// The SQL child (SEC-3, SEC-4, CMP-18). It runs in its own process with an empty environment, opens the store
// read-only with `limits` (attach: 0 also stops VACUUM INTO), defensive mode and a deny-by-default authorizer, refuses
// anything but one SELECT/WITH/VALUES statement, reads with iterate() under row and byte caps, and reports which
// columns it read so the parent can wrap strangers' text. The parent kills it with SIGKILL after 5 s: node:sqlite has no
// interrupt, and a worker thread cannot stop a native sqlite3_step.

import { openDatabase, sqliteConstants as C } from '../store/sqlite.ts';
import { checkSql } from './tokenize.ts';

export interface RunnerRequest {
  dbPath: string;
  sql: string;
  maxRows: number;
  maxBytes: number;
  /** Tables whose every text column is a stranger's text (in addition to untrusted_* columns anywhere). */
  untrustedTables?: string[];
}

export interface RunnerResponse {
  ok: boolean;
  error?: string;
  columns?: string[];
  rows?: unknown[][];
  truncated?: boolean;
  /** At least one column holding strangers' text was read: every string cell is wrapped by the parent. */
  untrusted?: boolean;
  tablesRead?: string[];
}

/** Functions a query may call. Everything else (randomblob, zeroblob, load_extension, readfile…) is refused. */
export const ALLOWED_FUNCTIONS = new Set([
  'abs', 'avg', 'coalesce', 'count', 'date', 'datetime', 'group_concat', 'string_agg', 'ifnull', 'iif', 'if', 'instr',
  'julianday', 'length', 'like', 'glob', 'lower', 'upper', 'ltrim', 'rtrim', 'trim', 'max', 'min', 'nullif', 'printf',
  'format', 'replace', 'round', 'sign', 'strftime', 'substr', 'substring', 'sum', 'total', 'typeof', 'unixepoch',
  'time', 'timediff', 'quote', 'hex', 'char', 'unicode', 'concat', 'concat_ws', 'octet_length', 'median',
  'json', 'json_extract', 'json_array_length', 'json_type', 'json_valid', 'json_object', 'json_array', 'json_group_array',
  'json_group_object', 'json_each', 'json_tree', '->', '->>',
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
  'nth_value',
  'ceil', 'ceiling', 'floor', 'pow', 'power', 'sqrt', 'exp', 'ln', 'log', 'log10', 'log2', 'mod', 'pi', 'trunc',
  'likely', 'unlikely', 'likelihood',
]);

const LIMITS = { attach: 0, length: 1_000_000, sqlLength: 100_000, compoundSelect: 50, exprDepth: 100, columns: 200 };

export function runQuery(req: RunnerRequest): RunnerResponse {
  const scan = checkSql(req.sql);
  if (!scan.ok) return { ok: false, error: scan.reason ?? 'refused' };
  const untrustedTables = new Set(req.untrustedTables ?? []);
  let db;
  try {
    db = openDatabase(req.dbPath, { readOnly: true, allowExtension: false, limits: LIMITS } as never);
  } catch (e) {
    return { ok: false, error: `The store could not be opened: ${(e as Error).message}` };
  }
  try {
    db.enableDefensive(true);
    db.exec('PRAGMA temp_store=MEMORY');
    const tablesRead = new Set<string>();
    let untrusted = false;
    db.setAuthorizer((action: number, a1: string | null, a2: string | null) => {
      switch (action) {
        case C.SQLITE_SELECT:
        case C.SQLITE_RECURSIVE:
          return C.SQLITE_OK;
        case C.SQLITE_READ:
          if (a1) tablesRead.add(a1);
          if ((a2 && a2.toLowerCase().startsWith('untrusted_')) || (a1 && untrustedTables.has(a1))) untrusted = true;
          return C.SQLITE_OK;
        case C.SQLITE_FUNCTION:
          return a2 && ALLOWED_FUNCTIONS.has(a2.toLowerCase()) ? C.SQLITE_OK : C.SQLITE_DENY;
        default:
          return C.SQLITE_DENY;
      }
    });
    let stmt;
    try {
      stmt = db.prepare(req.sql);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const columns = stmt.columns().map((c) => c.name);
    stmt.setReturnArrays(true);
    const rows: unknown[][] = [];
    let bytes = 0;
    let truncated = false;
    for (const row of stmt.iterate() as Iterable<unknown[]>) {
      const cells = row.map((v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? `<blob ${v.byteLength} bytes>` : v));
      bytes += Buffer.byteLength(JSON.stringify(cells));
      if (rows.length >= req.maxRows || bytes > req.maxBytes) {
        truncated = true;
        break;
      }
      rows.push(cells);
    }
    return { ok: true, columns, rows, truncated, untrusted, tablesRead: [...tablesRead].sort() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    db.close();
  }
}

// When started as a child process: answer one request over IPC, then exit.
if (typeof process.send === 'function' && process.argv.includes('--creatorlens-sql-child')) {
  process.once('message', (msg: RunnerRequest) => {
    const res = runQuery(msg);
    process.send!(res, () => process.exit(0));
  });
}
