// YT2.1's acceptance: every one of the review's 102 findings (SEC-1–20, API-1–27, UX-1–26, CMP-1–29) has its own row,
// with a decision, in design v2 § 12.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers/env.ts';

const COUNTS = { SEC: 20, API: 27, UX: 26, CMP: 29 } as const;

test('design v2 has a row for each of the 102 review findings', () => {
  const text = fs.readFileSync(path.join(REPO, 'docs', 'design.md'), 'utf8');
  const section = text.slice(text.indexOf('## 12. Every review finding'));
  assert.ok(section.length > 1000, 'section 12 exists');
  const rows = new Set([...section.matchAll(/^\| ((?:SEC|API|UX|CMP)-\d+) \|/gm)].map((m) => m[1]));
  const missing: string[] = [];
  for (const [prefix, n] of Object.entries(COUNTS)) {
    for (let i = 1; i <= n; i++) if (!rows.has(`${prefix}-${i}`)) missing.push(`${prefix}-${i}`);
  }
  assert.deepEqual(missing, []);
  assert.equal(rows.size, 102);
});
