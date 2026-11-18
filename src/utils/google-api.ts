import {
  formatHttpErrorDetail,
  normalizeEmail,
  parseJsonObject,
  readBoundedResponseText,
  sanitizeErrorMessage,
  sanitizeTerminalText,
} from "./redact.js"

export const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

export interface UserInfo {
  email: string
  name?: string | undefined
  given_name?: string | undefined
  family_name?: string | undefined
  picture?: string | undefined
}

export interface ApiRequestOptions {
  timeoutMs?: number | undefined
  maxRetries?: number | undefined
  signal?: AbortSignal | undefined
}

const DEFAULT_API_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RETRIES = 2
const MAX_RETRY_DELAY_MS = 5_000

export function buildHostUserAgent(): string {
  const osName =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : "linux"
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch
  return `antigravity/1.5.10 ${osName}/${arch}`
}

export const USER_AGENT = buildHostUserAgent()

function resolveUserInfoEndpoint(): string {
  return process.env["AGK_USERINFO_URL"]?.trim() || USERINFO_URL
}

function createAttemptSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } {
  const controller = new AbortController()
  let timedOut = false

  const onAbort = (): void => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener("abort", onAbort, { once: true })
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
      externalSignal?.removeEventListener("abort", onAbort)
    },
  }
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null
  const secs = Number(headerVal.trim())
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(secs * 1000))
  }
  const dateMs = Date.parse(headerVal)
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now()
    return diff > 0 ? Math.min(MAX_RETRY_DELAY_MS, diff) : 0
  }
  return null
}

async function sleepAbortable(
  ms: number,
  externalSignal?: AbortSignal
): Promise<void> {
  if (ms <= 0) return
  if (externalSignal?.aborted) {
    throw new Error("Request aborted")
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error("Request aborted"))
    }
    const timer = setTimeout(() => {
      externalSignal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    externalSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: ApiRequestOptions
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options?.signal?.aborted) {
      throw new Error("Request aborted")
    }

    const { signal, cleanup, didTimeout } = createAttemptSignal(
      timeoutMs,
      options?.signal
    )

    try {
      const response = await fetch(url, { ...init, signal })
      const isRetryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500

      if (!isRetryable || attempt === maxRetries) {
        cleanup()
        return response
      }

      const retryDelay =
        parseRetryAfterMs(response.headers.get("retry-after")) ??
        250 * 2 ** attempt + Math.floor(Math.random() * 150)
      await response.body?.cancel().catch(() => {})
      cleanup()
      await sleepAbortable(retryDelay, options?.signal)
    } catch (error) {
      cleanup()
      if (options?.signal?.aborted && !didTimeout()) {
        throw new Error("Request aborted")
      }
      if (attempt < maxRetries) {
        const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 150)
        await sleepAbortable(delay, options?.signal)
        continue
      }
      const msg = didTimeout()
        ? `Request timed out after ${timeoutMs}ms`
        : sanitizeErrorMessage(error, 160)
      throw new Error(msg)
    }
  }

  throw new Error("Exhausted retry attempts")
}

export async function getUserInfo(
  accessToken: string,
  options?: ApiRequestOptions
): Promise<UserInfo> {
  const cleanToken = accessToken.trim()
  if (!cleanToken || cleanToken.includes("\r") || cleanToken.includes("\n")) {
    throw new Error("Invalid access token")
  }

  const response = await fetchWithRetry(
    resolveUserInfoEndpoint(),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    options
  )

  const rawBody = await readBoundedResponseText(response, 65_536)

  if (!response.ok) {
    throw new Error(
      `Failed to get user info (${formatHttpErrorDetail(response.status, rawBody)})`
    )
  }

  const parsed = parseJsonObject(rawBody)
  if (!parsed) {
    throw new Error("Malformed userinfo JSON payload")
  }

  const email = normalizeEmail(parsed["email"])
  if (!email) {
    throw new Error("Google userinfo response did not contain a valid email")
  }

  const info: UserInfo = { email }
  if (typeof parsed["name"] === "string") {
    const clean = sanitizeTerminalText(parsed["name"], 120)
    if (clean) info.name = clean
  }
  if (typeof parsed["given_name"] === "string") {
    const clean = sanitizeTerminalText(parsed["given_name"], 80)
    if (clean) info.given_name = clean
  }
  if (typeof parsed["family_name"] === "string") {
    const clean = sanitizeTerminalText(parsed["family_name"], 80)
    if (clean) info.family_name = clean
  }
  if (typeof parsed["picture"] === "string" && parsed["picture"].trim()) {
    info.picture = parsed["picture"].trim()
  }

  return info
}
