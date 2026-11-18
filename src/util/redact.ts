// One redaction function for everything that leaves the process as text: logs, sync_log.error, tool errors, doctor
// output (design v2, SEC-16). Access tokens live in memory only; this is the second line.

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ya29\.[A-Za-z0-9_\-.~+/]+=*/g, 'ya29.[REDACTED]'],
  [/1\/\/0[A-Za-z0-9_\-.~+/]+/g, '1//0[REDACTED]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]'],
  [/GOCSPX-[A-Za-z0-9_-]+/g, 'GOCSPX-[REDACTED]'],
  [
    /\b(code|code_verifier|refresh_token|access_token|id_token|client_secret|token)=([^&\s"']+)/gi,
    '$1=[REDACTED]',
  ],
  [
    /("(?:code|code_verifier|refresh_token|access_token|id_token|client_secret|token|secret)"\s*:\s*")[^"]*(")/gi,
    '$1[REDACTED]$2',
  ],
  [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(x-goog-api-key\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/(b64:)[A-Za-z0-9+/=]{8,}/g, '$1[REDACTED]'],
];

export function redact(input: string): string {
  let s = input;
  for (const [re, repl] of RULES) s = s.replace(re, repl);
  return s;
}

/** The message of any thrown value, redacted and cut to a sane length. */
export function errorText(e: unknown, max = 2000): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e);
  const s = redact(raw ?? String(e));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
