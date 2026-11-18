import { writeAuthFileAtomic } from "./auth-files.js"
import { MAX_SAFE_FILE_BYTES, readRegularFileSafe } from "./fs-atomic.js"
import { GOOGLE_ACCOUNTS_REL, getGoogleAccountsPath } from "./paths.js"
import {
  isDangerousObjectKey,
  normalizeEmail,
  parseJsonObject,
} from "./redact.js"

export const MAX_OLD_ACCOUNTS = 50

export interface GoogleAccountsFile {
  active?: string | null | undefined
  old?: string[] | undefined
  [key: string]: unknown
}

function normalizeOldAccounts(
  rawOld: unknown,
  excludeEmail: string | null
): string[] {
  if (!Array.isArray(rawOld)) return []

  const seen = new Set<string>()
  const result: string[] = []

  for (const entry of rawOld) {
    const normalized = normalizeEmail(entry)
    if (!normalized) continue
    if (excludeEmail && normalized === excludeEmail) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= MAX_OLD_ACCOUNTS) break
  }

  return result
}

export function readGoogleAccounts(): GoogleAccountsFile {
  const state = readRegularFileSafe(
    getGoogleAccountsPath(),
    MAX_SAFE_FILE_BYTES
  )
  if (state.status !== "ok") return {}

  const parsed = parseJsonObject(state.content)
  if (!parsed) return {}

  const out: GoogleAccountsFile = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (key === "active" || key === "old" || isDangerousObjectKey(key)) continue
    out[key] = val
  }

  if (parsed["active"] === null) {
    out.active = null
  } else {
    const active = normalizeEmail(parsed["active"])
    if (active) out.active = active
  }

  if ("old" in parsed) {
    out.old = normalizeOldAccounts(parsed["old"], out.active ?? null)
  }

  return out
}

export function getActiveAccountEmail(): string | null {
  const accounts = readGoogleAccounts()
  return typeof accounts.active === "string" ? accounts.active : null
}

export function setActiveAccount(email: string): void {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    throw new Error(`Invalid account email: ${String(email)}`)
  }

  const accounts = readGoogleAccounts()
  const previousActive =
    typeof accounts.active === "string" ? accounts.active : null
  const combinedOld = [
    ...(previousActive ? [previousActive] : []),
    ...(accounts.old ?? []),
  ]
  const dedupedOld = normalizeOldAccounts(combinedOld, normalized)

  const extra: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(accounts)) {
    if (key === "active" || key === "old" || isDangerousObjectKey(key)) continue
    extra[key] = val
  }

  writeAuthFileAtomic(
    GOOGLE_ACCOUNTS_REL,
    JSON.stringify(
      {
        ...extra,
        active: normalized,
        old: dedupedOld,
      },
      null,
      2
    )
  )
}
