import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import {
  getActiveAccountEmail,
  setActiveAccount,
} from "../../utils/accounts.js"
import {
  isValidAuthFileContent,
  readAuthFile,
  removeAuthFile,
  writeAuthFileAtomic,
} from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { getUserInfo } from "../../utils/google-api.js"
import { decodeJwtPayload } from "../../utils/jwt.js"
import { withAgkLock } from "../../utils/lock.js"
import {
  buildClientCandidates,
  discoverOAuthClients,
} from "../../utils/oauth-clients.js"
import { startOAuthFlow } from "../../utils/oauth-server.js"
import {
  type OAuthClient,
  type TokenResponse,
  refreshAccessTokenAnyClient,
} from "../../utils/oauth.js"
import {
  AGY_TOKEN_REL,
  KEYRING_REL,
  MANAGED_AUTH_FILES,
  formatDisplayPath,
  getAgkDir,
  getGeminiDir,
} from "../../utils/paths.js"
import { listAgyProcesses } from "../../utils/processes.js"
import { getProfile, listProfiles, saveProfile } from "../../utils/profiles.js"
import { normalizeEmail, sanitizeErrorMessage } from "../../utils/redact.js"
import {
  captureSessionToProfiles,
  detectCurrentSessionEmail,
} from "../../utils/session.js"
import { buildAuthFilesForTokens } from "../../utils/token-builders.js"
import {
  createSafeSpinner,
  getColors,
  isInteractiveSession,
} from "../../utils/tui.js"

type AddMethod = "capture" | "oauth" | "token"

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString("utf-8").trim()
}

function cleanPastedToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
}

function hasAnyLiveValidAuthFile(): boolean {
  for (const relPath of MANAGED_AUTH_FILES) {
    const content = readAuthFile(relPath)
    if (content !== null && isValidAuthFileContent(relPath, content)) {
      return true
    }
  }
  return false
}

function collectAllKnownClientCandidates(): OAuthClient[] {
  const authFileContents = MANAGED_AUTH_FILES.map((relPath) =>
    readAuthFile(relPath)
  ).filter((content): content is string => content !== null)

  const profiles = listProfiles()
  const firstStored = profiles.find((prof) =>
    Boolean(prof.clientId && prof.clientSecret)
  )

  const candidates = buildClientCandidates({
    stored:
      firstStored?.clientId && firstStored.clientSecret
        ? {
            clientId: firstStored.clientId,
            clientSecret: firstStored.clientSecret,
          }
        : null,
    authFileContents,
  })

  const seen = new Set(candidates.map((c) => `${c.id}:${c.secret}`))
  for (const prof of profiles) {
    if (prof.clientId && prof.clientSecret) {
      const key = `${prof.clientId}:${prof.clientSecret}`
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push({
          id: prof.clientId,
          secret: prof.clientSecret,
          label: `profile:${prof.email}`,
        })
      }
    }
  }

  return candidates
}

function persistAndMaybeActivate(params: {
  email: string
  name?: string | undefined
  tokens: TokenResponse
  refreshToken: string
  client: OAuthClient
  activate: boolean
}): {
  writtenFiles: string[]
  autoCapturedEmails: string[]
} {
  const effectiveRefresh = params.tokens.refresh_token ?? params.refreshToken
  const files = buildAuthFilesForTokens(
    {
      access_token: params.tokens.access_token,
      refresh_token: effectiveRefresh,
      expires_in: params.tokens.expires_in,
      id_token: params.tokens.id_token,
    },
    params.email,
    params.client,
    params.tokens.id_token
  )

  const autoCapturedEmails: string[] = []
  if (params.activate) {
    const captured = captureSessionToProfiles()
    for (const item of captured) {
      if (item.email !== params.email) {
        autoCapturedEmails.push(item.email)
      }
    }
  }

  saveProfile(
    params.email,
    files.map((file) => ({
      relPath: file.relPath,
      content: file.content,
      email: params.email,
    })),
    {
      name: params.name,
      clientId: params.client.id,
      clientSecret: params.client.secret,
      replaceFiles: true,
    }
  )

  const writtenFiles = files.map((f) => f.relPath)

  if (params.activate) {
    const writtenSet = new Set<string>()
    for (const file of files) {
      if (writeAuthFileAtomic(file.relPath, file.content)) {
        writtenSet.add(file.relPath)
      }
    }
    const agyFile = files.find((file) => file.relPath === AGY_TOKEN_REL)
    if (agyFile && writeAuthFileAtomic(KEYRING_REL, agyFile.content)) {
      writtenSet.add(KEYRING_REL)
      writtenFiles.push(KEYRING_REL)
    }
    for (const relPath of MANAGED_AUTH_FILES) {
      if (!writtenSet.has(relPath)) {
        removeAuthFile(relPath)
      }
    }
    setActiveAccount(params.email)
  }

  return { writtenFiles, autoCapturedEmails }
}

function failCommand(message: string, json: boolean): void {
  process.exitCode = 1
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2))
    return
  }
  const c = getColors(process.stderr)
  console.error(`${c.red("✗")} ${message}`)
}

export default defineCommand({
  meta: {
    name: "add",
    description: "Add a Google account for the Antigravity CLI (agy)",
  },
  args: {
    capture: {
      type: "boolean",
      description: "Capture the current session from ~/.gemini without prompts",
      default: false,
    },
    oauth: {
      type: "boolean",
      description: "Sign in with Google via browser OAuth",
      default: false,
    },
    token: {
      type: "boolean",
      description:
        "Import a refresh token (interactive masked prompt or AGK_REFRESH_TOKEN)",
      default: false,
    },
    "token-stdin": {
      type: "boolean",
      description: "Read a refresh token from standard input",
      default: false,
    },
    email: {
      type: "string",
      description: "Expected account email to verify against the token",
      alias: "e",
    },
    activate: {
      type: "boolean",
      description: "Switch the live CLI session to the added account",
      default: false,
    },
    yes: {
      type: "boolean",
      description: "Confirm prompts automatically",
      alias: "y",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output result as JSON",
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    const json = Boolean(args.json)
    const interactive = isInteractiveSession({ json })
    const c = getColors(process.stdout)

    const methodFlags = [
      args.capture ? "capture" : null,
      args.oauth ? "oauth" : null,
      args.token || args["token-stdin"] ? "token" : null,
    ].filter((x): x is AddMethod => x !== null)

    if (methodFlags.length > 1) {
      failCommand(
        "Conflicting flags: specify only one of --capture, --oauth, or --token/--token-stdin",
        json
      )
      return
    }

    let expectedEmail: string | null = null
    if (typeof args.email === "string" && args.email.length > 0) {
      expectedEmail = normalizeEmail(args.email)
      if (!expectedEmail) {
        failCommand(`Invalid email address: ${args.email}`, json)
        return
      }
    }

    printHeader("agk auth add", { json })
    if (interactive) {
      p.intro(`${c.cyan("◆")} ${c.bold("Add account")}`)
    }

    let method: AddMethod | null = methodFlags[0] ?? null
    if (!method && process.env["AGK_REFRESH_TOKEN"]?.trim()) {
      method = "token"
    }

    if (!method) {
      if (!interactive) {
        failCommand(
          "Non-interactive mode requires --capture, --oauth, --token-stdin, or AGK_REFRESH_TOKEN",
          json
        )
        return
      }

      const hasSession = hasAnyLiveValidAuthFile()
      const currentEmail = hasSession ? detectCurrentSessionEmail() : null

      const options: Array<{ value: AddMethod; label: string; hint: string }> =
        []
      if (hasSession) {
        options.push({
          value: "capture",
          label: `Capture current session${currentEmail ? ` (${currentEmail})` : ""}`,
          hint: `Save the login in ${formatDisplayPath(getGeminiDir())}`,
        })
      }
      options.push(
        {
          value: "oauth",
          label: "Sign in with Google",
          hint: "Browser OAuth with PKCE, no IDE needed",
        },
        {
          value: "token",
          label: "Import refresh token",
          hint: "Paste a Google OAuth refresh token (masked)",
        }
      )

      const selected = await p.select<AddMethod>({
        message: "How do you want to add the account?",
        options,
      })

      if (p.isCancel(selected)) {
        p.cancel("Cancelled")
        process.exitCode = 130
        return
      }
      method = selected
    }

    if (method === "capture") {
      await runCaptureFlow({
        activate: Boolean(args.activate),
        expectedEmail,
        interactive,
        json,
      })
      return
    }

    if (method === "oauth") {
      await runOAuthFlow({
        activate: Boolean(args.activate),
        expectedEmail,
        yes: Boolean(args.yes),
        interactive,
        json,
      })
      return
    }

    await runTokenFlow({
      activate: Boolean(args.activate),
      expectedEmail,
      fromStdin: Boolean(args["token-stdin"]),
      yes: Boolean(args.yes),
      interactive,
      json,
    })
  },
})

async function runCaptureFlow(opts: {
  activate: boolean
  expectedEmail: string | null
  interactive: boolean
  json: boolean
}): Promise<void> {
  const c = getColors(process.stdout)
  const spinner = createSafeSpinner(opts.interactive)
  const geminiLabel = formatDisplayPath(getGeminiDir())
  const agkLabel = formatDisplayPath(getAgkDir())

  spinner.start(`Capturing session from ${geminiLabel}...`)

  try {
    const captured = await withAgkLock("auth add capture", () =>
      captureSessionToProfiles()
    )

    if (captured.length === 0) {
      spinner.stop("Nothing to capture", 1)
      const hasAnyRaw = MANAGED_AUTH_FILES.some(
        (rel) => readAuthFile(rel) !== null
      )
      const reason = hasAnyRaw
        ? `Auth files under ${geminiLabel} had no valid account identity to capture`
        : `No valid auth files found under ${geminiLabel}`
      failCommand(reason, opts.json)
      return
    }

    if (
      opts.expectedEmail &&
      !captured.some((s) => s.email === opts.expectedEmail)
    ) {
      spinner.stop("Account mismatch", 1)
      failCommand(
        `Captured ${captured.map((s) => s.email).join(", ")}, expected ${opts.expectedEmail}`,
        opts.json
      )
      return
    }

    if (opts.activate) {
      const target =
        captured.find((s) => s.isLive)?.email ?? captured[0]?.email ?? null
      if (target) setActiveAccount(target)
    }

    spinner.stop("Session captured", 0)

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            method: "capture",
            activated: opts.activate,
            activeAccount: getActiveAccountEmail(),
            accounts: captured,
          },
          null,
          2
        )
      )
      return
    }

    for (const session of captured) {
      const liveTag = session.isLive ? c.green(" (live)") : ""
      console.log(
        `  ${c.green("✔")} ${c.cyan(session.email)}${liveTag} ${c.dim(`· ${session.files.length} file(s): ${session.files.join(", ")}`)}`
      )
    }

    if (opts.interactive) {
      p.outro(`${c.green("✔")} Saved profile(s) to ${agkLabel}`)
    }
  } catch (error) {
    spinner.stop("Capture failed", 1)
    failCommand(`Capture failed: ${sanitizeErrorMessage(error)}`, opts.json)
  }
}

async function runOAuthFlow(opts: {
  activate: boolean
  expectedEmail: string | null
  yes: boolean
  interactive: boolean
  json: boolean
}): Promise<void> {
  const c = getColors(process.stdout)

  if (opts.interactive && !opts.yes) {
    console.log()
    p.note(
      `Browser-based Google sign-in for the ${c.cyan("agy")} CLI.\nTokens are saved as a local profile.${opts.activate ? `\n${c.yellow("⚠")} --activate: the live CLI session will switch to this account.` : `\n${c.dim("Your current session stays untouched until you run")} ${c.cyan("agk auth switch")}${c.dim(".")}`}`,
      "OAuth"
    )

    const confirmed = await p.confirm({
      message: "Continue?",
      initialValue: true,
    })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled")
      process.exitCode = p.isCancel(confirmed) ? 130 : 0
      return
    }
  }

  const spinner = createSafeSpinner(opts.interactive)
  spinner.start("Resolving OAuth client...")

  const candidates = collectAllKnownClientCandidates()
  const oauthClient =
    candidates.find((cand) => cand.label !== "profile") ??
    candidates[0] ??
    discoverOAuthClients()[0]

  if (!oauthClient) {
    spinner.stop("No OAuth client found", 1)
    failCommand(
      "Could not discover OAuth client credentials. Install agy or gemini so client credentials can be discovered.",
      opts.json
    )
    return
  }

  spinner.stop("OAuth client resolved", 0)

  try {
    const result = await startOAuthFlow(oauthClient, {
      onAuthUrl: (authUrl, opened) => {
        if (!opts.json) {
          console.log()
          console.log(
            opened
              ? `  ${c.cyan("◆")} Browser opened. If needed, open this URL manually:`
              : `  ${c.cyan("◆")} Open this URL in your browser to sign in:`
          )
          console.log(`  ${c.dim(authUrl)}`)
          console.log()
        }
        spinner.start("Waiting for Google authorization in browser...")
      },
      onStage: (stage) => {
        if (stage === "exchanging_code") {
          spinner.message("Exchanging authorization code for tokens...")
        } else if (stage === "fetching_profile") {
          spinner.message("Fetching Google account profile...")
        } else if (stage === "fetching_quota") {
          spinner.message("Checking model quota...")
        }
      },
    })

    spinner.stop("Authorization complete", 0)

    const email = normalizeEmail(result.userInfo.email)
    if (!email) {
      failCommand("Google userinfo did not return a valid email", opts.json)
      return
    }

    if (opts.expectedEmail && email !== opts.expectedEmail) {
      failCommand(
        `Signed in as ${email}, which does not match expected ${opts.expectedEmail}`,
        opts.json
      )
      return
    }

    const existing = getProfile(email)
    if (existing && opts.interactive && !opts.yes) {
      const replace = await p.confirm({
        message: `${email} already has a saved profile. Replace it?`,
        initialValue: true,
      })
      if (p.isCancel(replace) || !replace) {
        p.cancel("Cancelled")
        process.exitCode = p.isCancel(replace) ? 130 : 0
        return
      }
    }

    spinner.start("Saving profile...")
    const persisted = await withAgkLock("auth add oauth", () =>
      persistAndMaybeActivate({
        email,
        name: result.userInfo.name,
        tokens: result.tokens,
        refreshToken: result.tokens.refresh_token,
        client: oauthClient,
        activate: opts.activate,
      })
    )
    spinner.stop("Profile saved", 0)

    const running = opts.activate ? await listAgyProcesses() : []

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            method: "oauth",
            email,
            activated: opts.activate,
            activeAccount: getActiveAccountEmail(),
            files: persisted.writtenFiles,
            autoCaptured: persisted.autoCapturedEmails,
            quotaModels: result.quota.models.length,
            runningProcesses: running.length,
          },
          null,
          2
        )
      )
      return
    }

    if (opts.activate) {
      console.log(
        `  ${c.green("✔")} Live session switched to ${c.cyan(email)}.`
      )
      if (running.length > 0) {
        console.log(
          `  ${c.yellow("⚠")} ${running.length} agy process(es) are running and may overwrite live auth files until restarted.`
        )
      }
    }

    if (opts.interactive) {
      console.log()
      p.note(
        `${c.green("Email:")} ${email}\n${c.green("Models:")} ${result.quota.models.length} with quota data\n${c.green("Active:")} ${opts.activate ? c.green("yes (live)") : c.dim("no (run agk auth switch)")}`,
        "Profile Created"
      )
      p.outro(`${c.green("✔")} ${c.cyan(email)} added`)
    }
  } catch (error) {
    spinner.stop("OAuth failed", 1)
    failCommand(`OAuth failed: ${sanitizeErrorMessage(error)}`, opts.json)
  }
}

async function runTokenFlow(opts: {
  activate: boolean
  expectedEmail: string | null
  fromStdin: boolean
  yes: boolean
  interactive: boolean
  json: boolean
}): Promise<void> {
  const c = getColors(process.stdout)
  let rawToken = ""

  if (opts.fromStdin) {
    rawToken = await readStdinText()
  } else if (process.env["AGK_REFRESH_TOKEN"]?.trim()) {
    rawToken = process.env["AGK_REFRESH_TOKEN"].trim()
  } else {
    if (!opts.interactive) {
      failCommand(
        "Non-interactive token import requires --token-stdin or AGK_REFRESH_TOKEN",
        opts.json
      )
      return
    }

    const prompted = await p.password({
      message: "Refresh token:",
      validate: (value) =>
        !value || !cleanPastedToken(value)
          ? "Refresh token is required"
          : undefined,
    })

    if (p.isCancel(prompted)) {
      p.cancel("Cancelled")
      process.exitCode = 130
      return
    }
    rawToken = prompted
  }

  const refreshToken = cleanPastedToken(rawToken)
  if (!refreshToken) {
    failCommand("Refresh token is empty", opts.json)
    return
  }

  const spinner = createSafeSpinner(opts.interactive)
  spinner.start("Validating refresh token...")

  try {
    const clients = collectAllKnownClientCandidates()
    const { tokens, client } = await refreshAccessTokenAnyClient(
      refreshToken,
      clients
    )

    let email: string | null = null
    let displayName: string | undefined
    try {
      const userInfo = await getUserInfo(tokens.access_token)
      email = normalizeEmail(userInfo.email)
      displayName = userInfo.name
    } catch {
      if (tokens.id_token) {
        const jwtPayload = decodeJwtPayload(tokens.id_token)
        email = normalizeEmail(jwtPayload?.email)
        displayName = jwtPayload?.name
      }
    }

    if (!email) {
      spinner.stop("Validation failed", 1)
      failCommand(
        "Could not resolve account email from the provided refresh token",
        opts.json
      )
      return
    }

    if (opts.expectedEmail && email !== opts.expectedEmail) {
      spinner.stop("Email mismatch", 1)
      failCommand(
        `Token belongs to ${email}, not ${opts.expectedEmail}`,
        opts.json
      )
      return
    }

    spinner.stop(`Token valid (${email})`, 0)

    const existing = getProfile(email)
    if (existing && opts.interactive && !opts.yes) {
      const replace = await p.confirm({
        message: `${email} already has a saved profile. Replace it?`,
        initialValue: true,
      })
      if (p.isCancel(replace) || !replace) {
        p.cancel("Cancelled")
        process.exitCode = p.isCancel(replace) ? 130 : 0
        return
      }
    }

    spinner.start("Saving profile...")
    const persisted = await withAgkLock("auth add token", () =>
      persistAndMaybeActivate({
        email,
        name: displayName,
        tokens,
        refreshToken,
        client,
        activate: opts.activate,
      })
    )
    spinner.stop("Profile saved", 0)

    const running = opts.activate ? await listAgyProcesses() : []

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            method: "token",
            email,
            activated: opts.activate,
            activeAccount: getActiveAccountEmail(),
            files: persisted.writtenFiles,
            autoCaptured: persisted.autoCapturedEmails,
            runningProcesses: running.length,
          },
          null,
          2
        )
      )
      return
    }

    if (opts.activate) {
      console.log(
        `  ${c.green("✔")} Live session switched to ${c.cyan(email)}.`
      )
      if (running.length > 0) {
        console.log(
          `  ${c.yellow("⚠")} ${running.length} agy process(es) are running and may overwrite live auth files until restarted.`
        )
      }
    }

    if (opts.interactive) {
      p.outro(`${c.green("✔")} ${c.cyan(email)} added`)
    } else {
      console.log(`${c.green("✔")} Added ${email}`)
    }
  } catch (error) {
    spinner.stop("Validation failed", 1)
    failCommand(`Import failed: ${sanitizeErrorMessage(error)}`, opts.json)
  }
}
