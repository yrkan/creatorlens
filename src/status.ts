// `creatorlens status --json` and the `status` tool: operational state only (identity, sign-in clocks, jobs, freshness,
// schedule, warnings). No figure about the channel's audience and no stranger's text, so the skills may read it through
// an allow rule for exactly that command (toolkit § 5.2). It never touches the network.

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { listProfiles, openProfileReader } from './profile.ts';
import { getMeta } from './store/db.ts';
import { policyView, POLICY, nextPurge, type PolicyView } from './policy.ts';
import { launchLabel } from './paths.ts';
import { APP_VERSION, SCHEMA_VERSION } from './version.ts';
import { pacificDay, daysBetweenDays } from './util/pacific.ts';
import { HOSTS } from './google/routes.ts';
import { treeSize } from './util/fsx.ts';
import { loadConfig, termsAccepted } from './config.ts';

export type JobState = 'pending_first_report' | 'no_reports_yet' | 'ok' | 'stale';

export interface JobStatus {
  report_type_id: string;
  job_id: string;
  created: string | null;
  first_expected_report_after: string | null;
  expire_time: string | null;
  deprecate_time: string | null;
  newest_report_day: string | null;
  files: number;
  state: JobState;
}

export interface ProfileStatus {
  profile: string;
  state: PolicyView['state'];
  channel: { id: string; title: string | null; handle: string | null } | null;
  sign_in: {
    store: string | null;
    consent_at: string | null;
    oauth_mode: string | null;
    last_refresh_ok_at: string | null;
    auth_lost_at: string | null;
    auth_lost_code: string | null;
    purge_due_at: string | null;
    testing_warning: string | null;
  };
  jobs: JobStatus[];
  types_without_job: string[];
  freshness: {
    newest_report_day: string | null;
    stale: boolean;
    archive_files: number;
    archive_bytes: number;
    undownloaded: number;
    earliest_undownloaded_expiry: string | null;
  };
  videos: { known: number; removed: number; state: 'no_uploads' | 'ok' | 'unknown' };
  last_sync: { started_at: string; finished_at: string | null; ok: boolean | null; trigger: string; error: string | null } | null;
  last_sync_ok_at: string | null;
  failed_runs_in_row: number;
  schedule: { installed: boolean; label: string };
  download_hosts: string[];
  banners: string[];
  warnings: string[];
}

export interface StatusReport {
  app_version: string;
  schema_version: number;
  data_folder: string;
  terms_accepted: boolean;
  client_configured: boolean;
  generated_at: string;
  profiles: ProfileStatus[];
}

const HOUR = 3_600_000;

export function profileStatus(ctx: Ctx, name: string): ProfileStatus {
  const { pp, db } = openProfileReader(ctx, name);
  try {
    const now = ctx.clock.now();
    const view = policyView(db, now);
    const today = pacificDay(now);
    const warnings: string[] = [];
    const channelId = getMeta(db, 'channel_id');
    const jobs = db
      .prepare(
        `SELECT j.id, j.report_type_id, j.create_time, j.expire_time, t.deprecate_time,
           (SELECT MAX(report_day_pt) FROM report_files f WHERE f.job_id = j.id) AS newest,
           (SELECT COUNT(*) FROM report_files f WHERE f.job_id = j.id) AS files
         FROM jobs j LEFT JOIN report_types t ON t.id = j.report_type_id
         WHERE j.gone_at IS NULL AND j.system_managed = 0 ORDER BY j.report_type_id`,
      )
      .all() as Array<{
      id: string;
      report_type_id: string;
      create_time: string | null;
      expire_time: string | null;
      deprecate_time: string | null;
      newest: string | null;
      files: number;
    }>;
    const jobStatuses: JobStatus[] = jobs.map((j) => {
      const created = j.create_time ? Date.parse(j.create_time) : NaN;
      let state: JobState;
      if (!j.newest) state = !Number.isNaN(created) && now.getTime() < created + 72 * HOUR ? 'pending_first_report' : 'no_reports_yet';
      else state = daysBetweenDays(j.newest, today) > POLICY.STALE_DAYS ? 'stale' : 'ok';
      if (j.deprecate_time) warnings.push(`${j.report_type_id} is deprecated on ${j.deprecate_time.slice(0, 10)}.`);
      return {
        report_type_id: j.report_type_id,
        job_id: j.id,
        created: j.create_time,
        first_expected_report_after: Number.isNaN(created) ? null : new Date(created + 48 * HOUR).toISOString(),
        expire_time: j.expire_time,
        deprecate_time: j.deprecate_time,
        newest_report_day: j.newest,
        files: Number(j.files),
        state,
      };
    });
    const typesWithout = (
      db
        .prepare(
          `SELECT t.id FROM report_types t WHERE t.system_managed = 0
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.report_type_id = t.id AND j.gone_at IS NULL)
             AND (t.deprecate_time IS NULL OR t.deprecate_time > ?)
             AND t.version = (SELECT MAX(version) FROM report_types u WHERE u.family = t.family AND u.system_managed = 0
                              AND (u.deprecate_time IS NULL OR u.deprecate_time > ?))`,
        )
        .all(now.toISOString(), now.toISOString()) as Array<{ id: string }>
    ).map((r) => r.id);
    if (channelId && typesWithout.length) warnings.push(`Report types without a job: ${typesWithout.join(', ')} (run "reporting enable").`);
    if (channelId && jobs.length === 0) warnings.push('No Reporting jobs yet: run "creatorlens reporting enable" in your Terminal.');
    const newest = (db.prepare('SELECT MAX(report_day_pt) AS d FROM report_files').get() as { d: string | null }).d;
    const stale = newest ? daysBetweenDays(newest, today) > POLICY.STALE_DAYS : jobStatuses.some((j) => j.state === 'no_reports_yet');
    if (stale) warnings.push(`Data is stale: the newest report is ${newest ?? 'missing'}.`);
    const files = (db.prepare('SELECT COUNT(*) AS n FROM report_files').get() as { n: number }).n;
    const undl = JSON.parse(getMeta(db, 'undownloaded') ?? '[]') as Array<{ job_expire_time: string | null }>;
    const earliest = undl.map((u) => u.job_expire_time).filter(Boolean).sort()[0] ?? null;
    if (undl.length) warnings.push(`${undl.length} report(s) listed by Google could not be downloaded yet.`);
    const known = (db.prepare('SELECT COUNT(*) AS n FROM videos WHERE removed_at IS NULL').get() as { n: number }).n;
    const removed = (db.prepare('SELECT COUNT(*) AS n FROM videos WHERE removed_at IS NOT NULL').get() as { n: number }).n;
    const lastSyncRow = db
      .prepare('SELECT started_at, finished_at, ok, trigger, error FROM sync_log ORDER BY id DESC LIMIT 1')
      .get() as { started_at: string; finished_at: string | null; ok: number | null; trigger: string; error: string | null } | undefined;
    const lastOk = getMeta(db, 'last_sync_ok_at') ?? null;
    if (channelId && (!lastOk || now.getTime() - Date.parse(lastOk) > 26 * HOUR)) warnings.push('No successful sync in the last 26 hours.');
    const hosts = JSON.parse(getMeta(db, 'download_hosts') ?? '[]') as string[];
    for (const h of hosts) if (h !== HOSTS.reporting) warnings.push(`Reports came from an unexpected host: ${h}.`);
    const label = launchLabel(name);
    const installed = fs.existsSync(path.join(ctx.paths.launchAgentsDir, `${label}.plist`));
    if (channelId && !installed) warnings.push('No daily schedule: run "creatorlens schedule install" in your Terminal.');
    const title = getMeta(db, 'channel_title') ?? null;
    const handle = getMeta(db, 'channel_handle') ?? null;
    return {
      profile: name,
      state: view.state,
      channel: channelId ? { id: channelId, title, handle } : null,
      sign_in: {
        store: getMeta(db, 'token_store') ?? null,
        consent_at: view.consentAt ?? null,
        oauth_mode: view.mode ?? null,
        last_refresh_ok_at: view.lastRefreshOkAt ?? null,
        auth_lost_at: view.authLostAt ?? null,
        auth_lost_code: view.authLostCode ?? null,
        purge_due_at: nextPurge(view) ?? null,
        testing_warning: view.testingWarning ?? null,
      },
      jobs: jobStatuses,
      types_without_job: typesWithout,
      freshness: {
        newest_report_day: newest,
        stale,
        archive_files: Number(files),
        archive_bytes: treeSize(pp.reports),
        undownloaded: undl.length,
        earliest_undownloaded_expiry: earliest,
      },
      videos: { known: Number(known), removed: Number(removed), state: !channelId ? 'unknown' : known === 0 ? 'no_uploads' : 'ok' },
      last_sync: lastSyncRow
        ? {
            started_at: lastSyncRow.started_at,
            finished_at: lastSyncRow.finished_at,
            ok: lastSyncRow.ok === null ? null : lastSyncRow.ok === 1,
            trigger: lastSyncRow.trigger,
            error: lastSyncRow.error,
          }
        : null,
      last_sync_ok_at: lastOk,
      failed_runs_in_row: Number(getMeta(db, 'failed_runs_in_row') ?? '0'),
      schedule: { installed, label },
      download_hosts: hosts,
      banners: view.banners,
      warnings,
    };
  } finally {
    db.close();
  }
}

export function buildStatus(ctx: Ctx, profile?: string): StatusReport {
  const cfg = loadConfig(ctx.paths, ctx.platform);
  const names = profile ? [profile] : listProfiles(ctx);
  return {
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    data_folder: ctx.paths.root,
    terms_accepted: termsAccepted(cfg),
    client_configured: Boolean(cfg.client),
    generated_at: ctx.clock.now().toISOString(),
    profiles: names.map((n) => profileStatus(ctx, n)),
  };
}
