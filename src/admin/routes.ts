// The only requests that change state at Google: revoking a token and creating or deleting a Reporting job. They are
// cli-only, and this folder (src/admin/) is never imported by the MCP server: test/importGraph.test.ts walks the
// server's imports and fails if it reaches here. A Reporting job is persistent state in the owner's Google account, so
// creating one is the owner's act, in his Terminal, with a typed confirmation (design v2 § 4.4).

import { HOSTS, type Route } from '../google/routes.ts';

export const ADMIN_ROUTES: readonly Route[] = [
  { id: 'oauth.revoke', method: 'POST', host: HOSTS.oauth, path: /^\/revoke$/, callers: ['cli'], credential: 'none' },
  { id: 'reporting.jobs.create', method: 'POST', host: HOSTS.reporting, path: /^\/v1\/jobs$/, callers: ['cli'], credential: 'bearer' },
  {
    id: 'reporting.jobs.delete',
    method: 'DELETE',
    host: HOSTS.reporting,
    path: /^\/v1\/jobs\/[A-Za-z0-9_-]{1,200}$/,
    callers: ['cli'],
    credential: 'bearer',
  },
];
