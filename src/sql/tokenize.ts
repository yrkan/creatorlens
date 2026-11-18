// A small SQL scanner for the read-only gate (SEC-3): the statement must start with SELECT, WITH or VALUES once leading
// comments are skipped, and nothing but whitespace and comments may follow its end. node:sqlite's prepare() takes no
// tail pointer, so "SELECT 1; DELETE …" would otherwise run its first half silently.

export interface Scan {
  ok: boolean;
  reason?: string;
  firstKeyword?: string;
}

const STARTS = new Set(['SELECT', 'WITH', 'VALUES']);
export const SQL_MAX_LENGTH = 100_000;

export function checkSql(sql: string): Scan {
  if (sql.length > SQL_MAX_LENGTH) return { ok: false, reason: `The query is longer than ${SQL_MAX_LENGTH} characters.` };
  let i = 0;
  const n = sql.length;
  const skipSpaceAndComments = (): void => {
    for (;;) {
      while (i < n && /\s/.test(sql[i]!)) i++;
      if (sql.startsWith('--', i)) {
        const e = sql.indexOf('\n', i);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (sql.startsWith('/*', i)) {
        const e = sql.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2;
        continue;
      }
      break;
    }
  };
  skipSpaceAndComments();
  const m = /^[A-Za-z]+/.exec(sql.slice(i));
  const first = m?.[0]?.toUpperCase();
  if (!first || !STARTS.has(first)) {
    return { ok: false, reason: 'Only one read-only statement is allowed: it must start with SELECT, WITH or VALUES.' };
  }
  // Walk to the end of the statement, honouring quotes and comments.
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      if (i >= n) return { ok: false, reason: 'An unterminated quote.' };
      i++;
      continue;
    }
    if (c === '[') {
      const e = sql.indexOf(']', i + 1);
      if (e < 0) return { ok: false, reason: 'An unterminated [identifier].' };
      i = e + 1;
      continue;
    }
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      skipSpaceAndComments();
      continue;
    }
    if (c === ';') {
      i++;
      skipSpaceAndComments();
      if (i < n) return { ok: false, reason: 'Only one statement is allowed.' };
      break;
    }
    i++;
  }
  return { ok: true, firstKeyword: first };
}
