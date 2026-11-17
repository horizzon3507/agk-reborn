export {
  getActiveAccountEmail,
  readGoogleAccounts,
  setActiveAccount,
} from "./utils/accounts.js"

export {
  captureLiveAuthFiles,
  detectAuthFileEmail,
  extractRefreshToken,
  geminiDirExists,
  parseAgyTokenFile,
  readAuthFile,
  writeAuthFileAtomic,
} from "./utils/auth-files.js"
export type { AgyTokenFile, AuthFileSnapshot } from "./utils/auth-files.js"

export { decodeJwtPayload } from "./utils/jwt.js"

export {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  GOOGLE_ACCOUNTS_REL,
  MANAGED_AUTH_FILES,
  OAUTH_CREDS_REL,
  getAgkDir,
  getAgyTokenPath,
  getGeminiDir,
  getGoogleAccountsPath,
  getLiveAuthFilePath,
  getProfilesDir,
} from "./utils/paths.js"

export {
  getProfile,
  getProfilePath,
  listProfiles,
  loadProfileSnapshots,
  removeProfile,
  sanitizeEmail,
  saveProfile,
  setProfileClient,
  updateProfileFile,
} from "./utils/profiles.js"
export type { Profile, ProfileFileMeta } from "./utils/profiles.js"

export { listAgyProcesses } from "./utils/processes.js"
export type { RunningProcess } from "./utils/processes.js"

export {
  captureSessionToProfiles,
  detectCurrentSessionEmail,
} from "./utils/session.js"
export type { CapturedSession } from "./utils/session.js"

export {
  buildAcpTokenFile,
  buildAgyTokenFile,
  buildAuthFilesForTokens,
  buildOauthCredsFile,
  patchAuthFileTokens,
} from "./utils/token-builders.js"
export type { FreshTokens } from "./utils/token-builders.js"

export {
  SCOPES,
  TOKEN_URL,
  exchangeCode,
  getAuthUrl,
  refreshAccessToken,
  refreshAccessTokenAnyClient,
} from "./utils/oauth.js"

export {
  buildClientCandidates,
  discoverOAuthClients,
  extractClientFromAuthFile,
  extractClientsFromBinary,
} from "./utils/oauth-clients.js"
export type {
  OAuthClient,
  RefreshedSession,
  TokenResponse,
} from "./utils/oauth.js"

export { startOAuthFlow } from "./utils/oauth-server.js"
export type { OAuthFlowResult } from "./utils/oauth-server.js"

export { getUserInfo } from "./utils/google-api.js"
export type { UserInfo } from "./utils/google-api.js"

export {
  fetchProjectId,
  fetchQuota,
  getQuotaWithRefresh,
} from "./utils/quota.js"
export type { ModelQuota, QuotaResult } from "./utils/quota.js"

export {
  printBanner,
  printCommand,
  printError,
  printHeader,
  printInfo,
  printSuccess,
  printVersion,
  printWarning,
} from "./utils/branding.js"
