// Token refresh, the scope check and the OAuth error map. The sign-in flow itself (loopback, PKCE, browser) is in
// src/admin/oauthFlow.ts, which only the CLI loads.

import { HttpError, type GoogleHttp } from './http.ts';
import { HOSTS } from './routes.ts';
import { SCOPES } from '../version.ts';

export const TOKEN_URL = `https://${HOSTS.oauth}/token`;

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
  error_subtype?: string;
}

interface ErrorInfo {
  /** True when the token can never be refreshed again: the policy's 28-day clock starts (design v2 § 6.2). */
  definitive: boolean;
  fix: string;
}

/** Every OAuth error we expect, mapped to what the operator should do (API-10, CMP-19). */
export const OAUTH_ERRORS: Readonly<Record<string, ErrorInfo>> = {
  invalid_grant: {
    definitive: true,
    fix:
      'The sign-in is no longer valid: it was revoked at Google, expired after 7 days while the app was in Testing, was unused for 6 months, or was pushed out by the 100-token limit. Run "creatorlens auth --profile <profile>" in your Terminal. Until then nothing syncs, and the data is purged 28 days after the last good refresh.',
  },
  invalid_rapt: {
    definitive: true,
    fix: 'Google requires you to sign in again (a re-authentication policy). Run "creatorlens auth --profile <profile>".',
  },
  invalid_client: {
    definitive: true,
    fix: 'Google does not recognise the OAuth client (wrong file, rotated secret or deleted client). Download the Desktop app client JSON again and run "creatorlens setup --client-json <file>".',
  },
  deleted_client: {
    definitive: true,
    fix: 'The OAuth client was deleted (Google deletes clients unused for 6 months; they can be restored within 30 days in Google Auth Platform → Clients). Restore it, or create a new Desktop app client and run "creatorlens setup".',
  },
  unauthorized_client: {
    definitive: true,
    fix: 'The client is not allowed this grant. Use a "Desktop app" client (docs/owner-setup.md, step 6).',
  },
  admin_policy_enforced: {
    definitive: true,
    fix: 'A Google Workspace administrator blocks this app or its scopes for this account.',
  },
  access_denied: { definitive: false, fix: 'Consent was declined, or not every requested scope was ticked. Run auth again and tick both.' },
  org_internal: { definitive: false, fix: 'The app\'s audience is "Internal". Set Audience to External in Google Auth Platform.' },
  redirect_uri_mismatch: { definitive: false, fix: 'The client is not a Desktop app client. Create a Desktop app client.' },
  invalid_request: { definitive: false, fix: 'Google rejected the request as malformed. Run "creatorlens doctor" and report the issue if it repeats.' },
  temporarily_unavailable: { definitive: false, fix: 'Google is temporarily unavailable. The next run retries.' },
};

export class OAuthError extends Error {
  readonly fix: string;
  readonly code: string;
  readonly subtype: string | undefined;
  readonly definitive: boolean;
  constructor(code: string, subtype: string | undefined, definitive: boolean, description?: string) {
    const info = OAUTH_ERRORS[subtype ?? ''] ?? OAUTH_ERRORS[code];
    const fix = info?.fix ?? 'Unexpected OAuth error. Run "creatorlens doctor".';
    super(`OAuth error ${code}${subtype ? `/${subtype}` : ''}${description ? ` (${description})` : ''}: ${fix}`);
    this.fix = fix;
    this.code = code;
    this.subtype = subtype;
    this.definitive = definitive;
  }
}

export function oauthErrorFrom(body: TokenResponse): OAuthError {
  const code = body.error ?? 'unknown_error';
  const subtype = body.error_subtype;
  const info = OAUTH_ERRORS[subtype ?? ''] ?? OAUTH_ERRORS[code];
  return new OAuthError(code, subtype, info?.definitive ?? false, body.error_description);
}

export interface RefreshResult {
  accessToken: string;
  expiresAt: Date;
  scopes: string[];
}

/** Exchanges a refresh token for an access token. The access token stays in memory only. */
export async function refreshAccessToken(
  http: GoogleHttp,
  client: ClientCreds,
  refreshToken: string,
  now: () => Date,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  }).toString();
  const res = await http.request('POST', TOKEN_URL, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    retry: true, // a refresh grant is idempotent
  });
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as TokenResponse;
  } catch {
    throw new HttpError(res.status, res.route.id, undefined, 'unreadable token response');
  }
  if (res.status !== 200 || !parsed.access_token) throw oauthErrorFrom(parsed);
  const scopes = (parsed.scope ?? '').split(/\s+/).filter(Boolean);
  const check = checkScopes(scopes);
  if (check.extra.length) throw new Error(`The token carries scopes creatorlens never asks for (${check.extra.join(', ')}); refused.`);
  return {
    accessToken: parsed.access_token,
    expiresAt: new Date(now().getTime() + Math.max(60, parsed.expires_in ?? 3600) * 1000),
    scopes,
  };
}

/** Compares granted scopes with the two requested ones, as sets (SEC-14). */
export function checkScopes(granted: readonly string[]): { ok: boolean; missing: string[]; extra: string[] } {
  const want = new Set<string>(SCOPES);
  const got = new Set(granted);
  const missing = [...want].filter((s) => !got.has(s));
  const extra = [...got].filter((s) => !want.has(s));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
