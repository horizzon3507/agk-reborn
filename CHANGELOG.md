# Changelog

We follow [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/). agk-reborn is a single CLI surface.

<details>
<summary>To see more about versioning, expand this.</summary>

Every version string starts with `v` (required), e.g. `v0.2.0`, `v0.1.0`.

Here the installable surface is **CLI** (`agk` / `agk-reborn`). Other apps swap in their own names the same way, e.g. **GNOME**, **Desktop**, or **Web**, matching whatever they actually ship.

| Part | What you install | Example |
| --- | --- | --- |
| **CLI** | `agk` / `agk-reborn` in the terminal | `v0.2.0` |

With one surface there is no `m` in the tag and no per-surface sections, just the version notes.

Each release heading is the version and date (`## v0.2.0 · 18/11/2026`); under it, a short summary ends with a plain sentence like: "This version was made for CLI on 18/11/2026 (v0.2.0)."

</details>

## v0.2.1 · 18/11/2026

Relicensed under Apache 2.0 with the upstream MIT notice preserved. This version was made for CLI on 18/11/2026 (v0.2.1).

- `LICENSE.md` now ships the Apache License 2.0; the original `antigravity-kit` MIT copyright and permission notice stays intact below it.
- `package.json` `license` field and the README badge and license section updated to Apache 2.0.

## v0.2.0 · 18/11/2026

End-to-end security hardening, transactional account switching, `agk auth refresh`, `agk doctor --fix`, scriptable `--json` output across every command, and zero runtime bloat. This version was made for CLI on 18/11/2026 (v0.2.0).

- Browser OAuth sign-in (`agk auth add --oauth`) now enforces RFC 7636 PKCE (`S256`) and constant-time CSRF `state` verification on an ephemeral `127.0.0.1` loopback listener, with strict HTTP timeouts, `Content-Security-Policy` headers, and shell-free `execFile` browser launch.
- New `agk auth refresh` subcommand validates and rotates stored OAuth tokens for one saved account or `--all` profiles, records the working OAuth client pair, and syncs live `~/.gemini` files plus the Linux Secret Service keyring when refreshing the active account.
- Transactional `agk auth switch` now coordinates under an advisory `.agk-lock` lockfile with dead-PID eviction, backs up existing profiles before overwriting, stages writes atomically with rollback on failure, and excludes ancestor PIDs so running `agk` inside `agy` never terminates its own parent session.
- Streaming OAuth client discovery scans large Go binaries (`agy`, `language_server`) in bounded 4 MiB chunks instead of loading hundreds of megabytes into V8 strings, slicing 35-byte `GOCSPX-` secrets cleanly without `.rodata` bleed and pairing each `client_id` with its nearest secret.
- Multi-client token refresh (`refreshAccessTokenAnyClient`) now probes every candidate OAuth client when Google returns `invalid_grant` for a mismatched client ID, while fast-failing network and 5xx outages.
- `agk doctor --fix` repairs directory (`0700`) and credential file (`0600`) modes, aligns stale `google_accounts.json` active markers with the live token owner, backfills missing keyring or disk mirrors, and cleans orphaned `.agk-tmp-*` files.
- Added `--json` output across `auth add`, `auth list`, `auth current`, `auth switch`, `auth refresh`, `auth quota`, `auth remove`, and `doctor`, along with non-interactive flags (`--capture`, `--oauth`, `--token`, `--token-stdin`, `--once`, `--quiet`), strict unknown-flag rejection, and automatic non-TTY fallbacks.
- Added `AGK_HOME` and `GEMINI_HOME` environment overrides (with automatic host-keyring isolation in sandboxed runs), symlink-safe `O_CREAT | O_EXCL` atomic file writes, automatic secret redaction (`1//`, JWTs, `GOCSPX-*`), dual ESM/CJS SDK exports, and replaced `gradient-string` with a pure-TypeScript 24-bit truecolor renderer.
- Various other security fixes, CI workflows, and test suites

## v0.1.0 · 17/11/2026

Initial release of agk-reborn, a CLI-only rebuild of antigravity-kit for `~/.gemini` accounts. This version was made for CLI on 17/11/2026 (v0.1.0).

- Multi-account profiles captured from `~/.gemini` auth files (`antigravity-oauth-token`, `oauth_creds.json`, `acp_token.json`, `google_accounts.json`) and saved under `~/.agk-reborn/profiles/` with `0600` permissions.
- Linux Secret Service keyring management (`service=gemini`, `username=antigravity` via `secret-tool`) alongside disk auth files so account switches persist across `agy` restarts.
- Atomic profile switching (`agk auth switch`) with running `agy` process detection, optional termination, stale file cleanup, and post-switch verification.
- Multi-client OAuth token refresh across Antigravity, `agy`, and Gemini CLI credentials discovered at runtime from local binaries and captured auth files.
- Interactive account menu on bare `agk`, live quota dashboard (`auth list`, `auth quota`), session ownership inspection (`auth current`), and setup diagnostics (`doctor`).
- Dual `agk` and `agk-reborn` binaries, standalone single-file compile target (`bun run build:bin`), and zero native dependencies on Node.js 18+.
