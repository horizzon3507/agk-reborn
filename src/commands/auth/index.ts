import * as p from "@clack/prompts"
import { defineCommand, renderUsage, runCommand } from "citty"
import { printHeader } from "../../utils/branding.js"
import { getColors, isInteractiveSession } from "../../utils/tui.js"
import addCommand from "./add.js"
import currentCommand from "./current.js"
import listCommand from "./list.js"
import quotaCommand from "./quota.js"
import refreshCommand from "./refresh.js"
import removeCommand from "./remove.js"
import switchCommand from "./switch.js"

export const authSubCommands = {
  list: listCommand,
  add: addCommand,
  switch: switchCommand,
  current: currentCommand,
  quota: quotaCommand,
  refresh: refreshCommand,
  remove: removeCommand,
} as const

export type AuthSubCommandKey = keyof typeof authSubCommands

export const AUTH_SUBCOMMAND_OPTIONS: ReadonlyArray<{
  value: AuthSubCommandKey
  label: string
  hint: string
}> = [
  { value: "list", label: "list", hint: "Saved accounts and live quota" },
  {
    value: "add",
    label: "add",
    hint: "Capture session, Google OAuth, or import token",
  },
  { value: "switch", label: "switch", hint: "Change the active CLI account" },
  { value: "current", label: "current", hint: "Inspect which account is live" },
  { value: "quota", label: "quota", hint: "Live model quota monitor" },
  {
    value: "refresh",
    label: "refresh",
    hint: "Verify and refresh stored OAuth tokens",
  },
  { value: "remove", label: "remove", hint: "Delete a saved account profile" },
]

export async function dispatchAuthSubCommand(
  key: AuthSubCommandKey,
  rawArgs: string[] = []
): Promise<void> {
  switch (key) {
    case "list":
      await runCommand(listCommand, { rawArgs })
      return
    case "add":
      await runCommand(addCommand, { rawArgs })
      return
    case "switch":
      await runCommand(switchCommand, { rawArgs })
      return
    case "current":
      await runCommand(currentCommand, { rawArgs })
      return
    case "quota":
      await runCommand(quotaCommand, { rawArgs })
      return
    case "refresh":
      await runCommand(refreshCommand, { rawArgs })
      return
    case "remove":
      await runCommand(removeCommand, { rawArgs })
      return
  }
}

const authCommand = defineCommand({
  meta: {
    name: "auth",
    description: "Manage Antigravity CLI (agy) accounts",
  },
  subCommands: authSubCommands,
  async run({ rawArgs }): Promise<void> {
    if (rawArgs && rawArgs.length > 0) return

    if (!isInteractiveSession()) {
      const usage = await renderUsage(authCommand, {
        meta: { name: "agk" },
      })
      console.log(usage)
      return
    }

    const c = getColors(process.stdout)
    printHeader("agk auth")
    p.intro(`${c.cyan("◆")} ${c.bold("Account manager")}`)

    const selected = await p.select<AuthSubCommandKey>({
      message: "Select an action:",
      options: [...AUTH_SUBCOMMAND_OPTIONS],
    })

    if (p.isCancel(selected)) {
      p.cancel("Cancelled")
      process.exitCode = 130
      return
    }

    console.log()
    await dispatchAuthSubCommand(selected)
  },
})

export default authCommand
