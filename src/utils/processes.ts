import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface RunningProcess {
  pid: number
  command: string
}

const AGY_PATTERNS = [/\bagy\b/, /antigravity/i, /language_server/i]

function isRelevantCommand(command: string): boolean {
  if (/\bagk\b|agk-reborn|node\b/.test(command)) return false
  return AGY_PATTERNS.some((pattern) => pattern.test(command))
}

export async function listAgyProcesses(): Promise<RunningProcess[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="])
    const processes: RunningProcess[] = []

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const separator = trimmed.indexOf(" ")
      if (separator === -1) continue

      const pid = Number.parseInt(trimmed.slice(0, separator), 10)
      const command = trimmed.slice(separator + 1)

      if (pid === process.pid) continue
      if (!isRelevantCommand(command)) continue

      processes.push({ pid, command })
    }

    return processes
  } catch {
    return []
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function terminateProcesses(
  processes: RunningProcess[],
  timeoutMs = 4000
): Promise<number> {
  for (const proc of processes) {
    try {
      process.kill(proc.pid, "SIGTERM")
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processes.every((proc) => !isAlive(proc.pid))) return 0
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  for (const proc of processes) {
    try {
      process.kill(proc.pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300))

  return processes.filter((proc) => isAlive(proc.pid)).length
}
