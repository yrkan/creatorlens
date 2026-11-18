# creatorlens: design v2

A local, read-only MCP server and command line that lets an AI assistant analyse **your own YouTube channels** through
Google's official APIs only. Design v1 (2026-11-18 morning) was reviewed the same day by four reviewers (security, API
policy, assistant UX, completeness): 102 findings, 11 graded A (blocks the build), 55 B (due before the first version),
36 C. This version answers every one of them (§ 12) and records what v0 (0.1.0) builds. Written 2026-11-18.

creatorlens is not affiliated with or endorsed by YouTube or Google.

## 0. What changed from v1

- **Staged** (CMP-4): **v0** keeps the history and the policy clocks (sign-in, Reporting jobs for every report type, a
  raw archive with a ledger, the schedule, doctor); **v1** answers questions (parsing, 16 tools); **v2** adds public
  research in a separate store, the full query validator and Linux.
- **One server, six profiles:** one registration; every tool takes `profile`; each profile is one channel with its own
  store, archive and token, so no call and no SQL can read two channels (CMP-12).
- **The threat model is rewritten** around private data, strangers' text and the ways out (SEC-1, API-2, UX-2): v1's
  "an injection can at most mislead" was false inside an AI client that also has a shell.
- **The deletion clocks are mandatory and automatic** (API-1, CMP-2, SEC-9).
- **No ratio is re-aggregated, no period CTR is computed** (UX-3, API-6).
- **The Reporting import keeps every raw file** as the source of truth (CMP-3, API-8).
- **Runtime:** Node ≥ 24.15 (pinned to the installed 26.7.0) and SQL in a killable child process (SEC-3, SEC-4, CMP-18).
- **MCP SDK:** `@modelcontextprotocol/server` 2.4.0 over `./stdio` (two transitive packages, core and zod) instead of
  `@modelcontextprotocol/sdk` 1.x (17 direct dependencies, mostly HTTP code a stdio server never runs) (SEC-12, CMP-26).
- **Install:** a pinned copy outside the clone, registered with `--scope local` in a dedicated analysis folder (SEC-17,
  UX-16, SEC-1).
- **Names:** "creatorlens" everywhere, never "YouTube", "YT" or "Tube" (SEC-2, API-3, UX-1, CMP-1).
- **Test runner:** Node's built-in `node:test` runs the TypeScript sources directly (erasable syntax only), so the whole
  development tree is `typescript` and `@types/node` (vitest is not needed).

## 1. Why

The owner runs six language channels and wants an assistant to answer real questions ("which Shorts hold viewers past
the hook?", "what do people type to find us?", "did the new title help?") from the channels' real figures. Every
existing YouTube MCP server read in depth failed that brief (write scopes that cannot be turned off, tokens sent to
arbitrary URLs, no impressions, a third party seeing every request). What this project is built around:

1. **Read-only by construction:** two read-only scopes, no write tool, a closed route table.
2. **Impressions and click-through:** these exist only in the Reporting API's files.
3. **Memory:** Google keeps report files 60 days and a job brings only the 30 days before its creation; a local archive
   keeps them for good.
4. **Honesty about the figures:** freshness, thresholds and definition breaks travel with every answer (v1).

## 2. Goals, non-goals, anti-goals

**Goals.** Own-channel analysis from Google's figures (views, engagedViews, watch time, retention, traffic sources and
search terms, playback location, impressions, subscribers, audience splits, Shorts against long-form by YouTube's own
`creatorContentType`); a local history beyond Google's windows, synced daily without the owner thinking about it;
read-only SQL over the store; everything on the owner's computer; a repository other channel owners can trust.

**Non-goals.** Uploading, editing, publishing, scheduling, commenting, moderating, thumbnails, playlists (the owner
acts in YouTube Studio); other channels' private analytics; transcripts (they need `youtube.force-ssl`); figures no API
gives (§ 4.6); Analytics groups created through the API (a write); a hosted or multi-user service; Windows.

**Anti-goals** (failures even if they worked):

- any path by which the model can change the channel, the Google account or anything outside the local store;
- any request to a host other than Google's API and sign-in endpoints; any network transport (HTTP or SSE) or shared
  server (III.I.15: no API service);
- scraping, yt-dlp, innertube, or data scraped by others inside this API client (III.E.6);
- **creating** derived metrics (III.E.4.h restricts creating them, not only storing them): channel scores or ratios,
  rankings between channels, outlier ratios, sentiment, inferred content type;
- secrets in the repository, logs, a command line or tool output.

## 3. Constraints (read from Google's documentation on 2026-11-18, as the reviews quote it)

- **Data API v3 quota:** 10,000 units a day per project; `search.list` its own bucket of 100 calls; list calls 1 unit;
  days on Pacific time; splitting one use over several projects is forbidden. Counts kept locally are estimates; the
  403 `quotaExceeded` is the authority (API-22).
- **Analytics API v2:** `ids=channel==MINE`; `engagedViews` since 2025-04-30; `audienceType` is a **filter only** (one
  query per value); `video` as a dimension needs a sort and ≤ 200 rows; documented sorts only (`top_content` cannot
  sort by likes or engagedViews); `filters=video==` takes up to 500 ids and aggregates; data lags 48–72 h and the end
  date is cut back to the last processed day.
- **Reporting API v1:** daily CSVs about 48 h after the day, **kept 60 days**; a new job brings **historical** reports
  for the 30 days before its creation (a "backfill" is a restatement: a new report id for the same period, which
  replaces the old one). Rows with an empty `video_id` (deleted videos, channel-level events) since 2026-09-09; zero
  rows are omitted, and a header-only file means no data. Types are versioned (`_a2` became `_a3` on 2025-06-30) and
  carry `deprecateTime`; jobs carry `expireTime`, reports `jobExpireTime`. Impressions and impressions CTR exist only
  in the reach reports (since 2026-01-15). Report ids must be kept. Not every non-GET call is `jobs.create`:
  `jobs.delete` is a DELETE and revoking a token is a POST.
- **Definition breaks** (per source): 2025-03-31 Shorts views count every start (product), reaching Analytics on
  2025-04-30 and bulk reports on 2025-06-30; 2026-03-09 under-18 viewers in age groups; 2026-08-27 views from the first
  frame, engagedViews redefined, average view duration and CTR on engaged views; 2026-11-16 TV co-views in views,
  watch time and Data API viewCount, not in engaged views. No series is continuous across them.
- **OAuth:** installed app, loopback, PKCE (Google defaults to `plain`, so S256 is sent explicitly). The two scopes can
  be unticked on the granular consent screen, so the grant is checked as a set. An app in Testing gets 7-day tokens for
  YouTube scopes; `refresh_token_expires_in` is **not** a reliable Testing signal. Since June 2025 a client secret is
  shown once; clients unused for 6 months are deleted (restorable 30 days); 100 refresh tokens per account per client;
  the 100-user cap counts users over the project's lifetime. Google's documentation does not promise a Brand Account
  picker, so the channel is confirmed after consent with `channels.list mine=true`.
- **Policies** (Developer Policies, read 2026-11-18): delete all Authorized Data within 7 days after a revocation through
  the client and within 30 days after a token cannot be refreshed (III.D.2.c); re-confirm authorization every 30 days
  (III.E.4.b); own non-statistical data (metadata) and other channels' data at most 30 days unless refreshed
  (III.E.4.c, III.E.4.d); no derived metrics without the III.L audit (III.E.4.h, III.L since 2026-06-01, applying only
  to audited developers); terms binding users to YouTube's Terms, a privacy policy naming YouTube API Services with
  Google's Privacy Policy, the revocation page, sharing and a contact (III.A); results may reach only agents the user
  approved (III.E.3.b); no YouTube mark in names (Branding Guidelines through III.G.2.d); no scraping (III.E.6); one
  project per API client (III.D.1.c); no credentials in open source (III.D.1.d).
- **Runtime:** Node ≥ 24.15: `setAuthorizer` (24.10), defensive mode (24.12), `limits` (24.15, which also drops the
  ExperimentalWarning). On Node 22 a read-only connection copied the whole database with `VACUUM INTO` and accepted
  `limits` without enforcing it; on Node 26.7.0 both are refused (measured 2026-11-18, and again while building v0).
  node:sqlite has no interrupt. Node 26 renames `DatabaseSync` to `Database` (DEP0210).

## 4. Architecture

```
MCP client ──stdio──> creatorlens serve (read-only latch; never imports src/admin/)
                          │  status · describe_store · sql_query (child process)
                          ▼
              profiles/<p>/store.db   profiles/<p>/reports/…csv.gz   public.db (v2)
                          ▲
creatorlens CLI (owner's terminal) ── setup · auth · reporting · sync · schedule · doctor · purge · revoke · install
                          │  GET to the route table; POST /token; CLI-only: POST /revoke, POST/DELETE jobs
                          ▼
     youtube.googleapis.com · youtubeanalytics.googleapis.com · youtubereporting.googleapis.com · oauth2.googleapis.com
```

### 4.1 Modules (`src/`, as built in v0)

| Module | Role |
|---|---|
| `cli.ts` | entry: Node version check, argument parsing, commands loaded on demand (so `serve` never loads `src/admin/`) |
| `context.ts` | everything from the outside world in one object (clock, fetch, exec, terminal, secrets, notifications) |
| `paths.ts` | the data folder (`~/Library/Application Support/creatorlens/`), profile names `^[a-z0-9][a-z0-9-]{0,31}$` |
| `config.ts` | the operator's settings: client id and project number, accepted terms version, secret store, transcript folders |
| `secrets.ts` | the Keychain through `security -i` (base64, read-back, 4,095-byte limit); a 0600 file store only on request |
| `google/routes.ts` | the closed route table (core routes, usable by both callers) |
| `google/http.ts` | the only network module: route check, redirects, retries, caps, TLS switch, latch |
| `google/oauth.ts` | token refresh, the scope check, the OAuth error map |
| `google/api.ts` | typed GETs: channels, uploads, videos, report types, jobs, reports, downloads, an Analytics probe |
| `google/quota.ts` | one quota ledger per Cloud project, per Pacific day |
| `admin/` | CLI only: the loopback sign-in (PKCE), job creation and deletion, revocation, and their routes |
| `store/` | node:sqlite wrapper, migrations and the column map (origin and meaning of every column), public.db's clock |
| `policy.ts`, `check.ts` | the clocks and the full purge; the no-network check the server runs on every call |
| `sync.ts`, `archive.ts`, `reportingPlan.ts` | the daily sync, the raw archive and its ledger, the choice of jobs |
| `status.ts`, `doctor.ts` | state without the network; checks with it |
| `schedule.ts`, `install.ts` | the LaunchAgent; the pinned copy |
| `sql/` | the one-statement gate, the child runner, the parent sandbox |
| `mcp/` | the server (tools, resources, instructions) and its words |
| `commands/` | `serve.ts`, `ops.ts` (read and sync), `admin.ts` (state-changing) |

### 4.2 The route table (SEC-5, API-9, CMP-13, API-27)

| Method | Host | Path | Callers |
|---|---|---|---|
| POST | oauth2.googleapis.com | `/token` | cli, serve |
| GET | youtube.googleapis.com | `/youtube/v3/channels`, `/playlistItems`, `/videos` | cli, serve |
| GET | youtubeanalytics.googleapis.com | `/v2/reports` | cli, serve |
| GET | youtubereporting.googleapis.com | `/v1/reportTypes`, `/v1/jobs`, `/v1/jobs/{id}/reports`, `/v1/media/**` | cli, serve |
| POST | oauth2.googleapis.com | `/revoke` | cli (src/admin/) |
| POST | youtubereporting.googleapis.com | `/v1/jobs` | cli (src/admin/) |
| DELETE | youtubereporting.googleapis.com | `/v1/jobs/{id}` | cli (src/admin/) |

HTTPS only, exact hosts, no `www.googleapis.com`, no credentials in URLs, port 443. `redirect: 'error'` except on a
report download, which may follow a redirect only to another download route of the table; the access token is sent only
to the host its route names; a download host outside the table is refused with nothing sent, and every host a report
came from is recorded. Retries (with backoff and `Retry-After`) only for GETs and the refresh grant; never for the code
exchange, `jobs.create`, `jobs.delete` or `/revoke`. Body caps (8 MB JSON, 256 MB decompressed downloads). No
credential when `NODE_TLS_REJECT_UNAUTHORIZED=0`. The server builds its clients with the core routes only and latches
them read-only; `test/importGraph.test.ts` proves it never imports `src/admin/`, and `test/routes.test.ts` runs every
command and tool against a recording fake.

### 4.3 Sign-in (CLI only)

`creatorlens auth --profile <p>`: a TTY; terms accepted; a loopback listener on `127.0.0.1:0`; PKCE S256 with
`code_challenge_method` sent; a 32-byte state compared in constant time; `access_type=offline`, `prompt=consent`; the
URL always printed and opened with `/usr/bin/open` only after checking it starts with `https://accounts.google.com/`;
exactly one matching callback (GET, the right Host, the right state), a static `no-store` page, then closed; a 5-minute
timeout; the code exchanged once. The grant's scopes must equal the two requested (as a set), else the new token is
revoked and nothing is stored. `channels.list mine=true` must return one channel; the owner confirms its name and id by
typing `yes`; a profile already bound to another channel refuses. The operator says whether the app is In production
or Testing; the consent date is recorded; `refresh_token_expires_in` is recorded when present but never relied on.
The refresh token goes to the Keychain with a read-back; the access token stays in memory.

### 4.4 Reporting jobs (CLI only) and the daily sync

`reporting enable` lists the channel's report types and its jobs, and creates a job for every family's newest version
that is not deprecated and not system-managed, after a typed confirmation; each job is stored with the Cloud project
number. A type with a deprecation date keeps its job while its successor's is created beside it. `reporting disable`
deletes only the jobs creatorlens created (their name starts with `creatorlens `).

`sync` (scheduled daily, or by hand) writes only the local store and archive, ordered by how soon data is lost:

1. the policy clocks, then the identity check (`channels.list mine=true` must return the bound channel; a mismatch
   stops everything);
2. Reporting: report types (deprecations), jobs (expiry, gone jobs), then for every job every listed report not yet in
   the archive is downloaded to `reports/<type>/<YYYYMMDD of the Pacific day>_<createTime>_<reportId>.csv.gz` (0600,
   atomic), with a `report_files` row (ids, period, createTime, `jobExpireTime`, host, path, SHA-256 of the CSV, sizes,
   data rows by RFC 4180, header); restatements are marked `superseded_by` the newest; a full sync re-verifies every
   file's hash and fetches a damaged one again while Google still lists it;
3. own metadata: the channel row and every upload's metadata, with the publish day in Pacific time; a video no longer
   returned loses its metadata at once;
4. the clocks again, then freshness: a newest report older than 4 days warns and notifies.

A run's row is written before any work, with its trigger and app version; two failed scheduled runs in a row, a stale
archive, reports near expiry that could not be downloaded, and a lost sign-in each raise a local notification (at most
once a day each). The project's Data API units are counted per Pacific day; a 403 `quotaExceeded` marks the bucket
spent until the next Pacific midnight.

### 4.5 Schedule and install

`install` (from the clone, TTY) runs the tests, then copies the build, its documents and its runtime packages into
`~/Library/Application Support/creatorlens/app/<version>/` and checks the copy starts. `schedule install` refuses to
schedule anything but such a copy, and writes `~/Library/LaunchAgents/io.github.yrkan.creatorlens.<profile>.sync.plist`:
absolute `ProgramArguments` (the running node binary and the pinned `cli.js`), 07:30 daily, `RunAtLoad`, `Umask 63`,
background priority, logs in the profile's private folder, no environment and no secret. `serve` starts a detached
catch-up sync when a profile's last success is older than 26 hours. `doctor` checks the scheduled node exists and is
≥ 24.15, the scheduled app exists and is pinned, and the agent is loaded.

### 4.6 What no API gives

Search volume and autocomplete; YouTube Studio's Research, Trends and Inspiration; Test & compare; unique, new and
returning viewers; audience overlap; "Stayed to watch" and "Shown in feed" for Shorts; real-time figures; viewer
interface language and audio-track splits (caption language comes from the subtitles report); clicks to external sites;
community posts (a pilot since 2026-11-16, re-check in 2027); other channels' private analytics.

## 5. The store

One SQLite file per profile (`profiles/<p>/store.db`, WAL, `secure_delete` always on, 0600), migrated forward only;
a store with a newer schema is refused; a copy is made before migrating an existing store. v0's tables (schema 1):

| Table | Grain | Retention class |
|---|---|---|
| `meta` | key → value (binding, clocks, settings) | bookkeeping |
| `channel` | the bound channel | own metadata, 30 days unless refreshed |
| `videos` | one row per own video | own metadata, 30 days unless refreshed |
| `report_types` | one row per offered report type | bookkeeping |
| `jobs` | one row per Reporting job | bookkeeping |
| `report_files` | one row per archived report file | Authorized Data, kept while authorized |
| `sync_log` | one row per run, written first | bookkeeping |
| `events` | policy and binding events (no data, no secret) | bookkeeping |

Every column has an origin in `src/store/schema.ts` (`owner`, `google`, `creatorlens`, `third_party`); a third-party
text column must be named `untrusted_*` (a test holds both directions). v0 stores no stranger's text. Other channels'
data will live in `public.db`, never attached to a profile's store, never backed up, excluded from Time Machine, purged
at 30 days.

**v1 adds** (YT2.8): `rpt_*` tables at each report's own grain, filled from the archive, each (type, period) replaced in
one transaction by the newest createTime, columns read by header name (required ones checked, drift fails loudly, new
ones tolerated), empty `video_id` rows kept as a channel-level bucket without a foreign key, a SUM check against
Analytics, `reimport`; `definitions` (metric, source, valid_from, valid_to, text, source_url, read_on) and the caveat
codes; `series`, `notes`, `change_events`, `video_hourly`, `site_daily`, retention per video × window × audience type;
the views `v_video_day`, `v_video_by_age`, `v_video_country`, `v_search_terms_day`, `v_retention_latest`,
`v_reach_video_day`, `v_uploads`, `v_videos_labeled`; lookups for traffic sources, playback locations and categories.
Non-additive columns end in `_avg`, `_pct` or `_ctr` and are never summed.

## 6. Policy and privacy

### 6.1 The threat model

- **Private data:** analytics, unlisted and private videos' metadata, the raw files.
- **Strangers' text:** search terms, referrer pages, (v2) comments and other channels' titles may carry instructions to
  the assistant. Inside Claude Code the same assistant may have a shell, web access and servers that send mail: an
  injection can exfiltrate, not merely mislead.
- **The ways out:** the AI client and its other tools; anything running as the user (the Keychain does not stop it).

Defences: strangers' text cleaned when stored (NFC; C0/C1, bidi, zero-width, tag and variation-selector characters
removed; comments cut at 500 characters, descriptions at 1,000, the cut marked) and wrapped `{"untrusted": "…"}` in
every tool, `sql_query` included (the child reports reads of `untrusted_*` columns, through views and expressions);
strangers' free text never in the same answer as Authorized Data; comments only in v2, on an explicit call; install
with `--scope local` in an analysis folder whose settings deny the Keychain read, the state-changing commands and the
data folder, and keep the shell, web fetches and other servers' write tools on "ask"; the state-changing commands need
a TTY and a typed confirmation (a speed bump the model's shell cannot pass); a stdio injection fixture and a "no
credential in any output" test.

### 6.2 The clocks (`src/policy.ts`)

| Clock | Rule |
|---|---|
| revocation | `revoke` offers to delete the jobs (it needs the token), POSTs `/revoke`, then deletes every table, the archive, the backups, the logs, the configured transcripts and the token, in the same run, and prints that nothing was deleted on YouTube |
| lost sign-in | a definitive refresh failure (`invalid_grant` with its `error_subtype`, `invalid_client`, `deleted_client`, …) sets `auth_lost_at`; sync stops; every answer and command carries a banner; a notification once a day; at `last_refresh_ok_at` + 28 days everything is purged unless the same channel signed in again |
| unconfirmed sign-in | no successful refresh for 30 days for any reason: the next networked check tries once, and purges on failure; the server blocks own-data answers and starts a catch-up sync |
| own metadata | titles, descriptions, tags and the channel row cleared when not refreshed for 30 days; a deleted video's at once |
| other channels' data | `public.db` rows older than 30 days deleted (and any table that cannot be aged) |
| creatorlens's copies | backups (pre-migration, `purge --all`) deleted after 7 days |

Checked at `serve` start, on every tool call, on every command and in every sync. Deletion runs with `secure_delete`,
then `wal_checkpoint(TRUNCATE)` and `VACUUM`. The Testing-mode warning runs from consent day 5 until a refresh after
day 8 proves the app is In production (or always, when the operator said Testing).

### 6.3 Privacy and terms

`docs/privacy.md` (YouTube API Services; Google's Privacy Policy; what is fetched, where it is stored; that tool results
go to the AI client and its model provider and stay in its transcripts under `cleanupPeriodDays`; that installing into
a client is the owner's approval of that provider; comments as third parties' personal data; retention; revocation and
purge; a contact) and `docs/terms.md` (bound by YouTube's Terms; the operator model; no service to others; no derived
metrics; no warranty; not affiliated). `setup` shows both and records a typed acceptance with the version; a change of
either changes the version and asks again (`test/terms.test.ts`). `docs/policy.md` maps each policy rule to its code.

## 7. MCP tools

**v0** (all `readOnlyHint: true`, `destructiveHint: false`, local, strict inputs):

| Tool | Returns |
|---|---|
| `status` | identity per profile, sign-in state and clocks, jobs (newest report, deprecation, expiry), freshness, schedule, warnings, banners; no audience figure, no stranger's text |
| `describe_store` | the profile's tables, grain, retention, each column's origin and meaning, row counts, example queries |
| `sql_query` | one read-only SELECT in the child sandbox; strangers' text wrapped |

**v1** (by 2026-12-18): 16 tools. Common inputs: `profile`; one period grammar (`last_7d`, `last_28d`, `last_90d`,
`lifetime`, `YYYY-MM-DD..YYYY-MM-DD`, `YYYY-MM`) anchored at `data_through` and compared with a window of equal length,
or an age window (`first_1d/3d/7d/28d` with `day0_hours`); one `videos` selector; `detail`, `fields`, `limit` and a
cursor; flat strict schemas. Common output: a meta block (channel, profile, `data_through`, the window in "YouTube
days, Pacific time", sources, caveat codes, `stale`, the auth clock) and a columnar table, ≤ 3k tokens by default.

| Tool | Returns |
|---|---|
| `status` | as v0 |
| `find_videos` | one match, or candidates without figures, for an id, any URL form (parsed, never fetched), `latest`, `latest:short` or a title |
| `channel_review` | the week in one call: windows, totals by content type, new uploads at days 1, 3, 7 against earlier ones of the same age, traffic, search terms, definition breaks |
| `videos_table` | one row per video: views, engagedViews, minutes, subscribers, likes, comments, shares, Shorts-feed and search views, impressions; averages from live Analytics for the exact window |
| `video_report` | one video: lifetime and first 1/7/28 days, the daily series, retention checkpoints, traffic, search terms, reach, countries |
| `video_card` | the stable export for the skills, schema `creatorlens.card/1`, with a `missing` list (never a 0 for absent data) |
| `video_retention` | Google's values at checkpoints in seconds (audienceWatchRatio, relativeRetentionPerformance, started and stopped watching, segment impressions) |
| `video_now` | hourly snapshots of an upload younger than 72 hours |
| `channel_traffic` | views by source; presets `search_terms` and `shorts_vs_search` |
| `channel_reach` | summed thumbnail impressions and Google's daily CTR rows, never a period CTR; labelled "thumbnail impressions (not Shorts-feed shows)" |
| `channel_audience` | Google's figures by country, age and gender, device and more, for the exact window |
| `compare` | raw figures side by side, windows aligned on an event, the change day left out |
| `metadata_check` | the live title, description, tags, languages and flags against an `expect` the skill passes; compared, not stored |
| `describe_store`, `sql_query` | as v0 |
| `sync_now` | a detached quick sync, at most once in 15 minutes; `readOnlyHint: false`, `idempotentHint: true` |

Resources: `creatorlens://schema`, `creatorlens://glossary`, `creatorlens://privacy` (v0). Prompts (v1):
`weekly_review` (thin, over `channel_review`, the answer in the owner's language) and `video_postmortem`. Server
instructions (≤ 4,096 characters) open "Read-only analytics of your own YouTube channel" and route `status` first; every
tool description opens "YouTube …". **v2:** `public_search`, `public_channel`, `public_videos`, comments on own videos
(explicit call, RMF fields), the full `analytics_query` validator, prompts `series_review`, `title_change`,
`comments_digest`, `posting_time`. **Rejected:** a "trending" tool (`chart=mostPopular` returns only Music, Movies and
Gaming since 2025-07-21), Analytics groups through the API, any model-triggered sign-in or job creation, transcripts.

## 8. Command line (v0)

`setup`, `auth`, `reporting enable|disable|status`, `sync [--full] [--all]`, `schedule install|remove|status`,
`status [--json]`, `doctor [--json] [--offline]`, `sql`, `logs`, `purge --all|--backups|--public`, `revoke`, `install`,
`transcripts add|remove|list`, `mcp-config`, `serve`. State-changing commands need a TTY and a typed confirmation.
`status --json` is the skills' read (an allow rule for exactly that command). v1 adds `reimport`, `labels import`,
`import site`, `note add`, `series set`, `backup`, `restore`, `export`, `uninstall`, `card --json`, `review --json`,
`doctor --deep`.

## 9. Repository and supply chain

Public at github.com/yrkan/creatorlens (created private; made public after the pre-publication review and gitleaks 0),
MIT. Runtime: `@modelcontextprotocol/server` 2.4.0 and `zod` 4.6.7, exact (three packages in all). Development:
`typescript` 5.9.3, `@types/node` 26.6.6. pnpm 10.28.0 pinned with its hash; `minimumReleaseAge 10080`, `trustPolicy
no-downgrade`, `strictDepBuilds`, `blockExoticSubdeps`, no build scripts allowed. No install scripts, no telemetry, not
on npm (decision ★10 is the owner's). CI: Node 24 and 26 on Ubuntu and macOS (typecheck, tests, the dependency count,
`pnpm audit --prod`), gitleaks over the whole history, zizmor; actions pinned by commit; `permissions: contents: read`;
no secrets; Dependabot with a 7-day cooldown. A pinned gitleaks pre-commit hook with Google's rules (`GOCSPX-`,
`ya29.`, `1//0`, client-secret JSON). Synthetic fixtures only (`UCzz…`, `zz…`); a test fails on any other id and on the
first owner's channel id by its hash. Fake secrets are built at run time, so no literal matches a scanner.

## 10. Tests (v0)

`node:test`, no network: names; repository hygiene; terms version; text cleaning, redaction, the terminal printer, CSV,
Pacific days; OAuth (PKCE, state, loopback, scopes, client JSON, error map, the whole `auth` flow); secret stores (a fake
`security`, file modes, symlinks); the route table, latch, redirects, retries, TLS switch and caps; the import graph;
every command and tool against the recording fake; Reporting (job choice, enable, the archive and its ledger,
restatements, header-only and gzip files, an unknown host, lifetimes, pending states, a changed channel); the policy
clocks on a fake clock (revoke, lost sign-in at 28 days, unconfirmed at 30, metadata at 30, public.db at 30, backups at
7, the check on every call, Testing mode); the SQL sandbox (VACUUM INTO, ATTACH, `WITH … DELETE`, PRAGMA, a leading
comment, two statements, `load_extension`, `randomblob(1e9)`, a recursive CTE and a cross join answered within 6 s,
caps, wrapping through views and expressions); the stdio contract against the built server (tools, annotations, strict
inputs, an injection fixture, JSON-RPC only on stdout, no credential in any output); the schedule; doctor green and red;
the pinned copy serving on its own.

## 11. The owner's setup

[owner-setup.md](owner-setup.md): the Google Cloud steps (one project, three APIs, Google Auth Platform with the two
scopes, published In production, a Desktop client) and the Mac steps (build, install, setup, six sign-ins, jobs, sync,
schedules, doctor, `claude mcp add --scope local` in `~/YouTube-analysis`). Background: [google-cloud.md](google-cloud.md).

## 12. Every review finding and its decision

"v0" is built in 0.1.0 (by Fri 2026-11-27); "v1" lands by Fri 2026-12-18; "v2" by need. "Where" names the v0 code or test.

### 12.1 A findings (11)

| ID | Finding | Decision | When · where |
|---|---|---|---|
| SEC-1 | "an injection can at most mislead" is false inside Claude Code | § 6.1 rewritten; columns tagged by origin; strangers' text cleaned, cut and wrapped in every tool incl. SQL; comments only on explicit call; `--scope local` with write tools on "ask"; injection and no-credential tests | v0 · `util/text.ts`, `sql/`, `store/schema.ts`, `test/stdio.test.ts`, `test/sql.test.ts` |
| SEC-2 | the trademark in names | "creatorlens" in repo, package, command, server, OAuth app "creatorlens (personal)", Keychain service, label `io.github.yrkan.creatorlens.<profile>.sync`; `search_youtube` → `public_search`; the not-affiliated line; a name test | v0 · `version.ts`, `test/names.test.ts` |
| API-1 | the 7- and 30-day deletion deadlines are missing | the clocks of § 6.2, checked at start and on every call; revoke purges in the same run with the III.E.4.g notice; fake-clock tests | v0 · `policy.ts`, `check.ts`, `test/policy.test.ts` |
| API-2 | = SEC-1, plus a planted comment can order exfiltration | as SEC-1; strangers' free text never in the same answer as Authorized Data; titles and counts by default; answer caps | v0 rule, v1/v2 tools |
| API-3 | = SEC-2, plus domains and logos | no YouTube mark in any domain or logo; "Search YouTube" only as a descriptive action inside a description | v0 |
| UX-1 | = SEC-2, plus a crowded name and an unclaimed npm name | "not on npm" in the README until the owner decides (★10); never an `npx` line; "for YouTube" only in tagline, topics, README's first line, instructions and descriptions | v0 · README |
| UX-2 | = SEC-1, plus invisible tag characters pass review | cleaning removes tag and variation-selector payloads; `untrusted_*` columns only; authors left out unless asked | v0 · `util/text.ts`, `test/text.test.ts` |
| UX-3 | ratios re-aggregated into wrong figures | only additive columns summed; period averages from live Analytics; no period CTR (decision 6, option b); `_avg/_pct/_ctr` marked; tests where AVG(daily CTR) ≠ weighted | v1 |
| CMP-1 | = SEC-2, plus a name test | a test fails on "youtube", "tube" or "yt" as a word in any of our names | v0 · `test/names.test.ts` |
| CMP-2 | = API-1, plus the 30-day limit on own metadata | revoke acts without asking (beyond the typed confirmation); purge at `last_refresh_ok_at` + 28 days; metadata deleted when unrefreshed 30 days; `docs/policy.md` | v0 · `policy.ts`, `docs/policy.md` |
| CMP-3 | the Reporting import corrupts or loses history | every CSV kept gzipped as the source of truth; `report_files`; restatements superseded; parsing by header, period replacement, empty-id bucket, SUM test and `reimport` in v1 | v0 archive (`archive.ts`, `test/reporting.test.ts`), v1 parsing |

### 12.2 B findings: security (10)

| ID | Finding | Decision | When · where |
|---|---|---|---|
| SEC-3 | SQL escapes a read-only connection (VACUUM INTO, ATTACH, two statements) | Node ≥ 24.15; `readOnly`, `allowExtension: false`, `limits` (attach 0…); defensive; deny-by-default authorizer; one-statement gate; tests | v0 (ahead of plan) · `sql/runner.ts`, `test/sql.test.ts` |
| SEC-4 | a query can freeze the server | a forked child per query, `iterate()`, row and byte caps, SIGKILL at 5 s, one at a time, `temp_store=MEMORY`; runaway tests answered within 6 s | v0 (ahead of plan) · `sql/sandbox.ts` |
| SEC-5 | revoke and `jobs.delete` break the method rule; "CLI path only" is no mechanism | the route table of § 4.2; admin routes in `src/admin/`, never imported by `serve` (graph test); a read-only latch; no `www.googleapis.com`; `redirect: 'error'` except downloads; no retry of the code exchange or `jobs.create` | v0 · `google/`, `admin/`, `test/importGraph.test.ts`, `test/http.test.ts` |
| SEC-6 | the token sits beside the model's shell | SECURITY.md says what the Keychain does not do; TTY and typed confirmation for purge, revoke, reporting, schedule, auth, setup, install, transcripts; `purge --all` keeps a dated copy 7 days; deny rules and `denyRead` in the README; the runbook | v0 · `util/tty.ts`, `test/tty.test.ts`, SECURITY.md |
| SEC-7 | Keychain mechanics and a silent file fallback | `security -i`, base64, read-back, the 4,095-byte limit; a file store only with `--token-store file` (`wx` 0600 in 0700, fsync, rename, `lstat`) | v0 · `secrets.ts`, `test/secrets.test.ts` |
| SEC-8 | Windows | unsupported in v1; `doctor` says so; no Windows runner | v0 decision |
| SEC-9 | what counts as a revocation | the state machine of § 6.2; each profile bound to its first channel id; `secure_delete`, `wal_checkpoint(TRUNCATE)`, `VACUUM` | v0 · `policy.ts` |
| SEC-10 | results reach the model provider and its transcripts | privacy.md: the flow to the provider, approval by installing, transcripts under `cleanupPeriodDays`, comments as personal data purged at 30 days; a `creatorlens://privacy` resource; optional purge of named transcript folders | v0 · `docs/privacy.md`, `mcp/server.ts`, `transcripts` |
| SEC-11 | secrets in a public repo | push protection and secret scanning once public; a pinned gitleaks pre-commit hook with Google's rules; `.gitignore`; synthetic fixtures and a test for real ids; `doctor` redacts; an issue template; noreply commits; `setup` offers to delete a client JSON found inside a git tree | v0 · `.gitleaks.toml`, `.githooks/`, `test/hygiene.test.ts` |
| SEC-12 | the SDK's supply chain | `@modelcontextprotocol/server` 2.4.0 `./stdio`, exact (spiked: tools, resources, annotations and strict schemas over stdio work); CI prints the closure and fails on growth without a CHANGELOG line; `pnpm audit --prod` | v0 · `scripts/count-deps.mjs` |

### 12.3 B findings: API and policy (12)

| ID | Finding | Decision | When · where |
|---|---|---|---|
| API-4 | terms, privacy and acceptance | `docs/terms.md`; `setup` shows the Terms, the privacy policy and the terms, takes a typed acceptance with version and date, asks again when either changes; privacy.md as § 6.3; the operator model in `docs/policy.md` | v0 · `commands/admin.ts` setup, `test/terms.test.ts` |
| API-5 | derived metrics | Google's figures and labelled sums reconciled with Analytics only; no scores, ratios, cross-channel rankings, outliers, sentiment or inferred content type; relativeRetentionPerformance never relabelled; no III.L application | v1 (rule in v0 docs and instructions) |
| API-6 | ratios summed across rows | as UX-3; per-row averages dropped from aggregate views | v1 |
| API-7 | jobs stop silently | types by family from `reportTypes.list` (newest, not deprecated, not system-managed); job ids with the project number; `expireTime`, `jobExpireTime`, `deprecateTime` in sync, status and doctor; the successor created before a deprecation; an alert when the newest report is older than 4 days (decision 15) | v0 · `reportingPlan.ts`, `sync.ts`, `test/reporting.test.ts` |
| API-8 | backfills, empty ids, missing rows, column order | as CMP-3; `data_through` = every expected report loaded; channel totals from Analytics; § 3 corrected (60 days; 30 days historical); historical reports downloaded as soon as they are listed | v0 archive, v1 parsing |
| API-9 | = SEC-5 | exceptions by method, host and path; a separate client the server does not build; a test that no tool reaches them | v0 · `test/routes.test.ts` |
| API-10 | Testing-mode detection | the field optional; the consent date recorded; `auth` asks which mode applies; warnings from day 5 until a refresh after day 8; `error_subtype` read; the other ends of a token listed | v0 · `policy.ts`, `google/oauth.ts` |
| API-11 | own metadata limited to 30 days | refreshed at every sync even when other steps fail; cleared at 30 days; a deleted video's metadata cleared at once; comment text purged at 30 days (v2) | v0 · `policy.ts` expireMetadata, `sync.ts` |
| API-12 | content type must not be inferred | the Shorts split only for own videos through `creatorContentType`; public videos show duration only; duration filter named by meaning; no UUSH or UULF | v1/v2 |
| API-13 | the query validator | `channel_reports` tables as data; documented sorts only; content type from the store; the 50,000 limit splits the range; no `uniques`; monetary metrics refused | v1 subset, v2 full |
| API-14 | reach may not cover the Shorts feed | "thumbnail impressions (not Shorts-feed shows)" in the glossary and every reach answer; reach by source beside views of the same surface; the earliest reach day; the week-1 spike against YouTube Studio | v0 glossary, v1 tools, spike by 2026-12-18 |
| API-15 | definition breaks | a `definitions` table and `DEF_BREAK` codes for the dates of § 3; an engagedViews probe for 2024 at setup; no "continuous series" anywhere | v0 glossary, v1 table |

### 12.4 B findings: assistant UX (14)

| ID | Finding | Decision | When |
|---|---|---|---|
| UX-4 | no way to name a set of videos | one `videos` selector; playlists synced; `default_audio_language` kept; labels by import; a `series` table with `filters=video==` (≤ 500 ids), not Analytics groups (decision 11) | v1 |
| UX-5 | no output budget | 2–4k tokens by default, ≈ 20k at most; `detail`, `fields`, `limit`, cursor; columnar tables; a cut result says how to get the rest | v1 |
| UX-6 | ambiguous video inputs | one resolver; candidates without figures; `find_videos`; `video`/`videos`/`channel` names; comments filter `contains` | v1 |
| UX-7 | no period grammar | § 7's grammar anchored at `data_through`; equal comparison windows; "YouTube days, Pacific time" echoed | v1 (Pacific days in v0: `util/pacific.ts`) |
| UX-8 | missing caveats | definitions as data; caveat codes `DEF_BREAK`, `WITHHELD`, `LOW_N`, `PARTIAL_DAY0`, `SUBS_WATCH_PAGE_ONLY`, `LOGGED_IN_SHARE`, `STUDIO_DIFFERS`, `THUMB_NOT_FEED`; the scope's total when a breakdown undercounts | v0 glossary, v1 |
| UX-9 | the hook question | retention per video × window × audience type with all five metrics; `video_retention` with checkpoints in seconds; labels from the repository | v1 |
| UX-10 | no history of changes | `change_events` (no old text past 30 days), `note add`, `compare` around an event; thumbnails → Test & compare | v1 |
| UX-11 | a new Short's first hours | `video_hourly` for uploads under 72 h (1 unit per 50 videos); `video_now`; publish time in UTC, Pacific and local | v1 (Pacific publish day in v0) |
| UX-12 | a store Claude cannot describe | `describe_store` (built in v0 for v0's tables); raw `rpt_*` at report grain; the views and lookups of § 5 | v0 tool, v1 tables |
| UX-13 | search terms capped and duplicated | bulk rows for the job's days and the top 25 before; source and grain said; stored data never capped; the anonymised share | v1 |
| UX-14 | the weekly review takes 5–7 calls | `channel_review` in one call; `weekly_review` a thin prompt | v1 |
| UX-15 | nothing links uploads to site arrivals | `import site` from a SELECT-only export into `site_daily`, labelled "not from YouTube"; `uploads_vs_site` | v1 |
| UX-16 | NVM paths and a silently stopped schedule | `process.execPath` in the plist and the MCP line; `mcp-config`; doctor checks the scheduled node; `stale` after 4 days; days left before expiry; local notifications | v0 · `schedule.ts`, `doctor.ts`, `commands/ops.ts` |
| UX-17 | tools not found among other servers | instructions ≤ 4,096 characters opening "Read-only analytics of your own YouTube channel"; every description opens "YouTube …"; prefixes `channel_`, `video_`, `public_` | v0 · `mcp/text.ts`, `test/stdio.test.ts` |

### 12.5 B findings: completeness (19)

| ID | Finding | Decision | When · where |
|---|---|---|---|
| CMP-4 | too much before the first upload | v0, v1, v2 as § 0 | — |
| CMP-5 | report types left out lose their history | a job for every non-system type the channel is offered (subtitles, province, combined, end screens, cards, playlist reports included); reach keeps detail, device and OS (v1); non-goals named: memberships, live concurrent viewers, revenue | v0 · `reportingPlan.ts` |
| CMP-6 | = API-14 | for Shorts lead with engagedViews against views, SHORTS and SHORTS_FEED, and retention | v1 |
| CMP-7 | no language-series concept | `series(video_id, series, source)` from `defaultAudioLanguage` plus `series set`; figures from `filters=video==`; separate uploads per language (six channels already) | v1 |
| CMP-8 | = UX-15 | the import and the UTM convention (plan YT8.2); a site block in `channel_review` | v1 |
| CMP-9 | Pacific days | publish time in UTC with `published_day_pt`; day 0 possibly partial and said; periods end at `data_through`; DST and UTC+2/+3 tests | v0 day logic (`test/text.test.ts`), v1 periods |
| CMP-10 | a brand-new channel's states | `no_channel`, `no_uploads`, `pending_first_report` (creation + 48 h), `no_rows_yet`, `possibly_below_threshold`, `unclassified_content_type`; never 0 for missing data; channel confirmed at auth | v0 states in status/auth, v1 the rest |
| CMP-11 | failures go unnoticed | notifications (two failed runs, stale, near expiry, lost sign-in); a stale banner; log rotation and `logs`; a run's row first; `trigger` and `app_version`; `doctor --json` | v0 · `sync.ts`, `util/log.ts`, `util/notify.ts` |
| CMP-12 | a second channel mixed in | `channel_id` bound at auth; every sync compares and refuses a mismatch; every answer names its channel; one quota ledger per project number | v0 · `sync.ts`, `google/quota.ts`, `test/reporting.test.ts` |
| CMP-13 | = SEC-5 | the server's client is built without the CLI-only routes; a test walks every tool and command | v0 · `test/routes.test.ts` |
| CMP-14 | = API-7 | deprecations and expiries stored at every sync; status, doctor and warnings say what to run before which date; the project number beside each job; whether jobs are visible across projects checked by `doctor --deep` | v0, contract test v1 |
| CMP-15 | = UX-10 | `notes` through `note add`; a dated "field changed" marker; `compare around_note` | v1 |
| CMP-16 | no backup, restore, export or uninstall | `backup` (own data only), `restore`, `export` with a warning, `uninstall`; Time Machine documented; copies purged on revoke (already in v0: backups are part of every full purge) | v1 |
| CMP-17 | upgrades, concurrency, NVM | the upgrade procedure (owner-setup.md); a pinned copy outside the clone; absolute `execPath`; version check at start; `app_version` and `schema_version`; a newer schema refused; a copy before each migration; one writer lock; `busy_timeout` | v0 · `install.ts`, `store/db.ts`, `util/lock.ts`, `test/store.test.ts`, `test/install.test.ts` |
| CMP-18 | = SEC-3, SEC-4 | Node ≥ 24.15 (not 24.10: `limits` arrived in 24.15); CI on 24 and 26; a `Database`/`DatabaseSync` wrapper | v0 · `store/sqlite.ts` |
| CMP-19 | the 2025–26 Google Auth Platform | a guide to its four pages (the one-time secret, Audience → Publish app, the unverified screen, the Brand Account choice, the three APIs); `setup` accepts only an installed client; auth and doctor record the date and warn about Testing; every OAuth error mapped. No screenshots: no agent reads Google's pages by machine | v0 · `docs/owner-setup.md`, `docs/google-cloud.md` |
| CMP-20 | = SEC-10, API-4 | transcripts beyond purge disclosed, with how to finish a purge there; a contact (issues, private advisories); the policy version accepted at setup; the anti-goal "no network transport" | v0 |
| CMP-21 | parsing and validator untested against reality | header-driven fixtures (header-only, reordered and new columns, empty `video_id`, restatement, gzip, quoted terms, Cyrillic, Turkish, emoji) and round trips; the validator as data; `doctor --deep` live contract test; `fixtures capture --redact` | v1 (v0: header-only, gzip, quoted, Cyrillic, Turkish, emoji in `test/text.test.ts` and `test/reporting.test.ts`) |
| CMP-22 | Windows and Linux schedulers | Windows unsupported; Linux in v2 (systemd timer `Persistent=true`, secret-tool with a stop, not a fallback) | v2 |

### 12.6 C findings (36)

| ID | Disposition | When |
|---|---|---|
| SEC-13 | `sync_now`: `readOnlyHint: false`, `idempotentHint: true`; quick only, once in 15 minutes; 30 % of the general quota reserved for sync; an hourly search cap; a lock; quota spent in one conditional UPDATE | v1 (the lock and atomic ledger in v0) |
| SEC-14 | OAuth details: `listen(0, '127.0.0.1')`; S256 explicit; 32-byte state in constant time; one matching callback, Host checked, static no-store page; scopes as a set; installed client only; `/usr/bin/open` after the URL check; the URL printed | v0 · `admin/oauthFlow.ts`, `test/oauth.test.ts` |
| SEC-15 | one terminal printer escaping control, bidi and zero-width characters; a test with `ESC]52` and U+202E | v0 (ahead of plan) · `util/text.ts` |
| SEC-16 | one redaction function; access tokens in memory only; no credential when TLS checks are off; logs 0600 rotated; a planted-secret test | v0 · `util/redact.ts`, `util/log.ts`, `test/stdio.test.ts` |
| SEC-17 | a pinned copy; plist with absolute arguments, no secrets, `Umask` 63; validated profile names; the `io.github.yrkan.creatorlens.<profile>.sync` label | v0 · `schedule.ts`, `install.ts` |
| SEC-18 | pnpm `minimumReleaseAge 10080`, `trustPolicy no-downgrade`, `strictDepBuilds`, `blockExoticSubdeps`, pinned package manager; read-only workflows without persisted credentials or `pull_request_target`; zizmor; Dependabot with a cooldown; signed tags and provenance at the first release | v0 (signed tags with the first release) |
| SEC-19 | the API key in the secret store through a hidden prompt; the environment only for tests; never through an MCP client's env | v2 |
| SEC-20 | the ETag cache keyed by credential kind and URL, inside the store, purged by the clocks; `public.db` separate and excluded from Time Machine; stdio only | v1, v2 |
| API-16 | `doctor` tries `commentThreads.list` with the token and with the key | v2 |
| API-17 | one search page by default, labelled as the Data API's ranking for a region and language; order and text untouched; "Source: YouTube" | v2 |
| API-18 | comments with full text or a fetchable id, the uploader's channel and the video title (RMF) | v2 |
| API-19 | retention keyed by start and end date and audience type, one query per type, the three counts stored | v1 |
| API-20 | both search-term sources, labelled, with the anonymised share | v1 |
| API-21 | no monetary scope; the subtitles job created; groups unused; `content_type` nullable with the day it was seen | v0 (jobs), v1 |
| API-22 | quota shown as estimates; a 403 `quotaExceeded` marks the bucket spent until Pacific midnight | v0 · `google/quota.ts`, `google/api.ts` |
| API-23 | one dedicated project for all profiles; the client JSON never committed; the project used at least every 90 days (the daily sync) | v0 · docs, `.gitignore`, `.gitleaks.toml` |
| API-24 | after consent the channel's title and id shown and confirmed, and checked at every sync | v0 · `commands/admin.ts` auth, `sync.ts` |
| API-25 | covered by SEC-13, SEC-4 and SEC-8 | — |
| API-26 | `data_through` from the newest row returned; the last 7 Analytics days fetched again at every sync; Pacific calendar dates compared | v1 |
| API-27 | the download host logged at the first run; an unknown host fails closed; Authorization never beyond the route's host | v0 · `google/http.ts`, `profile.ts` recordMediaHost |
| UX-18 | 16 tools (§ 7) | v1 |
| UX-19 | prompts check freshness first, compare like with like, quote caveat codes, answer in the owner's language, say what the API cannot tell; `topic_research` dropped (the studio researches markets) | v1 |
| UX-20 | a flag for every setup question (`--client-json`, auto-detected in Downloads); secrets only in the owner's terminal; `--json` for doctor and status; console deep links; auth asks about Testing | v0 · `commands/admin.ts`, `doctor.ts` |
| UX-21 | public videos: age in days and publish time; content type unknown, duration only as a hint; `DEF_BREAK` on public counters | v2 |
| UX-22 | comments: 50 by default, a length cap, `since`, the owner's own excluded, `include_replies`, counts first, no authors unless asked, `imageUrl` never fetched | v2 |
| UX-23 | = SEC-13; progress notifications; returns what was refreshed | v1 |
| UX-24 | adopt categories, playlists, the date grammar and replies; reject trending (`chart=mostPopular` returns only Music, Movies and Gaming since 2025-07-21) | v1, v2 |
| UX-25 | the subtitles job; a view by subtitle language; a caveat code on Shorts reach until the spike | v0 (job), v1 |
| UX-26 | an eval set of the ten owner questions on a seeded store: expected tools, maximum calls and tokens, facts the answer must hold; run by hand before each release | v1 |
| CMP-23 | `RunAtLoad`; `serve` starts a detached sync after 26 hours; work ordered by perishability; quota and rate errors handled; network retries | v0 · `schedule.ts`, `commands/serve.ts`, `sync.ts`, `google/http.ts` |
| CMP-24 | = API-19 | v1 |
| CMP-25 | = UX-5; `sync_now` returns at once and runs detached; flat schemas (v0's tools already have no root anyOf) | v0 schemas, v1 |
| CMP-26 | = SEC-12; the README states the full production dependency count (three) | v0 |
| CMP-27 | SemVer from 0.1.0; a tag and a GitHub Release per version with its schema version; npm per decision ★10; issue and PR templates with a redaction reminder; the MCP Registry later; branch protection; private advisories | v0 (templates, SemVer, advisories), v2 (registry) |
| CMP-28 | public research in its own `public.db`, never attached or backed up | v0 clock (`store/publicDb.ts`), v2 data |
| CMP-29 | posts are a pilot (re-check in 2027); caption language from the subtitles report; definition dates per source; the `batchGetStats` reference read before `public_videos` (its host is `www.googleapis.com`, outside the table: add exactly that path in v2 or use `videos.list`) | v0 docs, v2 |

## 13. Conflicts between reviewers, settled

| Conflict | Settled | Why |
|---|---|---|
| period CTR | no period figure: summed impressions and Google's daily CTR rows (decision 6, option b) | III.E.4.h is read as forbidding "similar, independently calculated data": the careful side until settled |
| the Node floor | ≥ 24.15, pinned to the installed 26.7.0 | `limits` arrived in 24.15; measured |
| worker thread or child process | child process | `worker.terminate()` cannot stop a native `sqlite3_step` |
| Studio groups or id lists | a `series` table and `filters=video==…` | `groups.insert` is a write under the read-only scope |
| 28 or 30 days after `invalid_grant` | `last_refresh_ok_at` + 28 days; an unconfirmed (not lost) sign-in at 30 | covers a revocation older than its detection |
| Linux secret store failing | stop and explain; a file only by explicit opt-in (v2) | never a silent fallback |
| stale after 4 or 7 days | 4 days | well inside the 30- and 60-day loss windows |
| Testing detection | the consent date and the operator's answer; warnings from day 5 to day 8 | the response field may never come |
