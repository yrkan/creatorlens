/** True when version `v` (with or without a leading "v") is at least `min` (major.minor.patch). */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.replace(/^v/, '').split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}
