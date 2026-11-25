import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { fullPassInterval, loadConversationMetadata, scanAntigravity } from '../src/collectors/antigravity';
import { FileState } from '../src/collectors/lines';
import { SqliteSession } from '../src/collectors/sqlite';
import { UsageRecord } from '../src/types';
import { temporaryDirectory } from './temp';

let DatabaseSync: (new (file: string) => { exec(sql: string): void; close(): void }) | undefined;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* the sqlite3 command is the writer then */ }
const sqlite3 = process.env.AGY_SQLITE3 || 'sqlite3';
const probe = spawnSync(sqlite3, ['--version']);
const haveWriter = Boolean(DatabaseSync) || (!probe.error && probe.status === 0);

function writeDb(file: string, ...statements: string[]): void {
  const sql = statements.join(';\n');
  if (DatabaseSync) {
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
    return;
  }
  const result = spawnSync(sqlite3, [file, sql], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function needWriter(t: TestContext): boolean {
  if (haveWriter) return true;
  assert.notEqual(process.env.AGY_TEST_REQUIRE_SQLITE, '1', 'CI must provide node:sqlite or the sqlite3 command');
  t.skip('neither node:sqlite nor the sqlite3 command is available to write the fixture');
  return false;
}

const varint = (n: number): number[] => { const out: number[] = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (num: number, wire: number, payload: number[]) => [...varint(num * 8 + wire), ...payload];
const message = (num: number, data: number[]) => field(num, 2, [...varint(data.length), ...data]);
const counter = (num: number, value: number) => field(num, 0, varint(value));
const stepBytes = (tsSec: number, input = 100, output = 20) => Buffer.from([...message(1, counter(1, tsSec)), ...message(9, [...counter(1, 1318), ...counter(2, input), ...counter(3, output)])]);
const GOOD = stepBytes(Date.parse('2026-11-16T10:00:00Z') / 1000);
const BAD = Buffer.from([10, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
const hex = (buffer: Buffer) => `X'${buffer.toString('hex')}'`;
const TABLE = 'CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)';
const insert = (idx: number, metadata: Buffer, type = 15) => `INSERT INTO steps VALUES (${idx}, ${type}, ${hex(metadata)})`;
const steps = (from: number, to: number, bad: Record<number, Buffer> = {}) => Array.from({ length: to - from + 1 }, (_, i) => insert(from + i, bad[from + i] ?? GOOD));

async function layout() {
  const root = await temporaryDirectory('agy-db-');
  const conversations = path.join(root, 'conversations');
  await fs.mkdir(conversations);
  const scan = async (files: Record<string, FileState>, options: { strict?: boolean } = {}) => {
    const records: UsageRecord[] = [], problems: string[] = [];
    const changed = await scanAntigravity(path.join(root, 'brain'), path.join(root, 'conversation_summaries.db'), files, r => records.push(r), problems, conversations, options);
    return { records, problems, changed };
  };
  return { root, conversations, scan };
}

function countWorkers() {
  const workerThreads = require('node:worker_threads') as { Worker: typeof import('node:worker_threads').Worker };
  const RealWorker = workerThreads.Worker;
  const counter = { spawned: 0, stop: () => { workerThreads.Worker = RealWorker; } };
  workerThreads.Worker = class extends RealWorker { constructor(...args: ConstructorParameters<typeof RealWorker>) { counter.spawned++; super(...args); } };
  return counter;
}

test('an undecodable step is skipped with a persistent problem, the other steps are read and the cursor advances', async t => {
  if (!needWriter(t)) return;
  const { conversations, scan } = await layout();
  const db = path.join(conversations, 'conv-bad.db');
  writeDb(db, TABLE, ...steps(1, 100, { 50: BAD }));
  const files: Record<string, FileState> = {};
  const first = await scan(files);
  assert.equal(first.records.length, 99);
  assert.ok(!first.records.some(r => r.id === 'antigravity:conv-bad:50'));
  assert.equal(files[db].dbCursor, 100);
  assert.equal(files[db].skipped?.count, 1);
  assert.equal(files[db].skipped?.samples[0].offset, 50);
  assert.deepEqual(first.problems, [`Antigravity: 1 unreadable step skipped in ${db} (step 50: ${files[db].skipped!.samples[0].reason}); later usage is still collected.`]);
  assert.match(files[db].skipped!.samples[0].reason, /protobuf/i);

  const workers = countWorkers();
  try {
    const again = await scan(files);
    assert.deepEqual(again.problems, first.problems);
    assert.deepEqual(again.records, []);
    assert.equal(again.changed, 0);
    assert.equal(workers.spawned, 0);
  } finally { workers.stop(); }
});

test('a step with an out-of-range timestamp is skipped like any undecodable step', async t => {
  if (!needWriter(t)) return;
  const { conversations, scan } = await layout();
  const db = path.join(conversations, 'conv-time.db');
  writeDb(db, TABLE, insert(1, GOOD), insert(2, stepBytes(253402300800)), insert(3, stepBytes(Number.MAX_SAFE_INTEGER)), insert(4, GOOD));
  const files: Record<string, FileState> = {};
  const { records, problems } = await scan(files);
  assert.deepEqual(records.map(r => r.id), ['antigravity:conv-time:1', 'antigravity:conv-time:4']);
  assert.equal(files[db].skipped?.count, 2);
  assert.match(problems[0], /2 unreadable steps skipped in .* \(first at step 2: .*timestamp.*\)/);
});

test('an incremental pass keeps older skipped steps; a full pass recounts them', async t => {
  if (!needWriter(t)) return;
  const { conversations, scan } = await layout();
  const db = path.join(conversations, 'conv-long.db');
  writeDb(db, TABLE, ...steps(1, 400, { 5: BAD }));
  const files: Record<string, FileState> = {};
  await scan(files);
  assert.equal(files[db].skipped?.count, 1);

  writeDb(db, ...steps(401, 420, { 410: BAD }));
  const incremental = await scan(files);
  assert.deepEqual(incremental.records.map(r => r.id).slice(-1), ['antigravity:conv-long:420']);
  assert.ok(incremental.records.length < 276);
  assert.deepEqual(files[db].skipped?.samples.map(s => s.offset), [5, 410]);
  assert.equal(files[db].skipped?.count, 2);
  assert.equal(files[db].dbCursor, 420);

  writeDb(db, `UPDATE steps SET metadata = ${hex(GOOD)} WHERE idx = 5`);
  files[db].lastFullScan = Date.now() - 3 * 3600_000;
  const full = await scan(files);
  assert.equal(full.records.length, 419);
  assert.deepEqual(files[db].skipped?.samples.map(s => s.offset), [410]);
  assert.equal(files[db].skipped?.count, 1);
});

test('strict reads still fail on an undecodable step and store nothing', async t => {
  if (!needWriter(t)) return;
  const { conversations, scan } = await layout();
  const db = path.join(conversations, 'conv-strict.db');
  writeDb(db, TABLE, ...steps(1, 10, { 5: BAD }));
  const files: Record<string, FileState> = {};
  const { records, problems } = await scan(files, { strict: true });
  assert.deepEqual(records, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^cannot read Antigravity conversation DB .*conv-strict\.db: /);
  assert.deepEqual(files, {});
});

test('a scan pass uses one worker for all databases and pages, and none when nothing changed', async t => {
  if (!needWriter(t)) return;
  const { root, conversations, scan } = await layout();
  for (const name of ['conv-a', 'conv-b', 'conv-c']) writeDb(path.join(conversations, `${name}.db`), TABLE, ...steps(1, 300));
  writeDb(path.join(root, 'conversation_summaries.db'), 'CREATE TABLE conversation_summaries(conversation_id TEXT, title TEXT, workspace_uris TEXT, last_modified_time TEXT)', "INSERT INTO conversation_summaries VALUES ('conv-a', 'A title', '[\"file:///work/app\"]', '2026-11-01T00:00:00Z')");
  const workers = countWorkers();
  try {
    const files: Record<string, FileState> = {};
    const cold = await scan(files);
    assert.equal(cold.records.length, 900);
    assert.deepEqual(cold.problems, []);
    assert.equal(workers.spawned, 1);
    assert.equal(cold.records.find(r => r.session === 'conv-a')?.title, 'A title');
    assert.equal(cold.records.find(r => r.session === 'conv-a')?.project, 'app');

    const idle = await scan(files);
    assert.deepEqual(idle.records, []);
    assert.equal(workers.spawned, 1);
  } finally { workers.stop(); }
});

test('the database full pass interval carries a fixed per-file jitter of 0 to 20 percent', () => {
  const tenMinutes = 10 * 60_000;
  const intervals = Array.from({ length: 150 }, (_, i) => fullPassInterval(`/conversations/conv-${i}.db`));
  for (const interval of intervals) assert.ok(interval >= tenMinutes && interval < tenMinutes * 1.2, String(interval));
  assert.equal(fullPassInterval('/conversations/conv-7.db'), intervals[7]);
  assert.ok(Math.max(...intervals) - Math.min(...intervals) > tenMinutes * 0.15);
  assert.ok(new Set(intervals).size > 100);
});

test('databases that were read together do not all take their full pass in the same poll', async t => {
  if (!needWriter(t)) return;
  const { conversations, scan } = await layout();
  const names = Array.from({ length: 200 }, (_, i) => `conv-${i}`);
  const early = names.find(name => fullPassInterval(path.join(conversations, `${name}.db`)) < 10.3 * 60_000)!;
  const late = names.find(name => fullPassInterval(path.join(conversations, `${name}.db`)) > 11.7 * 60_000)!;
  for (const name of [early, late]) writeDb(path.join(conversations, `${name}.db`), TABLE, ...steps(1, 3));
  const files: Record<string, FileState> = {};
  await scan(files);
  for (const state of Object.values(files)) state.lastFullScan = Date.now() - 10.5 * 60_000;
  const next = await scan(files);
  assert.deepEqual([...new Set(next.records.map(r => r.session))], [early]);
});

test('conversation metadata is queried once per file revision, and empty titles or projects become undefined', async t => {
  if (!needWriter(t)) return;
  const root = await temporaryDirectory('agy-meta-');
  const file = path.join(root, 'conversation_summaries.db');
  const insertRow = (id: string, title: string, uris: string, modified: string) => `INSERT INTO conversation_summaries VALUES ('${id}', '${title}', '${uris}', '${modified}')`;
  writeDb(file, 'CREATE TABLE conversation_summaries(conversation_id TEXT, title TEXT, workspace_uris TEXT, last_modified_time TEXT)',
    insertRow('c1', 'First title', '["file:///work/proj"]', '2026-11-01T00:00:00Z'),
    insertRow('c2', '', '["file:///"]', ''),
    insertRow('c3', '   ', '[]', ''));
  const workers = countWorkers();
  try {
    const first = await loadConversationMetadata(file);
    assert.equal(workers.spawned, 1);
    assert.deepEqual(first.get('c1'), { title: 'First title', project: 'proj', lastModifiedMs: Date.parse('2026-11-01T00:00:00Z') });
    assert.deepEqual(first.get('c2'), { title: undefined, project: undefined, lastModifiedMs: 0 });
    assert.deepEqual(first.get('c3'), { title: undefined, project: undefined, lastModifiedMs: 0 });

    assert.equal(await loadConversationMetadata(file), first);
    assert.equal(workers.spawned, 1);

    await new Promise(resolve => setTimeout(resolve, 25));
    writeDb(file, "UPDATE conversation_summaries SET title = 'Renamed' WHERE conversation_id = 'c1'");
    const changed = await loadConversationMetadata(file);
    assert.notEqual(changed, first);
    assert.equal(changed.get('c1')?.title, 'Renamed');
    assert.equal(workers.spawned, 2);
  } finally { workers.stop(); }
  assert.equal((await loadConversationMetadata(path.join(root, 'missing.db'))).size, 0);
});

test('a SQLite session keeps one worker across queries, survives a failed query and refuses work once closed', async t => {
  if (!needWriter(t)) return;
  const root = await temporaryDirectory('agy-session-');
  const good = path.join(root, 'good.db');
  const bad = path.join(root, 'bad.db');
  writeDb(good, TABLE, ...steps(1, 3));
  await fs.writeFile(bad, 'not a database, just text');
  const workers = countWorkers();
  const session = new SqliteSession();
  try {
    assert.equal((await session.rows(good, 'SELECT idx FROM steps')).length, 3);
    await assert.rejects(session.rows(bad, 'SELECT idx FROM steps'));
    assert.equal((await session.rows(good, 'SELECT idx FROM steps WHERE idx > 1')).length, 2);
    const [left, right] = await Promise.all([session.rows(good, 'SELECT count(*) AS n FROM steps'), session.rows(good, 'SELECT max(idx) AS n FROM steps')]);
    assert.deepEqual([left[0].n, right[0].n], [3, 3]);
    assert.equal(workers.spawned, 1);
  } finally {
    await session.close();
    workers.stop();
  }
  await assert.rejects(session.rows(good, 'SELECT 1'), /closed/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(new SqliteSession('auto', aborted.signal).rows(good, 'SELECT 1'));
});

test('symlinked conversation databases are read once under their real name, links to nowhere are ignored', { skip: process.platform === 'win32' }, async t => {
  if (!needWriter(t)) return;
  const { root, conversations, scan } = await layout();
  const elsewhere = path.join(root, 'elsewhere');
  await fs.mkdir(elsewhere);
  writeDb(path.join(conversations, 'conv-real.db'), TABLE, ...steps(1, 2));
  writeDb(path.join(elsewhere, 'conv-moved.db'), TABLE, ...steps(1, 3));
  await fs.symlink(path.join(elsewhere, 'conv-moved.db'), path.join(conversations, 'conv-moved.db'));
  await fs.symlink(path.join(conversations, 'conv-real.db'), path.join(conversations, 'aaa-alias.db'));
  await fs.symlink(path.join(root, 'nowhere.db'), path.join(conversations, 'conv-dangling.db'));
  const files: Record<string, FileState> = {};
  const { records, problems } = await scan(files);
  assert.deepEqual(problems, []);
  assert.deepEqual([...new Set(records.map(r => r.session))].sort(), ['conv-moved', 'conv-real']);
  assert.equal(records.length, 5);
  assert.deepEqual(Object.keys(files).sort(), [path.join(conversations, 'conv-moved.db'), path.join(conversations, 'conv-real.db')]);
});
