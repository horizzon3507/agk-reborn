import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs"
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path"
import type { OAuthClient } from "./oauth.js"
import { isPlainObject, parseJsonObject } from "./redact.js"

export const MAX_SCAN_FILE_BYTES = 1024 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024
const OVERLAP_BYTES = 256
const MAX_WRAPPER_BYTES = 65_536
const MAX_WRAPPER_DEPTH = 3

const CLIENT_ID_SCAN_RE =
  /\d{6,30}-[a-z0-9]{8,80}\.apps\.googleusercontent\.com/g
const CLIENT_SECRET_SCAN_RE = /GOCSPX-(?:(?!GOCSPX-)[A-Za-z0-9_-]){10,64}/g

const CLIENT_ID_TEST = /^\d{6,30}-[a-z0-9]{8,80}\.apps\.googleusercontent\.com$/
const CLIENT_SECRET_TEST = /^GOCSPX-[A-Za-z0-9_-]{10,64}$/
const GOOGLE_GOCSPX_STANDARD_LENGTH = 35

const BINARY_NAMES = [
  "agy",
  "antigravity-cli",
  "antigravity",
  "gemini",
] as const

const DEFAULT_WIN_PATHEXT = [
  ".exe",
  ".cmd",
  ".bat",
  ".ps1",
  ".cjs",
  ".mjs",
  ".js",
] as const

export interface ClientCandidateOptions {
  stored?: { clientId: string; clientSecret: string } | null | undefined
  authFileContents?: readonly string[] | undefined
}

interface OffsetHit {
  value: string
  offset: number
  isFallbackSlice?: boolean | undefined
}

interface BinaryCacheEntry {
  mtimeMs: number
  size: number
  pairs: Array<{ id: string; secret: string }>
}

const binaryCache = new Map<string, BinaryCacheEntry>()
let discoveryCache: { key: string; clients: OAuthClient[] } | null = null

export function clearOAuthClientCache(): void {
  binaryCache.clear()
  discoveryCache = null
}

function getSearchPathEnv(): string {
  if (process.env["AGK_OAUTH_SEARCH_PATH"] !== undefined) {
    return process.env["AGK_OAUTH_SEARCH_PATH"]
  }
  return process.env["PATH"] ?? process.env["Path"] ?? ""
}

function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return resolve(filePath)
  }
}

function normalizePathKey(filePath: string): string {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath
}

function isRegularScannableFile(filePath: string): boolean {
  try {
    const st = statSync(filePath)
    return st.isFile() && st.size > 0 && st.size <= MAX_SCAN_FILE_BYTES
  } catch {
    return false
  }
}

function getPathExtensions(): string[] {
  if (process.platform !== "win32") return [""]
  const raw = process.env["PATHEXT"] ?? process.env["Pathext"]
  if (!raw) return ["", ...DEFAULT_WIN_PATHEXT]

  const seen = new Set<string>([""])
  const exts = [""]
  for (const item of raw.split(";")) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const dotted = (
      trimmed.startsWith(".") ? trimmed : `.${trimmed}`
    ).toLowerCase()
    if (!seen.has(dotted)) {
      seen.add(dotted)
      exts.push(dotted)
    }
  }
  return exts
}

function binaryCandidates(): string[] {
  const pathEnv = getSearchPathEnv()
  if (!pathEnv) return []

  const dirs = pathEnv
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"+|"+$/g, ""))
    .filter((dir) => dir.length > 0 && isAbsolute(dir))

  const exts = getPathExtensions()
  const seen = new Set<string>()
  const candidates: string[] = []

  for (const name of BINARY_NAMES) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const fileName =
          ext && !name.toLowerCase().endsWith(ext) ? `${name}${ext}` : name
        const candidate = join(dir, fileName)
        if (!isRegularScannableFile(candidate)) continue

        const resolved = resolveRealPath(candidate)
        const key = normalizePathKey(resolved)
        if (seen.has(key)) continue
        seen.add(key)
        candidates.push(resolved)
      }
    }
  }

  return candidates
}

function isJsFile(filePath: string): boolean {
  return /\.(c?js|mjs)$/i.test(filePath)
}

function readSmallTextHead(filePath: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size === 0 || st.size > MAX_WRAPPER_BYTES) {
      return null
    }
    const buf = Buffer.allocUnsafe(st.size)
    const bytesRead = readSync(fd, buf, 0, st.size, 0)
    const slice = buf.subarray(0, bytesRead)
    if (slice.subarray(0, Math.min(4096, bytesRead)).includes(0)) {
      return null
    }
    return slice.toString("utf-8")
  } catch {
    return null
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

function extractReferencedPathsFromWrapper(
  text: string,
  wrapperDir: string
): string[] {
  const results: string[] = []
  const pushResolved = (raw: string): void => {
    const cleaned = raw
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(
        /^(?:\$basedir|%~dp0|%dp0%|\$\{?DIR\}?|\$\{?SCRIPT_DIR\}?)[\\/]?/i,
        ""
      )
    if (!cleaned || cleaned.startsWith("-")) return
    const normalized = cleaned.replace(/\\+/g, "/")
    const candidate = isAbsolute(normalized)
      ? normalized
      : resolve(wrapperDir, normalized)
    if (isRegularScannableFile(candidate)) {
      results.push(resolveRealPath(candidate))
    } else if (!isJsFile(candidate)) {
      for (const ext of [".js", ".mjs", ".cjs"]) {
        if (isRegularScannableFile(`${candidate}${ext}`)) {
          results.push(resolveRealPath(`${candidate}${ext}`))
        }
      }
    }
  }

  for (const match of text.matchAll(/(["'`])([^"'`\r\n]{2,512})\1/g)) {
    if (
      match[2] &&
      (match[2].includes("/") || match[2].includes("\\") || isJsFile(match[2]))
    ) {
      pushResolved(match[2])
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    for (const token of trimmed.split(/\s+/)) {
      if (token.includes("/") || token.includes("\\") || isJsFile(token)) {
        pushResolved(token)
      }
    }
  }

  return results
}

function collectScanTargets(entryPath: string): string[] {
  const targets: string[] = []
  const seen = new Set<string>()
  const bundleDirs = new Set<string>()

  const addTarget = (filePath: string): void => {
    if (!isRegularScannableFile(filePath)) return
    const resolved = resolveRealPath(filePath)
    const key = normalizePathKey(resolved)
    if (seen.has(key)) return
    seen.add(key)
    targets.push(resolved)
  }

  const visit = (filePath: string, depth: number): void => {
    const resolved = resolveRealPath(filePath)
    addTarget(resolved)
    if (depth > MAX_WRAPPER_DEPTH) return

    const dir = dirname(resolved)
    const base = basename(resolved).toLowerCase()

    // Antigravity desktop installations store OAuth credentials inside resources/bin/language_server*
    if (base.startsWith("antigravity")) {
      const resourcesBin = join(dir, "resources", "bin")
      if (existsSync(resourcesBin)) {
        try {
          for (const item of readdirSync(resourcesBin)) {
            if (item.toLowerCase().startsWith("language_server")) {
              addTarget(join(resourcesBin, item))
            }
          }
        } catch {
          // ignore
        }
      }
    }

    if (isJsFile(resolved) && depth > 0) {
      bundleDirs.add(dir)
    } else if (
      isJsFile(resolved) &&
      !/(?:^|[\\/])(?:\.local[\\/]bin|usr[\\/]local[\\/]bin|usr[\\/]bin)$/i.test(
        dir
      )
    ) {
      bundleDirs.add(dir)
    }

    const head = readSmallTextHead(resolved)
    if (!head) return

    if (/^#!\s*\/.*\b(?:node|nodejs|bun|deno)\b/i.test(head)) {
      if (
        !/(?:^|[\\/])(?:\.local[\\/]bin|usr[\\/]local[\\/]bin|usr[\\/]bin)$/i.test(
          dir
        )
      ) {
        bundleDirs.add(dir)
      }
    }

    if (depth < MAX_WRAPPER_DEPTH) {
      for (const ref of extractReferencedPathsFromWrapper(head, dir)) {
        visit(ref, depth + 1)
      }
    }
  }

  visit(entryPath, 0)

  for (const dir of bundleDirs) {
    try {
      const entries = readdirSync(dir).sort()
      for (const entry of entries) {
        if (isJsFile(entry)) {
          addTarget(join(dir, entry))
        }
      }
    } catch {
      // ignore
    }
  }

  return targets
}

function scanFileChunked(filePath: string): {
  ids: OffsetHit[]
  secrets: OffsetHit[]
} {
  const ids: OffsetHit[] = []
  const secrets: OffsetHit[] = []

  let fd: number | null = null
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size <= 0 || st.size > MAX_SCAN_FILE_BYTES) {
      return { ids, secrets }
    }

    const bufSize = Math.min(st.size, CHUNK_BYTES + OVERLAP_BYTES)
    const buffer = Buffer.allocUnsafe(bufSize)
    let filePos = 0
    let carryLen = 0
    let lastIdEnd = -1
    let lastSecretEnd = -1

    while (filePos < st.size) {
      const toRead = Math.min(CHUNK_BYTES, st.size - filePos)
      let readTotal = 0
      while (readTotal < toRead) {
        const n = readSync(
          fd,
          buffer,
          carryLen + readTotal,
          toRead - readTotal,
          filePos + readTotal
        )
        if (n <= 0) break
        readTotal += n
      }
      if (readTotal === 0) break

      const windowLen = carryLen + readTotal
      const windowBaseOffset = filePos - carryLen
      const isLastChunk = filePos + readTotal >= st.size
      const safeStartCutoff = isLastChunk
        ? windowLen
        : Math.max(0, windowLen - OVERLAP_BYTES)

      const windowText = buffer.subarray(0, windowLen).toString("latin1")

      for (const match of windowText.matchAll(CLIENT_ID_SCAN_RE)) {
        const idx = match.index
        const val = match[0]
        if (idx === undefined || !val) continue
        if (idx >= safeStartCutoff) continue
        const absOffset = windowBaseOffset + idx
        if (absOffset < lastIdEnd) continue
        lastIdEnd = absOffset + val.length
        ids.push({ value: val, offset: absOffset })
      }

      for (const match of windowText.matchAll(CLIENT_SECRET_SCAN_RE)) {
        const idx = match.index
        const raw = match[0]
        if (idx === undefined || !raw) continue
        if (idx >= safeStartCutoff) continue
        const absOffset = windowBaseOffset + idx
        if (absOffset < lastSecretEnd) continue
        lastSecretEnd = absOffset + raw.length

        if (raw.length > GOOGLE_GOCSPX_STANDARD_LENGTH) {
          secrets.push({
            value: raw.slice(0, GOOGLE_GOCSPX_STANDARD_LENGTH),
            offset: absOffset,
          })
          secrets.push({
            value: raw,
            offset: absOffset,
            isFallbackSlice: true,
          })
        } else {
          secrets.push({ value: raw, offset: absOffset })
        }
      }

      if (!isLastChunk) {
        const nextCarry = Math.min(OVERLAP_BYTES, windowLen)
        buffer.copy(buffer, 0, windowLen - nextCarry, windowLen)
        carryLen = nextCarry
      }
      filePos += readTotal
    }
  } catch {
    // Unreadable binary target
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }

  return { ids, secrets }
}

export function extractClientsFromBinary(binaryPath: string): OAuthClient[] {
  const resolved = resolveRealPath(binaryPath)
  const cacheKey = normalizePathKey(resolved)

  let rootStat: { mtimeMs: number; size: number } | null = null
  try {
    const st = statSync(resolved)
    if (!st.isFile()) return []
    rootStat = { mtimeMs: st.mtimeMs, size: st.size }
    const cached = binaryCache.get(cacheKey)
    if (
      cached &&
      cached.mtimeMs === rootStat.mtimeMs &&
      cached.size === rootStat.size
    ) {
      return cached.pairs.map((p) => ({
        id: p.id,
        secret: p.secret,
        label: binaryPath,
      }))
    }
  } catch {
    return []
  }

  const targets = collectScanTargets(resolved)
  const allPrimaryIds = new Set<string>()
  const allPrimarySecrets = new Set<string>()
  const allFallbackSecrets = new Set<string>()

  interface ProximityPair {
    id: string
    secret: string
    distance: number
    isFallback: boolean
    fileIdx: number
    offset: number
  }

  const proximityPairs: ProximityPair[] = []

  for (let fileIdx = 0; fileIdx < targets.length; fileIdx++) {
    const target = targets[fileIdx]
    if (!target) continue
    const { ids, secrets } = scanFileChunked(target)
    for (const idHit of ids) allPrimaryIds.add(idHit.value)
    for (const secHit of secrets) {
      if (secHit.isFallbackSlice) {
        allFallbackSecrets.add(secHit.value)
      } else {
        allPrimarySecrets.add(secHit.value)
      }
    }

    if (ids.length === 0 || secrets.length === 0) continue

    for (const idHit of ids) {
      for (const secHit of secrets) {
        const distance = Math.abs(idHit.offset - secHit.offset)
        proximityPairs.push({
          id: idHit.value,
          secret: secHit.value,
          distance,
          isFallback: Boolean(secHit.isFallbackSlice),
          fileIdx,
          offset: Math.min(idHit.offset, secHit.offset),
        })
      }
    }
  }

  if (
    allPrimaryIds.size === 0 ||
    (allPrimarySecrets.size === 0 && allFallbackSecrets.size === 0)
  ) {
    binaryCache.set(cacheKey, { ...rootStat, pairs: [] })
    return []
  }

  proximityPairs.sort((a, b) => {
    if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1
    if (a.distance !== b.distance) return a.distance - b.distance
    if (a.fileIdx !== b.fileIdx) return a.fileIdx - b.fileIdx
    return a.offset - b.offset
  })

  const orderedPairs: Array<{ id: string; secret: string }> = []
  const seenPairs = new Set<string>()
  const pushPair = (id: string, secret: string): void => {
    const key = `${id}:${secret}`
    if (seenPairs.has(key)) return
    seenPairs.add(key)
    orderedPairs.push({ id, secret })
  }

  // Tier 1: greedy 1-to-1 closest primary pairs within the same file
  const matchedIds = new Set<string>()
  const matchedSecrets = new Set<string>()
  for (const pair of proximityPairs) {
    if (pair.isFallback) continue
    if (matchedIds.has(pair.id) || matchedSecrets.has(pair.secret)) continue
    matchedIds.add(pair.id)
    matchedSecrets.add(pair.secret)
    pushPair(pair.id, pair.secret)
  }

  // Tier 2: remaining same-file primary proximity pairs
  for (const pair of proximityPairs) {
    if (!pair.isFallback) pushPair(pair.id, pair.secret)
  }

  // Tier 3: cross-file Cartesian primary pairs
  for (const id of allPrimaryIds) {
    for (const secret of allPrimarySecrets) {
      pushPair(id, secret)
    }
  }

  // Tier 4: fallback unsliced secrets (>35 chars)
  for (const pair of proximityPairs) {
    if (pair.isFallback) pushPair(pair.id, pair.secret)
  }
  for (const id of allPrimaryIds) {
    for (const secret of allFallbackSecrets) {
      pushPair(id, secret)
    }
  }

  binaryCache.set(cacheKey, { ...rootStat, pairs: orderedPairs })
  return orderedPairs.map((p) => ({
    id: p.id,
    secret: p.secret,
    label: binaryPath,
  }))
}

function readValidClientPair(
  obj: Record<string, unknown>,
  label: string
): OAuthClient | null {
  const rawId = obj["client_id"]
  const rawSecret = obj["client_secret"]
  if (typeof rawId !== "string" || typeof rawSecret !== "string") return null
  const id = rawId.trim()
  const secret = rawSecret.trim()
  if (!CLIENT_ID_TEST.test(id) || !CLIENT_SECRET_TEST.test(secret)) return null
  return { id, secret, label }
}

export function extractClientFromAuthFile(content: string): OAuthClient | null {
  const parsed = parseJsonObject(content)
  if (!parsed) return null

  const direct = readValidClientPair(parsed, "auth-file")
  if (direct) return direct

  for (const section of ["token", "installed", "web"] as const) {
    const nested = parsed[section]
    if (isPlainObject(nested)) {
      const found = readValidClientPair(nested, "auth-file")
      if (found) return found
    }
  }

  return null
}

export function discoverOAuthClients(options?: {
  forceRefresh?: boolean | undefined
}): OAuthClient[] {
  const key = `${process.platform}\0${getSearchPathEnv()}\0${process.env["PATHEXT"] ?? ""}`
  if (!options?.forceRefresh && discoveryCache && discoveryCache.key === key) {
    return discoveryCache.clients.map((c) => ({ ...c }))
  }

  const seen = new Set<string>()
  const clients: OAuthClient[] = []

  for (const binaryPath of binaryCandidates()) {
    for (const client of extractClientsFromBinary(binaryPath)) {
      const pairKey = `${client.id}:${client.secret}`
      if (seen.has(pairKey)) continue
      seen.add(pairKey)
      clients.push(client)
    }
  }

  discoveryCache = { key, clients }
  return clients.map((c) => ({ ...c }))
}

export function buildClientCandidates(
  options: ClientCandidateOptions = {}
): OAuthClient[] {
  const clients: OAuthClient[] = []
  const seen = new Set<string>()

  const push = (client: OAuthClient | null): void => {
    if (!client) return
    const key = `${client.id}:${client.secret}`
    if (seen.has(key)) return
    seen.add(key)
    clients.push(client)
  }

  if (options.stored) {
    const id =
      typeof options.stored.clientId === "string"
        ? options.stored.clientId.trim()
        : ""
    const secret =
      typeof options.stored.clientSecret === "string"
        ? options.stored.clientSecret.trim()
        : ""
    if (CLIENT_ID_TEST.test(id) && CLIENT_SECRET_TEST.test(secret)) {
      push({ id, secret, label: "profile" })
    }
  }

  for (const content of options.authFileContents ?? []) {
    push(extractClientFromAuthFile(content))
  }

  for (const client of discoverOAuthClients()) {
    push(client)
  }

  return clients
}
