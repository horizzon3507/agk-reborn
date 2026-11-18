import { homedir } from "node:os"
import { join } from "node:path"

export const AGY_TOKEN_REL = "antigravity-cli/antigravity-oauth-token"
export const OAUTH_CREDS_REL = "oauth_creds.json"
export const ACP_TOKEN_REL = "antigravity-acp/acp_token.json"
export const GOOGLE_ACCOUNTS_REL = "google_accounts.json"
export const KEYRING_REL = "keyring/antigravity"

export const MANAGED_AUTH_FILES = [
  AGY_TOKEN_REL,
  OAUTH_CREDS_REL,
  ACP_TOKEN_REL,
  KEYRING_REL,
] as const

export function getGeminiDir(): string {
  return join(homedir(), ".gemini")
}

export function getAgkDir(): string {
  return join(homedir(), ".agk-reborn")
}

export function getProfilesDir(): string {
  return join(getAgkDir(), "profiles")
}

export function getLiveAuthFilePath(relPath: string): string {
  return join(getGeminiDir(), relPath)
}

export function getGoogleAccountsPath(): string {
  return join(getGeminiDir(), GOOGLE_ACCOUNTS_REL)
}

export function getAgyTokenPath(): string {
  return join(getGeminiDir(), AGY_TOKEN_REL)
}
