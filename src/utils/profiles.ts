import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { AuthFileSnapshot } from "./auth-files.js"
import { getProfilesDir } from "./paths.js"

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

interface ProfileMetaFile {
  email: string
  name?: string
  clientId?: string
  clientSecret?: string
  createdAt: number
  updatedAt: number
  files?: Record<string, ProfileFileMeta>
}

const META_FILE = "meta.json"
const FILES_DIR = "files"

export function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9@._-]/g, "_")
}

export function getProfilePath(email: string): string {
  return join(getProfilesDir(), sanitizeEmail(email))
}

function encodeRelPath(relPath: string): string {
  return relPath.replace(/\//g, "__")
}

function decodeRelPath(encoded: string): string {
  return encoded.replace(/__/g, "/")
}

function readMeta(profilePath: string): ProfileMetaFile | null {
  const metaPath = join(profilePath, META_FILE)
  if (!existsSync(metaPath)) return null

  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ProfileMetaFile
  } catch {
    return null
  }
}

export function listProfiles(): Profile[] {
  const profilesDir = getProfilesDir()
  if (!existsSync(profilesDir)) return []

  const profiles: Profile[] = []

  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const profilePath = join(profilesDir, entry.name)
    const meta = readMeta(profilePath)
    if (!meta) continue

    profiles.push({
      email: meta.email,
      name: meta.name ?? null,
      clientId: meta.clientId ?? null,
      clientSecret: meta.clientSecret ?? null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      path: profilePath,
      files: meta.files ?? {},
    })
  }

  return profiles.sort((a, b) => a.email.localeCompare(b.email))
}

export function getProfile(email: string): Profile | null {
  return listProfiles().find((profile) => profile.email === email) ?? null
}

export function saveProfile(
  email: string,
  snapshots: AuthFileSnapshot[],
  options?: {
    name?: string | undefined
    clientId?: string | undefined
    clientSecret?: string | undefined
  }
): Profile {
  const profilePath = getProfilePath(email)
  const filesDir = join(profilePath, FILES_DIR)
  mkdirSync(filesDir, { recursive: true, mode: 0o700 })

  const existing = readMeta(profilePath)
  const now = Date.now()
  const files: Record<string, ProfileFileMeta> = { ...(existing?.files ?? {}) }

  for (const snapshot of snapshots) {
    writeFileSync(
      join(filesDir, encodeRelPath(snapshot.relPath)),
      snapshot.content,
      { mode: 0o600 }
    )
    files[snapshot.relPath] = {
      email: snapshot.email,
      savedAt: now,
    }
  }

  const resolvedName = options?.name ?? existing?.name
  const resolvedClientId = options?.clientId ?? existing?.clientId
  const resolvedClientSecret = options?.clientSecret ?? existing?.clientSecret
  const meta: ProfileMetaFile = {
    email,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    files,
  }
  if (resolvedName) meta.name = resolvedName
  if (resolvedClientId) meta.clientId = resolvedClientId
  if (resolvedClientSecret) meta.clientSecret = resolvedClientSecret

  writeFileSync(join(profilePath, META_FILE), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  })

  return {
    email,
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
