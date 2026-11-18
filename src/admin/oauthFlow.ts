// The installed-app sign-in (RFC 8252 loopback, PKCE S256), CLI only (design v2 § 4.3; SEC-14):
// - a listener on 127.0.0.1 on a random port (localhost may be firewalled or resolve to ::1);
// - a 32-byte state compared in constant time, code_challenge_method=S256 sent explicitly (Google defaults to plain);
// - exactly one matching callback: GET, the right Host header, the right state; a static no-store page; then closed;
// - the browser opened with /usr/bin/open only after the URL is checked to start with https://accounts.google.com/,
//   and the URL always printed;
// - the code exchanged once, never retried; access_type=offline and prompt=consent for a refresh token.

import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Exec } from '../util/exec.ts';
import type { GoogleHttp } from '../google/http.ts';
import { TOKEN_URL, oauthErrorFrom, type ClientCreds, type TokenResponse } from '../google/oauth.ts';
import { SCOPES } from '../version.ts';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function makeState(): string {
  return b64url(crypto.randomBytes(32));
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function authUrl(p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: p.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3em;max-width:40em"><h1>${title}</h1><p>${body}</p></body>`;

export class CallbackError extends Error {}

export interface Loopback {
  port: number;
  redirectUri: string;
  /** Resolves with the authorization code once one matching callback arrives. */
  code: Promise<string>;
  close(): void;
}

/** Starts the loopback listener. The caller builds the auth URL from `redirectUri`. */
export async function startLoopback(state: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<Loopback> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {});
  let done = false;
  const server = http.createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    const send = (status: number, title: string, body: string): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(PAGE(title, body));
    };
    if (done) return send(410, 'creatorlens', 'This sign-in has finished. You can close this tab.');
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}`) return send(400, 'creatorlens', 'Unexpected request.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/') return send(404, 'creatorlens', 'Not found.');
    const gotState = url.searchParams.get('state') ?? '';
    if (!safeEqual(gotState, state)) return send(400, 'creatorlens', 'This answer does not belong to the sign-in in progress.');
    done = true;
    const error = url.searchParams.get('error');
    if (error) {
      send(200, 'creatorlens: sign-in cancelled', 'Nothing was stored. You can close this tab and return to your Terminal.');
      rejectCode(oauthErrorFrom({ error }));
    } else {
      const c = url.searchParams.get('code');
      if (!c) {
        send(400, 'creatorlens', 'No authorization code in the answer.');
        rejectCode(new CallbackError('The answer carried no authorization code.'));
      } else {
        send(200, 'creatorlens: signed in', 'You can close this tab and return to your Terminal.');
        resolveCode(c);
      }
    }
    setImmediate(() => server.close());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      rejectCode(new CallbackError(`No answer from the browser within ${Math.round(timeoutMs / 60000)} minutes; nothing was stored.`));
      server.close();
    }
  }, timeoutMs);
  timer.unref();
  code.finally(() => clearTimeout(timer)).catch(() => {});
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}`,
    code,
    close: () => {
      done = true;
      clearTimeout(timer);
      server.close();
    },
  };
}

/** Opens the consent page in the default browser, only after checking where the URL goes. */
export async function openBrowser(exec: Exec, url: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!url.startsWith('https://accounts.google.com/')) throw new Error('Refusing to open a URL that is not Google’s sign-in page.');
  if (platform !== 'darwin') return false;
  const r = await exec('/usr/bin/open', [url], { timeoutMs: 15_000 });
  return r.code === 0;
}

/** Exchanges the authorization code for tokens. Never retried: a code works once. */
export async function exchangeCode(
  httpClient: GoogleHttp,
  client: ClientCreds,
  p: { code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  }).toString();
  const res = await httpClient.request('POST', TOKEN_URL, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    retry: false,
  });
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as TokenResponse;
  } catch {
    // fall through
  }
  if (res.status !== 200 || !parsed.access_token) throw oauthErrorFrom(parsed.error ? parsed : { error: `http_${res.status}` });
  return parsed;
}
