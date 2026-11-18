// The policy clocks without the network, for the server's start and every tool call, and for status and sql (API-1:
// "a check at start-up and on every call"). When another process holds the writer lock (a sync), the clocks are only
// read: that process runs them itself.

import fs from 'node:fs';
import type { Ctx } from './context.ts';
import { enforce, policyView, type PolicyView } from './policy.ts';
import { openProfile, openProfileReader } from './profile.ts';
import { profilePaths } from './paths.ts';
import { acquireLock, LockBusy } from './util/lock.ts';

export async function checkProfile(ctx: Ctx, name: string): Promise<PolicyView> {
  const pp = profilePaths(ctx.paths, name);
  if (!fs.existsSync(pp.store)) throw new Error(`No profile "${name}".`);
  let held;
  try {
    held = acquireLock(pp.lock, 'policy-check', () => ctx.clock.now());
  } catch (e) {
    if (!(e instanceof LockBusy)) throw e;
    const { db } = openProfileReader(ctx, name);
    try {
      return policyView(db, ctx.clock.now());
    } finally {
      db.close();
    }
  }
  try {
    const s = openProfile(ctx, name);
    try {
      return (await enforce(ctx, s, { network: false })).view;
    } finally {
      s.close();
    }
  } finally {
    held.release();
  }
}
