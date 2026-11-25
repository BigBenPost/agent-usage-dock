import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Pricing } from '../src/pricing';
import { InvalidStoreError, mergeData, UsageStore } from '../src/store';
import { formatSpan, summarize, toCsv } from '../src/summary';
import { Tokens, UsageRecord } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');

function rec(id: string, output: number, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    source: 'antigravity',
    day: '2026-10-21',
    model: 'gemini-1.5-flash',
    tokens: { input: 1, cacheRead: 100, cacheWrite: 0, cacheWrite1h: 10, output },
    ...over,
  };
}

async function newStore(): Promise<{ store: UsageStore; file: string }> {
  const file = path.join(await temporaryDirectory('ai-usage-store-'), 'usage.json');
  return { store: await UsageStore.load(file), file };
}

const bucket = (store: UsageStore, day = '2026-10-21', model = 'gemini-1.5-flash') => store.data.days[day]?.antigravity?.[model];

test('streamed copies of a message count once, with the largest output', async () => {
  const { store } = await newStore();
  assert.equal(store.add(rec('m1', 10)), true);
  assert.equal(store.add(rec('m1', 50)), true);
  assert.equal(store.add(rec('m1', 20)), false);
  assert.equal(store.add(rec('m1', 50)), false);
  assert.deepEqual(bucket(store), { requests: 1, input: 1, cacheRead: 100, cacheWrite: 0, cacheWrite1h: 10, output: 50 });
});

test('a late final version updates a request without counting it twice', async () => {
  const { store } = await newStore();
  store.add(rec('m1', 50));
  assert.equal(store.add(rec('m1', 80)), true);
  assert.equal(bucket(store)?.output, 80);
  assert.equal(bucket(store)?.requests, 1);
});

test('old records are imported and their identities remain durable', async () => {
  const { store } = await newStore();
  assert.equal(store.add(rec('old', 5, { day: '2026-08-01' })), true);
  store.add(rec('m1', 5, { day: '2026-10-01' }));
  assert.deepEqual(Object.keys(store.data.records).sort(), ['m1', 'old']);
  assert.equal(bucket(store, '2026-10-01')?.output, 5);
});

test('store survives a save/load round trip', async () => {
  const { store, file } = await newStore();
  store.add(rec('m1', 5));
  store.data.files['/x.jsonl'] = { size: 3, mtimeMs: 4, offset: 3, model: 'gpt-6.1-sol' };
  await store.save();
  const loaded = await UsageStore.load(file);
  // JSON drops keys that are undefined in memory (a record without session info)
  assert.deepEqual(loaded.data, JSON.parse(JSON.stringify(store.data)));
  assert.equal(loaded.data.firstDay, '2026-10-21');
});

const tokens = (t: Partial<Tokens>): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, ...t });
const quoteCost = (pricing: Pricing, model: string, t: Tokens): number | undefined => {
  const quote = pricing.quote({ source: 'antigravity', model, tokens: t });
  return quote.unpriced ? undefined : quote.cost;
};

test('pricing matches default globs and leaves unknown models unpriced', () => {
  const pricing = new Pricing();
  const rate = pricing.rateFor('gemini-1.5-flash');
  assert.equal(rate?.output, 0.30);
  assert.equal(rate?.overridden, false);
  assert.equal(pricing.rateFor('mystery-model'), undefined);
  assert.equal(pricing.quote({ source: 'antigravity', model: 'mystery-model', tokens: tokens({ output: 1e6 }) }).unpriced, true);
});

test('pricing picks the most specific built-in entry', () => {
  const out = (model: string) => new Pricing().rateFor(model)?.output;
  assert.equal(out('gemini-1.5-flash'), 0.30);
  assert.equal(out('gemini-2.0-flash'), 0.40);
  assert.equal(out('gemini-1.5-pro'), 5.0);
  assert.equal(out('gemini-1.5-flash-8b'), 0.15);
  assert.equal(out('claude-3-5-sonnet-20241022'), 15);
  assert.equal(out('claude-3-5-haiku-20241022'), 4);
  assert.equal(out('claude-3-opus-20240229'), 75);
  assert.equal(out('gpt-4o'), 10);
  assert.equal(out('gpt-4o-mini'), 0.60);
  assert.equal(out('o1'), 60);
  assert.equal(out('o3-mini'), 4.40);
  assert.equal(out('unknown-model'), undefined);
});

test('pricing overrides merge over defaults and price new models', () => {
  const pricing = new Pricing({ 'gemini-1.5-flash': { output: 9 }, 'custom-model': { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 8 } }, 0.5);
  const r = pricing.rateFor('gemini-1.5-flash');
  assert.equal(r?.output, 9);
  assert.equal(r?.overridden, true);
  // cacheWrite1h falls back to cacheWrite when not set
  assert.equal(quoteCost(pricing, 'custom-model', tokens({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6, output: 1e6 })), (1 + 0.1 + 2 + 2 + 8) * 0.5);
});

test('a quote splits the cost by token type and the parts add up to the cost', () => {
  const pricing = new Pricing({ 'gemini-1.5-flash': { input: 1, cacheRead: 0.1, cacheWrite: 2, cacheWrite1h: 3, output: 8 } }, 0.5);
  const t = tokens({ input: 1e6, cacheRead: 2e6, cacheWrite: 1e6, cacheWrite1h: 1e6, output: 1e6 });
  const quote = pricing.quote({ source: 'antigravity', model: 'gemini-1.5-flash', tokens: t });
  assert.deepEqual(quote.breakdown, { input: 0.5, cacheRead: 0.1, cacheWrite: 1, cacheWrite1h: 1.5, output: 4 });
  assert.equal(quote.cost, 0.5 + 0.1 + 1 + 1.5 + 4);
  assert.equal(pricing.quote({ source: 'antigravity', model: 'mystery-model', tokens: t }).unpriced, true);
});

test('pricing ignores invalid override values', () => {
  const pricing = new Pricing({ 'gemini-1.5-flash': { output: -1, input: 'x' as unknown as number } });
  assert.equal(pricing.rateFor('gemini-1.5-flash')?.output, new Pricing().rateFor('gemini-1.5-flash')?.output);
});

test('summary prices only the current UTC month and lists unpriced models', async () => {
  const { store } = await newStore();
  store.add(rec('a', 1e6, { tokens: tokens({ output: 1e6 }) }));
  store.add(rec('b', 1e6, { day: '2026-09-30', tokens: tokens({ output: 1e6 }) }));
  store.add(rec('c', 1e6, { source: 'antigravity', model: 'mystery-model', tokens: tokens({ output: 1e6 }) }));
  const s = summarize(store.data, new Pricing(), NOW);
  assert.equal(s.month, '2026-10');
  assert.equal(s.dayOfMonth, 21);
  assert.equal(s.daysInMonth, 31);
  assert.equal(s.bySource.antigravity > 0, true);
  assert.deepEqual(s.unpriced, ['mystery-model']);
  assert.deepEqual(s.days.map((d) => d.day), ['2026-10-21']);
  assert.equal(s.firstDay, '2026-09-30');
});

test('daysInMonth follows the calendar, including February', () => {
  const at = (iso: string) => summarize({ days: {} }, new Pricing(), Date.parse(iso));
  assert.equal(at('2028-02-10T00:00:00Z').daysInMonth, 29);
  assert.equal(at('2027-02-10T00:00:00Z').daysInMonth, 28);
  assert.equal(at('2026-11-30T23:59:00Z').daysInMonth, 30);
  assert.equal(at('2026-11-30T23:59:00Z').dayOfMonth, 30);
});

test('csv export neutralises formula-like model names that an older store may hold', () => {
  // new records cannot carry such a name (the parsers and store.add rewrite it), but stored history from before could
  const days = { '2026-10-21': { antigravity: { '=cmd()': { requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1 } } } };
  assert.match(toCsv(days, new Pricing()), /2026-10-21,antigravity,'=cmd\(\),1,/);
});

test('mergeData unions requests without dropping disjoint records', async () => {
  const a = (await newStore()).store;
  const b = (await newStore()).store;
  a.add(rec('antigravity:a1', 5));
  a.add(rec('antigravity:a2', 5, { day: '2026-10-20' }));
  b.add(rec('antigravity:a1', 5));
  b.add(rec('antigravity:b2', 7));
  const merged = mergeData(a.data, b.data);
  assert.equal(merged.days['2026-10-21']?.antigravity?.['gemini-1.5-flash']?.requests, 2);
  assert.equal(merged.days['2026-10-20']?.antigravity?.['gemini-1.5-flash']?.requests, 1);
  assert.deepEqual(Object.keys(merged.records).sort(), ['antigravity:a2', 'antigravity:a1', 'antigravity:b2'].sort());
  assert.equal(merged.firstDay, '2026-10-20');
  assert.equal('seen' in merged || 'open' in merged, false);
});

test('transaction reloads under a lock so two stores on one file do not overwrite each other', async () => {
  const { store: s1, file } = await newStore();
  const s2 = await UsageStore.load(file);
  await Promise.all([
    s1.transaction(() => void s1.add(rec('antigravity:x', 5))),
    s2.transaction(() => void s2.add(rec('antigravity:y', 6))),
  ]);
  const final = await UsageStore.load(file);
  assert.equal(final.data.days['2026-10-21']?.antigravity?.['gemini-1.5-flash']?.requests, 2);
});

test('absorb merges a legacy store file and reports a missing one', async () => {
  const legacy = await newStore();
  legacy.store.add(rec('antigravity:old', 5, { day: '2026-10-12' }));
  await legacy.store.save();
  const { store } = await newStore();
  assert.equal(await store.absorb(legacy.file), true);
  assert.equal(store.data.firstDay, '2026-10-12');
  assert.equal(await store.absorb(`${legacy.file}.none`), false);
});

const inSession = (session: string, ts: string, output: number, over: Partial<UsageRecord> = {}) =>
  rec(`antigravity:${session}:${ts}`, output, { session, project: 'proj', ts: Date.parse(ts), tokens: tokens({ output }), ...over });

test('sessions total each session per day and model, alongside the day totals', async () => {
  const { store } = await newStore();
  store.add(inSession('s1', '2026-10-20T10:00:00Z', 10, { day: '2026-10-20' }));
  store.add(inSession('s1', '2026-10-21T09:00:00Z', 20));
  store.add(inSession('s1', '2026-10-21T09:05:00Z', 5, { model: 'gemini-flash-lite' }));
  store.add(inSession('s2', '2026-10-21T11:00:00Z', 7));
  const s1 = store.data.sessions?.['antigravity:s1'];
  assert.equal(s1?.project, 'proj');
  assert.equal(s1?.first, Date.parse('2026-10-20T10:00:00Z'));
  assert.equal(s1?.last, Date.parse('2026-10-21T09:05:00Z'));
  assert.equal(s1?.days['2026-10-20']?.['gemini-1.5-flash']?.output, 10);
  assert.equal(s1?.days['2026-10-21']?.['gemini-1.5-flash']?.output, 20);
  assert.equal(s1?.days['2026-10-21']?.['gemini-flash-lite']?.requests, 1);
  assert.equal(store.data.sessions?.['antigravity:s2']?.days['2026-10-21']?.['gemini-1.5-flash']?.output, 7);
  // the same requests sit in the day totals
  assert.equal(bucket(store)?.output, 20 + 7);
});

test('a streamed message that grows replaces itself in its session instead of adding', async () => {
  const { store } = await newStore();
  const at = '2026-10-21T09:00:00Z';
  store.add(inSession('s1', at, 10, { id: 'm1' }));
  store.add(inSession('s1', at, 50, { id: 'm1' }));
  store.add(inSession('s1', at, 20, { id: 'm1' }));
  const b = store.data.sessions?.['antigravity:s1']?.days['2026-10-21']?.['gemini-1.5-flash'];
  assert.equal(b?.requests, 1);
  assert.equal(b?.output, 50);
});

test('requests without a session count in the day totals only', async () => {
  const { store } = await newStore();
  store.add(rec('m1', 5));
  assert.deepEqual(store.data.sessions, {});
  assert.equal(bucket(store)?.requests, 1);
});

test('a store without sessions gets them from its records on the next change and on every load', async () => {
  const { store, file } = await newStore();
  delete store.data.sessions;
  store.add(inSession('s1', '2026-10-21T09:00:00Z', 10));
  assert.ok(store.data.sessions?.['antigravity:s1']);
  await store.save();
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  delete stored.sessions;
  await fs.writeFile(file, JSON.stringify(stored));
  assert.equal((await UsageStore.load(file)).data.sessions?.['antigravity:s1']?.days['2026-10-21']?.['gemini-1.5-flash']?.output, 10);
});

test('mergeData derives sessions from durable records', async () => {
  const a = (await newStore()).store;
  a.add(inSession('s1', '2026-10-21T09:00:00Z', 10));
  assert.ok(mergeData(a.data, a.data).sessions?.['antigravity:s1']);
});

test('summary lists the month\'s sessions by cost and reports what no session covers', async () => {
  const { store } = await newStore();
  const M = 1e6;
  store.add(inSession('cheap', '2026-10-21T09:00:00Z', M / 10));
  store.add(inSession('dear', '2026-10-20T09:00:00Z', M, { day: '2026-10-20' }));
  store.add(inSession('dear', '2026-10-21T09:00:00Z', M));
  store.add(inSession('old', '2026-09-30T09:00:00Z', M, { day: '2026-09-30' }));
  store.add(inSession('mixed', '2026-10-21T10:00:00Z', M, { model: 'mystery-model' }));
  store.add(rec('loose', M, { tokens: tokens({ output: M }) }));
  const s = summarize(store.data, new Pricing(), NOW);
  const out = new Pricing().rateFor('gemini-1.5-flash')?.output ?? 0.3;
  assert.deepEqual(s.sessions.map((r) => r.id), ['dear', 'cheap', 'mixed']);
  assert.equal(s.sessions[0].cost, 2 * out);
  assert.equal(s.sessions[0].tokens.requests, 2);
  assert.equal(s.sessions[0].first, Date.parse('2026-10-20T09:00:00Z'));
  assert.equal(s.sessions[2].unpriced, true);
  assert.equal(s.sessions[2].cost, 0);
  // `loose` has no session; `old` is last month
  assert.ok(Math.abs((s.unattributed ?? NaN) - out) < 1e-9);
});

test('summary reports no unattributed figure while sessions are untracked', async () => {
  const { store } = await newStore();
  delete store.data.sessions;
  store.add(rec('m1', 5));
  delete store.data.sessions;
  const s = summarize(store.data, new Pricing(), NOW);
  assert.deepEqual(s.sessions, []);
  assert.equal(s.unattributed, undefined);
});

test('formatSpan stays compact', () => {
  assert.equal(formatSpan(0), '0m');
  assert.equal(formatSpan(45 * 60_000), '45m');
  assert.equal(formatSpan(185 * 60_000), '3h 05m');
  assert.equal(formatSpan((2 * 24 + 4) * 3_600_000), '2d 4h');
});

test('a record whose model is __proto__ cannot poison Object.prototype, and is counted as unknown-model', async () => {
  const { store } = await newStore();
  assert.equal(store.add(rec('m-proto', 5, { model: '__proto__' })), true);
  assert.equal(({} as Record<string, unknown>).input, undefined);
  assert.equal(({} as Record<string, unknown>).requests, undefined);
  assert.equal(bucket(store, '2026-10-21', 'unknown-model')?.requests, 1);
});

test('a store file that is empty, truncated or not a store is rejected with a SyntaxError so the caller can set it aside', async () => {
  for (const content of ['', '{"version":1,"days":{"2026', 'null', '[]', '{}', '"text"']) {
    const { file } = await newStore();
    await fs.writeFile(file, content);
    await assert.rejects(UsageStore.load(file), SyntaxError, JSON.stringify(content));
  }
});

test('a store from an older version without seen, open or files still loads', async () => {
  const { file } = await newStore();
  await fs.writeFile(file, JSON.stringify({ version: 1, days: {} }));
  const loaded = await UsageStore.load(file);
  assert.deepEqual(loaded.data.files, {});
  assert.equal('seen' in loaded.data || 'open' in loaded.data, false);
});

test('a lock left by a dead process is taken over instead of waited on', async () => {
  const { store, file } = await newStore();
  const lock = `${file}.lock`;
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, 'owner'), 'dead-process');
  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(lock, old, old);
  const started = Date.now();
  await store.transaction(() => void store.add(rec('antigravity:after-crash', 5)));
  assert.ok(Date.now() - started < 5_000);
  await assert.rejects(fs.stat(lock));
  assert.equal(bucket(await UsageStore.load(file))?.requests, 1);
});

test('an exception inside a transaction still releases the lock', async () => {
  const { store, file } = await newStore();
  await assert.rejects(store.transaction(() => { throw new Error('boom'); }), /boom/);
  await assert.rejects(fs.stat(`${file}.lock`));
  await store.transaction(() => void store.add(rec('antigravity:ok', 5)));
  assert.equal(bucket(await UsageStore.load(file))?.requests, 1);
});

test('a holder that finds its lock was taken over leaves the new owner\'s lock alone', async () => {
  const { store, file } = await newStore();
  await store.transaction(async () => {
    await fs.writeFile(path.join(`${file}.lock`, 'owner'), 'someone-else');
  });
  assert.ok((await fs.stat(`${file}.lock`)).isDirectory());
  await fs.rm(`${file}.lock`, { recursive: true });
});

test('several writers at once all land, and saving leaves no temp or lock files behind', async () => {
  const { store: s1, file } = await newStore();
  const stores = [s1, await UsageStore.load(file), await UsageStore.load(file), await UsageStore.load(file)];
  await Promise.all(stores.map((s, i) => s.transaction(() => void s.add(rec(`antigravity:w${i}`, 5 + i)))));
  assert.equal(bucket(await UsageStore.load(file))?.requests, 4);
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((f) => f !== 'backups'), ['usage.json']);
});

// Stand-ins for fs.promises calls, so a test can force the order in which two waiters move.
const rawFs = fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
function hook(name: string, wrap: (original: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) => Promise<unknown>): () => void {
  const original = rawFs[name];
  rawFs[name] = (...args) => wrap(original, ...args);
  return () => void (rawFs[name] = original);
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => (resolve = r)), resolve };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('two waiters that find the same dead lock do not both take it', async () => {
  const { store: a, file } = await newStore();
  const b = await UsageStore.load(file);
  const lockDir = `${file}.lock`;
  await fs.mkdir(lockDir);
  const old = new Date(Date.now() - 5 * 60_000);
  await fs.utimes(lockDir, old, old);

  // Both waiters look at the dead lock before either moves it, and the second move is held back until the first waiter
  // has made a fresh lock and is working: the second rename then lands on a live lock.
  let looked = 0;
  const bothLooked = deferred();
  const firstWorking = deferred();
  let renames = 0;
  const restore = [
    hook('stat', async (stat, ...args) => {
      const result = await stat(...args);
      if (args[0] === lockDir && ++looked <= 2) {
        if (looked === 2) bothLooked.resolve();
        await bothLooked.promise;
      }
      return result;
    }),
    hook('rename', async (rename, ...args) => {
      if (args[0] === lockDir && ++renames === 2) await firstWorking.promise;
      return rename(...args);
    }),
  ];
  let working = 0;
  let mostWorking = 0;
  const write = (store: UsageStore, id: string, ms: number) => () =>
    (async () => {
      mostWorking = Math.max(mostWorking, ++working);
      firstWorking.resolve();
      await sleep(ms);
      store.add(rec(id, 5));
      working--;
    })();
  try {
    await Promise.all([a.transaction(write(a, 'antigravity:a', 30)), b.transaction(write(b, 'antigravity:b', 60))]);
  } finally {
    restore.forEach((undo) => undo());
  }
  assert.equal(mostWorking, 1);
  assert.equal((await UsageStore.load(file)).data.days['2026-10-21']?.antigravity?.['gemini-1.5-flash']?.requests, 2);
});

test('a writer whose lock was taken over saves nothing instead of overwriting the new holder', async () => {
  const { store, file } = await newStore();
  await assert.rejects(
    store.transaction(async () => {
      store.add(rec('antigravity:x', 5));
      // Another process judged this lock dead (a suspended laptop) and now owns it.
      await fs.writeFile(path.join(`${file}.lock`, 'owner'), 'someone-else');
    }),
    /lost the lock/,
  );
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp')), []);
});

test('a file that parses but is not a usage store is refused, saying which part is wrong', async () => {
  const dir = await temporaryDirectory('ai-usage-store-');
  const bad: [string, string][] = [
    ['{"version":1}', '"days"'],
    ['{"days":[]}', '"days"'],
    ['{"days":{"2026-10-21":{"antigravity":{"m":{"requests":"1"}}}}}', '"days"'],
    ['{"days":{},"sessions":{"antigravity:a":{"days":[]}}}', '"sessions"'],
    ['{"days":{},"files":{"/x.jsonl":1}}', '"files"'],
    ['[]', 'usage store'],
    ['null', 'usage store'],
    ['{broken', 'not valid JSON'],
  ];
  for (const [body, what] of bad) {
    const file = path.join(dir, 'usage.json');
    await fs.writeFile(file, body);
    await assert.rejects(UsageStore.load(file), (err: unknown) => err instanceof InvalidStoreError && err instanceof SyntaxError && err.file === file && err.message.includes(what), body);
  }
});

test('a store from before seen, open and files existed still loads', async () => {
  const dir = await temporaryDirectory('ai-usage-store-');
  const file = path.join(dir, 'usage.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, days: { '2026-10-21': { antigravity: { 'gemini-1.5-flash': { requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 9 } } } } }));
  const store = await UsageStore.load(file);
  assert.deepEqual(store.data.files, {});
  assert.equal(bucket(store)?.output, 9);
});

test('absorb refuses a damaged legacy file by name and leaves it where it is', async () => {
  const { store } = await newStore();
  const dir = await temporaryDirectory('ai-usage-store-');
  for (const body of ['{"version":1,"days":{', '{"version":1}']) {
    const legacy = path.join(dir, 'legacy.json');
    await fs.writeFile(legacy, body);
    await assert.rejects(store.absorb(legacy), (err: unknown) => err instanceof InvalidStoreError && err.file === legacy);
    assert.equal(await fs.readFile(legacy, 'utf8'), body);
  }
});

