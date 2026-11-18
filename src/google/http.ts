// The only module that touches the network (design v2 § 4.3). Every request is checked against the closed route table
// before anything is sent: HTTPS only, an exact host, a listed path and method, a caller the route allows. Then:
// - no redirect is followed, except on a report download, and only to another download route of the table, with the
//   Authorization header never sent to a host other than the one it was meant for (SEC-5, API-27, GHSA-6prh-2h8m-c8cw);
// - the body is read with a byte cap, counted after decompression;
// - retries only for idempotent calls, on network errors, 429 and 5xx, honouring Retry-After; never for the code
//   exchange, jobs.create, jobs.delete or revoke;
// - no credential is sent when NODE_TLS_REJECT_UNAUTHORIZED=0 has turned certificate checks off (SEC-16);
// - `serve` sets a one-way read-only latch: afterwards only GET and the token refresh pass.
// URLs are logged without their query; tokens travel in headers and bodies only.

import { matchRoute, type Caller, type Method, type Route } from './routes.ts';
import { redact } from '../util/redact.ts';

export class RouteRefused extends Error {
  constructor(message: string) {
    super(`Request refused before sending: ${message}`);
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly routeId: string;
  readonly reason: string | undefined;
  readonly bodyText: string;
  constructor(status: number, routeId: string, reason: string | undefined, bodyText: string) {
    super(`Google answered ${status}${reason ? ` (${reason})` : ''} on ${routeId}: ${bodyText.slice(0, 300)}`);
    this.status = status;
    this.routeId = routeId;
    this.reason = reason;
    this.bodyText = bodyText;
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  route: Route;
  finalHost: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  accessToken?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Retry on network errors, 429 and 5xx. Off for non-idempotent calls. Default: on for GET, off otherwise. */
  retry?: boolean;
}

export interface HttpDeps {
  caller: Caller;
  routes: readonly Route[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export const JSON_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 256 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const MAX_REDIRECTS = 3;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class GoogleHttp {
  private latched = false;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;

  private readonly deps: HttpDeps;

  constructor(deps: HttpDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
    this.env = deps.env ?? process.env;
  }

  get caller(): Caller {
    return this.deps.caller;
  }

  /** One-way: after this only GET and the token refresh are allowed. */
  latchReadOnly(): void {
    this.latched = true;
  }

  get isLatched(): boolean {
    return this.latched;
  }

  /** Checks a request against the table without sending it. Throws RouteRefused. */
  check(method: Method, urlStr: string): { url: URL; route: Route } {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new RouteRefused('not a URL');
    }
    if (url.protocol !== 'https:') throw new RouteRefused(`${url.protocol} is not HTTPS`);
    if (url.username || url.password) throw new RouteRefused('credentials in the URL');
    if (url.port && url.port !== '443') throw new RouteRefused(`port ${url.port}`);
    const route = matchRoute(this.deps.routes, method, url, this.deps.caller);
    if (!route) throw new RouteRefused(`${method} ${url.hostname}${url.pathname} is not in the route table for ${this.deps.caller}`);
    if (this.latched && method !== 'GET' && route.id !== 'oauth.token') {
      throw new RouteRefused(`${route.id} after the read-only latch`);
    }
    return { url, route };
  }

  async request(method: Method, urlStr: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const { url, route } = this.check(method, urlStr);
    const carriesCredential = Boolean(opts.accessToken) || route.credential === 'client';
    if (carriesCredential && this.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      throw new RouteRefused('NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off; no credential is sent');
    }
    const retry = opts.retry ?? method === 'GET';
    const maxBytes = opts.maxBytes ?? (route.media ? MEDIA_MAX_BYTES : JSON_MAX_BYTES);
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.once(method, url, route, opts, maxBytes);
        if (retry && RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
          continue;
        }
        if (retry && res.status === 403 && attempt < MAX_ATTEMPTS && googleReason(res.body) === 'rateLimitExceeded') {
          await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
          continue;
        }
        return res;
      } catch (e) {
        if (e instanceof RouteRefused || e instanceof SizeExceeded) throw e;
        lastError = e;
        if (!retry || attempt >= MAX_ATTEMPTS) break;
        await this.sleep(this.backoff(attempt, null));
      }
    }
    throw new Error(`Network error on ${route.id}: ${redact(lastError instanceof Error ? lastError.message : String(lastError))}`);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 60_000);
    }
    return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
  }

  private async once(method: Method, url: URL, route: Route, opts: RequestOptions, maxBytes: number): Promise<HttpResponse> {
    let current = url;
    let currentRoute = route;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      // The access token goes only to the host of the route it was meant for.
      if (opts.accessToken && currentRoute.credential === 'bearer' && current.hostname === route.host) {
        headers.authorization = `Bearer ${opts.accessToken}`;
      }
      const started = Date.now();
      const res = await this.fetchImpl(current.toString(), {
        method,
        headers,
        body: opts.body,
        redirect: currentRoute.media ? 'manual' : 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? (currentRoute.media ? 120_000 : 30_000)),
      });
      this.log(`${method} ${current.hostname}${current.pathname} -> ${res.status} (${Date.now() - started} ms)`);
      if (currentRoute.media && res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new Error('A redirect without a Location header');
        const next = new URL(loc, current);
        const nextRoute = matchRoute(this.deps.routes, 'GET', next, this.deps.caller);
        if (!nextRoute?.media || next.protocol !== 'https:') {
          throw new RouteRefused(
            `a report download redirected to ${next.hostname}, which is not an allowed download host; nothing was sent there. Please report this host (README, "Report download host").`,
          );
        }
        current = next;
        currentRoute = nextRoute;
        continue;
      }
      const body = await readCapped(res, maxBytes);
      return { status: res.status, headers: res.headers, body, route: currentRoute, finalHost: current.hostname };
    }
    throw new Error('Too many redirects on a report download');
  }

  /** A JSON request; throws HttpError on anything but 2xx. */
  async json<T>(method: Method, url: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } });
    const text = res.body.toString('utf8');
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, res.route.id, googleReason(res.body), redact(text));
    }
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }
}

class SizeExceeded extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SizeExceeded(`The answer is larger than ${maxBytes} bytes; refused.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The `reason` of a Google API error body ({"error": {"errors": [{"reason": "quotaExceeded"}]}}), or the OAuth error. */
export function googleReason(body: Buffer | string): string | undefined {
  try {
    const j = JSON.parse(typeof body === 'string' ? body : body.toString('utf8')) as {
      error?: string | { errors?: Array<{ reason?: string }>; status?: string; details?: Array<{ reason?: string }> };
    };
    if (typeof j.error === 'string') return j.error;
    return j.error?.errors?.[0]?.reason ?? j.error?.details?.find((d) => d.reason)?.reason ?? j.error?.status;
  } catch {
    return undefined;
  }
}
