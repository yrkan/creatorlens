import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUntrusted, wrapUntrusted, escapeForTerminal, TEXT_LIMITS } from '../src/util/text.ts';
import { redact, errorText } from '../src/util/redact.ts';
import { csvShape } from '../src/util/csv.ts';
import { pacificDay, nextPacificMidnight, daysBetweenDays } from '../src/util/pacific.ts';
import { fakeAccessToken, fakeClientSecret, fakeRefreshToken } from './helpers/fakeGoogle.ts';

test('strangers’ text: NFC, controls, bidi, zero-width, tag characters and smuggled selectors are removed', () => {
  const tag = String.fromCodePoint(0xe0049, 0xe0067, 0xe006e); // invisible "Ign" in tag characters
  const vs = String.fromCodePoint(0xe0100, 0xe0101); // variation selector supplement payload
  const input = `é ok‮evil​⁦x⁩\u0007${tag}${vs}﻿ end`;
  const r = cleanUntrusted(input);
  assert.equal(r.text, 'é okevilx end');
  assert.equal(r.cleaned, true);
  assert.equal(r.cut, false);
});

test('strangers’ text: a run of emoji presentation selectors is kept as one, never at the start', () => {
  assert.equal(cleanUntrusted('️️a❤️️️').text, 'a❤️');
});

test('strangers’ text: cut by code points with a marker; comments 500, descriptions 1000', () => {
  const long = '😀'.repeat(600);
  const r = cleanUntrusted(long, TEXT_LIMITS.comment);
  assert.equal(r.cut, true);
  assert.equal(Array.from(r.text.replace('…[cut]', '')).length, 500);
  assert.equal(TEXT_LIMITS.description, 1000);
  assert.deepEqual(wrapUntrusted('hello'), { untrusted: 'hello' });
});

test('terminal printer escapes ESC, OSC 52, bidi and zero-width characters', () => {
  const s = escapeForTerminal('a\u001b]52;c;ZXZpbA==\u0007b‮c​d');
  assert.ok(!/[\u001b\u0007‮​]/.test(s));
  assert.match(s, /\\u\{1b\}/);
  assert.match(s, /\\u\{202e\}/);
  assert.equal(escapeForTerminal('x\ny', true), 'x\ny');
  assert.equal(escapeForTerminal('x\ny'), 'x\\u{a}y');
});

test('redaction masks tokens, keys, secrets and auth headers', () => {
  const refresh = fakeRefreshToken();
  const access = fakeAccessToken();
  const secret = fakeClientSecret();
  const key = ['AI', 'za', 'SyntheticKey0123456789abcdefghij'].join('');
  const text = `refresh=${refresh} ${access} ${secret} ${key} Authorization: Bearer ${access} code=4/abc&code_verifier=xyz "refresh_token": "${refresh}" x-goog-api-key: ${key}`;
  const out = redact(text);
  for (const s of [refresh, access, secret, key, '4/abc', 'xyz']) assert.ok(!out.includes(s), `leaked ${s}`);
  assert.ok(errorText(new Error(`boom ${access}`)).includes('ya29.[REDACTED]'));
});

test('CSV shape: header, rows, quoted commas and newlines, header-only, BOM, CRLF', () => {
  assert.deepEqual(csvShape('a,b\n1,2\n3,4\n'), { header: ['a', 'b'], rows: 2 });
  assert.deepEqual(csvShape('﻿a,b\r\n"x, y","multi\nline"\r\n'), { header: ['a', 'b'], rows: 1 });
  assert.deepEqual(csvShape('date,views\n'), { header: ['date', 'views'], rows: 0 });
  assert.deepEqual(csvShape('date,term\n20261117,"контейнер ""20"""\n20261117,konteyner 🚢\n'), { header: ['date', 'term'], rows: 2 });
  assert.throws(() => csvShape('a\n"unterminated'));
});

test('Pacific days: an Israeli morning is the Pacific day before; DST switches; next midnight', () => {
  assert.equal(pacificDay(new Date('2026-11-20T06:00:00Z')), '2026-11-19'); // 08:00 in Israel
  assert.equal(pacificDay(new Date('2026-11-20T08:00:00Z')), '2026-11-20');
  assert.equal(pacificDay(new Date('2026-07-01T06:59:00Z')), '2026-06-30'); // PDT, UTC-7
  assert.equal(pacificDay(new Date('2026-07-01T07:00:00Z')), '2026-07-01');
  assert.equal(nextPacificMidnight(new Date('2026-11-20T10:00:00Z')).toISOString(), '2026-11-21T08:00:00.000Z');
  assert.equal(nextPacificMidnight(new Date('2026-07-01T10:00:00Z')).toISOString(), '2026-07-02T07:00:00.000Z');
  // The day DST ends (2026-11-01 has 25 hours in Los Angeles).
  assert.equal(nextPacificMidnight(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(daysBetweenDays('2026-11-15', '2026-11-20'), 5);
});
