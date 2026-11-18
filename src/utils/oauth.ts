import { createHash, randomBytes } from "node:crypto"
import {
  formatHttpErrorDetail,
  parseJsonObject,
  readBoundedResponseText,
  sanitizeErrorMessage,
} from "./redact.js"

export const TOKEN_URL = "https://oauth2.googleapis.com/token"
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"

export const SCOPES: readonly string[] = [
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
]

export interface OAuthClient {
  id: string
  secret: string
  label: string
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  token_type?: string | undefined
  refresh_token?: string | undefined
  id_token?: string | undefined
}

export interface RefreshedSession {
  tokens: TokenResponse
  client: OAuthClient
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: "S256"
}

export interface AuthUrlOptions {
  state?: string | undefined
  codeChallenge?: string | undefined
  codeChallengeMethod?: "S256" | undefined
}

export interface OAuthRequestOptions {
  timeoutMs?: number | undefined
  maxRetries?: number | undefined
  signal?: AbortSignal | undefined
}

export type OAuthErrorKind =
  | "invalid_grant"
  | "client_mismatch"
  | "rate_limited"
  | "transient"
  | "invalid_response"
  | "invalid_request"
  | "no_clients"
  | "aborted"
  | "http_error"

export class OAuthError extends Error {
  readonly kind: OAuthErrorKind
  readonly status?: number | undefined

  constructor(
    message: string,
    options: { kind: OAuthErrorKind; status?: number | undefined }
  ) {
    super(message)
    this.name = "OAuthError"
    this.kind = options.kind
    this.status = options.status
  }
}

const DEFAULT_OAUTH_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RETRIES = 2
const MAX_RETRY_AFTER_MS = 5_000

function resolveTokenEndpoint(): string {
  return process.env["AGK_OAUTH_TOKEN_URL"]?.trim() || TOKEN_URL
}

function resolveAuthEndpoint(): string {
  return process.env["AGK_OAUTH_AUTH_URL"]?.trim() || AUTH_URL
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge, method: "S256" }
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url")
}

export function getAuthUrl(
  redirectUri: string,
  client: OAuthClient,
  options?: AuthUrlOptions
): string {
  const cleanRedirect = redirectUri.trim()
  const cleanClientId = client.id.trim()
  if (!cleanRedirect || !cleanClientId) {
    throw new OAuthError("Missing OAuth redirect URI or client ID", {
      kind: "invalid_request",
    })
  }

  const params = new URLSearchParams({
    client_id: cleanClientId,
    redirect_uri: cleanRedirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  })

  return `${AUTH_URL}?${params.toString()}`
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  client: OAuthClient
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    code: code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  })

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed: ${errorText}`)
  }

  const tokenRes = (await response.json()) as TokenResponse

  if (!tokenRes.refresh_token) {
    console.warn(
      "Warning: No refresh_token returned. You may need to revoke access at https://myaccount.google.com/permissions"
    )
  }

  return tokenRes
}

export async function refreshAccessToken(
  refreshToken: string,
  client: OAuthClient
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  })

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed: ${errorText}`)
  }

  return (await response.json()) as TokenResponse
}

export interface RefreshedSession {
  tokens: TokenResponse
  client: OAuthClient
}

export async function refreshAccessTokenAnyClient(
  refreshToken: string,
  clients: OAuthClient[]
): Promise<RefreshedSession> {
  let lastError: Error | null = null

  for (const client of clients) {
    try {
      const tokens = await refreshAccessToken(refreshToken, client)
      return { tokens, client }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError = error instanceof Error ? error : new Error(message)

      if (message.includes("invalid_grant")) {
        throw new Error(
          "Refresh token is dead (invalid_grant). Re-add the account."
        )
      }
    }
  }

  throw (
    lastError ??
    new Error(
      "No OAuth client accepted this refresh token. Install agy/gemini so its client credentials can be discovered."
    )
  )
}
