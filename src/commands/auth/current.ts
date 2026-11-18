import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { inspectAuthFile, readAuthFileState } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import {
  AGY_TOKEN_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
  OAUTH_CREDS_REL,
} from "../../utils/paths.js"
import { getProfile } from "../../utils/profiles.js"
import { sanitizeTerminalText } from "../../utils/redact.js"
import {
  formatResetCountdown,
  getColors,
  isInteractiveSession,
} from "../../utils/tui.js"

interface FileReportEntry {
  relPath: string
  status: "ok" | "missing" | "unavailable" | "unreadable" | "invalid"
  email: string | null
  hasRefreshToken: boolean
  expiresAt: string | null
  isExpired: boolean | null
}

function formatExpiryBadge(
  expiresAtMs: number | null,
  isExpired: boolean | null
): string {
  const c = getColors(process.stdout)
  if (expiresAtMs === null) return ""
  if (isExpired) return ` ${c.yellow("(access token expired)")}`
  const iso = new Date(expiresAtMs).toISOString()
  const rem = formatResetCountdown(iso, "compact")
  return rem ? ` ${c.dim(`(valid ${rem})`)}` : ""
}

export default defineCommand({
  meta: {
    name: "current",
    description: "Show the account the agy CLI is currently using",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output current session status as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const interactive = isInteractiveSession({ json })
    const c = getColors(process.stdout)

    printHeader("agk auth current", { json })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Current session")}`)
    }

    const activeMarker = getActiveAccountEmail()
    const entries: FileReportEntry[] = []
    const lines: string[] = []
    const ownersByPath = new Map<string, string>()

    for (const relPath of MANAGED_AUTH_FILES) {
      const state = readAuthFileState(relPath)

      if (state.status === "unavailable") {
        entries.push({
          relPath,
          status: "unavailable",
          email: null,
          hasRefreshToken: false,
          expiresAt: null,
          isExpired: null,
        })
        lines.push(
          `  ${c.dim("-")} ${relPath} ${c.dim("· keyring unavailable")}`
        )
        continue
      }

      if (state.status === "missing") {
        entries.push({
          relPath,
          status: "missing",
          email: null,
          hasRefreshToken: false,
          expiresAt: null,
          isExpired: null,
        })
        lines.push(`  ${c.dim("✗")} ${relPath} ${c.dim("· missing")}`)
        continue
      }

      if (state.status === "unreadable") {
        entries.push({
          relPath,
          status: "unreadable",
          email: null,
          hasRefreshToken: false,
          expiresAt: null,
          isExpired: null,
        })
        lines.push(
          `  ${c.yellow("⚠")} ${relPath} ${c.dim(`· unreadable (${state.reason})`)}`
        )
        continue
      }

      const info = inspectAuthFile(relPath, state.content)
      if (!info.valid) {
        entries.push({
          relPath,
          status: "invalid",
          email: null,
          hasRefreshToken: false,
          expiresAt: null,
          isExpired: null,
        })
        lines.push(
          `  ${c.red("✗")} ${relPath} ${c.red("· invalid or corrupted JSON")}`
        )
        continue
      }

      if (info.email) {
        ownersByPath.set(relPath, info.email)
      }

      const expiresAtIso =
        info.expiresAtMs !== null
          ? new Date(info.expiresAtMs).toISOString()
          : null

      entries.push({
        relPath,
        status: "ok",
        email: info.email,
        hasRefreshToken: info.hasRefreshToken,
        expiresAt: expiresAtIso,
        isExpired: info.isExpired,
      })

      const detail = info.email
        ? sanitizeTerminalText(info.email, 120)
        : c.dim("no email embedded")
      const expiryBadge = formatExpiryBadge(info.expiresAtMs, info.isExpired)
      lines.push(
        `  ${c.green("✔")} ${relPath} ${c.dim("·")} ${detail}${expiryBadge}`
      )
    }

    const sessionEmail =
      ownersByPath.get(KEYRING_REL) ??
      ownersByPath.get(AGY_TOKEN_REL) ??
      ownersByPath.get(OAUTH_CREDS_REL) ??
      null

    const distinctTokenOwners = [...new Set(ownersByPath.values())]
    const warnings: string[] = []

    if (distinctTokenOwners.length > 1) {
      const breakdown = [...ownersByPath.entries()]
        .map(([path, owner]) => `${path}=${owner}`)
        .join(", ")
      warnings.push(`Split-brain auth files detected: ${breakdown}`)
    }

    if (sessionEmail && activeMarker && sessionEmail !== activeMarker) {
      warnings.push(
        `google_accounts.json points at ${activeMarker} while live token belongs to ${sessionEmail}`
      )
    } else if (!sessionEmail && activeMarker) {
      warnings.push(
        `google_accounts.json lists ${activeMarker}, but no valid live token file is present`
      )
    }

    const profile = sessionEmail ? getProfile(sessionEmail) : null

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            account: sessionEmail,
            activeMarker,
            savedProfile: Boolean(profile),
            splitBrain: warnings.length > 0,
            warnings,
            files: entries,
          },
          null,
          2
        )
      )
      return
    }

    const accountLabel = sessionEmail
      ? c.cyan(sessionEmail)
      : activeMarker
        ? `${c.yellow(activeMarker)} ${c.dim("(marker only, no token)")}`
        : c.red("none")

    const savedLabel = profile
      ? c.green("yes")
      : sessionEmail
        ? c.dim("no (run agk auth add --capture)")
        : c.dim("no")

    if (interactive) {
      p.note(
        `${c.green("Account:")} ${accountLabel}\n${c.green("Saved profile:")} ${savedLabel}`,
        "Status"
      )
    } else {
      console.log(`Account: ${sessionEmail ?? "none"}`)
      console.log(`Saved profile: ${profile ? "yes" : "no"}`)
      console.log()
    }

    for (const line of lines) console.log(line)
    for (const warning of warnings) {
      console.log(`  ${c.yellow("⚠")} ${warning}`)
    }
    console.log()

    if (interactive) {
      p.outro(c.dim("Done"))
    }
  },
})
