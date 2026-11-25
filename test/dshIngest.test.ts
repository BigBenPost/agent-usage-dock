import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { DshContentFailure, readDsh, scanDsh } from '../src/collectors/dsh';
import { DshContentError, DshParser, DshResult } from '../src/collectors/dshParser';
import { splitLines } from '../src/collectors/dshLines';
import { FileState } from '../src/collectors/lines';
import { temporaryDirectory } from './temp';

const compress = (zlib as any).zstdCompressSync as ((data: Buffer) => Buffer) | undefined;
const monday = Date.parse('2026-11-16T01:00:00Z');
const header = { type: 'session', version: 4, id: 'session-fixture', createdAt: monday, cwd: '/private/project' };
const event = (seq: number, type: string, data: any, time = monday) => ({ seq, type, data, time });
const request = (seq: number) => event(seq, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' });
const message = (seq: number, input = 100) => event(seq, 'assistant/message', { turn: seq, step: 0, message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: input, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 } });
const title = (seq: number, text: string) => event(seq, 'session/title', { title: text });

async function* chunksOf(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const part of parts) yield Buffer.from(part);
}
async function linesOf(...parts: (string | Buffer)[]): Promise<string[]> {
  const out: string[] = [];
  for await (const line of splitLines(chunksOf(...parts))) out.push(line);
  return out;
}
function parseAll(rows: object[]): DshResult {
  const parser = new DshParser(1);
  for (const row of [header, ...rows]) parser.line(JSON.stringify(row));
  return parser.finish();
}
const goodRecord = () => parseAll([request(0), message(1)]).records[0];
const outcome = (over: Partial<DshResult> = {}): DshResult => ({ session: 'session-fixture', records: [goodRecord()], problems: [], ...over });

async function placeholder() {
  const home = await temporaryDirectory('dsh-ingest-');
  const dir = path.join(home, 'sessions', 'workspace', 'session-fixture');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  await fs.writeFile(file, 'placeholder bytes');
  const touch = async (text: string) => { await fs.appendFile(file, text); };
  return { home, dir, file, touch };
}

function fakeReader(behavior: (file: string, call: number) => DshResult | Promise<DshResult>) {
  const calls: string[] = [];
  const read: typeof readDsh = async file => behavior(file, calls.push(file));
  return { read, calls };
}

test('splitLines breaks on LF only: U+2028, U+2029 and U+0085 stay inside the line and one trailing CR is dropped', async () => {
  const text = (n: number) => JSON.stringify({ t: `a b c\u0085d${n}` });
  assert.deepEqual(await linesOf(`${text(1)}\r\n${text(2)}\n${text(3)}`), [text(1), text(2), text(3)]);
  assert.deepEqual(await linesOf('a\r\r\nb\n\n'), ['a\r', 'b', '']);
  assert.deepEqual(await linesOf(''), []);
});

test('splitLines joins lines split across chunks, including inside a multibyte character and between CR and LF', async () => {
  const euro = Buffer.from('€');
  assert.deepEqual(await linesOf(Buffer.concat([Buffer.from('x'), euro.subarray(0, 1)]), Buffer.concat([euro.subarray(1), Buffer.from('y\n')]), 'abc\r', '\ndef\nlast'), ['x€y', 'abc', 'def', 'last']);
});

test('splitLines rejects a line over 32 MiB as a content problem', async () => {
  async function* endless(): AsyncGenerator<Buffer> {
    const mebibyte = Buffer.alloc(1024 * 1024, 'a');
    for (let i = 0; i < 33; i++) yield mebibyte;
  }
  await assert.rejects(async () => { for await (const line of splitLines(endless())) void line; }, (error: unknown) => error instanceof DshContentError && /exceeds 32 MiB/.test(error.message));
});

test('a DSH session with U+2028, U+2029, U+0085 and CRLF line ends is accepted whole', async () => {
  const text = 'a b c\u0085d';
  const raw = [header, request(0), title(1, text), message(2)].map(row => JSON.stringify(row)).join('\r\n') + '\r\n';
  assert.ok(raw.includes(' '));
  const parser = new DshParser(1);
  for await (const line of splitLines(chunksOf(raw.slice(0, 40), raw.slice(40)))) parser.line(line);
  const result = parser.finish();
  assert.deepEqual(result.problems, []);
  assert.equal(result.records.length, 1);
  assert.equal(result.title, text);
});

test('a null or non-object line is a damaged log, not a crash of the parser', () => {
  assert.throws(() => { const parser = new DshParser(1); parser.line('null'); }, DshContentError);
  const parser = new DshParser(1);
  parser.line(JSON.stringify(header));
  parser.line('null');
  assert.throws(() => parser.finish(), (error: unknown) => error instanceof DshContentError && /boundary/.test(error.message));
});

test('content problems are stored with the fingerprint; an unchanged file is not decoded again and its problems are reported from the state', async () => {
  const f = await placeholder();
  const states: Record<string, FileState> = {};
  const reader = fakeReader(() => outcome({ problems: ['Invalid usage counters or call position', 'Invalid usage counters or call position', 'Malformed JSON line'] }));
  const first = await scanDsh(f.home, states, undefined, reader.read);
  assert.equal(first.records.length, 1);
  const stored = ['Invalid usage counters or call position (2 times)', 'Malformed JSON line'];
  assert.deepEqual(first.problems, stored.map(p => `${f.file}: ${p}`));
  assert.deepEqual(states[f.file].problems, stored);
  assert.equal(states[f.file].session, 'session-fixture');
  assert.equal(first.changedFiles, 1);

  const second = await scanDsh(f.home, states, undefined, reader.read);
  assert.equal(reader.calls.length, 1);
  assert.deepEqual(second.records, []);
  assert.deepEqual(second.problems, first.problems);
  assert.equal(second.changedFiles, 0);

  await f.touch('more');
  await scanDsh(f.home, states, undefined, reader.read);
  assert.equal(reader.calls.length, 2);
});

test('a damaged log is stored as a problem too and keeps the session of the earlier read; a rewrite clears it', async () => {
  const f = await placeholder();
  const states: Record<string, FileState> = {};
  let damaged = false;
  const reader = fakeReader(() => { if (damaged) throw new DshContentFailure('unexpected end of file'); return outcome(); });
  await scanDsh(f.home, states, undefined, reader.read);
  assert.equal(states[f.file].problems, undefined);

  damaged = true;
  await f.touch('x');
  const bad = await scanDsh(f.home, states, undefined, reader.read);
  assert.deepEqual(bad.records, []);
  assert.deepEqual(bad.problems, [`${f.file}: unexpected end of file`]);
  assert.deepEqual(states[f.file].problems, ['unexpected end of file']);
  assert.equal(states[f.file].session, 'session-fixture');
  assert.deepEqual((await scanDsh(f.home, states, undefined, reader.read)).problems, bad.problems);
  assert.equal(reader.calls.length, 2);

  damaged = false;
  await f.touch('y');
  const healed = await scanDsh(f.home, states, undefined, reader.read);
  assert.deepEqual(healed.problems, []);
  assert.equal(states[f.file].problems, undefined);
});

test('timeouts, crashes, a file that changed during the scan and unknown generations store nothing and are retried', async () => {
  const f = await placeholder();
  const states: Record<string, FileState> = {};
  const failures = [new Error('DSH scan exceeded 60 seconds'), new Error('DSH worker exited before returning: 1'), new Error('DSH requires native zstd decompression in this runtime')];
  const reader = fakeReader((_, call) => { throw failures[call - 1] ?? new Error('done'); });
  for (const failure of failures) {
    const result = await scanDsh(f.home, states, undefined, reader.read);
    assert.deepEqual(result.problems, [`${f.file}: ${failure.message}`]);
    assert.deepEqual(states, {});
  }
  assert.equal(reader.calls.length, 3);

  const racing = fakeReader(async file => { await fs.appendFile(file, 'late write'); return outcome(); });
  const changed = await scanDsh(f.home, states, undefined, racing.read);
  assert.deepEqual(changed.problems, [`${f.file}: DSH file changed during scan; retrying later`]);
  assert.deepEqual(changed.records, []);
  assert.deepEqual(states, {});

  await fs.copyFile(f.file, path.join(f.dir, 'session.v5.jsonl.zstd'));
  const untouched = fakeReader(() => outcome());
  const future = await scanDsh(f.home, states, undefined, untouched.read);
  assert.match(future.problems[0], /Unsupported highest DSH log generation/);
  assert.deepEqual(untouched.calls, []);
  assert.deepEqual(states, {});
});

test('a cancelled scan rejects instead of recording a problem', async () => {
  const f = await placeholder();
  const controller = new AbortController();
  const reader = fakeReader(() => { controller.abort(); throw new Error('DSH scan cancelled'); });
  await assert.rejects(scanDsh(f.home, {}, controller.signal, reader.read), /cancelled/);
});

test('records that fail the ledger validation are dropped and counted as a problem', async () => {
  const f = await placeholder();
  const states: Record<string, FileState> = {};
  const good = goodRecord();
  const bad = { ...good, id: 'dsh:session-fixture:9', tokens: { ...good.tokens, input: -1 } };
  const reader = fakeReader(() => outcome({ records: [good, bad] }));
  const result = await scanDsh(f.home, states, undefined, reader.read);
  assert.deepEqual(result.records.map(r => r.id), [good.id]);
  assert.deepEqual(states[f.file].problems, ['1 usage record failed validation and was skipped']);
  assert.deepEqual(result.problems, [`${f.file}: 1 usage record failed validation and was skipped`]);
});

test('at most ten problem lines are stored, the rest is summarized', async () => {
  const f = await placeholder();
  const states: Record<string, FileState> = {};
  const reader = fakeReader(() => outcome({ problems: Array.from({ length: 15 }, (_, i) => `problem ${i}`) }));
  await scanDsh(f.home, states, undefined, reader.read);
  const stored = states[f.file].problems!;
  assert.equal(stored.length, 10);
  assert.equal(stored[8], 'problem 8');
  assert.equal(stored[9], 'and 6 more');
});

async function sessionFile(rows: object[], newline = '\n') {
  const f = await placeholder();
  const bytes = Buffer.from([header, ...rows].map(row => JSON.stringify(row)).join(newline) + newline);
  await fs.writeFile(f.file, compress ? compress(bytes) : bytes);
  return f;
}

test('the worker keeps U+2028, U+2029, U+0085 and CRLF inside a DSH session (needs native zstd, otherwise the capability problem is reported)', async () => {
  const text = 'a b c\u0085d';
  const f = await sessionFile([request(0), title(1, text), message(2)], '\r\n');
  if (!compress) {
    await assert.rejects(readDsh(f.file, 1), /native zstd/);
    return;
  }
  const result = await readDsh(f.file, 1);
  assert.deepEqual(result.problems, []);
  assert.equal(result.records.length, 1);
  assert.equal(result.title, text);
  assert.equal(result.records[0].title, text);
});

test('an unchanged DSH file with a content problem spawns no worker after the first scan (needs native zstd; otherwise the capability failure stays uncached)', async () => {
  const workerThreads = require('node:worker_threads') as { Worker: typeof import('node:worker_threads').Worker };
  const RealWorker = workerThreads.Worker;
  let spawned = 0;
  workerThreads.Worker = class extends RealWorker { constructor(...args: ConstructorParameters<typeof RealWorker>) { spawned++; super(...args); } };
  try {
    const bad = message(2, -1);
    const f = await sessionFile([request(0), message(1), bad]);
    const states: Record<string, FileState> = {};
    const first = await scanDsh(f.home, states);
    if (!compress) {
      assert.match(first.problems[0], /native zstd/);
      assert.deepEqual(states, {});
      await scanDsh(f.home, states);
      assert.equal(spawned, 2);
      return;
    }
    assert.equal(spawned, 1);
    assert.equal(first.records.length, 1);
    assert.deepEqual(first.problems, [`${f.file}: Invalid usage counters or call position`]);
    for (let poll = 0; poll < 3; poll++) {
      const again = await scanDsh(f.home, states);
      assert.deepEqual(again.problems, first.problems);
      assert.equal(again.records.length, 0);
    }
    assert.equal(spawned, 1);
  } finally {
    workerThreads.Worker = RealWorker;
  }
});
