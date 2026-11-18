// One writer at a time per profile: sync, purge, revoke, reporting and auth take this lock (CMP-17, SEC-13). It is a
// file created exclusively; a lock whose process is gone, or older than its limit, is stale and replaced.

import fs from 'node:fs';
import { writeFileAtomic } from './fsx.ts';

export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export class LockBusy extends Error {
  readonly holder: string;
  constructor(holder: string) {
    super(`Another creatorlens process is writing this profile (${holder}). Try again when it has finished.`);
    this.holder = holder;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Held {
  release(): void;
}

export function acquireLock(file: string, purpose: string, now: () => Date = () => new Date()): Held {
  const body = JSON.stringify({ pid: process.pid, purpose, at: now().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
            if (cur.pid === process.pid) fs.rmSync(file, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid?: number; purpose?: string; at?: string } = {};
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // unreadable: treat as stale
      }
      const age = holder.at ? now().getTime() - Date.parse(holder.at) : Infinity;
      const stale = !holder.pid || !alive(holder.pid) || age > LOCK_STALE_MS;
      if (!stale) throw new LockBusy(`${holder.purpose ?? 'unknown'}, pid ${holder.pid}`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockBusy('could not take the lock');
}

/** Rewrites the lock's timestamp so a long sync is not taken for stale. */
export function heartbeat(file: string, purpose: string, now: () => Date = () => new Date()): void {
  try {
    writeFileAtomic(file, JSON.stringify({ pid: process.pid, purpose, at: now().toISOString() }));
  } catch {
    // best effort
  }
}
