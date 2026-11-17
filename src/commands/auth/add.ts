import * as p from "@clack/prompts"
import { defineCommand } from "citty"
import pc from "picocolors"
import { setActiveAccount } from "../../utils/accounts.js"
import { readAuthFile, writeAuthFileAtomic } from "../../utils/auth-files.js"
import { printHeader } from "../../utils/branding.js"
import { getUserInfo } from "../../utils/google-api.js"
import {
  buildClientCandidates,
  discoverOAuthClients,
  extractClientFromAuthFile,
} from "../../utils/oauth-clients.js"
import { startOAuthFlow } from "../../utils/oauth-server.js"
import { refreshAccessTokenAnyClient } from "../../utils/oauth.js"
import {
  ACP_TOKEN_REL,
  AGY_TOKEN_REL,
  MANAGED_AUTH_FILES,
} from "../../utils/paths.js"
import { getProfile, saveProfile } from "../../utils/profiles.js"
import {
  captureSessionToProfiles,
  detectCurrentSessionEmail,
} from "../../utils/session.js"
import { buildAuthFilesForTokens } from "../../utils/token-builders.js"

export default defineCommand({
  meta: {
    name: "add",
    description: "Add a Google account for the Antigravity CLI (agy)",
  },
  args: {
    activate: {
      type: "boolean",
      description: "Also switch the live CLI session to the new account",
      default: false,
    },
  },
  async run({ args }) {
    printHeader("agk auth add")

    p.intro(`${pc.cyan("◆")} ${pc.bold("Add account")}`)

    const hasSession = readAuthFile(AGY_TOKEN_REL) !== null
    const currentEmail = hasSession ? detectCurrentSessionEmail() : null

    const options: Array<{ value: string; label: string; hint: string }> = []
    if (hasSession) {
      options.push({
        value: "capture",
        label: `Capture current session${currentEmail ? ` (${currentEmail})` : ""}`,
        hint: "Save the login already in ~/.gemini",
      })
    }
    options.push(
      {
        value: "oauth",
        label: "Sign in with Google",
        hint: "Browser OAuth, no IDE needed",
      },
      {
        value: "token",
        label: "Import refresh token",
        hint: "Manual email + refresh token",
      }
    )

    const method = await p.select({
      message: "How do you want to add the account?",
      options,
    })

    if (p.isCancel(method)) {
      p.cancel("Cancelled")
      process.exit(0)
    }

    if (method === "capture") {
      await runCaptureFlow()
      return
    }

    if (method === "oauth") {
      await runOAuthFlow(args.activate)
      return
    }

    await runTokenFlow(args.activate)
  },
})

async function runCaptureFlow(): Promise<void> {
  const spinner = p.spinner()
  spinner.start("Capturing session from ~/.gemini ...")

  const captured = captureSessionToProfiles()

  if (captured.length === 0) {
    spinner.stop("Nothing to capture")
    p.cancel("No auth files found under ~/.gemini")
    process.exit(1)
  }

  spinner.stop("Session captured")

  for (const session of captured) {
    const liveTag = session.isLive ? pc.green(" (live)") : ""
    console.log(
      `  ${pc.green("✔")} ${pc.cyan(session.email)}${liveTag} ${pc.dim(`— ${session.files.length} file(s): ${session.files.join(", ")}`)}`
    )
  }

  p.outro(`${pc.green("✔")} Profile(s) saved to ~/.agk-reborn`)
}

async function runOAuthFlow(activate: boolean): Promise<void> {
  console.log()
  p.note(
    `Browser-based Google sign-in for the ${pc.cyan("agy")} CLI.
The tokens are saved as a profile.${activate ? `\n${pc.yellow("⚠")} --activate: the live CLI session will switch to this account.` : `\n${pc.dim("Your current session is untouched until you run")} ${pc.cyan("agk auth switch")}${pc.dim(".")}`}`,
    "OAuth"
  )

  const confirmed = await p.confirm({
    message: "Continue?",
    initialValue: true,
  })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  const spinner = p.spinner()
  spinner.start("Resolving OAuth client...")

  const acpContent = readAuthFile(ACP_TOKEN_REL)
  const oauthClient =
    (acpContent ? extractClientFromAuthFile(acpContent) : null) ??
    discoverOAuthClients()[0]

  if (!oauthClient) {
    spinner.stop("Failed")
    p.cancel(
      "Could not find OAuth client credentials. Install agy or use the refresh-token import."
    )
    process.exit(1)
  }

  try {
    const result = await startOAuthFlow(oauthClient)
    const email = result.userInfo.email
    const refreshToken = result.tokens.refresh_token

    if (!refreshToken) {
      throw new Error(
        "No refresh_token returned. Revoke access at https://myaccount.google.com/permissions and try again."
      )
    }

    const existing = getProfile(email)
    if (existing) {
      const replace = await p.confirm({
        message: `${email} already has a profile. Replace it?`,
        initialValue: true,
      })
      if (p.isCancel(replace) || !replace) {
        p.cancel("Cancelled")
        process.exit(0)
      }
    }

    spinner.start("Saving profile...")

    const files = buildAuthFilesForTokens(
      {
        access_token: result.tokens.access_token,
        refresh_token: refreshToken,
        expires_in: result.tokens.expires_in,
        id_token: result.tokens.id_token,
      },
      email,
      oauthClient,
      result.tokens.id_token
    )

    saveProfile(
      email,
      files.map((file) => ({
        relPath: file.relPath,
        content: file.content,
        email,
      })),
      {
        name: result.userInfo.name,
        clientId: oauthClient.id,
        clientSecret: oauthClient.secret,
      }
    )

    spinner.stop("Profile saved")

    if (activate) {
      for (const file of files) {
        writeAuthFileAtomic(file.relPath, file.content)
      }
      setActiveAccount(email)
      console.log(
        `  ${pc.yellow("⚠")} Live session switched to ${pc.cyan(email)}. Restart running agy sessions.`
      )
    }

    console.log()
    p.note(
      `${pc.green("Email:")} ${email}
${pc.green("Models:")} ${result.quota.models.length} with quota data
${pc.green("Active:")} ${activate ? pc.green("yes (live)") : pc.dim("no — run agk auth switch")}`,
      "Profile Created"
    )

    p.outro(`${pc.green("✔")} ${pc.cyan(email)} added`)
  } catch (error) {
    spinner.stop("Failed")
    const message = error instanceof Error ? error.message : "Unknown error"
    p.cancel(`OAuth failed: ${message}`)
    process.exit(1)
  }
}

async function runTokenFlow(activate: boolean): Promise<void> {
  const email = await p.text({
    message: "Account email:",
    placeholder: "you@gmail.com",
    validate: (value) => {
      if (!value) return "Email required"
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Invalid email"
      return undefined
    },
  })

  if (p.isCancel(email)) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  const refreshToken = await p.text({
    message: "Refresh token:",
    placeholder: "1//...",
    validate: (value) => (!value ? "Refresh token required" : undefined),
  })

  if (p.isCancel(refreshToken)) {
    p.cancel("Cancelled")
    process.exit(0)
  }

  const spinner = p.spinner()
  spinner.start("Validating token...")

  try {
    const clients = buildClientCandidates({
      authFileContents: MANAGED_AUTH_FILES.map((relPath) =>
        readAuthFile(relPath)
      ).filter((content): content is string => content !== null),
    })
    const { tokens, client } = await refreshAccessTokenAnyClient(
      refreshToken,
      clients
    )
    const userInfo = await getUserInfo(tokens.access_token)

    if (userInfo.email !== email) {
      spinner.stop("Mismatch")
      p.cancel(`Token belongs to ${userInfo.email}, not ${email}`)
      process.exit(1)
    }

    spinner.stop("Token valid")

    const files = buildAuthFilesForTokens(
      {
        access_token: tokens.access_token,
        refresh_token: refreshToken,
        expires_in: tokens.expires_in,
        id_token: tokens.id_token,
      },
      email,
      client,
      tokens.id_token
    )

    saveProfile(
      email,
      files.map((file) => ({
        relPath: file.relPath,
        content: file.content,
        email,
      })),
      { name: userInfo.name, clientId: client.id, clientSecret: client.secret }
    )

    if (activate) {
      for (const file of files) {
        writeAuthFileAtomic(file.relPath, file.content)
      }
      setActiveAccount(email)
      console.log(
        `  ${pc.yellow("⚠")} Live session switched to ${pc.cyan(email)}.`
      )
    }

    p.outro(`${pc.green("✔")} ${pc.cyan(email)} added`)
  } catch (error) {
    spinner.stop("Failed")
    const message = error instanceof Error ? error.message : "Unknown error"
    p.cancel(`Import failed: ${message}`)
    process.exit(1)
  }
}
