import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { printHeader } from "../../utils/branding.js"
import { withAgkLock } from "../../utils/lock.js"
import {
  getProfile,
  listProfiles,
  removeProfile,
} from "../../utils/profiles.js"
import { sanitizeErrorMessage } from "../../utils/redact.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"
import { getColors, isInteractiveSession } from "../../utils/tui.js"

function reportError(message: string, json: boolean): void {
  process.exitCode = 1
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2))
    return
  }
  console.error(`${getColors(process.stderr).red("✗")} ${message}`)
}

export default defineCommand({
  meta: {
    name: "remove",
    description: "Remove a saved account profile",
  },
  args: {
    email: {
      type: "positional",
      description: "Account email to remove",
      required: false,
    },
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
      alias: "f",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const interactive = isInteractiveSession({ json })
    const c = getColors(process.stdout)

    printHeader("agk auth remove", { json })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Remove account")}`)
    }

    const profiles = listProfiles()
    if (profiles.length === 0) {
      if (interactive) {
        p.note("No profiles saved yet.", "Empty")
      }
      reportError("No saved profiles to remove", json)
      return
    }

    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()
    let rawEmail =
      typeof args.email === "string" && args.email.trim().length > 0
        ? args.email.trim()
        : undefined

    if (!rawEmail) {
      if (!interactive) {
        reportError(
          "Account email and --force are required in non-interactive mode (agk auth remove <email> --force)",
          json
        )
        return
      }

      const selected = await p.select<string>({
        message: "Remove which profile?",
        options: profiles.map((profile) => ({
          value: profile.email,
          label:
            profile.email === activeEmail
              ? `${profile.email} ${c.green("(current)")}`
              : profile.email,
        })),
      })

      if (p.isCancel(selected)) {
        p.cancel("Cancelled")
        process.exitCode = 130
        return
      }
      rawEmail = selected
    }

    const target = getProfile(rawEmail)
    if (!target) {
      reportError(`No profile for ${rawEmail}`, json)
      return
    }

    const canonicalEmail = target.email
    const isActive = canonicalEmail === activeEmail

    if (!args.force) {
      if (!interactive) {
        reportError(
          `Pass --force to remove ${canonicalEmail} in non-interactive mode`,
          json
        )
        return
      }

      const confirmed = await p.confirm({
        message: `Remove saved profile for ${c.cyan(canonicalEmail)}?${isActive ? `\n${c.yellow("⚠")} This profile matches your live session (live credentials in ~/.gemini stay untouched).` : ""}`,
        initialValue: false,
      })

      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled")
        process.exitCode = p.isCancel(confirmed) ? 130 : 0
        return
      }
    }

    try {
      const removed = await withAgkLock("auth remove", () =>
        removeProfile(canonicalEmail)
      )
      if (!removed) {
        reportError(`Failed to remove profile for ${canonicalEmail}`, json)
        return
      }

      if (json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              removed: true,
              email: canonicalEmail,
              wasActiveSession: isActive,
            },
            null,
            2
          )
        )
        return
      }

      if (isActive && args.force) {
        console.log(
          `  ${c.dim(`Note: live session for ${canonicalEmail} remains logged in under ~/.gemini.`)}`
        )
      }

      if (interactive) {
        p.outro(`${c.green("✔")} ${c.cyan(canonicalEmail)} removed`)
      } else {
        console.log(`${c.green("✔")} Removed ${canonicalEmail}`)
      }
    } catch (error) {
      reportError(`Remove failed: ${sanitizeErrorMessage(error)}`, json)
    }
  },
})
