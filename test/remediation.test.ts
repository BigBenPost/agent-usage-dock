import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { temporaryDirectory } from './temp';
import { UsageStore, parseStoreData } from '../src/store';
import { aggregate, canonicalRecords, isUsageRecord, mergeLegacy } from '../src/reconcile';
import { initializeUsageStore, sharedStoreFile } from '../src/paths';
import { loadArchive } from '../src/backup';
import { DshParser } from '../src/collectors/dshParser';
import { Pricing } from '../src/pricing';
import { summarize, toCsv } from '../src/summary';
import { normalizeConfig } from '../src/configValues';
import { budgetLevel, levelBar, statusBarLabel, statusBarText } from '../src/statusText';
import { refreshUsage } from '../src/scan';

const now = Date.parse('2026-11-22T12:00:00Z');
const bucket = (input: number) => ({ requests: 1, input, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
const legacy = (day: string, input: number) => ({ version: 1, days: { [day]: { antigravity: { 'gemini-1.5-flash': bucket(input) } } } });

test('legacy-only imports survive reload, repeat import and archive-only recovery', async () => {
  const root = await temporaryDirectory('import-lifecycle-'), file = path.join(root, 'usage-v3.json');
  const first = path.join(root, 'first.json'), second = path.join(root, 'second.json');
  await fs.writeFile(first, JSON.stringify(legacy('2026-11-20', 100)));
  await fs.writeFile(second, JSON.stringify(legacy('2026-11-21', 200)));
  let store = await UsageStore.load(file);
  await store.absorb(first); await store.absorb(second); await store.absorb(first);
  store = await UsageStore.load(file);
  assert.equal(summarize(store.data, new Pricing(), now).tokensTotal, 300);
  const csv = toCsv(store.data.days, new Pricing());
  await fs.rm(file);
  store = await UsageStore.recover(file, () => assert.fail('missing store is not corrupt'));
  assert.equal(summarize(store.data, new Pricing(), now).tokensTotal, 300);
  assert.equal(toCsv(store.data.days, new Pricing()), csv);
});

test('legacy conflicts preserve working file and archive; cutoff cannot expand silently', async () => {
  const root = await temporaryDirectory('import-conflict-'), file = path.join(root, 'usage-v3.json');
  const input = path.join(root, 'old.json');
  await fs.writeFile(input, JSON.stringify(legacy('2026-11-20', 100)));
  const store = await UsageStore.load(file); await store.absorb(input);
  const archive = path.join(root, 'archive', 'history-ledger-v3.json');
  const before = [await fs.readFile(file, 'utf8'), await fs.readFile(archive, 'utf8')];
  await fs.writeFile(input, JSON.stringify(legacy('2026-11-20', 200)));
  await assert.rejects(store.absorb(input), /Legacy merge conflict/);
  assert.deepEqual([await fs.readFile(file, 'utf8'), await fs.readFile(archive, 'utf8')], before);
  const a = { days: legacy('2026-11-22', 100).days, before: now };
  const b = { days: legacy('2026-11-21', 200).days, before: now + 1000 };
  assert.throws(() => mergeLegacy(a, b), /cutoff/);
  assert.deepEqual(mergeLegacy(a, { days: {}, before: now + 1000 }), a);
  const reordered = JSON.parse(JSON.stringify(a), (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.equal(mergeLegacy(a, { ...reordered, before: now + 1000 })!.before, now);
});

test('recovery merges disjoint archived baselines and refuses ambiguous overlaps without replacing either file', async () => {
  const root = await temporaryDirectory('baseline-recovery-'), file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const data = parseStoreData(JSON.stringify(legacy('2026-11-20', 100)), file);
  store.data = data; store.markDirty(); await store.save();
  const archived = parseStoreData(JSON.stringify(legacy('2026-11-21', 200)), file);
  const archive = path.join(root, 'archive', 'history-ledger-v3.json');
  await fs.mkdir(path.dirname(archive));
  await fs.writeFile(archive, JSON.stringify({ version: 3, records: {}, days: archived.days, legacy: archived.legacy, updatedAt: new Date(now).toISOString() }));
  await store.transaction(() => store.archive());
  assert.equal(summarize(store.data, new Pricing(), now).tokensTotal, 300);
  const changed = JSON.parse(await fs.readFile(archive, 'utf8'));
  changed.legacy.days['2026-11-20'].antigravity['gemini-1.5-flash'].input = 999;
  await fs.writeFile(archive, JSON.stringify(changed));
  const before = [await fs.readFile(file, 'utf8'), await fs.readFile(archive, 'utf8')];
  await assert.rejects(store.transaction(() => store.archive()), /Legacy merge conflict/);
  assert.deepEqual([await fs.readFile(file, 'utf8'), await fs.readFile(archive, 'utf8')], before);
});

test('legacy and every archive generation reject dangerous keys, invalid days and counters before aggregation', async () => {
  const root = await temporaryDirectory('input-validation-'), file = path.join(root, 'usage-v3.json');
  await fs.mkdir(path.join(root, 'archive'));
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const model of ['__proto__', 'constructor', 'prototype']) {
    const days = JSON.parse('{"2026-11-22":{"antigravity":{' + JSON.stringify(model) + ':' + JSON.stringify(bucket(100)) + '}}}');
    assert.throws(() => parseStoreData(JSON.stringify({ version: 1, days }), file), /malformed/);
    for (const version of [1, 2, 3]) {
      const name = version === 1 ? 'history-ledger.json' : `history-ledger-v${version}.json`;
      const p = path.join(root, 'archive', name);
      await fs.writeFile(p, JSON.stringify({ version, days, records: {} }));
      await assert.rejects(loadArchive(file), /invalid archive/); await fs.rm(p);
    }
  }
  for (const day of ['2026-02-30', '__proto__']) assert.throws(() => parseStoreData(JSON.stringify(legacy(day, 10)), file));
  for (const input of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseStoreData(JSON.stringify(legacy('2026-11-22', input)), file));
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototype);
});

test('broken legacy migration cannot publish an empty current store and can retry after repair', async () => {
  const root = await temporaryDirectory('startup-migration-'), previous = process.env.AGY_TOKEN_TRACKER_HOME;
  process.env.AGY_TOKEN_TRACKER_HOME = root;
  try {
    const source = path.join(root, 'usage-v2.json');
    await fs.writeFile(source, '{broken');
    await assert.rejects(initializeUsageStore(() => assert.fail('wrong recovery')), /usage-v2/);
    await assert.rejects(fs.access(sharedStoreFile()), { code: 'ENOENT' });
    await fs.writeFile(source, JSON.stringify(legacy('2026-11-20', 100)));
    const store = await initializeUsageStore(() => assert.fail('healthy migration'));
    assert.equal(summarize(store.data, new Pricing(), now).tokensTotal, 100);
  } finally {
    if (previous === undefined) delete process.env.AGY_TOKEN_TRACKER_HOME; else process.env.AGY_TOKEN_TRACKER_HOME = previous;
  }
});

function callLog(bad: boolean, revision: number) {
  const parser = new DshParser(revision);
  const event = (seq: number, type: string, data: unknown) => ({ seq, type, data, time: now });
  const usage = { inputTokens: 100, outputTokens: 20 };
  const events = [
    { type: 'session', version: 4, id: 'repair-session', createdAt: now },
    event(0, 'assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { ...usage, inputTokens: bad ? -1 : 100 } } }] }),
    event(1, 'assistant/message', { turn: 0, step: 0, message: { source: { provider: 'deepseek', model: 'deepseek-flash' } }, usage }),
  ];
  for (const e of events) parser.line(JSON.stringify(e));
  return parser.finish();
}

test('DSH identity is stable through bad usage repair; old alias cannot resurrect after stale archive restore', async () => {
  const root = await temporaryDirectory('call-repair-'), file = path.join(root, 'usage-v3.json');
  const first = callLog(true, 1), fixed = callLog(false, 2);
  assert.equal(first.problems.length, 1);
  assert.equal(first.records[0].id, fixed.records[0].id);
  const old = structuredClone(fixed.records[0]); old.id = 'dsh:repair-session:1'; delete old.evidence!.dshCall;
  const store = await UsageStore.load(file);
  await store.transaction(async checkpoint => { store.add(old); await checkpoint(); await store.archive(); });
  const archive = path.join(root, 'archive', 'history-ledger-v3.json');
  const stale = await fs.readFile(archive);
  // Simulate a committed checkpoint followed by a failed archive write.
  await store.transaction(checkpoint => { store.addRecords(fixed.records); return checkpoint(); });
  await fs.writeFile(archive, stale);
  const restored = await UsageStore.load(file);
  await restored.transaction(() => restored.archive());
  assert.deepEqual(Object.keys(restored.data.records), ['dsh:repair-session:0']);
  assert.equal(summarize(restored.data, new Pricing(), now).tokensTotal, 120);
  const imported = { ...restored.data.records, [old.id]: old };
  assert.equal(Object.keys(canonicalRecords(imported)).length, 1);
  assert.equal(aggregate(imported).days['2026-11-22'].dsh![Object.keys(aggregate(imported).days['2026-11-22'].dsh!)[0]].requests, 1);
});

test('DSH alias evidence rejects conflicting or foreign identities and retains unrelated calls', () => {
  const rec = callLog(false, 2).records[0];
  for (const patch of [{ source: 'antigravity' }, { session: 'other' }, { id: 'dsh:repair-session:1' }, { evidence: { ...rec.evidence, dshCall: { version: 1, sequences: [0, -1] } } }]) {
    const invalid = { ...rec, ...patch };
    assert.equal(isUsageRecord(invalid, invalid.id), false);
  }
  const conflicting = structuredClone(rec); conflicting.id = 'dsh:repair-session:1'; conflicting.evidence!.dshCall!.sequences = [1, 2];
  assert.throws(() => canonicalRecords({ [rec.id]: rec, [conflicting.id]: conflicting }), /Conflicting/);
  const unrelated = structuredClone(rec); unrelated.session = 'other'; unrelated.id = 'dsh:other:0';
  assert.equal(Object.keys(canonicalRecords({ [rec.id]: rec, [unrelated.id]: unrelated })).length, 2);
});

test('cost budget level and accessible label use the selected metric at all thresholds', () => {
  const summary = summarize({ days: {} }, new Pricing(), now);
  const cfg = normalizeConfig({ budgetMode: 'cost', budgetLimit: 10, tokenBudgetLimit: 0 });
  for (const [total, level, bar] of [[7, 'ok', 'green'], [7.5, 'warning', 'amber'], [9, 'critical', 'red'], [10, 'critical', 'red'], [15, 'critical', 'red']] as const) {
    const s = { ...summary, total, todayTotal: total };
    assert.equal(budgetLevel(s, cfg), level); assert.equal(levelBar(s, cfg), bar);
    assert.match(statusBarLabel(s, cfg), /estimated cost/);
  }
  assert.match(statusBarLabel({ ...summary, total: 15 }, cfg), /150%.*over budget/);
  assert.match(statusBarText({ ...summary, total: 15 }, cfg), /150%/);
  assert.equal(levelBar(summary, { ...cfg, budgetLimit: 0, tokenBudgetLimit: 1 }), undefined);
  for (const budgetMode of ['tokens', 'cost'] as const) for (const levelIndicator of ['bar', 'ring'] as const) for (const statusBarStyle of ['percent', 'gauge', 'ring'] as const) {
    const config = normalizeConfig({ budgetMode, levelIndicator, statusBarStyle, budgetLimit: 10, tokenBudgetLimit: 1 });
    const value = { ...summary, total: budgetMode === 'cost' ? 15 : 0, tokensTotal: budgetMode === 'tokens' ? 1_500_000 : 0 };
    assert.equal(budgetLevel(value, config), 'critical');
    assert.equal(levelBar(value, config), 'red');
    assert.match(statusBarLabel(value, config), /150%/);
    assert.ok(statusBarText(value, config));
  }
});

test('unchanged polling keeps live timestamps without rewriting the full ledger; health transitions persist immediately', async () => {
  const root = await temporaryDirectory('idle-health-'), file = path.join(root, 'usage-v3.json'), home = path.join(root, 'agy');
  await fs.mkdir(home);
  const store = await UsageStore.load(file);
  await refreshUsage(store, file, home);
  const original = await fs.readFile(file, 'utf8');
  await refreshUsage(store, file, home);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const expired = JSON.parse(original);
  expired.health.attemptedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  await fs.writeFile(file, JSON.stringify(expired));
  await refreshUsage(store, file, home);
  assert.notEqual(JSON.parse(await fs.readFile(file, 'utf8')).health.attemptedAt, expired.health.attemptedAt);
  await fs.rm(home, { recursive: true });
  await refreshUsage(store, file, home);
  assert.notEqual(await fs.readFile(file, 'utf8'), original);
  assert.equal((await UsageStore.load(file)).data.sourceHealth?.antigravity?.status, 'incomplete');
});
