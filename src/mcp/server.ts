// The MCP server over stdio (design v2 § 7). v0 has three tools, all read-only and local: status, describe_store and
// sql_query. The policy clocks run when the server starts and again on every call (API-1). This module and everything
// it imports must stay free of src/admin/ (test/importGraph.test.ts): the server cannot sign in, create or delete
// Reporting jobs, or revoke.

import * as z from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import type { Ctx } from '../context.ts';
import { buildStatus } from '../status.ts';
import { checkProfile } from '../check.ts';
import { listProfiles, openProfileReader } from '../profile.ts';
import { getMeta } from '../store/db.ts';
import { REGISTRY } from '../store/schema.ts';
import { sqlQuery } from '../sql/sandbox.ts';
import { errorText } from '../util/redact.ts';
import { PROFILE_RE, profilePaths } from '../paths.ts';
import { APP_VERSION, MCP_SERVER_NAME } from '../version.ts';
import { GLOSSARY, INSTRUCTIONS, TOOL_TEXT } from './text.ts';
import { readDoc } from '../docs.ts';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const profileField = z.string().regex(PROFILE_RE, 'a profile name such as en, es, ru, fr, de or tr');

export interface Envelope {
  meta: {
    profile: string | null;
    channel: { id: string; title: string | null; handle: string | null } | null;
    source: 'store';
    banners: string[];
    note?: string;
  };
  data: unknown;
}

function text(obj: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function errorResult(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: errorText(message) }], isError: true };
}

function channelOf(ctx: Ctx, name: string): Envelope['meta']['channel'] {
  const { db } = openProfileReader(ctx, name);
  try {
    const id = getMeta(db, 'channel_id');
    return id ? { id, title: getMeta(db, 'channel_title') ?? null, handle: getMeta(db, 'channel_handle') ?? null } : null;
  } finally {
    db.close();
  }
}

export function describeStore(ctx: Ctx, name: string): unknown {
  const { db } = openProfileReader(ctx, name);
  try {
    const tables = Object.entries(REGISTRY).map(([table, info]) => {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      return {
        table,
        grain: info.grain,
        retention: info.retention,
        rows: Number(n),
        columns: Object.entries(info.columns).map(([column, c]) => ({ column, origin: c.origin, meaning: c.meaning })),
      };
    });
    return {
      engine: 'SQLite (window functions and JSON1)',
      version_note:
        'v0 keeps the Reporting archive ledger, jobs, own video metadata and bookkeeping. The report files themselves are not parsed yet (v1), so there are no audience figures in tables.',
      strangers_text: 'No table holds text written by strangers in v0. From v1, such columns are named untrusted_* and are always wrapped.',
      tables,
      examples: [
        "SELECT report_type_id, COUNT(*) AS files, MIN(report_day_pt) AS first_day, MAX(report_day_pt) AS last_day FROM report_files WHERE superseded_by IS NULL GROUP BY report_type_id",
        'SELECT report_type_id, create_time, expire_time FROM jobs WHERE gone_at IS NULL ORDER BY report_type_id',
        'SELECT id, title, published_day_pt, duration_s, privacy FROM videos WHERE removed_at IS NULL ORDER BY published_at_utc DESC LIMIT 20',
        'SELECT started_at, trigger, ok, reports_downloaded, error FROM sync_log ORDER BY id DESC LIMIT 10',
        "SELECT report_day_pt, report_type_id, rows FROM report_files WHERE rows = 0 ORDER BY report_day_pt DESC",
      ],
    };
  } finally {
    db.close();
  }
}

export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: APP_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'status',
    {
      title: 'Status',
      description: TOOL_TEXT.status,
      inputSchema: z.strictObject({ profile: profileField.optional() }),
      annotations: READ_ONLY,
    },
    async ({ profile }) => {
      try {
        const names = profile ? [profile] : listProfiles(ctx);
        for (const n of names) await checkProfile(ctx, n);
        return text(buildStatus(ctx, profile));
      } catch (e) {
        return errorResult(errorText(e));
      }
    },
  );

  server.registerTool(
    'describe_store',
    {
      title: 'Describe the store',
      description: TOOL_TEXT.describe_store,
      inputSchema: z.strictObject({ profile: profileField }),
      annotations: READ_ONLY,
    },
    async ({ profile }) => {
      try {
        const view = await checkProfile(ctx, profile);
        const env: Envelope = {
          meta: { profile, channel: channelOf(ctx, profile), source: 'store', banners: view.banners },
          data: describeStore(ctx, profile),
        };
        return text(env);
      } catch (e) {
        return errorResult(errorText(e));
      }
    },
  );

  server.registerTool(
    'sql_query',
    {
      title: 'Read-only SQL',
      description: TOOL_TEXT.sql_query,
      inputSchema: z.strictObject({
        profile: profileField,
        sql: z.string().min(1).max(100_000),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ profile, sql, limit }) => {
      try {
        const view = await checkProfile(ctx, profile);
        if (view.blockData) {
          return text({
            meta: { profile, channel: null, source: 'store', banners: view.banners },
            data: { refused: 'The data of this profile is blocked until the sign-in is confirmed or the profile is set up again.' },
          } satisfies Envelope);
        }
        const res = await sqlQuery(profilePaths(ctx.paths, profile).store, sql, { limit: limit ?? 200 });
        const env: Envelope = {
          meta: {
            profile,
            channel: channelOf(ctx, profile),
            source: 'store',
            banners: view.banners,
            ...(res.untrusted ? { note: 'This result read text written by strangers: every string cell is wrapped as {"untrusted": …}.' } : {}),
          },
          data: res.ok
            ? { columns: res.columns, rows: res.rows, truncated: res.truncated, elapsed_ms: res.elapsedMs }
            : { error: res.error },
        };
        return res.ok ? text(env) : { ...text(env), isError: true };
      } catch (e) {
        return errorResult(errorText(e));
      }
    },
  );

  server.registerResource(
    'schema',
    'creatorlens://schema',
    { title: 'Store schema', description: 'Tables and columns of a profile store, with origins and meanings.', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(REGISTRY, null, 1) }],
    }),
  );
  server.registerResource(
    'glossary',
    'creatorlens://glossary',
    { title: 'Glossary', description: 'YouTube days, Reporting files, definition breaks, what no API gives.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GLOSSARY }] }),
  );
  server.registerResource(
    'privacy',
    'creatorlens://privacy',
    { title: 'Privacy policy', description: 'What creatorlens stores, where, for how long, and who receives tool results.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readDoc('privacy.md') }] }),
  );
  return server;
}
