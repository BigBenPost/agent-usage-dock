import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { temporaryDirectory } from './temp';
import type { Config } from '../src/config';
import { renderBody } from '../src/panelHtml';
import { chartSvg, tooltipMarkdown } from '../src/tooltip';
import { Pricing } from '../src/pricing';
import { aggregate, LegacyBaseline, mergeLegacy } from '../src/reconcile';
import { parseStoreData, UsageStore } from '../src/store';
import { summarize } from '../src/summary';
import { emptyBucket, SessionRecord, TokenBucket, UsageRecord } from '../src/types';
import { isLegacy } from '../src/validation';

const MODEL = 'claude-sonnet-5-5';
const NOW = Date.parse('2026-11-24T12:00:00Z');
const cfg: Config = { dashboardTheme: 'light', timeZone: 'UTC', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', budgetLimit: 100, warningThreshold: 0.75, criticalThreshold: 0.9, pollIntervalSeconds: 60, correctionFactor: 1, rates: {} };

const bucket = (requests: number, output: number): TokenBucket => ({ ...emptyBucket(), requests, output });
const total = (day: string, requests: number, output: number) => ({ [day]: { claude: { [MODEL]: bucket(requests, output) } } });

function session(id: string, day: string, requests: number, output: number, over: Partial<SessionRecord> = {}): SessionRecord {
  const last = Date.parse(`${day}T10:00:00Z`);
  return { source: 'claude', id, first: last - 600_000, last, days: { [day]: { [MODEL]: bucket(requests, output) } }, ...over };
}

function request(id: string, ts: number, output: number, sessionId = 'a'): UsageRecord {
  return { id, source: 'claude', day: new Date(ts).toISOString().slice(0, 10), model: MODEL, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output }, session: sessionId, ts };
}

const OLD_STORE = {
  version: 1,
  days: { ...total('2026-10-20', 30, 3000), ...total('2026-10-21', 10, 1000) },
  sessions: {
    'claude:a': session('a', '2026-10-20', 10, 1000, { project: 'alpha' }),
    'claude:b': session('b', '2026-10-20', 20, 2000, { project: 'beta' }),
    'claude:c': session('c', '2026-10-21', 10, 1000),
  },
};

test('the sessions of an older store come in with its day totals, so a month whose logs are gone keeps its conversations', () => {
  const data = parseStoreData(JSON.stringify(OLD_STORE), 'old.json');
  assert.deepEqual(Object.keys(data.sessions!).sort(), ['claude:a', 'claude:b', 'claude:c']);
  const october = summarize(data, new Pricing(), NOW, '2026-10');
  assert.equal(october.sessions.length, 3, 'three conversations, not the one that a log still holds');
  assert.equal(october.totalRequests, 40);
  assert.equal(october.unattributed, 0, 'every request belongs to a session');
  assert.deepEqual(october.sessions.map((row) => [row.id, row.project, row.tokens.requests]).sort(), [['a', 'alpha', 10], ['b', 'beta', 20], ['c', undefined, 10]]);
});

test('a session of an older store that does not fit is left out, and the day totals still come in', () => {
  const crooked = { ...OLD_STORE, sessions: { ...OLD_STORE.sessions, 'claude:x': { ...OLD_STORE.sessions['claude:a'], id: 'other' }, 'claude:y': { ...OLD_STORE.sessions['claude:a'], source: 'mystery', id: 'y' } } };
  const data = parseStoreData(JSON.stringify(crooked), 'old.json');
  assert.deepEqual(Object.keys(data.legacy!.sessions!).sort(), ['claude:a', 'claude:b', 'claude:c']);
  assert.equal(summarize(data, new Pricing(), NOW, '2026-10').totalRequests, 40);
  const none = parseStoreData(JSON.stringify({ ...OLD_STORE, sessions: { 'claude:x': { ...OLD_STORE.sessions['claude:a'], id: 'other' } } }), 'old.json');
  assert.equal(none.legacy!.sessions, undefined, 'a baseline with no usable session carries none');
});

test('a request the logs still hold is not counted again, one the older store never saw is added', () => {
  const day = '2026-10-20';
  const snapshot = Date.parse(`${day}T10:00:00Z`);
  const legacy: LegacyBaseline = { days: total(day, 10, 1000), before: snapshot, sessions: { 'claude:a': session('a', day, 10, 1000, { project: 'alpha' }) } };
  const held = [1, 2, 3, 4].map((n) => request(`claude:m${n}`, snapshot - n * 1000, 100));
  const same = aggregate(Object.fromEntries(held.map((r) => [r.id, r])), legacy, [], true);
  assert.deepEqual(same.days[day].claude![MODEL].requests, 10, 'day totals: four held requests and six still only in the baseline');
  assert.equal(same.sessions['claude:a'].days[day][MODEL].requests, 10, 'the session likewise');
  assert.equal(same.sessions['claude:a'].days[day][MODEL].output, 1000);
  assert.equal(same.sessions['claude:a'].project, 'alpha', 'the baseline names the session when the records do not');

  const later = request('claude:m5', snapshot + 1000, 100);
  const grown = aggregate(Object.fromEntries([...held, later].map((r) => [r.id, r])), legacy, [], true);
  assert.equal(grown.days[day].claude![MODEL].requests, 11);
  assert.equal(grown.sessions['claude:a'].days[day][MODEL].requests, 11, 'a request after the snapshot is a new one');
  assert.equal(grown.sessions['claude:a'].first, snapshot - 600_000, 'the session starts where the baseline says it did');
  assert.equal(grown.sessions['claude:a'].last, snapshot + 1000, 'and ends with the newest request');
});

test('a session the baseline holds beside records of other sessions stays, and a hidden one does not', () => {
  const day = '2026-10-20';
  const snapshot = Date.parse(`${day}T10:00:00Z`);
  const legacy: LegacyBaseline = { days: total(day, 14, 1400), before: snapshot, sessions: { 'claude:a': session('a', day, 10, 1000), 'claude:z': session('z', day, 4, 400) } };
  const records = Object.fromEntries([request('claude:x1', snapshot - 1000, 100, 'x')].map((r) => [r.id, r]));
  const out = aggregate(records, legacy, [], true);
  assert.deepEqual(Object.keys(out.sessions).sort(), ['claude:a', 'claude:x', 'claude:z']);
  assert.equal(aggregate(records, legacy, ['claude:z'], true).sessions['claude:z'], undefined);
});

test('merging baselines merges their sessions: the larger count wins, labels follow the newer snapshot, and the order does not matter', () => {
  const day = '2026-10-20';
  const a: LegacyBaseline = { days: total(day, 5, 50), before: 1000, sessions: { 'claude:s1': session('s1', day, 5, 50, { project: 'old' }), 'claude:s2': session('s2', day, 1, 10) } };
  const newer = session('s1', day, 8, 80, { project: 'new', title: 'Named later', last: Date.parse(`${day}T11:00:00Z`) });
  newer.days['2026-10-21'] = { [MODEL]: bucket(1, 10) };
  const b: LegacyBaseline = { days: {}, before: 2000, sessions: { 'claude:s1': newer, 'claude:s3': session('s3', day, 2, 20) } };
  const merged = mergeLegacy(a, b)!;
  assert.deepEqual(merged.days, a.days, 'a baseline with sessions only adds no days');
  assert.equal(merged.before, a.before);
  assert.deepEqual(Object.keys(merged.sessions!), ['claude:s1', 'claude:s2', 'claude:s3']);
  assert.equal(merged.sessions!['claude:s1'].days[day][MODEL].requests, 8);
  assert.equal(merged.sessions!['claude:s1'].days['2026-10-21'][MODEL].requests, 1);
  assert.equal(merged.sessions!['claude:s1'].project, 'new');
  assert.equal(merged.sessions!['claude:s1'].title, 'Named later');
  assert.equal(merged.sessions!['claude:s1'].last, newer.last);
  assert.deepEqual(mergeLegacy(merged, b), merged, 'merging a snapshot again changes nothing');
  assert.deepEqual(mergeLegacy(b, a)!.sessions, merged.sessions, 'either order gives the same sessions');
  assert.deepEqual(mergeLegacy(a, { days: {}, before: 2000 }), a, 'no sessions on one side leaves the other as it was');
});

test('a baseline with sessions is only valid when every session is one and its key says which', () => {
  const ok = { days: {}, before: 1, sessions: { 'claude:a': session('a', '2026-10-20', 1, 1) } };
  assert.ok(isLegacy(ok));
  const broken: [string, (value: any) => void][] = [
    ['a key that does not name the session', (value) => { value.sessions['claude:b'] = value.sessions['claude:a']; }],
    ['a source the store does not know', (value) => { value.sessions['claude:a'].source = 'mystery'; }],
    ['an invalid day', (value) => { value.sessions['claude:a'].days = { '2026-02-30': { [MODEL]: bucket(1, 1) } }; }],
    ['a negative count', (value) => { value.sessions['claude:a'].days['2026-10-20'][MODEL].output = -1; }],
    ['a time that is not a number', (value) => { value.sessions['claude:a'].last = 'late'; }],
    ['a time that is no date', (value) => { value.sessions['claude:a'].last = 1.7e18; }],
    ['a time before 1970', (value) => { value.sessions['claude:a'].first = -1; }],
    ['a dangerous key', (value) => { value.sessions = JSON.parse('{"__proto__":{"source":"claude","id":"a","first":1,"last":1,"days":{}}}'); }],
  ];
  for (const [name, damage] of broken) {
    const copy = structuredClone(ok);
    damage(copy);
    assert.equal(isLegacy(copy), false, name);
  }
});

test('the sessions survive a reload, a second import of the same file, a later snapshot, and recovery from the archive alone', async () => {
  const root = await temporaryDirectory('legacy-sessions-'), file = path.join(root, 'usage-v3.json');
  const input = path.join(root, 'old.json'), later = path.join(root, 'later.json');
  await fs.writeFile(input, JSON.stringify(OLD_STORE));
  let store = await UsageStore.load(file);
  await store.absorb(input);
  await store.absorb(input);
  store = await UsageStore.load(file);
  assert.equal(Object.keys(store.data.sessions!).length, 3);
  assert.equal(Object.keys(store.data.legacy!.sessions!).length, 3);

  const grown = session('a', '2026-10-20', 12, 1200, { project: 'alpha', last: Date.parse('2026-10-20T10:30:00Z') });
  await fs.writeFile(later, JSON.stringify({ version: 3, records: {}, days: {}, files: {}, legacy: { days: {}, before: NOW, sessions: { 'claude:a': grown } } }));
  await store.absorb(later);
  store = await UsageStore.load(file);
  assert.equal(store.data.sessions!['claude:a'].days['2026-10-20'][MODEL].requests, 12, 'a later snapshot of a session replaces the earlier one');
  assert.equal(Object.keys(store.data.sessions!).length, 3, 'and adds no session');
  assert.equal(summarize(store.data, new Pricing(), NOW, '2026-10').totalRequests, 40, 'the day totals are those of the first import');

  await fs.rm(file);
  store = await UsageStore.recover(file, () => assert.fail('a missing store is not a corrupt one'));
  assert.equal(Object.keys(store.data.sessions!).length, 3);
  assert.equal(store.data.sessions!['claude:a'].days['2026-10-20'][MODEL].requests, 12);
});

test('a baseline keeps its session totals beside it on disk, so a build that rebuilds the baseline cannot take them along', async () => {
  const root = await temporaryDirectory('legacy-apart-'), file = path.join(root, 'usage-v3.json'), input = path.join(root, 'old.json');
  await fs.writeFile(input, JSON.stringify(OLD_STORE));
  let store = await UsageStore.load(file);
  await store.absorb(input);
  for (const name of [file, path.join(root, 'archive', 'history-ledger-v3.json')]) {
    const written = JSON.parse(await fs.readFile(name, 'utf8'));
    assert.deepEqual(Object.keys(written.legacy).sort(), ['before', 'days'], `${path.basename(name)}: the baseline is what an older build knows`);
    assert.deepEqual(Object.keys(written.legacySessions).sort(), ['claude:a', 'claude:b', 'claude:c'], path.basename(name));
  }
  store = await UsageStore.load(file);
  assert.deepEqual(Object.keys(store.data.legacy!.sessions!).sort(), ['claude:a', 'claude:b', 'claude:c'], 'and in memory they are part of it again');
  assert.equal((store.data as unknown as Record<string, unknown>).legacySessions, undefined);
  assert.equal(Object.keys(store.data.sessions!).length, 3);
});

test('a ledger written before the totals were kept apart is read, and written the new way at the next save', async () => {
  const root = await temporaryDirectory('legacy-inside-'), file = path.join(root, 'usage-v3.json');
  const baseline = { days: OLD_STORE.days, before: NOW, sessions: OLD_STORE.sessions };
  await fs.writeFile(file, JSON.stringify({ version: 3, records: {}, days: {}, files: {}, legacy: baseline }));
  const store = await UsageStore.load(file);
  assert.equal(Object.keys(store.data.sessions!).length, 3);
  store.markDirty();
  await store.save();
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(written.legacy.sessions, undefined);
  assert.equal(Object.keys(written.legacySessions).length, 3);
});

test('totals kept apart that are not session totals refuse the store, and the archive', async () => {
  const root = await temporaryDirectory('legacy-bad-'), file = path.join(root, 'usage-v3.json');
  await fs.writeFile(file, JSON.stringify({ version: 3, records: {}, days: {}, files: {}, legacySessions: { 'claude:a': { source: 'claude', id: 'b', first: 1, last: 2, days: {} } } }));
  await assert.rejects(UsageStore.load(file), /legacySessions/);
  await fs.rm(file);
  const store = await UsageStore.load(file);
  store.data.legacy = { days: {}, before: NOW };
  store.markDirty();
  await store.save();
  const archive = path.join(root, 'archive', 'history-ledger-v3.json');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, JSON.stringify({ version: 3, updatedAt: new Date(NOW).toISOString(), days: {}, records: {}, legacySessions: { 'claude:a': { nonsense: true } } }));
  await assert.rejects(UsageStore.recover(file, () => undefined), /session totals/);
});

test('the conversation count is a floor when requests belong to no session, and the average counts only what is in sessions', () => {
  const day = '2026-10-21';
  const first = Date.parse(`${day}T09:00:00Z`);
  const part = (id: string, requests: number, output: number): SessionRecord => ({ source: 'antigravity', id, first, last: first + 60_000, days: { [day]: { 'gemini-1.5-flash': bucket(requests, output) } } });
  const render = (days: number, sessions: Record<string, SessionRecord>): string => renderBody(summarize({ days: { [day]: { antigravity: { 'gemini-1.5-flash': bucket(days, days * 1000) } } }, sessions, firstDay: day }, new Pricing(), Date.parse(`${day}T12:00:00Z`)), cfg);

  const partial = render(100, { 'antigravity:p': part('p', 10, 10_000), 'antigravity:q': part('q', 10, 10_000) });
  assert.match(partial, /<div class="stat" title="At least this many: 80 requests of the month belong to no recorded conversation[^"]*"><dt>CONVERSATIONS<\/dt><dd>2\+ <small>avg 10\.0k<\/small><\/dd>/);
  assert.match(partial, /or they carry no conversation id\./);

  const whole = render(20, { 'antigravity:p': part('p', 10, 10_000), 'antigravity:q': part('q', 10, 10_000) });
  assert.match(whole, /<div class="stat"><dt>CONVERSATIONS<\/dt><dd>2 <small>avg 10\.0k<\/small><\/dd>/);

  const summary = summarize({ days: { [day]: { antigravity: { 'gemini-1.5-flash': bucket(100, 100_000) } } }, sessions: { 'antigravity:p': part('p', 10, 10_000), 'antigravity:q': part('q', 10, 10_000) }, firstDay: day }, new Pricing(), Date.parse(`${day}T12:00:00Z`));
  assert.match(tooltipMarkdown(summary, cfg, { dark: false, chart: false }), /2\+ conversations · avg 10k/, 'the status bar hover says what the page says');
  assert.match(chartSvg(summary, cfg, false), /2\+ conversations · avg 10k/);
  const all = summarize({ days: { [day]: { antigravity: { 'gemini-1.5-flash': bucket(20, 20_000) } } }, sessions: { 'antigravity:p': part('p', 10, 10_000), 'antigravity:q': part('q', 10, 10_000) }, firstDay: day }, new Pricing(), Date.parse(`${day}T12:00:00Z`));
  assert.match(tooltipMarkdown(all, cfg, { dark: false, chart: false }), /2 conversations · avg 10k/);

  const untracked = renderBody(summarize({ days: { [day]: { antigravity: { 'gemini-1.5-flash': bucket(5, 5000) } } }, firstDay: day }, new Pricing(), Date.parse(`${day}T12:00:00Z`)), cfg);
  assert.match(untracked, /<dt>CONVERSATIONS<\/dt><dd>–<\/dd>/, 'before the sessions are built there is no count to show');
});
