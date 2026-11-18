// Words the MCP client and the model read: the server instructions (at most 4,096 characters, UX-17), the tool
// descriptions (each opens with "YouTube …" so tool search finds them among other servers) and the glossary.

import { UNTRUSTED_NOTE } from '../util/text.ts';

export const INSTRUCTIONS = `Read-only analytics of your own YouTube channel, through Google's official APIs, kept on this computer by creatorlens (version 0.1, "v0").

What v0 holds: each profile (one per channel: en, es, ru, fr, de, tr) is bound to one channel and keeps that channel's Reporting API files in a raw archive, the ledger of those files, the Reporting jobs and their lifetimes, the channel's own video metadata, and the sign-in and policy clocks. v0 does not parse the reports yet, so it has no views, watch time or traffic figures: the analysis tools (channel_review, video_report, video_card, video_retention, channel_traffic, channel_reach, channel_audience, compare, metadata_check) arrive in v1.

How to use it:
1. Call status first. It says, per profile, whether the sign-in is valid, when data would be purged, which Reporting jobs exist, how fresh the archive is, and any warning. Quote its banners to the owner.
2. Call describe_store before sql_query. sql_query runs one read-only SELECT on one profile's store, in a sandbox that stops after 5 seconds.
3. Every tool takes "profile". A call reads one channel only; never combine profiles in one answer. Compare languages only by quoting two separate answers.

Rules:
- Nothing here can change the channel, the Google account or anything outside the local store. Sign-in, Reporting jobs, sync, purge and revoke are the owner's commands in his own Terminal; you cannot run them, and you should not ask the owner to paste secrets into the chat.
- ${UNTRUSTED_NOTE}
- Report Google's figures as given (in v1). Do not compute scores, rankings between channels, outlier ratios or sentiment from them (YouTube API Services Developer Policies III.E.4.h).
- YouTube's days are Pacific-time days.
- Not affiliated with or endorsed by YouTube or Google.`;

export const TOOL_TEXT = {
  status:
    'YouTube channel analytics status (creatorlens): for each profile, the bound channel, the sign-in state and the policy clocks (when data would be purged), the Reporting jobs with their newest report and lifetimes, archive freshness, the daily schedule, warnings and banners. Operational state only: no audience figures and no text written by strangers. Call this first.',
  describe_store:
    "YouTube analytics store map (creatorlens): the tables of one profile's local store, each column's meaning and origin (owner, Google, creatorlens, or third party), what each table holds in this version, and example queries. Call before sql_query.",
  sql_query: `YouTube analytics SQL (creatorlens): runs one read-only SELECT (or WITH / VALUES) on one profile's local SQLite store, in a separate process that is stopped after 5 seconds, with at most "limit" rows (default 200, at most 1000). Write, PRAGMA, ATTACH, VACUUM and extension calls are refused. Call describe_store first for the tables. ${UNTRUSTED_NOTE}`,
} as const;

export const GLOSSARY = `# creatorlens glossary (v0)

## YouTube days
Analytics and Reporting dates are Pacific-time days (America/Los_Angeles, with daylight saving). A Short published at 08:00 in Israel is published at 22:00 Pacific the day before, so its day 0 holds about two hours.

## Reporting API files
- A job makes one file a day for its report type, about 48 hours after the day. Google keeps files 60 days.
- A new job also brings "historical" files for the 30 days before it was created, within a couple of days.
- A later file for the same type and day is a restatement (Google calls it a backfill): it replaces the earlier one. creatorlens keeps both files and marks the older one superseded.
- A file with only a header means no data that day. It is not the same as a missing file.
- Since 2026-09-09 a file may carry rows with an empty video_id: deleted videos and channel-level events. They count in the totals.

## Definition breaks (dates when YouTube changed what a figure means)
- 2025-03-31: Shorts views count every start and replay (product); reached the Analytics API on 2025-04-30 and bulk reports on 2025-06-30.
- 2026-03-09: estimated under-18 viewers added to age groups.
- 2026-08-27: every format counts views from the first frame; engagedViews redefined; average view duration and CTR computed on engaged views.
- 2026-11-16: views, watch time and the Data API viewCount include TV co-views; engaged views exclude them.
No series is "continuous" across these dates: compare like with like.

## Impressions
Reach files report thumbnail impressions: a thumbnail shown for more than a second, at least half visible. The Shorts feed autoplays without a thumbnail, so these figures may say nothing about Shorts-feed shows. Until a check against YouTube Studio settles it, read them as "thumbnail impressions (not Shorts-feed shows)".

## What no API gives
Search volume and autocomplete; YouTube Studio's Research, Trends and Inspiration tabs; Test & compare results; unique, new and returning viewers; "Stayed to watch" and "Shown in feed" for Shorts; real-time figures; clicks from YouTube to an external site (measure arrivals on the site instead); other channels' private analytics.

## Caveat codes (v1 answers)
WITHHELD (below YouTube's privacy threshold), LOW_N, PARTIAL_DAY0, THUMB_NOT_FEED, SUBS_WATCH_PAGE_ONLY, LOGGED_IN_SHARE, STUDIO_DIFFERS, DEF_BREAK.
`;
