// No name of ours may contain "youtube", "tube" or "yt" as a word (Branding Guidelines; design v2, SEC-2, CMP-1):
// the package, the command, the MCP server, the tools, the Keychain service, the LaunchAgent label, the OAuth app name.
// "for YouTube" stays descriptive, in descriptions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, KEYCHAIN_SERVICE, LAUNCH_LABEL_PREFIX, MCP_SERVER_NAME, OAUTH_APP_NAME, APP_VERSION } from '../src/version.ts';
import { launchLabel } from '../src/paths.ts';
import { createServer } from '../src/mcp/server.ts';
import { makeEnv, REPO } from './helpers/env.ts';

const BANNED = new Set(['youtube', 'tube', 'yt']);

function words(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function assertClean(kind: string, name: string): void {
  const bad = words(name).filter((w) => BANNED.has(w) || w.includes('youtube') || w.endsWith('tube'));
  assert.deepEqual(bad, [], `${kind} "${name}" carries a YouTube mark`);
}

test('every name of ours is free of youtube, tube and yt', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string>; version: string };
  assertClean('package', pkg.name);
  for (const b of Object.keys(pkg.bin)) assertClean('bin', b);
  for (const [k, v] of Object.entries({ APP_NAME, KEYCHAIN_SERVICE, LAUNCH_LABEL_PREFIX, MCP_SERVER_NAME, OAUTH_APP_NAME })) assertClean(k, v);
  assertClean('LaunchAgent label', launchLabel('en'));
  assert.equal(pkg.version, APP_VERSION, 'package.json and src/version.ts agree on the version');
});

test('every MCP tool and resource name is free of the marks, and every description opens with "YouTube"', async () => {
  const env = makeEnv();
  try {
    const server = createServer(env.ctx) as unknown as {
      _registeredTools?: Record<string, { description?: string }>;
      _registeredResources?: Record<string, unknown>;
    };
    const tools = server._registeredTools ?? {};
    const names = Object.keys(tools);
    assert.deepEqual(names.sort(), ['describe_store', 'sql_query', 'status']);
    for (const n of names) {
      assertClean('tool', n);
      assert.match(tools[n]!.description ?? '', /^YouTube /, `${n} description opens with "YouTube"`);
    }
    for (const r of Object.keys(server._registeredResources ?? {})) assertClean('resource', r);
  } finally {
    env.cleanup();
  }
});
