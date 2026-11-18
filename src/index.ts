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
export type {
  Profile,
  ProfileFileMeta,
  SaveProfileOptions,
} from "./utils/profiles.js"

export {
  collectProtectedPids,
  filterAgyProcessRows,
  formatProcessSummary,
  isAgyArgv,
  listAgyProcesses,
  parsePsTable,
  scanAgyProcesses,
  terminateProcesses,
  tokenizeCommandString,
} from "./utils/processes.js"
export type {
  AgyProcessScanResult,
  RawProcessRow,
  RunningProcess,
} from "./utils/processes.js"

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
export type { BuiltAuthFile, FreshTokens } from "./utils/token-builders.js"

export {
  AUTH_URL,
  OAuthError,
  SCOPES,
  TOKEN_URL,
  exchangeCode,
  generateOAuthState,
  generatePkcePair,
  getAuthUrl,
  refreshAccessToken,
  refreshAccessTokenAnyClient,
} from "./utils/oauth.js"
export type {
  AuthUrlOptions,
  OAuthClient,
  OAuthErrorKind,
  OAuthRequestOptions,
  PkcePair,
  RefreshedSession,
  TokenResponse,
} from "./utils/oauth.js"

export {
  MAX_SCAN_FILE_BYTES,
  buildClientCandidates,
  clearOAuthClientCache,
  discoverOAuthClients,
  extractClientFromAuthFile,
  extractClientsFromBinary,
} from "./utils/oauth-clients.js"
export type { ClientCandidateOptions } from "./utils/oauth-clients.js"

export {
  DEFAULT_CALLBACK_TIMEOUT_MS,
  OAUTH_CALLBACK_PATH,
  OAUTH_LOOPBACK_HOST,
  openBrowser,
  startCallbackServer,
  startOAuthFlow,
  validateBrowserUrl,
  verifyOAuthState,
} from "./utils/oauth-server.js"
export type {
  CallbackServerHandle,
  CallbackServerOptions,
  OAuthFlowOptions,
  OAuthFlowResult,
  OAuthFlowStage,
} from "./utils/oauth-server.js"

export {
  USERINFO_URL,
  USER_AGENT,
  buildHostUserAgent,
  fetchWithRetry,
  getUserInfo,
} from "./utils/google-api.js"
export type { ApiRequestOptions, UserInfo } from "./utils/google-api.js"

export {
  CLOUD_CODE_BASE_URL,
  LOAD_CODE_ASSIST_URL,
  QUOTA_API_URL,
  clampQuotaPercentage,
  computeQuotaPercentage,
  fetchProjectId,
  fetchQuota,
  getQuotaWithRefresh,
  resolveFamilyQuota,
} from "./utils/quota.js"
export type {
  ModelQuota,
  ProjectAssistInfo,
  QuotaRequestOptions,
  QuotaResult,
  RefreshedQuotaResult,
} from "./utils/quota.js"

export {
  printBanner,
  printCommand,
  printError,
  printHeader,
  printInfo,
  printSuccess,
  printVersion,
  printWarning,
  resetHeaderState,
  shouldSuppressBanner,
} from "./utils/branding.js"
