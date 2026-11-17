import { existsSync, readFileSync } from "node:fs"
import { writeAuthFileAtomic } from "./auth-files.js"
import { GOOGLE_ACCOUNTS_REL, getGoogleAccountsPath } from "./paths.js"

interface GoogleAccountsFile {
  active?: string
  old?: unknown[]
  [key: string]: unknown
}

export function readGoogleAccounts(): GoogleAccountsFile {
  const path = getGoogleAccountsPath()
  if (!existsSync(path)) return {}

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GoogleAccountsFile
  } catch {
    return {}
  }
}

export function getActiveAccountEmail(): string | null {
  const accounts = readGoogleAccounts()
  return typeof accounts.active === "string" ? accounts.active : null
}

export function setActiveAccount(email: string): void {
  const accounts = readGoogleAccounts()
  const previousActive =
    typeof accounts.active === "string" ? accounts.active : null

  const previousOld = Array.isArray(accounts.old)
    ? accounts.old.filter((entry): entry is string => typeof entry === "string")
    : []

  const old = [previousActive, ...previousOld].filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry !== email
  )

  const deduped = [...new Set(old)]

  writeAuthFileAtomic(
    GOOGLE_ACCOUNTS_REL,
    JSON.stringify({ ...accounts, active: email, old: deduped }, null, 2)
  )
}
