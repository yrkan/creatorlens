// A fake of Google's endpoints for tests: it answers the requests creatorlens makes, records every one of them, and
// knows nothing about the network. All ids are synthetic: channels start with "UCzz", videos with "zz"
// (test/hygiene.test.ts holds that no real id appears anywhere).

import zlib from 'node:zlib';

export const CHANNEL_ID = 'UCzzSYNTHETICchannel0001';
export const OTHER_CHANNEL_ID = 'UCzzSYNTHETICchannel0002';
export const SCOPE_RO = 'https://www.googleapis.com/auth/youtube.readonly';
export const SCOPE_ARO = 'https://www.googleapis.com/auth/yt-analytics.readonly';

/** Secrets are built at run time, so no literal in this repository matches a secret scanner's rule. */
export function fakeRefreshToken(tag = 'a'): string {
  return ['1', '//0', 'SYNTHETICrefresh', tag, 'x'.repeat(30)].join('');
}
export function fakeAccessToken(tag = 'a'): string {
  return ['ya', '29.', 'SYNTHETICaccess', tag, 'y'.repeat(20)].join('');
}
export function fakeClientSecret(): string {
  return ['GOC', 'SPX-', 'SYNTHETICsecret0000000000000'].join('');
}

export interface Recorded {
  method: string;
  url: URL;
  authorization: string | null;
  body: string | undefined;
  redirect: string | undefined;
}

export interface FakeReport {
  id: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  jobExpireTime?: string;
  downloadUrl: string;
}

export interface FakeJob {
  id: string;
  reportTypeId: string;
  name?: string;
  createTime?: string;
  expireTime?: string;
  systemManaged?: boolean;
}

type TokenAnswer = { status: number; body: Record<string, unknown> };

export class FakeGoogle {
  readonly requests: Recorded[] = [];
  channel: { id: string; title: string; handle: string; uploads: string } | null = {
    id: CHANNEL_ID,
    title: 'Synthetic Channel',
    handle: '@synthetic',
    uploads: 'UUzzSYNTHETICchannel0001',
  };
  videos: Array<{ id: string; title: string; publishedAt: string; duration: string }> = [
    { id: 'zzVideo0001', title: 'First synthetic Short', publishedAt: '2026-11-10T14:00:00Z', duration: 'PT31S' },
    { id: 'zzVideo0002', title: 'Second synthetic Short', publishedAt: '2026-11-12T14:00:00Z', duration: 'PT45S' },
  ];
  reportTypes: Array<{ id: string; name: string; deprecateTime?: string; systemManaged?: boolean }> = [
    { id: 'channel_basic_a3', name: 'User activity' },
    { id: 'channel_basic_a2', name: 'User activity (old)', deprecateTime: '2025-10-31T00:00:00Z' },
    { id: 'channel_traffic_source_a3', name: 'Traffic sources' },
    { id: 'channel_reach_basic_a1', name: 'Reach basic' },
    { id: 'channel_subtitles_a3', name: 'Subtitles' },
  ];
  jobs: FakeJob[] = [];
  reports = new Map<string, FakeReport[]>();
  media = new Map<string, { status?: number; body?: Buffer; location?: string; rawGzip?: boolean }>();
  /** Scopes the token endpoint grants. */
  grantedScopes = `${SCOPE_RO} ${SCOPE_ARO}`;
  /** Queue of forced token answers (an error such as invalid_grant), consumed first. */
  tokenQueue: TokenAnswer[] = [];
  refreshTokenExpiresIn: number | undefined;
  disabledApis = new Set<'data' | 'analytics' | 'reporting'>();
  revoked: string[] = [];
  private jobSeq = 0;

  /** A report file for a job and a Pacific day, with a synthetic CSV. */
  addReport(job: FakeJob, day: string, opts: { createTime?: string; rows?: string[]; header?: string; id?: string } = {}): FakeReport {
    const start = `${day}T08:00:00Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace('.000Z', 'Z');
    const id = opts.id ?? `rep${job.id}${day.replace(/-/g, '')}${(opts.createTime ?? '').replace(/\D/g, '').slice(-4)}`;
    const path = `/v1/media/CHANNEL/${CHANNEL_ID}/jobs/${job.id}/reports/${id}`;
    const r: FakeReport = {
      id,
      jobId: job.id,
      startTime: start,
      endTime: end,
      createTime: opts.createTime ?? `${day}T23:00:00Z`,
      jobExpireTime: new Date(Date.parse(start) + 60 * 86_400_000).toISOString(),
      downloadUrl: `https://youtubereporting.googleapis.com${path}?alt=media`,
    };
    const header = opts.header ?? 'date,channel_id,video_id,live_or_on_demand,subscribed_status,country_code,views,engaged_views';
    const rows = opts.rows ?? [`${day.replace(/-/g, '')},${CHANNEL_ID},zzVideo0001,on_demand,unsubscribed,US,12,9`];
    this.media.set(path, { body: Buffer.from([header, ...rows].join('\n') + '\n') });
    this.reports.set(job.id, [...(this.reports.get(job.id) ?? []), r]);
    return r;
  }

  addJob(reportTypeId: string, createTime = '2026-11-01T00:00:00Z', name?: string): FakeJob {
    const job: FakeJob = { id: `job${++this.jobSeq}${reportTypeId.replace(/_/g, '')}`, reportTypeId, createTime, name: name ?? `creatorlens en ${reportTypeId}` };
    this.jobs.push(job);
    return job;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  private disabled(api: 'data' | 'analytics' | 'reporting'): Response {
    return this.json(403, { error: { code: 403, message: `API ${api} has not been used or is disabled`, errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED' } });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.requests.push({ method, url, authorization: headers.get('authorization'), body, redirect: init?.redirect });
    const res = this.route(method, url, headers, body);
    if (res.status >= 300 && res.status < 400 && init?.redirect === 'error') throw new TypeError('fetch failed: redirect mode is error');
    return res;
  };

  private needAuth(headers: Headers): boolean {
    return !(headers.get('authorization') ?? '').startsWith('Bearer ya29.');
  }

  private route(method: string, url: URL, headers: Headers, body: string | undefined): Response {
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') {
      const forced = this.tokenQueue.shift();
      if (forced) return this.json(forced.status, forced.body);
      const form = new URLSearchParams(body ?? '');
      const grant = form.get('grant_type');
      const answer: Record<string, unknown> = { access_token: fakeAccessToken(grant ?? 'g'), expires_in: 3599, token_type: 'Bearer', scope: this.grantedScopes };
      if (grant === 'authorization_code') {
        answer.refresh_token = fakeRefreshToken('new');
        if (this.refreshTokenExpiresIn) answer.refresh_token_expires_in = this.refreshTokenExpiresIn;
      }
      return this.json(200, answer);
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke' && method === 'POST') {
      this.revoked.push(new URLSearchParams(body ?? '').get('token') ?? '');
      return new Response('', { status: 200 });
    }
    if (url.hostname === 'youtube.googleapis.com') {
      if (this.disabledApis.has('data')) return this.disabled('data');
      if (this.needAuth(headers)) return this.json(401, { error: { code: 401, errors: [{ reason: 'authError' }] } });
      if (url.pathname === '/youtube/v3/channels') {
        const c = this.channel;
        return this.json(200, {
          items: c ? [{ id: c.id, snippet: { title: c.title, customUrl: c.handle, publishedAt: '2026-11-01T00:00:00Z', country: 'IL' }, contentDetails: { relatedPlaylists: { uploads: c.uploads } } }] : [],
        });
      }
      if (url.pathname === '/youtube/v3/playlistItems') {
        if (this.videos.length === 0) return this.json(404, { error: { code: 404, errors: [{ reason: 'playlistNotFound' }] } });
        return this.json(200, { items: this.videos.map((v) => ({ contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt } })) });
      }
      if (url.pathname === '/youtube/v3/videos') {
        const ids = (url.searchParams.get('id') ?? '').split(',');
        return this.json(200, {
          items: this.videos
            .filter((v) => ids.includes(v.id))
            .map((v) => ({
              id: v.id,
              snippet: { title: v.title, description: 'Synthetic description', tags: ['synthetic'], publishedAt: v.publishedAt, categoryId: '27', defaultLanguage: 'en', defaultAudioLanguage: 'en', liveBroadcastContent: 'none' },
              contentDetails: { duration: v.duration },
              status: { privacyStatus: 'public', madeForKids: false },
            })),
        });
      }
    }
    if (url.hostname === 'youtubeanalytics.googleapis.com' && url.pathname === '/v2/reports') {
      if (this.disabledApis.has('analytics')) return this.disabled('analytics');
      if (this.needAuth(headers)) return this.json(401, { error: { code: 401 } });
      return this.json(200, { kind: 'youtubeAnalytics#resultTable', columnHeaders: [{ name: 'views' }], rows: [[1]] });
    }
    if (url.hostname === 'youtubereporting.googleapis.com') {
      if (this.disabledApis.has('reporting')) return this.disabled('reporting');
      if (this.needAuth(headers)) return this.json(401, { error: { code: 401 } });
      if (url.pathname === '/v1/reportTypes' && method === 'GET') return this.json(200, { reportTypes: this.reportTypes });
      if (url.pathname === '/v1/jobs' && method === 'GET') return this.json(200, { jobs: this.jobs });
      if (url.pathname === '/v1/jobs' && method === 'POST') {
        const req = JSON.parse(body ?? '{}') as { reportTypeId: string; name: string };
        const job = this.addJob(req.reportTypeId, '2026-11-20T10:00:00Z', req.name);
        return this.json(200, job);
      }
      const del = /^\/v1\/jobs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (del && method === 'DELETE') {
        this.jobs = this.jobs.filter((j) => j.id !== del[1]);
        return this.json(200, {});
      }
      const rep = /^\/v1\/jobs\/([A-Za-z0-9_-]+)\/reports$/.exec(url.pathname);
      if (rep && method === 'GET') return this.json(200, { reports: this.reports.get(rep[1]!) ?? [] });
      const m = this.media.get(url.pathname);
      if (m) {
        if (m.location) return new Response(null, { status: 302, headers: { location: m.location } });
        if (m.status && m.status !== 200) return new Response('', { status: m.status });
        const b = m.rawGzip ? zlib.gzipSync(m.body ?? Buffer.alloc(0)) : (m.body ?? Buffer.alloc(0));
        return new Response(b, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
    }
    return this.json(404, { error: { code: 404, message: `fake has no ${method} ${url.hostname}${url.pathname}` } });
  }
}
