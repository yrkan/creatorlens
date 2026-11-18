// Secrets: the refresh token of each profile and the OAuth client secret. On macOS they live in the login Keychain,
// written through `security -i` so the value never appears on a command line, base64-encoded, and read back to check
// the write (SEC-7, go-keyring's method). A file store exists only when the operator asks for it (--token-store file):
// 0600 in a 0700 folder, written atomically, refused when it is a symlink or readable by others.
//
// What the Keychain does not do (SECURITY.md): it protects the token at rest and from other users, not from code that
// runs as you. `security find-generic-password -s creatorlens -a <profile> -w` prints it without a prompt.

import path from 'node:path';
import fs from 'node:fs';
import type { Exec } from './util/exec.ts';
import { KEYCHAIN_SERVICE } from './version.ts';
import { ensureDir, readPrivateFile, writeFileAtomic } from './util/fsx.ts';

export type StoreKind = 'keychain' | 'file';

export interface SecretStore {
  readonly kind: StoreKind;
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

const ACCOUNT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** `security -i` reads lines of at most 4,095 bytes; a longer line is split and a failed add can hide (go-keyring #153). */
export const SECURITY_LINE_MAX = 4095;
const B64_PREFIX = 'b64:';

function checkAccount(account: string): void {
  if (!ACCOUNT_RE.test(account)) throw new Error(`Invalid secret account name: ${account}`);
}

export class KeychainStore implements SecretStore {
  readonly kind = 'keychain' as const;
  private readonly exec: Exec;
  private readonly bin: string;
  private readonly service: string;
  constructor(exec: Exec, bin = '/usr/bin/security', service: string = KEYCHAIN_SERVICE) {
    this.exec = exec;
    this.bin = bin;
    this.service = service;
  }

  async set(account: string, value: string): Promise<void> {
    checkAccount(account);
    const encoded = B64_PREFIX + Buffer.from(value, 'utf8').toString('base64');
    const line = `add-generic-password -U -s ${this.service} -a ${account} -w ${encoded}\n`;
    if (Buffer.byteLength(line, 'utf8') > SECURITY_LINE_MAX) {
      throw new Error('The secret is too long for the Keychain command line (4,095 bytes); nothing was written.');
    }
    const r = await this.exec(this.bin, ['-i'], { input: line, timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(`The Keychain refused the write (security exited ${r.code}).`);
    const back = await this.get(account);
    if (back !== value) throw new Error('The Keychain read-back did not match what was written; the secret is not stored.');
  }

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    const r = await this.exec(this.bin, ['find-generic-password', '-s', this.service, '-a', account, '-w'], {
      timeoutMs: 20_000,
    });
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) throw new Error(`The Keychain could not be read (security exited ${r.code}; is it locked?).`);
    const raw = r.stdout.replace(/\n$/, '');
    if (!raw.startsWith(B64_PREFIX)) throw new Error('The Keychain item was not written by creatorlens.');
    return Buffer.from(raw.slice(B64_PREFIX.length), 'base64').toString('utf8');
  }

  async delete(account: string): Promise<boolean> {
    checkAccount(account);
    const r = await this.exec(this.bin, ['delete-generic-password', '-s', this.service, '-a', account], {
      timeoutMs: 20_000,
    });
    if (r.code === 44) return false;
    if (r.code !== 0) throw new Error(`The Keychain item could not be deleted (security exited ${r.code}).`);
    return true;
  }
}

export class FileStore implements SecretStore {
  readonly kind = 'file' as const;
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(account: string): string {
    checkAccount(account);
    return path.join(this.dir, `${account}.secret`);
  }

  async set(account: string, value: string): Promise<void> {
    ensureDir(this.dir);
    writeFileAtomic(this.file(account), JSON.stringify({ v: value }), 0o600);
    const back = await this.get(account);
    if (back !== value) throw new Error('The secret file read-back did not match.');
  }

  async get(account: string): Promise<string | null> {
    const f = this.file(account);
    try {
      fs.lstatSync(f);
    } catch {
      return null;
    }
    const parsed = JSON.parse(readPrivateFile(f).toString('utf8')) as { v?: unknown };
    if (typeof parsed.v !== 'string') throw new Error(`Malformed secret file: ${f}`);
    return parsed.v;
  }

  async delete(account: string): Promise<boolean> {
    const f = this.file(account);
    try {
      fs.rmSync(f);
      return true;
    } catch {
      return false;
    }
  }
}

/** The account under which the OAuth client secret is stored. */
export const CLIENT_ACCOUNT = 'oauth-client';
