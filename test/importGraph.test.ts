// The MCP server must not be able to sign in, create or delete Reporting jobs, or revoke (design v2 § 4.3; SEC-5,
// API-9, CMP-13). Those requests live in src/admin/. This test walks every static import reachable from the server's
// entry (cli.ts's static imports plus commands/serve.ts) and fails if any reaches src/admin/ or the admin commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers/env.ts';

const SRC = path.join(REPO, 'src');

function staticImports(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  // `import … from '…'` and `export … from '…'`, not `import('…')`.
  for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out.filter((s) => s.startsWith('.')).map((s) => path.resolve(path.dirname(file), s));
}

function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of staticImports(f)) stack.push(d);
  }
  return seen;
}

test('the server never imports src/admin/ or the admin commands', () => {
  const files = closure([path.join(SRC, 'cli.ts'), path.join(SRC, 'commands', 'serve.ts')]);
  const rel = [...files].map((f) => path.relative(SRC, f)).sort();
  assert.ok(rel.includes('mcp/server.ts'), 'the walk reaches the server');
  assert.ok(rel.includes('google/http.ts'), 'the walk reaches the HTTP layer');
  const bad = rel.filter((f) => f.startsWith('admin/') || f === 'commands/admin.ts');
  assert.deepEqual(bad, [], `the server's imports reach ${bad.join(', ')}`);
});

test('cli.ts loads every command dynamically', () => {
  const direct = staticImports(path.join(SRC, 'cli.ts')).map((f) => path.relative(SRC, f));
  assert.ok(!direct.some((f) => f.startsWith('commands/') || f.startsWith('admin/')), direct.join(', '));
});

test('the state-changing routes are defined only in src/admin/routes.ts', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith(path.join('admin', 'routes.ts'))) {
        const t = fs.readFileSync(p, 'utf8');
        if (/method:\s*'(POST|DELETE)'/.test(t) && !p.endsWith(path.join('google', 'routes.ts'))) offenders.push(path.relative(SRC, p));
        if (/id:\s*'(oauth\.revoke|reporting\.jobs\.create|reporting\.jobs\.delete)'/.test(t)) offenders.push(path.relative(SRC, p));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, []);
  const core = fs.readFileSync(path.join(SRC, 'google', 'routes.ts'), 'utf8');
  const posts = [...core.matchAll(/id:\s*'([^']+)',\s*method:\s*'POST'/g)].map((m) => m[1]);
  assert.deepEqual(posts, ['oauth.token'], 'the only core POST is the token endpoint');
});
