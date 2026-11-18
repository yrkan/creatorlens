// The closed route table: every request creatorlens can make, by method, host, path and caller (design v2 § 4.3;
// SEC-5, API-9, CMP-13). Anything not listed is refused before it is sent. There is no www.googleapis.com.
//
// These are the core routes, usable by the CLI and by the MCP server (`serve`). The three routes that change state at
// Google (POST /revoke, POST and DELETE on Reporting jobs) are not here: they live in src/admin/routes.ts, a module the
// server never imports (test/importGraph.test.ts), and are marked cli-only besides.

export type Caller = 'serve' | 'cli';
export type Method = 'GET' | 'POST' | 'DELETE';

export interface Route {
  id: string;
  method: Method;
  host: string;
  path: RegExp;
  callers: readonly Caller[];
  /** How the request is authenticated: an access token, the OAuth client (token endpoint), or nothing. */
  credential: 'bearer' | 'client' | 'none';
  /** A report download: may follow a redirect, but only to a media route of this table. */
  media?: boolean;
}

export const HOSTS = {
  oauth: 'oauth2.googleapis.com',
  data: 'youtube.googleapis.com',
  analytics: 'youtubeanalytics.googleapis.com',
  reporting: 'youtubereporting.googleapis.com',
} as const;

const BOTH: readonly Caller[] = ['serve', 'cli'];

export const CORE_ROUTES: readonly Route[] = [
  { id: 'oauth.token', method: 'POST', host: HOSTS.oauth, path: /^\/token$/, callers: BOTH, credential: 'client' },
  { id: 'data.channels.list', method: 'GET', host: HOSTS.data, path: /^\/youtube\/v3\/channels$/, callers: BOTH, credential: 'bearer' },
  {
    id: 'data.playlistItems.list',
    method: 'GET',
    host: HOSTS.data,
    path: /^\/youtube\/v3\/playlistItems$/,
    callers: BOTH,
    credential: 'bearer',
  },
  { id: 'data.videos.list', method: 'GET', host: HOSTS.data, path: /^\/youtube\/v3\/videos$/, callers: BOTH, credential: 'bearer' },
  {
    id: 'analytics.reports.query',
    method: 'GET',
    host: HOSTS.analytics,
    path: /^\/v2\/reports$/,
    callers: BOTH,
    credential: 'bearer',
  },
  {
    id: 'reporting.reportTypes.list',
    method: 'GET',
    host: HOSTS.reporting,
    path: /^\/v1\/reportTypes$/,
    callers: BOTH,
    credential: 'bearer',
  },
  { id: 'reporting.jobs.list', method: 'GET', host: HOSTS.reporting, path: /^\/v1\/jobs$/, callers: BOTH, credential: 'bearer' },
  {
    id: 'reporting.jobs.reports.list',
    method: 'GET',
    host: HOSTS.reporting,
    path: /^\/v1\/jobs\/[A-Za-z0-9_-]{1,200}\/reports$/,
    callers: BOTH,
    credential: 'bearer',
  },
  {
    id: 'reporting.media.download',
    method: 'GET',
    host: HOSTS.reporting,
    path: /^\/v1\/media\/[A-Za-z0-9_\-./%]{1,900}$/,
    callers: BOTH,
    credential: 'bearer',
    media: true,
  },
];

export function matchRoute(routes: readonly Route[], method: Method, url: URL, caller: Caller): Route | undefined {
  return routes.find(
    (r) => r.method === method && r.host === url.hostname && r.path.test(url.pathname) && r.callers.includes(caller),
  );
}
