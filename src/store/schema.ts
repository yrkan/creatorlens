// The store's schema and the map of every column: where its value comes from, so that strangers' text can be found and
// wrapped (design v2 § 5, SEC-1), and what it means (describe_store, UX-12).
//
// Origins: "owner" = written by the channel owner (titles, descriptions, tags); "google" = a value Google computes or
// assigns (ids, dates, enums); "creatorlens" = our own bookkeeping; "third_party" = written by someone else. Every
// third-party text column is named untrusted_* and is wrapped in every answer, sql_query included. v0 stores none:
// search terms and referrers arrive with v1's parsing, comments with v2.

export type Origin = 'owner' | 'google' | 'creatorlens' | 'third_party';

export interface ColumnInfo {
  origin: Origin;
  meaning: string;
}

export interface TableInfo {
  grain: string;
  /** III.E.4.b (statistics, kept while authorized), III.E.4.c (metadata, 30 days unless refreshed), or none. */
  retention: 'authorized_data' | 'metadata_30d' | 'bookkeeping';
  columns: Record<string, ColumnInfo>;
}

export const MIGRATIONS: readonly string[] = [
  // 1: v0 — identity, own metadata, Reporting jobs and the raw archive's ledger, sync log, policy events.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE channel (
    id TEXT PRIMARY KEY,
    title TEXT, handle TEXT, country TEXT, published_at TEXT, uploads_playlist_id TEXT,
    refreshed_at TEXT NOT NULL, metadata_expired_at TEXT
  );
  CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    title TEXT, description TEXT, tags_json TEXT,
    published_at_utc TEXT, published_day_pt TEXT, duration_s REAL,
    privacy TEXT, made_for_kids INTEGER, default_language TEXT, default_audio_language TEXT,
    category_id TEXT, live_broadcast TEXT,
    first_seen_at TEXT NOT NULL, refreshed_at TEXT, metadata_expired_at TEXT, removed_at TEXT
  );
  CREATE TABLE report_types (
    id TEXT PRIMARY KEY, name TEXT, family TEXT NOT NULL, version INTEGER NOT NULL,
    deprecate_time TEXT, system_managed INTEGER NOT NULL DEFAULT 0, seen_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, report_type_id TEXT NOT NULL, name TEXT, create_time TEXT, expire_time TEXT,
    system_managed INTEGER NOT NULL DEFAULT 0, project_number TEXT,
    created_by_creatorlens INTEGER NOT NULL DEFAULT 0, seen_at TEXT NOT NULL, gone_at TEXT
  );
  CREATE TABLE report_files (
    report_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, report_type_id TEXT NOT NULL,
    start_time TEXT NOT NULL, end_time TEXT NOT NULL, create_time TEXT NOT NULL, report_day_pt TEXT NOT NULL,
    job_expire_time TEXT, download_host TEXT NOT NULL, path TEXT NOT NULL,
    sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, bytes_gz INTEGER NOT NULL, rows INTEGER NOT NULL, header TEXT NOT NULL,
    downloaded_at TEXT NOT NULL, superseded_by TEXT, imported_at TEXT
  );
  CREATE INDEX report_files_period ON report_files (report_type_id, start_time, end_time);
  CREATE INDEX report_files_job ON report_files (job_id);
  CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, trigger TEXT NOT NULL, app_version TEXT NOT NULL,
    mode TEXT NOT NULL, ok INTEGER, reports_downloaded INTEGER NOT NULL DEFAULT 0, videos_seen INTEGER NOT NULL DEFAULT 0,
    data_units INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
  `,
];

const BOOK = 'creatorlens' as const;
const G = 'google' as const;
const O = 'owner' as const;

export const REGISTRY: Record<string, TableInfo> = {
  meta: {
    grain: 'one row per key',
    retention: 'bookkeeping',
    columns: {
      key: { origin: BOOK, meaning: 'setting or clock name (schema_version, channel_id, last_refresh_ok_at, …)' },
      value: { origin: BOOK, meaning: 'its value' },
    },
  },
  channel: {
    grain: 'one row: the channel this profile is bound to',
    retention: 'metadata_30d',
    columns: {
      id: { origin: G, meaning: 'channel id (UC…)' },
      title: { origin: O, meaning: 'channel title' },
      handle: { origin: O, meaning: 'channel handle (@…)' },
      country: { origin: O, meaning: 'channel country setting' },
      published_at: { origin: G, meaning: 'channel creation time, UTC' },
      uploads_playlist_id: { origin: G, meaning: 'the uploads playlist id' },
      refreshed_at: { origin: BOOK, meaning: 'when this row was last read from the Data API (cleared after 30 days without a refresh)' },
      metadata_expired_at: { origin: BOOK, meaning: 'when the metadata was cleared under the 30-day rule' },
    },
  },
  videos: {
    grain: 'one row per own video',
    retention: 'metadata_30d',
    columns: {
      id: { origin: G, meaning: 'video id' },
      title: { origin: O, meaning: 'title' },
      description: { origin: O, meaning: 'description' },
      tags_json: { origin: O, meaning: 'tags, JSON array' },
      published_at_utc: { origin: G, meaning: 'publish time, UTC' },
      published_day_pt: { origin: BOOK, meaning: 'publish day in Pacific time (YouTube days); day 0 may be partial' },
      duration_s: { origin: G, meaning: 'duration in seconds' },
      privacy: { origin: O, meaning: 'public, unlisted or private' },
      made_for_kids: { origin: O, meaning: '1 if made for kids' },
      default_language: { origin: O, meaning: 'metadata language' },
      default_audio_language: { origin: O, meaning: 'audio language' },
      category_id: { origin: O, meaning: 'category id' },
      live_broadcast: { origin: G, meaning: 'none, upcoming or live' },
      first_seen_at: { origin: BOOK, meaning: 'first sync that saw the video' },
      refreshed_at: { origin: BOOK, meaning: 'last metadata refresh' },
      metadata_expired_at: { origin: BOOK, meaning: 'when the metadata was cleared under the 30-day rule' },
      removed_at: { origin: BOOK, meaning: 'when the video stopped being returned (deleted or unavailable); its metadata is cleared' },
    },
  },
  report_types: {
    grain: 'one row per Reporting API report type offered to this channel',
    retention: 'bookkeeping',
    columns: {
      id: { origin: G, meaning: 'report type id, e.g. channel_basic_a3' },
      name: { origin: G, meaning: 'Google’s name for it' },
      family: { origin: BOOK, meaning: 'the id without its version suffix' },
      version: { origin: BOOK, meaning: 'the number of the _aN suffix' },
      deprecate_time: { origin: G, meaning: 'when Google stops it (a successor must exist before)' },
      system_managed: { origin: G, meaning: '1 for system-managed types (no job is created)' },
      seen_at: { origin: BOOK, meaning: 'last listing that returned it' },
    },
  },
  jobs: {
    grain: 'one row per Reporting job of this channel',
    retention: 'bookkeeping',
    columns: {
      id: { origin: G, meaning: 'job id' },
      report_type_id: { origin: G, meaning: 'its report type' },
      name: { origin: BOOK, meaning: 'job name (creatorlens <profile> <type> when we created it)' },
      create_time: { origin: G, meaning: 'creation time; historical reports cover the 30 days before it' },
      expire_time: { origin: G, meaning: 'when Google ends the job' },
      system_managed: { origin: G, meaning: '1 for system-managed jobs' },
      project_number: { origin: BOOK, meaning: 'the Cloud project the job belongs to' },
      created_by_creatorlens: { origin: BOOK, meaning: '1 when creatorlens created it' },
      seen_at: { origin: BOOK, meaning: 'last listing that returned it' },
      gone_at: { origin: BOOK, meaning: 'when it stopped being listed' },
    },
  },
  report_files: {
    grain: 'one row per downloaded report file in the raw archive',
    retention: 'authorized_data',
    columns: {
      report_id: { origin: G, meaning: 'report id' },
      job_id: { origin: G, meaning: 'job id' },
      report_type_id: { origin: G, meaning: 'report type' },
      start_time: { origin: G, meaning: 'period start, UTC (00:00 Pacific)' },
      end_time: { origin: G, meaning: 'period end, UTC' },
      create_time: { origin: G, meaning: 'creation time; a later file for the same period is a restatement' },
      report_day_pt: { origin: BOOK, meaning: 'the Pacific day the report covers' },
      job_expire_time: { origin: G, meaning: 'when Google deletes the report (about 60 days)' },
      download_host: { origin: BOOK, meaning: 'host the file came from' },
      path: { origin: BOOK, meaning: 'file in the archive, relative to the profile folder' },
      sha256: { origin: BOOK, meaning: 'SHA-256 of the uncompressed CSV' },
      bytes: { origin: BOOK, meaning: 'uncompressed size' },
      bytes_gz: { origin: BOOK, meaning: 'size on disk' },
      rows: { origin: BOOK, meaning: 'data rows (0 = a header-only file: no data that day)' },
      header: { origin: G, meaning: 'the CSV header line (column names)' },
      downloaded_at: { origin: BOOK, meaning: 'download time' },
      superseded_by: { origin: BOOK, meaning: 'report id of a newer file for the same type and period' },
      imported_at: { origin: BOOK, meaning: 'when v1 parsed it into tables (empty in v0)' },
    },
  },
  sync_log: {
    grain: 'one row per sync run, written before the work starts',
    retention: 'bookkeeping',
    columns: {
      id: { origin: BOOK, meaning: 'run number' },
      started_at: { origin: BOOK, meaning: 'start time' },
      finished_at: { origin: BOOK, meaning: 'end time (empty if the run died)' },
      trigger: { origin: BOOK, meaning: 'schedule, manual or serve' },
      app_version: { origin: BOOK, meaning: 'creatorlens version' },
      mode: { origin: BOOK, meaning: 'quick or full' },
      ok: { origin: BOOK, meaning: '1 success, 0 failure' },
      reports_downloaded: { origin: BOOK, meaning: 'report files added to the archive' },
      videos_seen: { origin: BOOK, meaning: 'own videos refreshed' },
      data_units: { origin: BOOK, meaning: 'Data API units spent (estimate)' },
      error: { origin: BOOK, meaning: 'error text, redacted' },
    },
  },
  events: {
    grain: 'one row per policy or binding event',
    retention: 'bookkeeping',
    columns: {
      id: { origin: BOOK, meaning: 'event number' },
      at: { origin: BOOK, meaning: 'time' },
      kind: { origin: BOOK, meaning: 'auth_ok, auth_lost, purge, revoke, metadata_expired, binding, notify…' },
      detail: { origin: BOOK, meaning: 'short text, no data and no secret' },
    },
  },
};

/**
 * The tables a full purge empties: everything that came from the API about the channel, and the bookkeeping that ran
 * alongside it (the sync log and the event log), so nothing of the channel outlives a revocation. Only `meta` keeps a
 * few keys of its own (schema and app version, the secret store, when and why the purge ran).
 */
export const PURGED_TABLES = ['channel', 'videos', 'report_types', 'jobs', 'report_files', 'sync_log', 'events'] as const;

/**
 * The non-statistical fields the 30-day metadata clock clears (Developer Policies III.E.4.c), and that a removed
 * video loses at once: every column of `videos` and `channel` that came from the Data API (or is computed from one),
 * except the ids. test/store.test.ts holds that no such column is left out.
 */
export const METADATA_COLUMNS = {
  videos: [
    'title',
    'description',
    'tags_json',
    'published_at_utc',
    'published_day_pt',
    'duration_s',
    'privacy',
    'made_for_kids',
    'default_language',
    'default_audio_language',
    'category_id',
    'live_broadcast',
  ],
  channel: ['title', 'handle', 'country', 'published_at'],
} as const satisfies Record<'videos' | 'channel', readonly string[]>;

/** The id columns of `videos` and `channel` that stay when their metadata is cleared. */
export const METADATA_KEEP = { videos: ['id'], channel: ['id', 'uploads_playlist_id'] } as const;

/** `SET a = NULL, b = NULL, …` for a table's metadata columns (fixed names, never input). */
export function clearMetadataSql(table: 'videos' | 'channel'): string {
  return METADATA_COLUMNS[table].map((c) => `${c} = NULL`).join(', ');
}
