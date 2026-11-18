// The analysis folder's settings that `mcp-config` prints and the README shows (SEC-6). A Claude Code Bash rule matches
// the command as written, "*" standing for any text (code.claude.com/docs/en/permissions, "Wildcard patterns"). The
// deny rules must catch the direct forms of a state-changing command and of the Keychain read, quoted paths included
// (the data folder's path has a space, so every real invocation quotes or escapes it), and must not catch the one
// allowed command. A wrapped command (a variable, sh -c) passes: the README calls the rules a net, not a wall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { folderSettings, shellQuote, STATE_CHANGING_COMMANDS } from '../src/commands/ops.ts';
import { REPO } from './helpers/env.ts';

const ROOT = '/Users/someone/Library/Application Support/creatorlens';
const NODE = '/Users/someone/.nvm/versions/node/v26.7.0/bin/node';
const ENTRY = `${ROOT}/app/0.1.0/cli.js`;

function inner(rule: string, tool: string): string | undefined {
  const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(rule);
  return m?.[1];
}

function globMatches(pattern: string, command: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  return re.test(command);
}

function settings(): { deny: string[]; allow: string[] } {
  const s = folderSettings(ROOT, NODE, ENTRY) as { permissions: { deny: string[]; allow: string[] } };
  return s.permissions;
}

function denied(command: string): boolean {
  return settings()
    .deny.map((r) => inner(r, 'Bash'))
    .some((p) => p !== undefined && globMatches(p, command));
}

test('the deny rules catch every direct form of a state-changing command and of the Keychain read', () => {
  for (const c of STATE_CHANGING_COMMANDS) {
    const forms = [
      `${shellQuote(NODE)} ${shellQuote(ENTRY)} ${c} --profile en`, // the quoting mcp-config itself prints
      `node "${ENTRY}" ${c} --profile en`,
      `node ${ENTRY.replace(/ /g, '\\ ')} ${c} --profile en`,
      `cd "${ROOT}/app/0.1.0" && node cli.js ${c} --profile en`,
      `script -q /dev/null node '${ENTRY}' ${c} --profile en`,
      `creatorlens ${c} --profile en`,
    ];
    for (const f of forms) assert.ok(denied(f), `not denied: ${f}`);
  }
  for (const f of [
    'security find-generic-password -s creatorlens -a en -w',
    '/usr/bin/security find-generic-password -s creatorlens -a oauth-client -w',
    'security dump-keychain -d',
  ]) {
    assert.ok(denied(f), `not denied: ${f}`);
  }
});

test('the one allowed command is not denied, and the deny rules are a net, not a wall', () => {
  const allowed = `${shellQuote(NODE)} ${shellQuote(ENTRY)} status --json`;
  assert.deepEqual(settings().allow, [`Bash(${allowed})`]);
  assert.equal(denied(allowed), false, 'deny rules are checked first: they must leave status --json alone');
  for (const ok of ['ls', 'git status', `${shellQuote(NODE)} ${shellQuote(ENTRY)} doctor --json`]) assert.equal(denied(ok), false, ok);
  // What the README says the rules miss: a command hidden behind a variable set earlier. The shell on "ask" covers it.
  assert.equal(denied('node "$APP" revoke --profile en'), false);
  assert.ok(settings().deny.includes(`Read(${ROOT}/**)`));
});

test('the README shows the same deny rules as mcp-config prints', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('### Settings for the folder where you use it'));
  const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(block, 'the README has the settings block');
  const shown = JSON.parse(block) as { permissions: { deny: string[] } };
  const bash = (rules: string[]): string[] => rules.filter((r) => r.startsWith('Bash(')).sort();
  assert.deepEqual(bash(shown.permissions.deny), bash(settings().deny));
});
