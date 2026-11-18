// The store (CMP-17): migrations, a newer schema refused, private files, one writer at a time, the column map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, setMeta, NewerSchema } from '../src/store/db.ts';
import { REGISTRY, MIGRATIONS, METADATA_COLUMNS, METADATA_KEEP, PURGED_TABLES } from '../src/store/schema.ts';
import { SCHEMA_VERSION } from '../src/version.ts';
import { acquireLock, LockBusy } from '../src/util/lock.ts';
import { openDatabase } from '../src/store/sqlite.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'creatorlens-store-'));
}

test('a new store is migrated to the current schema, with private files', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'p', 'store.db');
    const db = openStore(file, path.join(dir, 'p', 'backups'), new Date());
    assert.equal(MIGRATIONS.length, SCHEMA_VERSION);
    const v = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
    assert.equal(Number(v), SCHEMA_VERSION);
    db.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a store written by a newer creatorlens is refused', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'store.db');
    const db = openStore(file, path.join(dir, 'backups'), new Date());
    setMeta(db, 'schema_version', String(SCHEMA_VERSION + 1));
    db.close();
    assert.throws(() => openStore(file, path.join(dir, 'backups'), new Date()), NewerSchema);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every table and column of the schema is in the column map, and no third-party text column escapes the untrusted_ prefix', () => {
  const db = openDatabase(':memory:');
  for (const m of MIGRATIONS) db.exec(m);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name).sort();
  assert.deepEqual(tables, Object.keys(REGISTRY).sort());
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
    assert.deepEqual(cols, Object.keys(REGISTRY[t]!.columns).sort(), t);
    for (const [c, info] of Object.entries(REGISTRY[t]!.columns)) {
      if (info.origin === 'third_party') assert.ok(c.startsWith('untrusted_'), `${t}.${c}`);
      if (c.startsWith('untrusted_')) assert.equal(info.origin, 'third_party', `${t}.${c}`);
    }
  }
  db.close();
});

test('the 30-day metadata clock covers every API field of videos and channel but the ids, and a full purge every table but meta', () => {
  // A column added later from the Data API cannot escape the clock: it must be listed in METADATA_COLUMNS or be an id.
  for (const table of ['videos', 'channel'] as const) {
    const listed = new Set<string>(METADATA_COLUMNS[table]);
    const keep = new Set<string>(METADATA_KEEP[table]);
    for (const [c, info] of Object.entries(REGISTRY[table]!.columns)) {
      if (info.origin === 'owner' || info.origin === 'google') {
        assert.ok(listed.has(c) || keep.has(c), `${table}.${c} comes from the API: add it to METADATA_COLUMNS (or METADATA_KEEP if it is an id)`);
      }
    }
    for (const c of listed) assert.ok(REGISTRY[table]!.columns[c], `${table}.${c} is in the schema`);
  }
  assert.deepEqual([...PURGED_TABLES].sort(), Object.keys(REGISTRY).filter((t) => t !== 'meta').sort(), 'a full purge empties every table but meta');
});

test('one writer at a time; a stale lock (dead process) is replaced', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'writer.lock');
    const a = acquireLock(file, 'sync');
    assert.throws(() => acquireLock(file, 'purge'), LockBusy);
    a.release();
    const b = acquireLock(file, 'purge');
    b.release();
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999_999, purpose: 'ghost', at: new Date().toISOString() }));
    const c = acquireLock(file, 'sync');
    c.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
