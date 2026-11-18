// A small rotating log (0600, rotated by size). Every line is redacted; no title, description or stranger's text is
// logged, only ids, counts and errors (SEC-16, CMP-11).

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsx.ts';
import { redact } from './redact.ts';

export const LOG_MAX_BYTES = 1_000_000;
export const LOG_KEEP = 3;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export class FileLogger implements Logger {
  readonly file: string;
  private readonly now: () => Date;
  private readonly echo: ((line: string) => void) | undefined;
  constructor(dir: string, name: string, now: () => Date = () => new Date(), echo?: (line: string) => void) {
    this.file = path.join(dir, `${name}.log`);
    this.now = now;
    this.echo = echo;
  }
  private write(level: string, msg: string): void {
    const line = `${this.now().toISOString()} ${level} ${redact(msg).replace(/\n/g, ' | ')}\n`;
    try {
      ensureDir(path.dirname(this.file));
      this.rotate();
      const fd = fs.openSync(this.file, 'a', 0o600);
      try {
        fs.writeSync(fd, line);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(this.file, 0o600);
    } catch {
      // A log that cannot be written never stops the work.
    }
    this.echo?.(line.trimEnd());
  }
  private rotate(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < LOG_MAX_BYTES) return;
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
    const drop = `${this.file}.${LOG_KEEP + 1}`;
    if (fs.existsSync(drop)) fs.rmSync(drop);
  }
  info(msg: string): void {
    this.write('INFO', msg);
  }
  warn(msg: string): void {
    this.write('WARN', msg);
  }
  error(msg: string): void {
    this.write('ERROR', msg);
  }
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

/** The last `n` lines of a log file (and its first rotation when needed). */
export function tailLog(file: string, n: number): string[] {
  const read = (f: string): string[] => {
    try {
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const lines = [...read(`${file}.1`), ...read(file)];
  return lines.slice(-n);
}
