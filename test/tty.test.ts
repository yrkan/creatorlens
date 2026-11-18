// State-changing commands need a terminal, a typed confirmation and a shell no AI assistant started (SEC-6). The TTY
// check alone is a speed bump: a shell can open a pseudo-terminal (script(1)) and type the phrase, as the
// pre-publication review showed, so the commands also refuse a shell that carries CLAUDE_CODE_CHILD_SESSION.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdAuth, cmdInstall, cmdPurge, cmdReporting, cmdRevoke, cmdSchedule, cmdSetup, cmdTranscripts } from '../src/commands/admin.ts';
import { TtyRequired, agentShell } from '../src/util/tty.ts';
import { makeEnv, seedProfile, REPO, type TestEnv } from './helpers/env.ts';

function stateChanging(env: TestEnv): Array<[string, () => Promise<number>]> {
  return [
    ['setup', () => cmdSetup(env.ctx, { 'client-json': '/nonexistent.json' })],
    ['auth', () => cmdAuth(env.ctx, { profile: 'en' })],
    ['reporting enable', () => cmdReporting(env.ctx, { profile: 'en' }, 'enable')],
    ['reporting disable', () => cmdReporting(env.ctx, { profile: 'en' }, 'disable')],
    ['revoke', () => cmdRevoke(env.ctx, { profile: 'en' })],
    ['purge', () => cmdPurge(env.ctx, { profile: 'en', all: true })],
    ['purge public', () => cmdPurge(env.ctx, { public: true })],
    ['schedule install', () => cmdSchedule(env.ctx, { profile: 'en' }, 'install')],
    ['schedule remove', () => cmdSchedule(env.ctx, { profile: 'en' }, 'remove')],
    ['install', () => cmdInstall(env.ctx, {})],
    ['transcripts add', () => cmdTranscripts(env.ctx, {}, 'add', '~/.claude/projects/x')],
    ['transcripts remove', () => cmdTranscripts(env.ctx, {}, 'remove', '~/.claude/projects/x')],
  ];
}

test('every state-changing command refuses without a TTY, before touching anything', async () => {
  const env = makeEnv({ tty: false });
  const s = await seedProfile(env);
  s.close();
  try {
    for (const [name, call] of stateChanging(env)) await assert.rejects(call(), TtyRequired, name);
    assert.equal(env.google.requests.length, 0, 'nothing reached Google');
    assert.ok(await env.secrets.get('en'), 'the token is untouched');
  } finally {
    env.cleanup();
  }
});

test('every state-changing command refuses a shell an AI assistant started, even with a terminal and the right answers', async () => {
  // A pseudo-terminal and every confirmation phrase at hand: only the agent check stands between them and the commands.
  const answers = ['I accept', 'yes', 'p', 'enable en', 'disable en', 'revoke en', 'delete jobs', 'purge en', 'purge public', 'schedule en', 'install 0.1.0'];
  const env = makeEnv({ tty: true, answers });
  env.ctx.env = { CLAUDE_CODE_CHILD_SESSION: '1' };
  const s = await seedProfile(env);
  s.close();
  try {
    for (const [name, call] of stateChanging(env)) {
      await assert.rejects(call(), (e: unknown) => e instanceof TtyRequired && /started by an AI assistant/.test((e as Error).message), name);
    }
    assert.deepEqual(env.prompt.asked, [], 'no confirmation was even asked');
    assert.equal(env.google.requests.length, 0, 'nothing reached Google');
    assert.ok(await env.secrets.get('en'), 'the token is untouched');
    assert.equal(agentShell({}), undefined, 'an ordinary shell carries no marker');
    assert.equal(agentShell({ CLAUDECODE: '1' }), undefined, 'CLAUDECODE alone (an IDE terminal) is not an assistant shell');
  } finally {
    env.cleanup();
  }
});

test('the built command line refuses an assistant shell before anything, through a pseudo-terminal too', () => {
  const cli = path.join(REPO, 'dist', 'cli.js');
  assert.ok(fs.existsSync(cli), 'run "pnpm build" first');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorlens-agent-'));
  const marker = path.join(home, 'public.db');
  fs.writeFileSync(marker, 'stand-in');
  const env = { PATH: process.env.PATH ?? '', HOME: home, CREATORLENS_HOME: home, CLAUDE_CODE_CHILD_SESSION: '1' };
  try {
    const direct = spawnSync(process.execPath, [cli, 'purge', '--public'], { env, input: 'purge public\n', encoding: 'utf8', timeout: 20_000 });
    assert.equal(direct.status, 3, direct.stderr);
    assert.match(direct.stderr, /started by an AI assistant/);
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/script')) {
      // script(1) gives the command a terminal on stdin and stdout, so the TTY check alone would pass here (it needs a
      // real pipe on its own stdin: Node's stdio pipes are sockets, which script cannot read terminal settings from).
      const pty = spawnSync(
        '/bin/sh',
        ['-c', 'printf "purge public\\n" | /usr/bin/script -q /dev/null "$0" "$1" purge --public', process.execPath, cli],
        { env, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      assert.match(`${pty.stdout}${pty.stderr}`, /started by an AI assistant/);
    }
    assert.ok(fs.existsSync(marker), 'nothing was deleted');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
