import * as p from "@clack/prompts"
import { defineCommand, runCommand } from "citty"
import pc from "picocolors"
import { printHeader } from "../../utils/branding.js"
import addCommand from "./add.js"
import currentCommand from "./current.js"
import listCommand from "./list.js"
import quotaCommand from "./quota.js"
import removeCommand from "./remove.js"
import switchCommand from "./switch.js"

const subCommands = {
  add: addCommand,
  list: listCommand,
  switch: switchCommand,
  current: currentCommand,
  quota: quotaCommand,
  remove: removeCommand,
}

type SubCommandKey = keyof typeof subCommands

const subCommandOptions: Array<{
  value: SubCommandKey
  label: string
  hint: string
}> = [
  { value: "list", label: "list", hint: "Saved accounts + live quota" },
  {
    value: "add",
    label: "add",
    hint: "Capture, OAuth sign-in or import token",
  },
  { value: "switch", label: "switch", hint: "Change the active CLI account" },
  { value: "current", label: "current", hint: "Which account is live now" },
  { value: "quota", label: "quota", hint: "Live quota monitor" },
  { value: "remove", label: "remove", hint: "Delete a saved account" },
]

const subCommandNames = Object.keys(subCommands)

export default defineCommand({
  meta: {
    name: "auth",
    description: "Manage Antigravity CLI (agy) accounts",
  },
  subCommands,
  async run({ rawArgs }) {
    const hasSubCommand = rawArgs?.some((arg) => subCommandNames.includes(arg))
    if (hasSubCommand) return

    printHeader("agk auth")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Account manager")}`)

    const selected = await p.select({
      message: "Select an action:",
      options: subCommandOptions,
    })

    if (p.isCancel(selected)) {
      p.cancel("Cancelled")
      process.exit(0)
    }

    console.log()

    // biome-ignore lint/suspicious/noExplicitAny: citty's runCommand typing conflicts with dynamic selection
    await runCommand(subCommands[selected as SubCommandKey] as any, {
      rawArgs: [],
    })
  },
})
