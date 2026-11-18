// The documents the app shows (terms, privacy policy): next to the built files in a pinned copy, or in the repository.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type DocName = 'privacy.md' | 'terms.md' | 'policy.md';

export function docPath(name: DocName): string {
  for (const rel of [`./docs/${name}`, `../docs/${name}`]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Document ${name} is missing from this installation.`);
}

export function readDoc(name: DocName): string {
  return fs.readFileSync(docPath(name), 'utf8');
}
