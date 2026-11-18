import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

const CLI_PATH = resolve(import.meta.dirname, "../dist/cli.js")

function makeJwt(email: string): string {
  const hdr = Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")
  const exp = Math.floor(Date.now() / 1000) + 3600
  const body = Buffer.from(JSON.stringify({ email, exp })).toString("base64url")
  return `${hdr}.${body}.sig`
}

interface CliRunResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCliSubprocess(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdinText?: string
): Promise<CliRunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf-8")
    child.stderr.setEncoding("utf-8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", rejectPromise)
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr })
    })

    if (stdinText !== undefined) {
      child.stdin.write(stdinText)
    }
    child.stdin.end()
  })
}

describe("end-to-end CLI workflows in isolated sandbox", () => {
  let rootDir = ""
  let mockServer: http.Server | null = null
  let baseEnv: NodeJS.ProcessEnv = {}

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "agk-e2e-"))
    const agkHome = join(rootDir, "agk")
    const geminiHome = join(rootDir, "gemini")
    const keyringFile = join(rootDir, "keyring.json")

    mockServer = http.createServer(async (req, res) => {
      if (req.url === "/token") {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        const params = new URLSearchParams(
          Buffer.concat(chunks).toString("utf-8")
        )
        const rt = params.get("refresh_token") ?? ""

        if (rt === "1//"+"refresh_alice") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              access_token: "ya29."+"access_alice_fresh",
              refresh_token: "1//"+"refresh_alice",
              expires_in: 3600,
              id_token: makeJwt("alice@gmail.com"),
            })
          )
          return
        }
        if (rt === "1//"+"refresh_bob") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              access_token: "ya29."+"access_bob_fresh",
              refresh_token: "1//"+"refresh_bob",
              expires_in: 3600,
              id_token: makeJwt("bob@gmail.com"),
            })
          )
          return
        }
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "invalid_grant" }))
        return
      }

      if (req.url === "/userinfo") {
        const auth = req.headers.authorization ?? ""
        const email = auth.includes("bob") ? "bob@gmail.com" : "alice@gmail.com"
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ email, name: email.split("@")[0] }))
        return
      }

      if (req.url === "/v1internal:loadCodeAssist") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            cloudaicompanionProject: "e2e-proj",
            paidTier: { id: "pro" },
          })
        )
        return
      }

      if (req.url === "/v1internal:fetchAvailableModels") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            models: {
              "models/claude-opus-4-5-thinking": {
                quotaInfo: {
                  remainingFraction: 0.75,
                  resetTime: "2026-11-19T00:00:00Z",
                },
              },
              "models/gemini-4-pro-high": {
                quotaInfo: {
                  remainingFraction: 0.9,
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

    const port = await new Promise<number>((resolvePort, rejectPort) => {
      if (!mockServer) {
        rejectPort(new Error("no server"))
        return
      }
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer?.address()
        if (!addr || typeof addr === "string") {
          rejectPort(new Error("bad addr"))
          return
        }
        resolvePort(addr.port)
      })
    })

    const mockBase = `http://127.0.0.1:${port}`
    baseEnv = {
      ...process.env,
      AGK_HOME: agkHome,
      GEMINI_HOME: geminiHome,
      AGK_KEYRING_FILE: keyringFile,
      AGK_DISABLE_PROCESS_SCAN: "1",
      AGK_OAUTH_SEARCH_PATH: "",
      AGK_OAUTH_TOKEN_URL: `${mockBase}/token`,
      AGK_USERINFO_URL: `${mockBase}/userinfo`,
      AGK_CLOUD_CODE_URL: mockBase,
      NO_COLOR: "1",
    }
  })

  afterEach(async () => {
    if (mockServer) {
      mockServer.closeAllConnections?.()
      await new Promise<void>((r) => mockServer?.close(() => r()))
      mockServer = null
    }
    rmSync(rootDir, { recursive: true, force: true })
  })

  it("handles version, help, non-TTY root fallback, and strict invalid flag rejection", async () => {
    const ver = await runCliSubprocess(["-v"], baseEnv)
    assert.equal(ver.code, 0)
    assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+/)

    const bareNonTty = await runCliSubprocess([], baseEnv)
    assert.equal(bareNonTty.code, 0)
    assert.ok(bareNonTty.stdout.includes("USAGE"))

    const unknownCmd = await runCliSubprocess(["bogus"], baseEnv)
    assert.equal(unknownCmd.code, 1)
    assert.ok(unknownCmd.stderr.includes("Unknown command"))

    const unknownFlag = await runCliSubprocess(
      ["auth", "switch", "alice@gmail.com", "--dry-run"],
      baseEnv
    )
    assert.equal(unknownFlag.code, 1)
    assert.ok(unknownFlag.stderr.includes('Unknown option "--dry-run"'))

    const danglingOpt = await runCliSubprocess(["auth", "quota", "-a"], baseEnv)
    assert.equal(danglingOpt.code, 1)
    assert.ok(danglingOpt.stderr.includes("requires a value"))
  })

  it("executes capture, token import, current, list, quota, switch, refresh, doctor --fix, and remove", async () => {
    const geminiHome = baseEnv["GEMINI_HOME"] ?? ""
    const agkHome = baseEnv["AGK_HOME"] ?? ""

    // Seed live session for alice@gmail.com with embedded OAuth client in acp_token.json
    mkdirSync(join(geminiHome, "antigravity-cli"), { recursive: true })
    mkdirSync(join(geminiHome, "antigravity-acp"), { recursive: true })
    writeFileSync(
      join(geminiHome, "antigravity-cli", "antigravity-oauth-token"),
      JSON.stringify({
        token: {
          access_token: "ya29."+"alice_init",
          refresh_token: "1//"+"refresh_alice",
          id_token: makeJwt("alice@gmail.com"),
        },
        id_token_email: "alice@gmail.com",
      })
    )
    writeFileSync(
      join(geminiHome, "antigravity-acp", "acp_token.json"),
      JSON.stringify({
        client_id: "12345678-e2eclientid.apps.googleusercontent.com",
        client_secret: "GOCSPX-"+"e2eclientsecret1234567890abc",
        refresh_token: "1//"+"refresh_alice",
      })
    )

    // 1. Capture Alice
    const cap = await runCliSubprocess(
      ["auth", "add", "--capture", "--json"],
      baseEnv
    )
    assert.equal(cap.code, 0, cap.stderr)
    const capJson = JSON.parse(cap.stdout) as {
      ok: boolean
      accounts: Array<{ email: string }>
    }
    assert.equal(capJson.ok, true)
    assert.equal(capJson.accounts[0]?.email, "alice@gmail.com")

    // 2. Import Bob via --token-stdin --activate
    const addBob = await runCliSubprocess(
      ["auth", "add", "--token-stdin", "--activate", "--json"],
      baseEnv,
      "  1//refresh_bob \n"
    )
    assert.equal(addBob.code, 0, addBob.stderr)
    const bobJson = JSON.parse(addBob.stdout) as {
      ok: boolean
      email: string
      activated: boolean
    }
    assert.equal(bobJson.ok, true)
    assert.equal(bobJson.email, "bob@gmail.com")
    assert.equal(bobJson.activated, true)

    // 3. Inspect current session
    const cur = await runCliSubprocess(["auth", "current", "--json"], baseEnv)
    assert.equal(cur.code, 0)
    const curJson = JSON.parse(cur.stdout) as {
      account: string
      splitBrain: boolean
    }
    assert.equal(curJson.account, "bob@gmail.com")
    assert.equal(curJson.splitBrain, false)

    // 4. List accounts + quotas in non-TTY JSON mode
    const listRes = await runCliSubprocess(["auth", "list", "--json"], baseEnv)
    assert.equal(listRes.code, 0)
    const listJson = JSON.parse(listRes.stdout) as {
      ok: boolean
      activeAccount: string
      accounts: Array<{ email: string; claude: { percentage: number } | null }>
    }
    assert.equal(listJson.ok, true)
    assert.equal(listJson.activeAccount, "bob@gmail.com")
    assert.equal(listJson.accounts.length, 2)
    assert.equal(listJson.accounts[0]?.claude?.percentage, 75)

    // 5. Quota positional email + --once --json
    const quotaRes = await runCliSubprocess(
      ["auth", "quota", "alice@gmail.com", "--once", "--json"],
      baseEnv
    )
    assert.equal(quotaRes.code, 0)
    const quotaJson = JSON.parse(quotaRes.stdout) as {
      ok: boolean
      models: Array<{ percentage: number }>
    }
    assert.equal(quotaJson.ok, true)
    assert.equal(quotaJson.models.length, 2)

    // 6. Case-insensitive switch back to ALICE@GMAIL.COM
    const sw = await runCliSubprocess(
      ["auth", "switch", "ALICE@GMAIL.COM", "--force", "--json"],
      baseEnv
    )
    assert.equal(sw.code, 0, sw.stderr)
    const swJson = JSON.parse(sw.stdout) as {
      ok: boolean
      email: string
      tokenRefresh: string
    }
    assert.equal(swJson.ok, true)
    assert.equal(swJson.email, "alice@gmail.com")
    assert.equal(swJson.tokenRefresh, "refreshed")

    // 7. Proactive refresh --all --json
    const refAll = await runCliSubprocess(
      ["auth", "refresh", "--all", "--json"],
      baseEnv
    )
    assert.equal(refAll.code, 0, refAll.stderr)
    const refJson = JSON.parse(refAll.stdout) as {
      ok: boolean
      refreshed: number
    }
    assert.equal(refJson.ok, true)
    assert.equal(refJson.refreshed, 2)

    // 8. Doctor --fix repairs loose permissions, stale temp file, and marker drift
    const agyLivePath = join(
      geminiHome,
      "antigravity-cli",
      "antigravity-oauth-token"
    )
    if (process.platform !== "win32") {
      chmodSync(agyLivePath, 0o644)
    }
    const staleTmp = join(agkHome, ".agk-tmp-stale-99999999-1-abcd1234")
    writeFileSync(staleTmp, "leftover")
    writeFileSync(
      join(geminiHome, "google_accounts.json"),
      JSON.stringify({ active: "wrong@gmail.com", old: [] })
    )

    const docFix = await runCliSubprocess(
      ["doctor", "--fix", "--json"],
      baseEnv
    )
    assert.equal(docFix.code, 0, docFix.stderr)
    const docJson = JSON.parse(docFix.stdout) as {
      ok: boolean
      repairs: string[]
    }
    assert.equal(docJson.ok, true)
    assert.ok(docJson.repairs.length >= 2)
    assert.equal(existsSync(staleTmp), false)
    if (process.platform !== "win32") {
      assert.equal(statSync(agyLivePath).mode & 0o777, 0o600)
    }

    // 9. Remove requires --force in non-TTY, then succeeds with --force
    const remNoForce = await runCliSubprocess(
      ["auth", "remove", "bob@gmail.com", "--json"],
      baseEnv
    )
    assert.equal(remNoForce.code, 1)

    const remOk = await runCliSubprocess(
      ["auth", "remove", "BOB@GMAIL.COM", "--force", "--json"],
      baseEnv
    )
    assert.equal(remOk.code, 0)
    const remJson = JSON.parse(remOk.stdout) as {
      ok: boolean
      removed: boolean
      email: string
    }
    assert.equal(remJson.ok, true)
    assert.equal(remJson.removed, true)
    assert.equal(remJson.email, "bob@gmail.com")
  })
})
