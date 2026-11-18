import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { describe, it } from "node:test"
import * as esmSdk from "../dist/index.js"

const requireCjs = createRequire(import.meta.url)

describe("dual ESM and CJS package exports", () => {
  it("loads both ESM and CommonJS entrypoints with matching public symbols", () => {
    const cjsSdk = requireCjs("../dist/index.cjs") as Record<string, unknown>

    const esmKeys = Object.keys(esmSdk).sort()
    const cjsKeys = Object.keys(cjsSdk).sort()

    assert.deepEqual(cjsKeys, esmKeys)
    assert.equal(typeof esmSdk.decodeJwtPayload, "function")
    assert.equal(typeof cjsSdk["decodeJwtPayload"], "function")
    assert.equal(typeof esmSdk.KEYRING_REL, "string")
    assert.equal(cjsSdk["KEYRING_REL"], esmSdk.KEYRING_REL)
    assert.equal(typeof esmSdk.VERSION, "string")
  })
})
