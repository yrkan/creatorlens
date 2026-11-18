// Sign-in (design v2 § 4.3, SEC-14, API-10, CMP-19): PKCE S256, the state, the loopback listener, exactly two scopes,
// the client JSON, the error map, and the whole `auth` command against the fake Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { authUrl, makePkce, makeState, safeEqual, startLoopback, AUTH_ENDPOINT } from '../src/admin/oauthFlow.ts';
import { checkScopes, oauthErrorFrom, OAUTH_ERRORS } from '../src/google/oauth.ts';
import { parseClientJson } from '../src/config.ts';
import { cmdAuth } from '../src/commands/admin.ts';
import { getMeta } from '../src/store/db.ts';
import { openProfileReader } from '../src/profile.ts';
import { makeEnv, seedSetup } from './helpers/env.ts';
import { CHANNEL_ID, OTHER_CHANNEL_ID, SCOPE_ARO, SCOPE_RO, fakeClientSecret } from './helpers/fakeGoogle.ts';

function get(port: number, pathAndQuery: string, host = `127.0.0.1:${port}`): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('PKCE S256: a 43-character verifier and its SHA-256 challenge; a 32-byte state compared in constant time', () => {
  const { verifier, challenge } = makePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expect = crypto.createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expect);
  const state = makeState();
  assert.equal(Buffer.from(state, 'base64url').length, 32);
  assert.ok(safeEqual(state, state));
  assert.ok(!safeEqual(state, makeState()));
  assert.ok(!safeEqual(state, state.slice(1)));
});

test('the consent URL asks for exactly the two read-only scopes, S256 explicitly, offline access and fresh consent', () => {
  const u = new URL(authUrl({ clientId: 'c.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555', challenge: 'ch', state: 'st' }));
  assert.equal(`${u.origin}${u.pathname}`, AUTH_ENDPOINT);
  assert.deepEqual(u.searchParams.get('scope')!.split(' ').sort(), [SCOPE_RO, SCOPE_ARO].sort());
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.equal(u.searchParams.get('include_granted_scopes'), null);
});

test('scopes are compared as a set: missing or extra (a write scope) is refused', () => {
  assert.ok(checkScopes([SCOPE_ARO, SCOPE_RO]).ok);
  assert.deepEqual(checkScopes([SCOPE_RO]).missing, [SCOPE_ARO]);
  assert.deepEqual(checkScopes([SCOPE_RO, SCOPE_ARO, 'https://www.googleapis.com/auth/youtube.force-ssl']).extra, [
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ]);
});

test('the loopback accepts one matching GET only: wrong Host, wrong state and wrong path are refused', async () => {
  const state = makeState();
  const loop = await startLoopback(state, 10_000);
  try {
    assert.equal(loop.redirectUri, `http://127.0.0.1:${loop.port}`);
    assert.equal((await get(loop.port, `/?state=${state}&code=x`, 'evil.example:80')).status, 400);
    assert.equal((await get(loop.port, `/?state=${makeState()}&code=x`)).status, 400);
    assert.equal((await get(loop.port, `/favicon.ico`)).status, 404);
    const ok = await get(loop.port, `/?state=${encodeURIComponent(state)}&code=THE_CODE&scope=x`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(await loop.code, 'THE_CODE');
  } finally {
    loop.close();
  }
});

test('the loopback reports access_denied and times out', async () => {
  const state = makeState();
  const loop = await startLoopback(state, 10_000);
  await get(loop.port, `/?state=${encodeURIComponent(state)}&error=access_denied`);
  await assert.rejects(loop.code, /access_denied/);
  loop.close();
  const slow = await startLoopback(makeState(), 50);
  await assert.rejects(slow.code, /No answer from the browser/);
});

test('only a Desktop app ("installed") client JSON is accepted; the project number comes from the client id', () => {
  const good = JSON.stringify({ installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: fakeClientSecret(), project_id: 'creatorlens-personal', token_uri: 'https://oauth2.googleapis.com/token' } });
  const c = parseClientJson(good);
  assert.equal(c.projectNumber, '123456789012');
  assert.throws(() => parseClientJson(JSON.stringify({ web: { client_id: 'x' } })), /Web application/);
  assert.throws(() => parseClientJson('{"installed":{"client_id":"bad"}}'), /client_id/);
  assert.throws(() => parseClientJson('not json'), /not JSON/);
  assert.throws(
    () => parseClientJson(JSON.stringify({ installed: { client_id: '1-a.apps.googleusercontent.com', client_secret: fakeClientSecret(), project_id: 'creatorlens-personal', token_uri: 'https://evil.example/token' } })),
    /Unexpected token_uri/,
  );
});

test('OAuth errors map to a fix; invalid_grant, invalid_rapt and deleted_client are definitive', () => {
  for (const code of ['invalid_grant', 'invalid_client', 'deleted_client', 'admin_policy_enforced', 'access_denied']) {
    assert.ok(OAUTH_ERRORS[code], code);
  }
  const lost = oauthErrorFrom({ error: 'invalid_grant', error_subtype: 'invalid_rapt' });
  assert.equal(lost.definitive, true);
  assert.equal(lost.subtype, 'invalid_rapt');
  assert.match(lost.message, /sign in again/);
  assert.equal(oauthErrorFrom({ error: 'deleted_client' }).definitive, true);
  assert.equal(oauthErrorFrom({ error: 'temporarily_unavailable' }).definitive, false);
});

/** Drives `auth`: answers the browser's callback as Google would, from the URL the command printed. */
async function runAuth(envAnswers: string[], tweak?: (env: ReturnType<typeof makeEnv>) => void) {
  const env = makeEnv({ answers: envAnswers });
  await seedSetup(env);
  tweak?.(env);
  const result = cmdAuth(env.ctx, { profile: 'en', 'no-browser': true }).then((c) => c, (e: Error) => e);
  // Wait until the consent URL is printed, then call back like the browser would.
  for (let i = 0; i < 200 && !env.out.some((l) => l.includes(AUTH_ENDPOINT)); i++) await new Promise((r) => setTimeout(r, 5));
  const line = env.out.find((l) => l.includes(AUTH_ENDPOINT))!;
  const u = new URL(line.slice(line.indexOf(AUTH_ENDPOINT)).split(/\s/)[0]!);
  const port = Number(new URL(u.searchParams.get('redirect_uri')!).port);
  await get(port, `/?state=${encodeURIComponent(u.searchParams.get('state')!)}&code=SYNTHETIC_CODE`);
  return { env, result };
}

test('auth: binds the profile to the confirmed channel, stores the token, records consent and mode', async () => {
  const { env, result } = await runAuth(['yes', 'p']);
  try {
    assert.equal(await result, 0);
    const { db } = openProfileReader(env.ctx, 'en');
    assert.equal(getMeta(db, 'channel_id'), CHANNEL_ID);
    assert.equal(getMeta(db, 'oauth_mode'), 'production');
    assert.ok(getMeta(db, 'consent_at'));
    assert.ok(getMeta(db, 'last_refresh_ok_at'));
    db.close();
    assert.ok((await env.secrets.get('en'))?.startsWith('1//0'));
    const exchange = env.google.requests.find((r) => r.url.pathname === '/token' && r.body?.includes('authorization_code'))!;
    assert.ok(exchange.body!.includes('code_verifier='));
    // the code exchange is never retried and no token appears in any printed line
    assert.equal(env.google.requests.filter((r) => r.body?.includes('authorization_code')).length, 1);
    assert.ok(!env.out.join('\n').includes('1//0'));
    assert.ok(!env.out.join('\n').includes('ya29.'));
  } finally {
    env.cleanup();
  }
});

test('auth: a grant missing a scope is revoked and nothing is stored', async () => {
  const { env, result } = await runAuth(['yes', 'p'], (e) => (e.google.grantedScopes = SCOPE_RO));
  try {
    const r = await result;
    assert.ok(r instanceof Error && /Not every scope/.test(r.message));
    assert.equal(env.google.revoked.length, 1);
    assert.equal(await env.secrets.get('en'), null);
  } finally {
    env.cleanup();
  }
});

test('auth: a grant with an extra (write) scope is revoked and refused', async () => {
  const { env, result } = await runAuth(['yes', 'p'], (e) => (e.google.grantedScopes = `${SCOPE_RO} ${SCOPE_ARO} https://www.googleapis.com/auth/youtube`));
  try {
    const r = await result;
    assert.ok(r instanceof Error && /never asks for/.test(r.message));
    assert.equal(env.google.revoked.length, 1);
  } finally {
    env.cleanup();
  }
});

test('auth: an account without a channel is refused (no_channel); a profile bound to another channel refuses a new one', async () => {
  const a = await runAuth(['yes', 'p'], (e) => (e.google.channel = null));
  try {
    const r = await a.result;
    assert.ok(r instanceof Error && /no_channel/.test(r.message));
  } finally {
    a.env.cleanup();
  }
  const b = await runAuth(['yes', 'p']);
  try {
    assert.equal(await b.result, 0);
    b.env.google.channel = { id: OTHER_CHANNEL_ID, title: 'Other', handle: '@other', uploads: 'UUzzSYNTHETICchannel0002' };
    const r = await makeEnvAuthAgain(b.env);
    assert.ok(r instanceof Error && /belongs to channel/.test(r.message), String(r));
  } finally {
    b.env.cleanup();
  }
});

async function makeEnvAuthAgain(env: ReturnType<typeof makeEnv>): Promise<unknown> {
  (env.prompt as unknown as { answers: string[] }).answers.push('yes', 'p');
  env.out.length = 0;
  const p = cmdAuth(env.ctx, { profile: 'en', 'no-browser': true }).then((c) => c, (e: Error) => e);
  for (let i = 0; i < 200 && !env.out.some((l) => l.includes(AUTH_ENDPOINT)); i++) await new Promise((r) => setTimeout(r, 5));
  const line = env.out.find((l) => l.includes(AUTH_ENDPOINT))!;
  const u = new URL(line.slice(line.indexOf(AUTH_ENDPOINT)).split(/\s/)[0]!);
  await get(Number(new URL(u.searchParams.get('redirect_uri')!).port), `/?state=${encodeURIComponent(u.searchParams.get('state')!)}&code=SECOND`);
  return p;
}

test('auth: Testing mode and a time-limited grant are recorded and warned about', async () => {
  const { env, result } = await runAuth(['yes', 't'], (e) => (e.google.refreshTokenExpiresIn = 604_799));
  try {
    assert.equal(await result, 0);
    const { db } = openProfileReader(env.ctx, 'en');
    assert.equal(getMeta(db, 'oauth_mode'), 'testing');
    assert.ok(getMeta(db, 'refresh_token_expires_at'));
    db.close();
    assert.ok(env.out.some((l) => /stops working in 7 days/.test(l)));
  } finally {
    env.cleanup();
  }
});
