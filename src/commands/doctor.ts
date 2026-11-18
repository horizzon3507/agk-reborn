import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import { getActiveAccountEmail, setActiveAccount } from "../utils/accounts.js"
import {
  inspectAuthFile,
  readAuthFileState,
  writeAuthFileAtomic,
} from "../utils/auth-files.js"
import { printHeader } from "../utils/branding.js"
import {
  auditPathPermissions,
  cleanStaleTempFiles,
  listStaleTempFiles,
  repairPathPermissions,
} from "../utils/fs-atomic.js"
import {
  discoverOAuthClients,
  extractClientFromAuthFile,
} from "../utils/oauth-clients.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  GOOGLE_ACCOUNTS_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
  OAUTH_CREDS_REL,
  findExecutableInPath,
  formatDisplayPath,
  getAgkDir,
  getGeminiDir,
  getLiveAuthFilePath,
  getProfilesDir,
} from "../utils/paths.js"
import { listAgyProcesses } from "../utils/processes.js"
import { listCorruptProfileDirs, listProfiles } from "../utils/profiles.js"
import { getColors, isInteractiveSession } from "../utils/tui.js"

export type DoctorCheckStatus = "ok" | "warn" | "fail"

export interface DoctorCheckItem {
  id: string
  status: DoctorCheckStatus
  label: string
  repaired?: boolean | undefined
}

function collectTempScanDirs(): string[] {
  const geminiDir = getGeminiDir()
  const agkDir = getAgkDir()
  const profilesDir = getProfilesDir()

  const dirs = new Set<string>([
    geminiDir,
    join(geminiDir, "antigravity-cli"),
    join(geminiDir, "antigravity-acp"),
    agkDir,
    profilesDir,
  ])

  if (existsSync(profilesDir)) {
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const profPath = join(profilesDir, entry.name)
        dirs.add(profPath)
        dirs.add(join(profPath, "files"))
      }
    } catch {
      // ignore
    }
  }

  return [...dirs].filter((dir) => existsSync(dir))
}

function collectSensitivePathsToAudit(): Array<{
  path: string
  kind: "file" | "dir"
}> {
  const items: Array<{ path: string; kind: "file" | "dir" }> = []
  const agkDir = getAgkDir()
  const profilesDir = getProfilesDir()

  if (existsSync(agkDir)) items.push({ path: agkDir, kind: "dir" })
  if (existsSync(profilesDir)) items.push({ path: profilesDir, kind: "dir" })

  if (existsSync(profilesDir)) {
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        const profDir = join(profilesDir, entry.name)
        items.push({ path: profDir, kind: "dir" })
        const metaPath = join(profDir, "meta.json")
        if (existsSync(metaPath)) items.push({ path: metaPath, kind: "file" })
        const filesDir = join(profDir, "files")
        if (existsSync(filesDir)) {
          items.push({ path: filesDir, kind: "dir" })
          for (const f of readdirSync(filesDir)) {
            if (!f.startsWith(".")) {
              items.push({ path: join(filesDir, f), kind: "file" })
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  for (const relPath of [
    AGY_TOKEN_REL,
    OAUTH_CREDS_REL,
    ACP_TOKEN_REL,
    GOOGLE_ACCOUNTS_REL,
  ]) {
    try {
      const abs = getLiveAuthFilePath(relPath)
      const parent = dirname(abs)
      if (parent !== getGeminiDir() && existsSync(parent)) {
        items.push({ path: parent, kind: "dir" })
      }
      if (existsSync(abs)) {
        items.push({ path: abs, kind: "file" })
      }
    } catch {
      // ignore
    }
  }

  return items
}

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose and repair agy CLI auth setup",
  },
  args: {
    fix: {
      type: "boolean",
      description:
        "Repair permissions, stale temp files, and active marker drift",
      alias: "f",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output diagnostic checks as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const shouldFix = Boolean(args.fix)
    const interactive = isInteractiveSession({ json })
    const c = getColors(process.stdout)

    printHeader("agk doctor", { json })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Doctor")}`)
    }

    const checks: DoctorCheckItem[] = []
    const repairsApplied: string[] = []

    const addCheck = (
      id: string,
      status: DoctorCheckStatus,
      label: string,
      repaired?: boolean
    ): void => {
      checks.push({ id, status, label, repaired })
    }

    const searchOverride = process.env["AGK_OAUTH_SEARCH_PATH"]
    const agyBinary = findExecutableInPath(
      ["agy", "antigravity-cli", "antigravity"],
      searchOverride
    )
    addCheck(
      "agy_binary",
      agyBinary ? "ok" : "warn",
      agyBinary
        ? `agy binary: ${agyBinary}`
        : "agy binary not found in PATH (install agy to run the CLI)"
    )

    const geminiDir = getGeminiDir()
    const geminiLabel = formatDisplayPath(geminiDir)
    const geminiExists = existsSync(geminiDir)
    addCheck(
      "gemini_dir",
      geminiExists ? "ok" : "warn",
      geminiExists ? `${geminiLabel} exists` : `${geminiLabel} missing`
    )

    const ownersByPath = new Map<string, string>()
    const readableContents: string[] = []
    let hasPrimaryRefreshToken = false
    let validAgyContent: string | null = null
    let validKeyringContent: string | null = null

    for (const relPath of MANAGED_AUTH_FILES) {
      const state = readAuthFileState(relPath)

      if (state.status === "unavailable") {
        addCheck(
          `file:${relPath}`,
          "ok",
          `${relPath} skipped (OS keyring unavailable in this session)`
        )
        continue
      }

      if (state.status === "missing") {
        addCheck(`file:${relPath}`, "warn", `${relPath} missing`)
        continue
      }

      if (state.status === "unreadable") {
        addCheck(
          `file:${relPath}`,
          "fail",
          `${relPath} unreadable (${state.reason})`
        )
        continue
      }

      const inspection = inspectAuthFile(relPath, state.content)
      if (!inspection.valid) {
        addCheck(
          `file:${relPath}`,
          "fail",
          `${relPath} contains invalid or corrupted JSON`
        )
        continue
      }

      readableContents.push(state.content)
      if (inspection.email) {
        ownersByPath.set(relPath, inspection.email)
      }
      if (inspection.hasRefreshToken) {
        hasPrimaryRefreshToken = true
      }
      if (relPath === AGY_TOKEN_REL) validAgyContent = state.content
      if (relPath === KEYRING_REL) validKeyringContent = state.content

      const emailDetail = inspection.email
        ? ` (${inspection.email})`
        : " (no embedded email)"
      addCheck(`file:${relPath}`, "ok", `${relPath} ok${emailDetail}`)
    }

    if (readableContents.length > 0) {
      addCheck(
        "refresh_token",
        hasPrimaryRefreshToken ? "ok" : "fail",
        hasPrimaryRefreshToken
          ? "refresh token present in live session"
          : "refresh token missing across live auth files"
      )
    }

    const distinctOwners = [...new Set(ownersByPath.values())]
    const activeMarker = getActiveAccountEmail()
    const primaryOwner =
      ownersByPath.get(KEYRING_REL) ??
      ownersByPath.get(AGY_TOKEN_REL) ??
      ownersByPath.get(OAUTH_CREDS_REL) ??
      null

    if (distinctOwners.length > 1) {
      const summary = [...ownersByPath.entries()]
        .map(([p, e]) => `${p}=${e}`)
        .join(", ")
      addCheck(
        "split_brain",
        "fail",
        `split-brain live auth files owned by multiple accounts (${summary})`
      )
    } else if (primaryOwner && activeMarker !== primaryOwner) {
      if (shouldFix) {
        setActiveAccount(primaryOwner)
        repairsApplied.push(
          `Updated google_accounts.json active marker to ${primaryOwner}`
        )
        addCheck(
          "active_marker",
          "ok",
          `google_accounts active repaired to ${primaryOwner}`,
          true
        )
      } else {
        addCheck(
          "active_marker",
          "warn",
          activeMarker
            ? `google_accounts active (${activeMarker}) != token owner (${primaryOwner})`
            : `google_accounts active marker missing for live token (${primaryOwner})`
        )
      }
    } else if (activeMarker) {
      addCheck("active_marker", "ok", `google_accounts active: ${activeMarker}`)
    }

    if (
      shouldFix &&
      distinctOwners.length === 1 &&
      validAgyContent &&
      !validKeyringContent &&
      readAuthFileState(KEYRING_REL).status === "missing"
    ) {
      if (writeAuthFileAtomic(KEYRING_REL, validAgyContent)) {
        repairsApplied.push("Synced live agy token into OS keyring")
      }
    }

    const profiles = listProfiles()
    const corruptDirs = listCorruptProfileDirs()
    if (corruptDirs.length > 0) {
      addCheck(
        "corrupt_profiles",
        "fail",
        `${corruptDirs.length} corrupted profile directory(s) in ${formatDisplayPath(getProfilesDir())}`
      )
    }

    const discoveredClients = discoverOAuthClients()
    const embeddedClients = readableContents
      .map((c) => extractClientFromAuthFile(c))
      .filter((x) => x !== null)
    const profileClients = profiles.filter((prof) =>
      Boolean(prof.clientId && prof.clientSecret)
    )
    const totalClientSources =
      discoveredClients.length + embeddedClients.length + profileClients.length

    addCheck(
      "oauth_clients",
      totalClientSources > 0 ? "ok" : "warn",
      totalClientSources > 0
        ? `OAuth client credentials available (${discoveredClients.length} binary, ${profileClients.length} profile)`
        : "no OAuth client credentials discovered yet"
    )

    addCheck(
      "profiles",
      profiles.length > 0 ? "ok" : "warn",
      profiles.length > 0
        ? `${profiles.length} saved profile(s): ${profiles.map((prof) => prof.email).join(", ")}`
        : "no saved profiles yet (run agk auth add)"
    )

    const agkDir = getAgkDir()
    const agkLabel = formatDisplayPath(agkDir)
    addCheck(
      "agk_dir",
      existsSync(agkDir) ? "ok" : "warn",
      existsSync(agkDir)
        ? `${agkLabel} exists`
        : `${agkLabel} not initialized yet`
    )

    // Audit permissions & symlinks on sensitive credential files and directories
    const auditTargets = collectSensitivePathsToAudit()
    const symlinkViolations: string[] = []
    const openPermPaths: Array<{ path: string; kind: "file" | "dir" }> = []

    for (const target of auditTargets) {
      const audit = auditPathPermissions(target.path, target.kind)
      if (!audit.exists) continue
      if (audit.isSymlink) {
        symlinkViolations.push(formatDisplayPath(target.path))
      } else if (audit.tooOpen) {
        openPermPaths.push(target)
      }
    }

    if (symlinkViolations.length > 0) {
      addCheck(
        "symlinks",
        "fail",
        `unsafe symlink(s) in credential store: ${symlinkViolations.join(", ")}`
      )
    }

    if (openPermPaths.length > 0) {
      if (shouldFix) {
        let fixedCount = 0
        for (const item of openPermPaths) {
          if (repairPathPermissions(item.path, item.kind)) {
            fixedCount++
          }
        }
        repairsApplied.push(
          `Tightened permissions on ${fixedCount} credential path(s)`
        )
        const remaining = openPermPaths.length - fixedCount
        addCheck(
          "permissions",
          remaining === 0 ? "ok" : "fail",
          remaining === 0
            ? `repaired permissions on ${fixedCount} path(s) to 0600/0700`
            : `${remaining} path(s) still have overly permissive modes`,
          remaining === 0
        )
      } else {
        addCheck(
          "permissions",
          "warn",
          `${openPermPaths.length} credential path(s) have group/world permissions (run agk doctor --fix)`
        )
      }
    } else if (auditTargets.length > 0) {
      addCheck(
        "permissions",
        "ok",
        "credential file and directory permissions ok"
      )
    }

    // Stale atomic temp files check
    const tempScanDirs = collectTempScanDirs()
    const staleTemps = listStaleTempFiles(tempScanDirs, 0)
    if (staleTemps.length > 0) {
      if (shouldFix) {
        const cleaned = cleanStaleTempFiles(tempScanDirs, 0)
        repairsApplied.push(`Removed ${cleaned.length} stale temp file(s)`)
        addCheck(
          "stale_temps",
          "ok",
          `removed ${cleaned.length} stale .agk-tmp-* file(s)`,
          true
        )
      } else {
        addCheck(
          "stale_temps",
          "warn",
          `${staleTemps.length} stale .agk-tmp-* file(s) found (run agk doctor --fix)`
        )
      }
    }

    const running = await listAgyProcesses()
    const pidSummary = running.map((proc) => proc.pid).join(", ")
    addCheck(
      "processes",
      running.length === 0 ? "ok" : "warn",
      running.length === 0
        ? "no external agy processes running"
        : `${running.length} agy process(es) running (PID ${pidSummary})`
    )

    const failures = checks.filter((item) => item.status === "fail").length
    const warnings = checks.filter((item) => item.status === "warn").length
    if (failures > 0) {
      process.exitCode = 1
    }

    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: failures === 0,
            failures,
            warnings,
            repairs: repairsApplied,
            checks,
          },
          null,
          2
        )
      )
      return
    }

    console.log()
    for (const item of checks) {
      const icon =
        item.status === "ok"
          ? c.green("✔")
          : item.status === "warn"
            ? c.yellow("⚠")
            : c.red("✗")
      console.log(`  ${icon} ${item.label}`)
    }
    console.log()

    const summaryText =
      failures === 0
        ? `${c.green("✔")} Looks healthy${repairsApplied.length > 0 ? ` (${repairsApplied.length} repair(s) applied)` : ""}`
        : `${c.red("✗")} ${failures} problem(s) found`

    if (interactive) {
      p.outro(summaryText)
    } else {
      console.log(summaryText)
    }
  },
})
