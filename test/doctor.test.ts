// doctor (YT2.6, YT2.7 acceptance "doctor --json green"): green on a complete test profile, red with a reason and a fix
// when something is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDoctor } from '../src/doctor.ts';
import { runSync } from '../src/sync.ts';
import { buildPlist } from '../src/schedule.ts';
import { makeEnv, seedProfile } from './helpers/env.ts';

async function completeProfile() {
  const env = makeEnv({
    execImpl: (file, args) => {
      if (file === '/bin/launchctl') return { code: 0, stdout: '\tlast exit code = 0\n', stderr: '' };
      if (args[0] === '-v') return { code: 0, stdout: `v${process.versions.node}\n`, stderr: '' };
      return undefined;
    },
  });
  const s = await seedProfile(env);
  for (const t of env.google.reportTypes.filter((x) => !x.deprecateTime)) {
    const job = env.google.addJob(t.id, '2026-11-01T00:00:00Z');
    env.google.addReport(job, '2026-11-18');
  }
  const r = await runSync(env.ctx, s, { full: true, trigger: 'manual' });
  assert.equal(r.ok, true, r.error ?? "");
  s.close();
  const pinned = path.join(env.ctx.paths.appDir, '0.1.0', 'cli.js');
  fs.mkdirSync(path.dirname(pinned), { recursive: true });
  fs.writeFileSync(pinned, '// pinned');
  env.ctx.appEntry = pinned;
  fs.mkdirSync(env.ctx.paths.launchAgentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(env.ctx.paths.launchAgentsDir, 'io.github.yrkan.creatorlens.en.sync.plist'),
    buildPlist({ label: 'io.github.yrkan.creatorlens.en.sync', nodePath: process.execPath, appEntry: pinned, profile: 'en', hour: 7, minute: 30, logDir: '/tmp' }),
  );
  return env;
}

test('doctor --json is green on a complete test profile (live checks against the fake Google)', async () => {
  const env = await completeProfile();
  try {
    const r = await runDoctor(env.ctx, { profile: 'en', offline: false });
    const fails = [...r.host, ...r.profiles.flatMap((p) => p.checks)].filter((c) => c.status === 'fail');
    assert.deepEqual(fails, []);
    assert.equal(r.ok, true);
    const ids = r.profiles[0]!.checks.map((c) => c.id);
    for (const id of ['store', 'binding', 'token', 'sign_in', 'channel', 'analytics_api', 'reporting_jobs', 'reports', 'download_host', 'schedule']) {
      assert.ok(ids.includes(id), `doctor checks ${id}`);
    }
    assert.ok(!JSON.stringify(r).includes('1//0'), 'redacted');
  } finally {
    env.cleanup();
  }
});

test('doctor is red with a fix: a disabled API, a missing job, a lost sign-in, no schedule', async () => {
  const env = await completeProfile();
  try {
    env.google.disabledApis.add('analytics');
    env.google.reportTypes.push({ id: 'channel_province_a3', name: 'Province' });
    let r = await runDoctor(env.ctx, { profile: 'en', offline: false });
    const checks = r.profiles[0]!.checks;
    assert.equal(r.ok, false);
    assert.match(checks.find((c) => c.id === 'analytics_api')!.detail, /apis\/library\/youtubeanalytics\.googleapis\.com\?project=creatorlens-personal/);
    assert.match(checks.find((c) => c.id === 'reporting_jobs')!.detail, /channel_province_a3.*reporting enable/);
    fs.rmSync(env.ctx.paths.launchAgentsDir, { recursive: true, force: true });
    env.google.tokenQueue.push({ status: 400, body: { error: 'invalid_grant' } });
    r = await runDoctor(env.ctx, { profile: 'en', offline: false });
    const c2 = r.profiles[0]!.checks;
    assert.equal(c2.find((c) => c.id === 'schedule')!.status, 'fail');
  } finally {
    env.cleanup();
  }
});

test('doctor --offline skips the live checks and refuses an unsupported platform', async () => {
  const env = makeEnv({ platform: 'linux' });
  const s = await seedProfile(env);
  s.close();
  try {
    const r = await runDoctor(env.ctx, { offline: true });
    assert.equal(r.host.find((c) => c.id === 'platform')!.status, 'fail');
    assert.equal(r.profiles[0]!.checks.find((c) => c.id === 'live')!.status, 'skip');
    assert.equal(env.google.requests.length, 0);
  } finally {
    env.cleanup();
  }
});
