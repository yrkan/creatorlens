// Fixtures are synthetic (SEC-11): no real channel or video id may sit in this public repository. A channel id must
// start with "UCzz" and a video id in a link with "zz". The owner's own channel id is caught by its hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO } from './helpers/env.ts';

/** SHA-256 of channel ids that must never appear (the first owner's channel). */
const FORBIDDEN_HASHES = new Set(['a6a303bfe1dc8aae2725ef59e1e8130b74cc934bdaa23ab30a857c597c4aea49']);

function trackedFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('no real channel id or video id in any file of the repository', () => {
  const files = trackedFiles().filter((f) => !/\.(png|jpg|gz|db)$/.test(f) && !f.startsWith('node_modules/'));
  assert.ok(files.length > 10, 'git lists the repository files');
  const problems: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(REPO, f), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\bUC[A-Za-z0-9_-]{22}\b/g)) {
      const id = m[0];
      if (FORBIDDEN_HASHES.has(crypto.createHash('sha256').update(id).digest('hex'))) problems.push(`${f}: the owner's channel id`);
      else if (!id.startsWith('UCzz')) problems.push(`${f}: ${id} is not synthetic (use UCzz…)`);
    }
    for (const m of text.matchAll(/(?:youtu\.be\/|watch\?v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/g)) {
      if (!m[1]!.startsWith('zz')) problems.push(`${f}: video id ${m[1]} is not synthetic (use zz…)`);
    }
    for (const m of text.matchAll(/"video_id"\s*:\s*"([A-Za-z0-9_-]{11})"/g)) {
      if (!m[1]!.startsWith('zz')) problems.push(`${f}: video id ${m[1]} is not synthetic`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the hash list is a real SHA-256 list', () => {
  for (const h of FORBIDDEN_HASHES) assert.match(h, /^[0-9a-f]{64}$/);
});
