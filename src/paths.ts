// Where creatorlens keeps its files. Everything is inside one data folder; nothing is written anywhere else (ML K6),
// except the LaunchAgent plist that `schedule install` writes into ~/Library/LaunchAgents on the operator's command.

import os from 'node:os';
import path from 'node:path';
import { LAUNCH_LABEL_PREFIX } from './version.ts';

/** Profile names reach paths, the Keychain account and the plist, so they are a closed alphabet (SEC-17). */
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertProfile(name: string | undefined): string {
  if (!name) throw new Error('A profile is required: --profile <name> (for example en, es, ru, fr, de, tr).');
  if (!PROFILE_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}": use 1-32 characters from a-z, 0-9 and "-", starting with a letter or digit.`);
  }
  if (name === 'oauth-client') throw new Error('"oauth-client" is reserved.');
  return name;
}

export interface Paths {
  root: string;
  config: string;
  projectDb: string;
  publicDb: string;
  appDir: string;
  profilesDir: string;
  secretsDir: string;
  launchAgentsDir: string;
}

export interface ProfilePaths {
  name: string;
  dir: string;
  store: string;
  reports: string;
  backups: string;
  logs: string;
  lock: string;
}

/** The data folder: CREATORLENS_HOME if set (tests), else the platform's application-data folder. */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CREATORLENS_HOME) return path.resolve(env.CREATORLENS_HOME);
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'creatorlens');
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(xdg, 'creatorlens');
}

export function makePaths(root: string, launchAgentsDir?: string): Paths {
  return {
    root,
    config: path.join(root, 'config.json'),
    projectDb: path.join(root, 'project.db'),
    publicDb: path.join(root, 'public.db'),
    appDir: path.join(root, 'app'),
    profilesDir: path.join(root, 'profiles'),
    secretsDir: path.join(root, 'secrets'),
    launchAgentsDir: launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
  };
}

export function profilePaths(paths: Paths, profile: string): ProfilePaths {
  const name = assertProfile(profile);
  const dir = path.join(paths.profilesDir, name);
  return {
    name,
    dir,
    store: path.join(dir, 'store.db'),
    reports: path.join(dir, 'reports'),
    backups: path.join(dir, 'backups'),
    logs: path.join(dir, 'logs'),
    lock: path.join(dir, 'writer.lock'),
  };
}

export function launchLabel(profile: string): string {
  return `${LAUNCH_LABEL_PREFIX}.${assertProfile(profile)}.sync`;
}
