#!/usr/bin/env node

import * as p from "@clack/prompts"
import {
  type ArgsDef,
  type CommandDef,
  defineCommand,
  renderUsage,
  runCommand,
} from "citty"
import authCommand, {
  AUTH_SUBCOMMAND_OPTIONS,
  type AuthSubCommandKey,
  authSubCommands,
  dispatchAuthSubCommand,
} from "./commands/auth/index.js"
import doctorCommand from "./commands/doctor.js"
import { printHeader } from "./utils/branding.js"
import { sanitizeErrorMessage } from "./utils/redact.js"
import {
  getColors,
  isInteractiveSession,
  restoreTerminalState,
} from "./utils/tui.js"
import { BIN_NAME, DESCRIPTION, VERSION } from "./version.js"

type RootMenuKey = AuthSubCommandKey | "doctor"

const GLOBAL_COLOR_FLAGS = new Set([
  "--color",
  "--no-color",
  "--color=always",
  "--color=never",
  "--color=true",
  "--color=false",
])

const rootSubCommands = {
  auth: authCommand,
  doctor: doctorCommand,
} as const

const mainCommand = defineCommand({
  meta: {
    name: BIN_NAME,
    version: VERSION,
    description: DESCRIPTION,
  },
  subCommands: rootSubCommands,
  async run({ rawArgs }): Promise<void> {
    if (rawArgs && rawArgs.length > 0) return

    if (!isInteractiveSession()) {
      const usage = await renderUsage(mainCommand)
      console.log(usage)
      return
    }

    const c = getColors(process.stdout)
    printHeader("agk")
    p.intro(`${c.cyan("◆")} ${c.bold("Antigravity account manager")}`)

    const selected = await p.select<RootMenuKey>({
      message: "Select an action:",
      options: [
        ...AUTH_SUBCOMMAND_OPTIONS.map((opt) => ({
          value: opt.value as RootMenuKey,
          label: `auth ${opt.label}`,
          hint: opt.hint,
        })),
        {
          value: "doctor",
          label: "doctor",
          hint: "Diagnose and repair CLI auth setup",
        },
      ],
    })

    if (p.isCancel(selected)) {
      p.cancel("Cancelled")
      process.exitCode = 130
      return
    }

    console.log()
    if (selected === "doctor") {
      await runCommand(doctorCommand, { rawArgs: [] })
      return
    }
    await dispatchAuthSubCommand(selected)
  },
})

interface FlagSpec {
  kind: "boolean" | "string"
}

function buildCommandArgMeta(argsDef: ArgsDef | undefined): {
  flags: Map<string, FlagSpec>
  maxPositionals: number
} {
  const flags = new Map<string, FlagSpec>()
  let maxPositionals = 0

  if (!argsDef) return { flags, maxPositionals }

  for (const [name, rawSpec] of Object.entries(argsDef)) {
    if (!rawSpec || typeof rawSpec !== "object") continue
    const spec = rawSpec as {
      type?: string
      alias?: string | string[]
    }

    if (spec.type === "positional") {
      maxPositionals++
      continue
    }

    const kind: "boolean" | "string" =
      spec.type === "string" ? "string" : "boolean"
    flags.set(`--${name}`, { kind })
    if (kind === "boolean") {
      flags.set(`--no-${name}`, { kind: "boolean" })
    }

    const aliases = Array.isArray(spec.alias)
      ? spec.alias
      : typeof spec.alias === "string"
        ? [spec.alias]
        : []
    for (const alias of aliases) {
      flags.set(alias.length === 1 ? `-${alias}` : `--${alias}`, { kind })
    }
  }

  return { flags, maxPositionals }
}

function validateLeafCommandArgs(
  commandPath: string,
  argsDef: ArgsDef | undefined,
  tokens: readonly string[]
): string | null {
  const { flags, maxPositionals } = buildCommandArgMeta(argsDef)
  let positionalCount = 0
  let afterDoubleDash = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined) continue

    if (afterDoubleDash) {
      positionalCount++
      if (positionalCount > maxPositionals) {
        return `Unexpected positional argument "${tok}" for "${commandPath}"`
      }
      continue
    }

    if (tok === "--") {
      afterDoubleDash = true
      continue
    }

    if (tok.startsWith("-") && tok.length > 1) {
      const eqIdx = tok.indexOf("=")
      const flagKey = eqIdx === -1 ? tok : tok.slice(0, eqIdx)
      const inlineVal = eqIdx === -1 ? undefined : tok.slice(eqIdx + 1)

      const spec = flags.get(flagKey)
      if (!spec) {
        return `Unknown option "${flagKey}" for "${commandPath}"`
      }

      if (spec.kind === "string") {
        if (inlineVal !== undefined) {
          if (inlineVal.trim().length === 0) {
            return `Option "${flagKey}" requires a non-empty value`
          }
        } else {
          const nextTok = tokens[i + 1]
          if (nextTok === undefined || nextTok.startsWith("-")) {
            return `Option "${flagKey}" requires a value`
          }
          i++
        }
      }
      continue
    }

    positionalCount++
    if (positionalCount > maxPositionals) {
      return `Unexpected argument "${tok}" for "${commandPath}"`
    }
  }

  return null
}

function installStreamAndSignalGuards(): void {
  const handleBrokenPipe = (err: NodeJS.ErrnoException): void => {
    if (err.code === "EPIPE") {
      restoreTerminalState()
      process.exit(0)
    }
  }

  process.stdout.on("error", handleBrokenPipe)
  process.stderr.on("error", handleBrokenPipe)
  process.on("exit", () => {
    restoreTerminalState()
  })
}

async function executeCli(rawArgv: readonly string[]): Promise<void> {
  const filteredArgs = rawArgv.filter((arg) => !GLOBAL_COLOR_FLAGS.has(arg))

  if (
    filteredArgs.length === 1 &&
    (filteredArgs[0] === "--version" ||
      filteredArgs[0] === "-v" ||
      filteredArgs[0] === "-V")
  ) {
    console.log(VERSION)
    return
  }

  if (filteredArgs.length === 0) {
    await runCommand(mainCommand, { rawArgs: [] })
    return
  }

  const first = filteredArgs[0] ?? ""
  if (first === "--help" || first === "-h") {
    console.log(await renderUsage(mainCommand))
    return
  }

  if (first === "doctor") {
    const rest = filteredArgs.slice(1)
    if (rest.includes("--help") || rest.includes("-h")) {
      const parentMeta = {
        meta: { name: BIN_NAME },
      } as unknown as typeof doctorCommand
      console.log(await renderUsage(doctorCommand, parentMeta))
      return
    }
    const err = validateLeafCommandArgs(
      "agk doctor",
      doctorCommand.args as ArgsDef | undefined,
      rest
    )
    if (err) {
      const c = getColors(process.stderr)
      console.error(`${c.red("✗")} ${err}`)
      process.exitCode = 1
      return
    }
    await runCommand(doctorCommand, { rawArgs: rest })
    return
  }

  if (first === "auth") {
    const authRest = filteredArgs.slice(1)
    if (authRest.length === 0) {
      await runCommand(authCommand, { rawArgs: [] })
      return
    }

    const subName = authRest[0] ?? ""
    if (subName === "--help" || subName === "-h") {
      const parentMeta = {
        meta: { name: BIN_NAME },
      } as unknown as typeof authCommand
      console.log(await renderUsage(authCommand, parentMeta))
      return
    }

    if (!Object.hasOwn(authSubCommands, subName)) {
      const c = getColors(process.stderr)
      console.error(
        subName.startsWith("-")
          ? `${c.red("✗")} Unknown option "${subName}" for "agk auth"`
          : `${c.red("✗")} Unknown subcommand "${subName}" for "agk auth"`
      )
      process.exitCode = 1
      return
    }

    const subKey = subName as AuthSubCommandKey
    const subCmd = authSubCommands[subKey] as unknown as CommandDef<ArgsDef>
    const leafRest = authRest.slice(1)

    if (leafRest.includes("--help") || leafRest.includes("-h")) {
      const parentForHelp = defineCommand({
        meta: { name: "agk auth" },
      })
      console.log(await renderUsage(subCmd, parentForHelp))
      return
    }

    const resolvedArgs =
      typeof subCmd.args === "function"
        ? await subCmd.args()
        : await subCmd.args

    const leafErr = validateLeafCommandArgs(
      `agk auth ${subKey}`,
      resolvedArgs,
      leafRest
    )
    if (leafErr) {
      const c = getColors(process.stderr)
      console.error(`${c.red("✗")} ${leafErr}`)
      process.exitCode = 1
      return
    }

    await dispatchAuthSubCommand(subKey, leafRest)
    return
  }

  const c = getColors(process.stderr)
  console.error(
    first.startsWith("-")
      ? `${c.red("✗")} Unknown option "${first}". Run "agk --help" for usage.`
      : `${c.red("✗")} Unknown command "${first}". Run "agk --help" for usage.`
  )
  process.exitCode = 1
}

installStreamAndSignalGuards()

void executeCli(process.argv.slice(2)).catch((error: unknown) => {
  restoreTerminalState()
  const c = getColors(process.stderr)
  console.error(`${c.red("✗")} ${sanitizeErrorMessage(error)}`)
  process.exitCode = 1
})
