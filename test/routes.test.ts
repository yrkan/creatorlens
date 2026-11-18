// "The route test covers every tool and command" (YT2.4.3): each command and each MCP tool runs against the recording
// fake, and every request it made must match the route table for its caller. The MCP tools make no request at all, and
// only reporting enable/disable and revoke reach the admin routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_ROUTES, matchRoute, type Method } from '../src/google/routes.ts';
import { ADMIN_ROUTES } from '../src/admin/routes.ts';
import { runSync } from '../src/sync.ts';
import { runDoctor } from '../src/doctor.ts';
import { cmdReporting, cmdRevoke } from '../src/commands/admin.ts';
import { cmdStatus, cmdSql } from '../src/commands/ops.ts';
import { createServer, describeStore } from '../src/mcp/server.ts';
import { checkProfile } from '../src/check.ts';
import { buildStatus } from '../src/status.ts';
import { makeEnv, seedProfile, type TestEnv } from './helpers/env.ts';
import type { Recorded } from './helpers/fakeGoogle.ts';

function routeIds(reqs: Recorded[], caller: 'cli' | 'serve'): string[] {
  return reqs.map((r) => {
    const route = matchRoute([...CORE_ROUTES, ...ADMIN_ROUTES], r.method as Method, r.url, caller);
    assert.ok(route, `${r.method} ${r.url.hostname}${r.url.pathname} is not in the table for ${caller}`);
    return route.id;
  });
}

async function prepared(answers: string[] = []): Promise<TestEnv> {
  const env = makeEnv({ answers });
  const s = await seedProfile(env);
  const job = env.google.addJob('channel_basic_a3', '2026-10-20T00:00:00Z');
  env.google.addReport(job, '2026-11-17');
  s.close();
  return env;
}

const ADMIN_IDS = new Set(ADMIN_ROUTES.map((r) => r.id));

test('sync: GET routes and the token refresh only', async () => {
  const env = await prepared();
  try {
    const { openProfile } = await import('../src/profile.ts');
    const s = openProfile(env.ctx, 'en');
    await runSync(env.ctx, s, { full: true, trigger: 'manual' });
    s.close();
    const ids = routeIds(env.google.requests, 'cli');
    assert.ok(ids.length > 5);
    assert.ok(ids.every((id) => id === 'oauth.token' || CORE_ROUTES.find((r) => r.id === id)!.method === 'GET'));
    assert.ok(!ids.some((id) => ADMIN_IDS.has(id)));
    for (const id of ['data.channels.list', 'data.playlistItems.list', 'data.videos.list', 'reporting.reportTypes.list', 'reporting.jobs.list', 'reporting.jobs.reports.list', 'reporting.media.download']) {
      assert.ok(ids.includes(id), `sync uses ${id}`);
    }
  } finally {
    env.cleanup();
  }
});

test('doctor: GET routes and the token refresh only', async () => {
  const env = await prepared();
  try {
    await runDoctor(env.ctx, { profile: 'en', offline: false });
    const ids = routeIds(env.google.requests, 'cli');
    assert.ok(ids.includes('analytics.reports.query'));
    assert.ok(!ids.some((id) => ADMIN_IDS.has(id)));
  } finally {
    env.cleanup();
  }
});

test('reporting status reads; enable creates jobs; disable deletes only ours', async () => {
  const env = await prepared(['enable en', 'disable en']);
  try {
    await cmdReporting(env.ctx, { profile: 'en' }, 'status');
    assert.ok(!routeIds(env.google.requests, 'cli').some((id) => ADMIN_IDS.has(id)), 'status never writes');
    env.google.requests.length = 0;
    await cmdReporting(env.ctx, { profile: 'en' }, 'enable');
    assert.ok(routeIds(env.google.requests, 'cli').includes('reporting.jobs.create'));
    env.google.addJob('channel_province_a3', '2026-11-01T00:00:00Z', 'made by hand');
    env.google.requests.length = 0;
    await cmdReporting(env.ctx, { profile: 'en' }, 'disable');
    const ids = routeIds(env.google.requests, 'cli');
    assert.ok(ids.includes('reporting.jobs.delete'));
    assert.deepEqual(env.google.jobs.map((j) => j.name), ['made by hand'], 'a job creatorlens did not create is kept');
  } finally {
    env.cleanup();
  }
});

test('revoke: deletes jobs on request and revokes; nothing else writes', async () => {
  const env = await prepared(['revoke en', 'no']);
  try {
    await cmdRevoke(env.ctx, { profile: 'en' });
    const ids = routeIds(env.google.requests, 'cli');
    assert.ok(ids.includes('oauth.revoke'));
    assert.ok(!ids.includes('reporting.jobs.delete'), 'the jobs stay when the owner says no');
  } finally {
    env.cleanup();
  }
});

test('the MCP tools and the read commands make no network request at all', async () => {
  const env = makeEnv({ caller: 'serve' });
  const s = await seedProfile(env);
  s.close();
  try {
    await checkProfile(env.ctx, 'en');
    buildStatus(env.ctx);
    describeStore(env.ctx, 'en');
    const server = createServer(env.ctx) as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> };
    assert.ok(server._registeredTools.status);
    await cmdStatus(env.ctx, { json: true });
    await cmdSql(env.ctx, { profile: 'en', json: true }, ['SELECT key FROM meta']);
    assert.equal(env.google.requests.length, 0);
  } finally {
    env.cleanup();
  }
});
