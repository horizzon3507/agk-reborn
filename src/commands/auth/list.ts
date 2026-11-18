import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import Table from "cli-table3"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { extractRefreshToken } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import {
  discoverOAuthClients,
  extractClientFromAuthFile,
} from "../../utils/oauth-clients.js"
import { type OAuthClient, OAuthError } from "../../utils/oauth.js"
import {
  listProfiles,
  loadProfileSnapshots,
  setProfileClient,
  updateProfileFile,
} from "../../utils/profiles.js"
import {
  type ModelQuota,
  getQuotaWithRefresh,
  resolveFamilyQuota,
} from "../../utils/quota.js"
import {
  sanitizeErrorMessage,
  sanitizeTerminalText,
} from "../../utils/redact.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"
import { patchAuthFileTokens } from "../../utils/token-builders.js"
import {
  formatResetCountdown,
  getColors,
  isColorEnabled,
  isDumbTerminal,
  isInteractiveSession,
  runLiveMonitor,
  truncateDisplay,
} from "../../utils/tui.js"

const DEFAULT_REFRESH_SECONDS = 30

interface RowState {
  email: string
  isActive: boolean
  fileCount: number
  createdAt: number
  updatedAt: number
  refreshToken: string | null
  storedClient: { clientId: string; clientSecret: string } | null
  clients: OAuthClient[]
  claudeQuota: ModelQuota | null
  geminiQuota: ModelQuota | null
  allModels: ModelQuota[]
  subscriptionTier: string | null
  isForbidden: boolean
  errorKind: "revoked" | "error" | null
  errorMessage: string | null
  isLoading: boolean
}

function parseIntervalSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null) return DEFAULT_REFRESH_SECONDS
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const val = Number.parseInt(trimmed, 10)
  if (!Number.isSafeInteger(val) || val < 5 || val > 3600) return null
  return val
}

function formatSavedDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-"
  const d = new Date(timestamp)
  if (!Number.isFinite(d.getTime())) return "-"
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function formatQuotaCell(
  row: RowState,
  quota: ModelQuota | null,
  isLoading: boolean,
  compact: boolean
): string {
  const c = getColors(process.stdout)
  if (isLoading || row.isLoading) return c.dim("...")
  if (!row.refreshToken) return c.yellow("no token")
  if (row.isForbidden) return c.red("403")
  if (row.errorKind === "revoked") return c.red("revoked")
  if (row.errorKind === "error") return c.red("error")
  if (!quota) return c.dim("-")

  const color =
    quota.percentage >= 70 ? c.green : quota.percentage >= 30 ? c.yellow : c.red

  if (compact) return color(`${quota.percentage}%`)
  const reset = formatResetCountdown(quota.resetTime, "compact")
  return color(
    reset ? `${quota.percentage}% (${reset})` : `${quota.percentage}%`
  )
}

function syncRowsFromDisk(previous: ReadonlyMap<string, RowState>): RowState[] {
  const profiles = listProfiles()
  if (profiles.length === 0) return []

  const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()
  const discovered = discoverOAuthClients()

  return profiles.map((profile) => {
    const prev = previous.get(profile.email)
    if (prev && prev.updatedAt === profile.updatedAt) {
      return {
        ...prev,
        isActive: profile.email === activeEmail,
      }
    }

    const snapshots = loadProfileSnapshots(profile.email)
    const refreshToken =
      snapshots
        .map((s) => extractRefreshToken(s))
        .find((tok): tok is string => tok !== null) ?? null

    const storedClient =
      profile.clientId && profile.clientSecret
        ? { clientId: profile.clientId, clientSecret: profile.clientSecret }
        : null

    const clients: OAuthClient[] = []
    const seen = new Set<string>()
    const addClient = (cand: OAuthClient | null): void => {
      if (!cand) return
      const key = `${cand.id}:${cand.secret}`
      if (seen.has(key)) return
      seen.add(key)
      clients.push(cand)
    }

    if (storedClient) {
      addClient({
        id: storedClient.clientId,
        secret: storedClient.clientSecret,
        label: "profile",
      })
    }
    for (const snap of snapshots) {
      addClient(extractClientFromAuthFile(snap.content))
    }
    for (const disc of discovered) {
      addClient(disc)
    }

    return {
      email: profile.email,
      isActive: profile.email === activeEmail,
      fileCount: Object.keys(profile.files).length,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      refreshToken,
      storedClient,
      clients,
      claudeQuota: prev?.claudeQuota ?? null,
      geminiQuota: prev?.geminiQuota ?? null,
      allModels: prev?.allModels ?? [],
      subscriptionTier: prev?.subscriptionTier ?? null,
      isForbidden: false,
      errorKind: null,
      errorMessage: null,
      isLoading: true,
    }
  })
}

async function refreshRowQuotas(
  rows: RowState[],
  signal: AbortSignal
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      row.isLoading = true
      row.errorKind = null
      row.errorMessage = null
      row.isForbidden = false

      if (!row.refreshToken) {
        row.claudeQuota = null
        row.geminiQuota = null
        row.allModels = []
        row.isLoading = false
        return
      }

      try {
        const result = await getQuotaWithRefresh(
          row.refreshToken,
          row.clients,
          { signal, timeoutMs: 12_000 }
        )

        if (
          !row.storedClient ||
          row.storedClient.clientId !== result.client.id ||
          row.storedClient.clientSecret !== result.client.secret
        ) {
          setProfileClient(row.email, result.client)
          row.storedClient = {
            clientId: result.client.id,
            clientSecret: result.client.secret,
          }
        }

        if (
          result.refreshedTokens.refresh_token &&
          result.refreshedTokens.refresh_token !== row.refreshToken
        ) {
          const newRefresh = result.refreshedTokens.refresh_token
          row.refreshToken = newRefresh
          const snapshots = loadProfileSnapshots(row.email)
          for (const snap of snapshots) {
            const updated = patchAuthFileTokens(snap.relPath, snap.content, {
              access_token: result.refreshedTokens.access_token,
              refresh_token: newRefresh,
              expires_in: result.refreshedTokens.expires_in,
              id_token: result.refreshedTokens.id_token,
            })
            updateProfileFile(row.email, snap.relPath, updated)
          }
        }

        row.isForbidden = Boolean(result.isForbidden)
        row.subscriptionTier = result.subscriptionTier ?? null
        row.allModels = result.models

        if (row.isForbidden) {
          row.claudeQuota = null
          row.geminiQuota = null
        } else {
          row.claudeQuota = resolveFamilyQuota(result.models, "claude")
          row.geminiQuota = resolveFamilyQuota(result.models, "gemini")
        }
      } catch (error) {
        if (signal.aborted) return
        row.claudeQuota = null
        row.geminiQuota = null
        row.allModels = []
        if (error instanceof OAuthError && error.kind === "invalid_grant") {
          row.errorKind = "revoked"
          row.errorMessage = "Refresh token expired or revoked"
        } else {
          row.errorKind = "error"
          row.errorMessage = sanitizeErrorMessage(error, 120)
        }
      } finally {
        row.isLoading = false
      }
    })
  )
}

function buildDashboardLines(
  rows: readonly RowState[],
  ctx: {
    countdown: number
    isLoading: boolean
    isInteractive: boolean
    columns: number
  }
): string[] {
  const c = getColors(process.stdout)
  const colorOn = isColorEnabled(process.stdout)
  const dumb = isDumbTerminal()
  const maxWidth = Math.max(48, ctx.columns - 1)
  const compact = maxWidth < 96

  const emailCol = compact
    ? Math.max(18, maxWidth - 36)
    : Math.min(42, Math.max(26, maxWidth - 68))

  const head = compact
    ? ["", "Email", "Claude", "Gemini"]
    : ["", "Email", "Files", "Claude", "Gemini", "Saved"]

  const colWidths = compact
    ? [3, emailCol, 12, 12]
    : [3, emailCol, 7, 16, 16, 14]

  const tableOpts: ConstructorParameters<typeof Table>[0] = {
    head: head.map((h) => (colorOn ? c.white(h) : h)),
    style: { head: [], border: colorOn ? ["gray"] : [] },
    colWidths,
    wordWrap: false,
  }

  if (dumb) {
    tableOpts.chars = {
      top: "-",
      "top-mid": "+",
      "top-left": "+",
      "top-right": "+",
      bottom: "-",
      "bottom-mid": "+",
      "bottom-left": "+",
      "bottom-right": "+",
      left: "|",
      "left-mid": "+",
      mid: "-",
      "mid-mid": "+",
      right: "|",
      "right-mid": "+",
      middle: "|",
    }
  }

  const table = new Table(tableOpts)

  for (const row of rows) {
    const marker = row.isActive
      ? c.green(dumb ? "*" : "●")
      : c.dim(dumb ? "o" : "○")
    const safeEmail = truncateDisplay(
      sanitizeTerminalText(row.email, 120),
      Math.max(8, emailCol - 2)
    )
    const emailLabel = row.isActive ? c.green(safeEmail) : safeEmail
    const claudeCell = formatQuotaCell(
      row,
      row.claudeQuota,
      ctx.isLoading,
      compact
    )
    const geminiCell = formatQuotaCell(
      row,
      row.geminiQuota,
      ctx.isLoading,
      compact
    )

    if (compact) {
      table.push([marker, emailLabel, claudeCell, geminiCell])
    } else {
      table.push([
        marker,
        emailLabel,
        c.dim(String(row.fileCount)),
        claudeCell,
        geminiCell,
        c.dim(formatSavedDate(row.createdAt)),
      ])
    }
  }

  const lines: string[] = ["", c.bold("  Account Profiles"), ""]
  for (const line of table.toString().split("\n")) {
    lines.push(`  ${line}`)
  }
  lines.push("")

  const active = rows.find((r) => r.isActive)
  if (active) {
    lines.push(
      `  ${c.dim("Active:")} ${c.green(truncateDisplay(active.email, maxWidth - 12))}`
    )
  }

  const errored = rows.filter((r) => r.errorMessage)
  for (const errRow of errored.slice(0, 2)) {
    lines.push(
      `  ${c.yellow("⚠")} ${truncateDisplay(`${errRow.email}: ${errRow.errorMessage ?? ""}`, maxWidth - 6)}`
    )
  }

  if (ctx.isInteractive) {
    lines.push("")
    lines.push(
      c.dim(
        truncateDisplay(
          `  ${rows.length} profile(s) · ${ctx.isLoading ? "Loading quotas..." : `Refresh in ${ctx.countdown}s · 'r' reload · 'q' quit`}`,
          maxWidth
        )
      )
    )
  }
  lines.push("")

  return lines
}

export default defineCommand({
  meta: {
    name: "list",
    description: "List saved accounts with live quota",
  },
  args: {
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
      description: "Output saved accounts and quota as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const c = getColors(process.stdout)

    const intervalSeconds = parseIntervalSeconds(args.interval)
    if (intervalSeconds === null) {
      process.exitCode = 1
      const msg = `Invalid --interval value "${String(args.interval)}": expected an integer between 5 and 3600`
      if (json) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
      } else {
        console.error(`${getColors(process.stderr).red("✗")} ${msg}`)
      }
      return
    }

    const interactive = isInteractiveSession({ json })
    const singleShot = Boolean(args.once) || !interactive

    printHeader("agk auth list", { json })
    if (interactive && !json) {
      p.intro(`${c.cyan("◆")} ${c.bold("Saved accounts")}`)
    }

    const rowMap = new Map<string, RowState>()
    let rows = syncRowsFromDisk(rowMap)

    if (rows.length === 0) {
      if (json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              activeAccount:
                detectCurrentSessionEmail() ?? getActiveAccountEmail(),
              accounts: [],
            },
            null,
            2
          )
        )
        return
      }
      if (interactive) {
        p.note(
          `No profiles yet. Add one with:\n\n  ${c.cyan("agk auth add")}`,
          "Empty"
        )
        p.outro(c.dim("Done"))
      } else {
        console.log("No saved profiles. Run: agk auth add")
      }
      return
    }

    if (json) {
      const controller = new AbortController()
      await refreshRowQuotas(rows, controller.signal)
      const active = rows.find((r) => r.isActive)?.email ?? null
      console.log(
        JSON.stringify(
          {
            ok: true,
            activeAccount: active,
            accounts: rows.map((row) => ({
              email: row.email,
              isActive: row.isActive,
              fileCount: row.fileCount,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              hasRefreshToken: row.refreshToken !== null,
              subscriptionTier: row.subscriptionTier,
              isForbidden: row.isForbidden,
              error: row.errorMessage,
              claude: row.claudeQuota,
              gemini: row.geminiQuota,
              models: row.allModels,
            })),
          },
          null,
          2
        )
      )
      return
    }

    const stopReason = await runLiveMonitor({
      intervalSeconds,
      once: singleShot,
      onRefresh: async (signal) => {
        rows = syncRowsFromDisk(rowMap)
        for (const r of rows) rowMap.set(r.email, r)
        await refreshRowQuotas(rows, signal)
      },
      renderLines: (ctx) => buildDashboardLines(rows, ctx),
    })

    if (stopReason === "sigint") {
      process.exitCode = 130
      return
    }

    if (interactive && !singleShot) {
      p.outro(c.dim("Closed"))
    }
  },
})
