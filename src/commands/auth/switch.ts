import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import {
  getActiveAccountEmail,
  setActiveAccount,
} from "../../utils/accounts.js"
import {
  detectAuthFileEmail,
  extractRefreshToken,
  isValidAuthFileContent,
  readAuthFile,
  removeAuthFile,
  writeAuthFileAtomic,
} from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { withAgkLock } from "../../utils/lock.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import { OAuthError, refreshAccessTokenAnyClient } from "../../utils/oauth.js"
import {
  AGY_TOKEN_REL,
  GOOGLE_ACCOUNTS_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
} from "../../utils/paths.js"
import {
  formatProcessSummary,
  scanAgyProcesses,
  terminateProcesses,
} from "../../utils/processes.js"
import {
  getProfile,
  listProfiles,
  loadProfileSnapshots,
  setProfileClient,
  updateProfileFile,
} from "../../utils/profiles.js"
import { normalizeEmail, sanitizeErrorMessage } from "../../utils/redact.js"
import {
  captureSessionToProfiles,
  detectCurrentSessionEmail,
} from "../../utils/session.js"
import { patchAuthFileTokens } from "../../utils/token-builders.js"
import {
  createSafeSpinner,
  getColors,
  isInteractiveSession,
} from "../../utils/tui.js"

interface LiveStateSnapshot {
  files: Map<string, string | null>
}

function snapshotLiveGeminiState(): LiveStateSnapshot {
  const files = new Map<string, string | null>()
  for (const relPath of [...MANAGED_AUTH_FILES, GOOGLE_ACCOUNTS_REL]) {
    files.set(relPath, readAuthFile(relPath))
  }
  return { files }
}

function rollbackLiveGeminiState(backup: LiveStateSnapshot): void {
  for (const [relPath, content] of backup.files.entries()) {
    try {
      if (content === null) {
        removeAuthFile(relPath)
      } else {
        writeAuthFileAtomic(relPath, content)
      }
    } catch {
      // Best-effort rollback
    }
  }
}

function isLiveSessionHealthyForTarget(
  canonicalEmail: string,
  expectedRelPaths: readonly string[]
): boolean {
  if (getActiveAccountEmail() !== canonicalEmail) return false

  let sawTargetIdentity = false
  for (const relPath of expectedRelPaths) {
    if (relPath === KEYRING_REL) continue
    const content = readAuthFile(relPath)
    if (content === null || !isValidAuthFileContent(relPath, content)) {
      return false
    }
    const owner = detectAuthFileEmail(relPath, content)
    if (owner) {
      if (owner !== canonicalEmail) return false
      sawTargetIdentity = true
    }
  }

  for (const relPath of MANAGED_AUTH_FILES) {
    const content = readAuthFile(relPath)
    if (content === null) continue
    const owner = detectAuthFileEmail(relPath, content)
    if (owner && owner !== canonicalEmail) return false
    if (owner === canonicalEmail) sawTargetIdentity = true
  }

  return sawTargetIdentity
}

function reportFailure(
  message: string,
  opts: { json: boolean; quiet: boolean }
): void {
  process.exitCode = 1
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2))
    return
  }
  const c = getColors(process.stderr)
  console.error(`${c.red("✗")} ${message}`)
}

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
      description: "Stop running agy processes and switch without prompts",
      default: false,
    },
    "keep-processes": {
      type: "boolean",
      description:
        "Do not stop running agy processes (switch may be overwritten)",
      default: false,
    },
    quiet: {
      type: "boolean",
      description: "Suppress non-error output",
      alias: "q",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output structured JSON result",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const quiet = Boolean(args.quiet)
    const interactive = isInteractiveSession({ json, quiet })
    const c = getColors(process.stdout)

    if (args.force && args["keep-processes"]) {
      reportFailure(
        "Conflicting flags: cannot combine --force and --keep-processes",
        { json, quiet }
      )
      return
    }

    printHeader("agk auth switch", { json, quiet })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Switch account")}`)
    }

    const profiles = listProfiles()
    if (profiles.length === 0) {
      if (interactive) {
        p.note(
          `No profiles yet. Add one with:\n\n  ${c.cyan("agk auth add")}`,
          "Empty"
        )
      }
      reportFailure("No saved profiles found. Run agk auth add first.", {
        json,
        quiet,
      })
      return
    }

    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()
    let rawTarget =
      typeof args.email === "string" && args.email.trim().length > 0
        ? args.email.trim()
        : undefined

    if (!rawTarget) {
      if (!interactive) {
        reportFailure(
          "Account email argument is required in non-interactive mode (agk auth switch <email>)",
          { json, quiet }
        )
        return
      }

      const defaultTarget = profiles.find(
        (profile) => profile.email !== activeEmail
      )?.email
      const selectOpts: Parameters<typeof p.select<string>>[0] = {
        message: "Switch to:",
        options: profiles.map((profile) => ({
          value: profile.email,
          label:
            profile.email === activeEmail
              ? `${profile.email} ${c.green("(current)")}`
              : profile.email,
          hint:
            Object.keys(profile.files).length > 0
              ? `${Object.keys(profile.files).length} file(s)`
              : "empty",
        })),
      }
      if (defaultTarget !== undefined) {
        selectOpts.initialValue = defaultTarget
      }

      const selected = await p.select<string>(selectOpts)
      if (p.isCancel(selected)) {
        p.cancel("Cancelled")
        process.exitCode = 130
        return
      }
      rawTarget = selected
    }

    const target = getProfile(rawTarget)
    if (!target) {
      reportFailure(
        `No profile for ${rawTarget}. Run agk auth list to see saved accounts.`,
        { json, quiet }
      )
      return
    }

    const canonicalEmail = target.email
    const initialSnapshots = loadProfileSnapshots(canonicalEmail)
    if (initialSnapshots.length === 0) {
      reportFailure(`Profile ${canonicalEmail} has no saved auth files`, {
        json,
        quiet,
      })
      return
    }

    if (
      !args.force &&
      isLiveSessionHealthyForTarget(
        canonicalEmail,
        initialSnapshots.map((s) => s.relPath)
      )
    ) {
      if (json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              switched: false,
              alreadyActive: true,
              email: canonicalEmail,
              restoredFiles: [],
              warnings: [],
            },
            null,
            2
          )
        )
      } else if (interactive) {
        p.outro(c.dim(`Already on ${canonicalEmail}`))
      }
      return
    }

    const initialScan = await scanAgyProcesses()
    let shouldKillProcesses = false

    if (initialScan.processes.length > 0 && !args["keep-processes"]) {
      if (args.force) {
        shouldKillProcesses = true
      } else if (!interactive) {
        reportFailure(
          `${initialScan.processes.length} agy process(es) are running. Pass --force to stop them or --keep-processes to proceed anyway.`,
          { json, quiet }
        )
        return
      } else {
        const procPreview = initialScan.processes
          .slice(0, 4)
          .map((proc) => formatProcessSummary(proc))
          .join(", ")
        const answer = await p.confirm({
          message: `${c.yellow(`${initialScan.processes.length} agy process(es) running`)} (${procPreview}). Stop them before switching so they do not overwrite auth files?`,
          initialValue: true,
        })
        if (p.isCancel(answer)) {
          p.cancel("Cancelled")
          process.exitCode = 130
          return
        }
        shouldKillProcesses = answer
      }
    }

    const spinner = createSafeSpinner(interactive)
    const warnings: string[] = []

    try {
      const outcome = await withAgkLock("auth switch", async () => {
        spinner.start("Saving current session...")
        const captured = captureSessionToProfiles()
        spinner.stop(
          captured.length > 0
            ? `Current session saved (${captured.map((s) => s.email).join(", ")})`
            : "No live session to save",
          0
        )

        const freshScan = await scanAgyProcesses()
        let stoppedCount = 0
        let remainingCount = freshScan.processes.length

        if (freshScan.processes.length > 0 && !args["keep-processes"]) {
          if (shouldKillProcesses) {
            spinner.start(
              `Stopping ${freshScan.processes.length} agy process(es)...`
            )
            const survivors = await terminateProcesses(freshScan.processes)
            stoppedCount = freshScan.processes.length - survivors
            remainingCount = survivors
            spinner.stop(
              survivors > 0
                ? `${stoppedCount} stopped, ${survivors} still running`
                : `${stoppedCount} process(es) stopped`,
              0
            )
          } else {
            warnings.push(
              "Keeping running agy processes alive: they may overwrite live auth files."
            )
          }
        }

        if (freshScan.skippedAncestors.length > 0) {
          warnings.push(
            "Current parent agy session was kept alive; restart it after switching to pick up the new account."
          )
        }

        spinner.start(`Restoring ${canonicalEmail}...`)

        const freshProfile = getProfile(canonicalEmail) ?? target
        const snapshots = loadProfileSnapshots(canonicalEmail)
        if (snapshots.length === 0) {
          throw new Error(`Profile ${canonicalEmail} has no saved auth files`)
        }

        const refreshToken = snapshots
          .map((snapshot) => extractRefreshToken(snapshot))
          .find((token): token is string => token !== null)

        let patched = snapshots
        let refreshStatus:
          | "refreshed"
          | "revoked"
          | "offline_fallback"
          | "none" = refreshToken ? "offline_fallback" : "none"

        if (refreshToken) {
          try {
            const clients = buildClientCandidates({
              stored:
                freshProfile.clientId && freshProfile.clientSecret
                  ? {
                      clientId: freshProfile.clientId,
                      clientSecret: freshProfile.clientSecret,
                    }
                  : null,
              authFileContents: snapshots.map((snapshot) => snapshot.content),
            })

            const { tokens: fresh, client } = await refreshAccessTokenAnyClient(
              refreshToken,
              clients
            )

            if (
              client.id !== freshProfile.clientId ||
              client.secret !== freshProfile.clientSecret
            ) {
              setProfileClient(canonicalEmail, client)
            }

            patched = snapshots.map((snapshot) => ({
              ...snapshot,
              content: patchAuthFileTokens(snapshot.relPath, snapshot.content, {
                access_token: fresh.access_token,
                refresh_token: fresh.refresh_token ?? refreshToken,
                expires_in: fresh.expires_in,
                id_token: fresh.id_token,
              }),
            }))
            refreshStatus = "refreshed"
          } catch (refreshError) {
            if (
              refreshError instanceof OAuthError &&
              refreshError.kind === "invalid_grant"
            ) {
              refreshStatus = "revoked"
              warnings.push(
                `Stored refresh token for ${canonicalEmail} is expired or revoked (invalid_grant). Re-authenticate with "agk auth add".`
              )
            } else {
              refreshStatus = "offline_fallback"
              warnings.push(
                `Could not pre-refresh token (${sanitizeErrorMessage(refreshError, 120)}); restored cached credentials.`
              )
            }
          }
        }

        if (refreshStatus === "refreshed") {
          for (const snapshot of patched) {
            updateProfileFile(
              canonicalEmail,
              snapshot.relPath,
              snapshot.content
            )
          }
        }

        const liveBackup = snapshotLiveGeminiState()
        const writtenPaths = new Set<string>()
        const removedStale: string[] = []

        try {
          for (const snapshot of patched) {
            const ok = writeAuthFileAtomic(snapshot.relPath, snapshot.content)
            if (ok) {
              writtenPaths.add(snapshot.relPath)
            } else if (snapshot.relPath !== KEYRING_REL) {
              throw new Error(`Failed to write ${snapshot.relPath}`)
            }
          }

          if (!writtenPaths.has(KEYRING_REL)) {
            const agySnapshot = patched.find(
              (snapshot) => snapshot.relPath === AGY_TOKEN_REL
            )
            if (
              agySnapshot &&
              writeAuthFileAtomic(KEYRING_REL, agySnapshot.content)
            ) {
              writtenPaths.add(KEYRING_REL)
            }
          }

          // Remove every remaining managed auth file (including email-less acp_token.json)
          // so stale tokens from the previous account can never contaminate this session.
          for (const relPath of MANAGED_AUTH_FILES) {
            if (writtenPaths.has(relPath)) continue
            const prevContent = readAuthFile(relPath)
            if (prevContent === null) continue
            const prevOwner = detectAuthFileEmail(relPath, prevContent)
            if (removeAuthFile(relPath)) {
              removedStale.push(
                prevOwner ? `${relPath} (was ${prevOwner})` : relPath
              )
            }
          }

          setActiveAccount(canonicalEmail)
        } catch (writeErr) {
          rollbackLiveGeminiState(liveBackup)
          throw writeErr
        }

        const mismatches: string[] = []
        for (const relPath of MANAGED_AUTH_FILES) {
          const live = readAuthFile(relPath)
          if (live === null) continue
          const owner = normalizeEmail(detectAuthFileEmail(relPath, live))
          if (owner && owner !== canonicalEmail) {
            mismatches.push(`${relPath} -> ${owner}`)
          }
        }

        spinner.stop(`Restored ${writtenPaths.size} auth target(s)`, 0)

        return {
          capturedEmails: captured.map((s) => s.email),
          restoredFiles: [...writtenPaths],
          removedStale,
          mismatches,
          stoppedCount,
          remainingCount,
          refreshStatus,
        }
      })

      if (outcome.mismatches.length > 0) {
        process.exitCode = 1
      }

      if (json) {
        console.log(
          JSON.stringify(
            {
              ok: outcome.mismatches.length === 0,
              switched: outcome.mismatches.length === 0,
              alreadyActive: false,
              email: canonicalEmail,
              capturedSessions: outcome.capturedEmails,
              restoredFiles: outcome.restoredFiles,
              removedFiles: outcome.removedStale,
              mismatchedFiles: outcome.mismatches,
              processesStopped: outcome.stoppedCount,
              processesRemaining: outcome.remainingCount,
              tokenRefresh: outcome.refreshStatus,
              warnings,
            },
            null,
            2
          )
        )
        return
      }

      if (quiet) return

      if (outcome.removedStale.length > 0) {
        console.log(
          `  ${c.dim("Removed stale files:")}\n${outcome.removedStale.map((entry) => `     ${c.dim(entry)}`).join("\n")}`
        )
      }

      for (const warn of warnings) {
        console.log(`  ${c.yellow("⚠")} ${warn}`)
      }

      if (outcome.mismatches.length > 0) {
        console.error(
          `  ${c.red("✗")} Live files were rewritten back by a running process:\n${outcome.mismatches.map((entry) => `     ${c.dim(entry)}`).join("\n")}`
        )
        return
      }

      const aliveNote =
        outcome.remainingCount > 0
          ? `\n${c.yellow("⚠")} ${outcome.remainingCount} agy process(es) still running and may overwrite this switch.`
          : ""

      if (interactive) {
        console.log()
        p.note(
          `${c.green("Active:")} ${canonicalEmail}\n${c.green("Files:")} ${outcome.restoredFiles.join("\n        ")}${aliveNote}`,
          "Switched"
        )
        p.outro(`${c.green("✔")} Now using ${c.cyan(canonicalEmail)}`)
      } else {
        console.log(`${c.green("✔")} Switched to ${canonicalEmail}`)
      }
    } catch (error) {
      spinner.stop("Switch failed", 1)
      reportFailure(`Switch failed: ${sanitizeErrorMessage(error)}`, {
        json,
        quiet,
      })
    }
  },
})
