// Commands that change state: at Google (auth, reporting enable/disable, revoke) or on this computer (setup, purge,
// schedule, install, transcripts). Each needs a TTY and a typed confirmation (SEC-6). Only this module and src/admin/
// hold the routes that create or delete Reporting jobs and revoke tokens; the MCP server imports neither.

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.ts';
import { ADMIN_ROUTES } from '../admin/routes.ts';
import { authUrl, exchangeCode, makePkce, makeState, openBrowser, startLoopback } from '../admin/oauthFlow.ts';
import { createJob, deleteJob, revokeToken } from '../admin/google.ts';
import { loadConfig, saveConfig, parseClientJson, requireTerms, validateTranscriptDir, type Config } from '../config.ts';
import { clientCreds, makeApi, openProfile, recordRefreshOk, tokenStoreOf, type ProfileSession } from '../profile.ts';
import { getMeta, setMeta, delMeta, logEvent, backupTo } from '../store/db.ts';
import { fullPurge } from '../policy.ts';
import { checkScopes } from '../google/oauth.ts';
import { GoogleApi } from '../google/api.ts';
import { planJobs } from '../reportingPlan.ts';
import { upsertJobs } from '../sync.ts';
import { scheduleInstall, scheduleRemove, scheduleStatus } from '../schedule.ts';
import { installPinned } from '../install.ts';
import { confirmTyped, requireTty } from '../util/tty.ts';
import { acquireLock } from '../util/lock.ts';
import { ensureDir, fileExists, isInside, removeTree } from '../util/fsx.ts';
import { escapeForTerminal } from '../util/text.ts';
import { CLIENT_ACCOUNT, type StoreKind } from '../secrets.ts';
import { docPath } from '../docs.ts';
import { APP_VERSION, OAUTH_APP_NAME, SCOPES, TERMS_VERSION } from '../version.ts';
import { PURGED_TABLES } from '../store/schema.ts';

export interface AdminFlags {
  profile?: string;
  'client-json'?: string;
  'token-store'?: string;
  mode?: string;
  'no-browser'?: boolean;
  time?: string;
  all?: boolean;
  public?: boolean;
  backups?: boolean;
  force?: boolean;
  'skip-tests'?: boolean;
  json?: boolean;
}

function requireMac(ctx: Ctx, f: { 'token-store'?: string }): void {
  if (ctx.platform === 'win32') throw new Error('Windows is not supported.');
  if (ctx.platform !== 'darwin' && f['token-store'] !== 'file') {
    throw new Error('This version runs on macOS (Linux arrives in v2). For tests on another system use --token-store file.');
  }
}

function needProfile(f: AdminFlags): string {
  if (!f.profile) throw new Error('Name a profile with --profile <name> (for example en).');
  return f.profile;
}

// ---------------------------------------------------------------- setup

function insideGitWorkTree(file: string): boolean {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function findClientJson(ctx: Ctx): string | undefined {
  const dl = path.join(ctx.homedir, 'Downloads');
  try {
    const files = fs
      .readdirSync(dl)
      .filter((f) => /^client_secret_.*\.json$/.test(f))
      .map((f) => path.join(dl, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
  } catch {
    return undefined;
  }
}

export async function cmdSetup(ctx: Ctx, f: AdminFlags): Promise<number> {
  requireTty(ctx.prompt, 'setup');
  requireMac(ctx, f);
  const cfg = loadConfig(ctx.paths, ctx.platform);
  const kind = (f['token-store'] ?? cfg.tokenStore) as StoreKind;
  if (kind !== 'keychain' && kind !== 'file') throw new Error('--token-store is keychain or file.');
  if (kind === 'file') ctx.out('Note: secrets will be kept in files (0600) instead of the Keychain, because you asked for --token-store file.');

  ctx.out(`creatorlens ${APP_VERSION}: read-only channel analytics for YouTube, on this computer.`);
  ctx.out('Before anything is stored, read and accept:');
  ctx.out(`  - YouTube Terms of Service: https://www.youtube.com/t/terms`);
  ctx.out(`  - Google Privacy Policy: https://policies.google.com/privacy`);
  ctx.out(`  - creatorlens terms: ${docPath('terms.md')}`);
  ctx.out(`  - creatorlens privacy policy: ${docPath('privacy.md')}`);
  ctx.out('In short: creatorlens reads your channel with two read-only scopes and keeps the data on this computer. What a tool returns goes to your AI client and its model provider. You can revoke access at https://security.google.com/settings/security/permissions at any time.');
  const accepted = await confirmTyped(ctx.prompt, `Terms version ${TERMS_VERSION}.`, 'I accept');
  if (!accepted) {
    ctx.out('Not accepted; nothing was stored.');
    return 1;
  }
  const file = f['client-json'] ?? findClientJson(ctx);
  if (!file) throw new Error('Give the Desktop client JSON: creatorlens setup --client-json ~/Downloads/client_secret_….json');
  const client = parseClientJson(fs.readFileSync(path.resolve(file), 'utf8'));
  ensureDir(ctx.paths.root);
  await ctx.secrets(kind).set(CLIENT_ACCOUNT, client.clientSecret);
  const next: Config = {
    ...cfg,
    tokenStore: kind,
    client: { clientId: client.clientId, projectId: client.projectId, projectNumber: client.projectNumber, installedAt: ctx.clock.now().toISOString() },
    terms: { version: TERMS_VERSION, acceptedAt: ctx.clock.now().toISOString() },
  };
  saveConfig(ctx.paths, next);
  ctx.out(`Stored the OAuth client of project ${client.projectId} (number ${client.projectNumber}); its secret is in the ${kind === 'keychain' ? 'Keychain' : 'secret file store'}.`);
  if (insideGitWorkTree(file)) {
    ctx.out(`Warning: ${file} is inside a git work tree. A client secret must never be committed.`);
    if (await confirmTyped(ctx.prompt, 'Delete that copy now?', 'delete')) {
      fs.rmSync(file);
      ctx.out('Deleted.');
    }
  } else {
    ctx.out(`You may delete ${file} now; creatorlens keeps what it needs.`);
  }
  ctx.out('Next: creatorlens auth --profile en   (and es, ru, fr, de, tr: one profile per channel)');
  return 0;
}

// ---------------------------------------------------------------- auth

async function revokeQuietly(ctx: Ctx, token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    await revokeToken(ctx.http(ADMIN_ROUTES), token);
  } catch {
    // best effort: the token was never stored
  }
}

export async function cmdAuth(ctx: Ctx, f: AdminFlags): Promise<number> {
  requireTty(ctx.prompt, 'auth');
  requireMac(ctx, f);
  const name = needProfile(f);
  const cfg = loadConfig(ctx.paths, ctx.platform);
  requireTerms(cfg);
  const creds = await clientCreds(ctx, cfg);
  const s = openProfile(ctx, name, { create: true });
  const lock = acquireLock(s.pp.lock, 'auth', () => ctx.clock.now());
  try {
    const { verifier, challenge } = makePkce();
    const state = makeState();
    const loop = await startLoopback(state);
    const url = authUrl({ clientId: creds.clientId, redirectUri: loop.redirectUri, challenge, state });
    ctx.out(`Sign in for profile "${name}". Your browser opens Google's consent page; if it does not, open this address yourself:\n\n${url}\n`);
    ctx.out(`On the way: pick the Google account, then the channel (Brand Account) for "${name}". Google warns that "${OAUTH_APP_NAME}" is not verified: that is your own app; continue only if the developer e-mail shown is yours. Tick both boxes.`);
    if (!f['no-browser']) await openBrowser(ctx.exec, url, ctx.platform).catch(() => false);
    let code: string;
    try {
      code = await loop.code;
    } finally {
      loop.close();
    }
    const http = ctx.http();
    const tokens = await exchangeCode(http, creds, { code, verifier, redirectUri: loop.redirectUri });
    const granted = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    const check = checkScopes(granted);
    if (!check.ok) {
      await revokeQuietly(ctx, tokens.refresh_token ?? tokens.access_token);
      if (check.extra.length) throw new Error(`Google granted scopes creatorlens never asks for (${check.extra.join(', ')}); the grant was revoked and nothing was stored.`);
      throw new Error(`Not every scope was granted (missing: ${check.missing.join(', ')}). Run auth again and tick both boxes. Nothing was stored.`);
    }
    if (!tokens.refresh_token) {
      await revokeQuietly(ctx, tokens.access_token);
      throw new Error('Google returned no refresh token. Remove creatorlens at https://security.google.com/settings/security/permissions and run auth again.');
    }
    const api = new GoogleApi(http, async () => tokens.access_token!);
    const ch = await api.channelMine();
    if (!ch) {
      await revokeQuietly(ctx, tokens.refresh_token);
      throw new Error('This account has no YouTube channel (no_channel). Run auth again and pick the Brand Account that owns the channel. Nothing was stored.');
    }
    const bound = getMeta(s.db, 'channel_id');
    if (bound && bound !== ch.id) {
      await revokeQuietly(ctx, tokens.refresh_token);
      throw new Error(`Profile "${name}" belongs to channel ${bound}; this sign-in is for ${ch.id}. Use another profile for that channel. Nothing was stored.`);
    }
    ctx.out(`\nChannel: ${escapeForTerminal(ch.title)} ${escapeForTerminal(ch.handle ?? '')} (${ch.id})`);
    if (!(await confirmTyped(ctx.prompt, `Bind profile "${name}" to this channel?`, 'yes'))) {
      await revokeQuietly(ctx, tokens.refresh_token);
      ctx.out('Cancelled; the grant was revoked and nothing was stored.');
      return 1;
    }
    let mode = f.mode;
    if (!mode) {
      const a = (await ctx.prompt.ask('Is the OAuth app "In production" in Google Auth Platform → Audience? [p] In production, [t] Testing, [?] not sure: ')).toLowerCase();
      mode = a.startsWith('p') ? 'production' : a.startsWith('t') ? 'testing' : 'unknown';
    }
    if (!['production', 'testing', 'unknown'].includes(mode)) throw new Error('--mode is production, testing or unknown.');
    const kind = tokenStoreOf(s);
    await ctx.secrets(kind).set(name, tokens.refresh_token);
    const now = ctx.clock.now();
    s.db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of ['purged_at', 'purge_reason', 'auth_lost_at', 'auth_lost_code', 'refresh_token_expires_at']) delMeta(s.db, k);
      if (!bound) setMeta(s.db, 'bound_at', now.toISOString());
      setMeta(s.db, 'channel_id', ch.id);
      setMeta(s.db, 'channel_title', ch.title);
      if (ch.handle) setMeta(s.db, 'channel_handle', ch.handle);
      setMeta(s.db, 'consent_at', now.toISOString());
      setMeta(s.db, 'oauth_mode', mode);
      setMeta(s.db, 'token_store', kind);
      if (tokens.refresh_token_expires_in) {
        setMeta(s.db, 'refresh_token_expires_at', new Date(now.getTime() + tokens.refresh_token_expires_in * 1000).toISOString());
      }
      s.db
        .prepare(
          `INSERT INTO channel (id, title, handle, country, published_at, uploads_playlist_id, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET title = excluded.title, handle = excluded.handle, country = excluded.country,
             published_at = excluded.published_at, uploads_playlist_id = excluded.uploads_playlist_id, refreshed_at = excluded.refreshed_at,
             metadata_expired_at = NULL`,
        )
        .run(ch.id, ch.title, ch.handle, ch.country, ch.publishedAt, ch.uploadsPlaylistId, now.toISOString());
      recordRefreshOk(s);
      logEvent(s.db, now, 'auth_ok', `bound ${ch.id}`);
      s.db.exec('COMMIT');
    } catch (e) {
      s.db.exec('ROLLBACK');
      throw e;
    }
    ctx.out(`Signed in. Scopes: ${SCOPES.join(', ')}. The refresh token is in the ${kind === 'keychain' ? 'Keychain' : 'secret file store'}.`);
    if (tokens.refresh_token_expires_in || mode !== 'production') {
      ctx.out('Warning: if the app is in Testing, this sign-in stops working in 7 days. Publish it (Google Auth Platform → Audience → Publish app) and run auth again.');
    }
    ctx.out(`Next: creatorlens reporting enable --profile ${name}`);
    return 0;
  } finally {
    lock.release();
    s.close();
  }
}

// ---------------------------------------------------------------- reporting

async function accessToken(s: ProfileSession, ctx: Ctx): Promise<{ token: string; api: GoogleApi }> {
  const { api, token } = makeApi(s, ctx.http());
  return { token: await token(), api };
}

export async function cmdReporting(ctx: Ctx, f: AdminFlags, sub: string | undefined): Promise<number> {
  const name = needProfile(f);
  requireTerms(loadConfig(ctx.paths, ctx.platform));
  if (sub !== 'enable' && sub !== 'disable' && sub !== 'status') throw new Error('Use: reporting enable|disable|status --profile <name>');
  if (sub !== 'status') requireTty(ctx.prompt, `reporting ${sub}`);
  const s = openProfile(ctx, name);
  const lock = sub === 'status' ? undefined : acquireLock(s.pp.lock, `reporting ${sub}`, () => ctx.clock.now());
  try {
    const bound = getMeta(s.db, 'channel_id');
    if (!bound) throw new Error(`Profile "${name}" is not signed in. Run "creatorlens auth --profile ${name}".`);
    const { token, api } = await accessToken(s, ctx);
    const ch = await api.channelMine();
    if (!ch || ch.id !== bound) throw new Error(`The sign-in no longer returns channel ${bound}; nothing was changed.`);
    const types = await api.reportTypes();
    const jobs = await api.jobs();
    const now = ctx.clock.now();
    upsertJobs(s, jobs, now.toISOString(), s.cfg.client?.projectNumber ?? null);
    const plan = planJobs(types, jobs, now);
    if (sub === 'status') {
      const out = { profile: name, channel: bound, types: plan.wanted, covered: plan.covered, missing: plan.create, deprecating: plan.deprecating, expiring: plan.expiring };
      if (f.json) ctx.out(JSON.stringify(out, null, 2));
      else {
        ctx.out(`${name}: ${plan.covered.length} of ${plan.wanted.length} report types have a job.`);
        for (const t of plan.create) ctx.out(`  missing: ${t}`);
        for (const d of plan.deprecating) ctx.out(`  deprecated ${d.deprecateTime.slice(0, 10)}: ${d.reportTypeId} (successor ${d.successor ?? 'none yet'})`);
        for (const e of plan.expiring) ctx.out(`  job ends ${e.expireTime.slice(0, 10)}: ${e.reportTypeId}`);
      }
      return plan.create.length ? 1 : 0;
    }
    const http = ctx.http(ADMIN_ROUTES);
    if (sub === 'enable') {
      if (plan.create.length === 0) {
        ctx.out(`${name}: every one of the ${plan.wanted.length} report types already has a job. Nothing to do.`);
        return 0;
      }
      ctx.out(`${name} (${escapeForTerminal(ch.title)}, ${bound}): creatorlens will create ${plan.create.length} Reporting job(s) in your Google account:`);
      for (const t of plan.create) ctx.out(`  ${t}`);
      ctx.out('A job makes one file a day (about 48 hours later) and brings the 30 days before today within a couple of days. Jobs stay until you delete them ("reporting disable").');
      if (!(await confirmTyped(ctx.prompt, '', `enable ${name}`))) {
        ctx.out('Cancelled; nothing was created.');
        return 1;
      }
      let made = 0;
      const failed: string[] = [];
      for (const t of plan.create) {
        try {
          const job = await createJob(http, token, t, `creatorlens ${name} ${t}`);
          s.db
            .prepare(
              `INSERT INTO jobs (id, report_type_id, name, create_time, expire_time, system_managed, project_number, created_by_creatorlens, seen_at)
               VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?) ON CONFLICT (id) DO UPDATE SET created_by_creatorlens = 1, seen_at = excluded.seen_at`,
            )
            .run(job.id, job.reportTypeId ?? t, job.name ?? null, job.createTime ?? now.toISOString(), job.expireTime ?? null, s.cfg.client?.projectNumber ?? null, now.toISOString());
          logEvent(s.db, now, 'job_created', t);
          made++;
        } catch (e) {
          failed.push(`${t}: ${(e as Error).message.slice(0, 200)}`);
        }
      }
      ctx.out(`Created ${made} job(s).${failed.length ? ` Failed: ${failed.length} (run the command again for those):\n  ${failed.join('\n  ')}` : ''}`);
      ctx.out(`The first files arrive in about 48 hours. Next: creatorlens sync --profile ${name} --full, then creatorlens schedule install --profile ${name}`);
      return failed.length ? 1 : 0;
    }
    // disable: only the jobs creatorlens created (their name starts with "creatorlens ").
    const ours = jobs.filter((j) => !j.systemManaged && (j.name ?? '').startsWith('creatorlens '));
    if (ours.length === 0) {
      ctx.out('No job created by creatorlens exists for this channel.');
      return 0;
    }
    ctx.out(`This deletes ${ours.length} Reporting job(s) at Google. Reports not downloaded yet are lost; history older than 30 days cannot be fetched again.`);
    if (!(await confirmTyped(ctx.prompt, '', `disable ${name}`))) {
      ctx.out('Cancelled.');
      return 1;
    }
    for (const j of ours) {
      await deleteJob(http, token, j.id);
      s.db.prepare('UPDATE jobs SET gone_at = ? WHERE id = ?').run(now.toISOString(), j.id);
      logEvent(s.db, now, 'job_deleted', j.reportTypeId);
    }
    ctx.out(`Deleted ${ours.length} job(s).`);
    return 0;
  } finally {
    lock?.release();
    s.close();
  }
}

// ---------------------------------------------------------------- revoke

export async function cmdRevoke(ctx: Ctx, f: AdminFlags): Promise<number> {
  requireTty(ctx.prompt, 'revoke');
  const name = needProfile(f);
  const s = openProfile(ctx, name);
  const lock = acquireLock(s.pp.lock, 'revoke', () => ctx.clock.now());
  try {
    ctx.out(
      `Revoke for profile "${name}": creatorlens revokes its access at Google and deletes, in this run, everything it holds for this channel: the store's tables, the report archive, its own backups, the logs, the configured transcripts and the token. Reports older than 60 days exist nowhere else.`,
    );
    if (!(await confirmTyped(ctx.prompt, '', `revoke ${name}`))) {
      ctx.out('Cancelled.');
      return 1;
    }
    const kind = tokenStoreOf(s);
    const refresh = await ctx.secrets(kind).get(name);
    // 1. Offer to delete the Reporting jobs first: it needs the token (SEC-9).
    if (refresh) {
      try {
        const { token, api } = await accessToken(s, ctx);
        const ours = (await api.jobs()).filter((j) => (j.name ?? '').startsWith('creatorlens '));
        if (ours.length && (await confirmTyped(ctx.prompt, `Also delete the ${ours.length} Reporting job(s) at Google?`, 'delete jobs'))) {
          const http = ctx.http(ADMIN_ROUTES);
          for (const j of ours) await deleteJob(http, token, j.id);
          ctx.out(`Deleted ${ours.length} job(s).`);
        }
      } catch (e) {
        ctx.out(`The jobs could not be listed (${(e as Error).message.slice(0, 160)}); they stay until you delete them.`);
      }
      // 2. Revoke at Google, at once.
      const r = await revokeToken(ctx.http(ADMIN_ROUTES), refresh);
      ctx.out(r === 'revoked' ? 'Access revoked at Google.' : 'The token was already invalid at Google.');
    } else {
      ctx.out('No token is stored; nothing to revoke at Google.');
    }
    // 3. Purge everything, in this run.
    const report = await fullPurge(ctx, s, 'revoked by the operator', { deleteToken: true });
    await scheduleRemove(ctx, name).catch(() => false);
    ctx.out(
      `Purged: ${report.rowsDeleted} rows, ${report.archiveFilesDeleted} archive files, ${report.backupsDeleted} backup files, ${report.transcriptFilesDeleted} transcript files; schedule removed.`,
    );
    ctx.out(
      'This deleted creatorlens\'s local copies only. Nothing was deleted on YouTube. You can also check https://security.google.com/settings/security/permissions. Copies you exported yourself, Time Machine snapshots and transcripts outside the configured folders are beyond creatorlens\'s reach.',
    );
    return 0;
  } finally {
    lock.release();
    s.close();
  }
}

// ---------------------------------------------------------------- purge

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export async function cmdPurge(ctx: Ctx, f: AdminFlags): Promise<number> {
  requireTty(ctx.prompt, 'purge');
  if (f.public) {
    if (!(await confirmTyped(ctx.prompt, 'Delete public.db (other channels\' data) now?', 'purge public'))) return 1;
    for (const p of [ctx.paths.publicDb, `${ctx.paths.publicDb}-wal`, `${ctx.paths.publicDb}-shm`]) fs.rmSync(p, { force: true });
    ctx.out('public.db deleted.');
    return 0;
  }
  const name = needProfile(f);
  const s = openProfile(ctx, name);
  const lock = acquireLock(s.pp.lock, 'purge', () => ctx.clock.now());
  try {
    if (f.backups) {
      if (!(await confirmTyped(ctx.prompt, `Delete creatorlens's backups of profile "${name}" now?`, `purge backups ${name}`))) return 1;
      if (fileExists(s.pp.backups)) removeTree(s.pp.backups, s.pp.dir);
      ctx.out('Backups deleted.');
      return 0;
    }
    if (!f.all) throw new Error('Choose what to purge: --all (this profile\'s data), --backups, or --public.');
    ctx.out(`This deletes the data of profile "${name}" (tables and report archive). The sign-in stays. A copy is kept for 7 days in ${s.pp.backups}, then deleted.`);
    if (!(await confirmTyped(ctx.prompt, '', `purge ${name}`))) {
      ctx.out('Cancelled.');
      return 1;
    }
    const now = ctx.clock.now();
    const dir = path.join(s.pp.backups, `purge-${stamp(now)}`);
    ensureDir(dir);
    await backupTo(s.db, path.join(dir, 'store.db'));
    if (fileExists(s.pp.reports)) fs.renameSync(s.pp.reports, path.join(dir, 'reports'));
    s.db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of PURGED_TABLES) if (t !== 'channel') s.db.prepare(`DELETE FROM ${t}`).run();
      logEvent(s.db, now, 'purge', 'operator purge --all (copy kept 7 days)');
      s.db.exec('COMMIT');
    } catch (e) {
      s.db.exec('ROLLBACK');
      throw e;
    }
    s.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    ctx.out(`Purged. The copy in ${dir} is deleted after 7 days (or now with "purge --backups").`);
    return 0;
  } finally {
    lock.release();
    s.close();
  }
}

// ---------------------------------------------------------------- schedule

export async function cmdSchedule(ctx: Ctx, f: AdminFlags, sub: string | undefined): Promise<number> {
  const name = needProfile(f);
  if (sub === 'status') {
    const st = await scheduleStatus(ctx, name);
    ctx.out(f.json ? JSON.stringify(st, null, 2) : `${name}: ${st.installed ? `installed, ${st.time} daily` : 'not installed'}${st.problems.length ? `; ${st.problems.join('; ')}` : ''}`);
    return st.installed && st.problems.length === 0 ? 0 : 1;
  }
  if (sub !== 'install' && sub !== 'remove') throw new Error('Use: schedule install|remove|status --profile <name>');
  requireTty(ctx.prompt, `schedule ${sub}`);
  if (sub === 'remove') {
    if (!(await confirmTyped(ctx.prompt, `Remove the daily sync of profile "${name}"?`, `schedule ${name}`))) return 1;
    ctx.out((await scheduleRemove(ctx, name)) ? 'Removed.' : 'No schedule was installed.');
    return 0;
  }
  const [h, m] = (f.time ?? '07:30').split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) throw new Error('--time is HH:MM.');
  if (!(await confirmTyped(ctx.prompt, `Install a daily sync of profile "${name}" at ${f.time ?? '07:30'} with ${ctx.execPath} and ${ctx.appEntry}?`, `schedule ${name}`))) return 1;
  const file = await scheduleInstall(ctx, name, { hour: h, minute: m });
  ctx.out(`Installed ${file}. It also runs at login and after the Mac wakes from a missed time.`);
  return 0;
}

// ---------------------------------------------------------------- install

export async function cmdInstall(ctx: Ctx, f: AdminFlags): Promise<number> {
  requireTty(ctx.prompt, 'install');
  if (!(await confirmTyped(ctx.prompt, `Install creatorlens ${APP_VERSION} as a pinned copy in ${ctx.paths.appDir}?`, `install ${APP_VERSION}`))) return 1;
  const r = await installPinned(ctx, { force: Boolean(f.force), runTests: !f['skip-tests'] });
  ctx.out(`Installed ${r.target} (${r.files} files; runtime packages: ${r.packages.join(', ')}).`);
  ctx.out(`From now on run: ${ctx.execPath} "${r.entry}" <command>`);
  ctx.out(`Then: "${r.entry}" mcp-config prints the "claude mcp add" line; each profile's schedule: schedule install --profile <name>.`);
  return 0;
}

// ---------------------------------------------------------------- transcripts (Q25)

export async function cmdTranscripts(ctx: Ctx, f: AdminFlags, sub: string | undefined, dir: string | undefined): Promise<number> {
  const cfg = loadConfig(ctx.paths, ctx.platform);
  if (sub === 'list' || !sub) {
    ctx.out(cfg.transcriptDirs.length ? cfg.transcriptDirs.join('\n') : 'No transcript folder is configured.');
    return 0;
  }
  if (sub !== 'add' && sub !== 'remove') throw new Error('Use: transcripts add|remove <folder> | transcripts list');
  requireTty(ctx.prompt, `transcripts ${sub}`);
  if (!dir) throw new Error('Name the folder, for example ~/.claude/projects/-Users-you-YouTube-analysis');
  const abs = validateTranscriptDir(dir, ctx.homedir);
  if (sub === 'add') {
    ctx.out(`A full purge (revoke, or a lost sign-in after 28 days) will then delete every file in ${abs}.`);
    if (!(await confirmTyped(ctx.prompt, '', 'yes'))) return 1;
    cfg.transcriptDirs = [...new Set([...cfg.transcriptDirs, abs])];
  } else {
    cfg.transcriptDirs = cfg.transcriptDirs.filter((d) => d !== abs && !isInside(d, abs));
  }
  saveConfig(ctx.paths, cfg);
  ctx.out(cfg.transcriptDirs.length ? `Configured:\n${cfg.transcriptDirs.join('\n')}` : 'No transcript folder is configured.');
  return 0;
}
