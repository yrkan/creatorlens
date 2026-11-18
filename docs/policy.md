# creatorlens and the YouTube API Services policies

How creatorlens keeps the YouTube API Services Terms of Service and Developer Policies (read 2026-11-18,
https://developers.google.com/youtube/terms/developer-policies), rule by rule. The code that holds each rule is named,
with the test that proves it.

## The operator model

Every person who runs creatorlens creates a Google Cloud project for it alone ("creatorlens (personal)") and a Desktop
OAuth client in it. That project is the API client and its owner the developer of record (III.D.1.c: one project per
API client, no splitting of one use across projects to multiply quota). The project's client JSON and secret are never
committed (III.D.1.d); creatorlens keeps the secret in the Keychain. One operator's six channels are six profiles in
the same project. The project is used every day by the scheduled sync, well inside Google's 90-day inactivity limit.

creatorlens serves one person on one computer over stdio. It has no network transport and is never a shared server
(III.I.15: no API service that gives others access to YouTube data).

## Scopes and writes

Exactly two scopes, both read-only: `youtube.readonly` and `yt-analytics.readonly`. A grant with any other scope is
revoked and refused (`src/google/oauth.ts` `checkScopes`; `test/oauth.test.ts`). No write method of the Data API exists
in the code. The Reporting API's job creation and deletion and the token revocation are the only requests that change
state at Google: they live in `src/admin/`, run only from the command line in the operator's terminal with a typed
confirmation, and the MCP server never imports that folder (`test/importGraph.test.ts`). Every request is checked
against a closed route table of method, host, path and caller before it is sent (`src/google/routes.ts`,
`src/google/http.ts`; `test/http.test.ts`, `test/routes.test.ts`).

## Storage and deletion (III.D.2.c, III.E.4.b–d)

| Rule | What creatorlens does | Where |
|---|---|---|
| Revocation through the client: revoke right away, delete within 7 days | `creatorlens revoke` revokes at Google, then deletes every table, the raw archive, creatorlens's backups, the logs, the configured transcripts and the token, in the same run | `src/commands/admin.ts` `cmdRevoke`, `src/policy.ts` `fullPurge` |
| Tokens that cannot be refreshed: delete the user's API data within 30 days | a definitive refresh failure sets `auth_lost_at`; every answer carries a banner, a notification comes once a day, and everything is deleted at the last good refresh + 28 days unless the same channel signs in again | `src/policy.ts` `enforce`; `test/policy.test.ts` |
| Re-confirm authorization every 30 days | every sync refreshes the token; if nothing has confirmed it for 30 days, the next check that can reach Google tries once and deletes on failure | `src/policy.ts` |
| Own non-statistical data (metadata) at most 30 days unless refreshed | titles, descriptions, tags and the channel row are refreshed at every sync and cleared after 30 days without a refresh; a deleted video's metadata is cleared when the sync sees it gone | `src/policy.ts` `expireMetadata`, `src/sync.ts` |
| Data of other channels (no authorization) at most 30 days | `public.db`, separate from every channel's store, is purged of rows older than 30 days at every check (v2 writes there; v0 writes nothing) | `src/store/publicDb.ts` |
| Checks | at the server's start, on every tool call, on every command and in every sync | `src/check.ts`, `src/mcp/server.ts`, `src/sync.ts` |

Deletion runs with `secure_delete`, then `wal_checkpoint(TRUNCATE)` and `VACUUM`. Deleting creatorlens's local copies
deletes nothing on YouTube (III.E.4.g); the revoke command says so.

## Derived metrics (III.E.4.h) and aggregation (III.E.2)

creatorlens returns Google's figures as given and sums only additive figures of one channel, labelled as sums. It
creates no new metric: no channel score or ratio, no ranking between channels, no outlier ratio, no sentiment, no
inferred content type. A period's averages and percentages come from a live Analytics query for exactly that window
(v1); no period click-through rate is computed. Each call reads one channel (one profile); languages are compared
only in the conversation. No III.L application is made.

## Required disclosures (III.A)

`docs/terms.md` binds users to the YouTube Terms of Service; `docs/privacy.md` names the YouTube API Services, links
Google's Privacy Policy and the revocation page, says what is stored where and who receives tool results (the AI client
and its model provider). `creatorlens setup` shows both and records a typed, versioned acceptance before anything is
stored, and asks again when either changes (`src/version.ts` `TERMS_VERSION`, `test/terms.test.ts`).

## Branding (III.G.2.d, Branding Guidelines)

No name of creatorlens contains "YouTube", "YT" or "Tube": not the repository, package, command, MCP server, OAuth app,
Keychain service, LaunchAgent label or any tool (`test/names.test.ts`). "For YouTube" appears only descriptively. No
YouTube logo is used. Every README carries the not-affiliated line.

## No scraping (III.E.6)

creatorlens reads only Google's official APIs. It fetches no YouTube page, uses no yt-dlp or innertube, and accepts no
data scraped by others: no input of any tool carries search rankings or vendor data, and creatorlens never sends its
data to another service.
