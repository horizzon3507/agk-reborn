import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import {
  KEYRING_REL,
  clearKeyringSecret,
  collectProtectedPids,
  filterAgyProcessRows,
  isAgyArgv,
  isValidKeyringSecret,
  keyringAvailable,
  parsePsTable,
  readAuthFileState,
  readKeyringSecret,
  resetKeyringCache,
  setKeyringTestBackend,
  writeAuthFileAtomic,
} from "../dist/index.js"

describe("process classification, ancestor PID safety, and keyring backend", () => {
  afterEach(() => {
    setKeyringTestBackend(null)
    resetKeyringCache()
  })

  it("matches genuine agy/antigravity-cli executables while rejecting editors and foreign LSPs", () => {
    // True positives
    assert.equal(isAgyArgv(["agy", "chat"], "agy"), true)
    assert.equal(isAgyArgv(["/home/user/.local/bin/agy"], "agy"), true)
    assert.equal(
      isAgyArgv(
        [
          "node",
          "/usr/local/lib/node_modules/@google/antigravity-cli/dist/cli.js",
        ],
        "node"
      ),
      true
    )
    assert.equal(
      isAgyArgv(
        ["env", "FOO=bar", "/opt/bin/antigravity-cli"],
        "antigravity-cli"
      ),
      true
    )
    assert.equal(
      isAgyArgv(
        [
          "/opt/Antigravity/resources/bin/language_server_linux_x64",
          "--gemini_dir=/home/u/.gemini",
        ],
        "language_server"
      ),
      true
    )

    // True negatives (must NEVER be killed)
    assert.equal(isAgyArgv(["agk", "auth", "switch"], "agk"), false)
    assert.equal(
      isAgyArgv(
        ["node", "/home/u/Projects/agk-reborn/dist/cli.js", "auth", "switch"],
        "node"
      ),
      false
    )
    assert.equal(
      isAgyArgv(["nvim", "/home/u/Projects/antigravity/README.md"], "nvim"),
      false
    )
    assert.equal(isAgyArgv(["grep", "-rn", "antigravity", "."], "grep"), false)
    assert.equal(
      isAgyArgv(
        ["/opt/windsurf/bin/language_server_linux_x64", "--port=42100"],
        "language_server"
      ),
      false
    )
    assert.equal(
      isAgyArgv(
        ["/opt/Antigravity/antigravity", "--type=renderer"],
        "antigravity"
      ),
      false
    )
  })

  it("protects ancestor/child PIDs, filters foreign UIDs, and skips zombies", () => {
    const psSample = [
      "1000   500     1 S agy             /home/u/.local/bin/agy",
      "1000   550   500 S bash            /bin/bash",
      "1000   600   550 R node            node /home/u/agk-reborn/dist/cli.js auth switch",
      "1000   700     1 S agy             /home/u/.local/bin/agy --daemon",
      "1000   701     1 Z agy             [agy] <defunct>",
      "1001   800     1 S agy             /home/other/.local/bin/agy",
    ].join("\n")

    const rows = parsePsTable(psSample)
    assert.equal(rows.length, 6)

    const protectedSet = collectProtectedPids(rows, 600, 550)
    assert.equal(protectedSet.has(550), true)
    assert.equal(protectedSet.has(500), true) // Grandparent agy session protected!
    assert.equal(protectedSet.has(700), false)

    const filtered = filterAgyProcessRows(rows, {
      currentUid: 1000,
      selfPid: 600,
      selfPpid: 550,
    })

    // Only PID 700 is killable; PID 500 is reported in skippedAncestors; PID 701 (zombie) & 800 (UID 1001) ignored
    assert.deepEqual(
      filtered.processes.map((p) => p.pid),
      [700]
    )
    assert.deepEqual(
      filtered.skippedAncestors.map((p) => p.pid),
      [500]
    )
  })

  it("validates keyring JSON payloads and supports pluggable test backend", () => {
    assert.equal(isValidKeyringSecret(""), false)
    assert.equal(isValidKeyringSecret("{}"), false)
    assert.equal(isValidKeyringSecret('{"token": []}'), false)
    assert.equal(
      isValidKeyringSecret(
        JSON.stringify({
          token: { access_token: "ya29."+"ok", refresh_token: "1//"+"ok" },
        })
      ),
      true
    )

    let stored: string | null = null
    setKeyringTestBackend({
      available: () => true,
      read: () => stored,
      write: (val) => {
        stored = val
        return true
      },
      clear: () => {
        stored = null
        return true
      },
    })

    assert.equal(keyringAvailable(), true)
    assert.equal(readAuthFileState(KEYRING_REL).status, "missing")

    const validSecret = JSON.stringify({
      token: { access_token: "ya29."+"kr", refresh_token: "1//"+"kr" },
      id_token_email: "kr@example.com",
    })
    assert.equal(writeAuthFileAtomic(KEYRING_REL, validSecret), true)
    assert.equal(readKeyringSecret(), validSecret)
    assert.equal(readAuthFileState(KEYRING_REL).status, "ok")

    // Corrupt payload rejected on write
    assert.equal(writeAuthFileAtomic(KEYRING_REL, "not-json"), false)
    assert.equal(readKeyringSecret(), validSecret)

    assert.equal(clearKeyringSecret(), true)
    assert.equal(readKeyringSecret(), null)
  })
})
