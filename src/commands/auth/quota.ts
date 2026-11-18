import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { extractRefreshToken } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import {
  getProfile,
  listProfiles,
  loadProfileSnapshots,
  setProfileClient,
  updateProfileFile,
} from "../../utils/profiles.js"
import {
  type QuotaResult,
  clampQuotaPercentage,
  getQuotaWithRefresh,
} from "../../utils/quota.js"
import {
  normalizeEmail,
  sanitizeErrorMessage,
  sanitizeTerminalText,
} from "../../utils/redact.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"
import { patchAuthFileTokens } from "../../utils/token-builders.js"
import {
  createSafeSpinner,
  formatResetCountdown,
  getColors,
  isDumbTerminal,
  isInteractiveSession,
  padDisplayEnd,
  runLiveMonitor,
  truncateDisplay,
} from "../../utils/tui.js"

function parseRefreshInterval(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 30
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 5 || parsed > 3600) return null
  return parsed
}

function createProgressBar(percentage: number, width = 10): string {
  const c = getColors(process.stdout)
  const dumb = isDumbTerminal()
  const safePct = clampQuotaPercentage(percentage)
  const filled = Math.max(
    0,
    Math.min(width, Math.round((safePct / 100) * width))
  )
  const empty = Math.max(0, width - filled)
  const color = safePct >= 70 ? c.green : safePct >= 30 ? c.yellow : c.red
  const fillChar = dumb ? "#" : "█"
  const emptyChar = dumb ? "-" : "░"
  return color(fillChar.repeat(filled)) + c.dim(emptyChar.repeat(empty))
}

function renderQuotaLines(params: {
  email: string
  quota: QuotaResult | null
  lastError: string | null
  countdown: number
  isLoading: boolean
  isInteractive: boolean
  columns: number
}): string[] {
  const c = getColors(process.stdout)
  const dumb = isDumbTerminal()
  const maxWidth = Math.max(48, params.columns - 1)
  const lines: string[] = []

  lines.push("")
  lines.push(c.bold(`  Quota · ${c.cyan(params.email)}`))

  if (params.quota?.subscriptionTier) {
    lines.push(
      `  ${c.dim("Tier:")} ${c.magenta(sanitizeTerminalText(params.quota.subscriptionTier, 48))}`
    )
  }

  if (params.lastError) {
    lines.push(
      `  ${c.red("✗")} ${truncateDisplay(params.lastError, maxWidth - 6)}`
    )
  }

  if (!params.quota) {
    lines.push("")
    if (params.isLoading) {
      lines.push(c.dim("  Loading quota..."))
    }
    lines.push("")
    return lines
  }

  if (params.quota.isForbidden) {
    lines.push("")
    lines.push(`  ${c.red("Account forbidden by Cloud Code API (HTTP 403)")}`)
    lines.push("")
  } else if (params.quota.models.length === 0) {
    lines.push("")
    lines.push(c.dim("  No model quota entries reported for this account."))
    lines.push("")
  } else {
    lines.push("")

    const quotaColWidth = 17
    const resetColWidth = 15
    const modelColWidth = Math.min(
      36,
      Math.max(18, maxWidth - quotaColWidth - resetColWidth - 6)
    )

    const hChar = dumb ? "-" : "─"
    const vChar = dumb ? "|" : "│"
    const border = (left: string, mid: string, right: string): string =>
      c.dim(
        `  ${left}${hChar.repeat(modelColWidth)}${mid}${hChar.repeat(quotaColWidth)}${mid}${hChar.repeat(resetColWidth)}${right}`
      )

    lines.push(dumb ? border("+", "+", "+") : border("┌", "┬", "┐"))
    lines.push(
      `  ${c.dim(vChar)} ${c.bold(padDisplayEnd("Model", modelColWidth - 2))} ${c.dim(vChar)} ${c.bold(padDisplayEnd("Quota", quotaColWidth - 2))} ${c.dim(vChar)} ${c.bold(padDisplayEnd("Reset", resetColWidth - 2))} ${c.dim(vChar)}`
    )
    lines.push(dumb ? border("+", "+", "+") : border("├", "┼", "┤"))

    const sortedModels = [...params.quota.models].sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    for (const model of sortedModels) {
      const displayName = truncateDisplay(
        sanitizeTerminalText(model.name, 80),
        modelColWidth - 2
      )
      const safePct = clampQuotaPercentage(model.percentage)
      const bar = createProgressBar(safePct, 10)
      const pctText = `${safePct}%`.padStart(4)
      const reset = truncateDisplay(
        formatResetCountdown(model.resetTime, "prefixed"),
        resetColWidth - 2
      )

      lines.push(
        `  ${c.dim(vChar)} ${padDisplayEnd(displayName, modelColWidth - 2)} ${c.dim(vChar)} ${bar} ${pctText} ${c.dim(vChar)} ${padDisplayEnd(reset, resetColWidth - 2)} ${c.dim(vChar)}`
      )
    }

    lines.push(dumb ? border("+", "+", "+") : border("└", "┴", "┘"))
    lines.push("")
  }

  if (params.isInteractive) {
    lines.push(
      c.dim(
        params.isLoading
          ? "  Refreshing..."
          : `  Refresh in ${params.countdown}s · 'r' reload · 'q' quit`
      )
    )
    lines.push("")
  }

  return lines
}

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
    name: "quota",
    description: "Live quota monitor for a saved account",
  },
  args: {
    email: {
      type: "positional",
      description: "Account email (defaults to current account)",
      required: false,
    },
    account: {
      type: "string",
      description: "Account email (defaults to current account)",
      alias: "a",
    },
    once: {
      type: "boolean",
      description: "Print once and exit (no live monitor)",
      default: false,
    },
    interval: {
      type: "string",
      description: "Refresh interval in seconds (5-3600)",
      alias: "i",
      default: "30",
    },
    json: {
      type: "boolean",
      description: "Output quota as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const c = getColors(process.stdout)

    const intervalSeconds = parseRefreshInterval(args.interval)
    if (intervalSeconds === null) {
      reportError(
        `Invalid --interval value "${String(args.interval)}": expected an integer between 5 and 3600`,
        json
      )
      return
    }

    const posEmail =
      typeof args.email === "string" && args.email.trim().length > 0
        ? args.email.trim()
        : undefined
    const flagEmail =
      typeof args.account === "string" && args.account.trim().length > 0
        ? args.account.trim()
        : undefined

    if (
      posEmail &&
      flagEmail &&
      normalizeEmail(posEmail) !== normalizeEmail(flagEmail)
    ) {
      reportError(
        `Conflicting account arguments: "${posEmail}" vs --account "${flagEmail}"`,
        json
      )
      return
    }

    const interactive = isInteractiveSession({ json })
    const singleShot = Boolean(args.once) || !interactive

    printHeader("agk auth quota", { json })
    if (interactive && !json) {
      p.intro(`${c.cyan("◆")} ${c.bold("Quota monitor")}`)
    }

    const profiles = listProfiles()
    if (profiles.length === 0) {
      if (interactive) {
        p.note(
          `No profiles yet. Add one with:\n\n  ${c.cyan("agk auth add")}`,
          "Empty"
        )
      }
      reportError("No saved profiles found. Run agk auth add first.", json)
      return
    }

    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()
    let requestedEmail = posEmail ?? flagEmail

    if (!requestedEmail) {
      const firstProfile = profiles[0]
      if (!firstProfile) {
        reportError("No saved profiles found", json)
        return
      }

      if (singleShot || profiles.length === 1) {
        const activeMatch = activeEmail ? getProfile(activeEmail) : null
        requestedEmail = activeMatch?.email ?? firstProfile.email
      } else {
        const defaultChoice =
          (activeEmail ? getProfile(activeEmail)?.email : undefined) ??
          firstProfile.email
        const selected = await p.select<string>({
          message: "Account to monitor:",
          options: profiles.map((profile) => {
            const option: { value: string; label: string; hint?: string } = {
              value: profile.email,
              label: profile.email,
            }
            if (profile.email === activeEmail) option.hint = "current"
            return option
          }),
          initialValue: defaultChoice,
        })

        if (p.isCancel(selected)) {
          p.cancel("Cancelled")
          process.exitCode = 130
          return
        }
        requestedEmail = selected
      }
    }

    const targetProfile = getProfile(requestedEmail)
    if (!targetProfile) {
      reportError(
        `No profile for ${requestedEmail}. Run agk auth list to see saved accounts.`,
        json
      )
      return
    }

    const canonicalEmail = targetProfile.email
    const loadAccountCredentials = (): {
      token: string | null
      clients: ReturnType<typeof buildClientCandidates>
      profile: typeof targetProfile
    } => {
      const latestProfile = getProfile(canonicalEmail) ?? targetProfile
      const snapshots = loadProfileSnapshots(canonicalEmail)
      const token =
        snapshots
          .map((s) => extractRefreshToken(s))
          .find((tok): tok is string => tok !== null) ?? null
      const clients = buildClientCandidates({
        stored:
          latestProfile.clientId && latestProfile.clientSecret
            ? {
                clientId: latestProfile.clientId,
                clientSecret: latestProfile.clientSecret,
              }
            : null,
        authFileContents: snapshots.map((s) => s.content),
      })
      return { token, clients, profile: latestProfile }
    }

    const initialCreds = loadAccountCredentials()
    if (!initialCreds.token) {
      reportError(`No refresh token stored for ${canonicalEmail}`, json)
      return
    }

    const executeSingleFetch = async (
      signal?: AbortSignal
    ): Promise<QuotaResult> => {
      const creds = loadAccountCredentials()
      if (!creds.token) {
        throw new Error(`No refresh token stored for ${canonicalEmail}`)
      }
      const res = await getQuotaWithRefresh(creds.token, creds.clients, {
        signal,
        timeoutMs: 12_000,
      })

      if (
        res.client.id !== creds.profile.clientId ||
        res.client.secret !== creds.profile.clientSecret
      ) {
        setProfileClient(canonicalEmail, res.client)
      }

      if (
        res.refreshedTokens.refresh_token &&
        res.refreshedTokens.refresh_token !== creds.token
      ) {
        const snapshots = loadProfileSnapshots(canonicalEmail)
        for (const snap of snapshots) {
          const updated = patchAuthFileTokens(snap.relPath, snap.content, {
            access_token: res.refreshedTokens.access_token,
            refresh_token: res.refreshedTokens.refresh_token,
            expires_in: res.refreshedTokens.expires_in,
            id_token: res.refreshedTokens.id_token,
          })
          updateProfileFile(canonicalEmail, snap.relPath, updated)
        }
      }

      return res
    }

    if (json || singleShot) {
      const spinner = createSafeSpinner(interactive && !json)
      spinner.start("Fetching quota...")
      try {
        const quota = await executeSingleFetch()
        spinner.stop("Done", 0)

        if (json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                email: canonicalEmail,
                projectId: quota.projectId ?? null,
                subscriptionTier: quota.subscriptionTier ?? null,
                isForbidden: Boolean(quota.isForbidden),
                models: quota.models,
              },
              null,
              2
            )
          )
          return
        }

        const lines = renderQuotaLines({
          email: canonicalEmail,
          quota,
          lastError: null,
          countdown: 0,
          isLoading: false,
          isInteractive: false,
          columns: process.stdout.columns ?? 80,
        })
        console.log(lines.join("\n"))
      } catch (error) {
        spinner.stop("Failed", 1)
        reportError(sanitizeErrorMessage(error), json)
      }
      return
    }

    let currentQuota: QuotaResult | null = null
    let lastError: string | null = null

    console.log()
    console.log(
      c.dim(`  Monitoring ${c.cyan(canonicalEmail)} every ${intervalSeconds}s`)
    )

    const stopReason = await runLiveMonitor({
      intervalSeconds,
      once: false,
      onRefresh: async (signal) => {
        try {
          currentQuota = await executeSingleFetch(signal)
          lastError = null
        } catch (error) {
          if (signal.aborted) return
          lastError = `Failed to fetch quota: ${sanitizeErrorMessage(error, 140)}`
        }
      },
      renderLines: (ctx) =>
        renderQuotaLines({
          email: canonicalEmail,
          quota: currentQuota,
          lastError,
          countdown: ctx.countdown,
          isLoading: ctx.isLoading,
          isInteractive: ctx.isInteractive,
          columns: ctx.columns,
        }),
    })

    if (stopReason === "sigint") {
      process.exitCode = 130
      return
    }

    p.outro(c.dim("Stopped"))
  },
})
