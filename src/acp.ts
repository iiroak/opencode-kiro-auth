import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { createOpenCodeToolBridge, type OpenCodeToolBridge, type OpenCodeToolCall } from "./acp-tool-bridge"

type Block = Record<string, any>
type Message = { role: string; content: string | Block[] }
export type AcpRequest = {
  model?: string
  system?: string | Block[]
  messages?: Message[]
  tools?: Block[]
  tool_choice?: Block | string
}

type AcpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((item) => {
    if (!item || typeof item !== "object") return ""
    const block = item as Block
    if (block.type === "text" && typeof block.text === "string") return block.text
    if (block.type === "tool_use") {
      return `[tool call: ${String(block.name ?? "tool")}] ${JSON.stringify(block.input ?? {})}`
    }
    if (block.type === "tool_result") return extractText(block.content ?? block.text ?? "")
    if (block.type === "image") return "[image attached]"
    if (block.type === "document") return "[document attached]"
    return ""
  }).filter(Boolean).join("\n")
}

function imageContent(block: Block): AcpContent | undefined {
  const source = block.source
  if (block.type !== "image" || !source || typeof source !== "object") return undefined
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "image", data: source.data, mimeType: source.media_type }
  }
  return undefined
}

function keepImageTurns(): number {
  const value = Number.parseInt(process.env.KIRO_KEEP_IMAGE_TURNS ?? "2", 10)
  return Number.isFinite(value) && value >= 0 ? value : 2
}

function toAcpPrompt(body: AcpRequest, hasOpenCodeTools: boolean): AcpContent[] {
  const prompt: AcpContent[] = []
  const system = extractText(body.system)
  const toolPolicy = hasOpenCodeTools
    ? "Use only the tools exposed by the OpenCode MCP server for this request. Do not use Kiro's built-in file, shell, terminal, web, or other tools. OpenCode will execute requested tool calls and provide their results in the next turn.\n\n"
    : "Do not use tools for this request. Answer directly.\n\n"
  if (system || hasOpenCodeTools || body.tools?.length) {
    prompt.push({ type: "text", text: `SYSTEM INSTRUCTIONS\n${system}${system ? "\n\n" : ""}${toolPolicy}` })
  }

  const messages = body.messages ?? []
  const imageTurns = messages.flatMap((message, index) =>
    Array.isArray(message.content) && message.content.some((block) => block?.type === "image") ? [index] : [],
  )
  const keep = keepImageTurns()
  const keptImageTurns = new Set(keep > 0 ? imageTurns.slice(-keep) : [])

  for (const [messageIndex, message] of messages.entries()) {
    prompt.push({ type: "text", text: `\n--- ${message.role.toUpperCase()} ---\n` })
    if (typeof message.content === "string") {
      prompt.push({ type: "text", text: message.content })
      continue
    }
    for (const block of message.content) {
      if (block?.type === "image" && !keptImageTurns.has(messageIndex)) {
        prompt.push({ type: "text", text: "[older image omitted]" })
        continue
      }
      const image = imageContent(block)
      if (image) {
        prompt.push(image)
        continue
      }
      const text = extractText([block])
      if (text) prompt.push({ type: "text", text })
    }
  }
  if (prompt.length === 0) prompt.push({ type: "text", text: " " })
  return prompt
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function estimateTokens(value: unknown): number {
  if (!Array.isArray(value)) return 0
  let textChars = 0
  let images = 0
  for (const block of value) {
    if (block?.type === "image") images += 1
    else if (typeof block?.text === "string") textChars += block.text.length
  }
  return Math.ceil(textChars / 3.5 + images * 8_000)
}

/** Adapt Kiro CLI ACP updates to the Anthropic Messages stream consumed by OpenCode. */
export function kiroAcpToAnthropicStream(
  body: AcpRequest,
  model: string,
  effort: string | undefined,
  cwd: string,
  trustTools: boolean,
  signal?: AbortSignal,
): Response {
  let cancelled = false
  let child: ReturnType<typeof spawn> | undefined
  let bridge: OpenCodeToolBridge | undefined
  const onAbort = () => {
    cancelled = true
    child?.kill("SIGTERM")
    void bridge?.close()
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!cancelled && controller.desiredSize !== null) controller.enqueue(sse(event, data))
      }
      const messageId = `msg_${randomUUID().replace(/-/g, "")}`
      send("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      let index = -1
      let blockType: "thinking" | "text" | null = null
      let outputChars = 0
      let nextId = 0

      const closeBlock = () => {
        if (blockType === null) return
        send("content_block_stop", { type: "content_block_stop", index })
        blockType = null
      }

      const writeSseBlock = (kind: "thinking" | "text", text: string) => {
        if (!text) return
        if (blockType !== kind) {
          closeBlock()
          index += 1
          blockType = kind
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
          })
        }
        outputChars += text.length
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: kind === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
        })
      }

      const writeToolCalls = (calls: OpenCodeToolCall[]) => {
        closeBlock()
        for (const call of calls) {
          index += 1
          const input = JSON.stringify(call.input ?? {})
          outputChars += input.length
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
          })
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: input },
          })
          send("content_block_stop", { type: "content_block_stop", index })
        }
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { input_tokens: estimateTokens(toAcpPrompt(body, true)), output_tokens: Math.ceil(outputChars / 4) },
        })
        send("message_stop", { type: "message_stop" })
      }

      try {
        if (signal?.aborted) throw new Error("Kiro ACP request was cancelled")
        signal?.addEventListener("abort", onAbort, { once: true })

        const command = process.env.KIRO_CLI_PATH || "kiro-cli"
        const args = ["acp", "--model", model]
        if (effort) args.push("--effort", effort)
        if (trustTools) args.push("--trust-all-tools")

        bridge = await createOpenCodeToolBridge(body.tools, body.tool_choice)
        if (cancelled || signal?.aborted) throw new Error("Kiro ACP request was cancelled")

        child = spawn(command, args, {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
        })
        const currentChild = child
        if (!currentChild.stdin || !currentChild.stdout) throw new Error("Kiro CLI ACP did not open stdio pipes")
        const lines = createInterface({ input: currentChild.stdout })
        const iterator = lines[Symbol.asyncIterator]()
        let childError: Error | undefined

        const respond = (id: unknown, result: unknown) => {
          currentChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
        }

        const onNotification = (value: Record<string, any>) => {
          if (value.method === "session/request_permission" && value.id !== undefined) {
            const options = Array.isArray(value.params?.options) ? value.params.options as Block[] : []
            const title = value.params?.toolCall?.title
            const bridgeName = typeof title === "string"
              ? /@opencode\/([A-Za-z0-9_.-]+)/.exec(title)?.[1]
              : undefined
            const bridgeCall = Boolean(bridgeName && bridge?.isExposedName(bridgeName))
            const allow = (bridgeCall || trustTools)
              ? options.find((option) => option.kind === "allow_once" || option.optionId === "allow_once")
              : undefined
            const reject = options.find((option) => option.kind === "reject_once" || option.optionId === "reject_once")
            respond(value.id, allow
              ? { outcome: { outcome: "selected", optionId: allow.optionId } }
              : reject
              ? { outcome: { outcome: "selected", optionId: reject.optionId } }
              : { outcome: { outcome: "cancelled" } })
            return
          }
          if (value.method !== "session/update") return
          const update = value.params?.update
          const content = update?.content
          if (!content || content.type !== "text" || typeof content.text !== "string") return
          if (update.sessionUpdate === "agent_thought_chunk") writeSseBlock("thinking", content.text)
          else if (update.sessionUpdate === "agent_message_chunk") writeSseBlock("text", content.text)
        }

        const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, any>> => {
          const id = ++nextId
          currentChild.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
          while (!cancelled) {
            const next = await iterator.next()
            if (next.done) {
              throw childError ?? new Error(`Kiro CLI ACP exited before ${method} completed (exit ${currentChild.exitCode ?? "unknown"})`)
            }
            let value: Record<string, any>
            try {
              value = JSON.parse(next.value) as Record<string, any>
            } catch {
              continue
            }
            if (value.id === id) {
              if (value.error) throw new Error(`Kiro CLI ACP ${method} failed (${String(value.error.code ?? "unknown")})`)
              return value.result ?? {}
            }
            onNotification(value)
          }
          throw new Error("Kiro ACP request was cancelled")
        }

        currentChild.once("error", (error) => {
          childError = new Error(`Could not start Kiro CLI ACP: ${error.message}`)
        })

        await request("initialize", {
          protocolVersion: 1,
          // This adapter does not implement ACP filesystem or terminal client requests.
          clientCapabilities: {},
          clientInfo: { name: "opencode-kiro-auth", version: "1.0.0" },
        })
        const session = await request("session/new", { cwd, mcpServers: bridge ? [bridge.server] : [] })
        if (typeof session.sessionId !== "string") throw new Error("Kiro CLI ACP did not return a session ID")

        const prompt = request("session/prompt", {
          sessionId: session.sessionId,
          content: toAcpPrompt(body, Boolean(bridge)),
        })

        const promptOutcome = prompt.then(
          () => ({ kind: "complete" as const }),
          (error) => ({ kind: "error" as const, error }),
        )
        const outcome = bridge
          ? await Promise.race([
              promptOutcome,
              bridge.calls.then((calls) => ({ kind: "tool" as const, calls })),
            ])
          : await promptOutcome

        if (outcome?.kind === "tool") {
          writeToolCalls(outcome.calls)
          currentChild.kill("SIGTERM")
          return
        }
        if (outcome?.kind === "error") throw outcome.error

        closeBlock()
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: estimateTokens(toAcpPrompt(body, Boolean(bridge))), output_tokens: Math.ceil(outputChars / 4) },
        })
        send("message_stop", { type: "message_stop" })
      } catch (error) {
        if (!cancelled) {
          closeBlock()
          send("error", {
            type: "error",
            error: { type: "api_error", message: error instanceof Error ? error.message : String(error) },
          })
        }
      } finally {
        signal?.removeEventListener("abort", onAbort)
        child?.kill("SIGTERM")
        await bridge?.close()
        if (!cancelled && controller.desiredSize !== null) controller.close()
      }
    },
    cancel(reason) {
      cancelled = true
      child?.kill("SIGTERM")
      void bridge?.close()
      void reason
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  })
}
