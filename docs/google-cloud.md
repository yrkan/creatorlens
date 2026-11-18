# Google Cloud for creatorlens: the screens, the choices and the errors

The step-by-step list is [owner-setup.md](owner-setup.md). This page explains each choice and what to do when
something goes wrong. Google reorganised its consent settings in 2025 into **Google Auth Platform**, with four pages:
**Branding**, **Audience**, **Data Access** and **Clients**. (Read from Google's documentation and the review of
2026-11-18; Google changes these screens often, so trust the names more than their positions.)

## Why each choice

| Choice | Why |
|---|---|
| One project, only for creatorlens, for all your channels | the Developer Policies require one project per API client and forbid spreading one use over several projects (III.D.1.c); one project also keeps one quota ledger |
| The three APIs | Data API v3: your channel and videos. Analytics API: period figures (v1). Reporting API: the daily bulk files, the only source of impressions and click-through |
| Audience External | an Internal audience needs a Google Workspace organisation |
| Exactly `youtube.readonly` and `yt-analytics.readonly` | read-only; they cover your channel's data, every non-monetary analytics report and the whole Reporting API. creatorlens never asks for `youtube.force-ssl` (it can delete) or the monetary scope |
| Published, "In production" | tokens of an app in Testing expire after 7 days for YouTube scopes. Personal use needs no verification; you see an "unverified app" screen at each sign-in, and the app is capped at 100 users over its lifetime |
| A Desktop app client | creatorlens signs in through a loopback address on your computer (RFC 8252); a Web client does not allow that, and `setup` refuses one |

## What you see when you sign in

1. **Choose an account:** your Google account.
2. **Choose a channel:** for a channel owned by a Brand Account, Google asks which account or Brand Account to use.
   Pick the channel of the profile you are signing in. creatorlens then shows the channel's name and ID and asks you to
   confirm; a profile stays bound to its channel, and a sign-in for another channel is refused.
3. **"Google hasn't verified this app":** expected for your own unverified app. Continue only if the developer e-mail
   shown is your own: **Advanced** → **Go to … (unsafe)**. (An unverified app may show its domain rather than its name.)
4. **The scopes:** tick both boxes. With one unticked, creatorlens revokes the grant and asks you to start again.

## Keeping the project alive

- Google may cut a project's credentials after 90 days without use, and deletes OAuth clients unused for 6 months
  (they can be restored within 30 days under **Clients**). The daily sync uses the project every day.
- Each sign-in creates a refresh token; Google keeps at most 100 per account and client, and the oldest stops working
  without notice. Sign in again only when creatorlens asks.
- If the client secret leaks, rotate it under **Clients**, download the new JSON and run `creatorlens setup` again.

## Errors and their fixes

| What you see | Meaning | Fix |
|---|---|---|
| `invalid_grant` | the sign-in no longer works: revoked on Google's page, expired after 7 days in Testing, unused for 6 months, or pushed out by the 100-token limit | `creatorlens auth --profile <p>`. Until then nothing syncs, and the profile's data is purged 28 days after the last good refresh |
| `invalid_grant` / `invalid_rapt` | Google wants you to sign in again (a re-authentication policy) | `creatorlens auth --profile <p>` |
| `invalid_client` | the client is unknown: wrong file, rotated secret or deleted client | download the Desktop client JSON again; `creatorlens setup --client-json <file>` |
| `deleted_client` | the client was deleted (6 months unused) | restore it under **Clients** within 30 days, or create a new Desktop client and run `setup` |
| `access_denied` | consent declined, or a box unticked | run auth again and tick both boxes |
| `org_internal` | the audience is Internal | set **Audience** to External |
| `redirect_uri_mismatch`, `unauthorized_client` | not a Desktop app client | create a Desktop app client (step 7) |
| `admin_policy_enforced` | a Workspace administrator blocks the app or its scopes | use an account outside that Workspace policy |
| 403 `accessNotConfigured` / `SERVICE_DISABLED` | one of the three APIs is not enabled in the project | `creatorlens doctor` prints the exact link to enable it |
| 403 `quotaExceeded` | the project's daily Data API units are spent | creatorlens waits until midnight Pacific time; the daily sync uses a handful of units |
| "This account has no YouTube channel (no_channel)" | the chosen account or Brand Account has no channel | sign in again and pick the channel's Brand Account |
| "belongs to channel …" | this profile is bound to another channel | use a new profile name for the other channel |

## What creatorlens never does in Google Cloud

It never creates projects, enables APIs, changes the consent screen, creates clients or keys, or reads any Google page
by machine. Those steps are yours, in your browser. The only lasting state it creates in your Google account is the
Reporting jobs, from `reporting enable`, which you confirm by typing; `reporting disable` deletes them.
