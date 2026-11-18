export const MAX_EMAIL_LENGTH = 254

const EMAIL_SHAPE_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function isDangerousObjectKey(key: string): boolean {
  return DANGEROUS_OBJECT_KEYS.has(key)
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed =
    raw.charCodeAt(0) === 0xfeff ? raw.slice(1).trim() : raw.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isPlainObject(parsed)) return null
    const clean: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (isDangerousObjectKey(key)) continue
      clean[key] = val
    }
    return clean
  } catch {
    return null
  }
}

export function stripAnsiAndControls(
  input: string,
  allowNewlines = false
): string {
  let out = ""
  const len = input.length
  let i = 0

  while (i < len) {
    const code = input.charCodeAt(i)

    if (code === 0x1b) {
      const next = input.charCodeAt(i + 1)
      if (next === 0x5b) {
        // CSI sequence: ESC [ ... final byte 0x40..0x7e
        i += 2
        while (i < len) {
          const c = input.charCodeAt(i)
          i++
          if (c >= 0x40 && c <= 0x7e) break
        }
        continue
      }
      if (next === 0x5d) {
        // OSC sequence: ESC ] ... BEL (0x07) or ST (ESC \)
        i += 2
        while (i < len) {
          const c = input.charCodeAt(i)
          if (c === 0x07) {
            i++
            break
          }
          if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) {
            i += 2
            break
          }
          i++
        }
        continue
      }
      i += 2
      continue
    }

    if (code === 0x0a && allowNewlines) {
      out += "\n"
      i++
      continue
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " "
      i++
      continue
    }

    out += input[i]
    i++
  }

  return out
}

export function sanitizeTerminalText(input: unknown, maxLength = 240): string {
  const str = typeof input === "string" ? input : String(input ?? "")
  const stripped = stripAnsiAndControls(str, false).replace(/\s+/g, " ").trim()
  if (stripped.length <= maxLength) return stripped
  if (maxLength <= 3) return stripped.slice(0, Math.max(0, maxLength))
  return `${stripped.slice(0, maxLength - 3)}...`
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length < 3 || trimmed.length > MAX_EMAIL_LENGTH) return null
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null
  }
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i)
    if (c <= 0x20 || c >= 0x7f) return null
  }
  if (!EMAIL_SHAPE_RE.test(trimmed)) return null

  const atIndex = trimmed.indexOf("@")
  const local = trimmed.slice(0, atIndex)
  if (!local || local.startsWith(".") || local.endsWith(".")) {
    return null
  }
  return trimmed
}

export function redactSecrets(input: string): string {
  return input
    .replace(/GOCSPX-[A-Za-z0-9_-]{6,}/g, "GOCSPX-[REDACTED]")
    .replace(/1\/\/[A-Za-z0-9_-]{8,}/g, "1//[REDACTED]")
    .replace(/ya29\.[A-Za-z0-9._-]{8,}/g, "ya29.[REDACTED]")
    .replace(
      /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
      "[REDACTED_JWT]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /((?:refresh_token|access_token|client_secret|id_token|code)[=:]\s*"?)([^"&\s'}]+)/gi,
      "$1[REDACTED]"
    )
}

export function sanitizeErrorMessage(error: unknown, maxLength = 240): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected error"
  return sanitizeTerminalText(redactSecrets(raw), maxLength)
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = 32_768
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const fallback = await response.text()
    return fallback.length > maxBytes ? fallback.slice(0, maxBytes) : fallback
  }

  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, total).toString("utf-8")
}

export function formatHttpErrorDetail(
  status: number,
  rawBody: string,
  maxLength = 200
): string {
  const parsed = parseJsonObject(rawBody)
  if (parsed) {
    const errField = parsed["error"]
    const descField = parsed["error_description"]
    if (typeof errField === "string") {
      const suffix =
        typeof descField === "string" && descField.trim().length > 0
          ? ` (${descField.trim()})`
          : ""
      return sanitizeTerminalText(
        redactSecrets(`HTTP ${status}: ${errField}${suffix}`),
        maxLength
      )
    }
    if (isPlainObject(errField) && typeof errField["message"] === "string") {
      const statusText =
        typeof errField["status"] === "string" ? ` ${errField["status"]}` : ""
      return sanitizeTerminalText(
        redactSecrets(`HTTP ${status}${statusText}: ${errField["message"]}`),
        maxLength
      )
    }
  }

  const strippedHtml = rawBody.replace(/<[^>]*>/g, " ")
  const cleaned = sanitizeTerminalText(redactSecrets(strippedHtml), maxLength)
  return cleaned ? `HTTP ${status}: ${cleaned}` : `HTTP ${status}`
}
