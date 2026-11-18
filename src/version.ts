// Names and versions in one place. The names test (test/names.test.ts) reads these: no name of ours may contain
// "youtube", "tube" or "yt" as a word (YouTube Branding Guidelines; design v2, SEC-2).

export const APP_NAME = 'creatorlens';
export const APP_VERSION = '0.1.0';

/** The store's schema version. A store written by a newer creatorlens is refused (CMP-17). */
export const SCHEMA_VERSION = 1;

/** node:sqlite gained `limits` (attach: 0 stops VACUUM INTO and ATTACH) in 24.15 (SEC-3). */
export const NODE_MIN = '24.15.0';
/** The owner's installed Node, pinned by its absolute path in the LaunchAgent and the MCP registration (Q22). */
export const NODE_PINNED = '26.7.0';

/**
 * The version of docs/privacy.md and docs/terms.md that `setup` asks the operator to accept (Developer Policies III.A,
 * III.E.3.c). Changing either document changes TERMS_SHA256; test/terms.test.ts then fails until this version moves.
 */
export const TERMS_VERSION = '2026-11-18.2';
export const TERMS_SHA256 = '5deae24de370089a1eaee40ccd97b3a434995359c654d6538804dce67b03dd37';

export const KEYCHAIN_SERVICE = 'creatorlens';
export const LAUNCH_LABEL_PREFIX = 'io.github.yrkan.creatorlens';
/** The name the operator gives the OAuth app in Google Auth Platform (no Google product name in it). */
export const OAUTH_APP_NAME = 'creatorlens (personal)';
export const MCP_SERVER_NAME = 'creatorlens';

/** Exactly these two scopes, both read-only. Nothing else is ever requested, and a grant with any other scope is refused. */
export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
] as const;

export const REPO_URL = 'https://github.com/yrkan/creatorlens';
