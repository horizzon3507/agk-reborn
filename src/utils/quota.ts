import {
  type ApiRequestOptions,
  USER_AGENT,
  fetchWithRetry,
  getUserInfo,
} from "./google-api.js"
import { decodeJwtPayload } from "./jwt.js"
import {
  type OAuthClient,
  type TokenResponse,
  refreshAccessTokenAnyClient,
} from "./oauth.js"
import {
  formatHttpErrorDetail,
  isPlainObject,
  parseJsonObject,
  readBoundedResponseText,
  sanitizeTerminalText,
} from "./redact.js"

export { USER_AGENT }

export const CLOUD_CODE_BASE_URL = "https://cloudcode-pa.googleapis.com"
export const QUOTA_API_URL = `${CLOUD_CODE_BASE_URL}/v1internal:fetchAvailableModels`
export const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_BASE_URL}/v1internal:loadCodeAssist`

export interface ModelQuota {
  name: string
  percentage: number
  resetTime: string
}

export interface QuotaResult {
  projectId?: string | undefined
  subscriptionTier?: string | undefined
  models: ModelQuota[]
  isForbidden?: boolean | undefined
  warnings?: string[] | undefined
}

export interface ProjectAssistInfo {
  projectId?: string | undefined
  subscriptionTier?: string | undefined
  warning?: string | undefined
}

export interface RefreshedQuotaResult extends QuotaResult {
  email?: string | undefined
  client: OAuthClient
  refreshedTokens: TokenResponse
}

export interface QuotaRequestOptions extends ApiRequestOptions {
  includeUserInfo?: boolean | undefined
  includeAllModels?: boolean | undefined
}

function resolveCloudCodeBaseUrl(): string {
  const custom = process.env["AGK_CLOUD_CODE_URL"]?.trim()
  return custom ? custom.replace(/\/+$/, "") : CLOUD_CODE_BASE_URL
}

export function clampQuotaPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function normalizeResetTimestamp(raw: unknown): string {
  if (typeof raw !== "string") return ""
  const trimmed = raw.trim()
  if (!trimmed) return ""
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? trimmed : ""
}

export function computeQuotaPercentage(
  quotaInfo: Record<string, unknown>
): number {
  if (quotaInfo["isExhausted"] === true) return 0

  const rawFraction = quotaInfo["remainingFraction"]
  if (typeof rawFraction === "number" && Number.isFinite(rawFraction)) {
    return clampQuotaPercentage(rawFraction * 100)
  }
  if (typeof rawFraction === "string" && rawFraction.trim().length > 0) {
    const num = Number(rawFraction.trim())
    if (Number.isFinite(num)) return clampQuotaPercentage(num * 100)
  }

  // Proto3 JSON omits 0.0 scalar defaults: an active resetTime without remainingFraction indicates 0%.
  const reset = normalizeResetTimestamp(quotaInfo["resetTime"])
  return reset ? 0 : 100
}

function isSupportedQuotaModel(name: string, includeAll: boolean): boolean {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
  if (!clean) return false
  if (includeAll) return true
  if (
    clean.startsWith("chat_") ||
    clean.startsWith("tab_") ||
    clean.includes("embedding")
  ) {
    return false
  }
  return (
    clean.includes("gemini") ||
    clean.includes("claude") ||
    clean.includes("gemma") ||
    clean.startsWith("gpt") ||
    /^o[134](?:[-_]|$)/.test(clean)
  )
}

function extractTierLabel(rawTier: unknown): string | undefined {
  if (!isPlainObject(rawTier)) return undefined
  for (const key of ["id", "name", "quotaTier"] as const) {
    const val = rawTier[key]
    if (typeof val === "string" && val.trim().length > 0) {
      return sanitizeTerminalText(val, 64)
    }
  }
  return undefined
}

export async function fetchProjectId(
  accessToken: string,
  options?: ApiRequestOptions
): Promise<ProjectAssistInfo> {
  const cleanToken = accessToken.trim()
  if (!cleanToken) return {}

  const url = `${resolveCloudCodeBaseUrl()}/v1internal:loadCodeAssist`

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      },
      options
    )

    const rawBody = await readBoundedResponseText(response, 65_536)
    if (!response.ok) {
      return {
        warning: `loadCodeAssist returned ${formatHttpErrorDetail(response.status, rawBody, 120)}`,
      }
    }

    const parsed = parseJsonObject(rawBody)
    if (!parsed) {
      return { warning: "loadCodeAssist returned malformed JSON" }
    }

    let projectId: string | undefined
    const rawProject = parsed["cloudaicompanionProject"]
    if (typeof rawProject === "string" && rawProject.trim()) {
      projectId = sanitizeTerminalText(rawProject, 128)
    } else if (
      isPlainObject(rawProject) &&
      typeof rawProject["id"] === "string" &&
      rawProject["id"].trim()
    ) {
      projectId = sanitizeTerminalText(rawProject["id"], 128)
    }

    const subscriptionTier =
      extractTierLabel(parsed["paidTier"]) ??
      extractTierLabel(parsed["currentTier"])

    const out: ProjectAssistInfo = {}
    if (projectId) out.projectId = projectId
    if (subscriptionTier) out.subscriptionTier = subscriptionTier
    return out
  } catch (error) {
    if (options?.signal?.aborted) throw error
    return {
      warning:
        error instanceof Error
          ? error.message
          : "loadCodeAssist request failed",
    }
  }
}

export async function fetchQuota(
  accessToken: string,
  projectId?: string,
  options?: QuotaRequestOptions
): Promise<QuotaResult> {
  const cleanToken = accessToken.trim()
  if (!cleanToken) {
    throw new Error("Missing access token for quota request")
  }

  const url = `${resolveCloudCodeBaseUrl()}/v1internal:fetchAvailableModels`
  const payload = projectId?.trim() ? { project: projectId.trim() } : {}

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    },
    options
  )

  if (response.status === 403) {
    await response.body?.cancel().catch(() => {})
    return {
      models: [],
      isForbidden: true,
      warnings: ["Account forbidden by Cloud Code API (HTTP 403)"],
    }
  }

  const rawBody = await readBoundedResponseText(response, 262_144)
  if (!response.ok) {
    throw new Error(
      `Quota API error (${formatHttpErrorDetail(response.status, rawBody)})`
    )
  }

  const parsed = parseJsonObject(rawBody)
  if (!parsed) {
    throw new Error("Quota API returned invalid JSON payload")
  }

  const rawModels = isPlainObject(parsed["models"]) ? parsed["models"] : {}
  const models: ModelQuota[] = []

  for (const [rawName, entry] of Object.entries(rawModels)) {
    if (!isPlainObject(entry)) continue
    if (!isSupportedQuotaModel(rawName, options?.includeAllModels ?? false)) {
      continue
    }
    const quotaInfo = entry["quotaInfo"]
    if (!isPlainObject(quotaInfo)) continue

    const safeName = sanitizeTerminalText(rawName.replace(/^models\//i, ""), 80)
    if (!safeName) continue

    models.push({
      name: safeName,
      percentage: computeQuotaPercentage(quotaInfo),
      resetTime: normalizeResetTimestamp(quotaInfo["resetTime"]),
    })
  }

  const out: QuotaResult = { models }
  if (projectId?.trim()) out.projectId = projectId.trim()
  return out
}

function scoreFamilyModel(
  modelName: string,
  family: "claude" | "gemini"
): number {
  const name = modelName.toLowerCase().replace(/^models\//, "")
  if (!name.includes(family)) return -1

  let score = 100
  const verMatch = /(\d+)(?:[.-](\d+))?/.exec(name)
  if (verMatch?.[1]) {
    const major = Number.parseInt(verMatch[1], 10)
    const minor = verMatch[2] ? Number.parseInt(verMatch[2], 10) : 0
    score += major * 100 + minor * 10
  }

  if (family === "claude") {
    if (name.includes("opus")) score += 60
    else if (name.includes("sonnet")) score += 40
    else if (name.includes("haiku")) score += 10
    if (name.includes("thinking")) score += 5
  } else {
    if (name.includes("ultra") || name.includes("carbon")) score += 70
    else if (name.includes("pro")) score += 50
    else if (name.includes("flash") && !name.includes("lite")) score += 20
    if (name.includes("high")) score += 8
  }

  return score
}

export function resolveFamilyQuota(
  models: readonly ModelQuota[],
  family: "claude" | "gemini"
): ModelQuota | null {
  let best: ModelQuota | null = null
  let bestScore = -1

  for (const model of models) {
    const score = scoreFamilyModel(model.name, family)
    if (score > bestScore) {
      bestScore = score
      best = model
    }
  }

  return best
}

export async function getQuotaWithRefresh(
  refreshToken: string,
  clients: readonly OAuthClient[],
  options?: QuotaRequestOptions
): Promise<RefreshedQuotaResult> {
  const { tokens: refreshedTokens, client } = await refreshAccessTokenAnyClient(
    refreshToken,
    clients,
    options
  )

  const warnings: string[] = []
  let email = refreshedTokens.id_token
    ? decodeJwtPayload(refreshedTokens.id_token)?.email
    : undefined

  if (options?.includeUserInfo && !email) {
    try {
      const info = await getUserInfo(refreshedTokens.access_token, options)
      email = info.email
    } catch (err) {
      warnings.push(
        err instanceof Error ? err.message : "Could not fetch user info"
      )
    }
  }

  const projectAssist = await fetchProjectId(
    refreshedTokens.access_token,
    options
  )
  if (projectAssist.warning) warnings.push(projectAssist.warning)

  const quotaResult = await fetchQuota(
    refreshedTokens.access_token,
    projectAssist.projectId,
    options
  )
  if (quotaResult.warnings) warnings.push(...quotaResult.warnings)

  const out: RefreshedQuotaResult = {
    ...quotaResult,
    client,
    refreshedTokens,
  }
  if (email) out.email = email
  const tier = projectAssist.subscriptionTier ?? quotaResult.subscriptionTier
  if (tier) out.subscriptionTier = tier
  if (warnings.length > 0) out.warnings = warnings

  return out
}
