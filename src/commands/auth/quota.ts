import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import { extractRefreshToken } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import { listProfiles, loadProfileSnapshots } from "../../utils/profiles.js"
import { type QuotaResult, getQuotaWithRefresh } from "../../utils/quota.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write("\x1b[1A\x1b[2K")
  }
}

function formatResetTime(resetTimeStr: string): string {
  if (!resetTimeStr) return "—"

  try {
    const diffMs = new Date(resetTimeStr).getTime() - Date.now()
    if (diffMs <= 0) return "now"

    const hours = Math.floor(diffMs / 3_600_000)
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000)

    if (hours > 0) return `in ${hours}h ${minutes}m`
    return `in ${minutes}m`
  } catch {
    return resetTimeStr.slice(0, 16)
  }
}

function createProgressBar(percentage: number, width = 10): string {
  const filled = Math.round((percentage / 100) * width)
  const color =
    percentage >= 70 ? pc.green : percentage >= 30 ? pc.yellow : pc.red
  return color("█".repeat(filled)) + pc.dim("░".repeat(width - filled))
}

function renderQuotaTable(
  email: string,
  quota: QuotaResult,
  countdown: number,
  isLoading = false
): number {
  const lines: string[] = []

  lines.push("")
  lines.push(pc.bold(`  Quota — ${pc.cyan(email)}`))

  if (quota.subscriptionTier) {
    lines.push(`  ${pc.dim("Tier:")} ${pc.magenta(quota.subscriptionTier)}`)
  }

  if (quota.isForbidden) {
    lines.push(`  ${pc.red("FORBIDDEN (403)")}`)
    lines.push("")
    return printLines(lines)
  }

  lines.push("")

  const modelColWidth = 30
  const quotaColWidth = 14
  const resetColWidth = 15

  const border = (left: string, mid: string, right: string) =>
    pc.dim(
      `  ${left}${"─".repeat(modelColWidth)}${mid}${"─".repeat(quotaColWidth)}${mid}${"─".repeat(resetColWidth)}${right}`
    )

  lines.push(border("┌", "┬", "┐"))
  lines.push(
    `  │${pc.bold(" Model".padEnd(modelColWidth - 1))}│${pc.bold(" Quota".padEnd(quotaColWidth - 1))}│${pc.bold(" Reset".padEnd(resetColWidth - 1))}│`
  )
  lines.push(border("├", "┼", "┤"))

  const sortedModels = [...quota.models].sort((a, b) =>
    a.name.localeCompare(b.name)
  )

  for (const model of sortedModels) {
    const displayName =
      model.name.length > modelColWidth - 3
        ? `${model.name.slice(0, modelColWidth - 4)}…`
        : model.name
    const bar = createProgressBar(model.percentage)
    const pct = `${model.percentage}%`.padStart(4)
    const reset = formatResetTime(model.resetTime)
    lines.push(
      `  │ ${displayName.padEnd(modelColWidth - 2)}│ ${bar} ${pct} │ ${reset.padEnd(resetColWidth - 3)}│`
    )
  }

  lines.push(border("└", "┴", "┘"))
  lines.push("")
  lines.push(
    pc.dim(
      isLoading
        ? "  Refreshing..."
        : `  Refresh in ${countdown}s · 'r' reload · 'q' quit`
    )
  )
  lines.push("")

  return printLines(lines)
}

function printLines(lines: string[]): number {
  for (const line of lines) console.log(line)
  return lines.length
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

function getRefreshTokenFor(email: string): {
  token: string | null
  clients: ReturnType<typeof buildClientCandidates>
} {
  const snapshots = loadProfileSnapshots(email)
  const token =
    snapshots
      .map((snapshot) => extractRefreshToken(snapshot))
      .find((entry): entry is string => entry !== null) ?? null

  const profile = listProfiles().find((entry) => entry.email === email)
  const clients = buildClientCandidates({
    stored:
      profile?.clientId && profile.clientSecret
        ? { clientId: profile.clientId, clientSecret: profile.clientSecret }
        : null,
    authFileContents: snapshots.map((snapshot) => snapshot.content),
  })
  return { token, clients }
}

export default defineCommand({
  meta: {
    name: "quota",
    description: "Live quota monitor for a saved account",
  },
  args: {
    account: {
      type: "string",
      description: "Account email (defaults to current)",
      alias: "a",
    },
    once: {
      type: "boolean",
      description: "Print once and exit (no live monitor)",
      default: false,
    },
    interval: {
      type: "string",
      description: "Refresh interval in seconds",
      alias: "i",
      default: "30",
    },
  },
  async run({ args }) {
    printHeader("agk auth quota")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Quota monitor")}`)

    const profiles = listProfiles()
    if (profiles.length === 0) {
      p.note(
        `No profiles yet. Add one with:\n\n  ${pc.cyan("agk auth add")}`,
        "Empty"
      )
      p.cancel("Nothing to check")
      process.exit(1)
    }

    let email = args.account

    if (!email) {
      const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()

      const firstProfile = profiles[0]
      if (!firstProfile) {
        p.cancel("No profiles saved")
        process.exit(1)
      }

      if (profiles.length === 1) {
        email = firstProfile.email
      } else {
        const selected = await p.select({
          message: "Account to monitor:",
          options: profiles.map((profile) => {
            const option: { value: string; label: string; hint?: string } = {
              value: profile.email,
              label: profile.email,
            }
            if (profile.email === activeEmail) option.hint = "current"
            return option
          }),
          initialValue: activeEmail ?? firstProfile.email,
        })

        if (p.isCancel(selected)) {
          p.cancel("Cancelled")
          process.exit(0)
        }
        email = selected
      }
    }

    const { token: refreshToken, clients } = getRefreshTokenFor(email)
    if (!refreshToken) {
      p.cancel(`No refresh token stored for ${email}`)
      process.exit(1)
    }

    if (args.once) {
      const spinner = p.spinner()
      spinner.start("Fetching quota...")
      try {
        const quota = await getQuotaWithRefresh(refreshToken, clients)
        spinner.stop("Done")
        renderQuotaTable(email, quota, 0, false)
      } catch (error) {
        spinner.stop("Failed")
        p.cancel(error instanceof Error ? error.message : "Unknown error")
        process.exit(1)
      }
      return
    }

    const refreshInterval = Math.max(
      10,
      Number.parseInt(args.interval, 10) || 30
    )

    console.log()
    console.log(
      pc.dim(`  Monitoring ${pc.cyan(email)} every ${refreshInterval}s`)
    )

    let running = true
    let lastLineCount = 0
    let countdown = refreshInterval
    let isLoading = true
    let currentQuota: QuotaResult | null = null

    const fetchAndRender = async () => {
      isLoading = true
      try {
        currentQuota = await getQuotaWithRefresh(refreshToken, clients)
        countdown = refreshInterval
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        console.log(pc.red(`  Failed to fetch quota: ${message}`))
      }
      isLoading = false

      if (lastLineCount > 0) clearLines(lastLineCount)
      if (currentQuota) {
        lastLineCount = renderQuotaTable(email, currentQuota, countdown, false)
      }
    }

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
      if (lastLineCount > 0 && currentQuota && !isLoading) {
        clearLines(lastLineCount)
        lastLineCount = renderQuotaTable(email, currentQuota, countdown, false)
      }
      if (countdown <= 0) fetchAndRender()
    }, 1000)

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (running) return
        clearInterval(check)
        clearInterval(intervalId)
        cleanup()
        console.log()
        p.outro(pc.dim("Stopped"))
        resolve()
      }, 100)
    })
  },
})
