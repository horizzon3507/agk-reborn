import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  KEYRING_REL,
  OAUTH_CREDS_REL,
  buildAuthFilesForTokens,
  captureSessionToProfiles,
  decodeJwtPayload,
  detectAuthFileEmail,
  detectCurrentSessionEmail,
  extractRefreshToken,
  getJwtExpiryMs,
  inspectAuthFile,
  isJwtExpired,
  loadProfileSnapshots,
  parseAgyTokenFile,
  patchAuthFileTokens,
  resetKeyringCache,
  writeAuthFileAtomic,
} from "../dist/index.js"

function makeFakeJwt(payload: unknown): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.fakesignature`
}

describe("JWT decoding, token builders, and mixed-session capture", () => {
  let sandboxRoot = ""
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "agk-session-test-"))
    for (const key of [
      "AGK_HOME",
      "GEMINI_HOME",
      "AGK_DISABLE_KEYRING",
      "AGK_KEYRING_FILE",
    ] as const) {
      savedEnv[key] = process.env[key]
    }
    process.env["AGK_HOME"] = join(sandboxRoot, "agk")
    process.env["GEMINI_HOME"] = join(sandboxRoot, "gemini")
    process.env["AGK_KEYRING_FILE"] = join(sandboxRoot, "mock-keyring.json")
    Reflect.deleteProperty(process.env, "AGK_DISABLE_KEYRING")
    resetKeyringCache()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = val
    }
    resetKeyringCache()
    rmSync(sandboxRoot, { recursive: true, force: true })
  })

  it("validates JWT structure, base64url encoding, claims, and expiry", () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600
    const token = makeFakeJwt({
      email: "  Dev@Example.com ",
      name: "Dev User",
      exp: expSec,
    })

    const decoded = decodeJwtPayload(token)
    assert.equal(decoded?.email, "dev@example.com")
    assert.equal(decoded?.name, "Dev User")
    assert.equal(getJwtExpiryMs(token), expSec * 1000)
    assert.equal(isJwtExpired(token), false)

    const expiredJwt = makeFakeJwt({
      email: "old@example.com",
      exp: Math.floor(Date.now() / 1000) - 120,
    })
    assert.equal(isJwtExpired(expiredJwt), true)

    // Malformed / adversarial inputs
    assert.equal(decodeJwtPayload(null), null)
    assert.equal(decodeJwtPayload(12345), null)
    assert.equal(decodeJwtPayload("not-a-jwt"), null)
    assert.equal(decodeJwtPayload(".payload.sig"), null)
    assert.equal(decodeJwtPayload("a.b.c.d"), null)
    assert.equal(decodeJwtPayload("x".repeat(20_000)), null)
    assert.equal(
      decodeJwtPayload(
        `eyJhbGciOiJSUzI1NiJ9.${Buffer.from("null").toString("base64url")}.sig`
      ),
      null
    )
    assert.equal(
      decodeJwtPayload(
        `eyJhbGciOiJSUzI1NiJ9.${Buffer.from("[1,2]").toString("base64url")}.sig`
      ),
      null
    )
    assert.equal(decodeJwtPayload(makeFakeJwt({ email: 999 })), null)
    assert.equal(decodeJwtPayload(makeFakeJwt({ email: "../evil" })), null)
  })

  it("rejects malformed auth JSON and prioritizes JWT email over stale id_token_email", () => {
    assert.equal(parseAgyTokenFile("null"), null)
    assert.equal(parseAgyTokenFile('{"token": []}'), null)
    assert.equal(parseAgyTokenFile('{"token": {}}'), null)

    const freshJwt = makeFakeJwt({ email: "real-owner@gmail.com" })
    const mismatched = JSON.stringify({
      token: {
        access_token: "ya29."+"live",
        refresh_token: "1//"+"refresh_real",
        id_token: freshJwt,
      },
      id_token_email: "stale-owner@gmail.com",
    })
    assert.equal(
      detectAuthFileEmail(AGY_TOKEN_REL, mismatched),
      "real-owner@gmail.com"
    )

    // Empty refresh_token must return null rather than ""
    assert.equal(
      extractRefreshToken({
        relPath: AGY_TOKEN_REL,
        content: JSON.stringify({
          token: { access_token: "a", refresh_token: "   " },
        }),
        email: null,
      }),
      null
    )
  })

  it("builds and patches auth files while updating id_token and preserving extra keys", () => {
    const initialJwt = makeFakeJwt({
      email: "alice@gmail.com",
      exp: 1_800_000_000,
    })
    const updatedJwt = makeFakeJwt({
      email: "alice@gmail.com",
      exp: 1_900_000_000,
    })
    const client = {
      id: "123456789-abcdefghijkl.apps.googleusercontent.com",
      secret: "GOCSPX-"+"1234567890abcdefghijklmnopqr",
      label: "test",
    }

    const files = buildAuthFilesForTokens(
      {
        access_token: "ya29."+"initial",
        refresh_token: "1//"+"initial_refresh",
        expires_in: Number.NaN, // must safely default to 3600 without RangeError
        id_token: initialJwt,
      },
      "Alice@Gmail.com",
      client
    )
    assert.equal(files.length, 3)

    const agyOriginal = JSON.stringify({
      ...JSON.parse(files[0]?.content ?? "{}"),
      custom_field: "keep-me",
    })

    const patchedAgy = patchAuthFileTokens(AGY_TOKEN_REL, agyOriginal, {
      access_token: "ya29."+"refreshed",
      refresh_token: "1//"+"rotated_refresh",
      expires_in: 3600,
      id_token: updatedJwt,
    })

    const parsed = JSON.parse(patchedAgy) as {
      custom_field: string
      id_token_email: string
      token: { access_token: string; refresh_token: string; id_token: string }
    }
    assert.equal(parsed.custom_field, "keep-me")
    assert.equal(parsed.id_token_email, "alice@gmail.com")
    assert.equal(parsed.token.access_token, "ya29."+"refreshed")
    assert.equal(parsed.token.refresh_token, "1//"+"rotated_refresh")
    assert.equal(parsed.token.id_token, updatedJwt)

    const inspection = inspectAuthFile(AGY_TOKEN_REL, patchedAgy)
    assert.equal(inspection.valid, true)
    assert.equal(inspection.hasRefreshToken, true)
    assert.equal(inspection.isExpired, false)

    // Array JSON must never drop tokens into Array expandos
    assert.equal(
      patchAuthFileTokens(OAUTH_CREDS_REL, "[1, 2, 3]", {
        access_token: "ya29."+"x",
        refresh_token: "1//"+"x",
      }),
      "[1, 2, 3]"
    )
  })

  it("correlates email-less acp_token.json by refresh_token in mixed multi-account sessions", () => {
    const jwtAlice = makeFakeJwt({ email: "alice@gmail.com" })
    const jwtBob = makeFakeJwt({ email: "bob@gmail.com" })

    // Keyring belongs to Alice, while oauth_creds.json + acp_token.json belong to Bob!
    writeAuthFileAtomic(
      KEYRING_REL,
      JSON.stringify({
        token: {
          access_token: "ya29."+"alice",
          refresh_token: "1//"+"refresh_alice_token",
          id_token: jwtAlice,
        },
      })
    )
    writeAuthFileAtomic(
      AGY_TOKEN_REL,
      JSON.stringify({
        token: {
          access_token: "ya29."+"alice",
          refresh_token: "1//"+"refresh_alice_token",
          id_token: jwtAlice,
        },
      })
    )
    writeAuthFileAtomic(
      OAUTH_CREDS_REL,
      JSON.stringify({
        access_token: "ya29."+"bob",
        refresh_token: "1//"+"refresh_bob_token",
        id_token: jwtBob,
      })
    )
    writeAuthFileAtomic(
      ACP_TOKEN_REL,
      JSON.stringify({
        client_id: "123456789-abcdefghijkl.apps.googleusercontent.com",
        client_secret: "GOCSPX-"+"1234567890abcdefghijklmnopqr",
        refresh_token: "1//"+"refresh_bob_token",
      })
    )

    assert.equal(detectCurrentSessionEmail(), "alice@gmail.com")

    const captured = captureSessionToProfiles()
    assert.equal(captured.length, 2)

    const aliceSnaps = loadProfileSnapshots("alice@gmail.com")
    const bobSnaps = loadProfileSnapshots("bob@gmail.com")

    assert.deepEqual(
      aliceSnaps.map((s) => s.relPath),
      [KEYRING_REL, AGY_TOKEN_REL]
    )
    assert.deepEqual(
      bobSnaps.map((s) => s.relPath),
      [OAUTH_CREDS_REL, ACP_TOKEN_REL]
    )
  })
})
