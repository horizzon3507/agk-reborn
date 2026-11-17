import gradient from "gradient-string"
import pc from "picocolors"
import { VERSION } from "../version.js"

const BANNER = ` █████╗  ██████╗ ██╗  ██╗
██╔══██╗██╔════╝ ██║ ██╔╝
███████║██║  ███╗█████╔╝
██╔══██║██║   ██║██╔═██╗
██║  ██║╚██████╔╝██║  ██╗
╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝`

const agkGradient = gradient([
  { color: "#98FB98", pos: 0 },
  { color: "#7FFFD4", pos: 0.3 },
  { color: "#40E0D0", pos: 0.5 },
  { color: "#4169E1", pos: 1 },
])

export function printBanner(): void {
  console.log(agkGradient.multiline(BANNER))
}

export function printVersion(): void {
  console.log(pc.dim(`v${VERSION} • Made with ${pc.red("♥")}`))
  console.log()
}

export function printCommand(cmd: string): void {
  const boxChar = {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
  }

  const padding = 2
  const innerWidth = cmd.length + padding * 2
  const top = `${boxChar.topLeft}${boxChar.horizontal.repeat(innerWidth)}${boxChar.topRight}`
  const bottom = `${boxChar.bottomLeft}${boxChar.horizontal.repeat(innerWidth)}${boxChar.bottomRight}`
  const middle = `${boxChar.vertical}${" ".repeat(padding)}${pc.cyan(cmd)}${" ".repeat(padding)}${boxChar.vertical}`

  console.log(pc.dim(top))
  console.log(pc.dim(middle))
  console.log(pc.dim(bottom))
  console.log()
}

export function printHeader(command?: string): void {
  console.log()
  printBanner()
  printVersion()
  if (command) {
    printCommand(command)
  }
}

export function printSuccess(message: string): void {
  console.log(`${pc.green("✔")} ${message}`)
}

export function printError(message: string): void {
  console.log(`${pc.red("✖")} ${message}`)
}

export function printInfo(message: string): void {
  console.log(`${pc.blue("ℹ")} ${message}`)
}

export function printWarning(message: string): void {
  console.log(`${pc.yellow("⚠")} ${message}`)
}
