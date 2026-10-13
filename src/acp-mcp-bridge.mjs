import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"

const [configPath] = process.argv.slice(2)
const config = JSON.parse(await readFile(configPath, "utf8"))
const bridgeUrl = process.env.OPENCODE_KIRO_BRIDGE_URL
const bridgeToken = process.env.OPENCODE_KIRO_BRIDGE_TOKEN

function respond(id, result, error) {
  if (id === undefined) return
  const message = error
    ? { jsonrpc: "2.0", id, error: { code: -32603, message: String(error) } }
    : { jsonrpc: "2.0", id, result }
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function callOpenCodeTool(params) {
  const response = await fetch(`${bridgeUrl}/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: params?.name, arguments: params?.arguments ?? {} }),
  })
  if (!response.ok) throw new Error(`OpenCode tool bridge returned ${response.status}`)
  return {
    content: [{ type: "text", text: "OpenCode received this tool request. Stop this turn and wait for the tool result in the next prompt." }],
    isError: false,
  }
}

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    continue
  }

  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-tool-bridge", version: "1.0.0" },
      })
    } else if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
      continue
    } else if (message.method === "tools/list") {
      respond(message.id, {
        tools: config.tools.map((tool) => ({
          name: tool.proxyName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    } else if (message.method === "tools/call") {
      const result = await callOpenCodeTool(message.params)
      respond(message.id, result)
    } else if (message.method === "ping") {
      respond(message.id, {})
    } else {
      respond(message.id, undefined, `Unsupported MCP method: ${message.method}`)
    }
  } catch (error) {
    respond(message.id, undefined, error instanceof Error ? error.message : String(error))
  }
}
