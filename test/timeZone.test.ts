import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderSessionDetail } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { summarize } from '../src/summary';
import { DISPLAY_ZONES, isDisplayZone, stamp } from '../src/timeZone';
import { DayRecord, emptyBucket, SessionRecord, TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg: Config = normalizeConfig({ budgetLimit: 100 });
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const days: Record<string, DayRecord> = { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } };

const session = (first: string, last: string): SessionRecord => ({
  source: 'antigravity',
  id: 's1',
  project: 'proj',
  first: Date.parse(first),
  last: Date.parse(last),
  days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e6) } },
});

const body = (zone: Config['timeZone'], rec: SessionRecord): string => renderBody(summarize({ days, sessions: { 'antigravity:s1': rec } }, new Pricing(), NOW), { ...cfg, timeZone: zone });

test('a time is shown in the zone: Singapore is eight hours ahead of UTC, and the date moves with the clock', () => {
  const t = Date.parse('2026-10-21T20:30:00Z');
  assert.equal(stamp(t, 'UTC'), '10-21 20:30');
  assert.equal(stamp(t, 'SGT'), '10-22 04:30');
  assert.equal(stamp(Date.parse('2026-12-31T16:00:00Z'), 'SGT'), '01-01 00:00', 'across a year end');
  assert.deepEqual(Object.keys(DISPLAY_ZONES), ['UTC', 'SGT']);
});

test('only the two zones are accepted, from the settings or from the page', () => {
  for (const ok of ['UTC', 'SGT']) assert.equal(isDisplayZone(ok), true);
  for (const bad of ['JST', 'jst', 'PST', '', '__proto__', 'toString', 'constructor', 9, null, undefined, {}]) assert.equal(isDisplayZone(bad), false, String(bad));
  assert.equal(normalizeConfig({ timeZone: 'JST' }).timeZone, 'SGT', 'a setting saved while JST existed falls back to the default');
  assert.equal(normalizeConfig({ timeZone: 'Asia/Tokyo' }).timeZone, 'SGT');
  assert.equal(normalizeConfig({}).timeZone, 'SGT');
});

test('session cards read in the chosen zone, with the date where the clock crosses midnight', () => {
  const rec = session('2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z');
  assert.match(body('UTC', rec), /10-21 09:00 → 10:00/);
  assert.match(body('SGT', rec), /10-21 17:00 → 18:00/);
  const late = session('2026-10-21T20:00:00Z', '2026-10-21T22:00:00Z');
  assert.match(body('SGT', late), /10-22 04:00 → 06:00/);
  assert.match(body('UTC', late), /10-21 20:00 → 22:00/);
  const across = session('2026-10-21T14:00:00Z', '2026-10-21T17:00:00Z');
  assert.match(body('SGT', across), /10-21 22:00 → 10-22 01:00/);
});

test('the zone switch sits under the session count with the current zone marked, and each button says what the zone is', () => {
  const html = body('SGT', session('2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z'));
  const group = html.match(/<div class="zonebar">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  assert.match(group, /Times in /);
  assert.match(group, /<button type="button" data-focus="zone-UTC" data-zone="UTC" aria-pressed="false" title="UTC">UTC<\/button>/);
  assert.match(group, /<button type="button" data-focus="zone-SGT" data-zone="SGT" aria-pressed="true" title="Singapore time, UTC\+8" class="active">SGT<\/button>/);
  assert.doesNotMatch(group, /JST/);
});

test('the header names the whole billing month and says it is UTC, whatever zone times are shown in', () => {
  for (const zone of ['UTC', 'SGT'] as const) {
    const html = body(zone, session('2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z'));
    assert.match(html, /<div class="sub">Oct 1 – Oct 31 · billing cycle UTC<\/div>/, zone);
    assert.match(html, /Daily spend \(UTC\)/);
  }
  assert.match(renderBody(summarize({ days: { '2026-02-10': { antigravity: { 'gemini-1.5-flash': bucket(1) } } }, sessions: {} }, new Pricing(), NOW, '2026-02'), cfg), /Feb 1 – Feb 28 · billing cycle UTC · priced at the current rates/);
});

test('the session popup shows its start and last activity in the zone, and its days stay UTC', () => {
  const rec = session('2026-10-21T20:00:00Z', '2026-10-21T22:30:00Z');
  const detail = buildSessionDetail('antigravity:s1', rec, new Pricing(), '2026-10');
  const sgt = renderSessionDetail(detail, 'SGT');
  assert.match(sgt, /<div class="eyebrow">Started<\/div><div class="d-mid">10-22 04:00<\/div><div class="sub">SGT<\/div>/);
  assert.match(sgt, /<div class="eyebrow">Last active<\/div><div class="d-mid">10-22 06:30<\/div><div class="sub">2h 30m after start<\/div>/);
  assert.match(sgt, /<td>2026-10-21<\/td>/, 'the billing day is still the UTC day');
  assert.match(sgt, /By day \(UTC\)/);
  assert.match(renderSessionDetail(detail), /<div class="d-mid">10-21 20:00<\/div><div class="sub">UTC<\/div>/);
});
