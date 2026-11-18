// Everything a command needs from the outside world, in one object, so that tests can replace the network, the clock,
// the Keychain, the terminal and the operating system. This module must not import src/admin/ (the server loads it).

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Caller, CORE_ROUTES, type Route } from './google/routes.ts';
import { GoogleHttp } from './google/http.ts';
import { defaultRoot, makePaths, type Paths } from './paths.ts';
import { systemClock, type Clock } from './util/clock.ts';
import { realExec, type Exec } from './util/exec.ts';
import { realPrompt, type Prompt } from './util/tty.ts';
import { makeNotifier, type Notifier } from './util/notify.ts';
import { FileStore, KeychainStore, type SecretStore, type StoreKind } from './secrets.ts';

export interface Ctx {
  caller: Caller;
  paths: Paths;
  clock: Clock;
  fetchImpl: typeof fetch;
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  prompt: Prompt;
  out: (s: string) => void;
  err: (s: string) => void;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  uid: number;
  /** The node binary running now; written as an absolute path into the LaunchAgent and the MCP registration. */
  execPath: string;
  /** The cli.js (or cli.ts) that is running. */
  appEntry: string;
  notify: Notifier;
  secrets(kind: StoreKind): SecretStore;
  /** A Google HTTP client for this caller. `extra` is how the CLI adds the admin routes; the server never passes any. */
  http(extra?: readonly Route[]): GoogleHttp;
}

export function realContext(caller: Caller): Ctx {
  const paths = makePaths(defaultRoot());
  const exec = realExec;
  const log = (line: string): void => {
    if (process.env.CREATORLENS_DEBUG === '1') process.stderr.write(`[http] ${line}\n`);
  };
  return {
    caller,
    paths,
    clock: systemClock,
    fetchImpl: fetch,
    exec,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    prompt: realPrompt,
    out: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
    err: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    execPath: process.execPath,
    appEntry: path.resolve(fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url))),
    notify: makeNotifier(exec, process.platform),
    secrets: (kind) => (kind === 'file' ? new FileStore(paths.secretsDir) : new KeychainStore(exec)),
    http: (extra = []) => new GoogleHttp({ caller, routes: [...CORE_ROUTES, ...extra], fetchImpl: fetch, log }),
  };
}
