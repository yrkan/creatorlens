// The operator's global settings (config.json, 0600): the OAuth client's public half, the accepted terms version, the
// secret store, and the transcript folders a full purge also empties (Q25). The client secret is in the secret store.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Paths } from './paths.ts';
import { readPrivateFile, writeFileAtomic, isInside } from './util/fsx.ts';
import type { StoreKind } from './secrets.ts';
import { TERMS_VERSION } from './version.ts';

export interface ClientInfo {
  clientId: string;
  projectId: string;
  /** The numeric prefix of the client id is the Cloud project's number; jobs are recorded with it (CMP-14). */
  projectNumber: string;
  installedAt: string;
}

export interface Config {
  version: 1;
  tokenStore: StoreKind;
  client?: ClientInfo;
  terms?: { version: string; acceptedAt: string };
  transcriptDirs: string[];
}

export function defaultConfig(platform: NodeJS.Platform = process.platform): Config {
  return { version: 1, tokenStore: platform === 'darwin' ? 'keychain' : 'file', transcriptDirs: [] };
}

export function loadConfig(paths: Paths, platform: NodeJS.Platform = process.platform): Config {
  try {
    fs.lstatSync(paths.config);
  } catch {
    return defaultConfig(platform);
  }
  const raw = JSON.parse(readPrivateFile(paths.config).toString('utf8')) as Partial<Config>;
  return { ...defaultConfig(platform), ...raw, transcriptDirs: Array.isArray(raw.transcriptDirs) ? raw.transcriptDirs : [] };
}

export function saveConfig(paths: Paths, cfg: Config): void {
  writeFileAtomic(paths.config, `${JSON.stringify(cfg, null, 2)}\n`, 0o600);
}

export function termsAccepted(cfg: Config): boolean {
  return cfg.terms?.version === TERMS_VERSION;
}

export class TermsNotAccepted extends Error {
  constructor() {
    super(
      `The terms and privacy policy (version ${TERMS_VERSION}) are not accepted yet. Run "creatorlens setup --client-json <file>" in your Terminal first.`,
    );
  }
}

export function requireTerms(cfg: Config): void {
  if (!termsAccepted(cfg)) throw new TermsNotAccepted();
}

/** An installed-app OAuth client JSON from Google Auth Platform → Clients → Desktop app. */
export interface InstalledClient {
  clientId: string;
  clientSecret: string;
  projectId: string;
  projectNumber: string;
}

/** Validates a client JSON: only an "installed" (Desktop app) client is accepted, never "web" (SEC-14, CMP-19). */
export function parseClientJson(text: string): InstalledClient {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('The client file is not JSON. Download it again from Google Auth Platform → Clients.');
  }
  const obj = j as Record<string, unknown>;
  if (obj.web) throw new Error('This is a "Web application" client. Create a "Desktop app" client instead (docs/owner-setup.md, step 6).');
  const inst = obj.installed as Record<string, unknown> | undefined;
  if (!inst) throw new Error('This is not a Desktop app client JSON (no "installed" key).');
  const clientId = inst.client_id;
  const clientSecret = inst.client_secret;
  const projectId = inst.project_id;
  if (typeof clientId !== 'string' || !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('The client JSON has no valid client_id.');
  }
  if (typeof clientSecret !== 'string' || clientSecret.length < 10) throw new Error('The client JSON has no client_secret.');
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) {
    throw new Error('The client JSON has no valid project_id.');
  }
  for (const k of ['auth_uri', 'token_uri']) {
    const v = inst[k];
    if (v !== undefined && typeof v === 'string' && !/^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com)\//.test(v)) {
      throw new Error(`Unexpected ${k} in the client JSON: ${v}`);
    }
  }
  const projectNumber = clientId.split('-')[0] ?? '';
  return { clientId, clientSecret, projectId, projectNumber };
}

/** Transcript folders must sit inside ~/.claude/projects: a purge deletes files there and nowhere else. */
export function validateTranscriptDir(dir: string, home: string = os.homedir()): string {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, home));
  const base = path.join(home, '.claude', 'projects');
  if (!isInside(abs, base) || abs === base) {
    throw new Error(`A transcript folder must be one project folder inside ${base}.`);
  }
  return abs;
}
