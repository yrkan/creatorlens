// Secret storage (SEC-7): the Keychain through `security -i` with base64 and a read-back, the secret never on a command
// line, the 4,095-byte line limit; the file store 0600, atomic, refusing symlinks and loose permissions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, KeychainStore } from '../src/secrets.ts';
import type { Exec } from '../src/util/exec.ts';
import { fakeRefreshToken } from './helpers/fakeGoogle.ts';

/** A fake /usr/bin/security that keeps items in memory and records how it was called. */
function fakeSecurity(opts: { corrupt?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const exec: Exec = async (_file, args, o) => {
    calls.push({ args, ...(o?.input !== undefined ? { input: o.input } : {}) });
    if (args[0] === '-i') {
      const m = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(o?.input ?? '');
      if (!m) return { code: 1, stdout: '', stderr: 'bad command' };
      items.set(`${m[1]}/${m[2]}`, opts.corrupt ? 'b64:AAAA' : m[3]!);
      return { code: 0, stdout: '', stderr: '' };
    }
    const s = args[args.indexOf('-s') + 1];
    const a = args[args.indexOf('-a') + 1];
    const key = `${s}/${a}`;
    if (args[0] === 'find-generic-password') {
      return items.has(key) ? { code: 0, stdout: `${items.get(key)}\n`, stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'delete-generic-password') {
      return items.delete(key) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  return { exec, items, calls };
}

test('Keychain: written through security -i on stdin as base64, read back, never on argv', async () => {
  const sec = fakeSecurity();
  const store = new KeychainStore(sec.exec);
  const token = fakeRefreshToken('kc');
  await store.set('en', token);
  assert.equal(await store.get('en'), token);
  for (const c of sec.calls) assert.ok(!c.args.join(' ').includes(token), 'the secret is never on a command line');
  const add = sec.calls.find((c) => c.args[0] === '-i')!;
  assert.ok(add.input!.includes(`-w b64:${Buffer.from(token).toString('base64')}`));
  assert.ok(!add.input!.includes(token));
  assert.equal(await store.delete('en'), true);
  assert.equal(await store.get('en'), null);
});

test('Keychain: a read-back that does not match is an error; a line over 4,095 bytes is refused', async () => {
  const store = new KeychainStore(fakeSecurity({ corrupt: true }).exec);
  await assert.rejects(store.set('en', fakeRefreshToken()), /read-back did not match/);
  const ok = new KeychainStore(fakeSecurity().exec);
  await assert.rejects(ok.set('en', 'x'.repeat(4000)), /too long/);
  await assert.rejects(ok.set('../evil', 'x'), /Invalid secret account/);
});

test('file store: 0600 in a 0700 folder; refuses a symlink and a file others can read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorlens-sec-'));
  try {
    const sdir = path.join(dir, 'secrets');
    const store = new FileStore(sdir);
    await store.set('en', 'value-1');
    assert.equal(await store.get('en'), 'value-1');
    const file = path.join(sdir, 'en.secret');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(sdir).mode & 0o777, 0o700);
    fs.chmodSync(file, 0o644);
    await assert.rejects(store.get('en'), /readable by others/);
    fs.rmSync(file);
    const target = path.join(dir, 'elsewhere');
    fs.writeFileSync(target, JSON.stringify({ v: 'x' }), { mode: 0o600 });
    fs.symlinkSync(target, file);
    await assert.rejects(store.get('en'), /symlink/);
    assert.equal(await store.get('es'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
