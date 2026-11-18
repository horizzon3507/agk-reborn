import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import { getActiveAccountEmail } from "../utils/accounts.js"
import {
  authFileExists,
  detectAuthFileEmail,
  parseAgyTokenFile,
  readAuthFile,
} from "../utils/auth-files.js"
import { printHeader } from "../utils/branding.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
  getAgkDir,
  getGeminiDir,
} from "../utils/paths.js"
import { listAgyProcesses } from "../utils/processes.js"
import { listProfiles } from "../utils/profiles.js"

const execFileAsync = promisify(execFile)

async function findAgyBinary(): Promise<string | null> {
  for (const cmd of ["agy", "antigravity-cli"]) {
    try {
      const { stdout } = await execFileAsync("which", [cmd])
      const found = stdout.trim().split("\n")[0]
      if (found) return found
    } catch {
      // try next
    }
  }
  return null
}

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose agy CLI auth setup",
  },
  async run() {
    printHeader("agk doctor")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Doctor")}`)

    const results: Array<{ ok: boolean | "warn"; label: string }> = []
    const check = (ok: boolean | "warn", label: string) =>
      results.push({ ok, label })

    const agyPath = await findAgyBinary()
    check(
      !!agyPath,
      agyPath ? `agy binary: ${agyPath}` : "agy binary not found in PATH"
    )

    check(
      existsSync(getGeminiDir()),
      existsSync(getGeminiDir()) ? "~/.gemini exists" : "~/.gemini missing"
    )

    const emails = new Map<string, string>()

    for (const relPath of [
      AGY_TOKEN_REL,
      OAUTH_CREDS_REL,
      ACP_TOKEN_REL,
      KEYRING_REL,
    ]) {
      if (!authFileExists(relPath)) {
        check("warn", `${relPath} missing`)
        continue
      }

      const content = readAuthFile(relPath)
      if (!content) {
        check(false, `${relPath} unreadable`)
        continue
      }

      const email = detectAuthFileEmail(relPath, content)
      if (email) emails.set(relPath, email)
      check(
        true,
        `${relPath} ok${email ? ` (${email})` : " (no embedded email)"}`
      )
    }

    const agyContent = readAuthFile(AGY_TOKEN_REL)
    if (agyContent) {
      const parsed = parseAgyTokenFile(agyContent)
      check(
        !!parsed?.token?.refresh_token,
        parsed?.token?.refresh_token
          ? "refresh token present"
          : "refresh token missing in agy token"
      )
    }

    const activeMarker = getActiveAccountEmail()
    const sessionEmail =
      emails.get(KEYRING_REL) ?? emails.get(AGY_TOKEN_REL) ?? null

    if (activeMarker && sessionEmail && activeMarker !== sessionEmail) {
      check(
        "warn",
        `google_accounts active (${activeMarker}) != token owner (${sessionEmail})`
      )
    } else if (activeMarker) {
      check(true, `google_accounts active: ${activeMarker}`)
    }

    const profiles = listProfiles()
    check(
      profiles.length > 0,
      profiles.length > 0
        ? `${profiles.length} saved profile(s): ${profiles.map((profile) => profile.email).join(", ")}`
        : "no saved profiles — run agk auth add"
    )

    const running = await listAgyProcesses()
    check(
      running.length === 0 ? true : "warn",
      running.length === 0
        ? "no agy processes running"
        : `${running.length} agy/antigravity process(es) running`
    )

    check(
      existsSync(getAgkDir()),
      existsSync(getAgkDir())
        ? "~/.agk-reborn exists"
        : "~/.agk-reborn not created yet"
    )

    console.log()
    for (const { ok, label } of results) {
      const icon =
        ok === true
          ? pc.green("✔")
          : ok === "warn"
            ? pc.yellow("⚠")
            : pc.red("✗")
      console.log(`  ${icon} ${label}`)
    }
    console.log()

    const failures = results.filter((result) => result.ok === false).length
    p.outro(
      failures === 0
        ? `${pc.green("✔")} Looks healthy`
        : `${pc.red("✗")} ${failures} problem(s) found`
    )
  },
})
