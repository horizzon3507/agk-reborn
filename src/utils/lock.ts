import { randomBytes } from "node:crypto"
import {
  constants,
  closeSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { ensureSecureDirSync, readRegularFileSafe } from "./fs-atomic.js"
import { getAgkDir } from "./paths.js"

export interface LockOptions {
  timeoutMs?: number | undefined
  staleMs?: number | undefined
}

interface LockPayload {
  pid: number
  nonce: string
  createdAt: number
  label: string
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_STALE_LOCK_MS = 60_000

let activeLockDepth = 0
let activeLockPath: string | null = null
let activeLockNonce: string | null = null

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

function isHolderAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrnoCode(error) === "EPERM"
  }
}

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    const rec = parsed as Record<string, unknown>
    const pid = rec["pid"]
    const nonce = rec["nonce"]
    const createdAt = rec["createdAt"]
    const label = rec["label"]
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      typeof nonce !== "string" ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt)
    ) {
      return null
    }
    return {
      pid,
      nonce,
      createdAt,
      label: typeof label === "string" ? label : "unknown",
    }
  } catch {
    return null
  }
}

export function getAgkLockPath(): string {
  return join(getAgkDir(), ".lock")
}

function tryAcquireOnce(
  lockPath: string,
  label: string,
  staleMs: number
): string | null {
  const agkDir = getAgkDir()
  ensureSecureDirSync(agkDir, { mode: 0o700 })

  const nonce = randomBytes(8).toString("hex")
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0)

  let fd: number | null = null
  try {
    fd = openSync(lockPath, flags, 0o600)
    const body = JSON.stringify({
      pid: process.pid,
      nonce,
      createdAt: Date.now(),
      label,
    } satisfies LockPayload)
    writeSync(fd, Buffer.from(body, "utf-8"))
    closeSync(fd)
    fd = null
    return nonce
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    if (getErrnoCode(error) !== "EEXIST") {
      throw error
    }
  }

  const state = readRegularFileSafe(lockPath, 16_384)
  if (state.status === "ok") {
    const payload = parseLockPayload(state.content)
    const now = Date.now()
    if (payload) {
      const dead = payload.pid !== process.pid && !isHolderAlive(payload.pid)
      const expired = now - payload.createdAt > staleMs
      if (dead || expired) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another contender already cleaned it up
        }
      }
      return null
    }
  }

  try {
    const st = lstatSync(lockPath)
    if (st.isSymbolicLink() || Date.now() - st.mtimeMs > 2_000) {
      unlinkSync(lockPath)
    }
  } catch {
    // ignore
  }

  return null
}

function releaseOwnedLock(lockPath: string, expectedNonce: string): void {
  try {
    const state = readRegularFileSafe(lockPath, 16_384)
    if (state.status === "ok") {
      const payload = parseLockPayload(state.content)
      if (payload && payload.nonce !== expectedNonce) {
        return
      }
    }
    unlinkSync(lockPath)
  } catch {
    // ignore if already removed
  }
}

function sleepSync(ms: number): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(waitBuffer, 0, 0, ms)
}

export function withAgkLockSync<T>(
  label: string,
  fn: () => T,
  options?: LockOptions
): T {
  const lockPath = getAgkLockPath()
  if (activeLockDepth > 0 && activeLockPath === lockPath) {
    activeLockDepth++
    try {
      return fn()
    } finally {
      activeLockDepth--
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = options?.staleMs ?? DEFAULT_STALE_LOCK_MS
  const deadline = Date.now() + timeoutMs

  let nonce: string | null = null
  while (nonce === null) {
    nonce = tryAcquireOnce(lockPath, label, staleMs)
    if (nonce !== null) break
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for profile lock (${lockPath}) during ${label}`
      )
    }
    const delayMs = 25 + Math.floor(Math.random() * 40)
    sleepSync(delayMs)
  }

  activeLockDepth = 1
  activeLockPath = lockPath
  activeLockNonce = nonce

  try {
    return fn()
  } finally {
    activeLockDepth = 0
    activeLockPath = null
    activeLockNonce = null
    releaseOwnedLock(lockPath, nonce)
  }
}

export async function withAgkLock<T>(
  label: string,
  fn: () => Promise<T> | T,
  options?: LockOptions
): Promise<T> {
  const lockPath = getAgkLockPath()
  if (activeLockDepth > 0 && activeLockPath === lockPath) {
    activeLockDepth++
    try {
      return await fn()
    } finally {
      activeLockDepth--
    }
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const staleMs = options?.staleMs ?? DEFAULT_STALE_LOCK_MS
  const deadline = Date.now() + timeoutMs

  let nonce: string | null = null
  while (nonce === null) {
    nonce = tryAcquireOnce(lockPath, label, staleMs)
    if (nonce !== null) break
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for profile lock (${lockPath}) during ${label}`
      )
    }
    const delayMs = 25 + Math.floor(Math.random() * 50)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  activeLockDepth = 1
  activeLockPath = lockPath
  activeLockNonce = nonce

  try {
    return await fn()
  } finally {
    activeLockDepth = 0
    activeLockPath = null
    activeLockNonce = null
    releaseOwnedLock(lockPath, nonce)
  }
}

export function isAgkLocked(): boolean {
  if (activeLockDepth > 0 && activeLockNonce !== null) return true
  const lockPath = getAgkLockPath()
  const state = readRegularFileSafe(lockPath, 16_384)
  if (state.status !== "ok") return false
  const payload = parseLockPayload(state.content)
  if (!payload) return false
  return isHolderAlive(payload.pid)
}
