// CI: prints the production dependency closure and fails when it grows past the recorded count without a CHANGELOG line
// (design v2, SEC-12, CMP-26). Run after "pnpm build".
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { runtimeClosure } = await import(path.join(root, 'dist', 'install.js'));
const closure = runtimeClosure(root);
const names = [...closure.keys()].sort();
const recorded = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'deps-baseline.json'), 'utf8'));
console.log(`Production packages (${names.length}): ${names.join(', ')}`);
const added = names.filter((n) => !recorded.production.includes(n));
if (added.length) {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const unexplained = added.filter((n) => !changelog.includes(n));
  if (unexplained.length) {
    console.error(`New production packages without a CHANGELOG line: ${unexplained.join(', ')}`);
    process.exit(1);
  }
  console.log(`New packages, explained in CHANGELOG.md: ${added.join(', ')}. Update scripts/deps-baseline.json.`);
}
