// Time comes from a Clock so that the policy clocks can be tested on a fake one.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * HOUR_MS);
}

export function iso(d: Date): string {
  return d.toISOString();
}

/** Parses an ISO string; returns undefined for anything that is not a valid date. */
export function parseIso(s: string | null | undefined): Date | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t);
}

export function daysSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / DAY_MS;
}

/** A fake clock for tests: starts at `start` and moves only when told. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: string | Date) {
    this.t = typeof start === 'string' ? Date.parse(start) : start.getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceDays(days: number): void {
    this.t += days * DAY_MS;
  }
  advanceMs(ms: number): void {
    this.t += ms;
  }
  set(to: string | Date): void {
    this.t = typeof to === 'string' ? Date.parse(to) : to.getTime();
  }
}
