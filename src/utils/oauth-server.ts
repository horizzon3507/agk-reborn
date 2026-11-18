import { spawn } from "node:child_process"
import { timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import * as http from "node:http"
import { type UserInfo, getUserInfo } from "./google-api.js"
import {
  type OAuthClient,
  type TokenResponse,
  exchangeCode,
  generateOAuthState,
  generatePkcePair,
  getAuthUrl,
} from "./oauth.js"
import { type QuotaResult, fetchProjectId, fetchQuota } from "./quota.js"
import { sanitizeTerminalText } from "./redact.js"

export const OAUTH_LOOPBACK_HOST = "127.0.0.1"
export const OAUTH_CALLBACK_PATH = "/oauth-callback"
export const DEFAULT_CALLBACK_TIMEOUT_MS = 180_000

const MAX_URL_BYTES = 8_192
const MAX_CODE_BYTES = 2_048

export interface OAuthFlowResult {
  tokens: TokenResponse & { refresh_token: string }
  userInfo: UserInfo
  quota: QuotaResult
}

export type OAuthFlowStage =
  | "listening"
  | "waiting_for_browser"
  | "exchanging_code"
  | "fetching_profile"
  | "fetching_quota"

export interface OAuthFlowOptions {
  port?: number | undefined
  timeoutMs?: number | undefined
  openBrowser?: boolean | undefined
  signal?: AbortSignal | undefined
  onAuthUrl?: ((authUrl: string, browserOpened: boolean) => void) | undefined
  onStage?: ((stage: OAuthFlowStage) => void) | undefined
}

export interface CallbackServerOptions {
  expectedState: string
  port?: number | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export interface CallbackServerHandle {
  port: number
  redirectUri: string
  waitForCode: () => Promise<string>
  close: () => Promise<void>
}

function isTruthyEnv(raw: string | undefined): boolean {
  if (!raw) return false
  const val = raw.trim().toLowerCase()
  return val === "1" || val === "true" || val === "yes"
}

function isWslEnvironment(): boolean {
  if (process.platform !== "linux") return false
  if (process.env["WSL_DISTRO_NAME"] || process.env["WSL_INTEROP"]) return true
  try {
    const version = readFileSync("/proc/version", "utf-8")
    return /microsoft|wsl/i.test(version)
  } catch {
    return false
  }
}

export function validateBrowserUrl(targetUrl: string): string {
  if (typeof targetUrl !== "string" || targetUrl.trim().length === 0) {
    throw new Error("Browser URL is empty")
  }
  for (let i = 0; i < targetUrl.length; i++) {
    const code = targetUrl.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      throw new Error("Browser URL contains control characters")
    }
  }

  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    throw new Error("Invalid browser URL")
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported browser URL protocol: ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw new Error("Browser URL must not embed credentials")
  }

  const normalized = parsed.toString()
  if (normalized.includes('"')) {
    throw new Error("Browser URL contains unescaped quote")
  }
  return normalized
}

export function openBrowser(targetUrl: string): boolean {
  if (isTruthyEnv(process.env["AGK_NO_BROWSER"])) {
    return false
  }

  let safeUrl: string
  try {
    safeUrl = validateBrowserUrl(targetUrl)
  } catch {
    return false
  }

  const platform = process.platform

  if (
    platform === "linux" &&
    !isWslEnvironment() &&
    !process.env["DISPLAY"] &&
    !process.env["WAYLAND_DISPLAY"]
  ) {
    return false
  }

  let command: string
  let args: string[]
  let verbatim = false

  if (platform === "darwin") {
    command = "open"
    args = [safeUrl]
  } else if (platform === "win32" || isWslEnvironment()) {
    command = platform === "win32" ? "cmd.exe" : "cmd.exe"
    args = ["/c", "start", '""', `"${safeUrl}"`]
    verbatim = platform === "win32"
  } else {
    command = "xdg-open"
    args = [safeUrl]
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    })
    child.on("error", () => {
      // Caller always displays fallback URL
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

export function verifyOAuthState(
  expectedState: string,
  receivedState: string | null
): boolean {
  if (!expectedState || !receivedState) return false
  const a = Buffer.from(expectedState, "utf-8")
  const b = Buffer.from(receivedState, "utf-8")
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderStatusHtml(
  title: string,
  heading: string,
  body: string,
  ok: boolean
): string {
  const color = ok ? "#15803d" : "#b91c1c"
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,-apple-system,sans-serif;background:#fff;color:#111827;margin:0;padding:56px 24px;text-align:center}",
    "main{max-width:460px;margin:0 auto}",
    `h1{color:${color};font-size:1.4rem;margin:0 0 12px}`,
    "p{color:#374151;line-height:1.5;margin:0}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("")
}

function writePlainResponse(
  res: http.ServerResponse,
  status: number,
  body: string
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Connection: "close",
  })
  res.end(body)
}

function writeHtmlAndNotify(
  res: http.ServerResponse,
  status: number,
  html: string,
  onDone: () => void
): void {
  let fired = false
  const finish = (): void => {
    if (fired) return
    fired = true
    onDone()
  }
  res.once("finish", finish)
  res.once("close", finish)
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    Connection: "close",
  })
  res.end(html)
}

function isAllowedLoopbackHost(
  hostHeader: string | undefined,
  boundPort: number
): boolean {
  if (!hostHeader) return true
  const normalized = hostHeader.trim().toLowerCase()
  return (
    normalized === `${OAUTH_LOOPBACK_HOST}:${boundPort}` ||
    normalized === `localhost:${boundPort}` ||
    normalized === OAUTH_LOOPBACK_HOST ||
    normalized === "localhost"
  )
}

export async function startCallbackServer(
  options: CallbackServerOptions
): Promise<CallbackServerHandle> {
  if (!options.expectedState.trim()) {
    throw new Error("OAuth callback server requires expectedState")
  }
  if (options.signal?.aborted) {
    throw new Error("OAuth authorization cancelled")
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS
  let settled = false
  let boundPort = 0
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (error: Error) => void = () => {}

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  codePromise.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | null = null
  const onSignalAbort = (): void => {
    settleError(new Error("OAuth authorization cancelled"))
  }

  const clearGuards = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    options.signal?.removeEventListener("abort", onSignalAbort)
  }

  const settleSuccess = (code: string): void => {
    if (settled) return
    settled = true
    clearGuards()
    resolveCode(code)
  }

  const settleError = (error: Error): void => {
    if (settled) return
    settled = true
    clearGuards()
    rejectCode(error)
  }

  const server = http.createServer((req, res) => {
    req.resume()

    if (!isAllowedLoopbackHost(req.headers.host, boundPort)) {
      writePlainResponse(res, 400, "Invalid Host header")
      return
    }

    const rawUrl = req.url ?? ""
    if (
      !rawUrl.startsWith("/") ||
      rawUrl.startsWith("//") ||
      rawUrl.length > MAX_URL_BYTES
    ) {
      writePlainResponse(res, 400, "Bad Request")
      return
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl, `http://${OAUTH_LOOPBACK_HOST}:${boundPort}`)
    } catch {
      writePlainResponse(res, 400, "Bad Request")
      return
    }

    if (parsedUrl.pathname !== OAUTH_CALLBACK_PATH) {
      writePlainResponse(res, 404, "Not Found")
      return
    }

    if (req.method !== "GET") {
      writePlainResponse(res, 405, "Method Not Allowed")
      return
    }

    if (settled) {
      writePlainResponse(res, 400, "Session already completed")
      return
    }

    const params = parsedUrl.searchParams
    if (
      params.getAll("code").length > 1 ||
      params.getAll("state").length > 1 ||
      params.getAll("error").length > 1
    ) {
      writePlainResponse(res, 400, "Duplicate OAuth parameters")
      return
    }

    const receivedState = params.get("state")
    if (!verifyOAuthState(options.expectedState, receivedState)) {
      // Do NOT reject pending login on unauthenticated requests with wrong/missing state
      // so random local port probes cannot DoS an active browser login.
      const html = renderStatusHtml(
        "Verification Failed",
        "Invalid OAuth state",
        "State token did not match the active login session.",
        false
      )
      writeHtmlAndNotify(res, 400, html, () => {})
      return
    }

    const oauthError = params.get("error")
    if (oauthError) {
      const desc = params.get("error_description")
      const safeErr = sanitizeTerminalText(oauthError, 80)
      const safeDesc = desc ? sanitizeTerminalText(desc, 160) : ""
      const msg = safeDesc
        ? `OAuth authorization failed (${safeErr}): ${safeDesc}`
        : `OAuth authorization failed (${safeErr})`
      const html = renderStatusHtml(
        "Authorization Declined",
        "Authorization not completed",
        "You can close this tab and return to the terminal.",
        false
      )
      writeHtmlAndNotify(res, 400, html, () => settleError(new Error(msg)))
      return
    }

    const code = params.get("code")?.trim() ?? ""
    if (!code || code.length > MAX_CODE_BYTES) {
      const html = renderStatusHtml(
        "Authorization Failed",
        "Missing authorization code",
        "No valid code was returned. Please try again from your terminal.",
        false
      )
      writeHtmlAndNotify(res, 400, html, () =>
        settleError(new Error("No authorization code received"))
      )
      return
    }

    const html = renderStatusHtml(
      "Authorization Successful",
      "Signed in to agk-reborn",
      "You can close this tab and return to your terminal.",
      true
    )
    writeHtmlAndNotify(res, 200, html, () => settleSuccess(code))
  })

  server.headersTimeout = 10_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 1_000

  boundPort = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener("error", onError)
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not resolve bound loopback port"))
        return
      }
      resolve(addr.port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(options.port ?? 0, OAUTH_LOOPBACK_HOST)
  })

  server.on("error", (err) => {
    settleError(err)
  })

  timer = setTimeout(() => {
    const secs = Math.round(timeoutMs / 1000)
    settleError(new Error(`OAuth callback timed out after ${secs}s`))
  }, timeoutMs)
  timer.unref?.()

  if (options.signal) {
    if (options.signal.aborted) {
      onSignalAbort()
    } else {
      options.signal.addEventListener("abort", onSignalAbort, { once: true })
    }
  }

  let closePromise: Promise<void> | null = null
  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    clearGuards()
    closePromise = new Promise<void>((resolve) => {
      if (!server.listening) {
        server.closeAllConnections?.()
        resolve()
        return
      }
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    return closePromise
  }

  return {
    port: boundPort,
    redirectUri: `http://${OAUTH_LOOPBACK_HOST}:${boundPort}${OAUTH_CALLBACK_PATH}`,
    waitForCode: () => codePromise,
    close,
  }
}

export async function startOAuthFlow(
  client: OAuthClient,
  options?: OAuthFlowOptions
): Promise<OAuthFlowResult> {
  const state = generateOAuthState()
  const pkce = generatePkcePair()

  options?.onStage?.("listening")
  const handle = await startCallbackServer({
    expectedState: state,
    port: options?.port,
    timeoutMs: options?.timeoutMs,
    signal: options?.signal,
  })

  try {
    const authUrl = getAuthUrl(handle.redirectUri, client, {
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: pkce.method,
    })

    const shouldOpen = options?.openBrowser !== false
    const opened = shouldOpen ? openBrowser(authUrl) : false
    options?.onAuthUrl?.(authUrl, opened)
    options?.onStage?.("waiting_for_browser")

    const code = await handle.waitForCode()
    await handle.close()

    options?.onStage?.("exchanging_code")
    const tokens = await exchangeCode(code, handle.redirectUri, client, {
      codeVerifier: pkce.verifier,
      signal: options?.signal,
    })

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token returned by Google. Revoke prior access at https://myaccount.google.com/permissions and try again."
      )
    }

    options?.onStage?.("fetching_profile")
    const userInfo = await getUserInfo(tokens.access_token, {
      signal: options?.signal,
    })

    options?.onStage?.("fetching_quota")
    let quota: QuotaResult = { models: [] }
    try {
      const { projectId, subscriptionTier } = await fetchProjectId(
        tokens.access_token,
        { signal: options?.signal }
      )
      quota = await fetchQuota(tokens.access_token, projectId, {
        signal: options?.signal,
      })
      if (subscriptionTier) {
        quota.subscriptionTier = subscriptionTier
      }
    } catch {
      // Non-fatal: valid login tokens must not be discarded if quota endpoint is degraded
    }

    return {
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token,
      },
      userInfo,
      quota,
    }
  } finally {
    await handle.close()
  }
}
