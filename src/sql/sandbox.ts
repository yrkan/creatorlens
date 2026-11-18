// The parent side of the SQL sandbox: one query at a time, each in a fresh child process (fork, no shell, an empty
// environment), killed with SIGKILL when it runs past 5 seconds. Strangers' text in the result is cleaned and wrapped:
// when the child read any untrusted_* column, every string cell becomes {"untrusted": "…"} (design v2 § 6, SEC-1).

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RunnerRequest, RunnerResponse } from './runner.ts';
import { wrapUntrusted, type Wrapped } from '../util/text.ts';

export const SQL_TIMEOUT_MS = 5_000;
export const SQL_MAX_ROWS = 1_000;
export const SQL_MAX_BYTES = 1_000_000;

export interface QueryResult {
  ok: boolean;
  error?: string;
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  untrusted: boolean;
  tablesRead: string[];
  elapsedMs: number;
}

const runnerFile = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './runner.ts' : './runner.js', import.meta.url));

let queue: Promise<unknown> = Promise.resolve();

function runInChild(req: RunnerRequest, timeoutMs: number): Promise<RunnerResponse> {
  return new Promise((resolve) => {
    const child = fork(runnerFile, ['--creatorlens-sql-child'], {
      env: {},
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    let settled = false;
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 2000) stderr += d;
    });
    const done = (r: RunnerResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, error: `The query ran longer than ${timeoutMs / 1000} s and was stopped.` }),
      timeoutMs,
    );
    child.once('message', (m) => done(m as RunnerResponse));
    child.once('error', (e) => done({ ok: false, error: `The query process failed: ${e.message}` }));
    child.once('exit', (code, signal) => {
      if (!settled) done({ ok: false, error: `The query process ended (${signal ?? code})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}.` });
    });
    child.send(req);
  });
}

/** Wraps every string cell when the result read strangers' text. Numbers, nulls and owner text otherwise pass as they are. */
export function wrapCells(rows: unknown[][], untrusted: boolean): unknown[][] {
  if (!untrusted) return rows;
  return rows.map((r) => r.map((v): unknown => (typeof v === 'string' ? (wrapUntrusted(v) as Wrapped) : v)));
}

export interface QueryOptions {
  limit?: number;
  timeoutMs?: number;
  maxBytes?: number;
  untrustedTables?: string[];
}

/** Runs one read-only query against a store file. Never throws for a bad query; the error is in the result. */
export function sqlQuery(dbPath: string, sql: string, opts: QueryOptions = {}): Promise<QueryResult> {
  const job = queue.then(async () => {
    const started = Date.now();
    const res = await runInChild(
      {
        dbPath,
        sql,
        maxRows: Math.min(Math.max(1, opts.limit ?? 200), SQL_MAX_ROWS),
        maxBytes: opts.maxBytes ?? SQL_MAX_BYTES,
        ...(opts.untrustedTables ? { untrustedTables: opts.untrustedTables } : {}),
      },
      opts.timeoutMs ?? SQL_TIMEOUT_MS,
    );
    const untrusted = Boolean(res.untrusted);
    return {
      ok: res.ok,
      ...(res.error ? { error: res.error } : {}),
      columns: res.columns ?? [],
      rows: wrapCells(res.rows ?? [], untrusted),
      truncated: Boolean(res.truncated),
      untrusted,
      tablesRead: res.tablesRead ?? [],
      elapsedMs: Date.now() - started,
    } satisfies QueryResult;
  });
  queue = job.catch(() => {});
  return job;
}
