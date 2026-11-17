interface JwtPayload {
  email?: string
  name?: string
  exp?: number
}

export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null

  const payload = parts[1]
  if (!payload) return null

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    )
    const decoded = Buffer.from(padded, "base64").toString("utf-8")
    return JSON.parse(decoded) as JwtPayload
  } catch {
    return null
  }
}
