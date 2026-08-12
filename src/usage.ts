import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const KIRO_USAGE_ARGS = ["chat", "--no-interactive", "/usage"]
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 128 * 1024

export class KiroUsageError extends Error {}

export type KiroUsageOptions = {
  timeoutMs?: number
  command?: string
}

function stripTerminalControlCodes(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B(?!\[)[@-_]/g, "")
    .replace(/\r/g, "")
    .trim()
}

function cleanUsageOutput(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B(?!\[)[@-_]/g, "")
    .replace(/\r/g, "")
    .trim()
}

function errorDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error)
  const value = error as { stderr?: unknown; message?: unknown }
  const stderr = typeof value.stderr === "string" ? stripTerminalControlCodes(value.stderr) : ""
  return stderr || (typeof value.message === "string" ? value.message : "Unknown error")
}

/** Run Kiro's built-in /usage command without invoking a shell. */
export async function getKiroUsage(options: KiroUsageOptions = {}): Promise<string> {
  const command = options.command ?? "kiro-cli"
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const result = await execFileAsync(command, KIRO_USAGE_ARGS, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    })
    // Kiro writes the interactive-looking usage panel to stderr even when the
    // command exits successfully and stdout is redirected.
    const output = cleanUsageOutput(result.stdout || result.stderr)
    if (!output) throw new KiroUsageError("kiro-cli returned no usage information.")
    return output
  } catch (error) {
    if (error instanceof KiroUsageError) throw error

    const value = error as { code?: string | number; killed?: boolean; signal?: string }
    if (value.code === "ENOENT") {
      throw new KiroUsageError("kiro-cli was not found in PATH. Install it or configure its PATH before retrying.")
    }
    if (value.killed || value.signal === "SIGTERM") {
      throw new KiroUsageError(`kiro-cli /usage timed out after ${timeoutMs}ms.`)
    }

    throw new KiroUsageError(`kiro-cli /usage failed: ${errorDetail(error)}`)
  }
}
