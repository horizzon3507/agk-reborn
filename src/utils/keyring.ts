import { execFileSync } from "node:child_process"
import { existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { readRegularFileSafe, writeFileAtomicSync } from "./fs-atomic.js"
import { isGeminiDirOverridden } from "./paths.js"
import { isPlainObject, parseJsonObject } from "./redact.js"

export const KEYRING_SERVICE = "gemini"
export const KEYRING_USERNAME = "antigravity"
export const KEYRING_LABEL = `Password for '${KEYRING_USERNAME}' on '${KEYRING_SERVICE}'`

const KEYRING_TIMEOUT_MS = 2_500
const MAX_SECRET_BYTES = 262_144

export interface KeyringBackend {
  available(): boolean
  read(): string | null
  write(secret: string): boolean
  clear(): boolean
}

let cachedAvailable: boolean | null = null
let testBackend: KeyringBackend | null = null

export function resetKeyringCache(): void {
  cachedAvailable = null
}

export function setKeyringTestBackend(backend: KeyringBackend | null): void {
  testBackend = backend
  cachedAvailable = null
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function getSandboxKeyringFile(): string | null {
  const raw = process.env["AGK_KEYRING_FILE"]?.trim()
  return raw && raw.length > 0 ? raw : null
}

function isKeyringDisabledByEnv(): boolean {
  if (
    isTruthyEnv(process.env["AGK_DISABLE_KEYRING"]) ||
    isTruthyEnv(process.env["AGK_NO_KEYRING"])
  ) {
    return true
  }
  if (
    isGeminiDirOverridden() &&
    !getSandboxKeyringFile() &&
    !isTruthyEnv(process.env["AGK_ENABLE_HOST_KEYRING"])
  ) {
    return true
  }
  return false
}

function hasLinuxDbusSession(): boolean {
  const dbusAddr = process.env["DBUS_SESSION_BUS_ADDRESS"]?.trim()
  if (dbusAddr && dbusAddr.length > 0) return true

  const runtimeDir = process.env["XDG_RUNTIME_DIR"]?.trim()
  if (runtimeDir && existsSync(join(runtimeDir, "bus"))) {
    return true
  }
  return false
}

function didCommandTimeOut(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const rec = error as { code?: unknown; signal?: unknown; killed?: unknown }
  return (
    rec.code === "ETIMEDOUT" || rec.signal === "SIGKILL" || rec.killed === true
  )
}

export function isValidKeyringSecret(value: string): boolean {
  if (!value || Buffer.byteLength(value, "utf-8") > MAX_SECRET_BYTES) {
    return false
  }
  if (value.includes("\0") || value.includes("\ufffd")) {
    return false
  }
  const parsed = parseJsonObject(value)
  if (!parsed) return false

  const token = parsed["token"]
  if (!isPlainObject(token)) return false

  const access = token["access_token"]
  const refresh = token["refresh_token"]
  const hasAccess = typeof access === "string" && access.trim().length > 0
  const hasRefresh = typeof refresh === "string" && refresh.trim().length > 0
  return hasAccess || hasRefresh
}

export function keyringAvailable(): boolean {
  if (testBackend) return testBackend.available()
  if (getSandboxKeyringFile() !== null) return true
  if (isKeyringDisabledByEnv()) return false
  if (process.platform !== "linux") return false
  if (!hasLinuxDbusSession()) return false

  if (cachedAvailable !== null) return cachedAvailable

  try {
    execFileSync(
      "secret-tool",
      ["search", "--all", "service", "agk-reborn-probe-nonexistent"],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: KEYRING_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }
    )
    cachedAvailable = true
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

export function readKeyringSecret(): string | null {
  if (testBackend) {
    if (!testBackend.available()) return null
    const raw = testBackend.read()
    return raw && isValidKeyringSecret(raw) ? raw : null
  }

  const sandboxFile = getSandboxKeyringFile()
  if (sandboxFile !== null) {
    const res = readRegularFileSafe(sandboxFile, MAX_SECRET_BYTES)
    if (res.status !== "ok") return null
    const trimmed = res.content.trim()
    return isValidKeyringSecret(trimmed) ? trimmed : null
  }

  if (!keyringAvailable()) return null

  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", KEYRING_SERVICE, "username", KEYRING_USERNAME],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: KEYRING_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_SECRET_BYTES,
      }
    )
    const secret = out.trim()
    return isValidKeyringSecret(secret) ? secret : null
  } catch (error) {
    if (didCommandTimeOut(error)) {
      cachedAvailable = false
    }
    return null
  }
}

export function writeKeyringSecret(secret: string): boolean {
  if (!isValidKeyringSecret(secret)) return false

  if (testBackend) {
    return testBackend.available() ? testBackend.write(secret) : false
  }

  const sandboxFile = getSandboxKeyringFile()
  if (sandboxFile !== null) {
    try {
      writeFileAtomicSync(sandboxFile, secret, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  if (!keyringAvailable()) return false

  try {
    execFileSync(
      "secret-tool",
      [
        "store",
        `--label=${KEYRING_LABEL}`,
        "service",
        KEYRING_SERVICE,
        "username",
        KEYRING_USERNAME,
      ],
      {
        input: Buffer.from(secret, "utf-8"),
        stdio: ["pipe", "ignore", "ignore"],
        timeout: KEYRING_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }
    )
    return true
  } catch (error) {
    if (didCommandTimeOut(error)) {
      cachedAvailable = false
    }
    return false
  }
}

export function clearKeyringSecret(): boolean {
  if (testBackend) {
    return testBackend.available() ? testBackend.clear() : false
  }

  const sandboxFile = getSandboxKeyringFile()
  if (sandboxFile !== null) {
    try {
      unlinkSync(sandboxFile)
      return true
    } catch {
      return false
    }
  }

  if (!keyringAvailable()) return false

  try {
    execFileSync(
      "secret-tool",
      ["clear", "service", KEYRING_SERVICE, "username", KEYRING_USERNAME],
      {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: KEYRING_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }
    )
    return true
  } catch (error) {
    if (didCommandTimeOut(error)) {
      cachedAvailable = false
    }
    return false
  }
}
