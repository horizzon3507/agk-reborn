import { decodeJwtPayload } from "./jwt.js"
import { type OAuthClient, SCOPES, TOKEN_URL } from "./oauth.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
} from "./paths.js"
import { isPlainObject, normalizeEmail, parseJsonObject } from "./redact.js"

export interface FreshTokens {
  access_token: string
  refresh_token: string
  expires_in?: number | undefined
  id_token?: string | undefined
}

export interface BuiltAuthFile {
  relPath: string
  content: string
}

const ACP_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
] as const

const DEFAULT_EXPIRES_IN_SECONDS = 3600
const MAX_EXPIRES_IN_SECONDS = 31_536_000

function normalizeExpiresIn(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_EXPIRES_IN_SECONDS
  }
  return Math.min(MAX_EXPIRES_IN_SECONDS, Math.max(1, Math.round(raw)))
}

export function buildAgyTokenFile(
  tokens: FreshTokens,
  email: string,
  idToken?: string
): string {
  const normalizedEmail = normalizeEmail(email) ?? email.trim().toLowerCase()
  const expiresIn = normalizeExpiresIn(tokens.expires_in)
  const expiry = new Date(Date.now() + expiresIn * 1000).toISOString()

  const tokenObj: Record<string, unknown> = {
    access_token: tokens.access_token.trim(),
    token_type: "Bearer",
    refresh_token: tokens.refresh_token.trim(),
    expiry,
    expires_in: expiresIn,
  }

  const resolvedIdToken = (idToken ?? tokens.id_token)?.trim()
  if (resolvedIdToken) {
    tokenObj["id_token"] = resolvedIdToken
  }

  const file: Record<string, unknown> = {
    token: tokenObj,
    auth_method: "consumer",
    id_token_email: normalizedEmail,
  }

  return JSON.stringify(file, null, 2)
}

export function buildOauthCredsFile(
  tokens: FreshTokens,
  idToken?: string
): string {
  const expiresIn = normalizeExpiresIn(tokens.expires_in)
  const expiryDate = Date.now() + expiresIn * 1000

  const file: Record<string, unknown> = {
    access_token: tokens.access_token.trim(),
    refresh_token: tokens.refresh_token.trim(),
    token_type: "Bearer",
    scope: SCOPES.join(" "),
    expiry_date: expiryDate,
    expiry: new Date(expiryDate).toISOString(),
  }

  const resolvedIdToken = (idToken ?? tokens.id_token)?.trim()
  if (resolvedIdToken) {
    file["id_token"] = resolvedIdToken
  }

  return JSON.stringify(file, null, 2)
}

export function buildAcpTokenFile(
  refreshToken: string,
  client: OAuthClient
): string {
  return JSON.stringify(
    {
      client_id: client.id.trim(),
      client_secret: client.secret.trim(),
      refresh_token: refreshToken.trim(),
      token_uri: TOKEN_URL,
      scopes: [...ACP_SCOPES],
      project_id: "aicode-consumers",
    },
    null,
    2
  )
}

export function patchAuthFileTokens(
  relPath: string,
  content: string,
  tokens: FreshTokens
): string {
  const parsed = parseJsonObject(content)
  if (!parsed) return content

  const accessToken = tokens.access_token.trim()
  if (!accessToken) return content

  const refreshToken = tokens.refresh_token.trim()
  const idToken = tokens.id_token?.trim()
  const expiresIn = normalizeExpiresIn(tokens.expires_in)
  const expiryMs = Date.now() + expiresIn * 1000
  const expiryIso = new Date(expiryMs).toISOString()

  if (relPath === AGY_TOKEN_REL || relPath === KEYRING_REL) {
    const prevToken = isPlainObject(parsed["token"]) ? parsed["token"] : {}
    const nextToken: Record<string, unknown> = {
      token_type: "Bearer",
      ...prevToken,
      access_token: accessToken,
      expiry: expiryIso,
      expires_in: expiresIn,
    }
    if (refreshToken) {
      nextToken["refresh_token"] = refreshToken
    }
    if (idToken) {
      nextToken["id_token"] = idToken
    }

    const nextRoot: Record<string, unknown> = {
      ...parsed,
      token: nextToken,
    }
    if (idToken) {
      const jwtEmail = decodeJwtPayload(idToken)?.email
      if (jwtEmail) {
        nextRoot["id_token_email"] = jwtEmail
      }
    }
    return JSON.stringify(nextRoot, null, 2)
  }

  if (relPath === ACP_TOKEN_REL) {
    const nextRoot: Record<string, unknown> = { ...parsed }
    if (refreshToken) {
      nextRoot["refresh_token"] = refreshToken
    }
    return JSON.stringify(nextRoot, null, 2)
  }

  if (relPath === OAUTH_CREDS_REL) {
    const nextRoot: Record<string, unknown> = {
      ...parsed,
      access_token: accessToken,
      expiry_date: expiryMs,
      expiry: expiryIso,
    }
    if (refreshToken) {
      nextRoot["refresh_token"] = refreshToken
    }
    if (idToken) {
      nextRoot["id_token"] = idToken
    }
    return JSON.stringify(nextRoot, null, 2)
  }

  return content
}

export function buildAuthFilesForTokens(
  tokens: FreshTokens,
  email: string,
  client: OAuthClient,
  idToken?: string
): BuiltAuthFile[] {
  const resolvedIdToken = idToken ?? tokens.id_token
  return [
    {
      relPath: AGY_TOKEN_REL,
      content: buildAgyTokenFile(tokens, email, resolvedIdToken),
    },
    {
      relPath: OAUTH_CREDS_REL,
      content: buildOauthCredsFile(tokens, resolvedIdToken),
    },
    {
      relPath: ACP_TOKEN_REL,
      content: buildAcpTokenFile(tokens.refresh_token, client),
    },
  ]
}
