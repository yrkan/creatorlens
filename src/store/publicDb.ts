// Other channels' data (public research, v2) lives in its own file, public.db: never attached to a profile's store,
// never backed up, excluded from Time Machine, and purged 30 days after each row was fetched (Developer Policies
// III.E.4.d; CMP-28, SEC-20). v0 writes nothing there; the clock already runs, so the rule holds from the first row.

import fs from 'node:fs';
import { openDatabase } from './sqlite.ts';
import { addDays } from '../util/clock.ts';

/** Deletes every row older than `days` from every table of public.db that has a fetched_at column. */
export function purgePublicDb(file: string, now: Date, days: number): number {
  if (!fs.existsSync(file)) return 0;
  const db = openDatabase(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
    const cutoff = addDays(now, -days).toISOString();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{
      name: string;
    }>).map((r) => r.name);
    let n = 0;
    for (const t of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('fetched_at')) {
        // A table without fetched_at cannot be aged, so it cannot be kept: rows of other channels must not outlive 30 days.
        n += Number(db.prepare(`DELETE FROM ${t}`).run().changes);
        continue;
      }
      n += Number(db.prepare(`DELETE FROM ${t} WHERE fetched_at IS NULL OR fetched_at < ?`).run(cutoff).changes);
    }
    if (n > 0) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return n;
  } finally {
    db.close();
  }
}
