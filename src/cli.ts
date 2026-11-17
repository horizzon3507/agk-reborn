#!/usr/bin/env node

import { defineCommand, runCommand, runMain } from "citty"
import authCommand from "./commands/auth/index.js"
import doctorCommand from "./commands/doctor.js"
import { DESCRIPTION, NAME, VERSION } from "./version.js"

const subCommandNames = ["auth", "doctor"]

const main = defineCommand({
  meta: {
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
  },
  subCommands: {
    auth: authCommand,
    doctor: doctorCommand,
  },
  async run({ rawArgs }) {
    const hasSubCommand = rawArgs?.some((arg) =>
      subCommandNames.includes(arg)
    )
    if (hasSubCommand) return

    await runCommand(authCommand, { rawArgs: [] })
  },
})

await runMain(main)
