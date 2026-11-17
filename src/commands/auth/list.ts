import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import Table from "cli-table3"
import pc from "picocolors"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { extractRefreshToken } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import type { OAuthClient } from "../../utils/oauth.js"
import { listProfiles, loadProfileSnapshots } from "../../utils/profiles.js"
import { type ModelQuota, getQuotaWithRefresh } from "../../utils/quota.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"

const TARGET_MODELS = ["claude-opus-4-5-thinking", "gemini-3-pro-high"]
const REFRESH_INTERVAL = 30

interface QuotaInfo {
  percentage: number
  resetTime: string
}

interface Row {
  email: string
  isActive: boolean
  fileCount: number
  createdAt: number
  refreshToken: string | null
  clients: OAuthClient[]
  quotas: Map<string, QuotaInfo | null>
  isLoading: boolean
  error?: string
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return `${str.slice(0, maxLength - 3)}...`
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[1A\x1b[2K")
  }
}

function formatResetTime(resetTimeStr: string): string {
  if (!resetTimeStr) return ""

  try {
    const diffMs = new Date(resetTimeStr).getTime() - Date.now()
    if (diffMs <= 0) return "now"

    const hours = Math.floor(diffMs / 3_600_000)
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000)

    if (hours > 0) return `${hours}h${minutes}m`
    return `${minutes}m`
  } catch {
    return ""
  }
}

function createQuotaDisplay(
  info: QuotaInfo | null,
  isLoading: boolean
): string {
  if (isLoading) return pc.dim("...")
  if (info === null) return pc.dim("—")

  const color =
    info.percentage >= 70
      ? pc.green
      : info.percentage >= 30
        ? pc.yellow
        : pc.red
  const reset = formatResetTime(info.resetTime)
  return color(reset ? `${info.percentage}% (${reset})` : `${info.percentage}%`)
}

function findModelQuota(
  models: ModelQuota[],
  target: string
): QuotaInfo | null {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/^models\//, "")
      .trim()
  const wanted = normalize(target)

  const model =
    models.find((m) => normalize(m.name) === wanted) ??
    models.find((m) => {
      const name = normalize(m.name)
      return name.includes(wanted) || wanted.includes(name)
    }) ??
    models.find((m) => {
      const wantedParts = wanted.split("-")
      const nameParts = normalize(m.name).split("-")
      return (
        wantedParts.length >= 2 &&
        nameParts.length >= 2 &&
        wantedParts[0] === nameParts[0] &&
        wantedParts[1] === nameParts[1]
      )
    })

  if (!model) return null
  return { percentage: model.percentage, resetTime: model.resetTime }
}

function setupKeyHandler(onReload: () => void, onExit: () => void): () => void {
  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")

  const handler = (key: string) => {
    if (key === "q" || key === "\x03") onExit()
    else if (key === "r") onReload()
  }
  stdin.on("data", handler)

  return () => {
    stdin.removeListener("data", handler)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

function renderTable(
  rows: Row[],
  countdown: number,
  isLoading: boolean
): number {
  const table = new Table({
    head: [
      pc.white(""),
      pc.white("Email"),
      pc.white("Files"),
      pc.white("Claude"),
      pc.white("Gemini"),
      pc.white("Saved"),
    ],
    style: { head: [], border: ["gray"] },
    colWidths: [3, 30, 12, 16, 16, 14],
  })

  for (const row of rows) {
    table.push([
      row.isActive ? pc.green("●") : pc.dim("○"),
      row.isActive
        ? pc.green(truncate(row.email, 28))
        : truncate(row.email, 28),
      pc.dim(String(row.fileCount)),
      createQuotaDisplay(
        row.quotas.get(TARGET_MODELS[0] ?? "") ?? null,
        row.isLoading
      ),
      createQuotaDisplay(
        row.quotas.get(TARGET_MODELS[1] ?? "") ?? null,
        row.isLoading
      ),
      pc.dim(formatDate(row.createdAt)),
    ])
  }

  const lines: string[] = ["", pc.bold("  Account Profiles"), ""]
  for (const line of table.toString().split("\n")) {
    lines.push(`  ${line}`)
  }
  lines.push("")

  const active = rows.find((row) => row.isActive)
  if (active) {
    lines.push(pc.dim("  Active: ") + pc.green(active.email))
  }

  lines.push("")
  lines.push(
    pc.dim(
      `  ${rows.length} profile(s) · ${isLoading ? "Loading quotas..." : `Refresh in ${countdown}s · 'r' reload · 'q' quit`}`
    )
  )
  lines.push("")

  for (const line of lines) console.log(line)
  return lines.length
}

async function fetchQuotas(rows: Row[]): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      if (!row.refreshToken) return
      try {
        const result = await getQuotaWithRefresh(row.refreshToken, row.clients)
        for (const target of TARGET_MODELS) {
          row.quotas.set(target, findModelQuota(result.models, target))
        }
      } catch (error) {
        row.error = error instanceof Error ? error.message : "Unknown error"
      }
    })
  )
}

export default defineCommand({
  meta: {
    name: "list",
    description: "List saved accounts with live quota",
  },
  async run() {
    printHeader("agk auth list")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Saved accounts")}`)

    const profiles = listProfiles()
    if (profiles.length === 0) {
      p.note(
        `No profiles yet. Add one with:\n\n  ${pc.cyan("agk auth add")}`,
        "Empty"
      )
      p.outro(pc.dim("Done"))
      return
    }

    const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()

    const rows: Row[] = profiles.map((profile) => {
      const snapshots = loadProfileSnapshots(profile.email)
      const refreshToken =
        snapshots
          .map((snapshot) => extractRefreshToken(snapshot))
          .find((token): token is string => token !== null) ?? null

      return {
        email: profile.email,
        isActive: profile.email === activeEmail,
        fileCount: Object.keys(profile.files).length,
        createdAt: profile.createdAt,
        refreshToken,
        clients: buildClientCandidates({
          stored:
            profile.clientId && profile.clientSecret
              ? {
                  clientId: profile.clientId,
                  clientSecret: profile.clientSecret,
                }
              : null,
          authFileContents: snapshots.map((snapshot) => snapshot.content),
        }),
        quotas: new Map(),
        isLoading: true,
      }
    })

    let running = true
    let lastLineCount = 0
    let countdown = REFRESH_INTERVAL
    let isLoading = false

    const render = (loading: boolean) => {
      if (lastLineCount > 0) clearLines(lastLineCount)
      lastLineCount = renderTable(rows, countdown, loading)
    }

    const fetchAndRender = async () => {
      if (isLoading) return
      isLoading = true
      for (const row of rows) row.isLoading = true
      render(true)
      await fetchQuotas(rows)
      for (const row of rows) row.isLoading = false
      countdown = REFRESH_INTERVAL
      isLoading = false
      render(false)
    }

    console.log()
    await fetchAndRender()

    const cleanup = setupKeyHandler(
      () => {
        fetchAndRender()
      },
      () => {
        running = false
      }
    )

    const intervalId = setInterval(() => {
      if (!running) return
      countdown--
      if (!isLoading) render(false)
      if (countdown <= 0) fetchAndRender()
    }, 1000)

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (running) return
        clearInterval(check)
        clearInterval(intervalId)
        cleanup()
        console.log()
        p.outro(pc.dim("Closed"))
        resolve()
      }, 100)
    })
  },
})
