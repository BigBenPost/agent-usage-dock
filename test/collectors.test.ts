import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizeAntigravityModel, parseAntigravityLine } from '../src/collectors/antigravity';
import { FileState, readNewLines, safeModel, scanDir, UNKNOWN_MODEL } from '../src/collectors/lines';

async function tmpDir(): Promise<string> {
  return temporaryDirectory('ai-usage-test-');
}

async function collect(file: string, prev?: FileState): Promise<{ lines: string[]; state: FileState }> {
  const lines: string[] = [];
  const state = await readNewLines(file, prev, (l) => lines.push(l));
  return { lines, state };
}

test('readNewLines holds back a partial last line until it is completed', async () => {
  const file = path.join(await tmpDir(), 'a.jsonl');
  await fs.writeFile(file, 'one\ntw');
  const first = await collect(file);
  assert.deepEqual(first.lines, ['one']);
  assert.equal(first.state.offset, 4);

  await fs.appendFile(file, 'o\nthree\n');
  const second = await collect(file, first.state);
  assert.deepEqual(second.lines, ['two', 'three']);
  assert.equal(second.state.offset, 14);
});

test('readNewLines returns the same state when the file is unchanged', async () => {
  const file = path.join(await tmpDir(), 'a.jsonl');
  await fs.writeFile(file, 'one\n');
  const first = await collect(file);
  const second = await collect(file, first.state);
  assert.equal(second.state, first.state);
  assert.deepEqual(second.lines, []);
});

test('readNewLines re-reads a file that shrank and clears its model', async () => {
  const file = path.join(await tmpDir(), 'a.jsonl');
  await fs.writeFile(file, 'one\ntwo\n');
  const first = await collect(file);
  first.state.model = 'old';
  await fs.writeFile(file, 'x\n');
  const second = await collect(file, first.state);
  assert.deepEqual(second.lines, ['x']);
  assert.equal(second.state.model, undefined);
});

test('scanDir reads nested files and forgets deleted ones', async () => {
  const root = await tmpDir();
  await fs.mkdir(path.join(root, 'p', 'sub'), { recursive: true });
  const a = path.join(root, 'p', 'a.jsonl');
  const b = path.join(root, 'p', 'sub', 'b.jsonl');
  await fs.writeFile(a, 'a1\n');
  await fs.writeFile(b, 'b1\n');
  await fs.writeFile(path.join(root, 'p', 'ignored.json'), 'x\n');
  const files: Record<string, FileState> = { '/elsewhere/keep.jsonl': { size: 1, mtimeMs: 1, offset: 1 } };
  const lines: string[] = [];

  assert.equal(await scanDir(root, files, (l) => lines.push(l)), 2);
  assert.deepEqual(lines.sort(), ['a1', 'b1']);

  await fs.rm(b);
  assert.equal(await scanDir(root, files, (l) => lines.push(l)), 1);
  assert.deepEqual(Object.keys(files).sort(), ['/elsewhere/keep.jsonl', a].sort());
});

test('safeModel keeps real model ids and turns anything that could be a key attack or markup into unknown-model', () => {
  for (const ok of ['gemini-1.5-flash', 'gemini-1.5-pro', 'vendor/model@2+beta']) assert.equal(safeModel(ok), ok);
  const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '', ' ', 'a b', 'x\n\ny', '<img src=x>', '[a](b)', '`x`', 'a'.repeat(101), 42, null, undefined, {}];
  for (const bad of hostile) assert.equal(safeModel(bad), UNKNOWN_MODEL, String(bad));
});

test('readNewLines returns every line intact when lines straddle the 4 MiB read boundary, and ends at the file size', async () => {
  const file = path.join(await tmpDir(), 'big.jsonl');
  const lines = Array.from({ length: 4500 }, (_, i) => `line-${i}-`.padEnd(999, 'x'));
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  const read: string[] = [];
  const state = await readNewLines(file, undefined, (l) => read.push(l));
  assert.equal(read.length, lines.length);
  assert.deepEqual(read, lines);
  assert.equal(state.offset, (await fs.stat(file)).size);
});

test('parseAntigravityLine parses steps with tokens and ignores non-token lines', () => {
  const userLine = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-07T12:00:00Z', content: 'hello' });
  assert.equal(parseAntigravityLine(userLine, 'conv-123'), undefined);

  const plannerLine = JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-07T12:01:00Z',
    input_tokens: 1500,
    cache_read_tokens: 25000,
    output_tokens: 350,
  });
  const rec = parseAntigravityLine(plannerLine, 'conv-123', { title: 'My Task', project: 'Personal', lastModifiedMs: 12345 }, 'Gemini 1.5 Flash (High)');
  assert.ok(rec);
  assert.equal(rec.id, 'antigravity:conv-123:1');
  assert.equal(rec.source, 'antigravity');
  assert.equal(rec.day, '2026-11-07');
  assert.equal(rec.model, 'gemini-1.5-flash');
  assert.equal(rec.session, 'conv-123');
  assert.equal(rec.title, 'My Task');
  assert.equal(rec.project, 'Personal');
  assert.deepEqual(rec.tokens, { input: 1500, cacheRead: 25000, cacheWrite: 0, cacheWrite1h: 0, output: 350 });

  assert.equal(normalizeAntigravityModel('Gemini 1.5 Flash (High)'), 'gemini-1.5-flash');
  assert.equal(normalizeAntigravityModel('gemini-1.5-pro'), 'gemini-1.5-pro');
});
