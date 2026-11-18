<div align="center">
  <img src="https://raw.githubusercontent.com/horizzon3507/agk-reborn/main/assets/logo.png" alt="agk-reborn" width="250" />
</div>

<h1 align="center">agk-reborn</h1>

<p align="center">
  Multi-account manager for the Antigravity CLI (<code>agy</code>). Capture, switch, refresh, and monitor Google accounts from the terminal, no IDE required.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-black" alt="License: MIT" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-black" alt="Node >= 18" />
</p>

> Reborn fork of [antigravity-kit](https://github.com/duongductrong/antigravity-kit), rebuilt for the Antigravity CLI authentication layout. The upstream tool targeted the desktop IDE (`~/.config/Antigravity`, `state.vscdb`, OS keychain). `agk-reborn` manages only the CLI credentials under `~/.gemini` (and the Linux `gemini`/`antigravity` Secret Service entry) in pure TypeScript with zero native addons.

## Overview

- Snapshots whichever accounts are already signed into `~/.gemini` (`agk auth add --capture`), attributing each auth file to its Google account via JWT inspection and token correlation so mixed states split cleanly into separate profiles.
- Adds accounts directly from the terminal through browser OAuth (with RFC 7636 PKCE `S256` and CSRF `state` verification on `127.0.0.1`) or non-interactive refresh-token import (`--token`, `--token-stdin`, `AGK_REFRESH_TOKEN`).
- Switches active accounts atomically (`agk auth switch`) under an advisory lockfile: backs up the live session, stops or warns about running `agy` processes (while protecting `agk`'s own parent process tree), updates the Linux Secret Service keyring entry, removes stale files owned by other accounts, and rolls back automatically if a write fails.
- Refreshes OAuth tokens across multiple client credentials (`Antigravity`, `agy`, `Gemini CLI`), recording whichever client issued a profile's refresh token so later switches and `agk auth refresh` runs complete in a single request.
- Monitors per-model Cloud Code quotas (Claude, Gemini) with reset countdowns in live tables or single-pass scripts (`--once`, `--json`).
- Audits and repairs directory (`0700`) and file (`0600`) permissions, active-account marker drift, missing keyring mirrors, and leftover staging files (`agk doctor --fix`).

## Installation

Download the standalone `agk` binary from [Releases](https://github.com/horizzon3507/agk-reborn/releases) (no Node.js runtime needed), or compile it locally with Bun:

```bash
bun run build:bin   # writes bin/agk
```

Install globally from npm (requires Node.js >= 18):

```bash
npm install -g agk-reborn
# or
pnpm add -g agk-reborn
```

Both `agk` and `agk-reborn` invoke the same CLI entrypoint. To build and run from source:

```bash
git clone https://github.com/horizzon3507/agk-reborn
cd agk-reborn
pnpm install && pnpm build
node dist/cli.js --help
```

## Usage

Running `agk` or `agk auth` with no arguments in an interactive terminal opens the account manager menu. Outside a TTY, `agk` prints command usage instead of hanging on prompts.

```bash
agk auth add                      # interactive: capture session, browser OAuth, or import token
agk auth add --capture            # snapshot live ~/.gemini session without prompts
agk auth list                     # live account + quota dashboard ('r' reload, 'q' quit)
agk auth list --once              # print the account + quota table once and exit
agk auth switch [email]           # switch the active CLI account
agk auth current                  # show which account owns each live auth file
agk auth refresh [email]          # validate and rotate stored OAuth tokens (--all for every profile)
agk auth quota [email]            # live per-model quota monitor (--once for a single pass)
agk auth remove [email]           # delete a saved profile from ~/.agk-reborn
agk doctor                        # inspect agy binary, auth files, permissions, and processes
agk doctor --fix                  # repair permissions, active-account drift, and keyring sync
```

### Command and flag reference

| Command | Flags | Behavior |
| --- | --- | --- |
| `agk auth add` | `--capture`, `--oauth`, `--token`, `--token-stdin`, `-e` / `--email <email>`, `--activate`, `-y` / `--yes`, `--json` | `--capture` snapshots `$GEMINI_HOME` into `$AGK_HOME` without prompts; `--oauth` starts browser sign-in directly; `--token` / `--token-stdin` imports a refresh token; `--activate` switches the live CLI session to the added account; `--json` writes structured output to stdout. |
| `agk auth list` | `--once`, `-i` / `--interval <sec>`, `--json` | `--once` fetches quotas once and exits (automatic outside a TTY); `--interval` sets the live refresh cadence (`5` to `3600`, default `30`); `--json` outputs profile and quota records as JSON. |
| `agk auth switch [email]` | `--force`, `--keep-processes`, `-q` / `--quiet`, `--json` | `--force` stops running `agy` processes without prompting; `--keep-processes` leaves them running; `--quiet` suppresses non-error text; `--json` outputs the switch summary as JSON. |
| `agk auth current` | `--json` | Inspects each managed credential file and keyring entry; `--json` outputs `.account`, `.activeMarker`, `.savedProfile`, `.splitBrain`, and per-file ownership/expiry metadata. |
| `agk auth refresh [email]` | `--all`, `--json` | Validates and rotates tokens for one profile (defaults to active) or `--all` saved profiles, updates live files when refreshing the active account, and emits per-account results under `--json`. |
| `agk auth quota [email]` | `-a` / `--account <email>`, `--once`, `-i` / `--interval <sec>`, `--json` | Accepts a positional `[email]` or `-a <email>` (defaults to current account); `--once` prints once and exits (automatic outside a TTY); `--json` outputs subscription tier and per-model quota percentages with reset timestamps. |
| `agk auth remove [email]` | `-f` / `--force`, `--json` | Deletes `$AGK_HOME/profiles/<email>` without touching the live `$GEMINI_HOME` session; `--force` skips confirmation (required outside a TTY). |
| `agk doctor` | `-f` / `--fix`, `--json` | Audits setup health; `--fix` repairs directory (`0700`) and file (`0600`) modes, aligns stale `google_accounts.json` active markers, backfills missing keyring or disk mirrors, and removes leftover `.agk-tmp-*` staging files. |

### Typical workflow

```bash
# 1. Snapshot the account currently signed into ~/.gemini
agk auth add --capture

# 2. Add another account via browser OAuth (or log in via agy and capture again)
agk auth add --oauth

# 3. Switch accounts and stop running agy processes so they cannot overwrite ~/.gemini
agk auth switch work@example.com --force

# 4. Verify token health and rotate stored tokens across saved profiles
agk auth refresh --all
```

Running `agy` processes hold their credentials in memory and periodically rewrite `~/.gemini` files. `agk auth switch` detects active `agy` processes and offers to terminate them before restoring the target profile, while automatically excluding its own ancestor PIDs so running `agk` inside an `agy` terminal never kills your current session.

### Scripting and `--json` output

Passing `--json` suppresses banners, spinners, and ANSI styling on `stdout`, writing a single JSON document to `stdout` and sending errors to `stderr`. `list` and `quota` fall back to `--once` automatically whenever `stdout` or `stdin` is not a TTY. Exit codes are `0` on success and `1` on invalid flags, errors, or failed `doctor` checks.

```bash
agk auth current --json | jq -r '.account'
agk auth quota --once --json | jq '.models[] | {name, percentage, resetTime}'
agk doctor --fix --json
```

### Programmatic API

`agk-reborn` ships dual ESM and CommonJS entrypoints with TypeScript declarations:

```ts
import {
  captureSessionToProfiles,
  getActiveAccountEmail,
  listProfiles,
} from "agk-reborn"

const active = getActiveAccountEmail()
const profiles = listProfiles()
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGK_HOME` | `~/.agk-reborn` | Root directory for saved profiles and the `.agk-lock` lockfile (`AGK_DIR` is also accepted). |
| `GEMINI_HOME` | `~/.gemini` | Root directory for live Antigravity / Gemini CLI credentials (`AGK_GEMINI_DIR` and `GEMINI_CLI_HOME` are also accepted). |
| `AGK_DISABLE_KEYRING` | _(unset)_ | Skips Linux `secret-tool` keyring reads and writes when set to `1` or `true` (`AGK_NO_KEYRING` is also accepted). |
| `AGK_NO_BROWSER` | _(unset)_ | Prints the OAuth authorization URL without attempting to spawn a desktop browser. |
| `AGK_NO_BANNER` | _(unset)_ | Suppresses the ASCII banner header in interactive commands. |
| `AGK_REFRESH_TOKEN` | _(unset)_ | Supplies a refresh token non-interactively to `agk auth add --token`. |
| `NO_COLOR` | _(unset)_ | Disables ANSI color sequences when set (`FORCE_COLOR` overrides when non-zero). |

## How it works

The Antigravity CLI stores its live session under `$GEMINI_HOME` (`~/.gemini` by default):

| Path | Contains |
| --- | --- |
| `antigravity-cli/antigravity-oauth-token` | `agy` access, refresh, and ID tokens |
| `antigravity-acp/acp_token.json` | ACP agent refresh token and embedded OAuth client pair |
| `oauth_creds.json` | Shared OAuth credentials |
| `google_accounts.json` | Active-account marker (`active` and `old` history) |
| `keyring/antigravity` | Virtual entry for the Linux Secret Service item (`service=gemini`, `username=antigravity`), which `agy` reads before disk files |

A profile is a per-account snapshot stored under `$AGK_HOME/profiles/<email>/` (`0700` directories, `0600` files) with `meta.json` and `files/`. Mutations across `$AGK_HOME` and `$GEMINI_HOME` coordinate through an advisory `$AGK_HOME/.agk-lock` lockfile with dead-PID eviction, refuse to follow symlinks, and stage data into unique `.agk-tmp-*` files (`0600`) synced to disk before an atomic `rename`.

On Linux, `agy` caches its active token in the desktop Secret Service keyring (via `secret-tool`) and prefers that entry over files on disk. `agk-reborn` manages the keyring secret as a virtual auth file: captured into profiles, updated during `switch` and `refresh`, cleared when owned by another account, and derived from `antigravity-oauth-token` when switching a profile created without a keyring snapshot. When `GEMINI_HOME` points to a sandboxed directory, host keyring access is isolated automatically so tests and sandboxes never mutate the live desktop keyring.

Refresh tokens are bound to the OAuth client that issued them. During `switch`, `refresh`, `list`, and `quota`, `agk-reborn` probes candidate clients in order and records the working client pair in `meta.json` so future refreshes succeed immediately:

1. The profile's recorded client pair (saved after a prior successful refresh)
2. Client credentials embedded in captured auth files (`acp_token.json` carries `client_id` and `client_secret`)
3. Client credentials extracted via chunked streaming scans of installed `agy`, `antigravity`, or `gemini` binaries and JS bundles in `PATH`

## Security notes

- Browser OAuth sign-in (`agk auth add --oauth`) enforces RFC 7636 PKCE (`S256` `code_verifier` and `code_challenge`) and a cryptographic CSRF `state` parameter verified with `crypto.timingSafeEqual`. The local callback listener binds strictly to `127.0.0.1` on an ephemeral port, sends `Cache-Control: no-store` and `Content-Security-Policy` headers, enforces bounded request timeouts, and launches the browser via `execFile` without shell interpolation.
- No OAuth client secrets live in this repository. Client pairs are discovered at runtime from your local CLI installation or existing auth files.
- Saved profiles under `$AGK_HOME` (`~/.agk-reborn`) contain real OAuth refresh tokens. Directories are created with `0700` permissions and files with `0600` permissions (`agk doctor --fix` audits and restores both), and symlink targets are rejected on both reads and writes. Protect `$AGK_HOME` and `$GEMINI_HOME` with the same care as `~/.ssh`.
- Linux Secret Service reads and writes execute locally through `secret-tool` (`service=gemini`, `username=antigravity`) with `SIGKILL`-enforced subprocess timeouts. Outbound HTTPS requests go only to Google endpoints (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, and `cloudcode-pa.googleapis.com`).
- Access tokens, refresh tokens (`1//...`), JWTs, and `GOCSPX-*` client secrets are automatically redacted from error messages, terminal output, and `--json` payloads.

## Credits

- Original project: [duongductrong/antigravity-kit](https://github.com/duongductrong/antigravity-kit) (MIT)
- Cloud Code quota inspection adapted from community documentation of the quota endpoints

## License

MIT. See [LICENSE.md](LICENSE.md).
