// The policy clocks (design v2 § 6; YouTube API Services Developer Policies III.D.2.c, III.E.4.b–d; API-1, CMP-2,
// SEC-9, API-11). They run at the start of `serve`, on every tool call, on every CLI command and in every sync:
//
// 1. Revocation: `creatorlens revoke` revokes at Google and purges everything in the same run (src/commands/revoke.ts).
// 2. Lost sign-in: a definitive refresh failure (invalid_grant, deleted or invalid client) sets auth_lost_at; every
//    answer carries a banner, a notification comes once a day, and all Authorized Data is purged automatically at
//    last_refresh_ok_at + 28 days unless the same channel signs in again. (28, not 30: the revocation may be older than
//    its detection.)
// 3. Unconfirmed sign-in: if no refresh has succeeded for 30 days for any reason (the Mac was off, the network was down),
//    the next check that can reach Google tries once; if that fails, everything is purged. A check that cannot reach
//    Google (the server) blocks the data and asks for a sync.
// 4. Own metadata (titles, descriptions, tags, the channel row) is cleared when it has not been refreshed for 30 days.
// 5. Other channels' data (public.db, from v2) is deleted 30 days after it was fetched.
// 6. creatorlens's own copies (backups) are deleted after 7 days.
// Deletion uses secure_delete, then wal_checkpoint(TRUNCATE) and VACUUM. Nothing is ever deleted on YouTube.

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import type { ProfileSession } from './profile.ts';
import { getMeta, setMeta, delMeta, logEvent } from './store/db.ts';
import { PURGED_TABLES } from './store/schema.ts';
import type { Db } from './store/sqlite.ts';
import { addDays, parseIso, DAY_MS } from './util/clock.ts';
import { fileExists, removeTree } from './util/fsx.ts';
import { purgePublicDb } from './store/publicDb.ts';
import { tokenStoreOf } from './profile.ts';

export const POLICY = {
  LOST_PURGE_DAYS: 28,
  UNCONFIRMED_DAYS: 30,
  METADATA_DAYS: 30,
  PUBLIC_DAYS: 30,
  BACKUP_KEEP_DAYS: 7,
  STALE_DAYS: 4,
  TESTING_TOKEN_DAYS: 7,
  TESTING_WARN_FROM_DAY: 5,
  TESTING_PROVEN_AFTER_DAY: 8,
} as const;

export type AuthState = 'unbound' | 'authorized' | 'auth_lost' | 'unconfirmed' | 'purged';
export type OAuthMode = 'production' | 'testing' | 'unknown';

export interface PolicyView {
  state: AuthState;
  lastRefreshOkAt?: string;
  authLostAt?: string;
  authLostCode?: string;
  purgeDueAt?: string;
  consentAt?: string;
  mode?: OAuthMode;
  testingWarning?: string;
  purgedAt?: string;
  purgeReason?: string;
  banners: string[];
  /** Own-data answers are refused until a check that can reach Google confirms the sign-in. */
  blockData: boolean;
}

export function policyView(db: Db, now: Date): PolicyView {
  const banners: string[] = [];
  const lastOk = getMeta(db, 'last_refresh_ok_at');
  const lostAt = getMeta(db, 'auth_lost_at');
  const consentAt = getMeta(db, 'consent_at');
  const mode = (getMeta(db, 'oauth_mode') as OAuthMode | undefined) ?? 'unknown';
  const purgedAt = getMeta(db, 'purged_at');
  const view: PolicyView = { state: 'unbound', banners, blockData: false };
  if (consentAt) view.consentAt = consentAt;
  view.mode = mode;
  if (purgedAt && !getMeta(db, 'channel_id')) {
    view.state = 'purged';
    view.purgedAt = purgedAt;
    const reason = getMeta(db, 'purge_reason');
    if (reason) view.purgeReason = reason;
    banners.push(`All data of this profile was purged on ${purgedAt.slice(0, 10)} (${reason ?? 'purge'}). Run auth to start again.`);
    view.blockData = true;
    return view;
  }
  if (!getMeta(db, 'channel_id') || !lastOk) return view;
  view.lastRefreshOkAt = lastOk;
  const last = parseIso(lastOk)!;
  if (lostAt) {
    view.state = 'auth_lost';
    view.authLostAt = lostAt;
    const code = getMeta(db, 'auth_lost_code');
    if (code) view.authLostCode = code;
    const due = addDays(last, POLICY.LOST_PURGE_DAYS);
    view.purgeDueAt = due.toISOString();
    const days = Math.max(0, Math.ceil((due.getTime() - now.getTime()) / DAY_MS));
    banners.push(
      `SIGN-IN LOST (${code ?? 'invalid_grant'} since ${lostAt.slice(0, 10)}): nothing syncs. Run "creatorlens auth --profile <profile>" in your Terminal. ` +
        `Otherwise all data of this profile is purged on ${view.purgeDueAt.slice(0, 10)} (in ${days} days), as YouTube's policy requires.`,
    );
  } else if (now.getTime() >= addDays(last, POLICY.UNCONFIRMED_DAYS).getTime()) {
    view.state = 'unconfirmed';
    view.purgeDueAt = addDays(last, POLICY.UNCONFIRMED_DAYS).toISOString();
    view.blockData = true;
    banners.push(
      `The sign-in has not been confirmed for ${POLICY.UNCONFIRMED_DAYS} days. Run "creatorlens sync --profile <profile>": if Google still accepts it, nothing is lost; if not, the data is purged.`,
    );
  } else {
    view.state = 'authorized';
  }
  // Testing mode (API-10): tokens of an app in Testing die after 7 days. The response field is not reliable, so the
  // consent date and the operator's answer decide; a refresh that succeeds after day 8 proves the app is In production.
  const consent = parseIso(consentAt);
  const rtExpires = parseIso(getMeta(db, 'refresh_token_expires_at'));
  if (rtExpires && rtExpires.getTime() > now.getTime()) {
    view.testingWarning = `This sign-in expires on ${rtExpires.toISOString().slice(0, 10)} (a time-limited grant). Publish the app (Google Auth Platform → Audience → Publish app), then run auth again.`;
  } else if (consent && mode === 'testing') {
    view.testingWarning = `The OAuth app is in Testing: this sign-in stops working on ${addDays(consent, POLICY.TESTING_TOKEN_DAYS).toISOString().slice(0, 10)}. Publish the app (Google Auth Platform → Audience → Publish app) and run auth again.`;
  } else if (consent && mode === 'unknown') {
    const age = (now.getTime() - consent.getTime()) / DAY_MS;
    const provenAfter = addDays(consent, POLICY.TESTING_PROVEN_AFTER_DAY).getTime();
    const proven = last.getTime() > provenAfter;
    if (age >= POLICY.TESTING_WARN_FROM_DAY && !proven) {
      view.testingWarning = `If the OAuth app is still in Testing, this sign-in stops working on ${addDays(consent, POLICY.TESTING_TOKEN_DAYS).toISOString().slice(0, 10)}. Check Google Auth Platform → Audience: it should say "In production".`;
    }
  }
  if (view.testingWarning) banners.push(view.testingWarning);
  return view;
}

export interface PurgeReport {
  reason: string;
  at: string;
  rowsDeleted: number;
  archiveFilesDeleted: number;
  backupsDeleted: number;
  transcriptFilesDeleted: number;
  tokenDeleted: boolean;
}

function countFiles(dir: string): number {
  if (!fileExists(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

/** Empties the configured transcript folders (Q25). Each was validated to be one folder inside ~/.claude/projects. */
export function purgeTranscripts(dirs: readonly string[]): number {
  let n = 0;
  for (const dir of dirs) {
    if (!fileExists(dir)) continue;
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? countFiles(p) : 1;
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  return n;
}

/**
 * Deletes every piece of Authorized Data of a profile: the tables, the raw archive, creatorlens's own backups, the logs,
 * the configured transcripts and (unless told otherwise) the token. Mandated purges (revocation, lost or unconfirmed
 * sign-in) never keep a copy.
 */
export async function fullPurge(
  ctx: Ctx,
  s: ProfileSession,
  reason: string,
  opts: { deleteToken: boolean },
): Promise<PurgeReport> {
  const now = ctx.clock.now();
  let rows = 0;
  s.db.exec('PRAGMA secure_delete=ON');
  s.db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of PURGED_TABLES) {
      rows += Number(s.db.prepare(`DELETE FROM ${t}`).run().changes);
    }
    const keep = new Set(['schema_version', 'app_version', 'token_store']);
    const keys = (s.db.prepare('SELECT key FROM meta').all() as Array<{ key: string }>).map((r) => r.key);
    for (const k of keys) if (!keep.has(k)) delMeta(s.db, k);
    setMeta(s.db, 'purged_at', now.toISOString());
    setMeta(s.db, 'purge_reason', reason);
    logEvent(s.db, now, 'purge', reason);
    s.db.exec('COMMIT');
  } catch (e) {
    s.db.exec('ROLLBACK');
    throw e;
  }
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  s.db.exec('VACUUM');
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const archiveFilesDeleted = countFiles(s.pp.reports);
  const backupsDeleted = countFiles(s.pp.backups);
  if (fileExists(s.pp.reports)) removeTree(s.pp.reports, s.pp.dir);
  if (fileExists(s.pp.backups)) removeTree(s.pp.backups, s.pp.dir);
  if (fileExists(s.pp.logs)) removeTree(s.pp.logs, s.pp.dir);
  const transcriptFilesDeleted = purgeTranscripts(s.cfg.transcriptDirs);
  let tokenDeleted = false;
  if (opts.deleteToken) {
    try {
      tokenDeleted = await ctx.secrets(tokenStoreOf(s)).delete(s.pp.name);
    } catch (e) {
      s.log.error(`token delete failed: ${(e as Error).message}`);
    }
  }
  s.log.warn(`purged profile ${s.pp.name}: ${reason}; ${rows} rows, ${archiveFilesDeleted} archive files`);
  await ctx.notify('creatorlens', `Profile ${s.pp.name}: all data purged (${reason}).`);
  return {
    reason,
    at: now.toISOString(),
    rowsDeleted: rows,
    archiveFilesDeleted,
    backupsDeleted,
    transcriptFilesDeleted,
    tokenDeleted,
  };
}

/** Clears own metadata not refreshed for 30 days (III.E.4.c). Returns the number of rows cleared. */
export function expireMetadata(db: Db, now: Date): number {
  const cutoff = addDays(now, -POLICY.METADATA_DAYS).toISOString();
  const stamp = now.toISOString();
  const v = db
    .prepare(
      `UPDATE videos SET title = NULL, description = NULL, tags_json = NULL, default_language = NULL,
         default_audio_language = NULL, category_id = NULL, metadata_expired_at = ?
       WHERE metadata_expired_at IS NULL AND (refreshed_at IS NULL OR refreshed_at < ?)`,
    )
    .run(stamp, cutoff).changes;
  const c = db
    .prepare(
      `UPDATE channel SET title = NULL, handle = NULL, country = NULL, metadata_expired_at = ?
       WHERE metadata_expired_at IS NULL AND refreshed_at < ?`,
    )
    .run(stamp, cutoff).changes;
  const n = Number(v) + Number(c);
  if (n > 0) {
    delMeta(db, 'channel_title');
    delMeta(db, 'channel_handle');
    logEvent(db, now, 'metadata_expired', `${n} rows`);
  }
  return n;
}

/** Deletes creatorlens's own copies older than 7 days. The copy's time is in its name. */
export function expireBackups(backupsDir: string, now: Date): number {
  if (!fileExists(backupsDir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(backupsDir, { withFileTypes: true })) {
    const m = /(\d{8}T\d{6})/.exec(e.name);
    const stamp = m ? `${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6, 8)}T${m[1]!.slice(9, 11)}:${m[1]!.slice(11, 13)}:${m[1]!.slice(13, 15)}Z` : undefined;
    const made = parseIso(stamp) ?? fs.statSync(path.join(backupsDir, e.name)).mtime;
    if (now.getTime() - made.getTime() > POLICY.BACKUP_KEEP_DAYS * DAY_MS) {
      fs.rmSync(path.join(backupsDir, e.name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

export type RefreshOutcome = 'ok' | 'definitive' | 'transient';

export interface EnforceOptions {
  /** True when this check may reach Google (CLI commands, sync, doctor); false in the server. */
  network: boolean;
  /** Tries one token refresh; used only when the 30-day confirmation is due. */
  tryRefresh?: () => Promise<RefreshOutcome>;
}

export interface EnforceReport {
  view: PolicyView;
  purged?: PurgeReport;
  metadataExpired: number;
  backupsDeleted: number;
  publicRowsDeleted: number;
  refreshTried?: RefreshOutcome;
}

/** Runs every clock for one profile. Safe to call often; it writes only when something is due. */
export async function enforce(ctx: Ctx, s: ProfileSession, opts: EnforceOptions): Promise<EnforceReport> {
  const now = ctx.clock.now();
  const report: EnforceReport = {
    view: policyView(s.db, now),
    metadataExpired: 0,
    backupsDeleted: expireBackups(s.pp.backups, now),
    publicRowsDeleted: purgePublicDb(ctx.paths.publicDb, now, POLICY.PUBLIC_DAYS),
  };
  report.metadataExpired = expireMetadata(s.db, now);
  const view = report.view;
  if (view.state === 'auth_lost' && view.purgeDueAt && now.getTime() >= Date.parse(view.purgeDueAt)) {
    report.purged = await fullPurge(ctx, s, `sign-in lost for ${POLICY.LOST_PURGE_DAYS} days after the last good refresh`, {
      deleteToken: true,
    });
  } else if (view.state === 'unconfirmed') {
    if (opts.network && opts.tryRefresh) {
      report.refreshTried = await opts.tryRefresh();
      if (report.refreshTried !== 'ok') {
        report.purged = await fullPurge(ctx, s, `sign-in not confirmed for ${POLICY.UNCONFIRMED_DAYS} days`, {
          deleteToken: report.refreshTried === 'definitive',
        });
      }
    }
  }
  if (view.state === 'auth_lost' && !report.purged) {
    const lastNotice = parseIso(getMeta(s.db, 'last_lost_notice_at'));
    if (!lastNotice || now.getTime() - lastNotice.getTime() >= DAY_MS) {
      setMeta(s.db, 'last_lost_notice_at', now.toISOString());
      await ctx.notify(
        'creatorlens',
        `Profile ${s.pp.name}: the sign-in is lost. Run auth in Terminal before ${view.purgeDueAt?.slice(0, 10)} or its data is purged.`,
      );
    }
  }
  report.view = policyView(s.db, ctx.clock.now());
  return report;
}

/** When the next automatic purge would happen for a profile, for status and doctor. */
export function nextPurge(view: PolicyView): string | undefined {
  return view.state === 'auth_lost' || view.state === 'unconfirmed' ? view.purgeDueAt : undefined;
}
