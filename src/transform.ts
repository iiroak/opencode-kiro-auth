import { randomUUID } from "node:crypto"
import {
  KIRO_ENDPOINT,
  KIRO_TARGET,
  KIRO_CONTENT_TYPE,
  KIRO_ORIGIN,
  KIRO_USER_AGENT,
  KIRO_X_AMZ_USER_AGENT,
} from "./constants"
import { readKiroEvents } from "./eventstream"

/* ----------------------------- request mapping ----------------------------- */

type Block = Record<string, any>
type Message = { role: string; content: string | Block[] }
type AnthropicRequest = {
  model?: string
  system?: string | Block[]
  messages?: Message[]
  tools?: Block[]
  [key: string]: unknown
}

// Kiro rejects an empty modelId; everything else (incl. "auto") passes through.
const DEFAULT_MODEL = "claude-sonnet-4.6"

const ENV_STATE = {
  operatingSystem: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  currentWorkingDirectory: process.cwd(),
}

function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
}

function systemText(system: AnthropicRequest["system"]): string {
  if (!system) return ""
  return typeof system === "string" ? system : textOf(system)
}

function toolSpecs(tools?: Block[]) {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name,
      description: t.description ?? "",
      inputSchema: { json: t.input_schema ?? t.inputSchema ?? { type: "object", properties: {} } },
    },
  }))
}

function toolResults(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const results = content.filter((b) => b?.type === "tool_result")
  if (!results.length) return undefined
  return results.map((r) => ({
    toolUseId: r.tool_use_id,
    content: [{ text: typeof r.content === "string" ? r.content : JSON.stringify(r.content) }],
    status: r.is_error ? "error" : "success",
  }))
}

function toolUses(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const uses = content.filter((b) => b?.type === "tool_use")
  if (!uses.length) return undefined
  return uses.map((u) => ({ toolUseId: u.id, name: u.name, input: u.input ?? {} }))
}

const IMAGE_FORMATS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
}

function images(content: string | Block[]) {
  if (typeof content === "string") return undefined
  const imgs = content.filter((b) => b?.type === "image" && b.source?.type === "base64" && b.source?.data)
  if (!imgs.length) return undefined
  return imgs.map((b) => ({ format: IMAGE_FORMATS[b.source.media_type] ?? "png", source: { bytes: b.source.data } }))
}

function userEntry(msg: Message, modelId: string, tools?: ReturnType<typeof toolSpecs>) {
  const context: Record<string, unknown> = { envState: ENV_STATE }
  const tr = toolResults(msg.content)
  if (tr) context.toolResults = tr
  if (tools) context.tools = tools
  const imgs = images(msg.content)
  return {
    userInputMessage: {
      content: textOf(msg.content) || " ",
      userInputMessageContext: context,
      origin: KIRO_ORIGIN,
      modelId,
      ...(imgs ? { images: imgs } : {}),
    },
  }
}

function assistantEntry(msg: Message) {
  const tu = toolUses(msg.content)
  return {
    assistantResponseMessage: {
      content: textOf(msg.content),
      ...(tu ? { toolUses: tu } : {}),
    },
  }
}

/** Map an Anthropic Messages request to a Kiro GenerateAssistantResponse request. */
export function toKiroRequest(
  body: AnthropicRequest,
  accessToken: string,
  profileArn: string,
): { url: string; init: RequestInit } {
  const modelId = body.model || DEFAULT_MODEL
  const tools = toolSpecs(body.tools)

  // CodeWhisperer has no system role: fold the system prompt into the first user turn.
  const messages = (body.messages ?? []).map((m) => ({ ...m }))
  const sys = systemText(body.system)
  if (sys) {
    const firstUser = messages.find((m) => m.role === "user")
    if (firstUser) {
      firstUser.content =
        typeof firstUser.content === "string"
          ? `${sys}\n\n${firstUser.content}`
          : [{ type: "text", text: sys }, ...firstUser.content]
    }
  }

  const history = messages
    .slice(0, -1)
    .map((m) => (m.role === "assistant" ? assistantEntry(m) : userEntry(m, modelId)))

  const last = messages[messages.length - 1]
  const current = last && last.role !== "assistant" ? last : { role: "user", content: " " }

  const payload = {
    profileArn,
    conversationState: {
      conversationId: randomUUID(),
      currentMessage: userEntry(current, modelId, tools),
      history,
      chatTriggerType: "MANUAL",
      agentContinuationId: randomUUID(),
      agentTaskType: "vibe",
    },
  }

  return {
    url: KIRO_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": KIRO_CONTENT_TYPE,
        "x-amz-target": KIRO_TARGET,
        "user-agent": KIRO_USER_AGENT,
        "x-amz-user-agent": KIRO_X_AMZ_USER_AGENT,
        "x-amzn-codewhisperer-optout": "false",
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=3",
      },
      body: JSON.stringify(payload),
    },
  }
}

/* ---------------------------- response mapping ----------------------------- */

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Convert Kiro's event-stream into the Anthropic Messages SSE stream opencode expects. */
export function kiroToAnthropicStream(res: Response, model: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(sse(event, data)))

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${randomUUID().replace(/-/g, "")}`,
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
      let currentTool: string | null = null
      let usedTool = false
      let blockOpen = false

      const closeBlock = () => {
        if (!blockOpen) return
        send("content_block_stop", { type: "content_block_stop", index })
        blockOpen = false
        currentTool = null
      }

      try {
        for await (const ev of readKiroEvents(res)) {
          if (ev.eventType === "assistantResponseEvent") {
            const content = ev.payload.content
            if (typeof content !== "string" || content.length === 0) continue
            if (currentTool || !blockOpen) {
              closeBlock()
              index += 1
              blockOpen = true
              send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
            }
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: content } })
            continue
          }

          if (ev.eventType === "toolUseEvent") {
            const id = ev.payload.toolUseId as string
            const input = ev.payload.input as string | undefined
            const stop = ev.payload.stop === true

            if (id && id !== currentTool && input === undefined && !stop) {
              closeBlock()
              index += 1
              currentTool = id
              usedTool = true
              blockOpen = true
              send("content_block_start", {
                type: "content_block_start",
                index,
                content_block: { type: "tool_use", id, name: ev.payload.name, input: {} },
              })
              continue
            }
            if (typeof input === "string" && input.length > 0) {
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: input } })
            }
            if (stop) closeBlock()
            continue
          }

          if (ev.eventType.toLowerCase().includes("exception") || ev.eventType === "error") {
            send("error", { type: "error", error: { type: "api_error", message: JSON.stringify(ev.payload) } })
          }
        }

        closeBlock()
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: usedTool ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        })
        send("message_stop", { type: "message_stop" })
      } catch (error) {
        send("error", { type: "error", error: { type: "api_error", message: String(error) } })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
}
