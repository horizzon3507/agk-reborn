/**
 *
 * OAuth Authentication Utilities
 *
 * Handles Google OAuth token management for Antigravity accounts.
 *
 * Original Author: lbjlaq (https://github.com/lbjlaq)
 * License: CC-BY-NC-SA-4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/)
 * Note: This version contains modifications based on the original source code.
 */

export const TOKEN_URL = "https://oauth2.googleapis.com/token"
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"

export const SCOPES = [
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
  token_type?: string
  refresh_token?: string
  id_token?: string
}

export function getAuthUrl(redirectUri: string, client: OAuthClient): string {
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
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
