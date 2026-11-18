import { createHash } from "node:crypto"
import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import type { AuthFileSnapshot } from "./auth-files.js"
import {
  MAX_SAFE_FILE_BYTES,
  TEMP_FILE_PREFIX,
  ensureSecureDirSync,
  readRegularFileSafe,
  writeFileAtomicSync,
} from "./fs-atomic.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
  assertSafeRelPath,
  assertWithinDir,
  getAgkDir,
  getProfilesDir,
} from "./paths.js"
import {
  isDangerousObjectKey,
  isPlainObject,
  normalizeEmail,
  parseJsonObject,
  sanitizeTerminalText,
} from "./redact.js"

export interface ProfileFileMeta {
  email: string | null
  savedAt: number
}

export interface Profile {
  email: string
  name: string | null
  clientId: string | null
  clientSecret: string | null
  createdAt: number
  updatedAt: number
  path: string
  files: Record<string, ProfileFileMeta>
}

export interface SaveProfileOptions {
  name?: string | undefined
  clientId?: string | undefined
  clientSecret?: string | undefined
  replaceFiles?: boolean | undefined
}

interface ProfileMetaFile {
  email: string
  name?: string | undefined
  clientId?: string | undefined
  clientSecret?: string | undefined
  createdAt: number
  updatedAt: number
  files: Record<string, ProfileFileMeta>
}

const META_FILE = "meta.json"
const FILES_DIR = "files"

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.@]|$)/i
const SAFE_PROFILE_DIR_RE = /^[a-z0-9@.+_-]+$/

const SNAPSHOT_PRIORITY: Readonly<Record<string, number>> = {
  [KEYRING_REL]: 0,
  [AGY_TOKEN_REL]: 1,
  [OAUTH_CREDS_REL]: 2,
  [ACP_TOKEN_REL]: 3,
}

export function sanitizeEmail(email: string): string {
  if (typeof email !== "string") {
    throw new Error("Profile email must be a string")
  }
  const trimmed = email.trim().toLowerCase()
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(`Unsafe profile identifier: ${email}`)
  }

  const needsHash =
    !SAFE_PROFILE_DIR_RE.test(trimmed) ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    WINDOWS_RESERVED_RE.test(trimmed)

  if (!needsHash && trimmed.length <= 200) {
    return trimmed
  }

  const cleaned = trimmed
    .replace(/[^a-z0-9@.+_-]/g, "_")
    .replace(/^\.+/, "_")
    .replace(/\.+$/, "_")
    .slice(0, 120)
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12)
  const prefix = WINDOWS_RESERVED_RE.test(cleaned) ? `_${cleaned}` : cleaned
  return `${prefix || "account"}~${digest}`
}

export function encodeRelPath(relPath: string): string {
  const safe = assertSafeRelPath(relPath)
  let encoded = safe.replace(/%/g, "%25")
  while (encoded.includes("__")) {
    encoded = encoded.replace(/__/g, "%5F_")
  }
  encoded = encoded
    .replace(/_(?=\/)/g, "%5F")
    .replace(/(?<=\/)_/g, "%5F")
    .replace(/\//g, "__")

  if (encoded.startsWith(".")) {
    encoded = `%2E${encoded.slice(1)}`
  }
  return encoded
}

export function decodeRelPath(encoded: string): string {
  if (
    !encoded ||
    encoded.startsWith(".") ||
    encoded.includes("/") ||
    encoded.includes("\\") ||
    encoded.includes("\0")
  ) {
    throw new Error(`Invalid encoded snapshot filename: ${encoded}`)
  }

  const withSlashes = encoded.replace(/__/g, "/")
  const decoded = withSlashes.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
  return assertSafeRelPath(decoded)
}

function parseProfileMeta(raw: string): ProfileMetaFile | null {
  const parsed = parseJsonObject(raw)
  if (!parsed) return null

  const email = normalizeEmail(parsed["email"])
  if (!email) return null

  const now = Date.now()
  const rawCreated = parsed["createdAt"]
  const createdAt =
    typeof rawCreated === "number" &&
    Number.isFinite(rawCreated) &&
    rawCreated > 0
      ? rawCreated
      : now

  const rawUpdated = parsed["updatedAt"]
  const updatedAt =
    typeof rawUpdated === "number" &&
    Number.isFinite(rawUpdated) &&
    rawUpdated > 0
      ? rawUpdated
      : createdAt

  const files: Record<string, ProfileFileMeta> = {}
  const rawFiles = parsed["files"]
  if (isPlainObject(rawFiles)) {
    for (const [key, val] of Object.entries(rawFiles)) {
      if (isDangerousObjectKey(key) || !isPlainObject(val)) continue
      try {
        const safeKey = assertSafeRelPath(key)
        const fileEmail =
          val["email"] === null ? null : normalizeEmail(val["email"])
        const savedAt =
          typeof val["savedAt"] === "number" &&
          Number.isFinite(val["savedAt"]) &&
          val["savedAt"] > 0
            ? val["savedAt"]
            : updatedAt
        files[safeKey] = { email: fileEmail, savedAt }
      } catch {
        // Skip invalid relative path metadata entry
      }
    }
  }

  const meta: ProfileMetaFile = {
    email,
    createdAt,
    updatedAt,
    files,
  }

  if (typeof parsed["name"] === "string") {
    const cleanName = sanitizeTerminalText(parsed["name"], 120)
    if (cleanName) meta.name = cleanName
  }
  if (typeof parsed["clientId"] === "string" && parsed["clientId"].trim()) {
    meta.clientId = parsed["clientId"].trim()
  }
  if (
    typeof parsed["clientSecret"] === "string" &&
    parsed["clientSecret"].trim()
  ) {
    meta.clientSecret = parsed["clientSecret"].trim()
  }

  return meta
}

function readMeta(profilePath: string): ProfileMetaFile | null {
  const metaPath = join(profilePath, META_FILE)
  const state = readRegularFileSafe(metaPath, MAX_SAFE_FILE_BYTES)
  if (state.status !== "ok") return null
  return parseProfileMeta(state.content)
}

function findExistingProfileDir(normalizedTargetEmail: string): string | null {
  const profilesDir = getProfilesDir()
  if (!existsSync(profilesDir)) return null

  let entries: Dirent[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith(".")) continue
    const candidatePath = join(profilesDir, entry.name)
    const meta = readMeta(candidatePath)
    if (meta && meta.email === normalizedTargetEmail) {
      return assertWithinDir(profilesDir, candidatePath)
    }
  }

  return null
}

export function getProfilePath(email: string): string {
  const normalized = normalizeEmail(email)
  const profilesDir = getProfilesDir()
  if (normalized) {
    const existing = findExistingProfileDir(normalized)
    if (existing) return existing
    return assertWithinDir(
      profilesDir,
      join(profilesDir, sanitizeEmail(normalized))
    )
  }
  return assertWithinDir(profilesDir, join(profilesDir, sanitizeEmail(email)))
}

export function listProfiles(): Profile[] {
  const profilesDir = getProfilesDir()
  if (!existsSync(profilesDir)) return []

  let entries: Dirent[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    return []
  }

  const byEmail = new Map<string, Profile>()

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name.startsWith(".")) continue

    const profilePath = join(profilesDir, entry.name)
    const meta = readMeta(profilePath)
    if (!meta) continue

    const candidate: Profile = {
      email: meta.email,
      name: meta.name ?? null,
      clientId: meta.clientId ?? null,
      clientSecret: meta.clientSecret ?? null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      path: profilePath,
      files: meta.files,
    }

    const prev = byEmail.get(meta.email)
    if (!prev || candidate.updatedAt >= prev.updatedAt) {
      byEmail.set(meta.email, candidate)
    }
  }

  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email))
}

export function listCorruptProfileDirs(): string[] {
  const profilesDir = getProfilesDir()
  if (!existsSync(profilesDir)) return []

  let entries: Dirent[]
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
  } catch {
    return []
  }

  const corrupt: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const fullPath = join(profilesDir, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      corrupt.push(fullPath)
      continue
    }
    if (readMeta(fullPath) === null) {
      corrupt.push(fullPath)
    }
  }
  return corrupt
}

export function getProfile(email: string): Profile | null {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  return listProfiles().find((profile) => profile.email === normalized) ?? null
}

export function saveProfile(
  email: string,
  snapshots: AuthFileSnapshot[],
  options?: SaveProfileOptions
): Profile {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    throw new Error(`Invalid profile email: ${String(email)}`)
  }

  const agkDir = getAgkDir()
  const profilePath = getProfilePath(normalized)
  const filesDir = join(profilePath, FILES_DIR)
  ensureSecureDirSync(filesDir, { mode: 0o700, rootBoundary: agkDir })

  const existing = readMeta(profilePath)
  const now = Date.now()
  const files: Record<string, ProfileFileMeta> = options?.replaceFiles
    ? {}
    : { ...(existing?.files ?? {}) }

  const writtenEncodedNames = new Set<string>()

  for (const snapshot of snapshots) {
    const safeRel = assertSafeRelPath(snapshot.relPath)
    const encodedName = encodeRelPath(safeRel)
    writtenEncodedNames.add(encodedName)

    writeFileAtomicSync(join(filesDir, encodedName), snapshot.content, {
      mode: 0o600,
      dirMode: 0o700,
      rootBoundary: agkDir,
    })
    files[safeRel] = {
      email: snapshot.email
        ? (normalizeEmail(snapshot.email) ?? normalized)
        : null,
      savedAt: now,
    }
  }

  if (options?.replaceFiles) {
    try {
      for (const entry of readdirSync(filesDir, { withFileTypes: true })) {
        if (entry.name.startsWith(TEMP_FILE_PREFIX)) continue
        if (writtenEncodedNames.has(entry.name)) continue
        if (entry.isFile() || entry.isSymbolicLink()) {
          try {
            unlinkSync(join(filesDir, entry.name))
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const resolvedName = options?.name ?? existing?.name
  const resolvedClientId = options?.clientId ?? existing?.clientId
  const resolvedClientSecret = options?.clientSecret ?? existing?.clientSecret

  const meta: ProfileMetaFile = {
    email: normalized,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    files,
  }
  if (resolvedName) {
    const cleanName = sanitizeTerminalText(resolvedName, 120)
    if (cleanName) meta.name = cleanName
  }
  if (resolvedClientId?.trim()) meta.clientId = resolvedClientId.trim()
  if (resolvedClientSecret?.trim()) {
    meta.clientSecret = resolvedClientSecret.trim()
  }

  writeFileAtomicSync(
    join(profilePath, META_FILE),
    JSON.stringify(meta, null, 2),
    {
      mode: 0o600,
      dirMode: 0o700,
      rootBoundary: agkDir,
    }
  )

  return {
    email: normalized,
    name: meta.name ?? null,
    clientId: meta.clientId ?? null,
    clientSecret: meta.clientSecret ?? null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    path: profilePath,
    files,
  }
}

export function setProfileClient(
  email: string,
  client: { id: string; secret: string }
): void {
  const profilePath = getProfilePath(email)
  const meta = readMeta(profilePath)
  if (!meta) return

  meta.clientId = client.id
  meta.clientSecret = client.secret
  meta.updatedAt = Date.now()
  writeFileSync(join(profilePath, META_FILE), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  })
}

export function loadProfileSnapshots(email: string): AuthFileSnapshot[] {
  const profilePath = getProfilePath(email)
  const filesDir = join(profilePath, FILES_DIR)
  if (!existsSync(filesDir)) return []

  const snapshots: AuthFileSnapshot[] = []
  const meta = readMeta(profilePath)

  for (const entry of readdirSync(filesDir)) {
    const relPath = decodeRelPath(entry)
    const content = readFileSync(join(filesDir, entry), "utf-8")
    snapshots.push({
      relPath,
      content,
      email: meta?.files?.[relPath]?.email ?? null,
    })
  }

  return snapshots
}

export function updateProfileFile(
  email: string,
  relPath: string,
  content: string
): void {
  const profilePath = getProfilePath(email)
  const filesDir = join(profilePath, FILES_DIR)
  if (!existsSync(filesDir)) return

  const filePath = join(filesDir, encodeRelPath(relPath))
  if (!existsSync(filePath)) return

  writeFileSync(filePath, content, { mode: 0o600 })
}

export function removeProfile(email: string): boolean {
  const profilePath = getProfilePath(email)
  if (!existsSync(profilePath)) return false

  try {
    rmSync(profilePath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export function backupProfileTo(profile: Profile, destDir: string): void {
  cpSync(profile.path, join(destDir, sanitizeEmail(profile.email)), {
    recursive: true,
  })
}
