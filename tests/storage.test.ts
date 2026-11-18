import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  AGY_TOKEN_REL,
  KEYRING_REL,
  MAX_OLD_ACCOUNTS,
  OAUTH_CREDS_REL,
  assertSafeRelPath,
  assertWithinDir,
  auditPathPermissions,
  cleanStaleTempFiles,
  decodeRelPath,
  encodeRelPath,
  getActiveAccountEmail,
  getAgkDir,
  getGeminiDir,
  getLiveAuthFilePath,
  getProfile,
  listCorruptProfileDirs,
  listProfiles,
  loadProfileSnapshots,
  normalizeEmail,
  parseJsonObject,
  readGoogleAccounts,
  readRegularFileSafe,
  redactSecrets,
  removeProfile,
  repairPathPermissions,
  resetKeyringCache,
  sanitizeEmail,
  sanitizeTerminalText,
  saveProfile,
  setActiveAccount,
  withAgkLock,
  withAgkLockSync,
  writeFileAtomicSync,
} from "../dist/index.js"

describe("storage, atomic fs, lock, and profile safety", () => {
  let sandboxRoot = ""
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "agk-storage-test-"))
    for (const key of [
      "AGK_HOME",
      "GEMINI_HOME",
      "AGK_DISABLE_KEYRING",
    ] as const) {
      savedEnv[key] = process.env[key]
    }
    process.env["AGK_HOME"] = join(sandboxRoot, "agk")
    process.env["GEMINI_HOME"] = join(sandboxRoot, "gemini")
    process.env["AGK_DISABLE_KEYRING"] = "1"
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

  it("resolves AGK_HOME and GEMINI_HOME overrides and enforces path containment", () => {
    assert.equal(getAgkDir(), join(sandboxRoot, "agk"))
    assert.equal(getGeminiDir(), join(sandboxRoot, "gemini"))

    assert.equal(
      assertSafeRelPath("antigravity-cli/token"),
      "antigravity-cli/token"
    )
    assert.throws(() => assertSafeRelPath(""))
    assert.throws(() => assertSafeRelPath("../etc/passwd"))
    assert.throws(() => assertSafeRelPath("foo/../../bar"))
    assert.throws(() => assertSafeRelPath("/abs/path"))
    assert.throws(() => assertSafeRelPath("back\\slash"))
    assert.throws(() => assertSafeRelPath("null\0byte"))
    assert.throws(() => getLiveAuthFilePath(KEYRING_REL))
    assert.throws(() => assertWithinDir(sandboxRoot, sandboxRoot))
    assert.throws(() => assertWithinDir(sandboxRoot, join(sandboxRoot, "..")))
  })

  it("writes atomically with strict 0600/0700 modes and rejects symlinks", () => {
    const target = join(getAgkDir(), "nested", "secret.json")
    writeFileAtomicSync(target, '{"ok":true}', {
      mode: 0o600,
      dirMode: 0o700,
      rootBoundary: getAgkDir(),
    })

    const readRes = readRegularFileSafe(target)
    assert.equal(readRes.status, "ok")
    if (readRes.status === "ok") {
      assert.equal(readRes.content, '{"ok":true}')
    }

    if (process.platform !== "win32") {
      assert.equal(statSync(target).mode & 0o777, 0o600)
      assert.equal(statSync(join(getAgkDir(), "nested")).mode & 0o777, 0o700)

      // Loosen permissions manually, then verify atomic write restores 0600
      chmodSync(target, 0o644)
      assert.equal(auditPathPermissions(target, "file").tooOpen, true)
      writeFileAtomicSync(target, '{"ok":2}', {
        mode: 0o600,
        rootBoundary: getAgkDir(),
      })
      assert.equal(statSync(target).mode & 0o777, 0o600)

      // Repair helper
      chmodSync(target, 0o644)
      assert.equal(repairPathPermissions(target, "file"), true)
      assert.equal(statSync(target).mode & 0o777, 0o600)
    }

    // Symlink rejection on read and write
    const outsideFile = join(sandboxRoot, "outside.txt")
    writeFileSync(outsideFile, "do-not-touch")
    const linkPath = join(getAgkDir(), "symlink-target.json")
    symlinkSync(outsideFile, linkPath)

    assert.equal(readRegularFileSafe(linkPath).status, "unreadable")
    assert.throws(() =>
      writeFileAtomicSync(linkPath, "overwrite", { rootBoundary: getAgkDir() })
    )
    assert.equal(readRegularFileSafe(outsideFile).status, "ok")
  })

  it("cleans up stale .agk-tmp-* files from dead PIDs", () => {
    const dir = getAgkDir()
    mkdirSync(dir, { recursive: true })
    const deadTmp = join(dir, ".agk-tmp-meta.json-99999999-1-deadbeef")
    writeFileSync(deadTmp, "partial")

    const removed = cleanStaleTempFiles([dir], 60_000)
    assert.deepEqual(removed, [deadTmp])
    assert.equal(existsSync(deadTmp), false)
  })

  it("Recovers stale dead-PID locks and supports re-entrant locking", async () => {
    mkdirSync(getAgkDir(), { recursive: true })
    const lockFile = join(getAgkDir(), ".lock")
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 99999999,
        nonce: "stale",
        createdAt: Date.now() - 5_000,
        label: "crashed",
      })
    )

    const value = await withAgkLock("outer", async () => {
      return withAgkLockSync("inner", () => 42)
    })
    assert.equal(value, 42)
    assert.equal(existsSync(lockFile), false)
  })

  it("redacts secrets, strips ANSI/OSC escapes, and filters prototype keys", () => {
    const dirty =
      "Bearer " + "ya29." + "secret_access_token_12345 client_secret=" + "GOCSPX-" + "abcdef123456 refresh=" + "1//" + "0gsecret987654321"
    const clean = redactSecrets(dirty)
    assert.ok(!clean.includes("ya29."+"secret"))
    assert.ok(!clean.includes("GOCSPX-"+"abcdef"))
    assert.ok(!clean.includes("1//"+"0gsecret"))

    const oscInjected =
      "\x1b]52;c;SGVsbG8=\x07\x1b[31malice@gmail.com\x1b[0m\nnext"
    assert.equal(sanitizeTerminalText(oscInjected), "alice@gmail.com next")

    assert.equal(
      normalizeEmail("  Alice+Work@Gmail.COM "),
      "alice+work@gmail.com"
    )
    assert.equal(normalizeEmail(".."), null)
    assert.equal(normalizeEmail("bad/../@gmail.com"), null)

    const protoJson = parseJsonObject('{"__proto__":{"polluted":true},"ok":1}')
    assert.deepEqual(protoJson, { ok: 1 })
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined)
  })

  it("handles malformed google_accounts.json inputs without crashing", () => {
    const accountsPath = join(getGeminiDir(), "google_accounts.json")
    mkdirSync(getGeminiDir(), { recursive: true })

    for (const payload of ["null", "[]", "123", '"str"', "{truncated", ""]) {
      writeFileSync(accountsPath, payload)
      assert.deepEqual(readGoogleAccounts(), {})
      assert.equal(getActiveAccountEmail(), null)
    }

    const manyOld = Array.from({ length: 70 }, (_, i) => `user${i}@example.com`)
    writeFileSync(
      accountsPath,
      `\uFEFF${JSON.stringify({ active: "  MAIN@Example.com ", old: manyOld })}`
    )
    assert.equal(getActiveAccountEmail(), "main@example.com")

    setActiveAccount("Next@Example.com")
    const updated = readGoogleAccounts()
    assert.equal(updated.active, "next@example.com")
    assert.equal(updated.old?.[0], "main@example.com")
    assert.equal(updated.old?.length, MAX_OLD_ACCOUNTS)
  })

  it("prevents sanitizeEmail collisions, path traversal, and stale keyring poisoning", () => {
    assert.throws(() => sanitizeEmail(""))
    assert.throws(() => sanitizeEmail("."))
    assert.throws(() => sanitizeEmail(".."))
    assert.equal(removeProfile(".."), false)
    assert.equal(removeProfile(""), false)

    // Gmail '+' aliases must never collide with '_'
    assert.notEqual(
      sanitizeEmail("alice+work@gmail.com"),
      sanitizeEmail("alice_work@gmail.com")
    )

    // Bijective relative path encoding
    for (const rel of [
      AGY_TOKEN_REL,
      OAUTH_CREDS_REL,
      "foo__bar.json",
      "a/_b",
      "a_/b",
    ]) {
      assert.equal(decodeRelPath(encodeRelPath(rel)), rel)
    }
    assert.throws(() => decodeRelPath("..__.ssh__authorized_keys"))

    // Save two distinct alias profiles without overwriting each other
    saveProfile("Alice+Work@gmail.com", [
      {
        relPath: AGY_TOKEN_REL,
        content: JSON.stringify({
          token: { access_token: "a1", refresh_token: "r1" },
        }),
        email: "alice+work@gmail.com",
      },
      {
        relPath: KEYRING_REL,
        content: JSON.stringify({
          token: { access_token: "a1", refresh_token: "stale_r1" },
        }),
        email: "alice+work@gmail.com",
      },
    ])
    saveProfile("alice_work@gmail.com", [
      {
        relPath: AGY_TOKEN_REL,
        content: JSON.stringify({
          token: { access_token: "a2", refresh_token: "r2" },
        }),
        email: "alice_work@gmail.com",
      },
    ])

    assert.equal(listProfiles().length, 2)
    assert.equal(
      getProfile("ALICE+WORK@GMAIL.COM")?.email,
      "alice+work@gmail.com"
    )

    // Re-saving with replaceFiles: true purges stale keyring__antigravity snapshot
    saveProfile(
      "alice+work@gmail.com",
      [
        {
          relPath: AGY_TOKEN_REL,
          content: JSON.stringify({
            token: { access_token: "fresh", refresh_token: "fresh_r" },
          }),
          email: "alice+work@gmail.com",
        },
      ],
      { replaceFiles: true }
    )
    const reloaded = loadProfileSnapshots("alice+work@gmail.com")
    assert.deepEqual(
      reloaded.map((s) => s.relPath),
      [AGY_TOKEN_REL]
    )

    // Corrupt profile directory does not crash listProfiles and is reported
    const badDir = join(getAgkDir(), "profiles", "corrupt@example.com")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, "meta.json"), '{"email": 12345}')
    assert.equal(listProfiles().length, 2)
    assert.equal(listCorruptProfileDirs().length, 1)
  })
})
