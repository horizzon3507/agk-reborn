import { getActiveAccountEmail } from "./accounts.js"
import {
  type AuthFileSnapshot,
  captureLiveAuthFiles,
  detectAuthFileEmail,
  extractRefreshToken,
  readAuthFile,
} from "./auth-files.js"
import { withAgkLockSync } from "./lock.js"
import { extractClientFromAuthFile } from "./oauth-clients.js"
import { AGY_TOKEN_REL, KEYRING_REL, OAUTH_CREDS_REL } from "./paths.js"
import { saveProfile } from "./profiles.js"
import { normalizeEmail } from "./redact.js"

const SESSION_EMAIL_PRECEDENCE = [
  KEYRING_REL,
  AGY_TOKEN_REL,
  OAUTH_CREDS_REL,
] as const

export function detectCurrentSessionEmail(
  preloadedSnapshots?: readonly AuthFileSnapshot[]
): string | null {
  if (preloadedSnapshots) {
    for (const relPath of SESSION_EMAIL_PRECEDENCE) {
      const match = preloadedSnapshots.find((s) => s.relPath === relPath)
      if (!match) continue
      const email = normalizeEmail(
        match.email ?? detectAuthFileEmail(match.relPath, match.content)
      )
      if (email) return email
    }
    return getActiveAccountEmail()
  }

  for (const relPath of SESSION_EMAIL_PRECEDENCE) {
    const content = readAuthFile(relPath)
    if (!content) continue
    const email = normalizeEmail(detectAuthFileEmail(relPath, content))
    if (email) return email
  }

  return getActiveAccountEmail()
}

export interface CapturedSession {
  email: string
  files: string[]
  isLive: boolean
}

export function captureSessionToProfiles(): CapturedSession[] {
  return withAgkLockSync("capture session", () => {
    const rawSnapshots = captureLiveAuthFiles(null)
    if (rawSnapshots.length === 0) return []

    const liveEmail = detectCurrentSessionEmail(rawSnapshots)
    const tokenOwners = new Map<string, string>()
    const distinctIntrinsicOwners = new Set<string>()

    for (const snapshot of rawSnapshots) {
      const email = normalizeEmail(snapshot.email)
      if (!email) continue
      distinctIntrinsicOwners.add(email)
      const refresh = extractRefreshToken(snapshot)
      if (refresh && !tokenOwners.has(refresh)) {
        tokenOwners.set(refresh, email)
      }
    }

    const grouped = new Map<string, AuthFileSnapshot[]>()

    for (const snapshot of rawSnapshots) {
      let owner = normalizeEmail(snapshot.email)

      if (!owner) {
        const refresh = extractRefreshToken(snapshot)
        if (refresh) {
          owner = tokenOwners.get(refresh) ?? null
        }
      }

      if (!owner && distinctIntrinsicOwners.size <= 1) {
        owner = liveEmail
      }

      if (!owner) continue

      const group = grouped.get(owner) ?? []
      group.push({ ...snapshot, email: owner })
      grouped.set(owner, group)
    }

    const captured: CapturedSession[] = []

    for (const [email, files] of grouped) {
      const embeddedClient = files
        .map((file) => extractClientFromAuthFile(file.content))
        .find((client) => client !== null)

      saveProfile(email, files, {
        clientId: embeddedClient?.id,
        clientSecret: embeddedClient?.secret,
      })
      captured.push({
        email,
        files: files.map((file) => file.relPath),
        isLive: email === liveEmail,
      })
    }

    return captured
  })
}
