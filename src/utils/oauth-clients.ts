import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import type { OAuthClient } from "./oauth.js"

const CLIENT_ID_RE = /\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com/g
const CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{10,}/g
const CLIENT_ID_TEST = /^\d{6,}-[a-z0-9]+\.apps\.googleusercontent\.com$/
const CLIENT_SECRET_TEST = /^GOCSPX-[A-Za-z0-9_-]{10,}$/

const BINARY_NAMES = ["agy", "antigravity", "gemini"]

function binaryCandidates(): string[] {
  const pathEnv = process.env["PATH"] ?? ""
  const seen = new Set<string>()
  const paths: string[] = []
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of BINARY_NAMES) {
      const candidate = `${dir}/${name}`
      if (!existsSync(candidate)) continue
      const resolved = resolvePath(candidate)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      paths.push(resolved)
    }
  }
  return paths
}

function resolvePath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return filePath
  }
}

function isScriptFile(filePath: string): boolean {
  return /\.(c?js|mjs)$/.test(filePath)
}

function scanTargetsFor(resolvedPath: string): string[] {
  const targets = [resolvedPath]
  if (!isScriptFile(resolvedPath)) return targets

  try {
    const dir = dirname(resolvedPath)
    for (const entry of readdirSync(dir)) {
      if (isScriptFile(entry)) targets.push(join(dir, entry))
    }
  } catch {
    // keep only the resolved file
  }
  return targets
}

export function extractClientsFromBinary(binaryPath: string): OAuthClient[] {
  const ids = new Set<string>()
  const secrets = new Set<string>()

  for (const target of scanTargetsFor(resolvePath(binaryPath))) {
    let content: Buffer
    try {
      content = readFileSync(target)
    } catch {
      continue
    }

    const text = content.toString("latin1")
    for (const id of text.match(CLIENT_ID_RE) ?? []) ids.add(id)
    for (const secret of text.match(CLIENT_SECRET_RE) ?? []) secrets.add(secret)
  }

  if (ids.size === 0 || secrets.size === 0) return []

  const clients: OAuthClient[] = []
  for (const id of ids) {
    for (const secret of secrets) {
      clients.push({ id, secret, label: binaryPath })
    }
  }
  return clients
}

export function extractClientFromAuthFile(content: string): OAuthClient | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const id = parsed["client_id"]
    const secret = parsed["client_secret"]
    if (typeof id !== "string" || typeof secret !== "string") return null
    if (!CLIENT_ID_TEST.test(id) || !CLIENT_SECRET_TEST.test(secret))
      return null
    return { id, secret, label: "auth-file" }
  } catch {
    return null
  }
}

export function discoverOAuthClients(): OAuthClient[] {
  const seen = new Set<string>()
  const clients: OAuthClient[] = []

  for (const binaryPath of binaryCandidates()) {
    for (const client of extractClientsFromBinary(binaryPath)) {
      const key = `${client.id}:${client.secret}`
      if (seen.has(key)) continue
      seen.add(key)
      clients.push(client)
    }
  }

  return clients
}

export function buildClientCandidates(options: {
  stored?: { clientId: string; clientSecret: string } | null
  authFileContents?: string[]
}): OAuthClient[] {
  const clients: OAuthClient[] = []
  const seen = new Set<string>()

  const push = (client: OAuthClient | null) => {
    if (!client) return
    const key = `${client.id}:${client.secret}`
    if (seen.has(key)) return
    seen.add(key)
    clients.push(client)
  }

  if (options.stored) {
    push({
      id: options.stored.clientId,
      secret: options.stored.clientSecret,
      label: "profile",
    })
  }

  for (const content of options.authFileContents ?? []) {
    push(extractClientFromAuthFile(content))
  }

  for (const client of discoverOAuthClients()) {
    push(client)
  }

  return clients
}
