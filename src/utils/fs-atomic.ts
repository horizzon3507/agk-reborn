import { randomBytes } from "node:crypto"
import {
  constants,
  type Dirent,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

export const MAX_SAFE_FILE_BYTES = 1_048_576
export const TEMP_FILE_PREFIX = ".agk-tmp-"

let tmpCounter = 0

function isPosix(): boolean {
  return process.platform !== "win32"
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

export function isSymlinkSync(targetPath: string): boolean {
  try {
    return lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

export function ensureSecureDirSync(
  dirPath: string,
  options?: { mode?: number | undefined; rootBoundary?: string | undefined }
): void {
  const mode = options?.mode ?? 0o700
  const resolvedDir = resolve(dirPath)

  if (options?.rootBoundary) {
    const resolvedRoot = resolve(options.rootBoundary)
    const rel = relative(resolvedRoot, resolvedDir)
    if (rel.startsWith("..") || rel.includes(`..${sep}`)) {
      throw new Error(
        `Directory ${resolvedDir} escapes boundary ${resolvedRoot}`
      )
    }

    mkdirSync(resolvedRoot, { recursive: true, mode })
    if (isPosix()) {
      try {
        const rootStat = lstatSync(resolvedRoot)
        if (rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
          chmodSync(resolvedRoot, mode)
        }
      } catch {
        // Best-effort permission tightening
      }
    }

    if (rel.length > 0) {
      let current = resolvedRoot
      for (const segment of rel.split(sep)) {
        if (!segment) continue
        current = join(current, segment)
        try {
          const st = lstatSync(current)
          if (st.isSymbolicLink()) {
            throw new Error(`Refusing symlink directory segment: ${current}`)
          }
          if (!st.isDirectory()) {
            throw new Error(`Expected directory at path segment: ${current}`)
          }
          if (isPosix() && (st.mode & 0o077) !== 0) {
            try {
              chmodSync(current, mode)
            } catch {
              // Best-effort
            }
          }
        } catch (error) {
          if (getErrnoCode(error) === "ENOENT") {
            mkdirSync(current, { mode })
            if (isPosix()) {
              try {
                chmodSync(current, mode)
              } catch {
                // Best-effort
              }
            }
          } else {
            throw error
          }
        }
      }
    }
    return
  }

  try {
    const existing = lstatSync(resolvedDir)
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing symlink directory: ${resolvedDir}`)
    }
    if (!existing.isDirectory()) {
      throw new Error(`Expected directory at: ${resolvedDir}`)
    }
  } catch (error) {
    if (getErrnoCode(error) !== "ENOENT") throw error
    mkdirSync(resolvedDir, { recursive: true, mode })
  }

  if (isPosix()) {
    try {
      chmodSync(resolvedDir, mode)
    } catch {
      // Best-effort
    }
  }
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) {
      throw new Error("Short write while persisting atomic file")
    }
    offset += written
  }
}

function fsyncDirBestEffort(dirPath: string): void {
  if (!isPosix()) return
  let dirFd: number | null = null
  try {
    dirFd = openSync(dirPath, constants.O_RDONLY)
    fsyncSync(dirFd)
  } catch {
    // Some filesystems do not support fsync on directories
  } finally {
    if (dirFd !== null) {
      try {
        closeSync(dirFd)
      } catch {
        // ignore
      }
    }
  }
}

export function writeFileAtomicSync(
  filePath: string,
  content: string,
  options?: {
    mode?: number | undefined
    dirMode?: number | undefined
    rootBoundary?: string | undefined
  }
): void {
  const resolvedPath = resolve(filePath)
  const mode = options?.mode ?? 0o600
  const dirMode = options?.dirMode ?? 0o700
  const parentDir = dirname(resolvedPath)

  ensureSecureDirSync(parentDir, {
    mode: dirMode,
    rootBoundary: options?.rootBoundary,
  })

  try {
    const targetStat = lstatSync(resolvedPath)
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${resolvedPath}`)
    }
    if (targetStat.isDirectory()) {
      throw new Error(`Refusing to overwrite directory: ${resolvedPath}`)
    }
  } catch (error) {
    if (getErrnoCode(error) !== "ENOENT") throw error
  }

  const safeBase = basename(resolvedPath)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 48)
  const seq = ++tmpCounter
  const nonce = randomBytes(8).toString("hex")
  const tmpPath = join(
    parentDir,
    `${TEMP_FILE_PREFIX}${safeBase}-${process.pid}-${seq}-${nonce}`
  )

  const openFlags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0)

  let fd: number | null = null
  let created = false
  let committed = false

  try {
    fd = openSync(tmpPath, openFlags, mode)
    created = true
    if (isPosix()) {
      fchmodSync(fd, mode)
    }

    const payload = Buffer.from(content, "utf-8")
    writeAllSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = null

    try {
      renameSync(tmpPath, resolvedPath)
    } catch (renameErr) {
      const code = getErrnoCode(renameErr)
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES")
      ) {
        try {
          unlinkSync(resolvedPath)
        } catch {
          // ignore if missing
        }
        renameSync(tmpPath, resolvedPath)
      } else {
        throw renameErr
      }
    }

    committed = true
    if (isPosix()) {
      try {
        chmodSync(resolvedPath, mode)
      } catch {
        // Best-effort
      }
    }
    fsyncDirBestEffort(parentDir)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    if (created && !committed) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
    }
  }
}

export type SafeReadResult =
  | { status: "ok"; content: string }
  | { status: "missing" }
  | { status: "unreadable"; reason: string }

export function readRegularFileSafe(
  filePath: string,
  maxBytes = MAX_SAFE_FILE_BYTES
): SafeReadResult {
  const resolvedPath = resolve(filePath)

  try {
    const lstat = lstatSync(resolvedPath)
    if (lstat.isSymbolicLink()) {
      return { status: "unreadable", reason: "symlink rejected" }
    }
    if (!lstat.isFile()) {
      return { status: "unreadable", reason: "not a regular file" }
    }
    if (lstat.size > maxBytes) {
      return { status: "unreadable", reason: "file exceeds size limit" }
    }
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return { status: "missing" }
    }
    return {
      status: "unreadable",
      reason: getErrnoCode(error) ?? "stat failed",
    }
  }

  const openFlags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)

  let fd: number | null = null
  try {
    fd = openSync(resolvedPath, openFlags)
    const fstat = fstatSync(fd)
    if (!fstat.isFile()) {
      return { status: "unreadable", reason: "not a regular file" }
    }
    if (fstat.size > maxBytes) {
      return { status: "unreadable", reason: "file exceeds size limit" }
    }

    const size = fstat.size
    if (size === 0) {
      return { status: "ok", content: "" }
    }

    const buf = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(fd, buf, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }

    const rawText = buf.subarray(0, offset).toString("utf-8")
    const content =
      rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
    return { status: "ok", content }
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === "ENOENT") return { status: "missing" }
    return { status: "unreadable", reason: code ?? "read failed" }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

export interface PermissionAudit {
  exists: boolean
  isSymlink: boolean
  wrongKind: boolean
  tooOpen: boolean
  mode: number | null
}

export function auditPathPermissions(
  targetPath: string,
  expectedKind: "file" | "dir"
): PermissionAudit {
  try {
    const st = lstatSync(targetPath)
    if (st.isSymbolicLink()) {
      return {
        exists: true,
        isSymlink: true,
        wrongKind: true,
        tooOpen: false,
        mode: st.mode & 0o777,
      }
    }
    const kindOk = expectedKind === "dir" ? st.isDirectory() : st.isFile()
    const mode = st.mode & 0o777
    const tooOpen = isPosix() && kindOk && (mode & 0o077) !== 0
    return {
      exists: true,
      isSymlink: false,
      wrongKind: !kindOk,
      tooOpen,
      mode,
    }
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return {
        exists: false,
        isSymlink: false,
        wrongKind: false,
        tooOpen: false,
        mode: null,
      }
    }
    return {
      exists: true,
      isSymlink: false,
      wrongKind: true,
      tooOpen: false,
      mode: null,
    }
  }
}

export function repairPathPermissions(
  targetPath: string,
  expectedKind: "file" | "dir"
): boolean {
  if (!isPosix()) return true
  try {
    const st = lstatSync(targetPath)
    if (st.isSymbolicLink()) return false
    if (expectedKind === "dir" && !st.isDirectory()) return false
    if (expectedKind === "file" && !st.isFile()) return false
    chmodSync(targetPath, expectedKind === "dir" ? 0o700 : 0o600)
    return true
  } catch {
    return false
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return getErrnoCode(error) === "EPERM"
  }
}

function extractPidFromTempName(fileName: string): number | null {
  const parts = fileName.split("-")
  if (parts.length < 4) return null
  const pidPart = parts[parts.length - 3]
  if (!pidPart || !/^\d+$/.test(pidPart)) return null
  const pid = Number.parseInt(pidPart, 10)
  return Number.isSafeInteger(pid) ? pid : null
}

export function listStaleTempFiles(
  dirs: readonly string[],
  maxAgeMs = 10 * 60_000
): string[] {
  const found: string[] = []
  const now = Date.now()

  for (const dir of dirs) {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const name = entry.name
      if (!name.startsWith(TEMP_FILE_PREFIX)) continue
      const fullPath = join(dir, name)
      try {
        const st = lstatSync(fullPath)
        if (st.isDirectory()) continue
        const pid = extractPidFromTempName(name)
        const deadHolder =
          pid !== null && pid !== process.pid && !isPidAlive(pid)
        const expired = now - st.mtimeMs >= maxAgeMs
        if (deadHolder || expired) {
          found.push(fullPath)
        }
      } catch {
        // ignore
      }
    }
  }

  return found
}

export function cleanStaleTempFiles(
  dirs: readonly string[],
  maxAgeMs = 10 * 60_000
): string[] {
  const candidates = listStaleTempFiles(dirs, maxAgeMs)
  const removed: string[] = []
  for (const candidate of candidates) {
    try {
      unlinkSync(candidate)
      removed.push(candidate)
    } catch {
      // ignore if concurrently removed
    }
  }
  return removed
}
