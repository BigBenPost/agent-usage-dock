import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { currentArchiveFile } from '../src/backup';
import { fileStamp } from '../src/privateFiles';
import { refreshUsage } from '../src/scan';
import { UsageStore } from '../src/store';
import type { UsageRecord } from '../src/types';
import { temporaryDirectory } from './temp';

const call = (i: number, revision: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  id: `dsh:s1:${i}`, source: 'dsh', provider: 'deepseek', session: 's1', model: 'deepseek-v4-pro', day: '2026-11-20',
  ts: Date.UTC(2026, 10, 20, 2, i % 60), tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cacheWrite1h: 0 },
  evidence: { kind: 'transcript', revision, parserVersion: 4, dshCall: { version: 1, sequences: [i] } }, ...over,
});
const calls = (n: number, revision: number) => Array.from({ length: n }, (_, i) => call(i, revision));

async function freshStore(): Promise<{ store: UsageStore; file: string }> {
  const file = path.join(await temporaryDirectory('revision-churn-'), 'usage-v3.json');
  return { store: await UsageStore.load(file), file };
}

test('identical records with a newer revision are not changes and do not dirty the store', async () => {
  const { store, file } = await freshStore();
  assert.equal(store.addRecords(calls(500, 1000)), 500);
  await store.save();
  const saved = await fileStamp(file);
  assert.equal(store.addRecords(calls(500, 1000)), 0);
  assert.equal(store.addRecords(calls(500, 2000)), 0);
  await store.save();
  assert.equal(await fileStamp(file), saved, 'a clean store writes nothing');
  assert.equal(store.data.records['dsh:s1:7'].evidence?.revision, 2000, 'the newer revision is kept in memory');
});

test('a revision-only update persists with the next save', async () => {
  const { store, file } = await freshStore();
  store.addRecords(calls(3, 1000));
  await store.save();
  assert.equal(store.addRecords(calls(3, 2000)), 0);
  store.markDirty();
  await store.save();
  const stored = JSON.parse(await fs.readFile(file, 'utf8')).records;
  assert.deepEqual(Object.values<UsageRecord>(stored).map(r => r.evidence?.revision), [2000, 2000, 2000]);
});

test('a real difference wins with a higher revision, including a downward correction, and persists', async () => {
  const { store, file } = await freshStore();
  store.addRecords([call(0, 1)]);
  await store.save();
  const corrected = call(0, 2, { tokens: { input: 100, output: 4, cacheRead: 5, cacheWrite: 0, cacheWrite1h: 0 } });
  assert.equal(store.addRecords([corrected]), 1);
  await store.save();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records['dsh:s1:0'].tokens.output, 4);
  assert.equal(Object.values(store.data.days['2026-11-20'].dsh!).reduce((sum, b) => sum + b.output, 0), 4);
  assert.equal(store.addRecords([call(0, 1)]), 0, 'an older revision never reverts the correction');
});

test('a record that differs only in key order or an undefined field is the same fact', async () => {
  const { store } = await freshStore();
  const first = call(0, 1);
  assert.equal(store.addRecords([first]), 1);
  const reordered = JSON.parse(JSON.stringify(first, (_key, value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)));
  reordered.title = undefined;
  reordered.evidence.revision = 99;
  assert.equal(store.addRecords([reordered]), 0);
});

async function transcriptFixture() {
  const root = await temporaryDirectory('revision-pipeline-');
  const home = path.join(root, 'agy');
  const log = path.join(home, 'brain', 'c1', '.system_generated', 'logs', 'transcript.jsonl');
  await fs.mkdir(path.dirname(log), { recursive: true });
  const line = (i: number) => JSON.stringify({ step_index: i, created_at: new Date(Date.UTC(2026, 10, 20) + i * 1000).toISOString(), model: 'gemini-3.8-flash', input_tokens: 100 + i, output_tokens: 10, cache_read_tokens: 5 });
  await fs.writeFile(log, Array.from({ length: 400 }, (_, i) => line(i)).join('\n') + '\n');
  const file = path.join(root, 'usage-v3.json');
  return { root, home, log, file, line, store: await UsageStore.load(file) };
}

test('through the real pipeline, a log touched without changes reports nothing and leaves the archive alone, and one appended line is one change', async () => {
  const { home, log, file, line, store } = await transcriptFixture();
  const poll = () => refreshUsage(store, file, home, false, { source: 'antigravity' });
  assert.equal((await poll()).changed, 400);
  const archive = await fileStamp(currentArchiveFile(file));
  assert.equal((await poll()).changed, 0);

  const later = new Date(Date.now() + 60_000);
  await fs.utimes(log, later, later);
  assert.equal((await poll()).changed, 0, 'same content, newer mtime');
  assert.equal(await fileStamp(currentArchiveFile(file)), archive);

  await fs.appendFile(log, line(400) + '\n');
  assert.equal((await poll()).changed, 1, 'only the new line');
  assert.notEqual(await fileStamp(currentArchiveFile(file)), archive);
});
