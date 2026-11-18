// The LaunchAgent (YT2.6; SEC-17, UX-16, CMP-23): label, absolute node and pinned app, 07:30, RunAtLoad, Umask 077,
// logs in the private folder, no secret; the dev clone cannot be scheduled; status reads the plist back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlist, parsePlist, scheduleInstall, scheduleStatus, scheduleRemove } from '../src/schedule.ts';
import { cmdSchedule } from '../src/commands/admin.ts';
import { needsCatchUp } from '../src/commands/serve.ts';
import { makeEnv, seedProfile } from './helpers/env.ts';

test('the plist runs node and the pinned app by absolute path, daily at 07:30 and at load, with Umask 077', () => {
  const xmlText = buildPlist({
    label: 'io.github.yrkan.creatorlens.en.sync',
    nodePath: '/Users/x/.nvm/versions/node/v26.7.0/bin/node',
    appEntry: '/Users/x/Library/Application Support/creatorlens/app/0.1.0/cli.js',
    profile: 'en',
    hour: 7,
    minute: 30,
    logDir: '/Users/x/Library/Application Support/creatorlens/profiles/en/logs',
  });
  assert.match(xmlText, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xmlText, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(xmlText, /<key>Hour<\/key>\s*<integer>7<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.ok(!/EnvironmentVariables/.test(xmlText), 'no environment, so no secret, in the plist');
  const p = parsePlist(xmlText);
  assert.deepEqual(p.args, [
    '/Users/x/.nvm/versions/node/v26.7.0/bin/node',
    '/Users/x/Library/Application Support/creatorlens/app/0.1.0/cli.js',
    'sync',
    '--profile',
    'en',
    '--trigger',
    'schedule',
  ]);
  assert.throws(() => buildPlist({ label: 'l', nodePath: 'node', appEntry: '/a', profile: 'en', hour: 7, minute: 30, logDir: '/l' }), /absolute/);
  assert.match(buildPlist({ label: 'a&b<c>', nodePath: '/n', appEntry: '/a', profile: 'en', hour: 1, minute: 2, logDir: '/l' }), /a&amp;b&lt;c&gt;/);
});

test('the dev clone cannot be scheduled; a pinned copy can, and status reads it back green', async () => {
  const env = makeEnv({
    execImpl: (file, args) => {
      if (file === '/bin/launchctl' && args[0] === 'print') return { code: 0, stdout: 'state = waiting\n\tlast exit code = 0\n', stderr: '' };
      if (args[0] === '-v') return { code: 0, stdout: 'v26.7.0\n', stderr: '' };
      return undefined;
    },
  });
  const s = await seedProfile(env);
  s.close();
  try {
    await assert.rejects(scheduleInstall(env.ctx, 'en', { hour: 7, minute: 30 }), /Only a pinned copy can be scheduled/);
    const pinned = path.join(env.ctx.paths.appDir, '0.1.0', 'cli.js');
    fs.mkdirSync(path.dirname(pinned), { recursive: true });
    fs.writeFileSync(pinned, '// pinned');
    env.ctx.appEntry = pinned;
    (env.prompt as unknown as { answers: string[] }).answers.push('schedule en');
    assert.equal(await cmdSchedule(env.ctx, { profile: 'en' }, 'install'), 0);
    const file = path.join(env.ctx.paths.launchAgentsDir, 'io.github.yrkan.creatorlens.en.sync.plist');
    assert.ok(fs.existsSync(file));
    const boot = env.execs.find((e) => e.args[0] === 'bootstrap')!;
    assert.deepEqual(boot.args, ['bootstrap', 'gui/501', file]);
    const st = await scheduleStatus(env.ctx, 'en');
    assert.deepEqual(st.problems, []);
    assert.equal(st.time, '07:30');
    assert.equal(st.pinned, true);
    assert.equal(st.loaded, true);
    assert.equal(await cmdSchedule(env.ctx, { profile: 'en' }, 'status'), 0);
    assert.equal(await scheduleRemove(env.ctx, 'en'), true);
    assert.ok(!fs.existsSync(file));
  } finally {
    env.cleanup();
  }
});

test('status finds a missing node and a missing app in the plist', async () => {
  const env = makeEnv();
  try {
    fs.mkdirSync(env.ctx.paths.launchAgentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(env.ctx.paths.launchAgentsDir, 'io.github.yrkan.creatorlens.en.sync.plist'),
      buildPlist({ label: 'io.github.yrkan.creatorlens.en.sync', nodePath: '/nonexistent/node', appEntry: '/nonexistent/cli.js', profile: 'en', hour: 7, minute: 30, logDir: '/tmp' }),
    );
    const st = await scheduleStatus(env.ctx, 'en');
    assert.ok(st.problems.some((p) => /node binary is missing/.test(p)));
    assert.ok(st.problems.some((p) => /app is missing/.test(p)));
    assert.ok(st.problems.some((p) => /pinned/.test(p)));
  } finally {
    env.cleanup();
  }
});

test('the server starts a catch-up sync when the last success is older than 26 hours', () => {
  const now = new Date('2026-11-20T10:00:00Z');
  assert.equal(needsCatchUp(undefined, now), false);
  assert.equal(needsCatchUp('2026-11-19T09:00:00Z', now), false);
  assert.equal(needsCatchUp('2026-11-19T07:59:00Z', now), true);
});

test('a schedule needs an existing profile, and listing profiles ignores folders without a store', async () => {
  const env = makeEnv();
  try {
    const pinned = path.join(env.ctx.paths.appDir, '0.1.0', 'cli.js');
    fs.mkdirSync(path.dirname(pinned), { recursive: true });
    fs.writeFileSync(pinned, '// pinned');
    env.ctx.appEntry = pinned;
    await assert.rejects(scheduleInstall(env.ctx, 'xx', { hour: 7, minute: 30 }), /No profile "xx"/);
    fs.mkdirSync(path.join(env.ctx.paths.profilesDir, 'ghost', 'logs'), { recursive: true });
    const { listProfiles } = await import('../src/profile.ts');
    assert.deepEqual(listProfiles(env.ctx), []);
  } finally {
    env.cleanup();
  }
});
