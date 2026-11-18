// `creatorlens doctor [--json]`: checks everything that can stop the data from arriving, per profile (design v2 § 9;
// UX-16, CMP-11, CMP-19). "Green" means no check failed; warnings are allowed. Live checks (token refresh, the bound
// channel, the three APIs, job coverage) need the network and are skipped with --offline. Output is redacted.

import type { Ctx } from './context.ts';
import { loadConfig, termsAccepted } from './config.ts';
import { listProfiles, makeApi, openProfile, tokenStoreOf } from './profile.ts';
import { getMeta } from './store/db.ts';
import { enforce, type RefreshOutcome } from './policy.ts';
import { profileStatus } from './status.ts';
import { scheduleStatus, isPinned, versionAtLeast } from './schedule.ts';
import { planJobs } from './reportingPlan.ts';
import { OAuthError } from './google/oauth.ts';
import { HttpError } from './google/http.ts';
import { HOSTS } from './google/routes.ts';
import { CLIENT_ACCOUNT } from './secrets.ts';
import { errorText } from './util/redact.ts';
import { pacificDay } from './util/pacific.ts';
import { addDays } from './util/clock.ts';
import { APP_VERSION, NODE_MIN, NODE_PINNED, SCHEMA_VERSION } from './version.ts';
import type { GoogleApi } from './google/api.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export interface ProfileDoctor {
  profile: string;
  ok: boolean;
  checks: Check[];
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  app: { version: string; schema: number; entry: string; pinned: boolean };
  host: Check[];
  profiles: ProfileDoctor[];
}

const SERVICE_FOR: Record<string, string> = {
  data: 'youtube.googleapis.com',
  analytics: 'youtubeanalytics.googleapis.com',
  reporting: 'youtubereporting.googleapis.com',
};

function apiHint(e: unknown, which: keyof typeof SERVICE_FOR, projectId?: string): string {
  if (e instanceof HttpError && e.status === 403 && /accessNotConfigured|SERVICE_DISABLED|disabled/i.test(`${e.reason} ${e.bodyText}`)) {
    return `the API is not enabled in the Cloud project: https://console.cloud.google.com/apis/library/${SERVICE_FOR[which]}${projectId ? `?project=${projectId}` : ''}`;
  }
  return errorText(e, 300);
}

function hostChecks(ctx: Ctx): Check[] {
  const checks: Check[] = [];
  if (ctx.platform === 'darwin') checks.push({ id: 'platform', status: 'pass', detail: 'macOS' });
  else if (ctx.platform === 'win32') checks.push({ id: 'platform', status: 'fail', detail: 'Windows is not supported.' });
  else checks.push({ id: 'platform', status: 'fail', detail: `${ctx.platform} is supported from v2 (macOS only in v0 and v1).` });
  const v = process.versions.node;
  checks.push({
    id: 'node',
    status: versionAtLeast(v, NODE_MIN) ? (v === NODE_PINNED ? 'pass' : 'warn') : 'fail',
    detail: `${ctx.execPath} is ${v}; ${NODE_MIN} or later is required, ${NODE_PINNED} is the pinned version.`,
  });
  if (ctx.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    checks.push({ id: 'tls', status: 'fail', detail: 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off; creatorlens refuses to send credentials.' });
  }
  const pinned = isPinned(ctx, ctx.appEntry);
  checks.push({
    id: 'app',
    status: pinned ? 'pass' : 'warn',
    detail: pinned ? `pinned copy ${ctx.appEntry}` : `running from ${ctx.appEntry}, not a pinned copy (run "creatorlens install")`,
  });
  const cfg = loadConfig(ctx.paths, ctx.platform);
  checks.push({
    id: 'terms',
    status: termsAccepted(cfg) ? 'pass' : 'fail',
    detail: termsAccepted(cfg) ? `accepted on ${cfg.terms?.acceptedAt.slice(0, 10)}` : 'not accepted: run "creatorlens setup"',
  });
  checks.push({
    id: 'client',
    status: cfg.client ? 'pass' : 'fail',
    detail: cfg.client ? `project ${cfg.client.projectId} (number ${cfg.client.projectNumber})` : 'no OAuth client: run "creatorlens setup --client-json <file>"',
  });
  return checks;
}

export async function doctorProfile(ctx: Ctx, name: string, opts: { offline: boolean }): Promise<ProfileDoctor> {
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, detail: string): void => {
    checks.push({ id, status, detail });
  };
  let s;
  try {
    s = openProfile(ctx, name);
  } catch (e) {
    add('store', 'fail', errorText(e));
    return { profile: name, ok: false, checks };
  }
  try {
    const integrity = (s.db.prepare('PRAGMA integrity_check').get() as Record<string, string>)?.integrity_check;
    add('store', integrity === 'ok' ? 'pass' : 'fail', `integrity ${integrity}; schema ${getMeta(s.db, 'schema_version')} of ${SCHEMA_VERSION}`);
    const bound = getMeta(s.db, 'channel_id');
    add('binding', bound ? 'pass' : 'fail', bound ? `bound to ${bound}` : `not signed in: run "creatorlens auth --profile ${name}"`);
    const kind = tokenStoreOf(s);
    let tokenPresent = false;
    try {
      tokenPresent = Boolean(await ctx.secrets(kind).get(name));
      add('token', tokenPresent ? 'pass' : 'fail', tokenPresent ? `in the ${kind} store` : `missing from the ${kind} store`);
    } catch (e) {
      add('token', 'fail', errorText(e));
    }
    try {
      const client = await ctx.secrets(s.cfg.tokenStore).get(CLIENT_ACCOUNT);
      add('client_secret', client ? 'pass' : 'fail', client ? 'present' : 'missing: run "creatorlens setup"');
    } catch (e) {
      add('client_secret', 'fail', errorText(e));
    }

    let api: GoogleApi | undefined;
    let quota: { close(): void } | undefined;
    const tryRefresh = async (): Promise<RefreshOutcome> => {
      try {
        await api!.channelMine();
        return 'ok';
      } catch (e) {
        return e instanceof OAuthError && e.definitive ? 'definitive' : 'transient';
      }
    };
    if (!opts.offline && bound && tokenPresent) {
      const made = makeApi(s, ctx.http());
      api = made.api;
      quota = made.quota;
    }
    const pol = await enforce(ctx, s, { network: Boolean(api), ...(api ? { tryRefresh } : {}) });
    if (pol.purged) add('policy', 'fail', `purged now: ${pol.purged.reason}`);
    const view = pol.view;
    if (view.state === 'auth_lost') add('sign_in', 'fail', view.banners[0] ?? 'sign-in lost');
    else if (view.state === 'unconfirmed') add('sign_in', 'fail', view.banners[0] ?? 'sign-in unconfirmed');
    else if (view.state === 'purged') add('sign_in', 'fail', view.banners[0] ?? 'purged');
    else if (view.state === 'authorized') add('sign_in', 'pass', `last good refresh ${view.lastRefreshOkAt}`);
    if (view.testingWarning) add('testing_mode', 'warn', view.testingWarning);

    if (api && view.state === 'authorized') {
      try {
        const ch = await api.channelMine();
        if (!ch) add('channel', 'fail', 'the signed-in account has no channel (no_channel)');
        else add('channel', ch.id === bound ? 'pass' : 'fail', ch.id === bound ? `${ch.id} (${ch.handle ?? ch.title})` : `token returns ${ch.id}, profile bound to ${bound}`);
        add('data_api', 'pass', 'answers');
      } catch (e) {
        add('channel', 'fail', apiHint(e, 'data', s.cfg.client?.projectId));
      }
      try {
        await api.analyticsProbe(pacificDay(addDays(ctx.clock.now(), -3)));
        add('analytics_api', 'pass', 'answers (the figures are not read or kept)');
      } catch (e) {
        add('analytics_api', 'fail', apiHint(e, 'analytics', s.cfg.client?.projectId));
      }
      try {
        const types = await api.reportTypes();
        const jobs = await api.jobs();
        const plan = planJobs(types, jobs, ctx.clock.now());
        add(
          'reporting_jobs',
          plan.create.length ? 'fail' : jobs.length ? 'pass' : 'fail',
          plan.create.length
            ? `${plan.create.length} report type(s) without a job (${plan.create.join(', ')}): run "creatorlens reporting enable --profile ${name}"`
            : `${plan.covered.length} report types, each with a job`,
        );
        for (const d of plan.deprecating) {
          add('deprecation', d.successor && !plan.create.includes(d.successor) ? 'warn' : 'fail', `${d.reportTypeId} ends ${d.deprecateTime.slice(0, 10)}; successor ${d.successor ?? 'none yet'}`);
        }
        for (const x of plan.expiring) add('job_expiry', 'warn', `${x.reportTypeId} job ends ${x.expireTime.slice(0, 10)}`);
      } catch (e) {
        add('reporting_jobs', 'fail', apiHint(e, 'reporting', s.cfg.client?.projectId));
      }
    } else if (opts.offline) {
      add('live', 'skip', 'offline: token refresh, channel, APIs and job coverage not checked');
    }

    const st = profileStatus(ctx, name);
    const stale = st.jobs.filter((j) => j.state === 'stale' || j.state === 'no_reports_yet');
    const pending = st.jobs.filter((j) => j.state === 'pending_first_report');
    if (st.jobs.length) {
      add(
        'reports',
        stale.length ? 'fail' : 'pass',
        stale.length
          ? `${stale.length} job(s) have no recent report: ${stale.map((j) => `${j.report_type_id} (${j.newest_report_day ?? 'none'})`).join(', ')}`
          : `newest report ${st.freshness.newest_report_day ?? '—'}${pending.length ? `; ${pending.length} job(s) wait for their first report (about 48 h after creation)` : ''}`,
      );
    }
    if (st.freshness.undownloaded) add('downloads', 'fail', `${st.freshness.undownloaded} listed report(s) not downloaded yet`);
    const odd = st.download_hosts.filter((h) => h !== HOSTS.reporting);
    add('download_host', odd.length ? 'fail' : 'pass', odd.length ? `unexpected host(s): ${odd.join(', ')}` : st.download_hosts.length ? HOSTS.reporting : 'no download yet');
    if (st.failed_runs_in_row >= 2) add('sync', 'fail', `${st.failed_runs_in_row} failed syncs in a row: ${st.last_sync?.error ?? ''}`);
    else if (!st.last_sync_ok_at) add('sync', bound ? 'warn' : 'skip', 'no successful sync yet');
    else {
      const age = ctx.clock.now().getTime() - Date.parse(st.last_sync_ok_at);
      add('sync', age > 26 * 3_600_000 ? 'warn' : 'pass', `last success ${st.last_sync_ok_at}`);
    }
    add('archive', 'pass', `${st.freshness.archive_files} files, ${st.freshness.archive_bytes} bytes`);

    const sch = await scheduleStatus(ctx, name, { live: true });
    if (!sch.installed) add('schedule', 'fail', `not installed: run "creatorlens schedule install --profile ${name}"`);
    else add('schedule', sch.problems.length ? 'fail' : 'pass', sch.problems.length ? sch.problems.join('; ') : `${sch.time} daily, ${sch.nodePath} ${sch.nodeVersion ?? ''}`);
    quota?.close();
  } catch (e) {
    add('doctor', 'fail', errorText(e));
  } finally {
    s.close();
  }
  return { profile: name, ok: !checks.some((c) => c.status === 'fail'), checks };
}

export async function runDoctor(ctx: Ctx, opts: { profile?: string; offline: boolean }): Promise<DoctorReport> {
  const host = hostChecks(ctx);
  const names = opts.profile ? [opts.profile] : listProfiles(ctx);
  const profiles: ProfileDoctor[] = [];
  for (const n of names) profiles.push(await doctorProfile(ctx, n, opts));
  if (names.length === 0) host.push({ id: 'profiles', status: 'fail', detail: 'no profile yet: run "creatorlens auth --profile en"' });
  const ok = !host.some((c) => c.status === 'fail') && profiles.every((p) => p.ok);
  return {
    ok,
    generated_at: ctx.clock.now().toISOString(),
    app: { version: APP_VERSION, schema: SCHEMA_VERSION, entry: ctx.appEntry, pinned: isPinned(ctx, ctx.appEntry) },
    host,
    profiles,
  };
}

export function formatDoctor(r: DoctorReport): string {
  const mark = (s: CheckStatus): string => ({ pass: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: '--  ' })[s];
  const lines = [`creatorlens ${r.app.version} doctor: ${r.ok ? 'GREEN' : 'RED'}`];
  for (const c of r.host) lines.push(`  ${mark(c.status)} ${c.id}: ${c.detail}`);
  for (const p of r.profiles) {
    lines.push(`profile ${p.profile}: ${p.ok ? 'green' : 'red'}`);
    for (const c of p.checks) lines.push(`  ${mark(c.status)} ${c.id}: ${c.detail}`);
  }
  return lines.join('\n');
}
