// One quota ledger per Cloud project (CMP-12), shared by every profile: Google counts Data API units per project, per
// Pacific day. The figures are estimates (API-22): Google's 403 quotaExceeded is the authority, and it marks the bucket
// spent until the next Pacific midnight. Updates are single statements, safe across processes.

import { openDatabase, type Db } from '../store/sqlite.ts';
import { tightenDbFiles } from '../store/db.ts';
import { pacificDay, nextPacificMidnight } from '../util/pacific.ts';
import type { Clock } from '../util/clock.ts';

export type Bucket = 'data' | 'search' | 'batchGetStats' | 'analytics' | 'reporting';

/** Data API costs used by creatorlens (Data API v3 quota table, read 2026-11-18). */
export const DATA_COSTS = {
  'channels.list': 1,
  'playlistItems.list': 1,
  'videos.list': 1,
} as const;

export const DAILY_LIMITS: Partial<Record<Bucket, number>> = { data: 10_000, search: 100, batchGetStats: 10_000 };

export class QuotaLedger {
  private db: Db | undefined;
  private readonly file: string;
  private readonly project: string;
  private readonly clock: Clock;
  constructor(file: string, project: string, clock: Clock) {
    this.file = file;
    this.project = project;
    this.clock = clock;
  }

  private open(): Db {
    if (!this.db) {
      this.db = openDatabase(this.file);
      tightenDbFiles(this.file);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS quota (project TEXT NOT NULL, day_pt TEXT NOT NULL, bucket TEXT NOT NULL, used INTEGER NOT NULL,
          PRIMARY KEY (project, day_pt, bucket));
        CREATE TABLE IF NOT EXISTS exhausted (project TEXT NOT NULL, bucket TEXT NOT NULL, until TEXT NOT NULL,
          PRIMARY KEY (project, bucket));`);
    }
    return this.db;
  }

  spend(bucket: Bucket, units: number): void {
    this.open()
      .prepare(
        `INSERT INTO quota (project, day_pt, bucket, used) VALUES (?, ?, ?, ?)
         ON CONFLICT (project, day_pt, bucket) DO UPDATE SET used = used + excluded.used`,
      )
      .run(this.project, pacificDay(this.clock.now()), bucket, units);
  }

  used(bucket: Bucket): number {
    const row = this.open()
      .prepare('SELECT used FROM quota WHERE project = ? AND day_pt = ? AND bucket = ?')
      .get(this.project, pacificDay(this.clock.now()), bucket) as { used?: number } | undefined;
    return row?.used ?? 0;
  }

  markExhausted(bucket: Bucket): void {
    this.open()
      .prepare('INSERT OR REPLACE INTO exhausted (project, bucket, until) VALUES (?, ?, ?)')
      .run(this.project, bucket, nextPacificMidnight(this.clock.now()).toISOString());
  }

  exhaustedUntil(bucket: Bucket): string | undefined {
    const row = this.open()
      .prepare('SELECT until FROM exhausted WHERE project = ? AND bucket = ?')
      .get(this.project, bucket) as { until?: string } | undefined;
    if (!row?.until) return undefined;
    return Date.parse(row.until) > this.clock.now().getTime() ? row.until : undefined;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
