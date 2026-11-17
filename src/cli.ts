#!/usr/bin/env node

import { defineCommand, runMain } from "citty"
import authCommand from "./commands/auth/index.js"
import doctorCommand from "./commands/doctor.js"
import { DESCRIPTION, NAME, VERSION } from "./version.js"

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
})

await runMain(main)
