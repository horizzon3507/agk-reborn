import { execFileSync } from "node:child_process"

export const KEYRING_SERVICE = "gemini"
export const KEYRING_USERNAME = "antigravity"
export const KEYRING_LABEL = `Password for '${KEYRING_USERNAME}' on '${KEYRING_SERVICE}'`

let cachedAvailable: boolean | null = null

export function keyringAvailable(): boolean {
  if (cachedAvailable !== null) return cachedAvailable

  try {
    execFileSync(
      "secret-tool",
      ["search", "--all", "service", "agk-reborn-probe-nonexistent"],
      { stdio: ["ignore", "ignore", "ignore"] }
    )
    cachedAvailable = true
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

export function readKeyringSecret(): string | null {
  if (!keyringAvailable()) return null

  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", KEYRING_SERVICE, "username", KEYRING_USERNAME],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    )
    const secret = out.trim()
    return secret.length > 0 ? secret : null
  } catch {
    return null
  }
}

export function writeKeyringSecret(secret: string): boolean {
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
      { input: secret, stdio: ["pipe", "ignore", "ignore"] }
    )
    return true
  } catch {
    return false
  }
}

export function clearKeyringSecret(): boolean {
  if (!keyringAvailable()) return false

  try {
    execFileSync("secret-tool", [
      "clear",
      "service",
      KEYRING_SERVICE,
      "username",
      KEYRING_USERNAME,
    ])
    return true
  } catch {
    return false
  }
}
