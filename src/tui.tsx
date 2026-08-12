/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { getKiroUsage, KiroUsageError } from "./usage"

const commandName = "kiro.usage"

type AnsiPart = { text: string; color?: string; bold?: boolean }

const ANSI_COLORS: Record<string, string> = {
  "141": "#af87ff",
  "244": "#808080",
}
const PROGRESS_BAR_WIDTH = 32

function parseAnsi(value: string): AnsiPart[][] {
  let color: string | undefined
  let bold = false
  const lines: AnsiPart[][] = [[]]
  const pattern = /\u001b\[([0-9;]*)m|\u001b\[[0-?]*[ -/]*[@-~]/g
  let cursor = 0

  const append = (text: string) => {
    const parts = text.split("\n")
    for (const [index, line] of parts.entries()) {
      if (line) lines[lines.length - 1].push({ text: line, color, bold })
      if (index < parts.length - 1) lines.push([])
    }
  }

  for (const match of value.matchAll(pattern)) {
    append(value.slice(cursor, match.index))
    cursor = (match.index ?? 0) + match[0].length

    if (!match[1]) continue
    const codes = match[1] ? match[1].split(";") : ["0"]
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === "0") {
        color = undefined
        bold = false
      } else if (code === "1") {
        bold = true
      } else if (code === "22") {
        bold = false
      } else if (code === "39") {
        color = undefined
      } else if (code === "38" && codes[i + 1] === "5") {
        color = ANSI_COLORS[codes[i + 2]]
        i += 2
      }
    }
  }

  append(value.slice(cursor))
  return lines
}

function compactProgressLine(line: AnsiPart[]): AnsiPart[] {
  const plain = line.map((part) => part.text).join("")
  if (!plain.includes("█")) return line

  const percentage = Number(plain.match(/(\d+)%\s*$/)?.[1])
  if (!Number.isFinite(percentage)) return line

  const filled = Math.min(PROGRESS_BAR_WIDTH, Math.max(percentage > 0 ? 1 : 0, Math.round((percentage / 100) * PROGRESS_BAR_WIDTH)))
  let filledLeft = filled
  let emptyLeft = PROGRESS_BAR_WIDTH - filled

  return line.map((part) => {
    const blocks = part.text.match(/█/g)?.length ?? 0
    if (!blocks) return part

    const isFilled = part.color === ANSI_COLORS["141"]
    const count = isFilled ? Math.min(blocks, filledLeft) : Math.min(blocks, emptyLeft)
    if (isFilled) filledLeft -= count
    else emptyLeft -= count
    return { ...part, text: "█".repeat(count) }
  }).filter((part) => part.text)
}

function UsageText(props: { value: string; color: string }): JSX.Element {
  const lines = parseAnsi(props.value)
  return (
    <box flexDirection="column" width="100%">
      {lines.map((line) => (
        <text wrapMode="none" fg={props.color}>
          {compactProgressLine(line).map((part) => (
            <span style={{ fg: part.color ?? props.color, bold: part.bold }}>
              {part.text}
            </span>
          ))}
        </text>
      ))}
    </box>
  )
}

function usageDialog(api: Parameters<TuiPlugin>[0], title: string, message: string, usage?: boolean) {
  const color = api.theme.current.text
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => (
    <box paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <text fg={color}>
        <b>{title}</b>
      </text>
      {usage ? (
        <UsageText value={message} color={color} />
      ) : (
        <text wrapMode="word" fg={color}>
          {message}
        </text>
      )}
      <text fg={api.theme.current.textMuted}>esc closes</text>
    </box>
  ))
}

function showUsage(api: Parameters<TuiPlugin>[0]) {
  usageDialog(api, "Kiro Usage", "Loading usage from kiro-cli...")

  void getKiroUsage()
    .then((usage) => {
      usageDialog(api, "Kiro Usage", usage, true)
    })
    .catch((error) => {
      const message = error instanceof KiroUsageError ? error.message : `Unexpected error: ${String(error)}`
      usageDialog(api, "Kiro Usage Error", message)
    })
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: commandName,
        title: "Kiro Usage",
        category: "Kiro",
        namespace: "palette",
        slashName: "kiro-usage",
        run() {
          showUsage(api)
        },
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-kiro-auth",
  tui,
}

export default plugin
