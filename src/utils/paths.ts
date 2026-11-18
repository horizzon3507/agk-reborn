import { constants, accessSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, isAbsolute, join, parse, resolve, sep } from "node:path"

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

export type ManagedAuthFile = (typeof MANAGED_AUTH_FILES)[number]

const GEMINI_ENV_KEYS = [
  "AGK_GEMINI_DIR",
  "GEMINI_HOME",
  "GEMINI_DIR",
  "GEMINI_CLI_HOME",
] as const

const AGK_ENV_KEYS = ["AGK_HOME", "AGK_DIR"] as const

export function resolveHomeDir(): string {
  try {
    const home = homedir().trim()
    if (home && isAbsolute(home)) {
      const resolved = resolve(home)
      if (resolved !== parse(resolved).root) return resolved
    }
  } catch {
    // Rootless container without /etc/passwd entry
  }

  for (const key of ["HOME", "USERPROFILE"] as const) {
    const raw = process.env[key]?.trim()
    if (raw && isAbsolute(raw)) {
      const resolved = resolve(raw)
      if (resolved !== parse(resolved).root) return resolved
    }
  }

  return resolve(tmpdir(), `agk-user-${process.getuid?.() ?? 0}`)
}

function expandEnvPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === "~") return resolveHomeDir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(resolveHomeDir(), trimmed.slice(2))
  }
  const resolved = resolve(trimmed)
  if (resolved === parse(resolved).root) {
    throw new Error(`Refusing filesystem root as data directory: ${raw}`)
  }
  return resolved
}

function readEnvDirOverride(keys: readonly string[]): string | null {
  for (const key of keys) {
    const val = process.env[key]?.trim()
    if (val && val.length > 0) {
      return expandEnvPath(val)
    }
  }
  return null
}

export function isGeminiDirOverridden(): boolean {
  return readEnvDirOverride(GEMINI_ENV_KEYS) !== null
}

export function getGeminiDir(): string {
  return (
    readEnvDirOverride(GEMINI_ENV_KEYS) ?? join(resolveHomeDir(), ".gemini")
  )
}

export function getAgkDir(): string {
  return (
    readEnvDirOverride(AGK_ENV_KEYS) ?? join(resolveHomeDir(), ".agk-reborn")
  )
}

export function getProfilesDir(): string {
  return join(getAgkDir(), "profiles")
}

export function assertSafeRelPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("Relative path must be a non-empty string")
  }
  if (
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    relPath.startsWith("/") ||
    isAbsolute(relPath)
  ) {
    throw new Error(`Unsafe relative path: ${relPath}`)
  }

  const segments = relPath.split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`Invalid relative path segment in: ${relPath}`)
    }
  }
  return relPath
}

export function assertWithinDir(baseDir: string, targetPath: string): string {
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = resolve(targetPath)
  const prefix = resolvedBase.endsWith(sep)
    ? resolvedBase
    : `${resolvedBase}${sep}`

  if (!resolvedTarget.startsWith(prefix)) {
    throw new Error(`Path escapes boundary (${resolvedBase}): ${targetPath}`)
  }
  return resolvedTarget
}

export function getLiveAuthFilePath(relPath: string): string {
  if (relPath === KEYRING_REL) {
    throw new Error("Keyring auth entry does not map to a filesystem path")
  }
  const safeRel = assertSafeRelPath(relPath)
  const geminiDir = getGeminiDir()
  return assertWithinDir(geminiDir, join(geminiDir, safeRel))
}

export function getGoogleAccountsPath(): string {
  return getLiveAuthFilePath(GOOGLE_ACCOUNTS_REL)
}

export function getAgyTokenPath(): string {
  return getLiveAuthFilePath(AGY_TOKEN_REL)
}

export function formatDisplayPath(targetPath: string): string {
  const resolvedTarget = resolve(targetPath)
  const home = resolveHomeDir()
  if (resolvedTarget === home) return "~"
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`
  if (resolvedTarget.startsWith(prefix)) {
    return `~/${resolvedTarget.slice(prefix.length).split(sep).join("/")}`
  }
  return resolvedTarget
}

export function findExecutableInPath(
  names: readonly string[],
  customSearchPath?: string
): string | null {
  const rawPath =
    customSearchPath ?? process.env["PATH"] ?? process.env["Path"] ?? ""
  if (!rawPath) return null

  const isWin = process.platform === "win32"
  const rawExts = isWin
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.PS1")
        .split(";")
        .filter((ext) => ext.length > 0)
    : [""]
  const extensions = isWin ? ["", ...rawExts] : rawExts

  const dirs = rawPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"+|"+$/g, ""))
    .filter((entry) => entry.length > 0 && isAbsolute(entry))

  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = join(
          dir,
          ext && !name.toLowerCase().endsWith(ext.toLowerCase())
            ? `${name}${ext}`
            : name
        )
        try {
          const st = statSync(candidate)
          if (!st.isFile()) continue
          if (!isWin) {
            accessSync(candidate, constants.X_OK)
          }
          return candidate
        } catch {
          // try next candidate
        }
      }
    }
  }

  return null
}
