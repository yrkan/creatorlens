// A test context: a temporary data folder, a fake clock, the fake Google, a scripted terminal, an in-memory secret store
// standing in for the Keychain, and recorded notifications and child processes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from '../../src/context.ts';
import { makePaths } from '../../src/paths.ts';
import { GoogleHttp } from '../../src/google/http.ts';
import { CORE_ROUTES, type Caller } from '../../src/google/routes.ts';
import { FakeClock } from '../../src/util/clock.ts';
import { ScriptedPrompt } from '../../src/util/tty.ts';
import type { Exec, ExecResult } from '../../src/util/exec.ts';
import { FileStore, type SecretStore, type StoreKind } from '../../src/secrets.ts';
import { saveConfig, defaultConfig } from '../../src/config.ts';
import { openProfile, type ProfileSession } from '../../src/profile.ts';
import { setMeta } from '../../src/store/db.ts';
import { TERMS_VERSION } from '../../src/version.ts';
import { FakeGoogle, CHANNEL_ID, fakeClientSecret, fakeRefreshToken } from './fakeGoogle.ts';

export class MemoryStore implements SecretStore {
  readonly kind: StoreKind;
  readonly map = new Map<string, string>();
  constructor(kind: StoreKind = 'keychain') {
    this.kind = kind;
  }
  async get(a: string): Promise<string | null> {
    return this.map.get(a) ?? null;
  }
  async set(a: string, v: string): Promise<void> {
    this.map.set(a, v);
  }
  async delete(a: string): Promise<boolean> {
    return this.map.delete(a);
  }
}

export interface TestEnv {
  ctx: Ctx;
  root: string;
  google: FakeGoogle;
  clock: FakeClock;
  prompt: ScriptedPrompt;
  secrets: MemoryStore;
  out: string[];
  err: string[];
  notes: Array<{ title: string; message: string }>;
  execs: Array<{ file: string; args: readonly string[]; input?: string | undefined }>;
  cleanup(): void;
}

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeEnv(
  opts: {
    caller?: Caller;
    now?: string;
    answers?: string[];
    tty?: boolean;
    platform?: NodeJS.Platform;
    execImpl?: (file: string, args: readonly string[]) => ExecResult | undefined;
    appEntry?: string;
  } = {},
): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorlens-test-'));
  const launchAgents = path.join(root, 'LaunchAgents');
  const paths = makePaths(path.join(root, 'data'), launchAgents);
  const google = new FakeGoogle();
  const clock = new FakeClock(opts.now ?? '2026-11-20T10:00:00Z');
  const prompt = new ScriptedPrompt(opts.answers ?? [], opts.tty ?? true);
  const secrets = new MemoryStore('keychain');
  const out: string[] = [];
  const err: string[] = [];
  const notes: TestEnv['notes'] = [];
  const execs: TestEnv['execs'] = [];
  const exec: Exec = async (file, args, o) => {
    execs.push({ file, args, input: o?.input });
    return opts.execImpl?.(file, args) ?? { code: 0, stdout: '', stderr: '' };
  };
  const caller = opts.caller ?? 'cli';
  const ctx: Ctx = {
    caller,
    paths,
    clock,
    fetchImpl: google.fetch,
    exec,
    sleep: async () => {},
    prompt,
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    platform: opts.platform ?? 'darwin',
    env: {},
    homedir: path.join(root, 'home'),
    uid: 501,
    execPath: process.execPath,
    appEntry: opts.appEntry ?? path.join(REPO, 'dist', 'cli.js'),
    notify: async (title, message) => void notes.push({ title, message }),
    secrets: (kind) => (kind === 'file' ? new FileStore(paths.secretsDir) : secrets),
    http: (extra = []) => new GoogleHttp({ caller, routes: [...CORE_ROUTES, ...extra], fetchImpl: google.fetch, sleep: async () => {} }),
  };
  return {
    ctx,
    root,
    google,
    clock,
    prompt,
    secrets,
    out,
    err,
    notes,
    execs,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Writes an accepted config with an OAuth client, as `setup` would. */
export async function seedSetup(env: TestEnv): Promise<void> {
  fs.mkdirSync(env.ctx.paths.root, { recursive: true, mode: 0o700 });
  saveConfig(env.ctx.paths, {
    ...defaultConfig('darwin'),
    client: { clientId: '123456789012-abcdefg.apps.googleusercontent.com', projectId: 'creatorlens-personal', projectNumber: '123456789012', installedAt: env.clock.now().toISOString() },
    terms: { version: TERMS_VERSION, acceptedAt: env.clock.now().toISOString() },
  });
  await env.secrets.set('oauth-client', fakeClientSecret());
}

/** A profile signed in to the synthetic channel, as `auth` would leave it. */
export async function seedProfile(env: TestEnv, name = 'en'): Promise<ProfileSession> {
  await seedSetup(env);
  const s = openProfile(env.ctx, name, { create: true });
  const now = env.clock.now().toISOString();
  setMeta(s.db, 'channel_id', CHANNEL_ID);
  setMeta(s.db, 'channel_title', 'Synthetic Channel');
  setMeta(s.db, 'channel_handle', '@synthetic');
  setMeta(s.db, 'bound_at', now);
  setMeta(s.db, 'consent_at', now);
  setMeta(s.db, 'oauth_mode', 'production');
  setMeta(s.db, 'token_store', 'keychain');
  setMeta(s.db, 'last_refresh_ok_at', now);
  s.db
    .prepare('INSERT INTO channel (id, title, handle, refreshed_at) VALUES (?, ?, ?, ?)')
    .run(CHANNEL_ID, 'Synthetic Channel', '@synthetic', now);
  await env.secrets.set(name, fakeRefreshToken('seed'));
  return s;
}
