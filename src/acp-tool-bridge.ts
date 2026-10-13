import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

type Block = Record<string, any>

export type OpenCodeToolCall = {
  id: string
  name: string
  input: unknown
}

type BridgeTool = {
  name: string
  proxyName: string
  description: string
  inputSchema: Record<string, unknown>
}

type McpServerConfig = {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export type OpenCodeToolBridge = {
  server: McpServerConfig
  calls: Promise<OpenCodeToolCall[]>
  isExposedName(name: string): boolean
  close(): Promise<void>
}

function asSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} }
  }
  return value as Record<string, unknown>
}

function requestedToolName(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== "object") return undefined
  const choice = toolChoice as Block
  return choice.type === "tool" && typeof choice.name === "string" ? choice.name : undefined
}

function shouldExposeTools(toolChoice: unknown): boolean {
  return !toolChoice || typeof toolChoice !== "object" || (toolChoice as Block).type !== "none"
}

function validTools(input: unknown, toolChoice: unknown): BridgeTool[] {
  if (!Array.isArray(input) || !shouldExposeTools(toolChoice)) return []
  const forcedName = requestedToolName(toolChoice)
  const out: BridgeTool[] = []
  for (const [index, tool] of input.entries()) {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") continue
    if (forcedName && tool.name !== forcedName) continue
    const safe = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "tool"
    out.push({
      name: tool.name,
      proxyName: `oc${index}_${safe}`,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: asSchema(tool.input_schema ?? tool.inputSchema),
    })
  }
  return out
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Uint8Array
    length += bytes.byteLength
    if (length > 1024 * 1024) throw new Error("Tool arguments exceeded the bridge limit")
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function writeJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(JSON.stringify(value))
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Could not bind OpenCode tool bridge"))
      resolve(address.port)
    })
  })
}

/**
 * Expose exactly the tools OpenCode included in this provider request to Kiro ACP.
 * Kiro calls this short-lived MCP server; calls are returned to OpenCode as normal
 * Anthropic tool_use blocks so OpenCode executes them using its own permissions.
 */
export async function createOpenCodeToolBridge(
  input: unknown,
  toolChoice: unknown,
): Promise<OpenCodeToolBridge | undefined> {
  const tools = validTools(input, toolChoice)
  if (tools.length === 0) return undefined

  const secret = randomBytes(32).toString("hex")
  const byProxyName = new Map(tools.map((tool) => [tool.proxyName, tool]))
  const pendingCalls: OpenCodeToolCall[] = []
  let resolveCalls!: (calls: OpenCodeToolCall[]) => void
  let callsResolved = false
  let batchTimer: ReturnType<typeof setTimeout> | undefined
  const calls = new Promise<OpenCodeToolCall[]>((resolve) => { resolveCalls = resolve })

  const flushCalls = () => {
    if (callsResolved || pendingCalls.length === 0) return
    callsResolved = true
    if (batchTimer) clearTimeout(batchTimer)
    resolveCalls(pendingCalls.splice(0, 8))
  }

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/call") {
      writeJson(response, 404, { error: "not found" })
      return
    }
    if (request.headers.authorization !== `Bearer ${secret}`) {
      writeJson(response, 401, { error: "unauthorized" })
      return
    }
    if (callsResolved) {
      writeJson(response, 409, { error: "tool handoff already completed" })
      return
    }

    try {
      const value = await readJson(request) as Block
      const tool = byProxyName.get(value?.name)
      if (!tool) {
        writeJson(response, 400, { error: "unknown tool" })
        return
      }
      pendingCalls.push({ id: `toolu_${randomBytes(12).toString("hex")}`, name: tool.name, input: value.arguments ?? {} })
      writeJson(response, 202, { accepted: true })
      if (pendingCalls.length >= 8) flushCalls()
      else if (!batchTimer) batchTimer = setTimeout(flushCalls, 30)
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  const port = await listen(server)
  let directory: string | undefined
  let closePromise: Promise<void> | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), "opencode-kiro-acp-"))
    const configPath = join(directory, "tools.json")
    await writeFile(configPath, JSON.stringify({
      tools: tools.map((tool) => ({
        proxyName: tool.proxyName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }), { mode: 0o600 })

    const bridgeProgram = fileURLToPath(new URL("./acp-mcp-bridge.mjs", import.meta.url))
    const node = process.env.KIRO_ACP_NODE_PATH || "node"
    return {
      server: {
        name: "opencode",
        command: node,
        args: [bridgeProgram, configPath],
        env: [
          { name: "OPENCODE_KIRO_BRIDGE_URL", value: `http://127.0.0.1:${port}` },
          { name: "OPENCODE_KIRO_BRIDGE_TOKEN", value: secret },
        ],
      },
      calls,
      isExposedName: (name) => byProxyName.has(name),
      close: () => closePromise ??= (async () => {
        if (batchTimer) clearTimeout(batchTimer)
        await new Promise<void>((resolve) => server.close(() => resolve()))
        if (directory) await rm(directory, { recursive: true, force: true })
      })(),
    }
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}
