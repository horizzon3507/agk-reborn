import { execFile } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { promisify } from "node:util"
import { redactSecrets, sanitizeTerminalText } from "./redact.js"

const execFileAsync = promisify(execFile)

const MAX_PS_BUFFER_BYTES = 16 * 1024 * 1024
const PS_TIMEOUT_MS = 4_000

export interface RawProcessRow {
  uid: number | null
  pid: number
  ppid: number
  isZombie: boolean
  comm: string
  argv: string[]
  command: string
}

export interface RunningProcess {
  pid: number
  command: string
}

export interface AgyProcessScanResult {
  processes: RunningProcess[]
  skippedAncestors: RunningProcess[]
}

const SELF_BIN_NAMES = new Set([
  "agk",
  "agk.js",
  "agk.mjs",
  "agk.cjs",
  "agk-reborn",
  "agk-reborn.js",
  "agk-reborn.mjs",
  "agk-reborn.cjs",
])

const TARGET_CLI_NAMES = new Set([
  "agy",
  "agy.js",
  "agy.mjs",
  "agy.cjs",
  "agy.ts",
  "antigravity-cli",
  "antigravity-cli.js",
  "antigravity-cli.mjs",
  "antigravity-cli.cjs",
  "antigravity-cli.ts",
])

const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno", "tsx"])
const SHELL_WRAPPERS = new Set(["sh", "bash", "dash", "zsh"])

const NODE_SKIP_NEXT_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--title",
])

const NODE_EVAL_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-i",
  "--interactive",
  "-v",
  "--version",
  "-h",
  "--help",
])

function isTruthyEnv(val: string | undefined): boolean {
  if (!val) return false
  const clean = val.trim().toLowerCase()
  return clean === "1" || clean === "true" || clean === "yes"
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === "string" ? code : undefined
  }
  return undefined
}

function getCurrentUid(): number | null {
  if (typeof process.geteuid === "function") return process.geteuid()
  if (typeof process.getuid === "function") return process.getuid()
  return null
}

function executableBaseName(rawToken: string): string {
  const normalized = rawToken.replace(/\\+/g, "/").replace(/\/+$/, "")
  const idx = normalized.lastIndexOf("/")
  const base = idx === -1 ? normalized : normalized.slice(idx + 1)
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")
}

function isSelfToken(rawToken: string): boolean {
  const normalized = rawToken.replace(/\\+/g, "/")
  if (/(?:^|\/)agk-reborn\/(?:dist|src|bin)\//i.test(normalized)) return true
  return SELF_BIN_NAMES.has(executableBaseName(normalized))
}

function isTargetScriptOrBinary(
  rawToken: string,
  allTokens: readonly string[]
): boolean {
  if (isSelfToken(rawToken)) return false
  const normalized = rawToken.replace(/\\+/g, "/")
  const base = executableBaseName(normalized)

  if (TARGET_CLI_NAMES.has(base)) {
    // Ignore Electron helper processes if someone named a wrapper binary agy
    if (allTokens.some((arg) => arg.startsWith("--type="))) return false
    return true
  }

  if (
    /(?:^|\/)(?:@google\/)?antigravity-cli\/(?:dist|bin|src)\/[a-z0-9._-]+\.(?:c|m)?[jt]s$/i.test(
      normalized
    )
  ) {
    return true
  }

  if (/^language_server(?:_[a-z0-9_]+)?$/i.test(base)) {
    if (allTokens.some((arg) => arg.startsWith("--type="))) return false
    const joined = [normalized, ...allTokens].join(" ")
    return /antigravity|\.gemini/i.test(joined)
  }

  return false
}

export function tokenizeCommandString(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let active = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === undefined) continue

    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (
        ch === "\\" &&
        (command[i + 1] === '"' || command[i + 1] === "\\")
      ) {
        current += command[i + 1]
        i++
      } else {
        current += ch
      }
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      active = true
      continue
    }

    if (/\s/.test(ch)) {
      if (active) {
        tokens.push(current)
        current = ""
        active = false
      }
      continue
    }

    if (ch === "\\" && command[i + 1] !== undefined) {
      current += command[i + 1]
      active = true
      i++
      continue
    }

    current += ch
    active = true
  }

  if (active) tokens.push(current)
  return tokens
}

function unwrapEnvTokens(tokens: readonly string[]): string[] {
  let idx = 1
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (!tok) break
    if (tok === "--") {
      idx++
      break
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx++
      continue
    }
    if (
      tok === "-u" ||
      tok === "--unset" ||
      tok === "-C" ||
      tok === "--chdir"
    ) {
      idx += 2
      continue
    }
    if (tok.startsWith("-")) {
      idx++
      continue
    }
    break
  }
  return tokens.slice(idx)
}

function findRuntimeScriptArg(
  runtime: string,
  rest: readonly string[]
): string | null {
  let i = 0
  while (i < rest.length) {
    const tok = rest[i]
    if (!tok) return null
    if (tok === "--") return rest[i + 1] ?? null

    if (runtime === "bun" || runtime === "deno") {
      if (i === 0 && tok === "run") {
        i++
        continue
      }
      if (
        i === 0 &&
        new Set(["test", "install", "add", "remove", "build", "x", "eval"]).has(
          tok
        )
      ) {
        return null
      }
    }

    if (
      NODE_EVAL_FLAGS.has(tok) ||
      tok.startsWith("--eval=") ||
      tok.startsWith("--print=")
    ) {
      return null
    }
    if (NODE_SKIP_NEXT_FLAGS.has(tok)) {
      i += 2
      continue
    }
    if (tok.startsWith("-")) {
      i++
      continue
    }
    return tok
  }
  return null
}

export function isAgyArgv(argv: readonly string[], comm = ""): boolean {
  const cleanComm = comm.trim()
  if (/<defunct>/i.test(cleanComm)) return false
  if (cleanComm && isSelfToken(cleanComm)) return false

  let tokens = argv.filter((t) => t.length > 0)
  if (tokens.length === 0) {
    if (!cleanComm) return false
    return TARGET_CLI_NAMES.has(executableBaseName(cleanComm))
  }

  const firstRaw = tokens[0]
  if (!firstRaw) return false
  if (firstRaw.startsWith("[") && firstRaw.endsWith("]")) return false

  if (executableBaseName(firstRaw) === "env") {
    tokens = unwrapEnvTokens(tokens)
  }

  const argv0 = tokens[0]
  if (!argv0) return false
  if (isSelfToken(argv0)) return false

  if (isTargetScriptOrBinary(argv0, tokens.slice(1))) {
    return true
  }

  const runtimeName = executableBaseName(argv0)
  if (JS_RUNTIMES.has(runtimeName)) {
    const scriptArg = findRuntimeScriptArg(runtimeName, tokens.slice(1))
    if (!scriptArg) return false
    return isTargetScriptOrBinary(scriptArg, tokens.slice(1))
  }

  if (SHELL_WRAPPERS.has(runtimeName)) {
    const rest = tokens.slice(1)
    if (rest.some((arg) => arg === "-c" || arg === "-lc" || arg === "-ic")) {
      return false
    }
    const scriptArg = rest.find((arg) => !arg.startsWith("-"))
    if (!scriptArg) return false
    return isTargetScriptOrBinary(scriptArg, rest)
  }

  return false
}

export function collectProtectedPids(
  rows: ReadonlyArray<{ pid: number; ppid: number }>,
  selfPid = process.pid,
  selfPpid = process.ppid
): Set<number> {
  const protectedPids = new Set<number>([0, 1, selfPid])
  if (Number.isSafeInteger(selfPpid) && selfPpid > 1) {
    protectedPids.add(selfPpid)
  }

  const ppidMap = new Map<number, number>()
  for (const row of rows) {
    if (
      Number.isSafeInteger(row.pid) &&
      row.pid > 0 &&
      Number.isSafeInteger(row.ppid) &&
      row.ppid >= 0
    ) {
      ppidMap.set(row.pid, row.ppid)
      if (row.ppid === selfPid) {
        protectedPids.add(row.pid)
      }
    }
  }

  let cursor = ppidMap.get(selfPid) ?? selfPpid
  let hops = 0
  while (
    cursor !== undefined &&
    Number.isSafeInteger(cursor) &&
    cursor > 1 &&
    hops < 128
  ) {
    protectedPids.add(cursor)
    const next = ppidMap.get(cursor)
    if (next === undefined || protectedPids.has(next)) {
      if (next !== undefined) protectedPids.add(next)
      break
    }
    cursor = next
    hops++
  }

  return protectedPids
}

function readLinuxProcTable(): RawProcessRow[] | null {
  if (process.platform !== "linux") return null

  let entries: string[]
  try {
    entries = readdirSync("/proc")
  } catch {
    return null
  }

  const rows: RawProcessRow[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue

    const procDir = `/proc/${pid}`
    let uid: number | null = null
    try {
      uid = statSync(procDir).uid
    } catch {
      continue
    }

    let ppid = 0
    let state = ""
    let comm = ""
    try {
      const statText = readFileSync(`${procDir}/stat`, "utf-8")
      const openParen = statText.indexOf("(")
      const closeParen = statText.lastIndexOf(")")
      if (openParen === -1 || closeParen === -1 || closeParen <= openParen) {
        continue
      }
      comm = statText.slice(openParen + 1, closeParen)
      const after = statText
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/)
      state = after[0] ?? ""
      ppid = Number.parseInt(after[1] ?? "0", 10) || 0
    } catch {
      continue
    }

    let argv: string[] = []
    try {
      const cmdBuf = readFileSync(`${procDir}/cmdline`)
      if (cmdBuf.length > 0) {
        const rawParts = cmdBuf.toString("utf-8").split("\0")
        while (rawParts.length > 0 && rawParts[rawParts.length - 1] === "") {
          rawParts.pop()
        }
        argv = rawParts
      }
    } catch {
      // Kernel thread or raced exit
    }

    const command = argv.length > 0 ? argv.join(" ") : comm
    rows.push({
      uid,
      pid,
      ppid,
      isZombie: state.toUpperCase() === "Z",
      comm,
      argv,
      command,
    })
  }

  return rows
}

export function parsePsTable(stdout: string): RawProcessRow[] {
  const rows: RawProcessRow[] = []
  const rowRe = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/

  for (const rawLine of stdout.split(/\r?\n/)) {
    const match = rowRe.exec(rawLine)
    if (!match) continue
    const uid = Number.parseInt(match[1] ?? "", 10)
    const pid = Number.parseInt(match[2] ?? "", 10)
    const ppid = Number.parseInt(match[3] ?? "", 10)
    const state = match[4] ?? ""
    const comm = match[5] ?? ""
    const args = (match[6] ?? "").trim()

    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const argv = args ? tokenizeCommandString(args) : []

    rows.push({
      uid: Number.isSafeInteger(uid) ? uid : null,
      pid,
      ppid: Number.isSafeInteger(ppid) ? ppid : 0,
      isZombie: state.toUpperCase().startsWith("Z") || /<defunct>/i.test(args),
      comm,
      argv,
      command: args || comm,
    })
  }

  return rows
}

async function readPsFallbackTable(): Promise<RawProcessRow[]> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FO", "CSV", "/NH"],
        {
          timeout: PS_TIMEOUT_MS,
          maxBuffer: MAX_PS_BUFFER_BYTES,
          windowsHide: true,
        }
      )
      const rows: RawProcessRow[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
        if (!match?.[1] || !match[2]) continue
        const exe = match[1]
        const pid = Number.parseInt(match[2], 10)
        if (!Number.isSafeInteger(pid) || pid <= 0) continue
        rows.push({
          uid: null,
          pid,
          ppid: 0,
          isZombie: false,
          comm: exe,
          argv: [exe],
          command: exe,
        })
      }
      return rows
    } catch {
      return []
    }
  }

  const flagSets: ReadonlyArray<readonly string[]> = [
    ["-eww", "-o", "uid=,pid=,ppid=,state=,comm=,args="],
    ["-eo", "uid=,pid=,ppid=,state=,comm=,args="],
  ]

  for (const args of flagSets) {
    try {
      const { stdout } = await execFileAsync("ps", [...args], {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: MAX_PS_BUFFER_BYTES,
      })
      return parsePsTable(stdout)
    } catch {
      // try fallback flag set
    }
  }

  return []
}

export function filterAgyProcessRows(
  rows: readonly RawProcessRow[],
  options?: {
    currentUid?: number | null | undefined
    selfPid?: number | undefined
    selfPpid?: number | undefined
  }
): AgyProcessScanResult {
  const currentUid =
    options?.currentUid !== undefined ? options.currentUid : getCurrentUid()
  const selfPid = options?.selfPid ?? process.pid
  const selfPpid = options?.selfPpid ?? process.ppid
  const protectedPids = collectProtectedPids(rows, selfPid, selfPpid)

  const processes: RunningProcess[] = []
  const skippedAncestors: RunningProcess[] = []

  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 1) continue
    if (row.pid === selfPid) continue
    if (row.isZombie) continue
    if (currentUid !== null && row.uid !== null && row.uid !== currentUid) {
      continue
    }

    if (!isAgyArgv(row.argv, row.comm)) continue

    const item: RunningProcess = {
      pid: row.pid,
      command: row.command,
    }

    if (protectedPids.has(row.pid)) {
      skippedAncestors.push(item)
      continue
    }

    processes.push(item)
  }

  return { processes, skippedAncestors }
}

export async function scanAgyProcesses(): Promise<AgyProcessScanResult> {
  if (isTruthyEnv(process.env["AGK_DISABLE_PROCESS_SCAN"])) {
    return { processes: [], skippedAncestors: [] }
  }

  const mockJson = process.env["AGK_MOCK_PROCESSES_JSON"]?.trim()
  if (mockJson) {
    try {
      const parsed: unknown = JSON.parse(mockJson)
      if (Array.isArray(parsed)) {
        const processes: RunningProcess[] = []
        for (const item of parsed) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { pid?: unknown }).pid === "number" &&
            typeof (item as { command?: unknown }).command === "string"
          ) {
            processes.push({
              pid: (item as { pid: number }).pid,
              command: (item as { command: string }).command,
            })
          }
        }
        return { processes, skippedAncestors: [] }
      }
    } catch {
      return { processes: [], skippedAncestors: [] }
    }
  }

  const rows = readLinuxProcTable() ?? (await readPsFallbackTable())
  return filterAgyProcessRows(rows)
}

export async function listAgyProcesses(): Promise<RunningProcess[]> {
  const { processes } = await scanAgyProcesses()
  return processes
}

export function formatProcessSummary(proc: RunningProcess): string {
  const safeCmd = sanitizeTerminalText(redactSecrets(proc.command), 72)
  return `PID ${proc.pid} (${safeCmd})`
}

function checkProcessAlive(pid: number): "alive" | "dead" | "eperm" {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "dead"
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    return getErrnoCode(error) === "EPERM" ? "eperm" : "dead"
  }
}

export async function terminateProcesses(
  processes: readonly RunningProcess[],
  timeoutMs = 4_000
): Promise<number> {
  if (processes.length === 0) return 0

  const safeTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(30_000, Math.round(timeoutMs))
      : 0

  const pending = new Set<number>()
  let unkillableCount = 0

  for (const proc of processes) {
    const pid = proc.pid
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      pid === process.pid ||
      pid === process.ppid
    ) {
      continue
    }

    try {
      process.kill(pid, "SIGTERM")
      pending.add(pid)
    } catch (error) {
      if (getErrnoCode(error) === "EPERM") {
        unkillableCount++
      }
    }
  }

  const deadline = Date.now() + safeTimeout
  while (pending.size > 0 && Date.now() < deadline) {
    for (const pid of [...pending]) {
      const status = checkProcessAlive(pid)
      if (status === "dead") {
        pending.delete(pid)
      } else if (status === "eperm") {
        pending.delete(pid)
        unkillableCount++
      }
    }
    if (pending.size === 0) return unkillableCount
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  for (const pid of [...pending]) {
    if (checkProcessAlive(pid) !== "alive") {
      pending.delete(pid)
      continue
    }
    try {
      process.kill(pid, "SIGKILL")
    } catch (error) {
      if (getErrnoCode(error) === "EPERM") {
        pending.delete(pid)
        unkillableCount++
      }
    }
  }

  if (pending.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  let survivors = unkillableCount
  for (const pid of pending) {
    if (checkProcessAlive(pid) !== "dead") {
      survivors++
    }
  }
  return survivors
}
