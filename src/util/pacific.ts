// YouTube's days are Pacific-time days (America/Los_Angeles, with daylight saving), not the owner's local days (CMP-9).
// A Short published at 08:00 in Israel goes out at 22:00 Pacific the day before.

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The Pacific calendar day of an instant, as YYYY-MM-DD. */
export function pacificDay(d: Date): string {
  return dayFmt.format(d);
}

/** The UTC instant at which the Pacific day after `d` begins (00:00 Pacific). */
export function nextPacificMidnight(d: Date): Date {
  const [y, m, day] = pacificDay(d).split('-').map(Number) as [number, number, number];
  for (const offsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, day + 1, offsetHours));
    if (hourFmt.format(candidate) === '00' && pacificDay(candidate) !== pacificDay(d)) return candidate;
  }
  // Unreachable for America/Los_Angeles; fall back to 08:00 UTC.
  return new Date(Date.UTC(y, m - 1, day + 1, 8));
}

/** Whole days from Pacific day `a` to Pacific day `b` (both YYYY-MM-DD). */
export function daysBetweenDays(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86_400_000);
}
