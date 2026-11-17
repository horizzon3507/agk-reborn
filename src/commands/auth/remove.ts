import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { printHeader } from "../../utils/branding.js"
import { listProfiles, removeProfile } from "../../utils/profiles.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"

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
      description: "Skip confirmation",
      default: false,
    },
  },
  async run({ args }) {
    printHeader("agk auth remove")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Remove account")}`)

    const profiles = listProfiles()
    if (profiles.length === 0) {
      p.note("No profiles yet.", "Empty")
      p.cancel("Nothing to remove")
      process.exit(1)
    }

    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()

    let email = args.email
    if (!email) {
      const selected = await p.select({
        message: "Remove which profile?",
        options: profiles.map((profile) => ({
          value: profile.email,
          label:
            profile.email === activeEmail
              ? `${profile.email} ${pc.green("(current)")}`
              : profile.email,
        })),
      })

      if (p.isCancel(selected)) {
        p.cancel("Cancelled")
        process.exit(0)
      }
      email = selected
    }

    const target = profiles.find((profile) => profile.email === email)
    if (!target) {
      p.cancel(`No profile for ${email}`)
      process.exit(1)
    }

    if (!args.force) {
      const isActive = email === activeEmail
      const confirmed = await p.confirm({
        message: `Remove ${pc.cyan(email)}?${isActive ? `\n${pc.yellow("⚠")} This profile matches your live session — the login itself is NOT touched, only the saved copy.` : ""}`,
        initialValue: false,
      })

      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled")
        process.exit(0)
      }
    }

    if (!removeProfile(email)) {
      p.cancel("Failed to remove profile")
      process.exit(1)
    }

    p.outro(`${pc.green("✔")} ${pc.cyan(email)} removed`)
  },
})
