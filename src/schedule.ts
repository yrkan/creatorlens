// The daily sync as a macOS LaunchAgent (design v2 § 4.5; SEC-17, UX-16, CMP-23): label
// io.github.yrkan.creatorlens.<profile>.sync, 07:30 local time, RunAtLoad (a Mac that was off at 07:30 catches up at
// login), Umask 077, absolute ProgramArguments (the node binary and the pinned app, no shell), no environment and no
// secret in the plist, logs in the profile's private folder. Only a pinned copy can be scheduled, never the dev clone.

import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { launchLabel, profilePaths } from './paths.ts';
import { isInside } from './util/fsx.ts';
import { versionAtLeast } from './util/semver.ts';
import { NODE_MIN } from './version.ts';

export interface PlistSpec {
  label: string;
  nodePath: string;
  appEntry: string;
  profile: string;
  hour: number;
  minute: number;
  logDir: string;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildPlist(spec: PlistSpec): string {
  if (!path.isAbsolute(spec.nodePath) || !path.isAbsolute(spec.appEntry)) throw new Error('The node and app paths must be absolute.');
  if (!(spec.hour >= 0 && spec.hour < 24 && spec.minute >= 0 && spec.minute < 60)) throw new Error('Invalid time.');
  const args = [spec.nodePath, spec.appEntry, 'sync', '--profile', spec.profile, '--trigger', 'schedule'];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key>',
    `    <integer>${spec.hour}</integer>`,
    '    <key>Minute</key>',
    `    <integer>${spec.minute}</integer>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(path.join(spec.logDir, 'launchd.out.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(path.join(spec.logDir, 'launchd.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Reads back the parts of a plist we wrote: ProgramArguments and the start time. */
export function parsePlist(text: string): { args: string[]; hour?: number; minute?: number } {
  const unxml = (s: string): string =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? '';
  const args = [...arr.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]!));
  const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)?.[1];
  return { args, ...(hour ? { hour: Number(hour) } : {}), ...(minute ? { minute: Number(minute) } : {}) };
}

export function plistPath(ctx: Ctx, profile: string): string {
  return path.join(ctx.paths.launchAgentsDir, `${launchLabel(profile)}.plist`);
}

export function isPinned(ctx: Ctx, entry: string): boolean {
  return isInside(entry, ctx.paths.appDir);
}

export { versionAtLeast };

export interface ScheduleStatus {
  installed: boolean;
  plist: string;
  label: string;
  nodePath?: string;
  nodeVersion?: string;
  nodeOk?: boolean;
  appEntry?: string;
  appExists?: boolean;
  pinned?: boolean;
  time?: string;
  loaded?: boolean | null;
  lastExitCode?: number | null;
  problems: string[];
}

export async function scheduleStatus(ctx: Ctx, profile: string, opts: { live?: boolean } = {}): Promise<ScheduleStatus> {
  const label = launchLabel(profile);
  const file = plistPath(ctx, profile);
  const st: ScheduleStatus = { installed: false, plist: file, label, problems: [] };
  if (!fs.existsSync(file)) {
    st.problems.push('not installed');
    return st;
  }
  st.installed = true;
  const p = parsePlist(fs.readFileSync(file, 'utf8'));
  st.nodePath = p.args[0];
  st.appEntry = p.args[1];
  if (p.hour !== undefined && p.minute !== undefined) st.time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  st.appExists = Boolean(st.appEntry && fs.existsSync(st.appEntry));
  st.pinned = Boolean(st.appEntry && isPinned(ctx, st.appEntry));
  if (!st.appExists) st.problems.push(`the scheduled app is missing: ${st.appEntry}`);
  if (!st.pinned) st.problems.push('the schedule does not run a pinned copy');
  if (st.nodePath && fs.existsSync(st.nodePath)) {
    if (opts.live !== false) {
      const r = await ctx.exec(st.nodePath, ['-v'], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
      st.nodeVersion = r.stdout.trim();
      st.nodeOk = r.code === 0 && versionAtLeast(st.nodeVersion, NODE_MIN);
      if (!st.nodeOk) st.problems.push(`the scheduled node is ${st.nodeVersion || 'unreadable'}; ${NODE_MIN} or later is required`);
    }
  } else {
    st.nodeOk = false;
    st.problems.push(`the scheduled node binary is missing: ${st.nodePath}`);
  }
  if (opts.live !== false && ctx.platform === 'darwin') {
    const r = await ctx.exec('/bin/launchctl', ['print', `gui/${ctx.uid}/${label}`], { timeoutMs: 10_000 }).catch(() => ({
      code: 1,
      stdout: '',
      stderr: '',
    }));
    st.loaded = r.code === 0;
    const m = /last exit code = (-?\d+)/.exec(r.stdout);
    st.lastExitCode = m ? Number(m[1]) : null;
    if (!st.loaded) st.problems.push('the LaunchAgent is not loaded');
  }
  return st;
}

export async function scheduleInstall(ctx: Ctx, profile: string, time: { hour: number; minute: number }): Promise<string> {
  if (ctx.platform !== 'darwin') throw new Error('The schedule is macOS-only in this version (Linux arrives in v2).');
  if (!isPinned(ctx, ctx.appEntry)) {
    throw new Error(
      `Only a pinned copy can be scheduled (it runs with your token every day). Run "creatorlens install" from the repository, then run "schedule install" with the pinned copy it prints (${ctx.paths.appDir}/<version>/cli.js).`,
    );
  }
  const pp = profilePaths(ctx.paths, profile);
  const label = launchLabel(profile);
  const file = plistPath(ctx, profile);
  const xmlText = buildPlist({ label, nodePath: ctx.execPath, appEntry: ctx.appEntry, profile, ...time, logDir: pp.logs });
  fs.mkdirSync(ctx.paths.launchAgentsDir, { recursive: true });
  fs.mkdirSync(pp.logs, { recursive: true, mode: 0o700 });
  await ctx.exec('/bin/launchctl', ['bootout', `gui/${ctx.uid}/${label}`], { timeoutMs: 15_000 }).catch(() => undefined);
  fs.writeFileSync(file, xmlText, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const r = await ctx.exec('/bin/launchctl', ['bootstrap', `gui/${ctx.uid}`, file], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.stderr.trim()}`);
  return file;
}

export async function scheduleRemove(ctx: Ctx, profile: string): Promise<boolean> {
  const label = launchLabel(profile);
  const file = plistPath(ctx, profile);
  if (ctx.platform === 'darwin') {
    await ctx.exec('/bin/launchctl', ['bootout', `gui/${ctx.uid}/${label}`], { timeoutMs: 15_000 }).catch(() => undefined);
  }
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
