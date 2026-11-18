// A profile is one channel: its own folder, store, archive and token (CMP-12). This module opens one and builds the
// pieces that talk to Google for it.

import fs from 'node:fs';
import type { Ctx } from './context.ts';
import { profilePaths, assertProfile, type ProfilePaths } from './paths.ts';
import { loadConfig, type Config } from './config.ts';
import { openStore, openReader, getMeta, setMeta, delMeta, logEvent } from './store/db.ts';
import type { Db } from './store/sqlite.ts';
import { FileLogger, type Logger } from './util/log.ts';
import { ensureDir } from './util/fsx.ts';
import { CLIENT_ACCOUNT, type StoreKind } from './secrets.ts';
import { OAuthError, refreshAccessToken, type ClientCreds } from './google/oauth.ts';
import type { GoogleHttp } from './google/http.ts';
import { GoogleApi, type TokenSource } from './google/api.ts';
import { QuotaLedger } from './google/quota.ts';
import { HOSTS } from './google/routes.ts';

export interface ProfileSession {
  ctx: Ctx;
  pp: ProfilePaths;
  db: Db;
  cfg: Config;
  log: Logger;
  close(): void;
}

export function listProfiles(ctx: Ctx): string[] {
  try {
    return fs
      .readdirSync(ctx.paths.profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,31}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function profileExists(ctx: Ctx, name: string): boolean {
  return fs.existsSync(profilePaths(ctx.paths, name).store);
}

/** Opens a profile's store for writing, creating the profile when `create` is set. */
export function openProfile(ctx: Ctx, name: string, opts: { create?: boolean } = {}): ProfileSession {
  const pp = profilePaths(ctx.paths, assertProfile(name));
  if (!opts.create && !fs.existsSync(pp.store)) {
    throw new Error(`No profile "${name}". Create it with "creatorlens auth --profile ${name}" in your Terminal.`);
  }
  ensureDir(ctx.paths.root);
  ensureDir(ctx.paths.profilesDir);
  ensureDir(pp.dir);
  const db = openStore(pp.store, pp.backups, ctx.clock.now());
  const cfg = loadConfig(ctx.paths, ctx.platform);
  const log = new FileLogger(pp.logs, 'creatorlens', () => ctx.clock.now());
  return { ctx, pp, db, cfg, log, close: () => db.close() };
}

/** Opens a profile's store read-only (status, the MCP tools). */
export function openProfileReader(ctx: Ctx, name: string): { pp: ProfilePaths; db: Db } {
  const pp = profilePaths(ctx.paths, assertProfile(name));
  if (!fs.existsSync(pp.store)) throw new Error(`No profile "${name}".`);
  return { pp, db: openReader(pp.store) };
}

export function tokenStoreOf(s: ProfileSession): StoreKind {
  return (getMeta(s.db, 'token_store') as StoreKind | undefined) ?? s.cfg.tokenStore;
}

export async function clientCreds(ctx: Ctx, cfg: Config): Promise<ClientCreds> {
  if (!cfg.client) throw new Error('No OAuth client is set up. Run "creatorlens setup --client-json <file>" in your Terminal.');
  const secret = await ctx.secrets(cfg.tokenStore).get(CLIENT_ACCOUNT);
  if (!secret) throw new Error('The OAuth client secret is missing from the secret store. Run "creatorlens setup" again.');
  return { clientId: cfg.client.clientId, clientSecret: secret };
}

/** Records a successful refresh: the policy's clocks restart from here. */
export function recordRefreshOk(s: ProfileSession): void {
  const now = s.ctx.clock.now();
  setMeta(s.db, 'last_refresh_ok_at', now.toISOString());
  if (getMeta(s.db, 'auth_lost_at')) {
    delMeta(s.db, 'auth_lost_at');
    delMeta(s.db, 'auth_lost_code');
    logEvent(s.db, now, 'auth_ok', 'refresh succeeded again');
  }
}

/** Records a definitive refresh failure: the 28-day purge clock runs from the last good refresh (design v2 § 6.2). */
export function recordAuthLost(s: ProfileSession, err: OAuthError): void {
  const now = s.ctx.clock.now();
  if (!getMeta(s.db, 'auth_lost_at')) {
    setMeta(s.db, 'auth_lost_at', now.toISOString());
    setMeta(s.db, 'auth_lost_code', `${err.code}${err.subtype ? `/${err.subtype}` : ''}`);
    logEvent(s.db, now, 'auth_lost', err.code);
  }
}

/** A token source for one profile: refreshes on demand, keeps the access token in memory only. */
export function makeTokenSource(s: ProfileSession, http: GoogleHttp): TokenSource {
  let cached: { token: string; expiresAt: Date } | undefined;
  return async (force = false) => {
    const now = s.ctx.clock.now();
    if (!force && cached && cached.expiresAt.getTime() - 60_000 > now.getTime()) return cached.token;
    const refresh = await s.ctx.secrets(tokenStoreOf(s)).get(s.pp.name);
    if (!refresh) throw new Error(`Profile "${s.pp.name}" has no sign-in. Run "creatorlens auth --profile ${s.pp.name}" in your Terminal.`);
    const creds = await clientCreds(s.ctx, s.cfg);
    try {
      const r = await refreshAccessToken(http, creds, refresh, () => s.ctx.clock.now());
      cached = { token: r.accessToken, expiresAt: r.expiresAt };
      recordRefreshOk(s);
      return r.accessToken;
    } catch (e) {
      if (e instanceof OAuthError && e.definitive) recordAuthLost(s, e);
      throw e;
    }
  };
}

/** Records the hosts reports were downloaded from (API-27); an unknown one never gets this far. */
export function recordMediaHost(s: ProfileSession, host: string): void {
  const known = new Set<string>(JSON.parse(getMeta(s.db, 'download_hosts') ?? '[]') as string[]);
  if (!known.has(host)) {
    known.add(host);
    setMeta(s.db, 'download_hosts', JSON.stringify([...known].sort()));
    logEvent(s.db, s.ctx.clock.now(), 'download_host', host === HOSTS.reporting ? host : `${host} (unexpected)`);
  }
}

export function makeApi(
  s: ProfileSession,
  http: GoogleHttp,
): { api: GoogleApi; quota: QuotaLedger | undefined; token: TokenSource } {
  const quota = s.cfg.client ? new QuotaLedger(s.ctx.paths.projectDb, s.cfg.client.projectNumber, s.ctx.clock) : undefined;
  const token = makeTokenSource(s, http);
  const api = new GoogleApi(http, token, quota, (host) => recordMediaHost(s, host));
  return { api, quota, token };
}
