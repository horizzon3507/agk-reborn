import {
  normalizeEmail,
  parseJsonObject,
  sanitizeTerminalText,
} from "./redact.js"

export const MAX_JWT_LENGTH = 16_384
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const MAX_EPOCH_SECONDS = 8_640_000_000_000

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true })

export interface JwtPayload {
  email?: string | undefined
  name?: string | undefined
  sub?: string | undefined
  exp?: number | undefined
  iat?: number | undefined
}

function decodeBase64UrlUtf8(segment: string): string | null {
  if (
    segment.length === 0 ||
    segment.length % 4 === 1 ||
    !BASE64URL_RE.test(segment)
  ) {
    return null
  }
  try {
    const bytes = Buffer.from(segment, "base64url")
    return fatalUtf8Decoder.decode(bytes)
  } catch {
    return null
  }
}

export function decodeJwtPayload(token: unknown): JwtPayload | null {
  if (typeof token !== "string") return null
  const trimmed = token.trim()
  if (trimmed.length < 5 || trimmed.length > MAX_JWT_LENGTH) return null

  const firstDot = trimmed.indexOf(".")
  if (firstDot <= 0) return null

  const secondDot = trimmed.indexOf(".", firstDot + 1)
  if (secondDot <= firstDot + 1) return null

  if (trimmed.indexOf(".", secondDot + 1) !== -1) return null

  const headerSegment = trimmed.slice(0, firstDot)
  const payloadSegment = trimmed.slice(firstDot + 1, secondDot)

  if (!BASE64URL_RE.test(headerSegment) || headerSegment.length % 4 === 1) {
    return null
  }

  const decoded = decodeBase64UrlUtf8(payloadSegment)
  if (decoded === null) return null

  const raw = parseJsonObject(decoded)
  if (!raw) return null

  const payload: JwtPayload = {}

  if ("email" in raw) {
    const email = normalizeEmail(raw["email"])
    if (email) {
      payload.email = email
    } else if (
      raw["email"] !== undefined &&
      raw["email"] !== null &&
      raw["email"] !== ""
    ) {
      // Explicit invalid email claim (e.g. number, array, or path traversal)
      return null
    }
  }

  if (typeof raw["name"] === "string") {
    const cleanName = sanitizeTerminalText(raw["name"], 120)
    if (cleanName) payload.name = cleanName
  }

  if (typeof raw["sub"] === "string") {
    const cleanSub = sanitizeTerminalText(raw["sub"], 128)
    if (cleanSub) payload.sub = cleanSub
  }

  const exp = raw["exp"]
  if (
    typeof exp === "number" &&
    Number.isFinite(exp) &&
    exp > 0 &&
    exp <= MAX_EPOCH_SECONDS
  ) {
    payload.exp = exp
  }

  const iat = raw["iat"]
  if (
    typeof iat === "number" &&
    Number.isFinite(iat) &&
    iat > 0 &&
    iat <= MAX_EPOCH_SECONDS
  ) {
    payload.iat = iat
  }

  return payload
}

export function getJwtExpiryMs(token: unknown): number | null {
  const payload = decodeJwtPayload(token)
  if (!payload?.exp) return null
  return Math.round(payload.exp * 1000)
}

export function isJwtExpired(token: unknown, skewMs = 30_000): boolean | null {
  const expiryMs = getJwtExpiryMs(token)
  if (expiryMs === null) return null
  return Date.now() + skewMs >= expiryMs
}
