import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { Pricing } from '../src/pricing';
import { rateChoices } from '../src/rateEdit';
import { aggregate, preferredRecord } from '../src/reconcile';
import { mergeData, UsageStore } from '../src/store';
import type { ModelRow } from '../src/summary';
import type { Tokens, UsageRecord } from '../src/types';
import { temporaryDirectory } from './temp';

const tokens = (over: Partial<Tokens> = {}): Tokens => ({ input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 5, ...over });
const at = (minute: number) => Date.UTC(2026, 10, 20, 1, minute);

const agy = (step: number, minute: number, title?: string, project?: string): UsageRecord => ({
  id: `antigravity:c1:${step}`, source: 'antigravity', session: 'c1', model: 'gemini-3.8-flash', day: '2026-11-20', ts: at(minute), title, project, tokens: tokens(),
  evidence: { kind: 'transcript', revision: 1, parserVersion: 3 },
});
const claude = (id: string, session: string | undefined, minute = 0, over: Partial<UsageRecord> = {}): UsageRecord => ({
  id: `claude:${id}`, source: 'claude', session, model: 'claude-sonnet-5-5', day: '2026-11-20', ts: at(minute), tokens: tokens(), ...over,
});

const ids = (records: UsageRecord[]) => Object.fromEntries(records.map(r => [r.id, r]));

test('records and sessions are ordered by code unit, not by the locale of the process', () => {
  const upper = claude('B1', 'upper'), lower = claude('a1', 'lower');
  assert.deepEqual(Object.keys(aggregate(ids([lower, upper])).sessions), ['claude:upper', 'claude:lower']);
  assert.deepEqual(Object.keys(aggregate(ids([upper, lower])).sessions), ['claude:upper', 'claude:lower']);
  const row = (model: string): ModelRow => ({ model, source: 'claude' } as ModelRow);
  const pricing = new Pricing();
  assert.deepEqual(rateChoices([row('a-model'), row('B-model'), row('_x'), row('Z')], pricing).map(c => c.label), ['B-model', 'Z', '_x', 'a-model']);
  assert.deepEqual(rateChoices([row('Z'), row('B-model'), row('_x'), row('a-model')], pricing).map(c => c.label), ['B-model', 'Z', '_x', 'a-model']);
});

test('a session takes its title and project from the latest record that has one, never from an empty string', () => {
  const sessions = (records: UsageRecord[]) => aggregate(ids(records)).sessions['antigravity:c1'];
  const first = sessions([agy(1, 1, '', ''), agy(2, 2, 'Refactor billing', 'proj'), agy(3, 3, 'Refactor billing', 'proj')]);
  assert.deepEqual([first.title, first.project], ['Refactor billing', 'proj']);
  const text = sessions([agy(10, 5, 'Latest', 'late'), agy(9, 1, 'Early', 'soon'), agy(8, 9, '', '')]);
  assert.deepEqual([text.title, text.project], ['Latest', 'late'], 'by time, not by id order');
  const renamed = sessions([agy(2, 1, 'Draft', 'one'), agy(1, 2, 'Final', undefined)]);
  assert.deepEqual([renamed.title, renamed.project], ['Final', 'one'], 'each follows its own latest record');
  const tied = sessions([agy(1, 4, 'Alpha', 'a'), agy(2, 4, 'Omega', 'z')]);
  assert.deepEqual([tied.title, tied.project], ['Omega', 'z'], 'the greater id wins a tie on time');
  const none = sessions([agy(1, 1, '', ''), agy(2, 2, undefined, undefined)]);
  assert.deepEqual([none.title, none.project], [undefined, undefined]);
});

test('equal-timestamp copies of a Claude message belong to the smaller session id, whichever copy came first or has more tokens', () => {
  const small = claude('m1', 'aaa', 3, { tokens: tokens({ output: 1 }), project: 'p-small' });
  const large = claude('m1', 'zzz', 3, { tokens: tokens({ output: 9 }), project: 'p-large' });
  for (const [a, b] of [[small, large], [large, small]]) {
    const merged = preferredRecord(a, b);
    assert.equal(merged.session, 'aaa');
    assert.equal(merged.project, 'p-small');
    assert.equal(merged.tokens.output, 9, 'the richer counters still win');
  }
  const upper = claude('m2', 'Zed', 3), lower = claude('m2', 'abc', 3);
  assert.equal(preferredRecord(upper, lower).session, 'Zed', 'by code unit, so upper case first');
  const earlier = claude('m3', 'zzz', 1), later = claude('m3', 'aaa', 2);
  assert.equal(preferredRecord(earlier, later).session, 'zzz', 'an earlier timestamp beats a smaller id');
  assert.equal(preferredRecord(claude('m4', undefined, 3), claude('m4', 'zzz', 3)).session, 'zzz', 'a missing session ranks last');
});

function generator(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(choices: T[]): T => choices[Math.floor(next() * choices.length)];
  const shuffle = <T>(items: T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  return { next, pick, shuffle };
}

/** Copies of requests as the collectors see them: streamed or resumed Claude messages, and Antigravity steps from a transcript and a database. */
function pool(random: ReturnType<typeof generator>): UsageRecord[] {
  const out: UsageRecord[] = [];
  const { pick } = random;
  for (let i = 0; i < 6; i++) {
    for (let copy = 0; copy < 1 + Math.floor(random.next() * 3); copy++) {
      const session = pick(['sa', 'sB', 'sc']);
      const minute = pick([1, 2, 2, 3]);
      out.push(claude(`msg_${pick(['a', 'B', 'c', 'd'])}${i % 3}`, session, minute, {
        project: `proj-${session}`, tokens: tokens({ input: pick([10, 11]), output: pick([1, 5, 5]), cacheRead: pick([0, 7]) }),
      }));
    }
  }
  for (let step = 1; step <= 4; step++) {
    for (let copy = 0; copy < 1 + Math.floor(random.next() * 3); copy++) {
      const database = random.next() < 0.5;
      out.push({
        ...agy(step, step, pick(['Plan', 'Plan v2', undefined, '']), pick(['repo', undefined])),
        model: database ? pick(['unknown-model', 'gemini-3.8-flash']) : pick(['gemini-3.8-flash', 'gemini-1.5-pro']),
        tokens: tokens({ input: pick([5, 6]), output: pick([1, 2]) }),
        evidence: { kind: database ? 'database' : 'transcript', revision: pick([0, 10, 20]), parserVersion: pick([2, 3]), rawModel: database ? 'enum:1' : 'raw' },
      });
    }
  }
  return out;
}

const shape = (store: Pick<UsageStore, 'data'>) => JSON.stringify({ records: Object.keys(store.data.records).sort().map(id => store.data.records[id]), days: store.data.days, sessions: store.data.sessions });

test('any arrival order, batching or merge direction gives the same days, sessions, titles and requests', async () => {
  const dir = await temporaryDirectory('determinism-');
  const fresh = (name: string) => UsageStore.load(path.join(dir, name));
  for (let seed = 1; seed <= 40; seed++) {
    const random = generator(seed);
    const copies = pool(random);
    const reference = await fresh('ref.json');
    reference.addRecords(copies);
    const expected = shape(reference);
    for (let round = 0; round < 3; round++) {
      const store = await fresh('again.json');
      const order = random.shuffle(copies);
      for (let i = 0; i < order.length;) { const n = 1 + Math.floor(random.next() * 5); store.addRecords(order.slice(i, i + n)); i += n; }
      assert.equal(shape(store), expected, `seed ${seed} round ${round}`);
    }
    const [a, b] = [await fresh('a.json'), await fresh('b.json')];
    const order = random.shuffle(copies);
    a.addRecords(order.slice(0, order.length >> 1));
    b.addRecords(order.slice(order.length >> 1));
    for (const merged of [mergeData(a.data, b.data), mergeData(b.data, a.data)]) assert.equal(shape({ data: merged }), expected, `seed ${seed} merge`);
  }
});
