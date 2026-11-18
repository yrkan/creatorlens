# Changelog

Versions follow SemVer from 0.1.0; each release names its store schema version.

## 0.1.0 (v0), 2026-11-18 · schema 1

The first version: keep the history from day one, within the policy clocks.

- `setup`: shows the YouTube Terms of Service, the privacy policy and the terms, records a typed and versioned
  acceptance, stores the Desktop OAuth client (secret in the Keychain).
- `auth`: installed-app sign-in with PKCE S256, a 32-byte state, a loopback on 127.0.0.1, exactly two read-only scopes
  checked as a set, the channel confirmed and the profile bound to it, the refresh token in the Keychain through
  `security -i` with a read-back, the consent date and the OAuth app's mode recorded, an OAuth error map.
- `reporting enable | disable | status`: a job for every report type the channel is offered, at the newest version that
  is not deprecated, never a system-managed one; the job id with the Cloud project number.
- `sync`: the identity check, then every listed report file into the raw archive
  (`reports/<type>/<YYYYMMDD>_<createTime>_<reportId>.csv.gz`) with the `report_files` ledger, restatements marked
  superseded, lifetimes (`expireTime`, `jobExpireTime`, `deprecateTime`) and a stale alert after 4 days; own metadata
  refreshed; a run's row written before any work.
- The policy clocks: revoke purges everything in the same run; a lost sign-in is purged at the last good refresh +
  28 days; an unconfirmed one after 30 days; metadata after 30 days without a refresh; other channels' data (public.db)
  after 30 days; creatorlens's backups after 7 days. Checked at the server's start, on every tool call, by `status`,
  `sql` and `doctor`, and in every sync.
- `schedule`: a LaunchAgent (`io.github.yrkan.creatorlens.<profile>.sync`) at 07:30 with `RunAtLoad`, `Umask 077` and
  absolute paths to node and the pinned copy; the server starts a catch-up sync after 26 hours; local notifications.
- `install`: a pinned copy outside the repository, refused when the tests fail.
- `doctor [--json]`, `status [--json]` (state only), `logs`, `sql`, `purge`, `revoke`, `transcripts`, `mcp-config`.
- The MCP server over stdio with three read-only tools (`status`, `describe_store`, `sql_query`), three resources and
  instructions; strangers' text wrapped, SQL results included; SQL in a killable child process.
- Production dependencies: `@modelcontextprotocol/server` 2.4.0 (and its `@modelcontextprotocol/core` 2.4.0) for MCP
  over stdio, `zod` 4.6.7 for strict tool inputs. Nothing else.

Fixed by the pre-publication review (2026-11-18), before any release:

- A state-changing command run through a pseudo-terminal (`script`) passed the TTY check and its typed confirmation,
  although the README said an assistant's shell could not run one. They now also refuse a shell that carries
  `CLAUDE_CODE_CHILD_SESSION` (Claude Code's tools set it), the docs call all of it a speed bump and the assistant's
  shell on "ask" the wall, and the folder's deny rules now match quoted paths and `/usr/bin/security`.
- A full purge left the event log, which held the bound channel's id (and, after a binding refusal, the other
  channel's). The event log is now purged with the rest, and no event carries an id.
- The 30-day metadata clock cleared only the texts: publish times, durations, privacy, made-for-kids and live status
  (and the channel's creation time) stayed, and stayed for good on a deleted video. Every non-statistical field is now
  cleared (`METADATA_COLUMNS`, held complete by a test), and the WAL is truncated after.
- A sync with the current terms not accepted (after an upgrade that changed them) stopped before the clocks: a dead
  sign-in was never detected, the 30-day confirmation never ran, and nothing was logged or notified. The clocks now
  run first; the refusal is a failed run that notifies.
- A failing Reporting step skipped the own-metadata refresh, against design v2's API-11 decision; the refresh now runs
  and the run still fails.
- `setup` now prints both documents in full before asking for acceptance; terms version 2026-11-18.2 (privacy.md
  now names the copies a purge cannot reach: computer backups, exports, other transcripts).
- `doctor`'s text output escapes every detail for the terminal.
