import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { temporaryDirectory } from './temp';
import { cursorRecords, isCursorLedger } from '../src/cursorLedger';
import { Pricing } from '../src/pricing';
import { InvalidStoreError, parseStoreData, UsageStore } from '../src/store';
import { groupModels, summarize } from '../src/summary';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const T = (iso: string): number => Date.parse(iso);

/** `[time, model, input, output, cache read, cache write, cents charged, cents of list value, conversation]` */
type Event = [number, string, number, number, number, number, number, number, string];
const event = (iso: string, model: string, tokens: [number, number, number, number], conversation = '', cents: [number, number] = [5, 8]): Event =>
  [T(iso), model, ...tokens, ...cents, conversation];
const ledger = (events: Event[], extra: Record<string, unknown> = {}) => ({ version: 1, meta: { lastFetchAt: NOW }, events, daily: {}, cycle: { start: 0, end: 1 }, summary: {}, account: 'abc', ...extra });

const EVENTS: Event[] = [
  event('2026-10-21T06:09:06.800Z', 'claude-4.6-opus-max-thinking', [100, 50, 2000, 300], '3886207f9825'),
  event('2026-10-21T06:10:00.000Z', 'claude-4.6-opus-high-thinking', [10, 5, 200, 30], '3886207f9825'),
  event('2026-11-02T23:59:59.999Z', 'composer-2.5', [1000, 200, 5000, 0], ''),
  event('2026-11-03T00:00:00.000Z', 'default', [7, 3, 0, 0], 'a/b c'),
];

test('the usage ledger of Cursor is recognised by its events and by having no days or requests of its own', () => {
  assert.ok(isCursorLedger(ledger(EVENTS)));
  assert.ok(!isCursorLedger({ version: 1, days: {}, events: [] }), 'a store with days is a store');
  assert.ok(!isCursorLedger({ version: 3, records: {}, events: [] }));
  assert.ok(!isCursorLedger({ version: 2, events: [] }));
  assert.ok(!isCursorLedger({ version: 1 }));
  assert.ok(!isCursorLedger([]));
});

test('each event is a request of Cursor: UTC day, the tokens it used, the conversation as the session, the name Cursor wrote', () => {
  const records = cursorRecords(ledger(EVENTS));
  assert.equal(records.length, 4);
  const [first, , third, fourth] = records;
  assert.deepEqual({ ...first, id: undefined }, {
    id: undefined, source: 'cursor', day: '2026-10-21', model: 'claude-4.6-opus-max-thinking',
    tokens: { input: 100, cacheRead: 2000, cacheWrite: 300, cacheWrite1h: 0, output: 50 }, session: '3886207f9825', ts: T('2026-10-21T06:09:06.800Z'),
  });
  assert.equal(third.day, '2026-11-02', 'the last millisecond of a UTC day is still that day');
  assert.equal(records[3].day, '2026-11-03');
  assert.equal('session' in third, false, 'an event with no conversation belongs to no session');
  assert.equal('session' in fourth, false, 'and neither does one whose conversation id could not name a session');
  assert.equal(fourth.model, 'default');
  assert.ok(records.every((r) => !('evidence' in r)), 'no provenance is invented');
});

test('a request keeps its id wherever it sits in the file, and identical requests are told apart by a counter', () => {
  const same = event('2026-11-05T10:00:00.000Z', 'composer-2.5', [10, 2, 30, 0], 'c1');
  const ids = cursorRecords(ledger([...EVENTS, same, same, same])).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  const reversed = cursorRecords(ledger([same, same, same, ...[...EVENTS].reverse()])).map((r) => r.id);
  assert.deepEqual([...reversed].sort(), [...ids].sort(), 'the same requests have the same ids in any order');
  const revised = cursorRecords(ledger([event('2026-11-05T10:00:00.000Z', 'composer-2.5', [10, 2, 30, 0], 'c1', [99, 99])]))[0];
  assert.equal(revised.id, cursorRecords(ledger([same]))[0].id, 'what Cursor charged is not part of the id');
  const filled = cursorRecords(ledger([event('2026-11-05T10:00:00.000Z', 'composer-2.5', [10, 2, 30, 0], '')]))[0];
  assert.equal(filled.id, revised.id, 'nor is the conversation, which older events lack');
});

test('an event that cannot be read stops the import and is named', () => {
  for (const [bad, why] of [
    [[1, 'm', 1, 2]], [[T('2026-11-05T10:00:00Z'), '', 1, 2, 3, 4, 5, 6, '']], [[-1, 'm', 1, 2, 3, 4, 5, 6, '']],
    [[1e18, 'm', 1, 2, 3, 4, 5, 6, '']], [[T('2026-11-05T10:00:00Z'), 'm', -1, 2, 3, 4, 5, 6, '']], [[T('2026-11-05T10:00:00Z'), 'm', 1.5, 2, 3, 4, 5, 6, '']],
    ['text'],
  ] as [unknown[], string?][]) {
    const events = [EVENTS[0], bad as unknown as Event];
    assert.throws(() => cursorRecords({ events }), /^Error: event 2 /, JSON.stringify(bad));
    assert.throws(() => parseStoreData(JSON.stringify(ledger(events)), 'cursor.json'), (error: unknown) => error instanceof InvalidStoreError && /not a usage ledger of Cursor: event 2 /.test(error.message), JSON.stringify(why));
  }
});

test('importing the ledger adds its requests to the working ledger and its archive, and importing it again, or a later version of it, adds only what is new', async () => {
  const root = await temporaryDirectory('cursor-import-'), file = path.join(root, 'usage-v3.json'), input = path.join(root, 'cursor.json');
  await fs.writeFile(input, JSON.stringify(ledger(EVENTS)));
  let store = await UsageStore.load(file);
  await store.absorb(input);
  assert.equal(Object.keys(store.data.records).length, 4);
  await store.absorb(input);
  assert.equal(Object.keys(store.data.records).length, 4, 'the same file again adds nothing');

  const later = [...EVENTS, event('2026-11-10T08:00:00.000Z', 'gemini-4-argon-high', [5, 5, 5, 0], 'c2'), event('2026-11-11T08:00:00.000Z', 'composer-2.5', [1, 1, 1, 0], 'c2')];
  await fs.writeFile(input, JSON.stringify(ledger(later)));
  await store.absorb(input);
  assert.equal(Object.keys(store.data.records).length, 6, 'a later version adds the two new requests');
  await fs.writeFile(input, JSON.stringify(ledger(later.slice(2))));
  await store.absorb(input);
  assert.equal(Object.keys(store.data.records).length, 6, 'a version that has forgotten the oldest requests does not take them away');

  store = await UsageStore.load(file);
  assert.equal(Object.keys(store.data.records).length, 6, 'and it is what is on disk');
  const archive = JSON.parse(await fs.readFile(path.join(root, 'archive', 'history-ledger-v3.json'), 'utf8'));
  assert.equal(Object.keys(archive.records).length, 6);
  await fs.rm(file);
  store = await UsageStore.recover(file, () => assert.fail('a missing store is not a corrupt one'));
  assert.equal(Object.keys(store.data.records).length, 6, 'the archive alone brings them back');
});

test('the requests of Cursor are priced, grouped with the same model in other tools and listed as conversations', async () => {
  const root = await temporaryDirectory('cursor-month-'), file = path.join(root, 'usage-v3.json'), input = path.join(root, 'cursor.json');
  await fs.writeFile(input, JSON.stringify(ledger([
    event('2026-11-02T10:00:00.000Z', 'claude-4.6-opus-high-thinking', [1_000_000, 100_000, 0, 0], 'c1'),
    event('2026-11-03T10:00:00.000Z', 'claude-4.6-opus-max-thinking', [0, 1_000_000, 0, 0], 'c1'),
    event('2026-11-03T11:00:00.000Z', 'composer-2.5', [1_000_000, 0, 0, 0], ''),
  ])));
  const store = await UsageStore.load(file);
  await store.absorb(input);
  const claude = { id: 'claude:x', source: 'claude' as const, day: '2026-11-04', model: 'claude-opus-4-6', session: 's1', ts: T('2026-11-04T10:00:00Z'), tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 } };
  store.add(claude);
  const month = summarize(store.data, new Pricing({ 'claude-opus-4*': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 } }), NOW);
  assert.equal(month.bySource.cursor.toFixed(2), '33.00', '1M input and 1.1M output of Opus at $5 and $25, and 1M input of Composer at $0.50');
  assert.equal(month.unpriced.length, 0);
  const opus = groupModels(month.models).find((m) => m.model === 'claude-opus-4-6')!;
  assert.deepEqual(opus.sources, ['claude', 'cursor']);
  assert.equal(opus.tokens.requests, 3);
  assert.deepEqual(month.sessions.map((s) => [s.key, s.tokens.requests]).sort(), [['claude:s1', 1], ['cursor:c1', 2]]);
  assert.deepEqual(month.recorded, ['claude', 'cursor']);
});
