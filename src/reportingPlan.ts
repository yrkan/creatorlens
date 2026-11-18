// Which Reporting jobs a channel should have (design v2 § 4.4; CMP-5, API-7, CMP-14): one job for every report type
// the channel is offered, except system-managed ones, at the newest version of each family that is not deprecated.
// A type being deprecated keeps its job while its successor's job is created beside it, so both overlap.

import type { Job, ReportType } from './google/api.ts';

export function familyOf(id: string): { family: string; version: number } {
  const m = /^(.*)_a(\d+)$/.exec(id);
  return m ? { family: m[1]!, version: Number(m[2]) } : { family: id, version: 0 };
}

export interface JobPlan {
  /** The type id wanted for each family. */
  wanted: string[];
  /** Wanted types that have no job yet. */
  create: string[];
  /** Wanted types that have a job. */
  covered: string[];
  /** Types with a deprecation date that still carry a job: their successor is in `create` or `covered`. */
  deprecating: Array<{ reportTypeId: string; deprecateTime: string; successor: string | null }>;
  /** Jobs Google will end within 30 days. */
  expiring: Array<{ jobId: string; reportTypeId: string; expireTime: string }>;
}

function isDeprecated(t: ReportType, now: Date): boolean {
  return Boolean(t.deprecateTime && Date.parse(t.deprecateTime) <= now.getTime());
}

export function planJobs(types: readonly ReportType[], jobs: readonly Job[], now: Date): JobPlan {
  const usable = types.filter((t) => !t.systemManaged && /^[a-z0-9_]{1,100}$/.test(t.id));
  const byFamily = new Map<string, ReportType[]>();
  for (const t of usable) {
    const { family } = familyOf(t.id);
    byFamily.set(family, [...(byFamily.get(family) ?? []), t]);
  }
  const wanted: string[] = [];
  for (const list of byFamily.values()) {
    const sorted = [...list].sort((a, b) => familyOf(b.id).version - familyOf(a.id).version);
    const active = sorted.filter((t) => !isDeprecated(t, now));
    // Prefer the newest version with no deprecation date; else the newest one not yet deprecated.
    const pick = active.find((t) => !t.deprecateTime) ?? active[0];
    if (pick) wanted.push(pick.id);
  }
  wanted.sort();
  const activeJobs = jobs.filter((j) => !j.systemManaged);
  const jobTypes = new Set(activeJobs.map((j) => j.reportTypeId));
  const create = wanted.filter((t) => !jobTypes.has(t));
  const covered = wanted.filter((t) => jobTypes.has(t));
  const deprecating: JobPlan['deprecating'] = [];
  for (const t of usable) {
    if (t.deprecateTime && jobTypes.has(t.id)) {
      const fam = familyOf(t.id).family;
      const successor = wanted.find((w) => familyOf(w).family === fam && w !== t.id) ?? null;
      deprecating.push({ reportTypeId: t.id, deprecateTime: t.deprecateTime, successor });
    }
  }
  const soon = now.getTime() + 30 * 86_400_000;
  const expiring = activeJobs
    .filter((j) => j.expireTime && Date.parse(j.expireTime) <= soon)
    .map((j) => ({ jobId: j.id, reportTypeId: j.reportTypeId, expireTime: j.expireTime! }));
  return { wanted, create, covered, deprecating, expiring };
}
