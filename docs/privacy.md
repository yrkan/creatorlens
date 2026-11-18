# creatorlens privacy policy

Version 2026-11-18.2. `creatorlens setup` shows this policy and asks you to accept it before anything is stored, and asks again whenever this version changes.

creatorlens is software you run on your own computer, with your own Google Cloud project. You are the operator of that API client, so this policy describes what the software does with the data of the channels you sign in. creatorlens is not affiliated with or endorsed by YouTube or Google.

## YouTube API Services

creatorlens uses the YouTube API Services: the YouTube Data API v3, the YouTube Analytics API and the YouTube Reporting API. By using creatorlens you agree to be bound by the YouTube Terms of Service (https://www.youtube.com/t/terms). Google's handling of your data is described in the Google Privacy Policy (https://policies.google.com/privacy, also at http://www.google.com/policies/privacy).

## What creatorlens reads

Only with your authorization, given on Google's consent screen, and only through two read-only scopes:

- `https://www.googleapis.com/auth/youtube.readonly`: your channel's identity, its uploads and your own videos' metadata (titles, descriptions, tags, languages, privacy status).
- `https://www.googleapis.com/auth/yt-analytics.readonly`: your channel's analytics and the bulk Reporting API files (views, watch time, traffic sources, impressions and the other figures YouTube reports).

creatorlens cannot upload, edit, delete, comment or change anything on YouTube. From version 2 it may also read public data of other channels, with an API key, only when you ask for it.

## What is stored, and where

Everything stays on this computer:

- The data folder: on macOS `~/Library/Application Support/creatorlens/` (folders 0700, files 0600). It holds a local database per channel ("profile"), the raw Reporting files of each channel (gzipped CSV), creatorlens's logs (ids and counts, no titles), short-lived backups and the settings.
- Secrets: the sign-in (a refresh token) of each channel and your OAuth client secret, in the macOS login Keychain (or in 0600 files if you chose `--token-store file`).

creatorlens sends no telemetry, opens no network service, and contacts no host other than Google's API and sign-in endpoints.

## Who receives the data

- creatorlens itself shares nothing with anyone.
- When you connect creatorlens to an AI client through MCP (for example Claude Code), everything a creatorlens tool returns is sent to that client and on to its model provider (for Claude: Anthropic), and stays in the client's transcripts under the client's own retention setting (in Claude Code, `cleanupPeriodDays`). Installing creatorlens into a client is your approval of that provider as your agent for this data. creatorlens's own deletions cannot reach those copies, except in transcript folders you name with `creatorlens transcripts add`, which every full purge empties.
- Comments (version 2) are personal data of the people who wrote them. They are fetched only when you ask, and deleted after 30 days.

## How long data is kept

- Your channel's analytics and Reporting files: as long as your authorization holds. creatorlens re-confirms the authorization every day it syncs, and at least every 30 days.
- Your videos' and your channel's metadata (titles, descriptions, tags, languages, publish times, durations, privacy settings and the rest; only the ids are kept): refreshed at every sync, and deleted if it has not been refreshed for 30 days. A deleted video's metadata is cleared when the sync sees it gone.
- Other channels' data (version 2): at most 30 days.
- creatorlens's own backups: 7 days.
- When you revoke through creatorlens (`creatorlens revoke`): access is revoked at Google and all data of that channel is deleted in the same run.
- When the sign-in can no longer be refreshed (you removed access on Google's page, the app's tokens expired, the client was deleted): every answer says so, a daily notification reminds you, and all data of that channel is deleted 28 days after the last successful refresh unless the same channel signs in again.
- When the sign-in has not been confirmed for 30 days for any other reason: the next check that can reach Google confirms it or deletes the data. This check runs even while a newer version of these terms waits for your acceptance.
- creatorlens's deletions reach its data folder, its Keychain items and the transcript folders you named. Copies elsewhere stay until you delete them yourself: backups of your computer (Time Machine includes the data folder unless you exclude it), files you exported, and the AI client's other transcripts.

## Your choices

- Remove creatorlens's access at any time on Google's page: https://security.google.com/settings/security/permissions
- `creatorlens revoke --profile <p>`: revoke and delete everything for that channel.
- `creatorlens purge --profile <p> --all`: delete a channel's data and keep the sign-in.
- Deleting creatorlens's local data deletes nothing on YouTube.

## Contact

For your own data, you are the operator: everything is in the data folder above. For questions about the software, open an issue at https://github.com/yrkan/creatorlens; report a security problem privately through GitHub's private vulnerability reporting on that repository.
