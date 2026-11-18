// The accepted terms are versioned (Developer Policies III.A.2, III.E.3.c): a change to docs/privacy.md or docs/terms.md
// must move TERMS_VERSION and TERMS_SHA256 together, so `setup` asks for acceptance again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { TERMS_SHA256, TERMS_VERSION } from '../src/version.ts';
import { cmdSetup } from '../src/commands/admin.ts';
import { loadConfig } from '../src/config.ts';
import { REPO, makeEnv } from './helpers/env.ts';
import { fakeClientSecret } from './helpers/fakeGoogle.ts';

export function termsHash(): string {
  const p = fs.readFileSync(path.join(REPO, 'docs', 'privacy.md'));
  const t = fs.readFileSync(path.join(REPO, 'docs', 'terms.md'));
  return crypto.createHash('sha256').update(p).update('\n').update(t).digest('hex');
}

test('docs/privacy.md and docs/terms.md match the accepted terms version', () => {
  assert.equal(termsHash(), TERMS_SHA256, `privacy.md or terms.md changed: bump TERMS_VERSION (now ${TERMS_VERSION}) and set TERMS_SHA256 to ${termsHash()}`);
});

test('setup shows both documents in full before it asks, and records the accepted version', async () => {
  const env = makeEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorlens-setup-'));
  const clientJson = path.join(dir, 'client_secret_synthetic.json');
  fs.writeFileSync(
    clientJson,
    JSON.stringify({ installed: { client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: fakeClientSecret(), project_id: 'creatorlens-personal' } }),
  );
  let shownBeforeAsking = '';
  env.ctx.prompt = {
    isTTY: () => true,
    ask: async () => {
      shownBeforeAsking = env.out.join('\n');
      return 'I accept';
    },
  };
  try {
    assert.equal(await cmdSetup(env.ctx, { 'client-json': clientJson }), 0);
    assert.match(shownBeforeAsking, /# creatorlens terms of use/);
    assert.match(shownBeforeAsking, /# creatorlens privacy policy/);
    assert.match(shownBeforeAsking, /model provider/);
    assert.equal(loadConfig(env.ctx.paths, 'darwin').terms?.version, TERMS_VERSION);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    env.cleanup();
  }
});

test('both documents carry the version and the required links', () => {
  const p = fs.readFileSync(path.join(REPO, 'docs', 'privacy.md'), 'utf8');
  const t = fs.readFileSync(path.join(REPO, 'docs', 'terms.md'), 'utf8');
  for (const doc of [p, t]) assert.ok(doc.includes(`Version ${TERMS_VERSION}`));
  assert.ok(p.includes('YouTube API Services'));
  assert.ok(p.includes('https://www.youtube.com/t/terms'));
  assert.ok(p.includes('policies.google.com/privacy'));
  assert.ok(p.includes('https://security.google.com/settings/security/permissions'));
  assert.ok(/model provider/.test(p), 'privacy.md says tool results go to the model provider');
  assert.ok(t.includes('https://www.youtube.com/t/terms'));
  assert.ok(/not affiliated/i.test(t));
});
