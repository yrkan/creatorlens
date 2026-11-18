// Reporting jobs and the raw archive (YT2.4.1–YT2.4.4; CMP-3, CMP-5, API-7, API-8, API-27, CMP-14).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { planJobs, familyOf } from '../src/reportingPlan.ts';
import { cmdReporting } from '../src/commands/admin.ts';
import { runSync } from '../src/sync.ts';
import { archivePath } from '../src/archive.ts';
import { profileStatus } from '../src/status.ts';
import { openProfile } from '../src/profile.ts';
import { getMeta } from '../src/store/db.ts';
import { makeEnv, seedProfile } from './helpers/env.ts';
import { CHANNEL_ID } from './helpers/fakeGoogle.ts';

const NOW = new Date('2026-11-20T10:00:00Z');

test('families: one job per family, the newest version that is not deprecated, never a system-managed type', () => {
  assert.deepEqual(familyOf('channel_basic_a3'), { family: 'channel_basic', version: 3 });
  assert.deepEqual(familyOf('odd'), { family: 'odd', version: 0 });
  const plan = planJobs(
    [
      { id: 'channel_basic_a2', deprecateTime: '2025-10-31T00:00:00Z' },
      { id: 'channel_basic_a3' },
      { id: 'channel_reach_basic_a1' },
      { id: 'channel_subtitles_a3' },
      { id: 'playlist_basic_a2' },
      { id: 'channel_ad_rates_a1', systemManaged: true },
    ],
    [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
    NOW,
  );
  assert.deepEqual(plan.wanted, ['channel_basic_a3', 'channel_reach_basic_a1', 'channel_subtitles_a3', 'playlist_basic_a2']);
  assert.deepEqual(plan.create, ['channel_reach_basic_a1', 'channel_subtitles_a3', 'playlist_basic_a2']);
  assert.deepEqual(plan.covered, ['channel_basic_a3']);
});

test('a type being deprecated keeps its job while its successor gets one; expiring jobs are listed', () => {
  const plan = planJobs(
    [
      { id: 'channel_basic_a3', deprecateTime: '2027-02-01T00:00:00Z' },
      { id: 'channel_basic_a4' },
    ],
    [{ id: 'j1', reportTypeId: 'channel_basic_a3', expireTime: '2026-12-01T00:00:00Z' }],
    NOW,
  );
  assert.deepEqual(plan.create, ['channel_basic_a4']);
  assert.deepEqual(plan.deprecating, [{ reportTypeId: 'channel_basic_a3', deprecateTime: '2027-02-01T00:00:00Z', successor: 'channel_basic_a4' }]);
  assert.equal(plan.expiring.length, 1);
});

test('reporting enable creates exactly the missing jobs (the list of jobs = the list of types), with the project number', async () => {
  const env = makeEnv({ answers: ['enable en'] });
  const s = await seedProfile(env);
  s.close();
  try {
    env.google.addJob('channel_basic_a3');
    assert.equal(await cmdReporting(env.ctx, { profile: 'en' }, 'enable'), 0);
    const created = env.google.requests.filter((r) => r.method === 'POST' && r.url.pathname === '/v1/jobs');
    assert.deepEqual(
      created.map((r) => JSON.parse(r.body!).reportTypeId).sort(),
      ['channel_reach_basic_a1', 'channel_subtitles_a3', 'channel_traffic_source_a3'],
    );
    const types = env.google.reportTypes.filter((t) => !t.deprecateTime).map((t) => t.id).sort();
    assert.deepEqual(env.google.jobs.map((j) => j.reportTypeId).sort(), types);
    const s2 = openProfile(env.ctx, 'en');
    const rows = s2.db.prepare('SELECT report_type_id, project_number, created_by_creatorlens FROM jobs ORDER BY report_type_id').all() as Array<Record<string, unknown>>;
    s2.close();
    assert.equal(rows.length, 4);
    assert.ok(rows.filter((r) => r.created_by_creatorlens === 1).every((r) => r.project_number === '123456789012'));
    // A second run has nothing to do.
    assert.equal(await cmdReporting(env.ctx, { profile: 'en' }, 'enable'), 0);
    assert.ok(env.out.at(-1)!.includes('already has a job'));
  } finally {
    env.cleanup();
  }
});

test('sync downloads every listed report into the archive, path by type, day, createTime and id; the log matches the listing', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    const basic = env.google.addJob('channel_basic_a3', '2026-10-20T00:00:00Z');
    const traffic = env.google.addJob('channel_traffic_source_a3', '2026-10-20T00:00:00Z');
    for (const day of ['2026-11-15', '2026-11-16', '2026-11-17']) env.google.addReport(basic, day);
    env.google.addReport(traffic, '2026-11-17', { header: 'date,video_id,traffic_source_type,traffic_source_detail,views', rows: ['20261117,zzVideo0001,5,"container sizes, 20 ft",3'] });
    env.google.addReport(traffic, '2026-11-16', { rows: [] }); // a header-only day
    const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.reportsListed, 5);
    assert.equal(r.reportsDownloaded, 5);
    const files = s.db.prepare('SELECT * FROM report_files ORDER BY report_type_id, report_day_pt').all() as Array<Record<string, any>>;
    const listed = [...env.google.reports.values()].flat().map((x) => x.id).sort();
    assert.deepEqual(files.map((f) => f.report_id).sort(), listed, 'report_files matches jobs.reports.list');
    for (const f of files) {
      const abs = path.join(s.pp.dir, f.path);
      assert.equal(fs.statSync(abs).mode & 0o777, 0o600);
      const csv = zlib.gunzipSync(fs.readFileSync(abs)).toString('utf8');
      assert.ok(csv.startsWith('date,'));
      assert.match(f.path, /^reports\/channel_(basic|traffic_source)_a3\/\d{8}_\d{8}T\d{6}Z_[A-Za-z0-9_-]+\.csv\.gz$/);
    }
    const headerOnly = files.find((f) => f.report_type_id === 'channel_traffic_source_a3' && f.report_day_pt === '2026-11-16');
    assert.equal(headerOnly!.rows, 0);
    const quoted = files.find((f) => f.report_type_id === 'channel_traffic_source_a3' && f.report_day_pt === '2026-11-17');
    assert.equal(quoted!.rows, 1);
    assert.deepEqual(JSON.parse(getMeta(s.db, 'download_hosts')!), ['youtubereporting.googleapis.com']);
    // own metadata refreshed with Pacific publish days
    const v = s.db.prepare("SELECT published_day_pt FROM videos WHERE id = 'zzVideo0001'").get() as { published_day_pt: string };
    assert.equal(v.published_day_pt, '2026-11-10');
    // a second sync downloads nothing new
    const r2 = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r2.reportsDownloaded, 0);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('a restatement (same type and day, later createTime) supersedes the earlier file; both are kept', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    const job = env.google.addJob('channel_basic_a3', '2026-10-20T00:00:00Z');
    const first = env.google.addReport(job, '2026-11-10', { createTime: '2026-11-11T23:00:00Z', id: 'repA' });
    const second = env.google.addReport(job, '2026-11-10', { createTime: '2026-11-19T23:00:00Z', id: 'repB' });
    await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    const rows = (s.db.prepare('SELECT report_id, superseded_by FROM report_files ORDER BY report_id').all() as Array<{ report_id: string; superseded_by: string | null }>).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { report_id: first.id, superseded_by: second.id },
      { report_id: second.id, superseded_by: null },
    ]);
    assert.notEqual(archivePath('channel_basic_a3', first), archivePath('channel_basic_a3', second));
  } finally {
    s.close();
    env.cleanup();
  }
});

test('a file served as raw gzip is stored once, not double-compressed; an unknown download host is refused and counted', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    const job = env.google.addJob('channel_basic_a3', '2026-10-20T00:00:00Z');
    const rep = env.google.addReport(job, '2026-11-17');
    const m = env.google.media.get(new URL(rep.downloadUrl).pathname)!;
    m.rawGzip = true;
    const bad = env.google.addReport(job, '2026-11-18', { id: 'repEvil' });
    env.google.media.set(new URL(bad.downloadUrl).pathname, { location: 'https://storage.example.net/file' });
    const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r.reportsDownloaded, 1);
    assert.equal(r.reportsFailed, 1);
    assert.equal(r.ok, false);
    assert.ok(!env.google.requests.some((x) => x.url.hostname === 'storage.example.net'));
    const f = s.db.prepare('SELECT path FROM report_files').get() as { path: string };
    const csv = zlib.gunzipSync(fs.readFileSync(path.join(s.pp.dir, f.path))).toString('utf8');
    assert.ok(csv.startsWith('date,'));
    const st = profileStatus(env.ctx, 'en');
    assert.equal(st.freshness.undownloaded, 1);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('lifetimes: a deprecated type, an expiring job and a stale archive raise warnings and a notification', async () => {
  const env = makeEnv({ now: '2026-11-30T10:00:00Z' });
  const s = await seedProfile(env);
  try {
    env.google.reportTypes = [
      { id: 'channel_basic_a3', name: 'User activity', deprecateTime: '2027-01-15T00:00:00Z' },
      { id: 'channel_basic_a4', name: 'User activity v4' },
    ];
    const job = env.google.addJob('channel_basic_a3', '2026-10-01T00:00:00Z');
    job.expireTime = '2026-12-10T00:00:00Z';
    env.google.addReport(job, '2026-11-20');
    const r = await runSync(env.ctx, s, { full: false, trigger: 'schedule' });
    const w = r.warnings.join('\n');
    assert.match(w, /channel_basic_a3 is deprecated on 2027-01-15; its successor channel_basic_a4 needs "reporting enable"/);
    assert.match(w, /expires on 2026-12-10/);
    assert.match(w, /newest report is for 2026-11-20, 10 days ago/);
    assert.ok(env.notes.some((n) => /days old/.test(n.message)));
    const st = profileStatus(env.ctx, 'en');
    assert.equal(st.freshness.stale, true);
    assert.equal(st.jobs[0]!.state, 'stale');
    assert.equal(st.channel?.id, CHANNEL_ID);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('a new job waits for its first report (pending_first_report), then says no_reports_yet after 72 hours', async () => {
  const env = makeEnv({ now: '2026-11-20T12:00:00Z' });
  const s = await seedProfile(env);
  try {
    env.google.addJob('channel_basic_a3', '2026-11-20T10:00:00Z');
    await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(profileStatus(env.ctx, 'en').jobs[0]!.state, 'pending_first_report');
    env.clock.advanceDays(4);
    assert.equal(profileStatus(env.ctx, 'en').jobs[0]!.state, 'no_reports_yet');
  } finally {
    s.close();
    env.cleanup();
  }
});

test('a token that now returns another channel stops the sync (the profile is bound to its channel)', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    env.google.channel = { id: 'UCzzSYNTHETICchannel0009', title: 'Other', handle: '@other', uploads: 'UUzz' };
    const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /belongs to another channel/);
    assert.equal(env.google.requests.filter((x) => x.url.hostname === 'youtubereporting.googleapis.com').length, 0);
  } finally {
    s.close();
    env.cleanup();
  }
});
