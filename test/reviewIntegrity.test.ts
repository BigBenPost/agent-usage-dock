import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseDbStepMetadata } from '../src/collectors/antigravity';
import { parseClaudeLine } from '../src/collectors/claudeCode';
import { codexCountId, parseCodexLine } from '../src/collectors/codex';
import { scanDsh } from '../src/collectors/dsh';
import type { DshResult } from '../src/collectors/dshParser';
import type { FileState } from '../src/collectors/lines';
import { acquireFileLock } from '../src/fileLock';
import { publishPrivateFile, sweepStale } from '../src/privateFiles';
import { canonicalRecords, preferredRecord } from '../src/reconcile';
import { refreshUsage } from '../src/scan';
import { InvalidStoreError, mergeData, parseStoreData, UsageStore } from '../src/store';
import type { UsageRecord } from '../src/types';
import { temporaryDirectory } from './temp';

const HOUR = 3_600_000;
const aged = async (target: string, ms = 3 * HOUR) => { const when = new Date(Date.now() - ms); await fs.utimes(target, when, when); };
const exists = (target: string) => fs.stat(target).then(() => true, () => false);

test('the sweep leaves the files and folders of other programs in a shared data folder alone', async () => {
  const root = await temporaryDirectory('sweep-shared-');
  const strangers = [
    path.join(root, 'render.4242.tmp'),
    path.join(root, `download.${randomUUID()}.tmp`),
    path.join(root, `report.json.4242.${randomUUID()}.tmp`),
    path.join(root, 'usage-v3.json.tmp'),
  ];
  for (const file of strangers) await fs.writeFile(file, 'someone else');
  const cache = path.join(root, 'cache.lock.stale-run');
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, 'entry'), 'someone else');
  const notes = path.join(root, `notes.lock.stale-1-${randomUUID()}`);
  await fs.mkdir(notes);
  for (const target of [...strangers, cache, notes]) await aged(target);
  await sweepStale([root]);
  for (const target of [...strangers, cache, notes]) assert.equal(await exists(target), true, target);
});

test('the sweep still removes the extension\'s own leftovers, whatever the file they were writing', async () => {
  const root = await temporaryDirectory('sweep-own-');
  const own = [
    `cli.js.${process.pid}.${randomUUID()}.tmp`,
    `dshWorker-1.3.0.js.${process.pid}.${randomUUID()}.tmp`,
    `usage-v3.json.${process.pid}.${randomUUID()}.tmp`,
    `usage-v3-pre-rebuild-2026-11-24T10-00-00-000Z.json.${process.pid}.tmp`,
    `cli.js.lock.stale-${process.pid}-${randomUUID()}`,
  ].map(name => path.join(root, name));
  for (const target of own) {
    if (target.includes('.lock.stale-')) { await fs.mkdir(target); await fs.writeFile(path.join(target, 'owner'), 'x'); }
    else await fs.writeFile(target, 'x');
    await aged(target);
  }
  await sweepStale([root]);
  for (const target of own) assert.equal(await exists(target), false, target);
});

test('a writer whose lock was reclaimed after its last check cannot replace what the new owner committed', async () => {
  const dir = await temporaryDirectory('lock-commit-');
  const file = path.join(dir, 'usage-v3.json');
  await fs.writeFile(file, 'first');
  const old = await acquireFileLock(file);
  const paused = Object.assign(async () => {
    await old.assertHeld();
    const lock = `${file}.lock`;
    await fs.rename(lock, `${lock}.stale-1-${randomUUID()}`);
    const next = await acquireFileLock(file);
    await publishPrivateFile(file, 'newer', next.assertHeld);
    await next.release();
  }, { stage: old.assertHeld.stage });
  await assert.rejects(publishPrivateFile(file, 'older', paused), /lost the lock/);
  assert.equal(await fs.readFile(file, 'utf8'), 'newer');
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  await old.release();
});

test('a commit under a held lock stages inside the lock folder and leaves nothing behind', async () => {
  const dir = await temporaryDirectory('lock-stage-');
  const file = path.join(dir, 'usage-v3.json');
  const lock = await acquireFileLock(file);
  let sawStage: string[] = [];
  const watching = Object.assign(async () => { sawStage = await fs.readdir(`${file}.lock`); await lock.assertHeld(); }, { stage: lock.assertHeld.stage });
  await publishPrivateFile(file, 'content', watching);
  assert.equal(await fs.readFile(file, 'utf8'), 'content');
  assert.ok(sawStage.some(name => name.startsWith('usage-v3.json.') && name.endsWith('.tmp')), sawStage.join(', '));
  assert.deepEqual((await fs.readdir(`${file}.lock`)).sort(), ['info', 'owner']);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['usage-v3.json', 'usage-v3.json.lock']);
  await lock.release();
});

const stamp = '2026-11-22T12:00:00Z';
const t0 = Date.parse(stamp);
const unusedState = () => ({ offset: 0, size: 0, mtimeMs: 0 });
const byId = (records: UsageRecord[]) => Object.fromEntries(records.map(record => [record.id, record]));
const usage = { input: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 20 };
const codexFact = (id: string, session: string, ts: number, evidence: NonNullable<UsageRecord['evidence']>): UsageRecord =>
  ({ id, source: 'codex', day: '2026-11-22', model: 'gpt-6.2-sol', tokens: usage, session, ts, evidence });
const counterAt = (session: string, total: number, ts: number, extra: object = {}): UsageRecord =>
  codexFact(codexCountId(session, total), session, ts, { kind: 'transcript', revision: 0, parserVersion: 2, codexTurn: 'turn', ...extra });
const responseAt = (id: string, session: string, total: number | undefined, ts: number): UsageRecord =>
  codexFact(`codex:${id}`, session, ts, { kind: 'transcript', revision: ts, parserVersion: 2, codexTurn: 'turn', ...(total ? { codexTotal: total } : {}) });

test('a response paired with its counter is not paired again with a later counter of the same turn and usage', () => {
  const problems: string[] = [];
  const first = canonicalRecords(byId([responseAt('r1', 's', 120, t0), counterAt('s', 120, t0 + 1)]), problems);
  assert.deepEqual(Object.keys(first), ['codex:r1']);
  assert.equal(first['codex:r1'].evidence?.codexAlias?.total, 120);
  const later = canonicalRecords({ ...first, ...byId([counterAt('s', 240, t0 + 60_000)]) }, problems);
  assert.deepEqual(Object.keys(later).sort(), ['codex:count:s:240', 'codex:r1']);
  assert.deepEqual(problems, []);
});

test('a response and a counter whose cumulative totals differ are two requests, whatever their turn, time and usage', () => {
  const problems: string[] = [];
  const facts = canonicalRecords(byId([responseAt('r1', 's', 120, t0), counterAt('s', 240, t0)]), problems);
  assert.deepEqual(Object.keys(facts).sort(), ['codex:count:s:240', 'codex:r1']);
  assert.deepEqual(problems, []);
});

test('a second-level fork does not count the original request again once the first fork\'s copy is gone', () => {
  const problems: string[] = [];
  const settled = canonicalRecords(byId([
    responseAt('resp-parent', 'parent', 120, t0), counterAt('parent', 120, t0 + 1),
    counterAt('child', 120, t0 + 1, { codexForkFrom: 'parent' }),
  ]), problems);
  assert.deepEqual(Object.keys(settled), ['codex:resp-parent']);
  const facts = canonicalRecords({ ...settled, ...byId([
    counterAt('grandchild', 120, t0 + 1, { codexForkFrom: 'child' }),
    counterAt('grandchild', 360, t0 + 120_000),
  ]) }, problems);
  assert.deepEqual(Object.keys(facts).sort(), ['codex:count:grandchild:360', 'codex:resp-parent']);
  assert.deepEqual(problems, []);
});

test('the same holds when the original is a counter without a response, and a request of the fork itself still counts', () => {
  const problems: string[] = [];
  const settled = canonicalRecords(byId([
    counterAt('parent', 120, t0),
    counterAt('child', 120, t0, { codexForkFrom: 'parent' }),
    counterAt('child', 240, t0 + 60_000),
  ]), problems);
  assert.deepEqual(Object.keys(settled).sort(), ['codex:count:child:240', 'codex:count:parent:120']);
  const facts = canonicalRecords({ ...settled, ...byId([
    counterAt('grandchild', 120, t0, { codexForkFrom: 'child' }),
    counterAt('grandchild', 240, t0 + 60_000, { codexForkFrom: 'child' }),
    counterAt('grandchild', 480, t0 + 120_000),
  ]) }, problems);
  assert.deepEqual(Object.keys(facts).sort(), ['codex:count:child:240', 'codex:count:grandchild:480', 'codex:count:parent:120']);
  assert.deepEqual(problems, []);
});

test('two forks of one thread whose parent is gone do not make each other disappear', () => {
  const facts = canonicalRecords(byId([
    counterAt('left', 120, t0, { codexForkFrom: 'gone' }),
    counterAt('right', 120, t0, { codexForkFrom: 'gone' }),
  ]));
  assert.equal(Object.keys(facts).length, 2);
});

test('a Codex usage record without a payload is an error, so a strict flush is not Ready', async () => {
  assert.throws(() => parseCodexLine(JSON.stringify({ type: 'token_usage_record', timestamp: stamp }), unusedState()), /no payload/);
  assert.equal(parseCodexLine(JSON.stringify({ type: 'event_msg', timestamp: stamp, note: 'token_count' }), unusedState()), undefined);
  const root = await temporaryDirectory('codex-no-payload-');
  const codexHome = path.join(root, 'codex');
  await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(codexHome, 'sessions', 'rollout.jsonl'), JSON.stringify({ type: 'token_usage_record', timestamp: stamp }) + '\n');
  const file = path.join(root, 'usage-v3.json');
  const result = await refreshUsage(await UsageStore.load(file), file, undefined, false, { source: 'codex', strict: true, codexHome });
  assert.deepEqual(result.sources, [{ source: 'codex', status: 'incomplete' }]);
  assert.match(result.problems.join('\n'), /no payload/);
});

const claudeLine = (usageFields: object) => JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: stamp, message: { id: 'm', model: 'claude-sonnet-5-5', usage: usageFields } });

test('a streamed update that reports only some counts does not erase the others, whichever copy arrives first', async () => {
  const full = parseClaudeLine(claudeLine({ input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 5 }), unusedState())!;
  const delta = parseClaudeLine(claudeLine({ output_tokens: 30 }), unusedState())!;
  const expected = { input: 100, cacheRead: 40, cacheWrite: 10, cacheWrite1h: 0, output: 30 };
  assert.deepEqual(preferredRecord(full, delta), preferredRecord(delta, full));
  assert.deepEqual(preferredRecord(full, delta).tokens, expected);
  for (const order of [[full, delta], [delta, full]]) {
    const store = await UsageStore.load(path.join(await temporaryDirectory('claude-partial-'), 'usage-v3.json'));
    for (const copy of order) store.addRecords([copy]);
    assert.deepEqual(store.data.records['claude:m'].tokens, expected);
    assert.equal(store.data.days['2026-11-22'].claude!['claude-sonnet-5-5'].requests, 1);
    assert.equal(store.data.days['2026-11-22'].claude!['claude-sonnet-5-5'].input, 100);
  }
});

test('a ledger whose last-scan report is damaged loads without it, and a time outside the calendar is refused', () => {
  const base = { version: 3, records: {}, days: {}, files: {} };
  assert.equal(parseStoreData(JSON.stringify({ ...base, health: {} }), 'memory').health, undefined);
  assert.equal(parseStoreData(JSON.stringify({ ...base, health: { root: '/x', attemptedAt: 'never', problems: [] } }), 'memory').health, undefined);
  const sound = { root: '/x', attemptedAt: stamp, succeededAt: stamp, problems: ['one'] };
  assert.deepEqual(parseStoreData(JSON.stringify({ ...base, health: sound }), 'memory').health, sound);
  const far = { id: 'claude:m', source: 'claude', day: '2026-11-22', model: 'claude-sonnet-5-5', tokens: usage, ts: 1e300 };
  assert.throws(() => parseStoreData(JSON.stringify({ ...base, records: { 'claude:m': far } }), 'memory'), InvalidStoreError);
});

test('a request with a time outside the calendar is rejected by the store instead of failing the dashboard later', async () => {
  const store = await UsageStore.load(path.join(await temporaryDirectory('far-time-'), 'usage-v3.json'));
  store.addRecords([{ id: 'claude:m', source: 'claude', day: '2026-11-22', model: 'claude-sonnet-5-5', tokens: usage, ts: 8.64e15 }]);
  assert.deepEqual(store.rejected, [{ id: 'claude:m', reason: 'invalid timestamp' }]);
  assert.deepEqual(store.data.records, {});
});

test('importing a ledger keeps the scan report and the collection status of the store it joins', async () => {
  const dir = await temporaryDirectory('import-health-');
  const file = path.join(dir, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const health = { root: '/agy', attemptedAt: stamp, succeededAt: stamp, problems: ['Codex: unreadable'] };
  const sourceHealth = { codex: { root: '/codex', status: 'incomplete' as const, attemptedAt: stamp, problems: ['Codex: unreadable'] } };
  await store.transaction(() => { store.data.health = health; store.data.sourceHealth = sourceHealth; store.markDirty(); });
  const ledger = path.join(dir, 'cursor-usage.json');
  await fs.writeFile(ledger, JSON.stringify({ version: 1, events: [[t0, 'composer-2', 10, 5, 0, 0, 0, 0, 'conv-1']] }));
  assert.equal(await store.absorb(ledger), true);
  const saved = (await UsageStore.load(file)).data;
  assert.equal(Object.keys(saved.records).length, 1);
  assert.deepEqual(saved.health, health);
  assert.deepEqual(saved.sourceHealth, sourceHealth);
});

test('a database step with token counts but no time is an error, while a step without usage is still skipped', () => {
  const stepWith = (counts: string) => Buffer.from(counts, 'hex');
  assert.throws(() => parseDbStepMetadata(stepWith('4a0708ff4d10071800'), 'cid', 1), /no time/);
  assert.throws(() => parseDbStepMetadata(stepWith('0a004a0708ff4d10071800'), 'cid', 1), /no time/);
  assert.equal(parseDbStepMetadata(stepWith('4a0308ff4d'), 'cid', 1), undefined);
  assert.equal(parseDbStepMetadata(stepWith('0a0608ad9eafd706'), 'cid', 1), undefined);
  assert.equal(parseDbStepMetadata(stepWith('4a0708ff4d10001800'), 'cid', 1), undefined, 'a step of zero tokens has nothing to lose');
  assert.equal(parseDbStepMetadata(stepWith('0a0608ad9eafd7064a0708ff4d10071800'), 'cid', 1)?.tokens.input, 7);
});

const dshRecord = (session: string): UsageRecord => ({
  id: `dsh:${session}:1`, source: 'dsh', day: '2026-11-16', model: 'deepseek-flash', provider: 'deepseek', tokens: usage, session, ts: Date.parse('2026-11-16T01:00:00Z'),
  evidence: { kind: 'transcript', revision: 1, parserVersion: 1, dshCall: { version: 1, sequences: [1] } },
});

test('one unreadable DSH folder is reported and the rest of the tree is still read', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const home = await temporaryDirectory('dsh-unreadable-');
  const good = path.join(home, 'sessions', 'a', 'one', 'session.v4.jsonl.zstd');
  const blocked = path.join(home, 'sessions', 'b');
  const hidden = path.join(blocked, 'two', 'session.v4.jsonl.zstd');
  await fs.mkdir(path.dirname(good), { recursive: true });
  await fs.mkdir(path.dirname(hidden), { recursive: true });
  await fs.writeFile(good, 'x');
  await fs.writeFile(hidden, 'x');
  const states: Record<string, FileState> = { [hidden]: { size: 1, offset: 0, mtimeMs: 1, fingerprint: 'earlier', session: 'two' } };
  const read = async (): Promise<DshResult> => ({ records: [dshRecord('one')], problems: [], session: 'one' });
  await fs.chmod(blocked, 0o000);
  try {
    const result = await scanDsh(home, states, undefined, read);
    assert.deepEqual(result.records.map(record => record.id), ['dsh:one:1']);
    assert.match(result.problems.join('\n'), /cannot list .*[\\/]b: EACCES/);
    assert.ok(states[good], 'the readable log is collected');
    assert.ok(states[hidden], 'the state of a log inside the unreadable folder is kept for the next scan');
  } finally { await fs.chmod(blocked, 0o755); }
});

const cursorEvent = (conversation: string, time = t0) => [time, 'composer-2', 10, 5, 0, 0, 0, 0, conversation];
const cursorSnapshot = (...conversations: string[]) => parseStoreData(JSON.stringify({ version: 1, events: conversations.map(conversation => cursorEvent(conversation)) }), 'cursor-usage.json');
const sessionsOf = (data: { records: Record<string, UsageRecord> }) => Object.values(data.records).map(record => record.session).sort();

test('two conversations with the same millisecond, model and counts stay two requests, whatever the order of the snapshots', () => {
  const alone = mergeData(cursorSnapshot('alpha'), cursorSnapshot('bravo'));
  assert.deepEqual(sessionsOf(alone), ['alpha', 'bravo']);
  const reversed = mergeData(cursorSnapshot('alpha'), cursorSnapshot('bravo', 'alpha'));
  assert.deepEqual(sessionsOf(reversed), ['alpha', 'bravo']);
  const again = mergeData(reversed, cursorSnapshot('bravo', 'alpha'));
  assert.deepEqual(sessionsOf(again), ['alpha', 'bravo']);
  assert.deepEqual(sessionsOf(mergeData(again, cursorSnapshot('alpha', 'bravo'))), ['alpha', 'bravo']);
  assert.equal(Object.values(again.records).every(record => record.id.startsWith('cursor:')), true);
});

test('identical requests of one conversation still count each, and importing them again adds nothing', () => {
  const twice = cursorSnapshot('alpha', 'alpha');
  assert.equal(Object.keys(twice.records).length, 2);
  assert.equal(Object.keys(mergeData(twice, cursorSnapshot('alpha', 'alpha')).records).length, 2);
  assert.equal(Object.keys(mergeData(twice, cursorSnapshot('alpha', 'alpha', 'alpha')).records).length, 3);
});

test('a request first imported without its conversation takes it from a later snapshot instead of counting twice', () => {
  const merged = mergeData(cursorSnapshot(''), cursorSnapshot('alpha'));
  assert.deepEqual(Object.values(merged.records).map(record => record.session), ['alpha']);
  assert.deepEqual(Object.values(mergeData(cursorSnapshot('alpha'), cursorSnapshot('')).records).map(record => record.session), ['alpha']);
});

test('several processes committing through the lock one after another lose no write and leave nothing behind', async () => {
  const dir = await temporaryDirectory('lock-publish-race-');
  const worker = path.join(__dirname, 'publishWorker.js');
  const [workers, rounds] = [4, 6];
  const exits = await Promise.all(Array.from({ length: workers }, () => new Promise<number | null>(resolve => {
    spawn(process.execPath, [worker, dir, String(rounds)], { stdio: 'ignore' }).on('exit', resolve);
  })));
  assert.deepEqual(exits, Array(workers).fill(0));
  assert.equal(await fs.readFile(path.join(dir, 'errors.log'), 'utf8').catch(() => ''), '');
  assert.equal(Number(await fs.readFile(path.join(dir, 'counter.txt'), 'utf8')), workers * rounds);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.lock') || name.endsWith('.tmp')), []);
});
