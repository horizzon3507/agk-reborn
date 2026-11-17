import { type OAuthClient, SCOPES, TOKEN_URL } from "./oauth.js"
import { ACP_TOKEN_REL, AGY_TOKEN_REL, OAUTH_CREDS_REL } from "./paths.js"

export interface FreshTokens {
  access_token: string
  refresh_token: string
  expires_in?: number
  id_token?: string | undefined
}

const ACP_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
]

export function buildAgyTokenFile(tokens: FreshTokens, email: string): string {
  const expiry = new Date(
    Date.now() + (tokens.expires_in ?? 3600) * 1000
  ).toISOString()

  const file: Record<string, unknown> = {
    token: {
      access_token: tokens.access_token,
      token_type: "Bearer",
      refresh_token: tokens.refresh_token,
      expiry,
      expires_in: tokens.expires_in ?? 3600,
    },
    auth_method: "consumer",
    id_token_email: email,
  }

  if (tokens.id_token) {
    ;(file["token"] as Record<string, unknown>)["id_token"] = tokens.id_token
  }

  return JSON.stringify(file, null, 2)
}

export function buildOauthCredsFile(
  tokens: FreshTokens,
  idToken?: string
): string {
  const expiryDate = Date.now() + (tokens.expires_in ?? 3600) * 1000

  const file: Record<string, unknown> = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: "Bearer",
    scope: SCOPES.join(" "),
    expiry_date: expiryDate,
    expiry: new Date(expiryDate).toISOString(),
  }

  const resolvedIdToken = idToken ?? tokens.id_token
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
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: refreshToken,
      token_uri: TOKEN_URL,
      scopes: ACP_SCOPES,
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
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)

    if (relPath === AGY_TOKEN_REL) {
      const token = (parsed["token"] ?? {}) as Record<string, unknown>
      token["access_token"] = tokens.access_token
      token["refresh_token"] = tokens.refresh_token
      token["expiry"] = expiry.toISOString()
      token["expires_in"] = tokens.expires_in ?? 3600
      parsed["token"] = token
    } else if (relPath === ACP_TOKEN_REL) {
      parsed["refresh_token"] = tokens.refresh_token
    } else {
      parsed["access_token"] = tokens.access_token
      parsed["refresh_token"] = tokens.refresh_token
      parsed["expiry_date"] = expiry.getTime()
      parsed["expiry"] = expiry.toISOString()
    }

    return JSON.stringify(parsed, null, 2)
  } catch {
    return content
  }
}

export function buildAuthFilesForTokens(
  tokens: FreshTokens,
  email: string,
  client: OAuthClient,
  idToken?: string
): Array<{ relPath: string; content: string }> {
  return [
    { relPath: AGY_TOKEN_REL, content: buildAgyTokenFile(tokens, email) },
    {
      relPath: OAUTH_CREDS_REL,
      content: buildOauthCredsFile(tokens, idToken),
    },
    {
      relPath: ACP_TOKEN_REL,
      content: buildAcpTokenFile(tokens.refresh_token, client),
    },
  ]
}
