import { existsSync, lstatSync, unlinkSync } from "node:fs"
import {
  MAX_SAFE_FILE_BYTES,
  readRegularFileSafe,
  writeFileAtomicSync,
} from "./fs-atomic.js"
import { decodeJwtPayload, getJwtExpiryMs } from "./jwt.js"
import {
  clearKeyringSecret,
  keyringAvailable,
  readKeyringSecret,
  writeKeyringSecret,
} from "./keyring.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  GOOGLE_ACCOUNTS_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
  getGeminiDir,
  getLiveAuthFilePath,
} from "./paths.js"
import { isPlainObject, normalizeEmail, parseJsonObject } from "./redact.js"

export interface AgyTokenFile {
  token: {
    access_token: string
    token_type?: string | undefined
    refresh_token?: string | undefined
    expiry?: string | undefined
    expires_in?: number | undefined
    id_token?: string | undefined
  }
  auth_method?: string | undefined
  id_token_email?: string | undefined
  [key: string]: unknown
}

export interface AuthFileSnapshot {
  relPath: string
  content: string
  email: string | null
}

export type AuthFileState =
  | { status: "ok"; content: string }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "unreadable"; reason: string }

export interface AuthFileInspection {
  valid: boolean
  email: string | null
  hasRefreshToken: boolean
  expiresAtMs: number | null
  isExpired: boolean | null
}

export function readAuthFileState(relPath: string): AuthFileState {
  if (relPath === KEYRING_REL) {
    if (!keyringAvailable()) return { status: "unavailable" }
    const secret = readKeyringSecret()
    return secret !== null
      ? { status: "ok", content: secret }
      : { status: "missing" }
  }

  let absPath: string
  try {
    absPath = getLiveAuthFilePath(relPath)
  } catch (error) {
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : "invalid path",
    }
  }

  return readRegularFileSafe(absPath, MAX_SAFE_FILE_BYTES)
}

export function readAuthFile(relPath: string): string | null {
  const state = readAuthFileState(relPath)
  return state.status === "ok" ? state.content : null
}

export function authFileExists(relPath: string): boolean {
  if (relPath === KEYRING_REL) {
    return readKeyringSecret() !== null
  }
  try {
    const absPath = getLiveAuthFilePath(relPath)
    const st = lstatSync(absPath)
    return st.isFile() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

export function parseAgyTokenFile(content: string): AgyTokenFile | null {
  const parsed = parseJsonObject(content)
  if (!parsed) return null

  const token = parsed["token"]
  if (!isPlainObject(token)) return null

  const accessToken =
    typeof token["access_token"] === "string"
      ? token["access_token"].trim()
      : ""
  const refreshToken =
    typeof token["refresh_token"] === "string"
      ? token["refresh_token"].trim()
      : ""

  if (!accessToken && !refreshToken) return null

  const normalizedToken: AgyTokenFile["token"] = {
    access_token: accessToken,
  }
  if (typeof token["token_type"] === "string" && token["token_type"].trim()) {
    normalizedToken.token_type = token["token_type"].trim()
  }
  if (refreshToken) {
    normalizedToken.refresh_token = refreshToken
  }
  if (typeof token["expiry"] === "string" && token["expiry"].trim()) {
    normalizedToken.expiry = token["expiry"].trim()
  }
  if (
    typeof token["expires_in"] === "number" &&
    Number.isFinite(token["expires_in"]) &&
    token["expires_in"] > 0
  ) {
    normalizedToken.expires_in = token["expires_in"]
  }
  if (typeof token["id_token"] === "string" && token["id_token"].trim()) {
    normalizedToken.id_token = token["id_token"].trim()
  }

  const out: AgyTokenFile = {
    token: normalizedToken,
  }
  for (const [key, val] of Object.entries(parsed)) {
    if (key === "token" || key === "auth_method" || key === "id_token_email") {
      continue
    }
    out[key] = val
  }

  if (
    typeof parsed["auth_method"] === "string" &&
    parsed["auth_method"].trim()
  ) {
    out.auth_method = parsed["auth_method"].trim()
  }

  const normalizedEmail = normalizeEmail(parsed["id_token_email"])
  if (normalizedEmail) {
    out.id_token_email = normalizedEmail
  }

  return out
}

export function isValidAuthFileContent(
  relPath: string,
  content: string
): boolean {
  if (relPath === AGY_TOKEN_REL || relPath === KEYRING_REL) {
    return parseAgyTokenFile(content) !== null
  }

  const parsed = parseJsonObject(content)
  if (!parsed) return false

  if (relPath === OAUTH_CREDS_REL) {
    const hasAccess =
      typeof parsed["access_token"] === "string" &&
      parsed["access_token"].trim().length > 0
    const hasRefresh =
      typeof parsed["refresh_token"] === "string" &&
      parsed["refresh_token"].trim().length > 0
    const hasId =
      typeof parsed["id_token"] === "string" &&
      parsed["id_token"].trim().length > 0
    return hasAccess || hasRefresh || hasId
  }

  if (relPath === ACP_TOKEN_REL) {
    return (
      typeof parsed["refresh_token"] === "string" &&
      parsed["refresh_token"].trim().length > 0
    )
  }

  if (relPath === GOOGLE_ACCOUNTS_REL) {
    return true
  }

  return Object.keys(parsed).length > 0
}

export function detectAuthFileEmail(
  relPath: string,
  content: string
): string | null {
  if (relPath === AGY_TOKEN_REL || relPath === KEYRING_REL) {
    const parsed = parseAgyTokenFile(content)
    if (!parsed) return null

    if (parsed.token.id_token) {
      const jwtEmail = decodeJwtPayload(parsed.token.id_token)?.email
      if (jwtEmail) return jwtEmail
    }

    return parsed.id_token_email ?? null
  }

  if (relPath === OAUTH_CREDS_REL) {
    const parsed = parseJsonObject(content)
    if (!parsed) return null

    if (typeof parsed["id_token"] === "string") {
      const jwtEmail = decodeJwtPayload(parsed["id_token"])?.email
      if (jwtEmail) return jwtEmail
    }
    return normalizeEmail(parsed["email"])
  }

  if (relPath === ACP_TOKEN_REL) {
    return null
  }

  return null
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw > 1e11 ? Math.round(raw) : Math.round(raw * 1000)
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const ms = Date.parse(raw.trim())
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  return null
}

export function inspectAuthFile(
  relPath: string,
  content: string
): AuthFileInspection {
  const valid = isValidAuthFileContent(relPath, content)
  if (!valid) {
    return {
      valid: false,
      email: null,
      hasRefreshToken: false,
      expiresAtMs: null,
      isExpired: null,
    }
  }

  const email = detectAuthFileEmail(relPath, content)
  const refresh = extractRefreshToken({ relPath, content, email })

  let expiresAtMs: number | null = null
  const parsed = parseJsonObject(content)
  if (parsed) {
    if (relPath === AGY_TOKEN_REL || relPath === KEYRING_REL) {
      const token = isPlainObject(parsed["token"]) ? parsed["token"] : null
      if (token) {
        expiresAtMs =
          parseTimestampMs(token["expiry"]) ??
          parseTimestampMs(token["expiry_date"]) ??
          getJwtExpiryMs(token["id_token"])
      }
    } else if (relPath === OAUTH_CREDS_REL) {
      expiresAtMs =
        parseTimestampMs(parsed["expiry_date"]) ??
        parseTimestampMs(parsed["expiry"]) ??
        getJwtExpiryMs(parsed["id_token"])
    }
  }

  return {
    valid: true,
    email,
    hasRefreshToken: refresh !== null,
    expiresAtMs,
    isExpired: expiresAtMs !== null ? Date.now() >= expiresAtMs : null,
  }
}

export function writeAuthFileAtomic(relPath: string, content: string): boolean {
  if (relPath === KEYRING_REL) {
    return writeKeyringSecret(content)
  }

  const absPath = getLiveAuthFilePath(relPath)
  writeFileAtomicSync(absPath, content, {
    mode: 0o600,
    dirMode: 0o700,
    rootBoundary: getGeminiDir(),
  })
  return true
}

export function removeAuthFile(relPath: string): boolean {
  if (relPath === KEYRING_REL) {
    return clearKeyringSecret()
  }

  try {
    const absPath = getLiveAuthFilePath(relPath)
    const st = lstatSync(absPath)
    if (st.isDirectory()) return false
    unlinkSync(absPath)
    return true
  } catch {
    return false
  }
}

export function captureLiveAuthFiles(
  fallbackEmail: string | null
): AuthFileSnapshot[] {
  const normalizedFallback = normalizeEmail(fallbackEmail)
  const snapshots: AuthFileSnapshot[] = []

  for (const relPath of [
    AGY_TOKEN_REL,
    OAUTH_CREDS_REL,
    ACP_TOKEN_REL,
    KEYRING_REL,
  ]) {
    const content = readAuthFile(relPath)
    if (content === null) continue
    if (!isValidAuthFileContent(relPath, content)) continue

    const detected = detectAuthFileEmail(relPath, content)
    snapshots.push({
      relPath,
      content,
      email: detected ?? normalizedFallback,
    })
  }

  return snapshots
}

export function extractRefreshToken(snapshot: AuthFileSnapshot): string | null {
  const parsed = parseJsonObject(snapshot.content)
  if (!parsed) return null

  if (snapshot.relPath === AGY_TOKEN_REL || snapshot.relPath === KEYRING_REL) {
    const token = parsed["token"]
    if (!isPlainObject(token)) return null
    const raw = token["refresh_token"]
    if (typeof raw !== "string") return null
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  const refreshToken = parsed["refresh_token"]
  if (typeof refreshToken !== "string") return null
  const trimmed = refreshToken.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function geminiDirExists(): boolean {
  return existsSync(getGeminiDir())
}
