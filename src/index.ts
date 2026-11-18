export {
  BIN_NAME,
  DESCRIPTION,
  NAME,
  VERSION,
} from "./version.js"

export {
  MAX_OLD_ACCOUNTS,
  getActiveAccountEmail,
  readGoogleAccounts,
  setActiveAccount,
} from "./utils/accounts.js"
export type { GoogleAccountsFile } from "./utils/accounts.js"

export {
  authFileExists,
  captureLiveAuthFiles,
  detectAuthFileEmail,
  extractRefreshToken,
  geminiDirExists,
  inspectAuthFile,
  isValidAuthFileContent,
  parseAgyTokenFile,
  readAuthFile,
  readAuthFileState,
  removeAuthFile,
  writeAuthFileAtomic,
} from "./utils/auth-files.js"
export type {
  AgyTokenFile,
  AuthFileInspection,
  AuthFileSnapshot,
  AuthFileState,
} from "./utils/auth-files.js"

export {
  MAX_JWT_LENGTH,
  decodeJwtPayload,
  getJwtExpiryMs,
  isJwtExpired,
} from "./utils/jwt.js"
export type { JwtPayload } from "./utils/jwt.js"

export {
  KEYRING_LABEL,
  KEYRING_SERVICE,
  KEYRING_USERNAME,
  clearKeyringSecret,
  isValidKeyringSecret,
  keyringAvailable,
  readKeyringSecret,
  resetKeyringCache,
  setKeyringTestBackend,
  writeKeyringSecret,
} from "./utils/keyring.js"
export type { KeyringBackend } from "./utils/keyring.js"

export {
  getAgkLockPath,
  isAgkLocked,
  withAgkLock,
  withAgkLockSync,
} from "./utils/lock.js"
export type { LockOptions } from "./utils/lock.js"

export {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  GOOGLE_ACCOUNTS_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
  OAUTH_CREDS_REL,
  assertSafeRelPath,
  assertWithinDir,
  findExecutableInPath,
  formatDisplayPath,
  getAgkDir,
  getAgyTokenPath,
  getGeminiDir,
  getGoogleAccountsPath,
  getLiveAuthFilePath,
  getProfilesDir,
  isGeminiDirOverridden,
  resolveHomeDir,
} from "./utils/paths.js"
export type { ManagedAuthFile } from "./utils/paths.js"

export {
  auditPathPermissions,
  cleanStaleTempFiles,
  ensureSecureDirSync,
  isSymlinkSync,
  listStaleTempFiles,
  readRegularFileSafe,
  repairPathPermissions,
  writeFileAtomicSync,
} from "./utils/fs-atomic.js"
export type { PermissionAudit, SafeReadResult } from "./utils/fs-atomic.js"

export {
  formatHttpErrorDetail,
  isPlainObject,
  normalizeEmail,
  parseJsonObject,
  redactSecrets,
  sanitizeErrorMessage,
  sanitizeTerminalText,
  stripAnsiAndControls,
} from "./utils/redact.js"

export {
  backupProfileTo,
  decodeRelPath,
  encodeRelPath,
  getProfile,
  getProfilePath,
  listCorruptProfileDirs,
  listProfiles,
  loadProfileSnapshots,
  removeProfile,
  sanitizeEmail,
  saveProfile,
  setProfileClient,
  updateProfileFile,
} from "./utils/profiles.js"
export type { Profile, ProfileFileMeta } from "./utils/profiles.js"

export {
  listAgyProcesses,
  terminateProcesses,
} from "./utils/processes.js"
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
