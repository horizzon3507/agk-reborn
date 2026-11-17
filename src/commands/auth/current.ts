import { existsSync } from "node:fs"
import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { detectAuthFileEmail, readAuthFile } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import {
  AGY_TOKEN_REL,
  MANAGED_AUTH_FILES,
  getLiveAuthFilePath,
} from "../../utils/paths.js"
import { getProfile } from "../../utils/profiles.js"

export default defineCommand({
  meta: {
    name: "current",
    description: "Show the account the agy CLI is currently using",
  },
  async run() {
    printHeader("agk auth current")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Current session")}`)

    const activeMarker = getActiveAccountEmail()
    const lines: string[] = []

    let sessionEmail: string | null = null

    for (const relPath of MANAGED_AUTH_FILES) {
      const absPath = getLiveAuthFilePath(relPath)
      if (!existsSync(absPath)) {
        lines.push(`  ${pc.dim("✗")} ${relPath} ${pc.dim("— missing")}`)
        continue
      }

      const content = readAuthFile(relPath)
      if (content === null) {
        lines.push(`  ${pc.yellow("⚠")} ${relPath} ${pc.dim("— unreadable")}`)
        continue
      }

      const email = detectAuthFileEmail(relPath, content)
      const detail = email ?? pc.dim("no email embedded")

      if (relPath === AGY_TOKEN_REL) {
        sessionEmail = email
      }

      lines.push(`  ${pc.green("✔")} ${relPath} ${pc.dim("—")} ${detail}`)
    }

    if (sessionEmail && sessionEmail !== activeMarker) {
      lines.push(
        `  ${pc.yellow("⚠")} google_accounts.json points at ${pc.cyan(activeMarker ?? "?")} but the token belongs to ${pc.cyan(sessionEmail)}`
      )
    }

    const active = sessionEmail ?? activeMarker
    const profile = active ? getProfile(active) : null

    p.note(
      `${pc.green("Account:")} ${active ? pc.cyan(active) : pc.red("none")}
${pc.green("Saved profile:")} ${profile ? pc.green("yes") : pc.dim("no — run agk auth add → Capture")}`,
      "Status"
    )

    for (const line of lines) console.log(line)
    console.log()

    p.outro(pc.dim("Done"))
  },
})
