// Opening a profile's store: the writer (WAL, busy timeout, secure_delete always on, so deleted rows are overwritten)
// and read-only readers. Migrations are forward-only; a store written by a newer version is refused, and a copy is made
// before migrating an existing store (CMP-17).

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, sqliteBackup, type Db } from './sqlite.ts';
import { MIGRATIONS } from './schema.ts';
import { APP_VERSION, SCHEMA_VERSION } from '../version.ts';
import { ensureDir } from '../util/fsx.ts';

export class NewerSchema extends Error {
  constructor(found: number) {
    super(`This store was written by a newer creatorlens (schema ${found}, this one knows ${SCHEMA_VERSION}). Install the newer version.`);
  }
}

/** Database files are private: 0600 for the file and its -wal and -shm companions. */
export function tightenDbFiles(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      // not there yet
    }
  }
}

export function openWriter(file: string): Db {
  ensureDir(path.dirname(file));
  const db = openDatabase(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
  tightenDbFiles(file);
  return db;
}

export function openReader(file: string): Db {
  const db = openDatabase(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

export function schemaVersion(db: Db): number {
  const t = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!t) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  return row?.value ? Number(row.value) : 0;
}

/** Applies pending migrations in one transaction each. Returns the versions before and after. */
export function migrate(db: Db, file: string, backupsDir: string, now: Date): { from: number; to: number; backup?: string } {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) throw new NewerSchema(from);
  let backup: string | undefined;
  if (from > 0 && from < SCHEMA_VERSION) {
    ensureDir(backupsDir);
    backup = path.join(backupsDir, `pre-migration-v${from}-${now.toISOString().replace(/[:.]/g, '')}.db`);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]!);
      setMeta(db, 'schema_version', String(v + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  setMeta(db, 'app_version', APP_VERSION);
  return { from, to: SCHEMA_VERSION, ...(backup ? { backup } : {}) };
}

/** Opens (and creates or migrates) a profile store for writing. */
export function openStore(file: string, backupsDir: string, now: Date): Db {
  const db = openWriter(file);
  try {
    migrate(db, file, backupsDir, now);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function delMeta(db: Db, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export function logEvent(db: Db, at: Date, kind: string, detail = ''): void {
  db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(at.toISOString(), kind, detail);
}

/** A consistent copy of a database (node:sqlite backup()). */
export async function backupTo(db: Db, dest: string): Promise<void> {
  ensureDir(path.dirname(dest));
  await sqliteBackup(db, dest);
  fs.chmodSync(dest, 0o600);
}
