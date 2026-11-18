// Typed read-only calls to the three APIs, over GoogleHttp. Each GET costs what the quota table says and is recorded in
// the project ledger. A 401 refreshes the access token once; a 403 quotaExceeded marks the bucket spent until the next
// Pacific midnight (API-22).

import { HttpError, type GoogleHttp } from './http.ts';
import { HOSTS } from './routes.ts';
import type { QuotaLedger, Bucket } from './quota.ts';

export interface ChannelInfo {
  id: string;
  title: string;
  handle: string | null;
  country: string | null;
  publishedAt: string | null;
  uploadsPlaylistId: string | null;
}

export interface VideoInfo {
  id: string;
  title: string | null;
  description: string | null;
  tags: string[];
  publishedAt: string | null;
  categoryId: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  liveBroadcastContent: string | null;
  durationS: number | null;
  privacyStatus: string | null;
  madeForKids: boolean | null;
}

export interface ReportType {
  id: string;
  name?: string;
  deprecateTime?: string;
  systemManaged?: boolean;
}

export interface Job {
  id: string;
  reportTypeId: string;
  name?: string;
  createTime?: string;
  expireTime?: string;
  systemManaged?: boolean;
}

export interface Report {
  id: string;
  jobId: string;
  startTime: string;
  endTime: string;
  createTime: string;
  jobExpireTime?: string;
  downloadUrl: string;
}

export type TokenSource = (forceRefresh?: boolean) => Promise<string>;

export class QuotaExhausted extends Error {
  readonly bucket: Bucket;
  readonly until: string;
  constructor(bucket: Bucket, until: string) {
    super(`The ${bucket} quota is spent until ${until} (Google's quotaExceeded).`);
    this.bucket = bucket;
    this.until = until;
  }
}

const DATA = `https://${HOSTS.data}/youtube/v3`;
const ANALYTICS = `https://${HOSTS.analytics}/v2`;
const REPORTING = `https://${HOSTS.reporting}/v1`;

/** ISO 8601 duration (PT1M2S) to seconds. */
export function parseDuration(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
}

export class GoogleApi {
  private readonly http: GoogleHttp;
  private readonly token: TokenSource;
  private readonly quota: QuotaLedger | undefined;
  private readonly onMediaHost: ((host: string) => void) | undefined;
  constructor(http: GoogleHttp, token: TokenSource, quota?: QuotaLedger, onMediaHost?: (host: string) => void) {
    this.http = http;
    this.token = token;
    this.quota = quota;
    this.onMediaHost = onMediaHost;
  }

  private async get<T>(url: string, bucket: Bucket, units: number): Promise<T> {
    const until = this.quota?.exhaustedUntil(bucket);
    if (until) throw new QuotaExhausted(bucket, until);
    let token = await this.token();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await this.http.json<T>('GET', url, { accessToken: token });
        this.quota?.spend(bucket, units);
        return out;
      } catch (e) {
        if (e instanceof HttpError) {
          this.quota?.spend(bucket, units);
          if (e.status === 401 && attempt === 0) {
            token = await this.token(true);
            continue;
          }
          if (e.status === 403 && (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded')) {
            this.quota?.markExhausted(bucket);
            throw new QuotaExhausted(bucket, this.quota?.exhaustedUntil(bucket) ?? 'the next Pacific midnight');
          }
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  /** The channel of the signed-in account (channels.list mine=true, 1 unit). null when the account has no channel. */
  async channelMine(): Promise<ChannelInfo | null> {
    const q = new URLSearchParams({ part: 'snippet,contentDetails', mine: 'true', maxResults: '5' });
    const res = await this.get<{ items?: Array<Record<string, any>> }>(`${DATA}/channels?${q}`, 'data', 1);
    const items = res.items ?? [];
    if (items.length === 0) return null;
    if (items.length > 1) throw new Error('channels.list mine=true returned more than one channel; refused.');
    const it = items[0]!;
    return {
      id: String(it.id),
      title: String(it.snippet?.title ?? ''),
      handle: it.snippet?.customUrl ? String(it.snippet.customUrl) : null,
      country: it.snippet?.country ? String(it.snippet.country) : null,
      publishedAt: it.snippet?.publishedAt ? String(it.snippet.publishedAt) : null,
      uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ? String(it.contentDetails.relatedPlaylists.uploads) : null,
    };
  }

  /** The ids in the uploads playlist (1 unit a page of 50). An empty or missing playlist gives []. */
  async uploads(playlistId: string, maxPages = 40): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ part: 'contentDetails', playlistId, maxResults: '50' });
      if (pageToken) q.set('pageToken', pageToken);
      let res: { items?: Array<Record<string, any>>; nextPageToken?: string };
      try {
        res = await this.get(`${DATA}/playlistItems?${q}`, 'data', 1);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) return ids; // playlistNotFound: no uploads yet (CMP-10)
        throw e;
      }
      for (const it of res.items ?? []) {
        const id = it.contentDetails?.videoId;
        if (typeof id === 'string') ids.push(id);
      }
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return ids;
  }

  /** Our own videos' metadata, 50 ids a call (1 unit each). Missing ids are deleted or unavailable videos. */
  async videos(ids: readonly string[]): Promise<VideoInfo[]> {
    const out: VideoInfo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const q = new URLSearchParams({ part: 'snippet,contentDetails,status', id: batch.join(','), maxResults: '50' });
      const res = await this.get<{ items?: Array<Record<string, any>> }>(`${DATA}/videos?${q}`, 'data', 1);
      for (const it of res.items ?? []) {
        out.push({
          id: String(it.id),
          title: it.snippet?.title ?? null,
          description: it.snippet?.description ?? null,
          tags: Array.isArray(it.snippet?.tags) ? it.snippet.tags.map(String) : [],
          publishedAt: it.snippet?.publishedAt ?? null,
          categoryId: it.snippet?.categoryId ?? null,
          defaultLanguage: it.snippet?.defaultLanguage ?? null,
          defaultAudioLanguage: it.snippet?.defaultAudioLanguage ?? null,
          liveBroadcastContent: it.snippet?.liveBroadcastContent ?? null,
          durationS: parseDuration(it.contentDetails?.duration),
          privacyStatus: it.status?.privacyStatus ?? null,
          madeForKids: typeof it.status?.madeForKids === 'boolean' ? it.status.madeForKids : null,
        });
      }
    }
    return out;
  }

  /** Report types available to this channel (system-managed ones are left out by the API's default). */
  async reportTypes(): Promise<ReportType[]> {
    return this.paged<ReportType>(`${REPORTING}/reportTypes`, 'reportTypes');
  }

  async jobs(): Promise<Job[]> {
    return this.paged<Job>(`${REPORTING}/jobs`, 'jobs');
  }

  async reports(jobId: string, createdAfter?: string): Promise<Report[]> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) throw new Error(`Unexpected job id: ${jobId}`);
    const extra = createdAfter ? { createdAfter } : undefined;
    return this.paged<Report>(`${REPORTING}/jobs/${jobId}/reports`, 'reports', extra);
  }

  private async paged<T>(base: string, key: string, extra?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams(extra);
      if (pageToken) q.set('pageToken', pageToken);
      const qs = q.toString();
      const res = await this.get<Record<string, unknown>>(qs ? `${base}?${qs}` : base, 'reporting', 1);
      const items = res[key];
      if (Array.isArray(items)) out.push(...(items as T[]));
      pageToken = typeof res.nextPageToken === 'string' ? res.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /** Downloads one report. The host is recorded; a host outside the download routes is refused by GoogleHttp. */
  async download(downloadUrl: string): Promise<{ body: Buffer; host: string }> {
    let token = await this.token();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http.request('GET', downloadUrl, {
        accessToken: token,
        headers: { 'accept-encoding': 'gzip' },
      });
      this.onMediaHost?.(res.finalHost);
      this.quota?.spend('reporting', 1);
      if (res.status === 401 && attempt === 0) {
        token = await this.token(true);
        continue;
      }
      if (res.status !== 200) throw new HttpError(res.status, res.route.id, undefined, res.body.toString('utf8').slice(0, 300));
      return { body: res.body, host: res.finalHost };
    }
    throw new Error('unreachable');
  }

  /** A one-day query that proves the Analytics API answers for this channel. The figures are not kept or shown. */
  async analyticsProbe(day: string): Promise<boolean> {
    const q = new URLSearchParams({ ids: 'channel==MINE', startDate: day, endDate: day, metrics: 'views' });
    await this.get<unknown>(`${ANALYTICS}/reports?${q}`, 'analytics', 1);
    return true;
  }
}
