import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { currentArchiveFile } from '../src/backup';
import { parseAntigravityLine, parseDbStepMetadata } from '../src/collectors/antigravity';
import { parseClaudeLine } from '../src/collectors/claudeCode';
import { parseCodexLine } from '../src/collectors/codex';
import { readNewLines } from '../src/collectors/lines';
import { installCli } from '../src/cliInstall';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { aggregate, canonicalRecords, preferredRecord } from '../src/reconcile';
import { refreshUsage } from '../src/scan';
import { buildSessionDetail } from '../src/sessionDetail';
import { UsageStore } from '../src/store';
import { summarize, toCsv } from '../src/summary';
import { emptyBucket, type UsageRecord } from '../src/types';
import { temporaryDirectory } from './temp';

const timestamp = '2026-11-22T12:00:00Z';
const now = Date.parse(timestamp);
const day = timestamp.slice(0, 10);
const tokens = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
const record = (id: string): UsageRecord => ({ id, day, ts: now, model: 'gemini-1.5-flash', source: 'antigravity', tokens });
const ledgers = (records: UsageRecord[]) => Object.fromEntries(records.map(r => [r.id, r]));
const jsonlState = () => ({ offset: 0, size: 0, mtimeMs: 0 });
const claude = (id: string, stamp = timestamp, output = 20) => ({ type: 'assistant', sessionId: 'claude-test', timestamp: stamp, message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: output } } });

test('archive publication is fenced after a working checkpoint if ownership changes', async () => {
  const file = path.join(await temporaryDirectory('archive-fence-'), 'usage-v3.json');
  const store = await UsageStore.load(file);
  await store.transaction(async checkpoint => {
    store.add(record('first'));
    await checkpoint();
    await store.archive();
  });
  const prior = await fs.readFile(currentArchiveFile(file), 'utf8');
  await assert.rejects(store.transaction(async checkpoint => {
    store.add(record('second'));
    await checkpoint();
    await fs.writeFile(path.join(file + '.lock', 'owner'), 'replacement');
    await store.archive();
  }), /lost the lock/);
  assert.equal(await fs.readFile(currentArchiveFile(file), 'utf8'), prior);
  assert.equal(Object.keys((await UsageStore.load(file)).data.records).length, 2);
});

test('recovery rejects a legacy archive placed at the current pathname before quarantine', async () => {
  const file = path.join(await temporaryDirectory('archive-generation-'), 'usage-v3.json');
  const archive = currentArchiveFile(file);
  await fs.mkdir(path.dirname(archive));
  await fs.writeFile(archive, JSON.stringify({ version: 2, updatedAt: timestamp, days: {}, records: {} }));
  await fs.writeFile(file, '{truncated');
  await assert.rejects(UsageStore.recover(file, () => assert.fail('must not quarantine')), /expected version 3/);
  assert.equal(await fs.readFile(file, 'utf8'), '{truncated');
});

test('created accounting files and directories are private', { skip: process.platform === 'win32' }, async () => {
  const base = await temporaryDirectory('private-ledger-');
  const dir = path.join(base, 'owned');
  const file = path.join(dir, 'usage-v3.json');
  const store = await UsageStore.load(file);
  await store.transaction(async checkpoint => {
    store.add(record('first'));
    await checkpoint();
    await store.archive();
  });
  await store.transaction(() => undefined);
  for (const folder of [dir, path.join(dir, 'archive'), path.join(dir, 'backups')]) assert.equal((await fs.stat(folder)).mode & 0o077, 0);
  const [backup] = await fs.readdir(path.join(dir, 'backups'));
  for (const target of [file, currentArchiveFile(file), path.join(dir, 'backups', backup)]) assert.equal((await fs.stat(target)).mode & 0o077, 0);
});

test('parallel installers publish the newest CLI and preserve its versioned worker', async () => {
  const root = await temporaryDirectory('install-race-');
  const make = async (version: string) => {
    const folder = path.join(root, version);
    const stamp = '// agent-usage-dock ' + version + '\n';
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'cli.js'), stamp);
    await fs.writeFile(path.join(folder, 'dshWorker.js'), stamp);
    return path.join(folder, 'cli.js');
  };
  const older = await make('1.3.0'), newer = await make('1.4.0');
  const destination = path.join(root, 'shared', 'cli.js');
  await Promise.all([installCli(newer, destination), installCli(older, destination)]);
  assert.match(await fs.readFile(destination, 'utf8'), /1\.4\.0/);
  assert.match(await fs.readFile(path.join(path.dirname(destination), 'dshWorker-1.4.0.js'), 'utf8'), /1\.4\.0/);
});

test('an in-place growing rewrite is detected even when the ends of the old prefix match', async () => {
  const file = path.join(await temporaryDirectory('growing-rewrite-'), 'log.jsonl');
  const padding = 'a'.repeat(6000) + '\n';
  await fs.writeFile(file, padding + 'old\n' + padding);
  const first = await readNewLines(file, undefined, () => {});
  await fs.writeFile(file, padding + 'new\n' + padding + 'append\n');
  const observed: string[] = [];
  const next = await readNewLines(file, first, line => observed.push(line));
  assert.equal(next.identity, first.identity);
  assert.deepEqual(observed.filter(value => value.length < 10), ['new', 'append']);
});

test('flush saves a complete final line without LF, rejects corruption and distinguishes unavailable sources', async () => {
  const root = await temporaryDirectory('strict-usage-flush-');
  const home = path.join(root, '.claude'), projects = path.join(home, 'projects');
  const shared = path.join(root, 'ledger');
  const file = path.join(projects, 'claude-test.jsonl');
  await fs.mkdir(projects, { recursive: true });
  await fs.writeFile(file, JSON.stringify(claude('msg_first')));
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'flush', ...args], {
    env: { ...process.env, HOME: root, USERPROFILE: root, AGY_TOKEN_TRACKER_HOME: shared, ANTIGRAVITY_HOME: '', DSH_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, encoding: 'utf8',
  });
  assert.equal(run('--source', 'claude').status, 0);
  const store = path.join(shared, 'usage-v3.json');
  assert.ok((await UsageStore.load(store)).data.records['claude:msg_first']);
  await fs.appendFile(file, '\n{"type":"assistant","message":{"usage":\n');
  assert.equal(run('--source', 'claude').status, 1);
  assert.equal((await UsageStore.load(store)).data.sourceHealth?.claude?.status, 'incomplete');
  const absent = run('--source', 'codex');
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /Codex: Incomplete/);
  assert.match(run('--source', 'all').stdout, /Codex: Not installed/);
  await fs.rm(projects, { recursive: true });
  await fs.writeFile(projects, 'ordinary file');
  assert.equal(run('--source', 'claude').status, 1);
});

test('copies of a Claude response preserve its earliest UTC billing date and richer counters', () => {
  const first = parseClaudeLine(JSON.stringify(claude('msg_shared', '2026-10-31T23:59:59Z', 5)), jsonlState())!;
  const second = parseClaudeLine(JSON.stringify(claude('msg_shared', '2026-11-01T00:00:01Z', 20)), jsonlState())!;
  const left = preferredRecord(first, second), right = preferredRecord(second, first);
  assert.deepEqual(left, right);
  assert.equal(left.day, '2026-10-31');
  assert.equal(left.tokens.output, 20);
});

test('Codex pairs a response missing cumulative usage and retains the match for recovery', () => {
  const observed = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
  const context = { type: 'turn_context', payload: { turn_id: 'turn', model: 'gpt-6.2-sol' } };
  const count = { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: observed, last_token_usage: observed } } };
  const response = { type: 'token_usage_record', timestamp: '2026-11-22T12:00:01Z', payload: { response_id: 'resp', turn_id: 'turn', usage: observed } };
  const read = (session: string, fork?: string, hasResponse = true) => {
    const state = jsonlState();
    const meta = { type: 'session_meta', payload: { id: session, forked_from_id: fork } };
    return [meta, context, count, ...(hasResponse ? [response] : [])].map(row => parseCodexLine(JSON.stringify(row), state)).filter((row): row is UsageRecord => !!row);
  };
  const both = read('parent');
  const problems: string[] = [];
  const facts = canonicalRecords(ledgers([...both, ...read('child', 'parent', false)]), problems);
  assert.deepEqual(Object.keys(facts), ['codex:resp']);
  assert.deepEqual(problems, []);
  assert.equal(facts['codex:resp'].evidence?.codexAlias?.total, 120);
  assert.deepEqual(Object.keys(canonicalRecords({ ...facts, ...ledgers(read('child', 'parent', false)) })), ['codex:resp']);
  const mismatched = both.map(row => row.id === 'codex:resp' ? { ...row, tokens: { ...row.tokens, output: 21 } } : row);
  assert.equal(Object.keys(canonicalRecords(ledgers(mismatched), problems)).length, 2);
  assert.match(problems.join(' '), /Ambiguous Codex/);
});

test('Antigravity accepts explicit zero counters and preserves the best available model separately', () => {
  const raw = Buffer.from('0a0608ad9eafd7064a0708ff4d10001800', 'hex');
  const database = parseDbStepMetadata(raw, 'cid', 1)!;
  const transcript = parseAntigravityLine(JSON.stringify({ step_index: 1, model: 'gemini-3.8-flash', created_at: timestamp, input_tokens: 100, output_tokens: 20 }), 'cid')!;
  const merged = preferredRecord(database, transcript);
  assert.equal(merged.model, 'gemini-3.8-flash');
  assert.equal(merged.tokens.input + merged.tokens.output, 0);
  const newer = { ...transcript, model: 'gemini-1.5-flash', evidence: { ...transcript.evidence!, revision: 72 } };
  assert.equal(preferredRecord(newer, merged).model, newer.model);
});

test('partial prices agree across the budget, session cards, detail, and CSV', () => {
  const model = 'priced-input-only';
  const pricing = new Pricing({ ['codex/' + model]: { input: 1 } });
  const base = { ...record('id'), source: 'codex' as const, model };
  const usage = aggregate(ledgers([
    { ...base, id: 'input', session: 'one', tokens: { ...emptyBucket(), input: 1e6 } },
    { ...base, id: 'output', session: 'two', tokens: { ...emptyBucket(), output: 1e6 } },
  ]));
  const summary = summarize(usage, pricing, now);
  assert.equal(summary.total, 1);
  assert.equal(summary.sessions.reduce((sum, session) => sum + session.cost, 0), 1);
  assert.equal(buildSessionDetail('codex:one', usage.sessions['codex:one'], pricing, day.slice(0, 7)).cost, 1);
  assert.deepEqual(summary.unpriced, [model]);
  assert.match(toCsv(usage.days, pricing), /1\.0000,,fixed,User override · Subtotal excludes unpriced token types/);
  assert.match(renderBody(summary, normalizeConfig({ budgetMode: 'cost', budgetLimit: 1 })), /Budget reached/);
  assert.match(renderBody(summary, normalizeConfig({ budgetMode: 'cost', budgetLimit: .5 })), /aria-valuemax="0.5" aria-valuenow="0.5" aria-valuetext="\$1.00 of \$0.50"/);
});

test('default rates are exact or recognized aliases, and provider overrides stay isolated', () => {
  const pricing = new Pricing({ 'dsh/m': { input: 3 }, 'dsh[route]/m': { input: 2 }, m: { output: 5 } });
  assert.equal(pricing.rateFor('gemini-1.0-pro')?.input, .5);
  assert.equal(pricing.rateFor('gpt-99-unlisted'), undefined);
  assert.equal(pricing.rateFor('claude-opus-4-10', 'claude'), undefined);
  assert.equal(pricing.rateFor('gpt-6.2-sol-2026-11-20', 'codex')?.input, 2);
  assert.equal(pricing.rateFor('m', 'dsh', 'route')?.input, 2);
  assert.equal(pricing.rateFor('m', 'dsh', 'other')?.input, 3);
  assert.equal(pricing.rateFor('m', 'codex')?.output, 5);
  assert.ok(pricing.rateFor('m', 'codex')?.missing?.includes('input'));
  const two = { ...emptyBucket(), input: 10, requests: 1 };
  const days = { [day]: { dsh: { '["route","m","peak"]': two, '["route","m","offpeak"]': two } } };
  const csv = toCsv(days, pricing);
  assert.equal(csv.trim().split('\n').length, 2);
  assert.match(csv, /,dsh,m,2,20,/);
});

test('a disabled collector preserves the prior accounting and its scan is reported separately', async () => {
  const root = await temporaryDirectory('disabled-source-');
  const file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  await store.transaction(() => void store.add({ ...record('codex:kept'), source: 'codex' }));
  const result = await refreshUsage(store, file, undefined, false, { source: 'codex', codexEnabled: false, codexHome: path.join(root, 'unused') });
  assert.deepEqual(result.sources, [{ source: 'codex', status: 'disabled' }]);
  assert.ok(store.data.records['codex:kept']);
});
