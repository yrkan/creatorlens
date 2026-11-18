# creatorlens

**Read-only channel analytics for YouTube, for your AI assistant (MCP).** A local server and command line that keeps
your own channel's analytics on your computer, through Google's official APIs, with two read-only scopes.

creatorlens is not affiliated with, endorsed by or sponsored by YouTube or Google. "YouTube" is a trademark of Google
LLC.

> **Status: v0 (0.1.0).** v0 saves your history from day one: it signs in each channel, creates the YouTube Reporting
> API jobs, downloads every daily report file into a local archive, keeps the policy clocks, and runs every morning. Its
> MCP server answers `status`, `describe_store` and `sql_query`. The analysis tools (`channel_review`, `video_report`,
> `video_card`, `video_retention`, `channel_traffic`, `channel_reach`, `channel_audience`, `compare`, `metadata_check`
> and more) arrive in v1, which parses the archive v0 keeps. Nothing of the history is lost meanwhile: Google keeps
> report files for 60 days, and creatorlens keeps them for good.
>
> **Not on npm.** Install from this repository; never run an `npx creatorlens` line, which would fetch someone else's
> package.

## Why

- Impressions and click-through exist only in the Reporting API's files, Google keeps those files 60 days, and a job
  brings only the 30 days before it was created. A job must exist from the first day and its files must be kept.
- An assistant answers better from your real figures than from guesses, and a local store answers a year of questions
  in milliseconds with no quota.
- Every existing server we read either asks for write and delete scopes, has write tools that cannot be turned off, or
  sends your requests to a third party. creatorlens is read-only by construction.

## The safety model

- **Two read-only scopes:** `youtube.readonly` and `yt-analytics.readonly`. A grant with any other scope is revoked and
  refused. creatorlens has no way to upload, edit, delete, comment or change your channel.
- **A closed route table:** every request is checked against a list of method, host, path and caller before it is
  sent. Only Google's API and sign-in hosts are listed (not even `www.googleapis.com`). Redirects are refused, except a
  report download redirected to another download route; your token never goes to another host.
- **The few state-changing calls are yours alone:** creating and deleting Reporting jobs and revoking a token live in
  a module the MCP server never imports, and each runs only from your own terminal with a typed confirmation. The server
  also sets a one-way read-only latch.
- **Everything stays local:** a SQLite store and a raw archive per channel in `~/Library/Application Support/creatorlens/`
  (folders 0700, files 0600), the tokens in the macOS Keychain. No telemetry, no network service.
- **Strangers' text is data:** text other people write (search terms, referrer pages and, from v2, comments) is cleaned
  and returned only wrapped as `{"untrusted": "…"}`, in every tool and in SQL results too.
- **SQL in a sandbox:** `sql_query` runs one read-only statement in a separate process with an empty environment,
  `limits` that stop `ATTACH` and `VACUUM INTO`, a deny-by-default authorizer, and a kill after 5 seconds.
- **The policy clocks:** revoking through creatorlens deletes everything in the same run; a sign-in that can no longer be
  refreshed is announced in every answer and purged 28 days after the last good refresh; your videos' metadata is
  deleted if not refreshed for 30 days; other channels' data (v2) never lives longer than 30 days. See
  [docs/policy.md](docs/policy.md).

What the Keychain does not do, and what to do if a token leaks: [SECURITY.md](SECURITY.md).

## Privacy: who sees your data

Your data stays on your computer, **but everything a creatorlens tool returns goes to your AI client and on to its
model provider** (for Claude: Anthropic), and stays in the client's transcripts under the client's retention setting
(`cleanupPeriodDays` in Claude Code). Connecting creatorlens to a client is your choice of that provider for this data.
creatorlens's own purges cannot reach those copies, except in transcript folders you name with
`creatorlens transcripts add <folder>`, which every full purge empties. The full policy:
[docs/privacy.md](docs/privacy.md). Terms: [docs/terms.md](docs/terms.md).

## Requirements

- macOS (Linux arrives in v2; Windows is not supported).
- Node.js 24.15 or later; 26.7.0 is the tested and pinned version. `node:sqlite` needs 24.15 for its `limits`.
- pnpm 10.28 (the version in `package.json`).
- A Google account that owns or manages the channel, and about 40 minutes in Google Cloud the first time.

Production dependencies: `@modelcontextprotocol/server` 2.4.0 and `zod` 4.6.7, which bring one more package
(`@modelcontextprotocol/core`): three packages in all. Development: `typescript` and `@types/node`. No install scripts.

## Set up

The full checklist, with every Google Cloud screen: **[docs/owner-setup.md](docs/owner-setup.md)**. In short:

```sh
git clone https://github.com/yrkan/creatorlens.git && cd creatorlens
pnpm install --frozen-lockfile && pnpm build && pnpm test
sh scripts/install-hooks.sh                 # gitleaks before every commit (for contributors)
node dist/cli.js install                    # a pinned copy outside the clone; it prints its path
APP="$HOME/Library/Application Support/creatorlens/app/0.1.0/cli.js"
node "$APP" setup --client-json ~/Downloads/client_secret_*.json
node "$APP" auth --profile en               # one profile per channel: en, es, ru, …
node "$APP" reporting enable --profile en
node "$APP" sync --profile en --full
node "$APP" schedule install --profile en   # daily at 07:30, and at login
node "$APP" doctor --json                   # green when everything is in place
node "$APP" mcp-config                      # prints the next line with your paths
cd ~/YouTube-analysis && claude mcp add --scope local creatorlens -- <node> "$APP" serve
```

Secrets go only into your own terminal: never paste a token, the client JSON or an API key into a chat.

### Settings for the folder where you use it

`--scope local` registers the server only in the folder where you run the command. In that folder's
`.claude/settings.json`, keep the token and the state-changing commands out of the assistant's reach
(`creatorlens mcp-config` prints this block with your paths):

```json
{
  "permissions": {
    "deny": [
      "Bash(security find-generic-password*)",
      "Bash(security dump-keychain*)",
      "Bash(*cli.js auth*)", "Bash(*cli.js setup*)", "Bash(*cli.js revoke*)", "Bash(*cli.js purge*)",
      "Bash(*cli.js reporting*)", "Bash(*cli.js schedule*)", "Bash(*cli.js install*)", "Bash(*cli.js transcripts*)",
      "Read(~/Library/Application Support/creatorlens/**)"
    ]
  },
  "sandbox": { "filesystem": { "denyRead": ["~/Library/Application Support/creatorlens"] } }
}
```

While an assistant reads strangers' text, keep its shell, web fetches and other servers' write tools on "ask".

## Commands

| Command | What it does |
|---|---|
| `setup --client-json <file>` | shows and records your acceptance of the terms; stores the Desktop OAuth client (secret in the Keychain) |
| `auth --profile <p>` | signs in one channel in your browser (PKCE, loopback on 127.0.0.1); you confirm the channel's name and id |
| `reporting enable \| disable \| status --profile <p>` | creates a job for every report type the channel is offered (newest version, not system-managed); deletes the jobs creatorlens made; shows coverage |
| `sync --profile <p> [--full]` / `sync --all` | downloads new report files into the archive, refreshes your own metadata, runs the clocks |
| `schedule install \| remove \| status --profile <p>` | a LaunchAgent: daily at 07:30 and at login, running the pinned copy with an absolute node path |
| `status [--profile <p>] [--json]` | operational state only: sign-in, jobs, freshness, warnings; no audience figures, no strangers' text |
| `doctor [--profile <p>] [--json] [--offline]` | checks everything that could stop the data; green means no check failed |
| `sql --profile <p> "SELECT …"` | the same read-only sandbox as the tool, printed safely for a terminal |
| `logs --profile <p>` | the profile's log (ids and counts, redacted) |
| `purge --profile <p> --all \| --backups`, `purge --public` | deletes data; `--all` keeps a copy for 7 days |
| `revoke --profile <p>` | offers to delete the jobs, revokes at Google, deletes everything for that channel |
| `install [--force]` | copies the build into the data folder (refuses when tests fail) |
| `transcripts add \| remove \| list` | transcript folders (inside `~/.claude/projects/`) that every full purge empties |
| `mcp-config` | prints the `claude mcp add --scope local` line and the folder settings |
| `serve` | the MCP server over stdio (your MCP client runs it) |

State-changing commands need a terminal and a typed confirmation, so an assistant's shell cannot run them.

## MCP tools (v0)

| Tool | Returns |
|---|---|
| `status` | per profile: the bound channel, the sign-in and policy clocks, jobs and their newest report, freshness, schedule, warnings |
| `describe_store` | the tables of a profile's store, each column's meaning and origin, and example queries |
| `sql_query` | one read-only SELECT on a profile's store, in the sandbox; strangers' text wrapped |

Every tool is annotated read-only and takes `profile`; a call reads one channel only. Resources:
`creatorlens://schema`, `creatorlens://glossary`, `creatorlens://privacy`.

## What no API gives

Search volume and autocomplete; YouTube Studio's Research, Trends and Inspiration tabs; Test & compare results;
unique, new and returning viewers; "Stayed to watch" and "Shown in feed" for Shorts; real-time figures; clicks from
YouTube to an external site; other channels' private analytics. Transcripts need a write-capable scope, so
creatorlens does not read them.

## Report download host

Report files are downloaded only from `youtubereporting.googleapis.com`. If Google ever serves them from another host,
creatorlens refuses the download, sends nothing there and says so in `status` and `doctor`. Please open an issue with
the host name (never a URL with a token in it).

## Development

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test          # builds, then runs node --test on test/ (unit, policy clocks on a fake clock, SQL sandbox, stdio contract)
sh scripts/gitleaks.sh git
```

Fixtures are synthetic: channel ids start with `UCzz`, video ids with `zz`, and a test fails on anything else. The
design and every decision behind it: [docs/design.md](docs/design.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT, see [LICENSE](LICENSE).
