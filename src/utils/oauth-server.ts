/**
 * OAuth Server Utilities
 *
 * Local HTTP server for OAuth callback and browser opening utilities.
 *
 * Original Author: lbjlaq (https://github.com/lbjlaq)
 * License: CC-BY-NC-SA-4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/)
 * Note: This version contains modifications based on the original source code.
 */

import { exec } from "node:child_process"
import * as http from "node:http"
import * as os from "node:os"
import * as url from "node:url"
import { type UserInfo, getUserInfo } from "./google-api.js"
import {
  type OAuthClient,
  type TokenResponse,
  exchangeCode,
  getAuthUrl,
} from "./oauth.js"
import { type QuotaResult, fetchProjectId, fetchQuota } from "./quota.js"

// ============================================
// TYPES
// ============================================

export interface OAuthFlowResult {
  tokens: TokenResponse & { refresh_token: string }
  userInfo: UserInfo
  quota: QuotaResult
}

// ============================================
// BROWSER UTILITIES
// ============================================

/**
 * Open URL in default browser
 */
export function openBrowser(targetUrl: string): void {
  const platform = os.platform()
  let command: string

  switch (platform) {
    case "darwin":
      command = `open "${targetUrl}"`
      break
    case "win32":
      command = `start "" "${targetUrl}"`
      break
    default:
      command = `xdg-open "${targetUrl}"`
  }

  exec(command, (error) => {
    if (error) {
      console.error(`⚠️  Could not open browser: ${error.message}`)
      console.log(`\n📋 Please open this URL manually:\n${targetUrl}\n`)
    }
  })
}

// ============================================
// OAUTH SERVER
// ============================================

/**
 * Start local HTTP server to capture OAuth callback
 */
function startCallbackServer(
  port: number
): Promise<{ server: http.Server; codePromise: Promise<string> }> {
  return new Promise((resolve) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void

    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url || "", true)

      if (parsedUrl.pathname === "/oauth-callback") {
        const code = parsedUrl.query["code"] as string | undefined

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`
            <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: green;">✅ Authorization Successful!</h1>
              <p>You can close this window and return to the CLI.</p>
              <script>setTimeout(function() { window.close(); }, 2000);</script>
            </body>
            </html>
          `)
          resolveCode(code)
        } else {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          res.end(`
            <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: red;">❌ Authorization Failed</h1>
              <p>Could not get authorization code. Please try again.</p>
            </body>
            </html>
          `)
          rejectCode(new Error("No authorization code received"))
        }
      }
    })

    server.listen(port, "127.0.0.1", () => {
      resolve({ server, codePromise })
    })
  })
}

/**
 * Full OAuth flow: opens browser, captures callback, exchanges for tokens
 */
export async function startOAuthFlow(
  client: OAuthClient
): Promise<OAuthFlowResult> {
  // Find available port
  const port = 8085 + Math.floor(Math.random() * 100)
  const redirectUri = `http://127.0.0.1:${port}/oauth-callback`

  console.log("🚀 Starting OAuth flow...")
  console.log(`📡 Callback server listening on port ${port}`)

  // Start callback server
  const { server, codePromise } = await startCallbackServer(port)

  // Generate and open auth URL
  const authUrl = getAuthUrl(redirectUri, client)
  console.log("\n🌐 Opening browser for authorization...")
  console.log(`\n📋 If browser doesn't open, visit:\n${authUrl}\n`)
  openBrowser(authUrl)

  try {
    // Wait for callback
    console.log("⏳ Waiting for authorization...")
    const code = await codePromise
    console.log("✅ Authorization code received!")

    // Exchange code for tokens
    console.log("🔄 Exchanging code for tokens...")
    const tokens = await exchangeCode(code, redirectUri, client)

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token received. Visit https://myaccount.google.com/permissions to revoke access and try again."
      )
    }

    // Get user info
    console.log("👤 Fetching user info...")
    const userInfo = await getUserInfo(tokens.access_token)
    console.log(`✅ Logged in as: ${userInfo.email}`)

    // Get quota
    console.log("📊 Fetching quota...")
    const { projectId, subscriptionTier } = await fetchProjectId(
      tokens.access_token
    )
    const quota = await fetchQuota(tokens.access_token, projectId)
    if (subscriptionTier) {
      quota.subscriptionTier = subscriptionTier
    }

    return {
      tokens: tokens as TokenResponse & { refresh_token: string },
      userInfo,
      quota,
    }
  } finally {
    server.close()
  }
}
