import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { matchesGlob } from '../src/glob';
import { mergeData, parseStoreData, UsageStore } from '../src/store';
import { refreshUsage } from '../src/scan';
import { temporaryDirectory } from './temp';
import { UsageRuntime } from '../src/usageRuntime';
import { normalizeConfig } from '../src/configValues';

const day = '2026-11-24';
const record = (id: string, input: number) => ({ id: `claude:${id}`, source: 'claude' as const, day, model: 'claude-sonnet-4-6', tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });

test('wildcard rules stay bounded for adversarial patterns and preserve literal glob semantics', () => {
  for (const [pattern, value, expected] of [
    ['*', '', true], ['gpt-*', 'gpt-6.2-sol', true], ['a.b*', 'axb', false], ['a?*', 'ab', false],
    ['a*b*c', 'axybzc', true], ['a*b', 'abx', false], ['', '', true],
  ] as const) assert.equal(matchesGlob(pattern, value), expected);
  const run = spawnSync(process.execPath, ['-e', `
    const {Pricing}=require(${JSON.stringify(path.resolve(__dirname, '../src/pricing.js'))});
    const p=new Pricing({['*'.repeat(30)+'Z']:{input:1},['*a'.repeat(20)+'Z']:{input:1}});
    p.rateFor('claude-sonnet-4-6','claude');p.rateFor('a'.repeat(80),'claude');
  `], { timeout: 3000, encoding: 'utf8' });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
});

test('Cursor import matches duplicate requests once, across reorder, growth, pruning and anonymous enrichment', () => {
  const data = (sessions: string[]) => parseStoreData(JSON.stringify({ version: 1, events: sessions.map(s => [1795521600000, 'composer-2.5', 100, 20, 0, 0, 0, 0, s]) }), 'cursor.json');
  const counts = (d: ReturnType<typeof data>) => Object.fromEntries(Object.entries(d.sessions ?? {}).sort().map(([key, session]) => [key, session.days[day]['composer-2.5'].requests]));
  for (const [a, b, expected] of [
    [['B', 'A'], ['A', 'A', 'B'], { 'cursor:A': 2, 'cursor:B': 1 }],
    [['A', 'A'], ['B', 'A'], { 'cursor:A': 2, 'cursor:B': 1 }],
    [['', '', ''], ['A', 'A', 'B'], { 'cursor:A': 2, 'cursor:B': 1 }],
  ] as [string[], string[], Record<string, number>][]) {
    for (const [first, second] of [[a, b], [b, a]]) {
      const merged = mergeData(data(first), data(second));
      assert.deepEqual(counts(merged), expected);
      assert.deepEqual(counts(mergeData(merged, data(second))), expected, 'repeat import adds nothing');
      assert.deepEqual(counts(mergeData(merged, data(['A']))), expected, 'a pruned snapshot does not erase duplicates');
    }
  }
});

test('overflow rejects a batch atomically and leaves both durable snapshots recoverable', async () => {
  const file = path.join(await temporaryDirectory('overflow-131-'), 'usage-v3.json');
  const store = await UsageStore.load(file);
  await store.transaction(async checkpoint => { store.add(record('first', 1)); await checkpoint(); await store.archive(); });
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.transaction(() => store.addRecords([record('good', 10), record('bad', Number.MAX_SAFE_INTEGER)])), /safe integer/);
  assert.deepEqual(Object.keys(store.data.records), ['claude:first']);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.throws(() => store.add(record('bad', Number.MAX_SAFE_INTEGER)), /safe integer/);
  await fs.rm(file);
  const restored = await UsageStore.recover(file, () => assert.fail());
  assert.equal(restored.data.days[day].claude!['claude-sonnet-4-6'].input, 1);
});

test('Antigravity relocation and restart preserve the original session behind an alias', { skip: process.platform === 'win32' }, async () => {
  const root = await temporaryDirectory('alias-131-');
  const original = path.join(root, 'brain', 'original');
  const logDir = path.join(original, '.system_generated', 'logs');
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, 'transcript.jsonl'), JSON.stringify({ created_at: `${day}T12:00:00Z`, step_index: 1, input_tokens: 100, output_tokens: 20, model: 'gemini-3.8-flash' }) + '\n');
  const file = path.join(root, 'usage-v3.json');
  let store = await UsageStore.load(file);
  await refreshUsage(store, file, root);
  const moved = path.join(root, 'renamed');
  await fs.rename(original, moved);
  await fs.symlink(moved, path.join(root, 'brain', 'alias'));
  store = await UsageStore.load(file);
  await refreshUsage(store, file, root);
  await refreshUsage(store, file, root, true);
  assert.deepEqual(Object.keys(store.data.records), ['antigravity:original:1']);
});

test('usage runtime keeps raw requests in its worker, yields while loading history, and persists refreshes', async () => {
  const { withDataHome } = await import('./dataHome');
  await withDataHome(await temporaryDirectory('worker-131-'), async () => {
  const runtime = new UsageRuntime();
  try {
    // All tests run in a hermetic HOME. Populate the shared file with enough history to exercise worker aggregation.
    const { sharedStoreFile } = await import('../src/paths');
    const file = sharedStoreFile();
    const store = await UsageStore.load(file);
    await store.transaction(async checkpoint => {
      store.addRecords(Array.from({ length: 20_000 }, (_, i) => record('worker-' + i, 1)));
      await checkpoint(); await store.archive();
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    let loaded;
    try { loaded = await runtime.load(); } finally { clearInterval(timer); }
    assert.ok(ticks > 1, 'host event loop continues while the worker reads and aggregates history');
    assert.equal('records' in loaded.data, false, 'raw ledger never crosses back to host');
    assert.equal(loaded.data.days[day].claude!['claude-sonnet-4-6'].input, 20_000);
    const baseCfg = normalizeConfig({ antigravityEnabled: false, dshEnabled: false, claudeEnabled: false, codexEnabled: false });
    const proxiedCfg = new Proxy({ ...baseCfg, rates: new Proxy({ 'gemini-3.8-flash': new Proxy({ input: 1 }, {}) }, {}) }, {});
    const reply = await runtime.refresh(proxiedCfg);
    assert.equal(reply.result?.changed, 0);
    assert.equal(reply.data.sourceHealth?.claude?.status, 'disabled');
  } finally { runtime.dispose(); }
  });
});

test('an older JSONL parser cursor replays unchanged bytes after an upgrade', async () => {
  const { readNewLines } = await import('../src/collectors/lines');
  const file = path.join(await temporaryDirectory('parser-131-'), 'log.jsonl');
  await fs.writeFile(file, '{}\n');
  const current = await readNewLines(file, undefined, () => {});
  const old = { ...current, parserVersion: undefined };
  let replayed = 0;
  await readNewLines(file, old, () => replayed++);
  assert.equal(replayed, 1);
  replayed = 0;
  await readNewLines(file, current, () => replayed++);
  assert.equal(replayed, 0);
});
