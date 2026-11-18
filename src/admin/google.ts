// The state-changing calls, CLI only: create and delete Reporting jobs, revoke a token. None is ever retried.

import type { GoogleHttp } from '../google/http.ts';
import { HttpError } from '../google/http.ts';
import { HOSTS } from '../google/routes.ts';
import type { Job } from '../google/api.ts';

const JOBS = `https://${HOSTS.reporting}/v1/jobs`;

export async function createJob(http: GoogleHttp, accessToken: string, reportTypeId: string, name: string): Promise<Job> {
  if (!/^[a-z0-9_]{1,100}$/.test(reportTypeId)) throw new Error(`Unexpected report type id: ${reportTypeId}`);
  return http.json<Job>('POST', JOBS, {
    accessToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reportTypeId, name }),
    retry: false,
  });
}

export async function deleteJob(http: GoogleHttp, accessToken: string, jobId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) throw new Error(`Unexpected job id: ${jobId}`);
  await http.json<unknown>('DELETE', `${JOBS}/${jobId}`, { accessToken, retry: false });
}

/** Revokes a token at Google. The token travels in the form body, never in the URL. "Already invalid" counts as done. */
export async function revokeToken(http: GoogleHttp, token: string): Promise<'revoked' | 'already_invalid'> {
  const res = await http.request('POST', `https://${HOSTS.oauth}/revoke`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    retry: false,
  });
  if (res.status === 200) return 'revoked';
  const text = res.body.toString('utf8');
  if (res.status === 400 && /invalid_token/.test(text)) return 'already_invalid';
  throw new HttpError(res.status, res.route.id, undefined, text.slice(0, 200));
}
