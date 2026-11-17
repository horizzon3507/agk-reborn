#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineCommand, runMain } from "citty"
import authCommand from "./commands/auth/index.js"
import doctorCommand from "./commands/doctor.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface PackageJson {
  version: string
  name: string
  description: string
}

function getPackageJson(): PackageJson {
  try {
    const pkgPath = join(__dirname, "..", "package.json")
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson
  } catch {
    return {
      version: "0.0.0",
      name: "agk-reborn",
      description: "Multi-account manager for the Antigravity CLI",
    }
  }
}

const pkg = getPackageJson()

const main = defineCommand({
  meta: {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
  },
  subCommands: {
    auth: authCommand,
    doctor: doctorCommand,
  },
})

await runMain(main)
