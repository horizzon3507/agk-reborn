import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import {
  getActiveAccountEmail,
  setActiveAccount,
} from "../../utils/accounts.js"
import {
  detectAuthFileEmail,
  extractRefreshToken,
  readAuthFile,
  removeAuthFile,
  writeAuthFileAtomic,
} from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import { refreshAccessTokenAnyClient } from "../../utils/oauth.js"
import {
  AGY_TOKEN_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
} from "../../utils/paths.js"
import { listAgyProcesses, terminateProcesses } from "../../utils/processes.js"
import {
  getProfile,
  listProfiles,
  loadProfileSnapshots,
  setProfileClient,
  updateProfileFile,
} from "../../utils/profiles.js"
import {
  captureSessionToProfiles,
  detectCurrentSessionEmail,
} from "../../utils/session.js"
import { patchAuthFileTokens } from "../../utils/token-builders.js"

export default defineCommand({
  meta: {
    name: "switch",
    description: "Switch the agy CLI to a different Google account",
  },
  args: {
    email: {
      type: "positional",
      description: "Account email to switch to",
      required: false,
    },
    force: {
      type: "boolean",
      description: "Kill running agy processes and switch without prompts",
      default: false,
    },
    "keep-processes": {
      type: "boolean",
      description: "Do not kill running agy processes (switch may not stick)",
      default: false,
    },
  },
  async run({ args }) {
    printHeader("agk auth switch")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Switch account")}`)

    const profiles = listProfiles()

    if (profiles.length === 0) {
      p.note(
        `No profiles yet. Add one with:\n\n  ${pc.cyan("agk auth add")}`,
        "Empty"
      )
      p.cancel("Nothing to switch to")
      process.exit(1)
    }

    let targetEmail: string | undefined = args.email
    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()

    if (!targetEmail) {
      const selected = await p.select({
        message: "Switch to:",
        options: profiles.map((profile) => ({
          value: profile.email,
          label:
            profile.email === activeEmail
              ? `${profile.email} ${pc.green("(current)")}`
              : profile.email,
          hint:
            Object.keys(profile.files).length > 0
              ? `${Object.keys(profile.files).length} file(s)`
              : "empty",
        })),
        initialValue: profiles.find((profile) => profile.email !== activeEmail)
          ?.email,
      })

      if (p.isCancel(selected)) {
        p.cancel("Cancelled")
        process.exit(0)
      }
      targetEmail = selected
    }

    if (!targetEmail) {
      p.cancel("Cancelled")
      process.exit(0)
    }

    const target = getProfile(targetEmail)
    if (!target) {
      p.cancel(
        `No profile for ${targetEmail}. Run ${pc.cyan("agk auth list")} to see saved accounts.`
      )
      process.exit(1)
    }

    const markerEmail = getActiveAccountEmail()
    if (targetEmail === activeEmail && targetEmail === markerEmail) {
      p.outro(pc.dim(`Already on ${targetEmail}`))
      return
    }

    const spinner = p.spinner()
    spinner.start("Saving current session...")

    const captured = captureSessionToProfiles()

    spinner.stop(
      captured.length > 0
        ? `Current session saved (${captured.map((s) => s.email).join(", ")})`
        : "No live session to save"
    )

    const running = await listAgyProcesses()
    let killed = 0
    if (running.length > 0 && !args["keep-processes"]) {
      let shouldKill = args.force
      if (!shouldKill) {
        const answer = await p.confirm({
          message: `${pc.yellow(`${running.length} agy process(es) running`)} — they hold the old account in memory and will rewrite the auth files. Kill them?`,
          initialValue: true,
        })
        if (p.isCancel(answer)) {
          p.cancel("Cancelled")
          process.exit(0)
        }
        shouldKill = answer
      }

      if (shouldKill) {
        spinner.start(`Stopping ${running.length} agy process(es)...`)
        const survivors = await terminateProcesses(running)
        killed = running.length - survivors
        spinner.stop(
          survivors > 0
            ? `${killed} stopped, ${pc.yellow(`${survivors} still alive`)}`
            : `${killed} process(es) stopped`
        )
      } else {
        console.log(
          `  ${pc.yellow("⚠")} Keeping processes alive — they will likely rewrite the auth files and undo this switch.`
        )
      }
    }

    spinner.start(`Restoring ${pc.cyan(targetEmail)} ...`)

    const snapshots = loadProfileSnapshots(targetEmail)
    if (snapshots.length === 0) {
      spinner.stop("Failed")
      p.cancel(`Profile ${targetEmail} has no auth files`)
      process.exit(1)
    }

    const refreshToken = snapshots
      .map((snapshot) => extractRefreshToken(snapshot))
      .find((token): token is string => token !== null)

    let patched = snapshots
    if (refreshToken) {
      try {
        const clients = buildClientCandidates({
          stored:
            target.clientId && target.clientSecret
              ? { clientId: target.clientId, clientSecret: target.clientSecret }
              : null,
          authFileContents: snapshots.map((snapshot) => snapshot.content),
        })
        const { tokens: fresh, client } = await refreshAccessTokenAnyClient(
          refreshToken,
          clients
        )
        if (client.id !== target.clientId) {
          setProfileClient(targetEmail, client)
        }
        patched = snapshots.map((snapshot) => ({
          ...snapshot,
          content: patchAuthFileTokens(snapshot.relPath, snapshot.content, {
            access_token: fresh.access_token,
            refresh_token: fresh.refresh_token ?? refreshToken,
            expires_in: fresh.expires_in,
          }),
        }))
      } catch {
        // Offline or revoked — restore as stored, agy will refresh itself
      }
    }

    for (const snapshot of patched) {
      writeAuthFileAtomic(snapshot.relPath, snapshot.content)
      updateProfileFile(targetEmail, snapshot.relPath, snapshot.content)
    }

    const restoredPaths = new Set(patched.map((snapshot) => snapshot.relPath))

    if (!restoredPaths.has(KEYRING_REL)) {
      const agySnapshot = patched.find(
        (snapshot) => snapshot.relPath === AGY_TOKEN_REL
      )
      if (agySnapshot) {
        writeAuthFileAtomic(KEYRING_REL, agySnapshot.content)
      }
    }

    const removed: string[] = []
    for (const relPath of MANAGED_AUTH_FILES) {
      if (restoredPaths.has(relPath)) continue
      const live = readAuthFile(relPath)
      if (live === null) continue
      const owner = detectAuthFileEmail(relPath, live)
      if (owner && owner !== targetEmail && removeAuthFile(relPath)) {
        removed.push(`${relPath} (was ${owner})`)
      }
    }

    setActiveAccount(targetEmail)

    const mismatches: string[] = []
    for (const relPath of MANAGED_AUTH_FILES) {
      const live = readAuthFile(relPath)
      if (live === null) continue
      const owner = detectAuthFileEmail(relPath, live)
      if (owner && owner !== targetEmail) {
        mismatches.push(`${relPath} → ${owner}`)
      }
    }

    spinner.stop(`Restored ${patched.length} auth file(s)`)

    if (removed.length > 0) {
      console.log(
        `  ${pc.dim("Removed stale files:")}\n${removed.map((entry) => `     ${pc.dim(entry)}`).join("\n")}`
      )
    }

    if (mismatches.length > 0) {
      console.log(
        `  ${pc.red("✖")} Live files were rewritten back — a running process restored the old account:\n${mismatches.map((entry) => `     ${pc.dim(entry)}`).join("\n")}`
      )
    }

    const aliveNote =
      running.length - killed > 0
        ? `\n${pc.yellow("⚠")} ${running.length - killed} agy process(es) still running — they may overwrite this switch.`
        : ""

    console.log()
    p.note(
      `${pc.green("Active:")} ${targetEmail}
${pc.green("Files:")} ${patched.map((s) => s.relPath).join("\n         ")}${aliveNote}`,
      "Switched"
    )

    p.outro(`${pc.green("✔")} Now using ${pc.cyan(targetEmail)}`)
  },
})
