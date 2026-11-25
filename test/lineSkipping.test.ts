import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseClaudeLine } from '../src/collectors/claudeCode';
import { FileState, readNewLines, scanDir, timestampMs, utcDay } from '../src/collectors/lines';
import { refreshUsage } from '../src/scan';
import { UsageStore } from '../src/store';
import { temporaryDirectory } from './temp';

const claudeLine = (n: number, usage: object = {}, over: object = {}) => JSON.stringify({
  type: 'assistant', timestamp: `2026-11-20T01:0${n % 10}:00.000Z`, sessionId: 's1', requestId: `req_${n}`, uuid: `u${n}`, cwd: '/x/p',
  message: { id: `msg_${n}`, model: 'claude-sonnet-5-5', usage: { input_tokens: 10 * n, output_tokens: 5, ...usage } }, ...over,
});
const BROKEN = '{"type":"assistant","message":{"usage": BROKEN';
const lines = (...rows: string[]) => rows.join('\n') + '\n';

async function claudeFixture(...rows: string[]) {
  const root = await temporaryDirectory('line-skip-');
  const file = path.join(root, 'p', 's1.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines(...rows));
  const files: Record<string, FileState> = {};
  const poll = async () => {
    const got: string[] = [], problems: string[] = [];
    await scanDir(root, files, (line, state) => {
      const record = parseClaudeLine(line, state);
      if (record) got.push(record.id);
    }, problems, { label: 'Claude Code' });
    return { got, problems };
  };
  return { root, file, files, poll };
}

test('a bad line in the middle is skipped: later lines are read, the cursor advances and the file is not read again', async () => {
  const f = await claudeFixture(claudeLine(1), BROKEN, claudeLine(3), claudeLine(4));
  const offset = Buffer.byteLength(claudeLine(1)) + 1;
  const message = `Claude Code: 1 unreadable line skipped in ${f.file} (byte ${offset}: Malformed Claude usage line); later usage is still collected.`;

  const first = await f.poll();
  assert.deepEqual(first.got, ['claude:msg_1', 'claude:msg_3', 'claude:msg_4']);
  assert.deepEqual(first.problems, [message]);
  assert.equal(f.files[f.file].offset, (await fs.stat(f.file)).size);
  assert.deepEqual(f.files[f.file].skipped, { count: 1, samples: [{ offset, reason: 'Malformed Claude usage line' }] });

  const state = f.files[f.file];
  const second = await f.poll();
  assert.deepEqual(second.got, []);
  assert.deepEqual(second.problems, [message]);
  assert.equal(f.files[f.file], state);

  await fs.appendFile(f.file, lines(claudeLine(5)));
  const third = await f.poll();
  assert.deepEqual(third.got, ['claude:msg_5']);
  assert.deepEqual(third.problems, [message]);
});

test('a file read again from byte 0 starts with an empty skipped list', async () => {
  const f = await claudeFixture(claudeLine(1), BROKEN, claudeLine(3));
  await f.poll();
  assert.equal(f.files[f.file].skipped?.count, 1);

  await fs.writeFile(f.file, lines(claudeLine(2), BROKEN, claudeLine(3), claudeLine(4)));
  const rewritten = await f.poll();
  assert.deepEqual(rewritten.got, ['claude:msg_2', 'claude:msg_3', 'claude:msg_4']);
  assert.equal(f.files[f.file].skipped?.count, 1);

  await fs.writeFile(f.file, lines(claudeLine(1)));
  const clean = await f.poll();
  assert.deepEqual(clean.got, ['claude:msg_1']);
  assert.deepEqual(clean.problems, []);
  assert.equal(f.files[f.file].skipped, undefined);
});

test('many skipped lines keep an exact count and at most five samples', async () => {
  const f = await claudeFixture(...Array.from({ length: 7 }, () => BROKEN), claudeLine(1));
  const { got, problems } = await f.poll();
  assert.deepEqual(got, ['claude:msg_1']);
  assert.equal(f.files[f.file].skipped?.count, 7);
  assert.equal(f.files[f.file].skipped?.samples.length, 5);
  assert.match(problems[0], /^Claude Code: 7 unreadable lines skipped in .* \(first at byte 0: Malformed Claude usage line\); later usage is still collected\.$/);
});

test('strict reads still fail on the first unreadable line', async () => {
  const f = await claudeFixture(claudeLine(1), BROKEN, claudeLine(3));
  await assert.rejects(readNewLines(f.file, undefined, () => {}, { strict: true }), /Invalid or incomplete JSON at byte/);
  await fs.writeFile(f.file, lines(claudeLine(1), claudeLine(2)));
  const seen: string[] = [];
  await assert.rejects(readNewLines(f.file, undefined, line => { seen.push(line); if (seen.length === 2) throw new Error('rejected'); }, { strict: true }), /rejected/);
  const state = await readNewLines(f.file, undefined, line => { if (line.includes('msg_2')) throw new Error('rejected'); });
  assert.equal(state.skipped?.count, 1);
});

test('a line over 32 MiB is skipped, the lines around it are read and the cursor stays consistent', async () => {
  const root = await temporaryDirectory('line-huge-');
  const file = path.join(root, 'huge.jsonl');
  const huge = Buffer.concat([Buffer.from('{"pad":"'), Buffer.alloc(33 * 1024 * 1024, 'a'), Buffer.from('"}\n')]);
  await fs.writeFile(file, Buffer.concat([Buffer.from('{"n":1}\n'), huge, Buffer.from('{"n":2}\n')]));
  const seen: string[] = [];
  const state = await readNewLines(file, undefined, line => { seen.push(line.slice(0, 12)); });
  assert.deepEqual(seen, ['{"n":1}', '{"n":2}']);
  assert.deepEqual(state.skipped, { count: 1, samples: [{ offset: 8, reason: 'line exceeds 32 MiB' }] });
  assert.equal(state.offset, (await fs.stat(file)).size);

  await fs.appendFile(file, '{"n":3}\n');
  seen.length = 0;
  const later = await readNewLines(file, state, line => { seen.push(line); });
  assert.deepEqual(seen, ['{"n":3}']);
  assert.equal(later.skipped?.count, 1);
  await assert.rejects(readNewLines(file, undefined, () => {}, { strict: true }), /exceeds 32 MiB/);
});

test('an oversize line still being written is left for the next read and the hash covers only complete lines', async () => {
  const root = await temporaryDirectory('line-huge-open-');
  const file = path.join(root, 'open.jsonl');
  await fs.writeFile(file, Buffer.concat([Buffer.from('first\n'), Buffer.from('{"pad":"'), Buffer.alloc(33 * 1024 * 1024, 'a')]));
  const seen: string[] = [];
  const open = await readNewLines(file, undefined, line => { seen.push(line); });
  assert.deepEqual(seen, ['first']);
  assert.equal(open.offset, 6);
  assert.equal(open.skipped, undefined);

  await fs.appendFile(file, '"}\nlast\n');
  seen.length = 0;
  const done = await readNewLines(file, open, line => { seen.push(line); });
  assert.deepEqual(seen, ['last']);
  assert.equal(done.skipped?.count, 1);
  assert.equal(done.offset, (await fs.stat(file)).size);
});

test('instants outside 1970-01-01 to 9999-12-31 are invalid timestamps, never a malformed day', () => {
  for (const bad of ['+010000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z', '0001-01-01T00:00:00Z', '-000001-06-01T00:00:00Z', '1969-12-31T23:59:59.999Z', 'garbage', 5, undefined]) {
    assert.equal(timestampMs(bad), undefined, String(bad));
    assert.equal(utcDay(bad), undefined, String(bad));
  }
  assert.equal(utcDay('1970-01-01T00:00:00Z'), '1970-01-01');
  assert.equal(utcDay('9999-12-31T23:59:59.999Z'), '9999-12-31');
  assert.equal(timestampMs('2026-11-20T01:02:03.004Z'), Date.parse('2026-11-20T01:02:03.004Z'));
});

test('a Claude entry with an out-of-range timestamp is an unreadable line, not a malformed day', () => {
  const state = { size: 0, mtimeMs: 0, offset: 0 };
  for (const stamp of ['+010000-01-01T00:00:00.000Z', '0001-01-01T00:00:00Z']) {
    assert.throws(() => parseClaudeLine(claudeLine(1, {}, { timestamp: stamp }), state), /no valid identity, timestamp/);
  }
});

test('one out-of-range timestamp no longer aborts the batch or creates a ghost month, for every collector', async () => {
  const root = await temporaryDirectory('line-poison-');
  const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex'), agy = path.join(root, 'agy');
  const claudeFile = path.join(claudeHome, 'projects', 'p', 'good.jsonl');
  const weirdFile = path.join(claudeHome, 'projects', 'p', 'weird.jsonl');
  const codexFile = path.join(codexHome, 'sessions', 'rollout-codex-one.jsonl');
  const agyFile = path.join(agy, 'brain', 'conv-1', '.system_generated', 'logs', 'transcript.jsonl');
  const jsonl = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const count = (stamp: string, total: number) => ({ type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 3, output_tokens: 2 } } } });
  const step = (index: number, stamp: string) => ({ step_index: index, created_at: stamp, model: 'gemini-3.8-flash', input_tokens: 10, output_tokens: 5 });
  for (const file of [claudeFile, codexFile, agyFile]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(claudeFile, lines(claudeLine(1)));
  await fs.writeFile(weirdFile, lines(claudeLine(2, {}, { timestamp: '+010000-01-01T00:00:00.000Z' }), claudeLine(3, {}, { timestamp: '0001-01-01T00:00:00Z' })));
  await fs.writeFile(codexFile, jsonl({ type: 'session_meta', payload: { id: 'codex-one' } }, { type: 'turn_context', payload: { model: 'gpt-6.2-sol' } }, count('-000001-06-01T00:00:00Z', 5), count('2026-11-20T02:00:00Z', 9)));
  await fs.writeFile(agyFile, jsonl(step(1, '+010000-01-01T00:00:00Z'), step(2, '2026-11-20T03:00:00Z')));

  const file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const options = { source: 'all' as const, claudeHome, codexHome, dshEnabled: false };
  const first = await refreshUsage(store, file, agy, false, options);
  assert.deepEqual(Object.keys(store.data.records).sort(), ['antigravity:conv-1:2', 'claude:msg_1', 'codex:count:codex-one:9']);
  assert.deepEqual(Object.keys(store.data.days), ['2026-11-20']);
  assert.equal(first.problems.length, 3);
  assert.ok(first.problems.some(p => p.startsWith('Claude Code: 2 unreadable lines skipped in ') && p.includes('weird.jsonl')));
  assert.ok(first.problems.some(p => p.startsWith('Codex: 1 unreadable line skipped in ')));
  assert.ok(first.problems.some(p => p.startsWith('Antigravity: 1 unreadable line skipped in ')));
  assert.equal(store.data.sourceHealth?.claude?.status, 'incomplete');

  await fs.appendFile(claudeFile, lines(claudeLine(4)));
  const second = await refreshUsage(store, file, agy, false, options);
  assert.equal(second.changed, 1);
  assert.ok(store.data.records['claude:msg_4']);
  assert.deepEqual(second.problems, first.problems);
  const third = await refreshUsage(store, file, agy, false, options);
  assert.equal(third.changed, 0);
  assert.deepEqual(third.problems, first.problems);
});

test('the skipped-line problem is persisted with the cursor and survives a restart', async () => {
  const root = await temporaryDirectory('line-restart-');
  const claudeHome = path.join(root, 'claude');
  const log = path.join(claudeHome, 'projects', 'p', 's1.jsonl');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, lines(claudeLine(1), BROKEN, claudeLine(3)));
  const file = path.join(root, 'usage-v3.json');
  const options = { source: 'claude' as const, claudeHome };
  const store = await UsageStore.load(file);
  const first = await refreshUsage(store, file, path.join(root, 'agy'), false, options);
  assert.equal(first.problems.length, 1);

  const reloaded = await UsageStore.load(file);
  assert.equal(reloaded.data.files[log].skipped?.count, 1);
  const again = await refreshUsage(reloaded, file, path.join(root, 'agy'), false, options);
  assert.deepEqual(again.problems, first.problems);
  assert.equal(again.changed, 0);
  assert.equal(again.files, 0);
});

test('every record a collector emits must pass the ledger validation; a failure counts as an unreadable line', async () => {
  const root = await temporaryDirectory('line-validate-');
  const claudeHome = path.join(root, 'claude');
  const log = path.join(claudeHome, 'projects', 'p', 's1.jsonl');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, lines(claudeLine(1), claudeLine(2), claudeLine(3)));
  const claudeModule = require('../src/collectors/claudeCode') as { parseClaudeLine: typeof parseClaudeLine };
  const real = claudeModule.parseClaudeLine;
  claudeModule.parseClaudeLine = (line, state) => {
    const record = real(line, state);
    return record?.id === 'claude:msg_2' ? { ...record, tokens: { ...record.tokens, input: -1 } } : record;
  };
  try {
    const file = path.join(root, 'usage-v3.json');
    const store = await UsageStore.load(file);
    const result = await refreshUsage(store, file, path.join(root, 'agy'), false, { source: 'claude', claudeHome });
    assert.deepEqual(Object.keys(store.data.records).sort(), ['claude:msg_1', 'claude:msg_3']);
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], /^Claude Code: 1 unreadable line skipped in .* \(byte \d+: Invalid usage record\); later usage is still collected\.$/);
  } finally {
    claudeModule.parseClaudeLine = real;
  }
});

test('records the store refuses become at most ten problem lines and "and N more"', async () => {
  const root = await temporaryDirectory('line-rejected-');
  const claudeHome = path.join(root, 'claude');
  const log = path.join(claudeHome, 'projects', 'p', 's1.jsonl');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, lines(claudeLine(1)));
  const file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const addRecords = store.addRecords.bind(store);
  store.addRecords = records => {
    const changed = addRecords(records);
    Object.defineProperty(store, 'rejected', { configurable: true, value: Array.from({ length: 12 }, (_, i) => ({ id: `claude:bad_${i}`, reason: 'Invalid usage record' })) });
    return changed;
  };
  const result = await refreshUsage(store, file, path.join(root, 'agy'), false, { source: 'claude', claudeHome });
  assert.equal(result.problems.length, 11);
  assert.equal(result.problems[0], 'Rejected usage record claude:bad_0: Invalid usage record');
  assert.equal(result.problems[10], 'and 2 more rejected usage records');
  assert.equal(result.sources.find(s => s.source === 'claude')?.status, 'incomplete');
});

test('Claude assistant entries without any token field are ignored, invalid values stay errors', async () => {
  const state = { size: 0, mtimeMs: 0, offset: 0 };
  const entry = (usage: unknown) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-20T01:00:00Z', sessionId: 's1', message: { id: 'msg_x', model: 'claude-sonnet-5-5', usage } });
  assert.equal(parseClaudeLine(entry({ server_tool_use: { web_search_requests: 1 } }), state), undefined);
  assert.equal(parseClaudeLine(entry({}), state), undefined);
  assert.equal(parseClaudeLine(entry({ input_tokens: null, output_tokens: null }), state), undefined);
  assert.equal(parseClaudeLine(entry({ input_tokens: 5, output_tokens: 2, server_tool_use: {} }), state)?.tokens.input, 5);
  assert.throws(() => parseClaudeLine(entry({ input_tokens: -1 }), state));
  assert.throws(() => parseClaudeLine(entry({ input_tokens: 1, output_tokens: 'x' }), state), /Invalid Claude token count/);
  assert.throws(() => parseClaudeLine(entry({ input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: -4 } }), state), /cache creation/);
  assert.throws(() => parseClaudeLine(entry('5'), state));

  const f = await claudeFixture(claudeLine(1), claudeLine(2, { input_tokens: undefined, output_tokens: undefined, server_tool_use: { web_search_requests: 1 } }), claudeLine(3));
  const { got, problems } = await f.poll();
  assert.deepEqual(got, ['claude:msg_1', 'claude:msg_3']);
  assert.deepEqual(problems, []);
});
