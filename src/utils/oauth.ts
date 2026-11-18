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

  if (options?.state?.trim()) {
    params.set("state", options.state.trim())
  }
  if (options?.codeChallenge?.trim()) {
    params.set("code_challenge", options.codeChallenge.trim())
    params.set("code_challenge_method", options.codeChallengeMethod ?? "S256")
  }

  return `${resolveAuthEndpoint()}?${params.toString()}`
}

function createTimedSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController()
  let timedOut = false

  const onExternalAbort = (): void => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true })
    }
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error("Request timed out"))
  }, timeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort)
      }
    },
  }
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null
  const seconds = Number(headerValue.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000))
  }
  const dateMs = Date.parse(headerValue)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? Math.min(MAX_RETRY_AFTER_MS, delta) : 0
  }
  return null
}

async function sleepAbortable(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void> {
  if (ms <= 0) return
  if (externalSignal?.aborted) {
    throw new OAuthError("OAuth request aborted", { kind: "aborted" })
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OAuthError("OAuth request aborted", { kind: "aborted" }))
    }
    const timer = setTimeout(() => {
      externalSignal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    externalSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

function classifyOAuthHttpFailure(
  status: number,
  rawBody: string
): { kind: OAuthErrorKind; detail: string } {
  const parsed = parseJsonObject(rawBody)
  const errCode =
    typeof parsed?.["error"] === "string"
      ? parsed["error"].trim().toLowerCase()
      : ""
  const detail = formatHttpErrorDetail(status, rawBody)

  if (status === 429) return { kind: "rate_limited", detail }
  if (status === 408 || status >= 500) return { kind: "transient", detail }

  if (errCode === "invalid_grant") {
    return { kind: "invalid_grant", detail }
  }
  if (
    errCode === "invalid_client" ||
    errCode === "unauthorized_client" ||
    status === 401
  ) {
    return { kind: "client_mismatch", detail }
  }
  return { kind: "http_error", detail }
}

function parseTokenResponse(rawBody: string): TokenResponse {
  const parsed = parseJsonObject(rawBody)
  if (!parsed) {
    throw new OAuthError("OAuth endpoint returned invalid JSON payload", {
      kind: "invalid_response",
    })
  }

  const accessToken =
    typeof parsed["access_token"] === "string"
      ? parsed["access_token"].trim()
      : ""
  if (!accessToken) {
    throw new OAuthError("OAuth response missing access_token", {
      kind: "invalid_response",
    })
  }

  const rawExpires = parsed["expires_in"]
  const expiresIn =
    typeof rawExpires === "number" &&
    Number.isFinite(rawExpires) &&
    rawExpires > 0
      ? Math.min(31_536_000, Math.max(1, Math.round(rawExpires)))
      : 3600

  const result: TokenResponse = {
    access_token: accessToken,
    expires_in: expiresIn,
  }

  if (
    typeof parsed["token_type"] === "string" &&
    parsed["token_type"].trim().length > 0
  ) {
    result.token_type = parsed["token_type"].trim()
  }
  if (
    typeof parsed["refresh_token"] === "string" &&
    parsed["refresh_token"].trim().length > 0
  ) {
    result.refresh_token = parsed["refresh_token"].trim()
  }
  if (
    typeof parsed["id_token"] === "string" &&
    parsed["id_token"].trim().length > 0
  ) {
    result.id_token = parsed["id_token"].trim()
  }

  return result
}

async function postTokenRequest(
  params: URLSearchParams,
  label: string,
  options?: OAuthRequestOptions
): Promise<TokenResponse> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const endpoint = resolveTokenEndpoint()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options?.signal?.aborted) {
      throw new OAuthError("OAuth request aborted", { kind: "aborted" })
    }

    const { signal, cleanup, didTimeout } = createTimedSignal(
      timeoutMs,
      options?.signal
    )

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
        signal,
      })
    } catch (error) {
      cleanup()
      if (options?.signal?.aborted && !didTimeout()) {
        throw new OAuthError("OAuth request aborted", { kind: "aborted" })
      }
      if (attempt < maxRetries) {
        const delayMs = 200 * 2 ** attempt + Math.floor(Math.random() * 150)
        await sleepAbortable(delayMs, options?.signal)
        continue
      }
      const reason = didTimeout()
        ? `timed out after ${timeoutMs}ms`
        : sanitizeErrorMessage(error, 160)
      throw new OAuthError(`${label} network error: ${reason}`, {
        kind: "transient",
      })
    }

    let rawBody: string
    try {
      rawBody = await readBoundedResponseText(response, 65_536)
    } catch (readError) {
      cleanup()
      if (attempt < maxRetries) {
        const delayMs = 200 * 2 ** attempt + Math.floor(Math.random() * 150)
        await sleepAbortable(delayMs, options?.signal)
        continue
      }
      throw new OAuthError(
        `${label} stream read failed: ${sanitizeErrorMessage(readError, 160)}`,
        { kind: "transient" }
      )
    } finally {
      cleanup()
    }

    if (!response.ok) {
      const { kind, detail } = classifyOAuthHttpFailure(
        response.status,
        rawBody
      )
      if (
        (kind === "transient" || kind === "rate_limited") &&
        attempt < maxRetries
      ) {
        const retryHeader = parseRetryAfterMs(
          response.headers.get("retry-after")
        )
        const delayMs =
          retryHeader ?? 250 * 2 ** attempt + Math.floor(Math.random() * 200)
        await sleepAbortable(delayMs, options?.signal)
        continue
      }
      throw new OAuthError(`${label} failed (${detail})`, {
        kind,
        status: response.status,
      })
    }

    return parseTokenResponse(rawBody)
  }

  throw new OAuthError(`${label} exhausted retry attempts`, {
    kind: "transient",
  })
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  client: OAuthClient,
  options?: OAuthRequestOptions & { codeVerifier?: string | undefined }
): Promise<TokenResponse> {
  const cleanCode = code.trim()
  const cleanRedirect = redirectUri.trim()
  const cleanId = client.id.trim()
  const cleanSecret = client.secret.trim()

  if (!cleanCode || !cleanRedirect || !cleanId || !cleanSecret) {
    throw new OAuthError("Missing required OAuth token exchange parameters", {
      kind: "invalid_request",
    })
  }

  const params = new URLSearchParams({
    client_id: cleanId,
    client_secret: cleanSecret,
    code: cleanCode,
    redirect_uri: cleanRedirect,
    grant_type: "authorization_code",
  })

  if (options?.codeVerifier?.trim()) {
    params.set("code_verifier", options.codeVerifier.trim())
  }

  return postTokenRequest(params, "Token exchange", options)
}

export async function refreshAccessToken(
  refreshToken: string,
  client: OAuthClient,
  options?: OAuthRequestOptions
): Promise<TokenResponse> {
  const cleanToken = refreshToken.trim()
  const cleanId = client.id.trim()
  const cleanSecret = client.secret.trim()

  if (!cleanToken || !cleanId || !cleanSecret) {
    throw new OAuthError("Missing refresh token or OAuth client credentials", {
      kind: "invalid_request",
    })
  }

  const params = new URLSearchParams({
    client_id: cleanId,
    client_secret: cleanSecret,
    refresh_token: cleanToken,
    grant_type: "refresh_token",
  })

  return postTokenRequest(params, "Token refresh", options)
}

export async function refreshAccessTokenAnyClient(
  refreshToken: string,
  clients: readonly OAuthClient[],
  options?: OAuthRequestOptions
): Promise<RefreshedSession> {
  const cleanToken = refreshToken.trim()
  if (!cleanToken) {
    throw new OAuthError("Refresh token is empty", { kind: "invalid_request" })
  }

  const dedupedClients: OAuthClient[] = []
  const seen = new Set<string>()
  for (const candidate of clients) {
    const id = candidate.id.trim()
    const secret = candidate.secret.trim()
    if (!id || !secret) continue
    const key = `${id}:${secret}`
    if (seen.has(key)) continue
    seen.add(key)
    dedupedClients.push({ id, secret, label: candidate.label })
  }

  if (dedupedClients.length === 0) {
    throw new OAuthError(
      "No OAuth client credentials found. Install agy or gemini so client credentials can be discovered.",
      { kind: "no_clients" }
    )
  }

  let sawInvalidGrant = false
  let lastError: OAuthError | null = null

  for (const client of dedupedClients) {
    try {
      const tokens = await refreshAccessToken(cleanToken, client, options)
      return { tokens, client }
    } catch (error) {
      const oauthErr =
        error instanceof OAuthError
          ? error
          : new OAuthError(sanitizeErrorMessage(error), { kind: "transient" })
      lastError = oauthErr

      if (
        oauthErr.kind === "aborted" ||
        oauthErr.kind === "transient" ||
        oauthErr.kind === "rate_limited"
      ) {
        throw oauthErr
      }

      if (oauthErr.kind === "invalid_grant") {
        sawInvalidGrant = true
      }
    }
  }

  if (sawInvalidGrant) {
    throw new OAuthError(
      "Refresh token expired or revoked (invalid_grant). Re-add the account.",
      { kind: "invalid_grant", status: 400 }
    )
  }

  throw (
    lastError ??
    new OAuthError(
      "No OAuth client accepted this refresh token. Install agy or gemini so client credentials can be discovered.",
      { kind: "client_mismatch" }
    )
  )
}
