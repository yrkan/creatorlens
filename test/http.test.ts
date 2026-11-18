// The network layer (design v2 § 4.3; SEC-5, SEC-16, API-27): the closed route table, the read-only latch, redirects,
// retries, the TLS switch and the size cap. Every check happens before anything is sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleHttp, RouteRefused } from '../src/google/http.ts';
import { CORE_ROUTES } from '../src/google/routes.ts';
import { ADMIN_ROUTES } from '../src/admin/routes.ts';
import { FakeGoogle, fakeAccessToken } from './helpers/fakeGoogle.ts';

function client(google: FakeGoogle, caller: 'cli' | 'serve', admin = false, env: NodeJS.ProcessEnv = {}) {
  const sleeps: number[] = [];
  const h = new GoogleHttp({
    caller,
    routes: admin ? [...CORE_ROUTES, ...ADMIN_ROUTES] : CORE_ROUTES,
    fetchImpl: google.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    env,
  });
  return { h, sleeps };
}

test('off-list hosts, plain HTTP, credentials in the URL, other ports and www.googleapis.com are refused unsent', async () => {
  const g = new FakeGoogle();
  const { h } = client(g, 'cli', true);
  for (const url of [
    'https://example.com/youtube/v3/channels',
    'http://youtube.googleapis.com/youtube/v3/channels',
    'https://user:pw@youtube.googleapis.com/youtube/v3/channels',
    'https://youtube.googleapis.com:8443/youtube/v3/channels',
    'https://www.googleapis.com/youtube/v3/channels',
    'https://youtube.googleapis.com/youtube/v3/commentThreads',
    'https://youtube.googleapis.com/upload/youtube/v3/videos',
    'https://youtube.googleapis.com.evil.example/youtube/v3/channels',
  ]) {
    await assert.rejects(h.request('GET', url), RouteRefused, url);
  }
  await assert.rejects(h.request('POST', 'https://youtube.googleapis.com/youtube/v3/videos'), RouteRefused);
  await assert.rejects(h.request('PUT' as never, 'https://youtubereporting.googleapis.com/v1/jobs'), RouteRefused);
  assert.equal(g.requests.length, 0, 'nothing was sent');
});

test('the server cannot reach the admin routes, even if they were handed to it; the CLI can', async () => {
  const g = new FakeGoogle();
  const serve = client(g, 'serve', true).h;
  await assert.rejects(serve.request('POST', 'https://youtubereporting.googleapis.com/v1/jobs', { body: '{}' }), RouteRefused);
  await assert.rejects(serve.request('DELETE', 'https://youtubereporting.googleapis.com/v1/jobs/abc'), RouteRefused);
  await assert.rejects(serve.request('POST', 'https://oauth2.googleapis.com/revoke', { body: 'token=x' }), RouteRefused);
  assert.equal(g.requests.length, 0);
  const cli = client(g, 'cli', true).h;
  const r = await cli.request('POST', 'https://oauth2.googleapis.com/revoke', { body: 'token=x' });
  assert.equal(r.status, 200);
  // A CLI client without the admin routes cannot either.
  await assert.rejects(client(g, 'cli', false).h.request('POST', 'https://oauth2.googleapis.com/revoke'), RouteRefused);
});

test('the read-only latch is one-way: afterwards only GET and the token refresh pass', async () => {
  const g = new FakeGoogle();
  const { h } = client(g, 'cli', true);
  h.latchReadOnly();
  assert.equal(h.isLatched, true);
  await assert.rejects(h.request('POST', 'https://youtubereporting.googleapis.com/v1/jobs', { body: '{}' }), /read-only latch/);
  await assert.rejects(h.request('POST', 'https://oauth2.googleapis.com/revoke', { body: 'token=x' }), /read-only latch/);
  const tok = await h.request('POST', 'https://oauth2.googleapis.com/token', { body: 'grant_type=refresh_token' });
  assert.equal(tok.status, 200);
  const types = await h.request('GET', 'https://youtubereporting.googleapis.com/v1/reportTypes', { accessToken: fakeAccessToken() });
  assert.equal(types.status, 200);
});

test('no credential is sent when certificate checks are off', async () => {
  const g = new FakeGoogle();
  const { h } = client(g, 'cli', false, { NODE_TLS_REJECT_UNAUTHORIZED: '0' });
  await assert.rejects(
    h.request('GET', 'https://youtube.googleapis.com/youtube/v3/channels', { accessToken: fakeAccessToken() }),
    /NODE_TLS_REJECT_UNAUTHORIZED/,
  );
  await assert.rejects(h.request('POST', 'https://oauth2.googleapis.com/token', { body: 'x' }), /NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.equal(g.requests.length, 0);
});

test('JSON routes follow no redirect; a report download follows one only to another download route', async () => {
  const g = new FakeGoogle();
  const { h } = client(g, 'cli');
  g.media.set('/v1/media/a', { location: 'https://evil.example/steal' });
  await assert.rejects(h.request('GET', 'https://youtubereporting.googleapis.com/v1/media/a', { accessToken: fakeAccessToken() }), /not an allowed download host/);
  assert.equal(g.requests.filter((r) => r.url.hostname === 'evil.example').length, 0, 'nothing was sent to the other host');
  g.media.set('/v1/media/b', { location: 'https://youtubereporting.googleapis.com/v1/media/c' });
  g.media.set('/v1/media/c', { body: Buffer.from('date,views\n') });
  const ok = await h.request('GET', 'https://youtubereporting.googleapis.com/v1/media/b', { accessToken: fakeAccessToken() });
  assert.equal(ok.body.toString(), 'date,views\n');
  const hops = g.requests.filter((r) => r.url.pathname.startsWith('/v1/media/'));
  assert.ok(hops.every((r) => r.redirect === 'manual'));
  assert.ok(hops.every((r) => r.authorization?.startsWith('Bearer ')), 'the token stayed on its own host');
  const json = g.requests.find((r) => r.url.pathname === '/v1/reportTypes');
  assert.equal(json, undefined);
  await h.request('GET', 'https://youtubereporting.googleapis.com/v1/reportTypes', { accessToken: fakeAccessToken() });
  assert.equal(g.requests.at(-1)!.redirect, 'error');
});

test('GETs retry on 503 and 429 with backoff and Retry-After; POSTs that create state never retry', async () => {
  let n = 0;
  const flaky: typeof fetch = async () => {
    n++;
    return n < 3 ? new Response('busy', { status: n === 1 ? 503 : 429, headers: { 'retry-after': '2' } }) : new Response('{}', { status: 200 });
  };
  const sleeps: number[] = [];
  const h = new GoogleHttp({ caller: 'cli', routes: [...CORE_ROUTES, ...ADMIN_ROUTES], fetchImpl: flaky, sleep: async (ms) => void sleeps.push(ms) });
  const r = await h.request('GET', 'https://youtubereporting.googleapis.com/v1/jobs', { accessToken: fakeAccessToken() });
  assert.equal(r.status, 200);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
  n = 0;
  const r2 = await h.request('POST', 'https://youtubereporting.googleapis.com/v1/jobs', { accessToken: fakeAccessToken(), body: '{}', retry: false });
  assert.equal(r2.status, 503);
  assert.equal(n, 1, 'jobs.create is never retried');
});

test('an answer larger than the cap is refused', async () => {
  const big: typeof fetch = async () => new Response(Buffer.alloc(2048, 65), { status: 200 });
  const h = new GoogleHttp({ caller: 'cli', routes: CORE_ROUTES, fetchImpl: big, sleep: async () => {} });
  await assert.rejects(h.request('GET', 'https://youtubereporting.googleapis.com/v1/jobs', { maxBytes: 1024 }), /larger than 1024 bytes/);
});
