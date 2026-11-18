// The policy clocks on a fake clock (YT2.5; API-1, CMP-2, SEC-9, API-11): revocation, the lost sign-in (purge at the
// last good refresh + 28 days), the unconfirmed sign-in (30 days), own metadata (30 days), other channels' data
// (30 days), creatorlens's backups (7 days), and the checks at the server's start and on every call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enforce, policyView, POLICY } from '../src/policy.ts';
import { runSync } from '../src/sync.ts';
import { cmdRevoke } from '../src/commands/admin.ts';
import { checkProfile } from '../src/check.ts';
import { openProfile, openProfileReader } from '../src/profile.ts';
import { getMeta, setMeta } from '../src/store/db.ts';
import { openDatabase } from '../src/store/sqlite.ts';
import { saveConfig, loadConfig } from '../src/config.ts';
import { makeEnv, seedProfile } from './helpers/env.ts';
import { CHANNEL_ID } from './helpers/fakeGoogle.ts';

async function syncedProfile(env: ReturnType<typeof makeEnv>) {
  const s = await seedProfile(env);
  const job = env.google.addJob('channel_basic_a3', '2026-10-20T00:00:00Z');
  env.google.addReport(job, '2026-11-17');
  env.google.addReport(job, '2026-11-18');
  const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
  assert.equal(r.ok, true, r.error ?? "");
  return s;
}

function count(s: { db: ReturnType<typeof openDatabase> }, table: string): number {
  return Number((s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

test('path 1 — revoke: jobs offered for deletion, token revoked at Google, everything purged in the same run', async () => {
  const env = makeEnv({ answers: ['revoke en', 'delete jobs'] });
  const s = await syncedProfile(env);
  const transcripts = path.join(env.ctx.homedir, '.claude', 'projects', '-Users-test-YouTube-analysis');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(transcripts, 'session-1.jsonl'), '{"tool_result":"synthetic"}\n');
  saveConfig(env.ctx.paths, { ...loadConfig(env.ctx.paths, 'darwin'), transcriptDirs: [transcripts] });
  fs.mkdirSync(s.pp.backups, { recursive: true });
  fs.writeFileSync(path.join(s.pp.backups, 'purge-20261119T100000Z'), 'copy');
  s.close();
  try {
    assert.equal(await cmdRevoke(env.ctx, { profile: 'en' }), 0);
    assert.equal(env.google.revoked.length, 1, 'POST /revoke was sent');
    assert.equal(env.google.jobs.length, 0, 'the Reporting jobs were deleted on request');
    assert.equal(await env.secrets.get('en'), null, 'the token is gone');
    const after = openProfile(env.ctx, 'en');
    try {
      for (const t of ['channel', 'videos', 'jobs', 'report_files', 'report_types', 'sync_log']) assert.equal(count(after, t), 0, t);
      assert.equal(getMeta(after.db, 'channel_id'), undefined);
      assert.equal(getMeta(after.db, 'purge_reason'), 'revoked by the operator');
      assert.equal(policyView(after.db, env.clock.now()).state, 'purged');
    } finally {
      after.close();
    }
    assert.ok(!fs.existsSync(path.join(env.ctx.paths.profilesDir, 'en', 'reports')), 'archive deleted');
    assert.ok(!fs.existsSync(path.join(env.ctx.paths.profilesDir, 'en', 'backups')), 'backups deleted');
    assert.deepEqual(fs.readdirSync(transcripts), [], 'configured transcripts deleted');
    assert.ok(env.out.some((l) => /Nothing was deleted on YouTube/.test(l)), 'the III.E.4.g notice');
  } finally {
    env.cleanup();
  }
});

test('path 2 — lost sign-in: banner and daily notice from the first invalid_grant, purge at the last good refresh + 28 days', async () => {
  const env = makeEnv({ now: '2026-11-20T10:00:00Z' });
  const s = await syncedProfile(env);
  try {
    env.clock.advanceDays(2);
    env.google.tokenQueue.push({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const r = await runSync(env.ctx, s, { full: false, trigger: 'schedule' });
    assert.equal(r.ok, false);
    let v = policyView(s.db, env.clock.now());
    assert.equal(v.state, 'auth_lost');
    assert.equal(v.purgeDueAt, '2026-12-18T10:00:00.000Z', 'last good refresh 2026-11-20 + 28 days');
    assert.match(v.banners[0]!, /SIGN-IN LOST/);
    const notes = env.notes.length;
    // The next sync stops at once: no request after the loss.
    const before = env.google.requests.length;
    await runSync(env.ctx, s, { full: false, trigger: 'schedule' });
    assert.equal(env.google.requests.length, before, 'nothing syncs after the loss');
    // A day later the reminder comes again; on day 27 nothing is purged yet.
    env.clock.set('2026-12-17T10:00:00Z');
    let rep = await enforce(env.ctx, s, { network: false });
    assert.equal(rep.purged, undefined);
    assert.ok(env.notes.length > notes, 'a daily notification');
    assert.ok(count(s, 'report_files') > 0);
    // Day 28: everything goes, the token too.
    env.clock.set('2026-12-18T10:00:01Z');
    rep = await enforce(env.ctx, s, { network: false });
    assert.ok(rep.purged);
    assert.equal(count(s, 'report_files'), 0);
    assert.equal(count(s, 'videos'), 0);
    assert.equal(await env.secrets.get('en'), null);
    v = policyView(s.db, env.clock.now());
    assert.equal(v.state, 'purged');
  } finally {
    s.close();
    env.cleanup();
  }
});

test('path 2b — a refresh that succeeds again before day 28 clears the clock', async () => {
  const env = makeEnv();
  const s = await syncedProfile(env);
  try {
    env.google.tokenQueue.push({ status: 400, body: { error: 'invalid_grant' } });
    await runSync(env.ctx, s, { full: false, trigger: 'schedule' });
    assert.equal(policyView(s.db, env.clock.now()).state, 'auth_lost');
    // The owner signs in again (simulated as auth does: the binding stays, the loss is cleared).
    setMeta(s.db, 'last_refresh_ok_at', env.clock.now().toISOString());
    s.db.prepare("DELETE FROM meta WHERE key IN ('auth_lost_at', 'auth_lost_code')").run();
    env.clock.advanceDays(29);
    const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(policyView(s.db, env.clock.now()).state, 'authorized');
    assert.ok(count(s, 'report_files') > 0);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('path 3 — own metadata not refreshed for 30 days is cleared; a refresh keeps it', async () => {
  const env = makeEnv();
  const s = await syncedProfile(env);
  try {
    env.clock.advanceDays(29);
    await enforce(env.ctx, s, { network: false });
    assert.ok((s.db.prepare("SELECT title FROM videos WHERE id = 'zzVideo0001'").get() as { title: string | null }).title);
    env.clock.advanceDays(1.01);
    const rep = await enforce(env.ctx, s, { network: false });
    assert.ok(rep.metadataExpired >= 3, 'two videos and the channel row');
    const v = s.db.prepare("SELECT title, description, tags_json, metadata_expired_at FROM videos WHERE id = 'zzVideo0001'").get() as Record<string, unknown>;
    assert.equal(v.title, null);
    assert.equal(v.description, null);
    assert.equal(v.tags_json, null);
    assert.ok(v.metadata_expired_at);
    const c = s.db.prepare('SELECT title, handle FROM channel').get() as Record<string, unknown>;
    assert.equal(c.title, null);
    // Statistics (the archive) are kept while the authorization holds.
    assert.ok(count(s, 'report_files') > 0);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('a deleted video loses its metadata at the next sync', async () => {
  const env = makeEnv();
  const s = await syncedProfile(env);
  try {
    env.google.videos = env.google.videos.filter((v) => v.id !== 'zzVideo0002');
    await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    const v = s.db.prepare("SELECT title, removed_at FROM videos WHERE id = 'zzVideo0002'").get() as Record<string, unknown>;
    assert.equal(v.title, null);
    assert.ok(v.removed_at);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('path 4 — a sign-in unconfirmed for 30 days: the next networked check confirms it, or purges', async () => {
  const env = makeEnv();
  const s = await syncedProfile(env);
  try {
    env.clock.advanceDays(POLICY.UNCONFIRMED_DAYS + 1);
    // The server cannot reach Google: it blocks the data and purges nothing.
    let rep = await enforce(env.ctx, s, { network: false });
    assert.equal(rep.view.state, 'unconfirmed');
    assert.equal(rep.view.blockData, true);
    assert.equal(rep.purged, undefined);
    // A sync confirms it: nothing is lost.
    const r = await runSync(env.ctx, s, { full: false, trigger: 'manual' });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(policyView(s.db, env.clock.now()).state, 'authorized');
    // Thirty days later Google is unreachable: the networked check purges.
    env.clock.advanceDays(POLICY.UNCONFIRMED_DAYS + 1);
    rep = await enforce(env.ctx, s, { network: true, tryRefresh: async () => 'transient' });
    assert.ok(rep.purged);
    assert.equal(count(s, 'report_files'), 0);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('path 5 — other channels\' data in public.db is deleted 30 days after it was fetched', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    const pub = openDatabase(env.ctx.paths.publicDb);
    pub.exec('CREATE TABLE public_videos (id TEXT, untrusted_title TEXT, fetched_at TEXT); CREATE TABLE no_clock (id TEXT);');
    pub.prepare('INSERT INTO public_videos VALUES (?, ?, ?)').run('zzPublic001', 'old', '2026-10-01T00:00:00Z');
    pub.prepare('INSERT INTO public_videos VALUES (?, ?, ?)').run('zzPublic002', 'fresh', '2026-11-15T00:00:00Z');
    pub.prepare('INSERT INTO no_clock VALUES (?)').run('x');
    pub.close();
    const rep = await enforce(env.ctx, s, { network: false });
    assert.equal(rep.publicRowsDeleted, 2, 'the 50-day-old row and the row that cannot be aged');
    const check = openDatabase(env.ctx.paths.publicDb);
    assert.deepEqual((check.prepare('SELECT id FROM public_videos').all() as Array<{ id: string }>).map((r) => r.id), ['zzPublic002']);
    check.close();
    env.clock.advanceDays(30);
    assert.equal((await enforce(env.ctx, s, { network: false })).publicRowsDeleted, 1);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('path 6 — creatorlens\'s own copies are deleted after 7 days', async () => {
  const env = makeEnv({ now: '2026-11-20T10:00:00Z' });
  const s = await seedProfile(env);
  try {
    fs.mkdirSync(path.join(s.pp.backups, 'purge-20261112T090000Z'), { recursive: true });
    fs.mkdirSync(path.join(s.pp.backups, 'purge-20261118T090000Z'), { recursive: true });
    const rep = await enforce(env.ctx, s, { network: false });
    assert.equal(rep.backupsDeleted, 1);
    assert.deepEqual(fs.readdirSync(s.pp.backups), ['purge-20261118T090000Z']);
  } finally {
    s.close();
    env.cleanup();
  }
});

test('the clocks run on every call: a status check performs the purge that is due', async () => {
  const env = makeEnv({ caller: 'serve' });
  const s = await syncedProfile(env);
  setMeta(s.db, 'auth_lost_at', env.clock.now().toISOString());
  s.close();
  try {
    env.clock.advanceDays(28.1);
    const view = await checkProfile(env.ctx, 'en');
    assert.equal(view.state, 'purged');
    const { db } = openProfileReader(env.ctx, 'en');
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM report_files').get() as { n: number }).n), 0);
    assert.equal(getMeta(db, 'channel_id'), undefined);
    db.close();
    assert.ok(env.notes.some((n) => /purged/.test(n.message)));
  } finally {
    env.cleanup();
  }
});

test('Testing mode: a warning from day 5 after consent until a refresh after day 8 proves the app is In production', async () => {
  const env = makeEnv();
  const s = await seedProfile(env);
  try {
    setMeta(s.db, 'oauth_mode', 'unknown');
    env.clock.advanceDays(4);
    assert.equal(policyView(s.db, env.clock.now()).testingWarning, undefined);
    env.clock.advanceDays(1.5);
    assert.match(policyView(s.db, env.clock.now()).testingWarning ?? '', /stops working on/);
    env.clock.advanceDays(3);
    setMeta(s.db, 'last_refresh_ok_at', env.clock.now().toISOString());
    assert.equal(policyView(s.db, env.clock.now()).testingWarning, undefined);
    setMeta(s.db, 'oauth_mode', 'testing');
    assert.match(policyView(s.db, env.clock.now()).testingWarning ?? '', /in Testing/);
    assert.equal(getMeta(s.db, 'channel_id'), CHANNEL_ID);
  } finally {
    s.close();
    env.cleanup();
  }
});
