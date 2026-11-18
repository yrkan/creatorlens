#!/usr/bin/env node
// creatorlens: the command line and the MCP server entry. Commands are loaded on demand, so `serve` never loads
// src/admin/ (the routes that create or delete Reporting jobs and revoke tokens).

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, NODE_MIN } from './version.ts';
import { versionAtLeast } from './util/semver.ts';
import { errorText } from './util/redact.ts';

const HELP = `creatorlens ${APP_VERSION}: read-only channel analytics for YouTube, for your AI assistant (MCP).
Not affiliated with or endorsed by YouTube or Google.

Set up (in your own Terminal):
  setup --client-json <file>        accept the terms, store the Desktop OAuth client
  auth --profile <p>                sign in one channel (en, es, ru, fr, de, tr: one profile per channel)
  reporting enable|disable|status --profile <p>
  sync --profile <p> [--full]       download new report files and refresh own metadata (or --all)
  schedule install|remove|status --profile <p> [--time 07:30]
  install [--force]                 copy this build to a pinned folder (run from the repository)
  transcripts add|remove|list [<folder>]   transcript folders a full purge also empties

Read:
  status [--profile <p>] [--json]   state only: sign-in, jobs, freshness, warnings (no figures)
  doctor [--profile <p>] [--json] [--offline]
  sql --profile <p> "<SELECT …>"    read-only SQL on the local store
  logs --profile <p> [--lines N]
  mcp-config                        print the "claude mcp add --scope local" line and folder settings
  serve                             MCP server over stdio (run by your MCP client)

Remove:
  purge --profile <p> --all | --backups      purge --public
  revoke --profile <p>              revoke at Google and delete everything for that channel

Docs: https://github.com/yrkan/creatorlens`;

const OPTIONS = {
  profile: { type: 'string' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  full: { type: 'boolean' },
  trigger: { type: 'string' },
  offline: { type: 'boolean' },
  limit: { type: 'string' },
  lines: { type: 'string' },
  'client-json': { type: 'string' },
  'token-store': { type: 'string' },
  mode: { type: 'string' },
  'no-browser': { type: 'boolean' },
  time: { type: 'string' },
  public: { type: 'boolean' },
  backups: { type: 'boolean' },
  force: { type: 'boolean' },
  'skip-tests': { type: 'boolean' },
} as const;

export async function main(argv: string[]): Promise<number | 'serving'> {
  if (!versionAtLeast(process.versions.node, NODE_MIN)) {
    process.stderr.write(`creatorlens needs Node ${NODE_MIN} or later (this is ${process.versions.node}).\n`);
    return 2;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`creatorlens ${APP_VERSION}\n`);
    return 0;
  }
  const { values: f, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  const { realContext } = await import('./context.ts');

  if (cmd === 'serve') {
    const ctx = realContext('serve');
    const base = ctx.http;
    // One-way read-only latch for every Google client the server could build (SEC-5).
    ctx.http = (extra) => {
      if (extra && extra.length) throw new Error('The server takes no extra routes.');
      const h = base();
      h.latchReadOnly();
      return h;
    };
    const { serve } = await import('./commands/serve.ts');
    await serve(ctx);
    return 'serving';
  }

  const ctx = realContext('cli');
  const sub = positionals[0];
  switch (cmd) {
    case 'sync':
      return (await import('./commands/ops.ts')).cmdSync(ctx, f);
    case 'status':
      return (await import('./commands/ops.ts')).cmdStatus(ctx, f);
    case 'doctor':
      return (await import('./commands/ops.ts')).cmdDoctor(ctx, f);
    case 'logs':
      return (await import('./commands/ops.ts')).cmdLogs(ctx, f);
    case 'sql':
      return (await import('./commands/ops.ts')).cmdSql(ctx, f, positionals);
    case 'mcp-config':
      return (await import('./commands/ops.ts')).cmdMcpConfig(ctx);
    case 'setup':
      return (await import('./commands/admin.ts')).cmdSetup(ctx, f);
    case 'auth':
      return (await import('./commands/admin.ts')).cmdAuth(ctx, f);
    case 'reporting':
      return (await import('./commands/admin.ts')).cmdReporting(ctx, f, sub);
    case 'revoke':
      return (await import('./commands/admin.ts')).cmdRevoke(ctx, f);
    case 'purge':
      return (await import('./commands/admin.ts')).cmdPurge(ctx, f);
    case 'schedule':
      return (await import('./commands/admin.ts')).cmdSchedule(ctx, f, sub);
    case 'install':
      return (await import('./commands/admin.ts')).cmdInstall(ctx, f);
    case 'transcripts':
      return (await import('./commands/admin.ts')).cmdTranscripts(ctx, f, sub, positionals[1]);
    default:
      process.stderr.write(`Unknown command "${cmd}". Run "creatorlens help".\n`);
      return 2;
  }
}

function realpathOrEmpty(p: string | undefined): string {
  try {
    return p ? realpathSync(p) : '';
  } catch {
    return '';
  }
}

if (realpathOrEmpty(process.argv[1]) === realpathOrEmpty(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 'serving') process.exitCode = code;
    },
    (e: unknown) => {
      const tty = e instanceof Error && e.constructor.name === 'TtyRequired';
      process.stderr.write(`creatorlens: ${errorText(e)}\n`);
      process.exitCode = tty ? 3 : 1;
    },
  );
}
