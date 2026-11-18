// State-changing commands need a terminal and a typed confirmation (SEC-6); a model's shell has neither.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmdAuth, cmdInstall, cmdPurge, cmdReporting, cmdRevoke, cmdSchedule, cmdSetup, cmdTranscripts } from '../src/commands/admin.ts';
import { TtyRequired } from '../src/util/tty.ts';
import { makeEnv, seedProfile } from './helpers/env.ts';

test('every state-changing command refuses without a TTY, before touching anything', async () => {
  const env = makeEnv({ tty: false });
  const s = await seedProfile(env);
  s.close();
  try {
    const calls: Array<[string, () => Promise<number>]> = [
      ['setup', () => cmdSetup(env.ctx, { 'client-json': '/nonexistent.json' })],
      ['auth', () => cmdAuth(env.ctx, { profile: 'en' })],
      ['reporting enable', () => cmdReporting(env.ctx, { profile: 'en' }, 'enable')],
      ['reporting disable', () => cmdReporting(env.ctx, { profile: 'en' }, 'disable')],
      ['revoke', () => cmdRevoke(env.ctx, { profile: 'en' })],
      ['purge', () => cmdPurge(env.ctx, { profile: 'en', all: true })],
      ['schedule install', () => cmdSchedule(env.ctx, { profile: 'en' }, 'install')],
      ['schedule remove', () => cmdSchedule(env.ctx, { profile: 'en' }, 'remove')],
      ['install', () => cmdInstall(env.ctx, {})],
      ['transcripts add', () => cmdTranscripts(env.ctx, {}, 'add', '~/.claude/projects/x')],
    ];
    for (const [name, call] of calls) await assert.rejects(call(), TtyRequired, name);
    assert.equal(env.google.requests.length, 0, 'nothing reached Google');
    assert.ok(await env.secrets.get('en'), 'the token is untouched');
  } finally {
    env.cleanup();
  }
});

test('a wrong confirmation cancels: revoke and purge change nothing', async () => {
  const env = makeEnv({ answers: ['revoke es', 'purge'] });
  const s = await seedProfile(env);
  s.close();
  try {
    assert.equal(await cmdRevoke(env.ctx, { profile: 'en' }), 1);
    assert.equal(await cmdPurge(env.ctx, { profile: 'en', all: true }), 1);
    assert.equal(env.google.revoked.length, 0);
    assert.ok(await env.secrets.get('en'));
  } finally {
    env.cleanup();
  }
});

test('transcript folders must be inside ~/.claude/projects', async () => {
  const env = makeEnv({ answers: ['yes'] });
  try {
    await assert.rejects(cmdTranscripts(env.ctx, {}, 'add', '/etc'), /inside/);
    await assert.rejects(cmdTranscripts(env.ctx, {}, 'add', '~/.claude/projects'), /inside/);
    assert.equal(await cmdTranscripts(env.ctx, {}, 'add', '~/.claude/projects/-Users-x-YouTube-analysis'), 0);
  } finally {
    env.cleanup();
  }
});
