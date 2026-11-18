// The pinned copy (YT2.6; SEC-17, CMP-17): `install` copies the build with its runtime packages into
// <data>/app/<version>/, outside the repository, and that copy starts and serves MCP on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { installPinned, runtimeClosure, latestPinned } from '../src/install.ts';
import { realExec } from '../src/util/exec.ts';
import { makeEnv, REPO } from './helpers/env.ts';
import { APP_VERSION } from '../src/version.ts';

test('the runtime closure is the MCP server package, its core and zod: nothing else', () => {
  assert.deepEqual([...runtimeClosure(REPO).keys()].sort(), ['@modelcontextprotocol/core', '@modelcontextprotocol/server', 'zod']);
});

test('install writes a self-contained pinned copy that starts and answers MCP initialize', async () => {
  assert.ok(fs.existsSync(path.join(REPO, 'dist', 'cli.js')), 'run "pnpm build" first');
  const env = makeEnv();
  env.ctx.exec = realExec;
  try {
    const r = await installPinned(env.ctx, { force: false, runTests: false });
    assert.equal(r.target, path.join(env.ctx.paths.appDir, APP_VERSION));
    assert.ok(fs.existsSync(path.join(r.target, 'node_modules', '@modelcontextprotocol', 'server', 'package.json')));
    assert.ok(fs.existsSync(path.join(r.target, 'docs', 'privacy.md')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.target, 'package.json'), 'utf8')).type, 'module');
    assert.equal(latestPinned(env.ctx), r.entry);
    await assert.rejects(installPinned(env.ctx, { force: false, runTests: false }), /exists/);
    // The copy runs from its own folder, with no repository around it.
    const reply = await new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, [r.entry, 'serve'], {
        env: { PATH: process.env.PATH ?? '', CREATORLENS_HOME: env.ctx.paths.root, CREATORLENS_NO_CATCHUP: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: env.root,
      });
      let out = '';
      const timer = setTimeout(() => reject(new Error('no answer')), 15_000);
      p.stdout.setEncoding('utf8').on('data', (d: string) => {
        out += d;
        if (out.includes('\n')) {
          clearTimeout(timer);
          p.stdin.end();
          resolve(out.split('\n')[0]!);
        }
      });
      p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
    });
    assert.equal(JSON.parse(reply).result.serverInfo.name, 'creatorlens');
  } finally {
    env.cleanup();
  }
});
