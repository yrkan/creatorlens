// Commands that read Google (GET only) or the local store: sync, status, doctor, logs, sql, mcp-config.
// None of them changes anything at Google, so none needs src/admin/.

import path from 'node:path';
import type { Ctx } from '../context.ts';
import { listProfiles, openProfile } from '../profile.ts';
import { runSync, type Trigger } from '../sync.ts';
import { buildStatus } from '../status.ts';
import { runDoctor, formatDoctor } from '../doctor.ts';
import { checkProfile } from '../check.ts';
import { sqlQuery } from '../sql/sandbox.ts';
import { profilePaths } from '../paths.ts';
import { tailLog } from '../util/log.ts';
import { escapeForTerminal } from '../util/text.ts';
import { isPinned } from '../schedule.ts';
import { latestPinned } from '../install.ts';
import { loadConfig, requireTerms } from '../config.ts';

export interface Flags {
  profile?: string;
  all?: boolean;
  json?: boolean;
  full?: boolean;
  trigger?: string;
  offline?: boolean;
  limit?: string;
  lines?: string;
}

function profilesFor(ctx: Ctx, f: Flags): string[] {
  if (f.profile) return [f.profile];
  if (f.all) return listProfiles(ctx);
  throw new Error('Name a profile with --profile <name>, or use --all.');
}

export async function cmdSync(ctx: Ctx, f: Flags): Promise<number> {
  requireTerms(loadConfig(ctx.paths, ctx.platform));
  const trigger = (f.trigger ?? 'manual') as Trigger;
  if (!['manual', 'schedule', 'serve'].includes(trigger)) throw new Error('--trigger is manual, schedule or serve.');
  let code = 0;
  const results = [];
  for (const name of profilesFor(ctx, f)) {
    const s = openProfile(ctx, name);
    try {
      const r = await runSync(ctx, s, { full: Boolean(f.full), trigger });
      results.push(r);
      if (!r.ok) code = 1;
      if (!f.json) {
        ctx.out(
          `${name}: ${r.ok ? 'ok' : 'FAILED'}: ${r.reportsDownloaded} new report file(s) of ${r.reportsListed} listed, ${r.videosSeen} video(s) refreshed${r.error ? `; ${r.error}` : ''}`,
        );
        for (const w of r.warnings) ctx.out(`  warning: ${w}`);
        for (const b of r.policy?.view.banners ?? []) ctx.out(`  ${b}`);
      }
    } finally {
      s.close();
    }
  }
  if (f.json) ctx.out(JSON.stringify(results, null, 2));
  return code;
}

export async function cmdStatus(ctx: Ctx, f: Flags): Promise<number> {
  const names = f.profile ? [f.profile] : listProfiles(ctx);
  for (const n of names) await checkProfile(ctx, n);
  const report = buildStatus(ctx, f.profile);
  if (f.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return 0;
  }
  ctx.out(`creatorlens ${report.app_version} · data in ${report.data_folder}`);
  if (!report.terms_accepted) ctx.out('Terms not accepted: run "creatorlens setup".');
  if (!report.client_configured) ctx.out('No OAuth client: run "creatorlens setup --client-json <file>".');
  if (report.profiles.length === 0) ctx.out('No profile yet: run "creatorlens auth --profile en".');
  for (const p of report.profiles) {
    const ch = p.channel ? `${p.channel.title ?? '(title cleared)'} ${p.channel.handle ?? ''} ${p.channel.id}` : 'not signed in';
    ctx.out(`\n${p.profile}: ${p.state} · ${escapeForTerminal(ch)}`);
    ctx.out(`  jobs: ${p.jobs.length}${p.types_without_job.length ? ` (${p.types_without_job.length} types without a job)` : ''} · newest report: ${p.freshness.newest_report_day ?? '—'} · archive: ${p.freshness.archive_files} files`);
    ctx.out(`  last sync: ${p.last_sync ? `${p.last_sync.started_at} ${p.last_sync.ok ? 'ok' : 'failed'}` : 'never'} · schedule: ${p.schedule.installed ? 'installed' : 'not installed'}`);
    for (const b of p.banners) ctx.out(`  ! ${b}`);
    for (const w of p.warnings) ctx.out(`  - ${w}`);
  }
  return 0;
}

export async function cmdDoctor(ctx: Ctx, f: Flags): Promise<number> {
  const report = await runDoctor(ctx, { ...(f.profile ? { profile: f.profile } : {}), offline: Boolean(f.offline) });
  ctx.out(f.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
  return report.ok ? 0 : 1;
}

export async function cmdLogs(ctx: Ctx, f: Flags): Promise<number> {
  if (!f.profile) throw new Error('Name a profile with --profile <name>.');
  const pp = profilePaths(ctx.paths, f.profile);
  const n = Math.min(Math.max(Number(f.lines ?? 50) || 50, 1), 2000);
  for (const line of tailLog(path.join(pp.logs, 'creatorlens.log'), n)) ctx.out(escapeForTerminal(line));
  return 0;
}

export async function cmdSql(ctx: Ctx, f: Flags, positionals: string[]): Promise<number> {
  if (!f.profile) throw new Error('Name a profile with --profile <name>.');
  const sql = positionals.join(' ').trim();
  if (!sql) throw new Error('Give the query: creatorlens sql --profile en "SELECT …"');
  const view = await checkProfile(ctx, f.profile);
  if (view.blockData) throw new Error(view.banners[0] ?? 'The data of this profile is blocked.');
  const res = await sqlQuery(profilePaths(ctx.paths, f.profile).store, sql, { limit: Number(f.limit ?? 200) || 200 });
  if (f.json) {
    ctx.out(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }
  if (!res.ok) {
    ctx.err(`refused: ${escapeForTerminal(res.error ?? 'error')}`);
    return 1;
  }
  // One printer for every cell (SEC-15): no raw control, bidi or escape character reaches the terminal.
  const cell = (v: unknown): string =>
    escapeForTerminal(v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  ctx.out(res.columns.map(cell).join('\t'));
  for (const r of res.rows) ctx.out(r.map(cell).join('\t'));
  ctx.out(`(${res.rows.length} row(s)${res.truncated ? ', cut' : ''}${res.untrusted ? '; strangers’ text wrapped' : ''}, ${res.elapsedMs} ms)`);
  return 0;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function cmdMcpConfig(ctx: Ctx): Promise<number> {
  const entry = isPinned(ctx, ctx.appEntry) ? ctx.appEntry : latestPinned(ctx);
  if (!entry) {
    ctx.out('No pinned copy yet. Run "pnpm build && node dist/cli.js install" in the repository first.');
    return 1;
  }
  const node = ctx.execPath;
  ctx.out('Run this inside ~/YouTube-analysis (local scope: the server exists only in that folder):\n');
  ctx.out(`  claude mcp add --scope local creatorlens -- ${shellQuote(node)} ${shellQuote(entry)} serve\n`);
  ctx.out('Claude Desktop (claude_desktop_config.json), if you use it:\n');
  ctx.out(JSON.stringify({ mcpServers: { creatorlens: { command: node, args: [entry, 'serve'] } } }, null, 2));
  ctx.out('\nSettings for that folder (.claude/settings.json), so no session can read the token or run the state-changing commands:\n');
  ctx.out(
    JSON.stringify(
      {
        permissions: {
          deny: [
            'Bash(security find-generic-password*)',
            'Bash(security dump-keychain*)',
            ...['auth', 'setup', 'revoke', 'purge', 'reporting', 'schedule', 'install', 'transcripts'].map((c) => `Bash(*cli.js ${c}*)`),
            `Read(${ctx.paths.root}/**)`,
          ],
          allow: [`Bash(${shellQuote(node)} ${shellQuote(entry)} status --json)`],
        },
        sandbox: { filesystem: { denyRead: [ctx.paths.root] } },
      },
      null,
      2,
    ),
  );
  return 0;
}
