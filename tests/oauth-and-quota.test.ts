import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  OAuthError,
  clearOAuthClientCache,
  computeQuotaPercentage,
  extractClientsFromBinary,
  fetchQuota,
  generatePkcePair,
  refreshAccessTokenAnyClient,
  resolveFamilyQuota,
  startCallbackServer,
  startOAuthFlow,
  validateBrowserUrl,
  verifyOAuthState,
} from "../dist/index.js"

describe("OAuth PKCE, loopback server, binary discovery, and quota API", () => {
  let tempDir = ""
  const savedEnv: Record<string, string | undefined> = {}
  const activeServers: http.Server[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agk-net-test-"))
    for (const key of [
      "AGK_OAUTH_TOKEN_URL",
      "AGK_USERINFO_URL",
      "AGK_CLOUD_CODE_URL",
      "AGK_NO_BROWSER",
    ] as const) {
      savedEnv[key] = process.env[key]
    }
    process.env["AGK_NO_BROWSER"] = "1"
    clearOAuthClientCache()
  })

  afterEach(async () => {
    for (const srv of activeServers.splice(0)) {
      srv.closeAllConnections?.()
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = val
    }
    clearOAuthClientCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function startMockServer(
    handler: http.RequestListener
  ): Promise<{ url: string; server: http.Server }> {
    const server = http.createServer(handler)
    activeServers.push(server)
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        if (!addr || typeof addr === "string") {
          reject(new Error("no port"))
          return
        }
        resolve(addr.port)
      })
    })
    return { url: `http://127.0.0.1:${port}`, server }
  }

  it("generates valid RFC 7636 S256 PKCE pairs and constant-time state checks", () => {
    const pkce = generatePkcePair()
    assert.equal(pkce.method, "S256")
    const expectedChallenge = createHash("sha256")
      .update(pkce.verifier)
      .digest("base64url")
    assert.equal(pkce.challenge, expectedChallenge)

    assert.equal(verifyOAuthState("abc123state", "abc123state"), true)
    assert.equal(verifyOAuthState("abc123state", "wrongstate!"), false)
    assert.equal(verifyOAuthState("abc123state", null), false)

    assert.throws(() => validateBrowserUrl("file:///etc/passwd"))
    assert.throws(() => validateBrowserUrl("https://user:pass@example.com"))
    assert.throws(() => validateBrowserUrl("https://example.com/\r\n"))
    assert.equal(
      validateBrowserUrl('https://example.com/"quote'),
      "https://example.com/%22quote"
    )
    assert.equal(
      validateBrowserUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1"),
      "https://accounts.google.com/o/oauth2/v2/auth?x=1"
    )
  })

  it("continues past wrong-client invalid_grant and succeeds on matching OAuth client", async () => {
    let transientCalls = 0
    const { url } = await startMockServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(Buffer.from(c))
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf-8"))

      const clientId = form.get("client_id")
      if (clientId === "111111-wrongclientid.apps.googleusercontent.com") {
        // Google returns 400 invalid_grant when token belongs to another OAuth client!
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Bad Request",
          })
        )
        return
      }

      if (clientId === "222222-rightclientid.apps.googleusercontent.com") {
        transientCalls++
        if (transientCalls === 1) {
          res.writeHead(503, {
            "Content-Type": "text/plain",
            "Retry-After": "0",
          })
          res.end("Service Unavailable")
          return
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            access_token: "ya29." + "fresh_access",
            refresh_token: "1//" + "rotated_refresh",
            expires_in: 3600,
          })
        )
        return
      }

      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "invalid_client" }))
    })

    process.env["AGK_OAUTH_TOKEN_URL"] = `${url}/token`

    const refreshed = await refreshAccessTokenAnyClient(
      "1//" + "my_valid_token",
      [
        {
          id: "111111-wrongclientid.apps.googleusercontent.com",
          secret: "GOCSPX-" + "wrongsecret1234567890abcdefg",
          label: "wrong",
        },
        {
          id: "222222-rightclientid.apps.googleusercontent.com",
          secret: "GOCSPX-" + "rightsecret1234567890abcdefg",
          label: "right",
        },
      ]
    )

    assert.equal(refreshed.client.label, "right")
    assert.equal(refreshed.tokens.access_token, "ya29." + "fresh_access")
    assert.equal(refreshed.tokens.refresh_token, "1//" + "rotated_refresh")

    // When ALL clients return invalid_grant, throws OAuthError with kind === "invalid_grant"
    await assert.rejects(
      () =>
        refreshAccessTokenAnyClient("1//" + "dead_token", [
          {
            id: "111111-wrongclientid.apps.googleusercontent.com",
            secret: "GOCSPX-" + "wrongsecret1234567890abcdefg",
            label: "only",
          },
        ]),
      (err: unknown) =>
        err instanceof OAuthError && err.kind === "invalid_grant"
    )
  })

  it("enforces CSRF state, answers 404 on /favicon.ico, and completes PKCE OAuth flow", async () => {
    const callback = await startCallbackServer({
      expectedState: "expected-csrf-token",
      timeoutMs: 10_000,
    })

    try {
      // 1. /favicon.ico returns 404 immediately without hanging
      const favRes = await fetch(
        `http://127.0.0.1:${callback.port}/favicon.ico`
      )
      assert.equal(favRes.status, 404)

      // 2. Forged request with wrong state returns 400 and does NOT kill the active login
      const badStateRes = await fetch(
        `${callback.redirectUri}?code=attacker_code&state=wrong-state`
      )
      assert.equal(badStateRes.status, 400)

      // 3. Legitimate redirect resolves waitForCode
      const okRes = await fetch(
        `${callback.redirectUri}?code=valid_auth_code_123&state=expected-csrf-token`
      )
      assert.equal(okRes.status, 200)
      assert.equal(await callback.waitForCode(), "valid_auth_code_123")
    } finally {
      await callback.close()
    }

    // Full startOAuthFlow with PKCE verifier verification on mock Google backend
    let capturedVerifier: string | null = null
    let expectedChallenge: string | null = null

    const mockGoogle = await startMockServer(async (req, res) => {
      if (req.url === "/token") {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        const params = new URLSearchParams(
          Buffer.concat(chunks).toString("utf-8")
        )
        capturedVerifier = params.get("code_verifier")
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            access_token: "ya29." + "oauth_access",
            refresh_token: "1//" + "oauth_refresh",
            expires_in: 3600,
          })
        )
        return
      }
      if (req.url === "/userinfo") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({ email: "OAuthUser@Gmail.com", name: "OAuth User" })
        )
        return
      }
      if (req.url === "/v1internal:loadCodeAssist") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            cloudaicompanionProject: "proj-123",
            paidTier: { id: "g1-pro-tier" },
          })
        )
        return
      }
      if (req.url === "/v1internal:fetchAvailableModels") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            models: {
              "models/gemini-3-pro-high": {
                quotaInfo: {
                  remainingFraction: 0.82,
                  resetTime: "2026-11-19T00:00:00Z",
                },
              },
            },
          })
        )
        return
      }
      res.writeHead(404).end()
    })

    process.env["AGK_OAUTH_TOKEN_URL"] = `${mockGoogle.url}/token`
    process.env["AGK_USERINFO_URL"] = `${mockGoogle.url}/userinfo`
    process.env["AGK_CLOUD_CODE_URL"] = mockGoogle.url

    const flowResult = await startOAuthFlow(
      {
        id: "333333-flowclientid.apps.googleusercontent.com",
        secret: "GOCSPX-" + "flowsecret1234567890abcdefghi",
        label: "test",
      },
      {
        openBrowser: false,
        onAuthUrl: (authUrl) => {
          const parsed = new URL(authUrl)
          const redirect = parsed.searchParams.get("redirect_uri") ?? ""
          const state = parsed.searchParams.get("state") ?? ""
          expectedChallenge = parsed.searchParams.get("code_challenge")
          void fetch(
            `${redirect}?code=browser_code_xyz&state=${encodeURIComponent(state)}`
          )
        },
      }
    )

    assert.equal(flowResult.userInfo.email, "oauthuser@gmail.com")
    assert.equal(flowResult.quota.subscriptionTier, "g1-pro-tier")
    assert.equal(flowResult.quota.models.length, 1)
    assert.equal(flowResult.quota.models[0]?.percentage, 82)
    assert.ok(capturedVerifier)
    assert.equal(
      createHash("sha256")
        .update(capturedVerifier ?? "")
        .digest("base64url"),
      expectedChallenge
    )
  })

  it("slices Go .rodata 35-byte GOCSPX- secrets and pairs credentials by proximity", () => {
    const fakeBin = join(tempDir, "fake-agy-bin")
    const distantPublicId =
      "10000001-distantpublicid.apps.googleusercontent.com"
    const realId = "99887766-realagyclientid.apps.googleusercontent.com"
    const realSecret35 = "GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12" // exact 35 chars
    const goRodataAdjacent = `${realSecret35}NextGoStringInRodataWithoutNull`

    const payload = Buffer.concat([
      Buffer.from(`padding_${distantPublicId}_`),
      Buffer.alloc(16_384, 0x20),
      Buffer.from(`cfg={id:"${realId}",sec:"${goRodataAdjacent}"}`),
    ])
    writeFileSync(fakeBin, payload)

    const extracted = extractClientsFromBinary(fakeBin)
    assert.ok(extracted.length >= 2)
    assert.equal(extracted[0]?.id, realId)
    assert.equal(extracted[0]?.secret, realSecret35)
    assert.equal(extracted[0]?.secret.length, 35)
  })

  it("handles Proto3 empty models, percentage clamping, 403, and flagship family ranking", async () => {
    assert.equal(
      computeQuotaPercentage({ isExhausted: true, remainingFraction: 0.9 }),
      0
    )
    assert.equal(
      computeQuotaPercentage({ resetTime: "2026-11-18T12:00:00Z" }),
      0
    )
    assert.equal(computeQuotaPercentage({}), 100)
    assert.equal(computeQuotaPercentage({ remainingFraction: 1.35 }), 100)
    assert.equal(computeQuotaPercentage({ remainingFraction: -0.2 }), 0)

    let mode: "empty" | "forbidden" = "empty"
    const mockQuota = await startMockServer((_req, res) => {
      if (mode === "forbidden") {
        res.writeHead(403, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Forbidden" }))
        return
      }
      // Proto3 empty map serializes as "{}" with models omitted
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    process.env["AGK_CLOUD_CODE_URL"] = mockQuota.url

    const emptyRes = await fetchQuota("ya29." + "tok")
    assert.deepEqual(emptyRes.models, [])
    assert.equal(emptyRes.isForbidden, undefined)

    mode = "forbidden"
    const forbiddenRes = await fetchQuota("ya29." + "tok")
    assert.equal(forbiddenRes.isForbidden, true)

    const sampleModels = [
      { name: "gemini-3-flash", percentage: 99, resetTime: "" },
      { name: "gemini-4-pro-high", percentage: 64, resetTime: "" },
      { name: "claude-sonnet-4-5", percentage: 45, resetTime: "" },
    ]
    assert.equal(
      resolveFamilyQuota(sampleModels, "gemini")?.name,
      "gemini-4-pro-high"
    )
    assert.equal(
      resolveFamilyQuota(sampleModels, "claude")?.name,
      "claude-sonnet-4-5"
    )
  })
})
