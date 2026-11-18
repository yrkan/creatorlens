// The daily sync (design v2 § 4.2). It writes only the local store and archive, and uses only GET requests and the token
// refresh. Work is ordered by how soon it is lost (CMP-23): first the identity check, then the Reporting downloads
// (reports vanish after 60 days, historical ones after 30), then the own metadata (30-day rule), then the clocks.
// A run's row is written before any work, so a crash still leaves a trace (CMP-11).

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { makeApi, type ProfileSession } from './profile.ts';
import { getMeta, setMeta, logEvent } from './store/db.ts';
import { enforce, POLICY, type EnforceReport, type RefreshOutcome } from './policy.ts';
import { OAuthError } from './google/oauth.ts';
import { RouteRefused } from './google/http.ts';
import type { GoogleApi, Job, ReportType, VideoInfo } from './google/api.ts';
import { familyOf, planJobs } from './reportingPlan.ts';
import { archiveReport, markSuperseded } from './archive.ts';
import { acquireLock, heartbeat } from './util/lock.ts';
import { errorText } from './util/redact.ts';
import { pacificDay, daysBetweenDays } from './util/pacific.ts';
import { DAY_MS, parseIso } from './util/clock.ts';
import { APP_VERSION } from './version.ts';
import { sha256Hex } from './util/fsx.ts';
import zlib from 'node:zlib';

export type Trigger = 'schedule' | 'manual' | 'serve';

export interface SyncOptions {
  full: boolean;
  trigger: Trigger;
}

export interface SyncResult {
  ok: boolean;
  profile: string;
  reportsListed: number;
  reportsDownloaded: number;
  reportsFailed: number;
  videosSeen: number;
  warnings: string[];
  error?: string;
  policy?: EnforceReport;
}

function upsertTypes(s: ProfileSession, types: readonly ReportType[], now: string): void {
  const st = s.db.prepare(
    `INSERT INTO report_types (id, name, family, version, deprecate_time, system_managed, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, deprecate_time = excluded.deprecate_time,
       system_managed = excluded.system_managed, seen_at = excluded.seen_at`,
  );
  for (const t of types) {
    const { family, version } = familyOf(t.id);
    st.run(t.id, t.name ?? null, family, version, t.deprecateTime ?? null, t.systemManaged ? 1 : 0, now);
  }
}

export function upsertJobs(s: ProfileSession, jobs: readonly Job[], now: string, projectNumber: string | null): void {
  const st = s.db.prepare(
    `INSERT INTO jobs (id, report_type_id, name, create_time, expire_time, system_managed, project_number, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, expire_time = excluded.expire_time,
       system_managed = excluded.system_managed, seen_at = excluded.seen_at, gone_at = NULL,
       project_number = COALESCE(jobs.project_number, excluded.project_number)`,
  );
  for (const j of jobs) {
    st.run(j.id, j.reportTypeId, j.name ?? null, j.createTime ?? null, j.expireTime ?? null, j.systemManaged ? 1 : 0, projectNumber, now);
  }
  const listed = new Set(jobs.map((j) => j.id));
  const known = s.db.prepare('SELECT id FROM jobs WHERE gone_at IS NULL').all() as Array<{ id: string }>;
  for (const k of known) if (!listed.has(k.id)) s.db.prepare('UPDATE jobs SET gone_at = ? WHERE id = ?').run(now, k.id);
}

function upsertVideos(s: ProfileSession, videos: readonly VideoInfo[], uploadIds: readonly string[], now: string): void {
  const st = s.db.prepare(
    `INSERT INTO videos (id, title, description, tags_json, published_at_utc, published_day_pt, duration_s, privacy,
       made_for_kids, default_language, default_audio_language, category_id, live_broadcast, first_seen_at, refreshed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description, tags_json = excluded.tags_json,
       published_at_utc = excluded.published_at_utc, published_day_pt = excluded.published_day_pt, duration_s = excluded.duration_s,
       privacy = excluded.privacy, made_for_kids = excluded.made_for_kids, default_language = excluded.default_language,
       default_audio_language = excluded.default_audio_language, category_id = excluded.category_id,
       live_broadcast = excluded.live_broadcast, refreshed_at = excluded.refreshed_at, metadata_expired_at = NULL, removed_at = NULL`,
  );
  for (const v of videos) {
    st.run(
      v.id,
      v.title,
      v.description,
      JSON.stringify(v.tags),
      v.publishedAt,
      v.publishedAt ? pacificDay(new Date(v.publishedAt)) : null,
      v.durationS,
      v.privacyStatus,
      v.madeForKids === null ? null : v.madeForKids ? 1 : 0,
      v.defaultLanguage,
      v.defaultAudioLanguage,
      v.categoryId,
      v.liveBroadcastContent,
      now,
      now,
    );
  }
  // A video that is no longer in the uploads, or no longer returned, is gone: its metadata is cleared at once (API-11).
  const returned = new Set(videos.map((v) => v.id));
  const inUploads = new Set(uploadIds);
  const known = s.db.prepare('SELECT id FROM videos WHERE removed_at IS NULL').all() as Array<{ id: string }>;
  for (const k of known) {
    if (!returned.has(k.id) || !inUploads.has(k.id)) {
      s.db
        .prepare(
          `UPDATE videos SET removed_at = ?, title = NULL, description = NULL, tags_json = NULL, default_language = NULL,
             default_audio_language = NULL, category_id = NULL WHERE id = ?`,
        )
        .run(now, k.id);
    }
  }
}

async function tryRefreshWith(api: GoogleApi): Promise<RefreshOutcome> {
  try {
    await api.channelMine();
    return 'ok';
  } catch (e) {
    return e instanceof OAuthError && e.definitive ? 'definitive' : 'transient';
  }
}

/** Re-checks archived files on a full sync: a missing or altered file is downloaded again while Google still lists it. */
function verifyArchive(s: ProfileSession): string[] {
  const bad: string[] = [];
  const rows = s.db.prepare('SELECT report_id, path, sha256 FROM report_files').all() as Array<{
    report_id: string;
    path: string;
    sha256: string;
  }>;
  for (const r of rows) {
    const file = path.join(s.pp.dir, r.path);
    let ok = false;
    try {
      ok = sha256Hex(zlib.gunzipSync(fs.readFileSync(file))) === r.sha256;
    } catch {
      ok = false;
    }
    if (!ok) {
      bad.push(r.report_id);
      s.db.prepare('DELETE FROM report_files WHERE report_id = ?').run(r.report_id);
    }
  }
  return bad;
}

export async function runSync(ctx: Ctx, s: ProfileSession, opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = {
    ok: false,
    profile: s.pp.name,
    reportsListed: 0,
    reportsDownloaded: 0,
    reportsFailed: 0,
    videosSeen: 0,
    warnings: [],
  };
  const lock = acquireLock(s.pp.lock, 'sync', () => ctx.clock.now());
  const nowIso = (): string => ctx.clock.now().toISOString();
  const runId = Number(
    s.db
      .prepare('INSERT INTO sync_log (started_at, trigger, app_version, mode) VALUES (?, ?, ?, ?)')
      .run(nowIso(), opts.trigger, APP_VERSION, opts.full ? 'full' : 'quick').lastInsertRowid,
  );
  s.log.info(`sync start profile=${s.pp.name} trigger=${opts.trigger} mode=${opts.full ? 'full' : 'quick'}`);
  const http = ctx.http();
  const { api, quota } = makeApi(s, http);
  const unitsBefore = quota?.used('data') ?? 0;
  try {
    const pre = await enforce(ctx, s, { network: true, tryRefresh: () => tryRefreshWith(api) });
    result.policy = pre;
    if (pre.purged) throw new Error(`The profile was purged: ${pre.purged.reason}.`);
    if (pre.view.state === 'purged') throw new Error('This profile was purged. Run auth to start again.');
    if (pre.view.state === 'unbound') throw new Error(`Profile "${s.pp.name}" is not signed in. Run "creatorlens auth --profile ${s.pp.name}".`);
    if (pre.view.state === 'auth_lost') throw new Error(pre.view.banners[0] ?? 'The sign-in is lost.');

    // 1. Identity: the token must still belong to the bound channel (CMP-12, API-24).
    const bound = getMeta(s.db, 'channel_id');
    const ch = await api.channelMine();
    if (!ch) throw new Error('The signed-in account has no channel (no_channel). Run auth and pick the Brand Account that owns the channel.');
    if (ch.id !== bound) {
      logEvent(s.db, ctx.clock.now(), 'binding', `token now returns ${ch.id}, bound to ${bound}`);
      throw new Error(`This sign-in now belongs to another channel (${ch.id}); the profile is bound to ${bound}. Nothing was synced. Create a new profile for the other channel.`);
    }
    heartbeat(s.pp.lock, 'sync', () => ctx.clock.now());

    // 2. Reporting: lists, lifecycle and downloads.
    const now = nowIso();
    const types = await api.reportTypes();
    upsertTypes(s, types, now);
    const jobs = await api.jobs();
    upsertJobs(s, jobs, now, s.cfg.client?.projectNumber ?? null);
    const plan = planJobs(types, jobs, ctx.clock.now());
    if (plan.create.length) {
      result.warnings.push(
        `${plan.create.length} report type(s) have no job: ${plan.create.join(', ')}. Run "creatorlens reporting enable --profile ${s.pp.name}" in your Terminal.`,
      );
    }
    for (const d of plan.deprecating) {
      result.warnings.push(
        `${d.reportTypeId} is deprecated on ${d.deprecateTime.slice(0, 10)}${d.successor ? `; its successor ${d.successor} ${plan.create.includes(d.successor) ? 'needs "reporting enable"' : 'has a job'}` : '; no successor is offered yet'}.`,
      );
    }
    for (const e of plan.expiring) result.warnings.push(`Job ${e.reportTypeId} expires on ${e.expireTime.slice(0, 10)}.`);
    if (opts.full) {
      const bad = verifyArchive(s);
      if (bad.length) result.warnings.push(`${bad.length} archived file(s) were missing or altered and are fetched again where Google still has them.`);
    }
    const undownloaded: Array<{ report_id: string; job_expire_time: string | null; error: string }> = [];
    for (const job of jobs.filter((j) => !j.systemManaged)) {
      const reports = await api.reports(job.id);
      result.reportsListed += reports.length;
      for (const r of reports) {
        try {
          if (await archiveReport(s, api, job.reportTypeId, r)) result.reportsDownloaded++;
        } catch (e) {
          result.reportsFailed++;
          undownloaded.push({ report_id: r.id, job_expire_time: r.jobExpireTime ?? null, error: errorText(e, 300) });
          if (e instanceof RouteRefused) s.log.error(errorText(e));
        }
      }
      heartbeat(s.pp.lock, 'sync', () => ctx.clock.now());
    }
    markSuperseded(s);
    setMeta(s.db, 'undownloaded', JSON.stringify(undownloaded));
    const soon = undownloaded.filter(
      (u) => u.job_expire_time && Date.parse(u.job_expire_time) - ctx.clock.now().getTime() < 7 * DAY_MS,
    );
    if (soon.length) {
      await ctx.notify('creatorlens', `Profile ${s.pp.name}: ${soon.length} report(s) expire at Google within 7 days and could not be downloaded.`);
    }

    // 3. Own metadata (III.E.4.c: refreshed at least every 30 days; done on every run).
    s.db
      .prepare(
        `INSERT INTO channel (id, title, handle, country, published_at, uploads_playlist_id, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, handle = excluded.handle, country = excluded.country,
           published_at = excluded.published_at, uploads_playlist_id = excluded.uploads_playlist_id,
           refreshed_at = excluded.refreshed_at, metadata_expired_at = NULL`,
      )
      .run(ch.id, ch.title, ch.handle, ch.country, ch.publishedAt, ch.uploadsPlaylistId, nowIso());
    setMeta(s.db, 'channel_title', ch.title);
    if (ch.handle) setMeta(s.db, 'channel_handle', ch.handle);
    const ids = ch.uploadsPlaylistId ? await api.uploads(ch.uploadsPlaylistId) : [];
    const vids = ids.length ? await api.videos(ids) : [];
    upsertVideos(s, vids, ids, nowIso());
    result.videosSeen = vids.length;
    setMeta(s.db, 'metadata_refreshed_at', nowIso());

    // 4. The clocks again, then freshness.
    result.policy = await enforce(ctx, s, { network: true, tryRefresh: () => tryRefreshWith(api) });
    const newest = (s.db.prepare('SELECT MAX(report_day_pt) AS d FROM report_files').get() as { d: string | null }).d;
    if (newest) {
      const age = daysBetweenDays(newest, pacificDay(ctx.clock.now()));
      if (age > POLICY.STALE_DAYS) {
        result.warnings.push(`The newest report is for ${newest}, ${age} days ago (more than ${POLICY.STALE_DAYS}).`);
        await notifyOnce(ctx, s, 'stale', `Profile ${s.pp.name}: the newest report is ${age} days old.`);
      }
    }
    result.ok = result.reportsFailed === 0;
    if (result.reportsFailed) result.error = `${result.reportsFailed} report(s) could not be downloaded; the next run retries.`;
  } catch (e) {
    result.ok = false;
    result.error = errorText(e);
  } finally {
    const units = (quota?.used('data') ?? 0) - unitsBefore;
    s.db
      .prepare(
        `UPDATE sync_log SET finished_at = ?, ok = ?, reports_downloaded = ?, videos_seen = ?, data_units = ?, error = ? WHERE id = ?`,
      )
      .run(nowIso(), result.ok ? 1 : 0, result.reportsDownloaded, result.videosSeen, Math.max(0, units), result.error ?? null, runId);
    if (result.ok) {
      setMeta(s.db, 'last_sync_ok_at', nowIso());
      setMeta(s.db, 'failed_runs_in_row', '0');
    } else {
      const fails = Number(getMeta(s.db, 'failed_runs_in_row') ?? '0') + 1;
      setMeta(s.db, 'failed_runs_in_row', String(fails));
      setMeta(s.db, 'last_sync_failed_at', nowIso());
      if (opts.trigger === 'schedule' && fails >= 2) {
        await notifyOnce(ctx, s, 'failing', `Profile ${s.pp.name}: ${fails} syncs in a row failed. Run "creatorlens doctor".`);
      }
    }
    s.log[result.ok ? 'info' : 'error'](
      `sync end profile=${s.pp.name} ok=${result.ok} downloaded=${result.reportsDownloaded} failed=${result.reportsFailed}${result.error ? ` error=${result.error}` : ''}`,
    );
    quota?.close();
    lock.release();
  }
  return result;
}

/** A notification of a kind at most once a day per profile. */
export async function notifyOnce(ctx: Ctx, s: ProfileSession, kind: string, message: string): Promise<void> {
  const key = `last_notice_${kind}`;
  const last = parseIso(getMeta(s.db, key));
  const now = ctx.clock.now();
  if (last && now.getTime() - last.getTime() < DAY_MS) return;
  setMeta(s.db, key, now.toISOString());
  logEvent(s.db, now, 'notify', kind);
  await ctx.notify('creatorlens', message);
}
