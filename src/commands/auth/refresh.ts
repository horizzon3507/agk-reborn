import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import { getActiveAccountEmail } from "../../utils/accounts.js"
import {
  authFileExists,
  detectAuthFileEmail,
  extractRefreshToken,
  readAuthFile,
  writeAuthFileAtomic,
} from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { withAgkLock } from "../../utils/lock.js"
import { buildClientCandidates } from "../../utils/oauth-clients.js"
import { OAuthError, refreshAccessTokenAnyClient } from "../../utils/oauth.js"
import {
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
} from "../../utils/paths.js"
import {
  type Profile,
  getProfile,
  listProfiles,
  loadProfileSnapshots,
  setProfileClient,
  updateProfileFile,
} from "../../utils/profiles.js"
import { sanitizeErrorMessage } from "../../utils/redact.js"
import { detectCurrentSessionEmail } from "../../utils/session.js"
import { patchAuthFileTokens } from "../../utils/token-builders.js"
import {
  createSafeSpinner,
  getColors,
  isInteractiveSession,
} from "../../utils/tui.js"

interface AccountRefreshOutcome {
  email: string
  ok: boolean
  liveUpdated: boolean
  rotatedRefreshToken: boolean
  expiresInSeconds?: number | undefined
  error?: string | undefined
}

function syncLiveFilesIfOwnedBy(
  canonicalEmail: string,
  patched: ReadonlyArray<{ relPath: string; content: string }>
): boolean {
  for (const relPath of [KEYRING_REL, AGY_TOKEN_REL, OAUTH_CREDS_REL]) {
    const content = readAuthFile(relPath)
    if (content === null) continue
    const owner = detectAuthFileEmail(relPath, content)
    if (owner && owner !== canonicalEmail) {
      return false
    }
  }

  let sawTargetLive = false
  for (const relPath of [KEYRING_REL, AGY_TOKEN_REL, OAUTH_CREDS_REL]) {
    const content = readAuthFile(relPath)
    if (content && detectAuthFileEmail(relPath, content) === canonicalEmail) {
      sawTargetLive = true
    }
  }
  if (!sawTargetLive && getActiveAccountEmail() !== canonicalEmail) {
    return false
  }

  let updated = false
  for (const snap of patched) {
    if (!authFileExists(snap.relPath)) continue
    if (writeAuthFileAtomic(snap.relPath, snap.content)) {
      updated = true
    }
  }
  return updated
}

async function refreshSingleProfile(
  profile: Profile
): Promise<AccountRefreshOutcome> {
  const snapshots = loadProfileSnapshots(profile.email)
  if (snapshots.length === 0) {
    return {
      email: profile.email,
      ok: false,
      liveUpdated: false,
      rotatedRefreshToken: false,
      error: "Profile has no saved auth files",
    }
  }

  const refreshToken = snapshots
    .map((s) => extractRefreshToken(s))
    .find((tok): tok is string => tok !== null)

  if (!refreshToken) {
    return {
      email: profile.email,
      ok: false,
      liveUpdated: false,
      rotatedRefreshToken: false,
      error: "No refresh token stored in profile",
    }
  }

  const clients = buildClientCandidates({
    stored:
      profile.clientId && profile.clientSecret
        ? { clientId: profile.clientId, clientSecret: profile.clientSecret }
        : null,
    authFileContents: snapshots.map((s) => s.content),
  })

  try {
    const { tokens: fresh, client } = await refreshAccessTokenAnyClient(
      refreshToken,
      clients
    )

    const rotated = Boolean(
      fresh.refresh_token && fresh.refresh_token !== refreshToken
    )
    const effectiveRefresh = fresh.refresh_token ?? refreshToken

    const patched = snapshots.map((snap) => ({
      relPath: snap.relPath,
      content: patchAuthFileTokens(snap.relPath, snap.content, {
        access_token: fresh.access_token,
        refresh_token: effectiveRefresh,
        expires_in: fresh.expires_in,
        id_token: fresh.id_token,
      }),
    }))

    const liveUpdated = await withAgkLock("auth refresh", () => {
      if (
        client.id !== profile.clientId ||
        client.secret !== profile.clientSecret
      ) {
        setProfileClient(profile.email, client)
      }
      for (const item of patched) {
        updateProfileFile(profile.email, item.relPath, item.content)
      }
      return syncLiveFilesIfOwnedBy(profile.email, patched)
    })

    return {
      email: profile.email,
      ok: true,
      liveUpdated,
      rotatedRefreshToken: rotated,
      expiresInSeconds: fresh.expires_in,
    }
  } catch (error) {
    const msg =
      error instanceof OAuthError && error.kind === "invalid_grant"
        ? "Refresh token expired or revoked (invalid_grant)"
        : sanitizeErrorMessage(error, 160)
    return {
      email: profile.email,
      ok: false,
      liveUpdated: false,
      rotatedRefreshToken: false,
      error: msg,
    }
  }
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
    name: "refresh",
    description: "Refresh and verify OAuth tokens for saved profile(s)",
  },
  args: {
    email: {
      type: "positional",
      description: "Account email to refresh (defaults to current or --all)",
      required: false,
    },
    all: {
      type: "boolean",
      description: "Refresh all saved profiles",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output refresh results as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const interactive = isInteractiveSession({ json })
    const c = getColors(process.stdout)

    const posEmail =
      typeof args.email === "string" && args.email.trim().length > 0
        ? args.email.trim()
        : undefined

    if (posEmail && args.all) {
      reportError("Cannot combine positional <email> with --all", json)
      return
    }

    printHeader("agk auth refresh", { json })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Refresh tokens")}`)
    }

    const profiles = listProfiles()
    if (profiles.length === 0) {
      if (interactive) {
        p.note("No profiles saved yet.", "Empty")
      }
      reportError("No saved profiles found. Run agk auth add first.", json)
      return
    }

    let targets: Profile[] = []
    if (args.all) {
      targets = profiles
    } else if (posEmail) {
      const found = getProfile(posEmail)
      if (!found) {
        reportError(`No profile for ${posEmail}`, json)
        return
      }
      targets = [found]
    } else {
      const activeEmail = detectCurrentSessionEmail() ?? getActiveAccountEmail()
      if (!interactive || profiles.length === 1) {
        const activeMatch = activeEmail ? getProfile(activeEmail) : null
        const fallback = profiles[0]
        if (activeMatch) targets = [activeMatch]
        else if (fallback) targets = [fallback]
      } else {
        const selected = await p.select<string>({
          message: "Refresh which account?",
          options: [
            {
              value: "__all__",
              label: `All saved profiles (${profiles.length})`,
              hint: "Verify and refresh every profile",
            },
            ...profiles.map((prof) => ({
              value: prof.email,
              label:
                prof.email === activeEmail
                  ? `${prof.email} ${c.green("(current)")}`
                  : prof.email,
            })),
          ],
          initialValue: "__all__",
        })

        if (p.isCancel(selected)) {
          p.cancel("Cancelled")
          process.exitCode = 130
          return
        }

        if (selected === "__all__") {
          targets = profiles
        } else {
          const match = getProfile(selected)
          if (match) targets = [match]
        }
      }
    }

    const spinner = createSafeSpinner(interactive)
    spinner.start(`Refreshing ${targets.length} profile(s)...`)

    const results: AccountRefreshOutcome[] = []
    for (const target of targets) {
      results.push(await refreshSingleProfile(target))
    }

    const failed = results.filter((r) => !r.ok).length
    if (failed > 0) {
      process.exitCode = 1
    }

    spinner.stop(
      failed === 0
        ? `Refreshed ${results.length} profile(s)`
        : `${results.length - failed} refreshed, ${failed} failed`,
      failed === 0 ? 0 : 1
    )

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: failed === 0,
            refreshed: results.length - failed,
            failed,
            results,
          },
          null,
          2
        )
      )
      return
    }

    for (const item of results) {
      if (item.ok) {
        const liveTag = item.liveUpdated ? c.green(" (live updated)") : ""
        console.log(`  ${c.green("✔")} ${c.cyan(item.email)}${liveTag}`)
      } else {
        console.log(
          `  ${c.red("✗")} ${c.cyan(item.email)} ${c.dim(`· ${item.error ?? "failed"}`)}`
        )
      }
    }

    if (interactive) {
      p.outro(
        failed === 0
          ? `${c.green("✔")} All tokens valid`
          : `${c.red("✗")} ${failed} profile(s) failed refresh`
      )
    }
  },
})
