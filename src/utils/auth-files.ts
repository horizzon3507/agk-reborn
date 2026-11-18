import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { decodeJwtPayload } from "./jwt.js"
import {
  clearKeyringSecret,
  readKeyringSecret,
  writeKeyringSecret,
} from "./keyring.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
  getGeminiDir,
  getLiveAuthFilePath,
} from "./paths.js"

export interface AgyTokenFile {
  token: {
    access_token: string
    token_type?: string
    refresh_token?: string
    expiry?: string
    expires_in?: number
    id_token?: string
  }
  auth_method?: string
  id_token_email?: string
  [key: string]: unknown
}

export interface AuthFileSnapshot {
  relPath: string
  content: string
  email: string | null
}

export function readAuthFile(relPath: string): string | null {
  if (relPath === KEYRING_REL) {
    return readKeyringSecret()
  }

  const absPath = getLiveAuthFilePath(relPath)
  if (!existsSync(absPath)) return null

  try {
    return readFileSync(absPath, "utf-8")
  } catch {
    return null
  }
}

export function authFileExists(relPath: string): boolean {
  if (relPath === KEYRING_REL) {
    return readKeyringSecret() !== null
  }

  return existsSync(getLiveAuthFilePath(relPath))
}

export function parseAgyTokenFile(content: string): AgyTokenFile | null {
  try {
    const parsed = JSON.parse(content) as AgyTokenFile
    if (!parsed["token"] || typeof parsed["token"] !== "object") return null
    return parsed
  } catch {
    return null
  }
}

export function detectAuthFileEmail(
  relPath: string,
  content: string
): string | null {
  if (relPath === AGY_TOKEN_REL || relPath === KEYRING_REL) {
    const parsed = parseAgyTokenFile(content)
    if (parsed?.id_token_email) return parsed.id_token_email

    const idToken = parsed?.["token"]?.["id_token"]
    if (idToken) {
      return decodeJwtPayload(idToken)?.email ?? null
    }
    return null
  }

  if (relPath === OAUTH_CREDS_REL) {
    try {
      const parsed = JSON.parse(content) as { id_token?: string }
      if (parsed["id_token"]) {
        return decodeJwtPayload(parsed["id_token"])?.email ?? null
      }
    } catch {
      return null
    }
    return null
  }

  if (relPath === ACP_TOKEN_REL) {
    return null
  }

  return null
}

export function writeAuthFileAtomic(relPath: string, content: string): void {
  if (relPath === KEYRING_REL) {
    writeKeyringSecret(content)
    return
  }

  const absPath = getLiveAuthFilePath(relPath)
  const dir = dirname(absPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  const tmpPath = join(dir, `.agk-tmp-${process.pid}`)
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, absPath)
}

export function removeAuthFile(relPath: string): boolean {
  if (relPath === KEYRING_REL) {
    return clearKeyringSecret()
  }

  const absPath = getLiveAuthFilePath(relPath)
  try {
    rmSync(absPath)
    return true
  } catch {
    return false
  }
}

export function captureLiveAuthFiles(
  fallbackEmail: string | null
): AuthFileSnapshot[] {
  const snapshots: AuthFileSnapshot[] = []

  for (const relPath of [
    AGY_TOKEN_REL,
    OAUTH_CREDS_REL,
    ACP_TOKEN_REL,
    KEYRING_REL,
  ]) {
    const content = readAuthFile(relPath)
    if (content === null) continue

    const detected = detectAuthFileEmail(relPath, content)
    snapshots.push({
      relPath,
      content,
      email: detected ?? fallbackEmail,
    })
  }

  return snapshots
}

export function extractRefreshToken(snapshot: AuthFileSnapshot): string | null {
  try {
    const parsed = JSON.parse(snapshot.content) as Record<string, unknown>

    if (
      snapshot.relPath === AGY_TOKEN_REL ||
      snapshot.relPath === KEYRING_REL
    ) {
      const token = parsed["token"] as { refresh_token?: string } | undefined
      return token?.["refresh_token"] ?? null
    }

    const refreshToken = parsed["refresh_token"]
    return typeof refreshToken === "string" ? refreshToken : null
  } catch {
    return null
  }
}

export function geminiDirExists(): boolean {
  return existsSync(getGeminiDir())
}
