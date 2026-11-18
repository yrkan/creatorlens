// File helpers that keep the data folder private: folders 0700, files 0600, written atomically, read only when they are
// regular files owned by us with no group or other bits (SEC-7). Node applies a mode only when it creates a file, so an
// existing file is chmod-ed explicitly.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`Folder is owned by another user: ${dir}`);
  }
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/** Writes a file atomically: a new temporary file (exclusive create, given mode), fsync, rename, fsync of the folder. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // fsync of a folder is not supported everywhere; the rename is still atomic.
  }
}

/** Reads a private file; refuses a symlink, a non-regular file, another owner or any group/other permission bit. */
export function readPrivateFile(file: string): Buffer {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) throw new Error(`Refusing a symlink: ${file}`);
  if (!st.isFile()) throw new Error(`Not a regular file: ${file}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`File is owned by another user: ${file}`);
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`File is readable by others (mode ${(st.mode & 0o777).toString(8)}): ${file}`);
  return fs.readFileSync(file);
}

export function fileExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or inside it, after resolving both. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Removes a folder tree, but only inside `within` (a guard against a wrong path reaching rm -rf). */
export function removeTree(target: string, within: string): void {
  if (!isInside(target, within) || path.resolve(target) === path.resolve(within)) {
    throw new Error(`Refusing to remove ${target}: not inside ${within}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

/** Total size in bytes of the regular files under a folder (0 when it does not exist). */
export function treeSize(dir: string): number {
  let total = 0;
  if (!fileExists(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

export function sha256Hex(data: Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
