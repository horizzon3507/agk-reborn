import * as p from "@clack/prompts"
import pc from "picocolors"
import { stripAnsiAndControls } from "./redact.js"

export const HIDE_CURSOR = "\x1b[?25l"
export const SHOW_CURSOR = "\x1b[?25h"
export const CLEAR_LINE_UP = "\x1b[1A\x1b[2K"
export const DEFAULT_TERMINAL_COLUMNS = 80

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
})

export function stripAnsi(input: string): string {
  if (!input) return ""
  return stripAnsiAndControls(input, true)
}

export function isDumbTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["TERM"]?.trim().toLowerCase() === "dumb"
}

export function isColorEnabled(
  stream: { readonly isTTY?: boolean | undefined } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): boolean {
  if (
    argv.includes("--no-color") ||
    argv.includes("--color=never") ||
    argv.includes("--color=false")
  ) {
    return false
  }
  const noColor = env["NO_COLOR"]
  if (noColor !== undefined && noColor !== "") return false

  const forceColor = env["FORCE_COLOR"]?.trim().toLowerCase()
  if (forceColor === "0" || forceColor === "false") return false
  if (forceColor && forceColor.length > 0) return true

  if (isDumbTerminal(env)) return false
  return Boolean(stream.isTTY)
}

export function getColors(
  stream: { readonly isTTY?: boolean | undefined } = process.stdout
): ReturnType<typeof pc.createColors> {
  return pc.createColors(isColorEnabled(stream))
}

export function isInteractiveSession(options?: {
  json?: boolean | undefined
  quiet?: boolean | undefined
}): boolean {
  if (options?.json || options?.quiet) return false
  if (isDumbTerminal()) return false
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

export function resolveTerminalColumns(
  fallback = DEFAULT_TERMINAL_COLUMNS
): number {
  const cols = process.stdout.columns
  if (typeof cols === "number" && Number.isFinite(cols) && cols > 0) {
    return Math.max(20, Math.floor(cols))
  }
  return fallback
}

function isFullwidthCodePoint(cp: number): boolean {
  if (cp < 0x1100) return false
  return (
    cp <= 0x115f ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4c6) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6b) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f004 && cp <= 0x3fffd)
  )
}

function graphemeDisplayWidth(segment: string): number {
  const cp = segment.codePointAt(0)
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0
  if (isFullwidthCodePoint(cp)) return 2
  return 1
}

export function getDisplayWidth(input: string): number {
  const plain = stripAnsi(input)
  if (!plain) return 0

  let asciiOnly = true
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i)
    if (c < 0x20 || c > 0x7e) {
      asciiOnly = false
      break
    }
  }
  if (asciiOnly) return plain.length

  let width = 0
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    width += graphemeDisplayWidth(segment)
  }
  return width
}

export function truncateDisplay(input: string, maxWidth: number): string {
  const plain = stripAnsi(input)
  if (maxWidth <= 0) return ""
  if (getDisplayWidth(plain) <= maxWidth) return plain
  if (maxWidth <= 3) return plain.slice(0, maxWidth)

  let out = ""
  let width = 0
  const limit = maxWidth - 3
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    const w = graphemeDisplayWidth(segment)
    if (width + w > limit) break
    out += segment
    width += w
  }
  return `${out}...`
}

export function padDisplayEnd(input: string, targetWidth: number): string {
  const current = getDisplayWidth(input)
  if (current >= targetWidth) return input
  return `${input}${" ".repeat(targetWidth - current)}`
}

export function countVisualRows(
  lines: readonly string[],
  columns = resolveTerminalColumns()
): number {
  if (lines.length === 0) return 0
  const safeCols = Math.max(1, columns)
  let total = 0
  for (const line of lines) {
    const w = getDisplayWidth(line)
    total += w === 0 ? 1 : Math.ceil(w / safeCols)
  }
  return total
}

export function clearVisualRows(rowCount: number): void {
  if (!process.stdout.isTTY || isDumbTerminal()) return
  const rows = Math.floor(rowCount)
  if (rows <= 0) return
  process.stdout.write(`${CLEAR_LINE_UP.repeat(rows)}\r`)
}

export function formatResetCountdown(
  resetTimeStr: string,
  style: "compact" | "prefixed" = "compact"
): string {
  if (!resetTimeStr || !resetTimeStr.trim()) {
    return style === "prefixed" ? "-" : ""
  }

  const targetMs = Date.parse(resetTimeStr.trim())
  if (!Number.isFinite(targetMs)) {
    return style === "prefixed" ? "-" : ""
  }

  const diffMs = targetMs - Date.now()
  if (diffMs <= 0) return "now"
  if (diffMs < 60_000) return style === "prefixed" ? "in <1m" : "<1m"

  const totalMinutes = Math.floor(diffMs / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (totalHours >= 48) {
    const days = Math.floor(totalHours / 24)
    const remHours = totalHours % 24
    const base = remHours > 0 ? `${days}d${remHours}h` : `${days}d`
    return style === "prefixed" ? `in ${base}` : base
  }

  if (totalHours > 0) {
    return style === "prefixed"
      ? `in ${totalHours}h ${minutes}m`
      : `${totalHours}h${minutes}m`
  }

  return style === "prefixed" ? `in ${minutes}m` : `${minutes}m`
}

export interface SafeSpinner {
  start(msg: string): void
  message(msg: string): void
  stop(msg: string, code?: number): void
}

export function createSafeSpinner(enabled: boolean): SafeSpinner {
  if (!enabled) {
    return {
      start: () => {},
      message: () => {},
      stop: () => {},
    }
  }

  const inner = p.spinner()
  let active = false

  return {
    start(msg: string): void {
      if (active) {
        inner.message(msg)
        return
      }
      active = true
      inner.start(msg)
    },
    message(msg: string): void {
      if (active) inner.message(msg)
    },
    stop(msg: string, code = 0): void {
      if (!active) return
      active = false
      inner.stop(msg, code)
    },
  }
}

export function restoreTerminalState(): void {
  try {
    if (
      process.stdin.isTTY &&
      process.stdin.isRaw &&
      typeof process.stdin.setRawMode === "function"
    ) {
      process.stdin.setRawMode(false)
    }
  } catch {
    // ignore closed fd
  }
  try {
    if (process.stdout.isTTY && !isDumbTerminal()) {
      process.stdout.write(SHOW_CURSOR)
    }
  } catch {
    // ignore broken pipe
  }
}

export type LiveStopReason = "quit" | "sigint" | "sigterm" | "once"

export interface LiveMonitorFrameContext {
  countdown: number
  isLoading: boolean
  isInteractive: boolean
  columns: number
  signal: AbortSignal
}

export interface RunLiveMonitorConfig {
  intervalSeconds: number
  once?: boolean | undefined
  onRefresh: (signal: AbortSignal) => Promise<void>
  renderLines: (ctx: LiveMonitorFrameContext) => string[]
}

export async function runLiveMonitor(
  config: RunLiveMonitorConfig
): Promise<LiveStopReason> {
  const intervalSeconds = Math.max(5, Math.floor(config.intervalSeconds))
  const interactive = !config.once && isInteractiveSession()
  const abortController = new AbortController()

  if (!interactive) {
    await config.onRefresh(abortController.signal)
    const lines = config.renderLines({
      countdown: 0,
      isLoading: false,
      isInteractive: false,
      columns: resolveTerminalColumns(),
      signal: abortController.signal,
    })
    if (lines.length > 0) {
      process.stdout.write(`${lines.join("\n")}\n`)
    }
    return "once"
  }

  let stopped = false
  let cleanedUp = false
  let isLoading = false
  let countdown = intervalSeconds
  let lastVisualRows = 0
  const wasRaw = Boolean(process.stdin.isRaw)

  let resolveDone: (reason: LiveStopReason) => void = () => {}
  const donePromise = new Promise<LiveStopReason>((resolve) => {
    resolveDone = resolve
  })

  const draw = (loading: boolean): void => {
    if (stopped) return
    const cols = resolveTerminalColumns()
    const lines = config.renderLines({
      countdown,
      isLoading: loading,
      isInteractive: true,
      columns: cols,
      signal: abortController.signal,
    })
    if (stopped) return
    if (lastVisualRows > 0) {
      clearVisualRows(lastVisualRows)
    }
    if (lines.length > 0) {
      process.stdout.write(`${lines.join("\n")}\n`)
      lastVisualRows = countVisualRows(lines, cols)
    } else {
      lastVisualRows = 0
    }
  }

  const executeRefresh = async (): Promise<void> => {
    if (stopped || isLoading) return
    isLoading = true
    draw(true)
    try {
      await config.onRefresh(abortController.signal)
    } finally {
      isLoading = false
      countdown = intervalSeconds
      if (!stopped) {
        draw(false)
      }
    }
  }

  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    stopped = true
    clearInterval(tickId)
    if (!abortController.signal.aborted) {
      abortController.abort()
    }

    process.stdin.removeListener("data", onKey)
    process.stdin.removeListener("end", onEof)
    process.stdin.removeListener("close", onEof)
    process.stdout.removeListener("resize", onResize)
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
    process.removeListener("SIGHUP", onSigterm)
    process.removeListener("exit", cleanup)

    try {
      if (
        process.stdin.isTTY &&
        typeof process.stdin.setRawMode === "function"
      ) {
        process.stdin.setRawMode(wasRaw)
      }
      process.stdin.pause()
    } catch {
      // ignore
    }

    try {
      if (process.stdout.isTTY && !isDumbTerminal()) {
        process.stdout.write(SHOW_CURSOR)
      }
    } catch {
      // ignore
    }
  }

  const finish = (reason: LiveStopReason): void => {
    if (stopped) return
    cleanup()
    resolveDone(reason)
  }

  const onKey = (chunk: Buffer | string): void => {
    if (stopped) return
    const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8")
    if (str.includes("\x03")) {
      finish("sigint")
      return
    }
    if (
      str.includes("\x04") ||
      str.includes("q") ||
      str.includes("Q") ||
      str === "\x1b"
    ) {
      finish("quit")
      return
    }
    if (str.includes("r") || str.includes("R")) {
      void executeRefresh()
    }
  }

  const onEof = (): void => finish("quit")
  const onSigint = (): void => finish("sigint")
  const onSigterm = (): void => finish("sigterm")
  const onResize = (): void => {
    if (!stopped) draw(isLoading)
  }

  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  process.on("SIGHUP", onSigterm)
  process.on("exit", cleanup)
  process.stdout.on("resize", onResize)

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.setEncoding("utf-8")
  process.stdin.on("data", onKey)
  process.stdin.on("end", onEof)
  process.stdin.on("close", onEof)

  if (process.stdout.isTTY && !isDumbTerminal()) {
    process.stdout.write(HIDE_CURSOR)
  }

  const tickId = setInterval(() => {
    if (stopped || isLoading) return
    countdown--
    if (countdown <= 0) {
      void executeRefresh()
    } else {
      draw(false)
    }
  }, 1000)

  void executeRefresh()

  return donePromise
}
