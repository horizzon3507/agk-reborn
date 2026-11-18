import { VERSION } from "../version.js"
import {
  getColors,
  getDisplayWidth,
  isColorEnabled,
  isDumbTerminal,
  resolveTerminalColumns,
  truncateDisplay,
} from "./tui.js"

const BANNER = ` █████╗  ██████╗ ██╗  ██╗
██╔══██╗██╔════╝ ██║ ██╔╝
███████║██║  ███╗█████╔╝
██╔══██║██║   ██║██╔═██╗
██║  ██║╚██████╔╝██║  ██╗
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝`

interface ColorStop {
  pos: number
  r: number
  g: number
  b: number
}

const GRADIENT_STOPS: readonly ColorStop[] = [
  { pos: 0.0, r: 0x98, g: 0xfb, b: 0x98 },
  { pos: 0.3, r: 0x7f, g: 0xff, b: 0xd4 },
  { pos: 0.5, r: 0x40, g: 0xe0, b: 0xd0 },
  { pos: 1.0, r: 0x41, g: 0x69, b: 0xe1 },
]

const FALSEY_ENV = new Set(["", "0", "false", "no", "off"])
let headerAlreadyPrinted = false

export function resetHeaderState(): void {
  headerAlreadyPrinted = false
}

function interpolateStops(t: number): { r: number; g: number; b: number } {
  const clamped = Math.max(0, Math.min(1, t))
  const first = GRADIENT_STOPS[0]
  const last = GRADIENT_STOPS[GRADIENT_STOPS.length - 1]
  if (!first || !last) return { r: 64, g: 224, b: 208 }
  if (clamped <= first.pos) return first
  if (clamped >= last.pos) return last

  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const a = GRADIENT_STOPS[i]
    const b = GRADIENT_STOPS[i + 1]
    if (!a || !b) continue
    if (clamped >= a.pos && clamped <= b.pos) {
      const span = b.pos - a.pos
      const ratio = span > 0 ? (clamped - a.pos) / span : 0
      return {
        r: Math.round(a.r + (b.r - a.r) * ratio),
        g: Math.round(a.g + (b.g - a.g) * ratio),
        b: Math.round(a.b + (b.b - a.b) * ratio),
      }
    }
  }

  return last
}

function renderTruecolorMultiline(text: string): string {
  const lines = text.split("\n")
  const maxLen = Math.max(1, ...lines.map((line) => [...line].length))

  return lines
    .map((line) => {
      const chars = [...line]
      let out = ""
      for (let idx = 0; idx < chars.length; idx++) {
        const ch = chars[idx] ?? ""
        if (ch === " ") {
          out += " "
          continue
        }
        const { r, g, b } = interpolateStops(
          maxLen > 1 ? idx / (maxLen - 1) : 0
        )
        out += `\x1b[38;2;${r};${g};${b}m${ch}`
      }
      return `${out}\x1b[39m`
    })
    .join("\n")
}

export function shouldSuppressBanner(options?: {
  json?: boolean | undefined
  quiet?: boolean | undefined
}): boolean {
  if (options?.json || options?.quiet) return true
  if (!process.stdout.isTTY || isDumbTerminal()) return true
  const envVal = process.env["AGK_NO_BANNER"]
  if (envVal !== undefined && !FALSEY_ENV.has(envVal.trim().toLowerCase())) {
    return true
  }
  return resolveTerminalColumns() < 28
}

export function printBanner(): void {
  if (shouldSuppressBanner()) return
  if (!isColorEnabled(process.stdout)) {
    console.log(BANNER)
    return
  }
  console.log(renderTruecolorMultiline(BANNER))
}

export function printVersion(): void {
  if (shouldSuppressBanner()) return
  const c = getColors(process.stdout)
  console.log(c.dim(`v${VERSION} · Antigravity CLI account manager`))
  console.log()
}

export function printCommand(cmd: string): void {
  if (shouldSuppressBanner()) return
  const c = getColors(process.stdout)
  const padding = 2
  const maxLabel = Math.max(4, resolveTerminalColumns() - padding * 2 - 2)
  const cleanCmd = truncateDisplay(cmd, maxLabel)
  const innerWidth = getDisplayWidth(cleanCmd) + padding * 2

  const top = c.dim(`┌${"─".repeat(innerWidth)}┐`)
  const bottom = c.dim(`└${"─".repeat(innerWidth)}┘`)
  const pad = " ".repeat(padding)
  const middle = `${c.dim("│")}${pad}${c.cyan(cleanCmd)}${pad}${c.dim("│")}`

  console.log(top)
  console.log(middle)
  console.log(bottom)
  console.log()
}

export function printHeader(
  command?: string,
  options?: { json?: boolean | undefined; quiet?: boolean | undefined }
): void {
  if (shouldSuppressBanner(options)) return
  if (headerAlreadyPrinted) {
    if (command) printCommand(command)
    return
  }
  headerAlreadyPrinted = true
  console.log()
  printBanner()
  printVersion()
  if (command) {
    printCommand(command)
  }
}

export function printSuccess(message: string): void {
  const c = getColors(process.stdout)
  console.log(`${c.green("✔")} ${message}`)
}

export function printError(message: string): void {
  const c = getColors(process.stderr)
  console.error(`${c.red("✗")} ${message}`)
}

export function printInfo(message: string): void {
  const c = getColors(process.stdout)
  console.log(`${c.cyan("◆")} ${message}`)
}

export function printWarning(message: string): void {
  const c = getColors(process.stderr)
  console.error(`${c.yellow("⚠")} ${message}`)
}
