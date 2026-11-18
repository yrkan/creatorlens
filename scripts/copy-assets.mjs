// After tsc: the documents the app shows go next to the build, and the CLI entry becomes executable.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'docs'), { recursive: true });
for (const d of ['privacy.md', 'terms.md', 'policy.md']) {
  fs.copyFileSync(path.join(root, 'docs', d), path.join(dist, 'docs', d));
}
fs.chmodSync(path.join(dist, 'cli.js'), 0o755);
