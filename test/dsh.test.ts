import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from './temp';
import { DshParser } from '../src/collectors/dshParser';
import { discoverDsh, readDsh, recordedDshSession, scanDsh } from '../src/collectors/dsh';
import { FileState } from '../src/collectors/lines';
import { UsageStore } from '../src/store';
import { Pricing } from '../src/pricing';
import { aggregate } from '../src/reconcile';
import { tierOf } from '../src/projection';
import { summarize, toCsv } from '../src/summary';
import { buildSessionDetail } from '../src/sessionDetail';
import { dshHome, migrateLegacyStore, sharedStoreFile } from '../src/paths';
import { dailyBackup, rebuildBackup } from '../src/backup';
import { refreshUsage } from '../src/scan';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderSessionDetail } from '../src/panelHtml';
import { chartSvg } from '../src/tooltip';

// Contract: deepseek-ai/deepseek-harness@2e39e704, v4 header + timed compact streams.
const monday = Date.parse('2026-11-16T01:00:00Z');
const header = { type: 'session', version: 4, id: 'session-fixture', createdAt: monday, cwd: '/private/project' };
const usage = (input = 100, output = 20) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 10, cacheWriteTokens: 0 });
const event = (seq: number, type: string, data: any, time = monday) => ({ seq, type, data, time });
const request = (seq: number) => event(seq, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } }, reason: 'initial' });
const message = (seq: number, input = 100, time = monday) => event(seq, 'assistant/message', { turn: 0, step: 0, message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } }, stream: [], usage: usage(input) }, time);
function parse(events: any[], meta = header) {
  const parser = new DshParser(10);
  for (const e of [meta, ...events]) parser.line(JSON.stringify(e));
  return parser.finish();
}
const compress = (zlib as any).zstdCompressSync as ((data: Buffer) => Buffer) | undefined;
async function fixture(events = [request(0), message(1)]) {
  const home = await temporaryDirectory('dsh-');
  const dir = path.join(home, 'sessions', 'workspace', 'session-fixture');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const write = async (rows: any[]) => fs.writeFile(file, compress!(Buffer.from([header, ...rows].map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') + '\n')));
  await write(events);
  return { home, file, write };
}

test('DSH direct usage wins, stream final sample counts, replacement shrinks, retries add', () => {
  const attempt = event(1, 'assistant/attempt', { turn: 0, step: 0, stream: [
    { type: 'chunk', time: monday, chunk: { type: 'usage', usage: usage(500) } },
    { type: 'chunk', time: monday, chunk: { type: 'usage', usage: usage(200) } },
  ] });
  const result = parse([request(0), attempt, message(2, 50), event(3, 'llm/retry-started', { turn: 0, step: 0 }), message(4, 100)]);
  assert.deepEqual(result.records.map(r => [r.id, r.tokens.input]), [['dsh:session-fixture:1', 50], ['dsh:session-fixture:4', 100]]);
  assert.equal(result.records[0].provider, 'deepseek');
  assert.equal(result.records[0].model, 'deepseek-flash');
  assert.equal(result.records[0].project, 'project');
  assert.ok(!JSON.stringify(result).includes('/private'));
});

test('DSH counts failed attempts, no-usage settlements are skipped, totalTokens is not added', () => {
  const result = parse([request(0), event(1, 'assistant/attempt', { turn: 0, step: 0, stream: [
    { type: 'chunk', chunk: { type: 'usage', usage: { ...usage(), totalTokens: 130 } }, time: monday },
  ] }), event(2, 'assistant/message', { turn: 0, step: 1, stream: [] })]);
  assert.equal(result.records.length, 1);
  assert.equal(result.problems.length, 0);
  assert.equal(result.records[0].tokens.input, 100);
});

test('fork cut uses last inherited marker and ordinary restore markers retain history', () => {
  const events = [request(0), message(1), event(2, 'session/end-seed', { inherited: true }), message(3), event(4, 'session/end-seed', { inherited: true }), message(5)];
  assert.deepEqual(parse(events, { ...header, isSeeded: true } as any).records.map(r => r.id), ['dsh:session-fixture:5']);
  assert.equal(parse([message(0), event(1, 'session/end-seed', {})]).records.length, 1);
  assert.throws(() => parse([message(0)], { ...header, isSeeded: true } as any), /boundary/);
});

test('invalid header, IDs, event time, and ambiguous line boundaries are rejected', () => {
  for (const meta of [{ ...header, version: 5 }, { ...header, id: '../escape' }, { ...header, createdAt: 'today' }]) assert.throws(() => parse([], meta as any));
  assert.throws(() => parse([message(0, 100, NaN)]), /boundary/);
  const parser = new DshParser(1);
  parser.line(JSON.stringify(header)); parser.line('{bad');
  assert.throws(() => parser.finish(), /boundary/);
});

test('bad counters do not become zero and untrusted model/provider strings do not become keys', () => {
  const bad = message(0); bad.data.usage.inputTokens = -1;
  const good = message(1); good.data.message.source = { provider: '__proto__', model: '<script>' };
  const result = parse([bad, good]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].model, 'unknown-model');
  assert.equal(result.records[0].provider, undefined);
  assert.equal(result.problems.length, 1);
});

test('title changes update metadata and request context supplies attempt model/provider', () => {
  const result = parse([request(0), event(1, 'assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage() } }] }), event(2, 'session/title', { title: 'New title' })]);
  assert.equal(result.records[0].title, 'New title');
  assert.equal(result.records[0].model, 'deepseek-flash');
});

test('sequence gaps refuse accounting, message routes do not inherit a conflicting header', () => {
  assert.throws(() => parse([request(0), message(2)]), /boundary/);
  const msg = message(1);
  msg.data.message.source = { provider: '<bad>', model: '__proto__' };
  const result = parse([request(0), msg]);
  assert.equal(result.records[0].provider, undefined);
  assert.equal(result.records[0].model, 'unknown-model');
});

test('an update for the same settled DSH call can omit its existing route', () => {
  const updated = message(1, 150);
  updated.data.message.source = undefined;
  const result = parse([message(0), updated]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].provider, 'deepseek');
  assert.equal(result.records[0].model, 'deepseek-flash');
  assert.equal(result.records[0].tokens.input, 150);
});

test('on-demand prompt inspection uses the upstream user source kind and never persists content', () => {
  const parser = new DshParser(1, true);
  const entries = [header, event(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this project' }] }), message(1)];
  for (const e of entries) parser.line(JSON.stringify(e));
  const result = parser.finish();
  assert.equal(result.firstPrompt, 'Inspect this project');
  assert.ok(!JSON.stringify(result.records).includes('Inspect this project'));
});

test('UTC tier boundaries, weekends and cross-month dates', () => {
  for (const [time, tier] of [['00:59:59', 'offpeak'], ['01:00:00', 'peak'], ['03:59:59', 'peak'], ['04:00:00', 'offpeak'], ['06:00:00', 'peak'], ['10:00:00', 'offpeak']]) assert.equal(tierOf(Date.parse('2026-11-16T' + time + 'Z')), tier);
  assert.equal(tierOf(Date.parse('2026-11-21T02:00:00Z')), 'offpeak');
  assert.equal(tierOf(Date.parse('2026-12-01T02:00:00Z')), 'peak');
});

test('DSH pricing is route-specific, current-rate, with exact override precedence', () => {
  const tokens = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  const quote = (p: Pricing, provider = 'deepseek', model = 'deepseek-flash', ts = monday) => p.quote({ source: 'dsh', provider, model, ts, tokens });
  assert.equal(quote(new Pricing()).cost, .30);
  assert.equal(quote(new Pricing(), 'deepseek-account').cost, .30);
  assert.equal(quote(new Pricing(), 'deepseek-account', 'deepseek-v4.1-flash', monday + 3 * 3600_000).cost, .15);
  assert.equal(quote(new Pricing(), 'deepseek', 'deepseek-flash', monday + 3 * 3600_000).cost, .15);
  assert.equal(quote(new Pricing(), 'proxy').cost, undefined);
  assert.equal(quote(new Pricing(), 'deepseek', 'deepseek-future').cost, undefined);
  assert.equal(quote(new Pricing(), 'openai', 'gpt-4o').cost, undefined);
  const custom = new Pricing({ 'deepseek-*': { input: 2 }, 'deepseek-flash': { input: 4 } }, 2);
  assert.equal(quote(custom).cost, 8);
  assert.equal(quote(custom, 'proxy', 'deepseek-flash', monday + 3 * 3600_000).cost, 8);
  assert.equal(quote(new Pricing({ 'other': { output: 0 } }), 'proxy', 'other').cost, undefined);
});

test('mixed sources and peak/offpeak agree in overview, detail, CSV and UI', () => {
  const a = parse([request(0), message(1)]).records[0];
  const b = { ...a, id: a.id + '-next', evidence: undefined, ts: monday + 3 * 3600_000 };
  const agy = { ...a, id: 'agy-id', evidence: undefined, source: 'antigravity' as const, model: 'gemini-1.5-flash', session: 'other' };
  const data = aggregate({ a, b, agy });
  const pricing = new Pricing();
  const summary = summarize(data, pricing, monday);
  const dshModels = summary.models.filter(m => m.source === 'dsh');
  assert.equal(dshModels.length, 1);
  const detail = buildSessionDetail('dsh:' + a.session, data.sessions['dsh:' + a.session], pricing, '2026-11');
  assert.equal(detail.models.length, 1);
  assert.deepEqual(detail.models[0].pricingParts?.map(p => p.tier).sort(), ['offpeak', 'peak']);
  assert.equal(detail.cost, summary.bySource.dsh);
  assert.equal(detail.tokens.requests, 2);
  assert.equal(summary.totalRequests, 3);
  const csv = toCsv(data.days, pricing);
  assert.match(csv, /deepseek,peak,UTC weekday/);
  assert.match(csv, /deepseek,offpeak,UTC weekday/);
  assert.ok(!csv.includes('deepseek-flash@'));
  const body = renderBody(summary, normalizeConfig({}));
  assert.match(body, /deepseek · peak/); assert.match(body, /deepseek · offpeak/);
  assert.match(body, /agent-usage-dock/); assert.match(body, />DSH/); assert.match(body, /deepseek-v4\.1-flash/);
  assert.ok(!body.includes('DSH costs use UTC weekday/time estimates'));
  assert.match(chartSvg(summary, normalizeConfig({}), false), /DeepSeek/);
  assert.match(renderSessionDetail({ ...detail, info: { file: '/logs', folder: true } }, 'UTC'), /Open folder/);
});

test('unknown DSH routes retain tokens but never add guessed cost', () => {
  const rec = parse([message(0)]).records[0];
  rec.provider = 'proxy';
  const summary = summarize(aggregate({ [rec.id]: rec }), new Pricing(), monday);
  assert.equal(summary.total, 0); assert.equal(summary.tokensTotal, 130);
  assert.deepEqual(summary.unpriced, ['deepseek-flash']);
});

test('the built-in DeepSeek account route is priced in dollars and the UI uses the canonical model id', () => {
  const rec = { ...parse([message(0)]).records[0], provider: 'deepseek-account' };
  const pricing = new Pricing();
  const summary = summarize(aggregate({ [rec.id]: rec }), pricing, monday);
  assert.deepEqual(summary.unpriced, []);
  // Peak: 100 input × $0.30 + 10 cache read × $0.006 + 20 output × $1.20, per million tokens.
  assert.ok(Math.abs(summary.bySource.dsh - 54.06e-6) < 1e-12);
  const body = renderBody(summary, normalizeConfig({}));
  assert.match(body, /deepseek-v4\.1-flash/);
  assert.ok(!body.includes('Unpriced models'));
});

test('worker decompresses concatenated frames; scans skip fingerprints and persist downward corrections', { skip: !compress }, async () => {
  const f = await fixture();
  const states: Record<string, FileState> = {};
  const one = await scanDsh(f.home, states);
  assert.equal(one.records.length, 1); assert.deepEqual(one.problems, []);
  assert.equal((await scanDsh(f.home, states)).changedFiles, 0);
  const store = await UsageStore.load(path.join(f.home, 'usage.json'));
  store.addRecords(one.records);
  await f.write([request(0), message(1, 10)]);
  store.addRecords((await scanDsh(f.home, states)).records);
  assert.equal(store.data.records['dsh:session-fixture:1'].tokens.input, 10);
  const frame1 = compress!(Buffer.from(JSON.stringify(header) + '\n' + JSON.stringify(request(0)) + '\n'));
  const frame2 = compress!(Buffer.from(JSON.stringify(message(1)) + '\n'));
  await fs.writeFile(f.file, Buffer.concat([frame1, frame2]));
  assert.equal((await readDsh(f.file, 100)).records.length, 1);
});

test('truncated compression is kept as a problem of its fingerprint, a rewrite recovers, future formats retry later', { skip: !compress }, async () => {
  const f = await fixture();
  const states: Record<string, FileState> = {};
  await scanDsh(f.home, states);
  const good = structuredClone(states[f.file]);
  const bytes = await fs.readFile(f.file);
  await fs.writeFile(f.file, bytes.subarray(0, bytes.length - 3));
  const bad = await scanDsh(f.home, states);
  assert.ok(bad.problems.length); assert.equal(bad.records.length, 0);
  assert.equal(states[f.file].session, good.session);
  assert.notEqual(states[f.file].fingerprint, good.fingerprint);
  assert.ok(states[f.file].problems?.length);
  await f.write([request(0), message(1)]);
  const recovered = await scanDsh(f.home, states);
  assert.deepEqual(recovered.problems, []); assert.equal(recovered.records.length, 1);
  assert.equal(states[f.file].problems, undefined);
  await fs.copyFile(f.file, path.join(path.dirname(f.file), 'session.v5.jsonl.zstd'));
  assert.match((await discoverDsh(f.home))[0], /v5/);
  assert.match((await scanDsh(f.home, states)).problems[0], /Unsupported highest/);
});

test('concatenated frames can split JSON lines and old decoder fingerprints are rescanned', { skip: !compress }, async () => {
  const f = await fixture();
  const bytes = Buffer.from([header, request(0), message(1)].map(value => JSON.stringify(value)).join('\n') + '\n');
  await fs.writeFile(f.file, Buffer.concat([bytes.subarray(0, 17), bytes.subarray(17, bytes.length - 11), bytes.subarray(bytes.length - 11)].map(part => compress!(part))));
  const states: Record<string, FileState> = {};
  const result = await scanDsh(f.home, states);
  assert.deepEqual(result.problems, []);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].tokens.input, 100);
  states[f.file].fingerprint = states[f.file].fingerprint!.replace(/:[^:]+$/, ':1');
  assert.equal((await scanDsh(f.home, states)).changedFiles, 1);
});

test('deleted logs forget cursor only; source health and disabled collection retain budget history', { skip: !compress }, async () => {
  const f = await fixture();
  const file = path.join(f.home, 'usage.json'), store = await UsageStore.load(file);
  await refreshUsage(store, file, undefined, false, { source: 'dsh', dshHome: f.home });
  assert.equal(store.data.sourceHealth?.dsh?.status, 'ok');
  await fs.rm(f.file);
  await refreshUsage(store, file, undefined, false, { source: 'dsh', dshHome: f.home });
  assert.equal(Object.keys(store.data.records).length, 1);
  assert.equal(store.data.files[f.file], undefined);
  await refreshUsage(store, file, undefined, false, { source: 'dsh', dshHome: f.home, dshEnabled: false });
  assert.equal(store.data.sourceHealth?.dsh?.status, 'disabled');
  assert.equal(summarize(store.data, new Pricing(), monday).tokensTotal, 130);
});

test('missing explicit DSH root is incomplete, cancellation rejects, paths resolve', async () => {
  const dir = await temporaryDirectory('dsh-health-'), file = path.join(dir, 'usage.json');
  const store = await UsageStore.load(file);
  const r = await refreshUsage(store, file, undefined, false, { source: 'dsh', dshHome: path.join(dir, 'missing') });
  assert.ok(r.problems.length); assert.equal(store.data.sourceHealth?.dsh?.status, 'incomplete');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readDsh('unused', 0, controller.signal));
  assert.ok(path.isAbsolute(dshHome('~/dsh')));
});

test('native zstd capability failure is reported without replacing saved records or cursors', async () => {
  const dir = await temporaryDirectory('dsh-capability-');
  const sessionDir = path.join(dir, 'sessions', 'project', 'session-fixture');
  await fs.mkdir(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  // Fixed, synthetic v4 fixture; keeps this test active even on Node 18 without compression support.
  await fs.writeFile(file, Buffer.from('KLUv/WAlAMUFACLMJB9QiaoDRsNIRLh2F7Acny+HXWQyw4IY11guz2Sm5pgQyHuvBKxbxlIOaVVvLIJ1TCEn6YzvGUGNg2Fw/KxkdONX9h+n2w96rMYWzS11kkaDgnQyb+yrqrl1kjZrjvEJrbGkE64HRvUJYJVZRaoGeUWgKBIIReKQ3oHzNW8Lo9/cKiCG4SAjItsfRquFVK9Ony2skw0A2NigvEu3abh1IxRIZ0kiqVZ11YlWu6ZQeFxwPrdoW5o=', 'base64'));
  const prior: FileState = { size: 0, mtimeMs: 0, offset: 0, fingerprint: 'old', session: 'session-fixture' };
  const states = { [file]: prior };
  const result = await scanDsh(dir, states);
  if (typeof (zlib as any).createZstdDecompress === 'function') {
    assert.equal(result.problems.length, 0);
    assert.equal(result.records[0].tokens.input, 100);
  } else {
    assert.match(result.problems[0], /native zstd/);
    assert.equal(result.records.length, 0);
    assert.deepEqual(states[file], prior);
  }
});

test('v1 migration preserves baseline and v2 archive facts; v3 archive corruption never downgrades', async () => {
  const dir = await temporaryDirectory('dsh-v1-'), oldHome = process.env.AGY_TOKEN_TRACKER_HOME;
  process.env.AGY_TOKEN_TRACKER_HOME = dir;
  try {
    const original = JSON.stringify({ version: 1, days: { '2026-11-16': { antigravity: { 'gemini-1.5-flash': { requests: 1, input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cacheWrite1h: 0 } } } } });
    await fs.writeFile(path.join(dir, 'usage.json'), original);
    await fs.mkdir(path.join(dir, 'archive'));
    const rec = { ...parse([message(0)]).records[0], source: 'antigravity' as const, evidence: undefined, id: 'archived', model: 'gemini-1.5-flash' };
    await fs.writeFile(path.join(dir, 'archive', 'history-ledger-v2.json'), JSON.stringify({ version: 2, updatedAt: new Date(monday).toISOString(), records: { archived: rec }, days: aggregate({ archived: rec }).days }));
    await migrateLegacyStore();
    const store = await UsageStore.load(sharedStoreFile());
    assert.equal(store.data.version, 3);
    assert.equal(summarize(store.data, new Pricing(), monday).tokensTotal, 130);
    assert.equal(Object.keys(store.data.records).length, 1);
    assert.equal(await fs.readFile(path.join(dir, 'usage.json'), 'utf8'), original);
    await fs.writeFile(path.join(dir, 'archive', 'history-ledger-v3.json'), '{bad');
    await assert.rejects(store.transaction(() => undefined));
    assert.equal(await fs.readFile(path.join(dir, 'archive', 'history-ledger-v3.json'), 'utf8'), '{bad');
  } finally { if (oldHome === undefined) delete process.env.AGY_TOKEN_TRACKER_HOME; else process.env.AGY_TOKEN_TRACKER_HOME = oldHome; }
});

test('recorded session paths cannot escape the configured root through symlinks', { skip: !compress }, async () => {
  const f = await fixture(), outside = await fixture();
  const states: Record<string, FileState> = {};
  await scanDsh(f.home, states);
  assert.equal((await recordedDshSession(states, 'session-fixture', f.home))?.file, await fs.realpath(f.file));
  const contained = path.join(path.dirname(f.file), 'contained-log');
  await fs.rename(f.file, contained);
  await fs.symlink(contained, f.file);
  await scanDsh(f.home, states);
  assert.equal((await recordedDshSession(states, 'session-fixture', f.home))?.file, await fs.realpath(contained));
  await fs.rm(f.file); await fs.symlink(outside.file, f.file);
  assert.equal(await recordedDshSession(states, 'session-fixture', f.home), undefined);
});

test('v2 migration is concurrent-safe, leaves old bytes intact, rejects corrupt/future v3', async () => {
  const dir = await temporaryDirectory('dsh-migrate-'), priorHome = process.env.AGY_TOKEN_TRACKER_HOME;
  process.env.AGY_TOKEN_TRACKER_HOME = dir;
  try {
    const rec = { ...parse([message(0)]).records[0], source: 'antigravity', evidence: undefined, id: 'old', model: 'gemini-1.5-flash' };
    const original = JSON.stringify({ version: 2, records: { old: rec }, ...aggregate({ old: rec } as any), files: {}, seen: {} });
    await fs.writeFile(path.join(dir, 'usage-v2.json'), original);
    await Promise.all([migrateLegacyStore(), migrateLegacyStore()]);
    const store = await UsageStore.load(sharedStoreFile());
    assert.equal(store.data.version, 3);
    assert.equal(await fs.readFile(path.join(dir, 'usage-v2.json'), 'utf8'), original);
    assert.equal(summarize(store.data, new Pricing(), monday).tokensTotal, 130);
    await fs.writeFile(sharedStoreFile(), '{bad');
    await assert.rejects(migrateLegacyStore());
    assert.equal(await fs.readFile(sharedStoreFile(), 'utf8'), '{bad');
    await fs.writeFile(sharedStoreFile(), '{"version":99,"days":{}}');
    await assert.rejects(migrateLegacyStore(), /unsupported/);
  } finally { if (priorHome === undefined) delete process.env.AGY_TOKEN_TRACKER_HOME; else process.env.AGY_TOKEN_TRACKER_HOME = priorHome; }
});

test('v3 daily/rebuild pruning cannot touch old-version backups', async () => {
  const dir = await temporaryDirectory('dsh-backup-'), file = path.join(dir, 'usage-v3.json');
  await fs.mkdir(path.join(dir, 'backups'));
  await fs.writeFile(file, '{"version":3}');
  await fs.writeFile(path.join(dir, 'backups', 'usage-2000-01-01.json'), 'old bytes');
  await fs.writeFile(path.join(dir, 'backups', 'usage-pre-rebuild-old.json'), 'old rebuild');
  for (let i = 0; i < 4; i++) { await dailyBackup(file, monday + i * 86400_000, 1); await rebuildBackup(file, monday + i * 1000, 1); }
  const names = await fs.readdir(path.join(dir, 'backups'));
  assert.equal(names.length, 4);
  assert.ok(names.includes('usage-2000-01-01.json')); assert.ok(names.includes('usage-pre-rebuild-old.json'));
});

test('a broken current archive cannot quarantine the working file or downgrade to a legacy archive', async () => {
  const dir = await temporaryDirectory('dsh-recover-'), file = path.join(dir, 'usage-v3.json');
  await fs.mkdir(path.join(dir, 'archive'));
  await fs.writeFile(file, '{broken store');
  await fs.writeFile(path.join(dir, 'archive', 'history-ledger-v2.json'), '{"version":2,"records":{},"days":{}}');
  await assert.rejects(UsageStore.recover(file, () => assert.fail('no current archive')));
  await fs.writeFile(path.join(dir, 'archive', 'history-ledger-v3.json'), '{broken archive');
  await assert.rejects(UsageStore.recover(file, () => assert.fail('invalid current archive')));
  assert.equal(await fs.readFile(file, 'utf8'), '{broken store');
});

test('CLI dsh selection ignores unavailable Antigravity; invalid sources return 2', { skip: !compress }, async () => {
  const f = await fixture();
  const env = { ...process.env, AGY_TOKEN_TRACKER_HOME: path.join(f.home, 'store'), ANTIGRAVITY_HOME: path.join(f.home, 'missing') };
  const cli = path.join(__dirname, '..', 'src', 'cli.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, 'flush', ...args], { env, encoding: 'utf8' });
  const result = run(['--source', 'dsh', '--dsh-home', f.home]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(['--source', 'bogus']).status, 2);
  assert.equal(run([]).status, 1);
});
