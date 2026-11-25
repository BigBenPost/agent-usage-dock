import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from './temp';
import { UsageStore, parseStoreData } from '../src/store';
import { refreshUsage } from '../src/scan';
import { archiveLedgerFile } from '../src/backup';
import { Pricing } from '../src/pricing';
import { normalizeAntigravityModel, modelFromEnum, scanAntigravity, decodeProtoFields } from '../src/collectors/antigravity';
import { UsageRecord } from '../src/types';
import { aggregate, preferredRecord } from '../src/reconcile';
import { normalizeConfig } from '../src/configValues';
import { summarize } from '../src/summary';
import { statusBarText } from '../src/statusText';
import { renderBody, renderPage } from '../src/panelHtml';

const record = (id = 'antigravity:s:1', revision = 1, output = 10): UsageRecord => ({
  id, source: 'antigravity', day: '2026-01-01', model: 'gemini-1.5-flash', session: 's', ts: Date.parse('2026-01-01T12:00:00Z'),
  tokens: { input: 100, cacheRead: 20, cacheWrite: 0, cacheWrite1h: 0, output },
  evidence: { kind: 'database', revision, parserVersion: 2 },
});
async function fixture() {
  const root = await temporaryDirectory('agy-reliability-');
  const file = path.join(root, 'shared', 'usage-v2.json');
  const home = path.join(root, 'agy');
  const log = path.join(home, 'brain', 's', '.system_generated', 'logs', 'transcript.jsonl');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, JSON.stringify({ step_index: 1, created_at: '2026-01-01T12:00:00Z', model: 'gemini-1.5-flash', input_tokens: 100, output_tokens: 10 }) + '\n');
  return { root, file, home, log, store: await UsageStore.load(file) };
}
const total = (s: UsageStore) => summarize(s.data, new Pricing(), Date.parse('2026-01-02'));

test('imports old logs; repeated rebuilds and deleted logs preserve exact totals', async () => {
  const { store, file, home, log } = await fixture();
  await refreshUsage(store, file, home);
  assert.equal(total(store).totalRequests, 1);
  const initial = structuredClone(store.data.days);
  await refreshUsage(store, file, home, true);
  await refreshUsage(store, file, home, true);
  assert.deepEqual(store.data.days, initial);
  await fs.rm(log);
  await refreshUsage(store, file, home, true);
  assert.deepEqual(store.data.days, initial);
  assert.deepEqual(store.data.files, {});
});

test('missing working store recovers archive before first scan and saves recovery', async () => {
  const { store, file, home, log } = await fixture();
  await refreshUsage(store, file, home);
  const expected = structuredClone(store.data.days);
  await fs.rm(file); await fs.rm(log);
  const recovered = await UsageStore.load(file);
  await refreshUsage(recovered, file, home);
  assert.deepEqual((await UsageStore.load(file)).data.days, expected);
});

test('late downward corrections and model corrections survive restart and archive recovery', async () => {
  const { store, file } = await fixture();
  await store.transaction(async checkpoint => { store.add(record()); await checkpoint(); await store.archive(); });
  const corrected = { ...record(undefined, 2, 5), model: 'claude-opus-4.6' };
  await store.transaction(async checkpoint => { store.add(corrected); await checkpoint(); await store.archive(); });
  assert.equal(total(store).tokensBucket.output, 5);
  assert.equal(total(store).totalRequests, 1);
  await fs.rm(file);
  const recovered = await UsageStore.load(file);
  await recovered.transaction(() => undefined);
  assert.equal(total(recovered).models[0].model, 'claude-opus-4.6');
  assert.equal(total(recovered).tokensBucket.output, 5);
});

test('reconciliation is order-independent, idempotent and respects source revisions', async () => {
  const old = record(), final = record(undefined, 2, 5);
  const transcript = { ...record(undefined, 99, 900), evidence: { kind: 'transcript' as const, revision: 99, parserVersion: 2 } };
  const variants = [[old, final, transcript], [transcript, final, old], [final, old, transcript]];
  for (const variantsInOrder of variants) {
    const { store } = await fixture();
    store.addRecords(variantsInOrder);
    assert.deepEqual(store.data.records[old.id], final);
    assert.equal(store.addRecords(variantsInOrder), 0);
    assert.deepEqual(store.data.days, aggregate({ [final.id]: final }).days);
  }
  assert.deepEqual(preferredRecord(final, final), final);
});

test('legacy baseline is not added twice, including model reassignment, and is visibly qualified', async () => {
  const { store, file, home } = await fixture();
  const days = aggregate({ r: record() }).days;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, days }));
  await refreshUsage(store, file, home, true);
  assert.equal(total(store).totalRequests, 1);
  const revised = { ...record(undefined, 2), model: 'claude-opus-4.6' };
  await store.transaction(() => store.add(revised));
  assert.equal(total(store).totalRequests, 1);
  assert.match(renderBody(total(store), normalizeConfig({})), /Legacy aggregate history/);
});

test('corrupt and unsupported archives are preserved, never silently replaced', async () => {
  const { store, file, home } = await fixture();
  const archive = archiveLedgerFile(file);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  for (const text of ['{bad json', '{"version":999,"days":{}}']) {
    await fs.writeFile(archive, text);
    await assert.rejects(refreshUsage(store, file, home));
    assert.equal(await fs.readFile(archive, 'utf8'), text);
  }
  assert.throws(() => parseStoreData('{"version":999,"days":{}}', file), /unsupported/);
});

test('archive captures input-only corrections and does not rewrite unchanged facts', async () => {
  const { store, file } = await fixture();
  const target = path.join(path.dirname(file), 'archive', 'history-ledger-v3.json');
  await store.transaction(async checkpoint => { store.add(record()); await checkpoint(); await store.archive(); });
  const corrected = { ...record(undefined, 2), tokens: { ...record().tokens, input: 200 } };
  await store.transaction(async checkpoint => { store.add(corrected); await checkpoint(); await store.archive(); });
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).days['2026-01-01'].antigravity['gemini-1.5-flash'].input, 200);
  const before = await fs.stat(target);
  await store.transaction(() => store.archive());
  assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs);
});

test('failed save can be retried without counting a request twice', async () => {
  const { store, file } = await fixture();
  await assert.rejects(store.transaction(async () => { store.add(record()); throw new Error('injected'); }), /injected/);
  await store.transaction(() => store.add(record()));
  assert.equal(total(await UsageStore.load(file)).totalRequests, 1);
});

test('unknown models and partial prices do not silently become fully priced', () => {
  assert.equal(normalizeAntigravityModel('Claude Sonnet 4.5'), 'claude-sonnet-4.5');
  assert.equal(normalizeAntigravityModel('unknown-model'), 'unknown-model');
  assert.equal(modelFromEnum(987654), 'unknown-model');
  assert.equal(modelFromEnum(1035), 'claude-sonnet-4.6');
  assert.equal(modelFromEnum(1026), 'claude-opus-4.6');
  assert.equal(modelFromEnum(1525), 'gemini-4-hydrogen');
  const p = new Pricing({ custom: { output: 2 } });
  assert.equal(p.quote({ source: 'antigravity', model: 'custom', tokens: record().tokens }).unpriced, true);
  assert.equal(new Pricing().rateFor('claude-3.5-sonnet')?.input, 3);
  assert.equal(new Pricing().rateFor('claude-sonnet-4.6')?.input, 3);
  assert.equal(new Pricing().rateFor('claude-opus-4.6')?.input, 5);
  assert.equal(new Pricing().rateFor('gemini-3.8-flash')?.input, 0.75);
  assert.equal(new Pricing().rateFor('gemini-4-hydrogen-high')?.input, 1.5);
  assert.equal(new Pricing().rateFor('gpt-4o')?.input, 2.5);
  assert.equal(new Pricing().rateFor('some-random-unknown-model'), undefined);
});

test('cost budget and health are rendered with escaped paths and a valid page script', () => {
  const s = summarize({ ...aggregate({ r: record() }), health: { root: '<bad>', attemptedAt: 'now', problems: ['cannot read DB'] }, storage: { ledger: '<bad>/usage-v3.json', archive: '<bad>/archive' } }, new Pricing(), Date.parse('2026-01-02'));
  const cfg = normalizeConfig({ budgetMode: 'cost', budgetLimit: 10 });
  assert.match(statusBarText(s, cfg), /\$/);
  const html = renderPage(s, cfg);
  assert.match(html, /Estimated cost budget/);
  assert.match(html, /Incomplete scan/);
  assert.match(html, /&#60;bad&#62;/);
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
});

test('malformed protobuf lengths fail promptly and do not loop', () => {
  assert.throws(() => decodeProtoFields(Buffer.from([10, 255, 255, 255, 255, 255, 255, 255, 255])), /protobuf/i);
});

test('database failures are reported and do not advance the scan cursor', async () => {
  const { home } = await fixture();
  await fs.mkdir(path.join(home, 'conversations'));
  const db = path.join(home, 'conversations', 'bad.db'); await fs.writeFile(db, 'not sqlite');
  const files = {}, problems: string[] = [];
  await scanAntigravity(path.join(home, 'brain'), path.join(home, 'missing.db'), files, () => {}, problems);
  assert.equal(db in files, false); assert.ok(problems.some(p => p.includes('bad.db')));
});

test('WAL-only changes are scanned, with bounded recent-step and full rebuild reconciliation', async t => {
  let DatabaseSync: any;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('WAL writer fixture needs Node 22+; fallback is covered in the Node 18 CI job'); return; }
  const { home, file, store } = await fixture();
  await fs.rm(path.join(home, 'brain'), { recursive: true });
  await fs.mkdir(path.join(home, 'conversations'));
  const dbPath = path.join(home, 'conversations', 's.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
    const bytes = Buffer.from('0a0608ad9eafd7064a0c08a60a108827189003289875', 'hex');
    db.prepare('INSERT INTO steps VALUES (?,15,?)').run(1, bytes);
    await refreshUsage(store, file, home);
    const initial = (await fs.stat(dbPath)).mtimeMs;
    db.prepare('INSERT INTO steps VALUES (?,15,?)').run(2, bytes);
    assert.equal((await fs.stat(dbPath)).mtimeMs, initial);
    await refreshUsage(store, file, home);
    assert.equal(Object.keys(store.data.records).length, 2);
    const expected = structuredClone(store.data.days);
    await refreshUsage(store, file, home, true);
    assert.deepEqual(store.data.days, expected);
  } finally { db.close(); }
});

test('corrupt working store is quarantined under lock and restored; future versions are left untouched', async () => {
  const { store, file, home } = await fixture();
  await refreshUsage(store, file, home);
  const days = structuredClone(store.data.days);
  await fs.writeFile(file, '{broken');
  let aside = '';
  const recovered = await UsageStore.recover(file, p => { aside = p; });
  assert.equal(await fs.readFile(aside, 'utf8'), '{broken');
  assert.deepEqual(recovered.data.days, days);
  await fs.writeFile(file, '{"version":999}');
  await assert.rejects(UsageStore.recover(file, () => assert.fail('must not quarantine future versions')), /unsupported/);
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":999}');
});

test('SQLite command fallback uses PATH and reads paged hex metadata', async t => {
  const { spawnSync } = await import('node:child_process');
  const executable = process.env.AGY_SQLITE3 || 'sqlite3';
  const probe = spawnSync(executable, ['--version']);
  if (probe.error || probe.status !== 0) {
    assert.notEqual(process.env.AGY_TEST_REQUIRE_SQLITE, '1', 'CI must install sqlite3');
    t.skip('sqlite3 CLI not installed on this machine'); return;
  }
  const { root } = await fixture();
  const file = path.join(root, 'fallback.db');
  const result = spawnSync(executable, [file, "CREATE TABLE steps(idx INTEGER, metadata BLOB); INSERT INTO steps VALUES(1, X'CAFE');"]);
  assert.equal(result.status, 0);
  const { sqliteRows } = await import('../src/collectors/sqlite');
  assert.deepEqual(await sqliteRows(file, 'SELECT idx, hex(metadata) AS metadata FROM steps ORDER BY idx LIMIT 256', 'cli'), [{ idx: 1, metadata: 'CAFE' }]);
});

test('two independent collectors merge concurrent snapshots without lost requests', async () => {
  const { file } = await fixture();
  const a = await UsageStore.load(file), b = await UsageStore.load(file);
  await Promise.all([a.transaction(() => a.add(record('antigravity:a:1'))), b.transaction(() => b.add(record('antigravity:b:1')))]);
  const loaded = await UsageStore.load(file);
  assert.equal(total(loaded).totalRequests, 2);
});
