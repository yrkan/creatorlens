// `creatorlens install`: copies the built app, with its two runtime dependencies (and theirs), into
// <data folder>/app/<version>/ (SEC-17, CMP-17). The LaunchAgent and the MCP registration run that copy, never the
// repository a model or a `git pull` can change. It refuses when the build is missing or the tests fail.

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { APP_VERSION } from './version.ts';
import { ensureDir, sha256Hex } from './util/fsx.ts';

export interface InstallResult {
  target: string;
  entry: string;
  packages: string[];
  files: number;
}

/** Finds a package the way Node does: <dir>/node_modules/<name>, walking up from the requiring package. */
function resolvePackageDir(fromDir: string, name: string): string {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot find the package ${name} from ${fromDir}.`);
    dir = parent;
  }
}

/** The runtime dependency closure of the repository, as name → real folder. */
export function runtimeClosure(repoRoot: string): Map<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const out = new Map<string, string>();
  const visit = (name: string, fromDir: string): void => {
    if (out.has(name)) return;
    const dir = resolvePackageDir(fromDir, name);
    out.set(name, dir);
    const child = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(child.dependencies ?? {})) visit(dep, dir);
  };
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, repoRoot);
  return out;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

export function repoRootFromEntry(entry: string): string {
  // dist/cli.js → the repository is the parent of dist.
  return path.resolve(path.dirname(entry), '..');
}

export async function installPinned(ctx: Ctx, opts: { force: boolean; runTests: boolean }): Promise<InstallResult> {
  const entry = ctx.appEntry;
  if (entry.endsWith('.ts')) throw new Error('Build first ("pnpm build"), then run "node dist/cli.js install".');
  const distDir = path.dirname(entry);
  const repo = repoRootFromEntry(entry);
  const pkgFile = path.join(repo, 'package.json');
  if (!fs.existsSync(pkgFile)) throw new Error('Run install from the repository build (node dist/cli.js install).');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { name?: string; version?: string };
  if (pkg.name !== 'creatorlens' || pkg.version !== APP_VERSION) {
    throw new Error(`The build (${APP_VERSION}) does not match ${pkgFile} (${pkg.name} ${pkg.version}). Run "pnpm build" again.`);
  }
  if (opts.runTests) {
    const r = await ctx.exec(ctx.execPath, ['--test', '--test-concurrency=4', 'test/**/*.test.ts'], {
      timeoutMs: 600_000,
      cwd: repo,
      env: { PATH: ctx.env.PATH ?? '', HOME: ctx.env.HOME ?? '' },
    });
    if (r.code !== 0) throw new Error(`The tests failed; nothing was installed.\n${r.stdout.slice(-2000)}`);
  }
  ensureDir(ctx.paths.root);
  ensureDir(ctx.paths.appDir);
  const target = path.join(ctx.paths.appDir, APP_VERSION);
  if (fs.existsSync(target)) {
    if (!opts.force) throw new Error(`${target} exists. Use --force to replace it (the version number did not change).`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  const staging = `${target}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(distDir, staging, { recursive: true, dereference: true });
  ensureDir(path.join(staging, 'docs'));
  for (const d of ['privacy.md', 'terms.md', 'policy.md']) fs.copyFileSync(path.join(repo, 'docs', d), path.join(staging, 'docs', d));
  fs.writeFileSync(
    path.join(staging, 'package.json'),
    `${JSON.stringify({ name: 'creatorlens', version: APP_VERSION, private: true, type: 'module' }, null, 2)}\n`,
  );
  const closure = runtimeClosure(repo);
  for (const [name, dir] of closure) {
    const dest = path.join(staging, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(dir, dest, {
      recursive: true,
      dereference: true,
      filter: (src) => !path.relative(dir, src).split(path.sep).includes('node_modules'),
    });
  }
  const manifest: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else manifest[path.relative(staging, p)] = sha256Hex(fs.readFileSync(p));
    }
  };
  walk(staging);
  fs.writeFileSync(
    path.join(staging, 'install.json'),
    `${JSON.stringify({ version: APP_VERSION, installed_at: ctx.clock.now().toISOString(), from: repo, files: manifest }, null, 1)}\n`,
  );
  fs.renameSync(staging, target);
  const pinnedEntry = path.join(target, 'cli.js');
  const smoke = await ctx.exec(ctx.execPath, [pinnedEntry, '--version'], { timeoutMs: 30_000 });
  if (smoke.code !== 0 || !smoke.stdout.includes(APP_VERSION)) {
    throw new Error(`The pinned copy does not start: ${smoke.stderr.trim().slice(0, 500)}`);
  }
  return { target, entry: pinnedEntry, packages: [...closure.keys()], files: countFiles(target) };
}

export function latestPinned(ctx: Ctx): string | undefined {
  try {
    const versions = fs
      .readdirSync(ctx.paths.appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
        return 0;
      });
    const v = versions.at(-1);
    return v ? path.join(ctx.paths.appDir, v, 'cli.js') : undefined;
  } catch {
    return undefined;
  }
}
