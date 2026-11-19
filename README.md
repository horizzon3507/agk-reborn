# agk-reborn

Multi-account manager for the Antigravity CLI (`agy`). Capture, switch, refresh, and monitor Google accounts from the terminal, pure TypeScript, zero native addons. It manages only CLI credentials under `~/.gemini` and the Linux `gemini`/`antigravity` Secret Service entry; no IDE required.

## Install

Standalone `agk` binary from [Releases](https://github.com/horizzon3507/agk-reborn/releases) (no Node runtime needed), or:

```sh
npm install -g agk-reborn   # Node >= 18
bun run build:bin           # compile locally → bin/agk
```

`agk` and `agk-reborn` run the same entrypoint. From source:

```sh
git clone https://github.com/horizzon3507/agk-reborn
cd agk-reborn
pnpm install && pnpm build
node dist/cli.js --help
```

## Commands

Bare `agk` in a TTY opens the account manager menu; outside a TTY it prints usage. Flags in `[brackets]` are optional.

| Command | Does |
|---|---|
| `agk auth add [--capture\|--oauth\|--token\|--token-stdin]` | Add an account: snapshot live `~/.gemini`, browser OAuth (PKCE S256), or refresh-token import. `--activate` switches right away. |
| `agk auth list [--once] [-i sec]` | Live account + quota dashboard (`r` reload, `q` quit). `--once` prints and exits. |
| `agk auth switch [email] [--force\|--keep-processes]` | Atomic switch under a lockfile: backs up the session, handles running `agy`, syncs the keyring, rolls back on failure. |
| `agk auth current` | Shows which account owns each live auth file and keyring entry. |
| `agk auth refresh [email\|--all]` | Validates and rotates stored OAuth tokens, probing the recorded client first. |
| `agk auth quota [email] [--once] [-i sec]` | Per-model Cloud Code quota with reset countdowns. |
| `agk auth remove [email] [-f]` | Deletes a saved profile; never touches the live session. |
| `agk doctor [--fix]` | Audits `agy` binary, auth files, permissions, processes. `--fix` repairs modes (`0700`/`0600`), marker drift, keyring mirrors, stale tmp files. |

Every command accepts `--json`: one JSON document on stdout, errors on stderr, no ANSI. `list`/`quota` auto-fall back to `--once` off a TTY. Exit codes: `0` ok, `1` failure.

## Workflow

```sh
agk auth add --capture                        # snapshot the signed-in account
agk auth add --oauth                          # add another via browser
agk auth switch work@example.com --force      # switch, stopping running agy
agk auth refresh --all                        # rotate tokens across profiles
```

Running `agy` processes rewrite `~/.gemini` from memory. `switch` detects them and offers termination, excluding its own ancestor PIDs so `agk` inside an `agy` terminal never kills your session.

## Output

<details>
<summary><code>agk doctor</code></summary>

```text
  ✔ agy binary: /home/user/.local/bin/agy
  ✔ ~/.gemini exists
  ⚠ antigravity-cli/antigravity-oauth-token missing
  ⚠ oauth_creds.json missing
  ⚠ antigravity-acp/acp_token.json missing
  ✔ keyring/antigravity skipped (OS keyring unavailable in this session)
  ✔ OAuth client credentials available (20 binary, 0 profile)
  ⚠ no saved profiles yet (run agk auth add)
  ✔ ~/.agk-reborn exists
  ⚠ 1 credential path(s) have group/world permissions (run agk doctor --fix)
  ⚠ 1 agy process(es) running (PID 2244492)

✔ Looks healthy
```

</details>

<details>
<summary><code>agk auth current --json</code></summary>

```json
{
  "ok": true,
  "account": "alice@gmail.com",
  "activeMarker": "alice@gmail.com",
  "savedProfile": true,
  "splitBrain": false,
  "warnings": [],
  "files": [
    {
      "relPath": "antigravity-cli/antigravity-oauth-token",
      "status": "present",
      "email": "alice@gmail.com",
      "hasRefreshToken": true,
      "expiresAt": "2026-11-19T04:12:00.000Z",
      "isExpired": false
    }
  ]
}
```

</details>

<details>
<summary><code>agk auth --help</code></summary>

```text
USAGE `agk auth list|add|switch|current|quota|refresh|remove`

COMMANDS

     `list`    List saved accounts with live quota
      `add`    Add a Google account for the Antigravity CLI (agy)
   `switch`    Switch the agy CLI to a different Google account
   `current`   Show the account the agy CLI is currently using
    `quota`    Live quota monitor for a saved account
   `refresh`   Refresh and verify OAuth tokens for saved profile(s)
   `remove`    Remove a saved account profile
```

</details>

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AGK_HOME` | `~/.agk-reborn` | Saved profiles + `.agk-lock` lockfile (`AGK_DIR` also works) |
| `GEMINI_HOME` | `~/.gemini` | Live `agy` credentials (`AGK_GEMINI_DIR`, `GEMINI_CLI_HOME` also work) |
| `AGK_DISABLE_KEYRING` | unset | `1`/`true` skips Secret Service reads/writes |
| `AGK_NO_BROWSER` | unset | Prints the OAuth URL instead of opening a browser |
| `AGK_NO_BANNER` | unset | Suppresses the banner |
| `AGK_REFRESH_TOKEN` | unset | Non-interactive token for `auth add --token` |
| `NO_COLOR` | unset | Disables ANSI (`FORCE_COLOR` overrides) |

## Data

A profile is a per-account snapshot under `$AGK_HOME/profiles/<email>/` (`0700` dirs, `0600` files). Writes stage into `.agk-tmp-*` files, fsync, then atomic `rename`; symlinks are refused; mutations coordinate via `.agk-lock` with dead-PID eviction. On Linux, `agy` prefers its Secret Service token over disk, `agk` manages that entry as a virtual auth file, and sandboxed `GEMINI_HOME` isolates host keyring access automatically.

## Security notes

- OAuth sign-in enforces PKCE `S256` and constant-time CSRF `state` on a `127.0.0.1` ephemeral listener, with `Cache-Control: no-store` + CSP headers and shell-free browser launch.
- No client secrets in this repo, pairs are discovered at runtime from your local `agy` install or captured auth files.
- Profiles hold real refresh tokens; protect `$AGK_HOME` like `~/.ssh`.
- Outbound HTTPS only to Google endpoints. Tokens, JWTs, and `GOCSPX-*` secrets are redacted from output and `--json` payloads.

## SDK

```ts
import { captureSessionToProfiles, getActiveAccountEmail, listProfiles } from "agk-reborn"
```

Dual ESM/CJS entrypoints with `.d.ts`/`.d.cts` declarations.

## Credits

Idea from [duongductrong/antigravity-kit](https://github.com/duongductrong/antigravity-kit): `agk-reborn` is a clean-room TypeScript rewrite for the CLI layout, sharing no code with the original. Cloud Code quota inspection adapted from community docs.

## License

Apache 2.0. See [LICENSE.md](LICENSE.md).
