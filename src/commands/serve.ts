// `creatorlens serve`: the MCP server over stdio. Nothing but JSON-RPC is written to stdout; notes go to stderr.
// At start it runs the policy clocks for every profile and, when a profile's last successful sync is older than 26
// hours, starts a detached `sync` for it (CMP-23). It never imports src/admin/.

import { spawn } from 'node:child_process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Ctx } from '../context.ts';
import { createServer } from '../mcp/server.ts';
import { checkProfile } from '../check.ts';
import { listProfiles, openProfileReader } from '../profile.ts';
import { getMeta } from '../store/db.ts';
import { errorText } from '../util/redact.ts';

export const CATCH_UP_HOURS = 26;

export function needsCatchUp(lastOkIso: string | undefined, now: Date): boolean {
  if (!lastOkIso) return false; // never synced: the owner runs the first sync (`sync --full`) himself
  return now.getTime() - Date.parse(lastOkIso) > CATCH_UP_HOURS * 3_600_000;
}

function startCatchUp(ctx: Ctx, profile: string): void {
  const child = spawn(ctx.execPath, [ctx.appEntry, 'sync', '--profile', profile, '--trigger', 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...ctx.env, CREATORLENS_HOME: ctx.paths.root },
  });
  child.unref();
}

export async function serve(ctx: Ctx): Promise<void> {
  for (const name of listProfiles(ctx)) {
    try {
      const view = await checkProfile(ctx, name);
      const { db } = openProfileReader(ctx, name);
      let lastOk: string | undefined;
      let bound: string | undefined;
      try {
        lastOk = getMeta(db, 'last_sync_ok_at');
        bound = getMeta(db, 'channel_id');
      } finally {
        db.close();
      }
      if (bound && view.state !== 'auth_lost' && view.state !== 'purged' && (needsCatchUp(lastOk, ctx.clock.now()) || view.state === 'unconfirmed')) {
        if (ctx.env.CREATORLENS_NO_CATCHUP !== '1') startCatchUp(ctx, name);
        ctx.err(`creatorlens: profile ${name}: started a catch-up sync in the background.`);
      }
    } catch (e) {
      ctx.err(`creatorlens: profile ${name}: ${errorText(e, 300)}`);
    }
  }
  serveStdio(() => createServer(ctx), { onerror: (e) => ctx.err(`creatorlens: ${errorText(e, 300)}`) });
}
