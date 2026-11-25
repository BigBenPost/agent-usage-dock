import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as backup from '../src/backup';
import { currentArchiveFile, InvalidArchiveError, loadArchive } from '../src/backup';
import { initializeUsageStore } from '../src/paths';
import { fileStamp } from '../src/privateFiles';
import { isUsageRecord } from '../src/reconcile';
import { parseStoreData, UsageStore } from '../src/store';
import { isByModel, isDays, isLegacy } from '../src/validation';
import type { TokenBucket, UsageRecord } from '../src/types';
import { withDataHome } from './dataHome';
import { temporaryDirectory } from './temp';

const tokens = { input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 5 };
const bucket = (requests: number): TokenBucket => ({ requests, ...Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v * requests])) } as TokenBucket);
const record = (id: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
  id, source: 'claude', day: '2026-11-20', model: 'claude-sonnet-5-5', session: 's1', project: 'proj', ts: Date.parse('2026-11-20T10:00:00Z'), tokens, ...over,
});
const dayOf = (requests: number) => ({ '2026-11-20': { claude: { 'claude-sonnet-5-5': bucket(requests) } } });

/** What the build before the review fixes wrote: the request ledger plus `seen`, `open` and `hiddenSessions`. */
const writtenByEarlierBuild = () => ({
  version: 3,
  records: { 'claude:m1': record('claude:m1'), 'claude:m2': record('claude:m2', { session: 'hidden', ts: Date.parse('2026-11-20T11:00:00Z') }) },
  days: dayOf(2),
  sessions: { 'claude:s1': { source: 'claude', id: 's1', project: 'proj', first: 1, last: 1, days: { '2026-11-20': { 'claude-sonnet-5-5': bucket(1) } } } },
  seen: { 'claude:m1': '2026-11-20', 'claude:m2': '2026-11-20' },
  open: { 'claude:m1': { day: '2026-11-20', source: 'claude', model: 'claude-sonnet-5-5', tokens, at: Date.parse('2026-11-20T10:00:00Z') } },
  hiddenSessions: ['claude:hidden'],
  files: { '/gone/a.jsonl': { size: 1, mtimeMs: 2, offset: 1 } },
  firstDay: '2026-11-20',
  health: { root: '/x', attemptedAt: '2026-11-20T12:00:00.000Z', succeededAt: '2026-11-20T12:00:00.000Z', problems: [] },
  sourceHealth: { claude: { root: '/x', status: 'ok', attemptedAt: '2026-11-20T12:00:00.000Z', succeededAt: '2026-11-20T12:00:00.000Z', problems: [] } },
});

async function place(content: unknown): Promise<{ dir: string; file: string }> {
  const dir = await temporaryDirectory('store-format-');
  const file = path.join(dir, 'usage-v3.json');
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, file };
}

/** A transaction the way a poll runs it: change, checkpoint the working store, then archive. */
const persist = (store: UsageStore, change: () => void = () => store.markDirty()) =>
  store.transaction(async checkpoint => { change(); await checkpoint(); await store.archive(); });

/** The acceptance rules of parseStoreData in the earlier build for a version 3 file, so a store written now must still open there. */
function acceptedByEarlierBuild(text: string): void {
  const data = JSON.parse(text);
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const every = (v: unknown, ok: (x: unknown) => boolean) => isRecord(v) && Object.values(v).every(ok);
  assert.equal(data.version, 3);
  assert.ok(isDays(data.days), 'days');
  assert.ok(isRecord(data.records), 'records');
  for (const [id, rec] of Object.entries(data.records)) assert.ok(isUsageRecord(rec, id), id);
  if (data.sessions !== undefined) assert.ok(every(data.sessions, s => isRecord(s) && every(s.days, isByModel)), 'sessions');
  if (data.seen !== undefined) assert.ok(every(data.seen, day => typeof day === 'string'), 'seen');
  if (data.open !== undefined) assert.ok(every(data.open, isRecord), 'open');
  if (data.files !== undefined) assert.ok(every(data.files, isRecord), 'files');
  if (data.sourceHealth !== undefined) assert.ok(every(data.sourceHealth, h => isRecord(h) && typeof h.root === 'string' && Array.isArray(h.problems)), 'sourceHealth');
  if (data.legacy !== undefined) assert.ok(isLegacy(data.legacy), 'legacy');
  if (data.hiddenSessions !== undefined) assert.ok(Array.isArray(data.hiddenSessions) && data.hiddenSessions.every((x: unknown) => typeof x === 'string'), 'hiddenSessions');
}

test('a store written by the earlier build, with seen, open and hidden sessions, loads and saves again without them', async () => {
  const { dir, file } = await place(writtenByEarlierBuild());
  const store = await UsageStore.load(file);
  assert.equal('seen' in store.data || 'open' in store.data, false);
  assert.deepEqual(Object.keys(store.data.sessions ?? {}), ['claude:s1'], 'the hidden session stays out of the list');
  assert.equal(store.data.days['2026-11-20'].claude!['claude-sonnet-5-5'].requests, 2, 'its usage stays in the day totals');
  await persist(store);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal('seen' in saved || 'open' in saved, false);
  assert.deepEqual(saved.hiddenSessions, ['claude:hidden']);
  assert.deepEqual(JSON.parse(await fs.readFile(currentArchiveFile(file), 'utf8')).hiddenSessions, ['claude:hidden']);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.corrupt-')), []);
});

test('malformed seen or open never quarantines a store', async () => {
  for (const patch of [{ seen: [] }, { seen: { 'claude:m1': 7 } }, { open: [] }, { open: { x: 5 } }, { seen: 'text', open: 3 }]) {
    const { dir, file } = await place({ ...writtenByEarlierBuild(), ...patch });
    const store = await UsageStore.recover(file, aside => assert.fail('quarantined to ' + aside));
    assert.equal(store.data.days['2026-11-20'].claude!['claude-sonnet-5-5'].requests, 2, JSON.stringify(patch));
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.corrupt-')), []);
  }
});

test('hidden sessions survive the loss of the working store through the archive', async () => {
  const { file } = await place(writtenByEarlierBuild());
  const store = await UsageStore.load(file);
  await persist(store);
  await fs.rm(file);
  const recovered = await UsageStore.recover(file, () => assert.fail('nothing to quarantine'));
  assert.deepEqual(recovered.data.hiddenSessions, ['claude:hidden']);
  assert.deepEqual(Object.keys(recovered.data.sessions ?? {}), ['claude:s1']);
});

test('a store written by this build still opens under the rules of the earlier build', async () => {
  const { file } = await place(writtenByEarlierBuild());
  const store = await UsageStore.load(file);
  await persist(store, () => {
    store.addRecords([record('claude:m3', { ts: Date.parse('2026-11-20T12:00:00Z') })]);
    store.data.health = { root: '/x', attemptedAt: '2026-11-20T12:00:00.000Z', problems: ['one'] };
    store.data.sourceHealth = { claude: { root: '/x', status: 'incomplete', attemptedAt: '2026-11-20T12:00:00.000Z', problems: ['one'] } };
  });
  acceptedByEarlierBuild(await fs.readFile(file, 'utf8'));
  const archive = JSON.parse(await fs.readFile(currentArchiveFile(file), 'utf8'));
  assert.equal(archive.version, 3);
  assert.ok(isDays(archive.days));
  for (const [id, rec] of Object.entries(archive.records)) assert.ok(isUsageRecord(rec, id));
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort(), ['days', 'files', 'firstDay', 'hiddenSessions', 'health', 'records', 'sessions', 'sourceHealth', 'version'].sort());
});

test('a rejected request is skipped and listed, the rest are counted, and the list restarts with each call', async () => {
  const { file } = await place({ version: 3, records: {}, days: {} });
  const store = await UsageStore.load(file);
  const negative = record('claude:bad1', { tokens: { ...tokens, output: -1 } });
  const wrongDay = record('claude:bad2', { day: '2026-13-40' });
  const changed = store.addRecords([record('claude:ok1'), negative, record('claude:ok2'), wrongDay, null as unknown as UsageRecord]);
  assert.equal(changed, 2);
  assert.deepEqual(store.rejected.map(r => r.id), ['claude:bad1', 'claude:bad2', '']);
  assert.match(store.rejected[0].reason, /token counts/);
  assert.match(store.rejected[1].reason, /day/);
  assert.equal(Object.keys(store.data.records).length, 2);
  assert.equal(store.addRecords([record('claude:ok1')]), 0);
  assert.deepEqual(store.rejected, []);
  assert.throws(() => store.add(negative), /Invalid usage record: token counts/);
});

test('a bad saved firstDay is dropped and recomputed from the days', async () => {
  for (const firstDay of ['yesterday', 20261120, '2026-02-30', null, {}, '2026-11-20T00:00:00Z']) {
    const bare = parseStoreData(JSON.stringify({ version: 3, records: {}, days: {}, firstDay }), 'x.json');
    assert.equal(bare.firstDay, undefined, JSON.stringify(firstDay));
    assert.equal('firstDay' in bare, false);
    const withUsage = parseStoreData(JSON.stringify({ ...writtenByEarlierBuild(), firstDay }), 'x.json');
    assert.equal(withUsage.firstDay, '2026-11-20');
  }
  assert.equal(parseStoreData(JSON.stringify({ version: 3, records: {}, days: {}, firstDay: '2026-11-01' }), 'x.json').firstDay, '2026-11-01');
});

function countReads(target: string): { count: () => number; restore: () => void } {
  const promises = fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = promises.readFile;
  let reads = 0;
  promises.readFile = (...args) => { if (args[0] === target) reads++; return original(...args); };
  return { count: () => reads, restore: () => void (promises.readFile = original) };
}

test('a transaction reads the archive once, and does not write it when it already says what the store says', async () => {
  const { file } = await place({ version: 3, records: {}, days: {} });
  const first = await UsageStore.load(file);
  await first.transaction(async checkpoint => { first.addRecords([record('claude:m1'), record('claude:m2')]); await checkpoint(); await first.archive(); }, true);
  const archive = currentArchiveFile(file);
  const stamp = await fileStamp(archive);
  const second = await UsageStore.load(file);
  const reads = countReads(archive);
  try {
    await second.transaction(async checkpoint => { await checkpoint(); await second.archive(); }, true);
  } finally { reads.restore(); }
  assert.equal(reads.count(), 1);
  assert.equal(await fileStamp(archive), stamp);
});

test('two writers never make the union of archive and working records shrink', async () => {
  const { file } = await place({ version: 3, records: {}, days: {} });
  const writers = [await UsageStore.load(file), await UsageStore.load(file)];
  const ids = new Set<string>();
  const inArchive = async () => Object.keys((await loadArchive(file))?.records ?? {});
  const inWorking = async () => Object.keys((await UsageStore.load(file)).data.records);
  let seen = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const turn = round % 3 === 2 ? writers.map((_, i) => i) : [round % 2];
    await Promise.all(turn.map(i => {
      const id = `claude:r${round}w${i}`;
      ids.add(id);
      return writers[i].transaction(async checkpoint => { writers[i].addRecords([record(id)]); await checkpoint(); await writers[i].archive(); }, true);
    }));
    const [archived, working] = [new Set(await inArchive()), new Set(await inWorking())];
    for (const id of seen) { assert.ok(archived.has(id), `${id} left the archive`); assert.ok(working.has(id), `${id} left the working store`); }
    seen = new Set([...archived, ...working]);
  }
  assert.deepEqual([...seen].sort(), [...ids].sort());
  assert.deepEqual((await inArchive()).sort(), (await inWorking()).sort());
});

test('a working store that lost records gets them back from the archive without the archive shrinking', async () => {
  const { file } = await place({ version: 3, records: {}, days: {} });
  const a = await UsageStore.load(file);
  await a.transaction(async checkpoint => { a.addRecords([record('claude:m1'), record('claude:m2')]); await checkpoint(); await a.archive(); }, true);
  await fs.writeFile(file, JSON.stringify({ version: 3, records: { 'claude:m1': record('claude:m1') }, days: dayOf(1) }));
  await a.transaction(async checkpoint => { a.addRecords([record('claude:m3')]); await checkpoint(); await a.archive(); }, true);
  assert.deepEqual(Object.keys((await UsageStore.load(file)).data.records).sort(), ['claude:m1', 'claude:m2', 'claude:m3']);
  assert.deepEqual(Object.keys((await loadArchive(file))!.records!).sort(), ['claude:m1', 'claude:m2', 'claude:m3']);
});

test('a damaged archive stops loading with a typed error that names the file, and is never moved or rewritten', async () => {
  const { dir, file } = await place(writtenByEarlierBuild());
  const archive = currentArchiveFile(file);
  await fs.mkdir(path.dirname(archive));
  const damaged = ['{bad json', JSON.stringify({ version: 2, days: {}, records: {} }), JSON.stringify({ version: 3, days: {}, records: { x: { id: 'x' } } }), JSON.stringify({ version: 3, days: {}, records: {}, hiddenSessions: [1] })];
  for (const text of damaged) {
    await fs.writeFile(archive, text);
    const attempts = [
      () => UsageStore.recover(file, () => assert.fail('the archive must not be quarantined')),
      async () => (await UsageStore.load(file)).transaction(() => undefined),
      () => withDataHome(dir, () => initializeUsageStore(() => assert.fail('the archive must not be quarantined'))),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(() => undefined, (err: unknown) => err);
      assert.ok(error instanceof InvalidArchiveError, text);
      assert.equal(error.file, archive);
      assert.ok(error.message.includes(archive) && error.message.includes('README'), error.message);
    }
    assert.equal(await fs.readFile(archive, 'utf8'), text);
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.corrupt-')), []);
  }
});

test('log cursors are forgotten only when the log is gone and lies outside every source folder', async () => {
  const root = await temporaryDirectory('prune-files-');
  const inside = path.join(root, 'claude', 'projects'), elsewhere = path.join(root, 'old-setting');
  await fs.mkdir(inside, { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(elsewhere, 'still-there.jsonl'), '');
  const state = { size: 1, mtimeMs: 1, offset: 1 };
  const store = await UsageStore.load(path.join(root, 'usage-v3.json'));
  store.data.files = {
    [path.join(inside, 'gone-in-root.jsonl')]: state,
    [path.join(elsewhere, 'gone.jsonl')]: state,
    [path.join(elsewhere, 'still-there.jsonl')]: state,
    [path.join(root, 'claude-lookalike', 'gone.jsonl')]: state,
  };
  assert.equal(await store.pruneFiles([path.join(root, 'claude'), path.join(root, 'codex')]), 2);
  assert.deepEqual(Object.keys(store.data.files).map(key => path.relative(root, key)).sort(), [path.join('claude', 'projects', 'gone-in-root.jsonl'), path.join('old-setting', 'still-there.jsonl')]);
  await store.save();
  assert.equal(Object.keys((await UsageStore.load(path.join(root, 'usage-v3.json'))).data.files).length, 2);
  assert.equal(await store.pruneFiles([path.join(root, 'claude'), path.join(root, 'codex')]), 0, 'nothing more to forget');
});

test('the members that no longer have a caller are gone', () => {
  const proto = UsageStore.prototype as unknown as Record<string, unknown>;
  for (const name of ['prune', 'reset', 'setSessions', 'removeSessions', 'applySession']) assert.equal(proto[name], undefined, name);
  for (const name of ['archiveHistory', 'loadArchivedDays']) assert.equal((backup as Record<string, unknown>)[name], undefined, name);
});
