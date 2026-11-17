import { getActiveAccountEmail } from "./accounts.js"
import {
  type AuthFileSnapshot,
  captureLiveAuthFiles,
  detectAuthFileEmail,
  readAuthFile,
} from "./auth-files.js"
import { extractClientFromAuthFile } from "./oauth-clients.js"
import { AGY_TOKEN_REL, OAUTH_CREDS_REL } from "./paths.js"
import { saveProfile } from "./profiles.js"

export function detectCurrentSessionEmail(): string | null {
  const agyToken = readAuthFile(AGY_TOKEN_REL)
  if (agyToken) {
    const email = detectAuthFileEmail(AGY_TOKEN_REL, agyToken)
    if (email) return email
  }

  const oauthCreds = readAuthFile(OAUTH_CREDS_REL)
  if (oauthCreds) {
    const email = detectAuthFileEmail(OAUTH_CREDS_REL, oauthCreds)
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
  const fallbackEmail = detectCurrentSessionEmail()
  const snapshots = captureLiveAuthFiles(fallbackEmail)
  if (snapshots.length === 0) return []

  const liveEmail = detectCurrentSessionEmail()
  const grouped = new Map<string, AuthFileSnapshot[]>()

  for (const snapshot of snapshots) {
    const owner = snapshot.email ?? fallbackEmail
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
}
