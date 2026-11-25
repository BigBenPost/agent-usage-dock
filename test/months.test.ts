import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { pinnedMonth, summarize } from '../src/summary';
import { DayRecord, emptyBucket, SessionRecord, TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg: Config = { dashboardTheme: 'light', timeZone: 'UTC', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', budgetLimit: 100, warningThreshold: 0.75, criticalThreshold: 0.9, pollIntervalSeconds: 60, correctionFactor: 1, rates: {} };

const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const cost = (output: number): number => new Pricing().quote({ source: 'antigravity', model: 'gemini-1.5-flash', tokens: bucket(output) }).cost ?? NaN;

const days: Record<string, DayRecord> = {
  '2026-09-29': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } },
  '2026-09-30': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } },
  '2026-10-01': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } },
  '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(2e6) } },
};

const at = (iso: string): number => Date.parse(`${iso}T09:00:00Z`);
const near = (actual: number | undefined, expected: number): void => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

function session(id: string, spans: Record<string, number>): SessionRecord {
  const dayKeys = Object.keys(spans).sort();
  return {
    source: 'antigravity',
    id,
    project: id,
    first: at(dayKeys[0]),
    last: at(dayKeys[dayKeys.length - 1]),
    days: Object.fromEntries(dayKeys.map((d) => [d, { 'gemini-1.5-flash': bucket(spans[d]) }])),
  };
}

const sessions: Record<string, SessionRecord> = {
  'antigravity:sep': session('sep', { '2026-09-29': 1e6 }),
  'antigravity:span': session('span', { '2026-09-30': 1e6, '2026-10-01': 1e6 }),
  'antigravity:oct': session('oct', { '2026-10-21': 2e6 }),
};

const input = { days, sessions, firstDay: '2026-09-29' };
const page = (month?: string, over: Partial<Config> = {}): string => renderBody(summarize(input, new Pricing(), NOW, month), { ...cfg, ...over });

test('a past month is priced from its own days, with every day elapsed and no today', () => {
  const s = summarize(input, new Pricing(), NOW, '2026-09');
  assert.equal(s.month, '2026-09');
  assert.equal(s.isCurrent, false);
  assert.equal(s.daysInMonth, 30);
  assert.equal(s.dayOfMonth, 30);
  assert.equal(s.todayTotal, 0);
  near(s.total, 2 * cost(1e6));
  assert.deepEqual(s.days.map((d) => d.day), ['2026-09-30', '2026-09-29']);
});

test('a session that spans two months is listed in both', () => {
  const sep = summarize(input, new Pricing(), NOW, '2026-09');
  const oct = summarize(input, new Pricing(), NOW);
  assert.deepEqual(sep.sessions.map((r) => r.key).sort(), ['antigravity:sep', 'antigravity:span']);
  assert.deepEqual(oct.sessions.map((r) => r.key).sort(), ['antigravity:oct', 'antigravity:span']);
});

test('the present month stays the default', () => {
  const s = summarize(input, new Pricing(), NOW);
  assert.equal(s.isCurrent, true);
  assert.equal(s.month, '2026-10');
  assert.equal(s.dayOfMonth, 21);
  assert.deepEqual(s.months, ['2026-09', '2026-10']);
});

test('only a listed past month pins the dashboard; anything else follows the present month', () => {
  const months = ['2026-08', '2026-09', '2026-10'];
  assert.equal(pinnedMonth('2026-09', months, '2026-10'), '2026-09');
  assert.equal(pinnedMonth('current', months, '2026-10'), undefined);
  assert.equal(pinnedMonth('2026-10', months, '2026-10'), undefined);
});

test('the header has a month switcher', () => {
  const html = page();
  assert.match(html, /data-menu="month"/);
  assert.match(html, /data-month-select/);
});
