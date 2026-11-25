import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { refreshUsage } from '../src/scan';
import { activeSessionKeys } from '../src/sessionActivity';
import { findSessionLog, readSessionInfo } from '../src/sessionInfo';
import { UsageStore } from '../src/store';
import { summarize, toCsv } from '../src/summary';
import { temporaryDirectory } from './temp';

const timestamp = '2026-11-22T23:30:00Z';
const day = '2026-11-22';
const jsonl = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const codexUsage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 };
const counter = { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { last_token_usage: codexUsage, total_token_usage: codexUsage } } };
const response = { type: 'token_usage_record', timestamp, payload: { response_id: 'resp_one', usage: codexUsage, thread_token_usage: codexUsage } };
const meta = (id: string) => ({ type: 'session_meta', payload: { id, cwd: '/work/dock', git: { branch: 'main' } } });
const context = (model: string) => ({ type: 'turn_context', payload: { model } });
const claudeRequest = (output: number) => ({
  type: 'assistant', timestamp, sessionId: 'claude-one', cwd: '/work/dock',
  message: {
    id: 'msg_one', model: 'claude-sonnet-5-5',
    usage: {
      input_tokens: 50, cache_read_input_tokens: 40, cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 2 }, output_tokens: output,
    },
  },
});

async function writeLog(file: string, ...rows: object[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, jsonl(...rows));
}

test('Claude Code and Codex share the Dock ledger, with stable accounting across mirrors, rescan and recovery', async () => {
  const root = await temporaryDirectory('dock-agents-');
  const antigravityHome = path.join(root, 'agy');
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  const homes = { claudeHome, codexHome };
  const claude = path.join(claudeHome, 'projects', 'dock', 'claude-one.jsonl');
  const active = path.join(codexHome, 'sessions', '2026', '11', '22', 'rollout-codex-one.jsonl');
  const archived = path.join(codexHome, 'archived_sessions', path.basename(active));
  const legacy = path.join(codexHome, 'archived_sessions', 'rollout-codex-legacy.jsonl');
  await Promise.all([
    fs.mkdir(antigravityHome),
    writeLog(claude, { type: 'user', message: { content: 'Claude fixture prompt' }, cwd: '/work/dock', gitBranch: 'main' }, claudeRequest(2), claudeRequest(20), { type: 'ai-title', aiTitle: 'Fixture title' }),
    writeLog(path.join(claudeHome, 'projects', 'dock', 'fork.jsonl'), claudeRequest(2)),
    writeLog(active, meta('codex-one'), context('gpt-6.2-sol'), { type: 'event_msg', payload: { type: 'user_message', message: 'Codex fixture prompt' } }, counter),
    writeLog(legacy, meta('codex-legacy'), context('gpt-99-no-rate'), counter, counter),
  ]);
  const file = path.join(root, 'usage-v3.json');
  let store = await UsageStore.load(file);
  await store.transaction(() => store.add({
    id: 'antigravity:existing:1', source: 'antigravity', day, model: 'gemini-1.5-flash',
    session: 'existing', tokens: { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
  }));
  const options = { source: 'all' as const, ...homes, dshEnabled: false };
  const first = await refreshUsage(store, file, antigravityHome, false, options);
  assert.deepEqual(first.problems, []);
  assert.equal(Object.keys(store.data.records).length, 4);
  assert.equal(store.data.records['claude:msg_one'].tokens.output, 20);
  assert.equal(store.data.records['codex:count:codex-one:120'].model, 'gpt-6.2-sol');

  await fs.appendFile(active, jsonl(response, counter, response));
  store = await UsageStore.load(file);
  await refreshUsage(store, file, antigravityHome, false, options);
  const responseRecord = store.data.records['codex:resp_one'];
  assert.deepEqual(responseRecord.tokens, { input: 50, cacheRead: 40, cacheWrite: 10, cacheWrite1h: 0, output: 20 });
  assert.equal(store.data.records['codex:count:codex-one:120'], undefined);
  assert.deepEqual(activeSessionKeys(store.data.files), new Set(['claude:claude-one', 'codex:codex-one', 'codex:codex-legacy']));
  assert.equal((await refreshUsage(store, file, antigravityHome, false, options)).changed, 0);

  const pricing = new Pricing();
  const summary = summarize(store.data, pricing, Date.parse('2026-11-23T00:30:00Z'));
  assert.equal(summary.totalRequests, 4);
  assert.equal(summary.tokensBySource.codex.requests, 2);
  assert.equal(summary.tokensBySource.claude.cacheWrite1h, 2);
  assert.deepEqual(summary.unpriced, ['gpt-99-no-rate']);
  assert.ok(Math.abs(summary.bySource.claude - 332e-6) < 1e-12);
  assert.ok(Math.abs(summary.bySource.codex - 329e-6) < 1e-12);
  const html = renderBody(summary, normalizeConfig({ tokenBudgetLimit: 1 }));
  assert.match(html, /data-filter="claude"[^>]*checked><i class="dot claude"><\/i><span>Claude Code</);
  assert.match(html, /data-filter="codex"[^>]*checked><i class="dot codex"><\/i><span>Codex</);
  assert.match(html, /class="seg claude/);
  assert.match(html, /class="seg codex/);
  const csv = toCsv(store.data.days, pricing);
  assert.match(csv, /,claude,claude-sonnet-5-5,1,50,40,8,2,20,0\.0003/);
  assert.match(csv, /,codex,gpt-99-no-rate,1,50,40,10,0,20,,,fixed,/);
  const ledger = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(ledger, /fixture prompt|Fixture title/);

  assert.equal(await findSessionLog('claude', 'claude-one', '', homes), claude);
  assert.equal(await findSessionLog('claude', 'claude-one', '', homes, store.data.files), claude);
  const claudeInfo = await readSessionInfo('claude', claude);
  assert.equal(claudeInfo.title, 'Fixture title');
  assert.equal(claudeInfo.firstPrompt, 'Claude fixture prompt');
  assert.equal(claudeInfo.branch, 'main');
  await fs.copyFile(active, archived);
  assert.equal(await findSessionLog('codex', 'codex-one', '', homes), active);
  await fs.unlink(active);
  assert.equal(await findSessionLog('codex', '../codex-one', '', homes), undefined);
  assert.equal(await findSessionLog('codex', 'codex-one', '', homes), archived);
  assert.equal(await findSessionLog('codex', 'codex-one', '', homes, store.data.files), archived);
  const codexInfo = await readSessionInfo('codex', archived);
  assert.equal(codexInfo.firstPrompt, 'Codex fixture prompt');
  assert.equal(codexInfo.cwd, '/work/dock');

  await fs.unlink(claude);
  await refreshUsage(store, file, antigravityHome, true, options);
  assert.equal(store.data.records['claude:msg_one'].tokens.output, 20);
  assert.equal(Object.keys(store.data.records).length, 4);
  await fs.unlink(file);
  const recovered = await UsageStore.recover(file, () => {});
  assert.equal(Object.keys(recovered.data.records).length, 4);
});

test('CLI accepts the new source and home flags and leaves other sources out of the flush', async () => {
  const root = await temporaryDirectory('dock-cli-agents-');
  const claude = path.join(root, 'claude');
  const codex = path.join(root, 'codex');
  const shared = path.join(root, 'shared');
  await Promise.all([
    writeLog(path.join(claude, 'projects', 'dock', 'claude-one.jsonl'), claudeRequest(20)),
    writeLog(path.join(codex, 'sessions', 'rollout-codex-one.jsonl'), meta('codex-one'), context('gpt-6.2-sol'), response, counter),
  ]);
  const flush = (source: string, ...args: string[]) => spawnSync(process.execPath, [
    path.join(__dirname, '..', 'src', 'cli.js'), 'flush', '--source', source, '--home', path.join(root, 'missing-antigravity'),
    ...args,
  ], { env: { ...process.env, AGY_TOKEN_TRACKER_HOME: shared }, encoding: 'utf8' });
  assert.equal(flush('claude', '--claude-home', claude).status, 0);
  let store = await UsageStore.load(path.join(shared, 'usage-v3.json'));
  assert.deepEqual(Object.keys(store.data.records), ['claude:msg_one']);
  assert.equal(store.data.sourceHealth?.claude?.status, 'ok');
  assert.equal(store.data.sourceHealth?.codex, undefined);
  const bad = flush('codex', '--codex-home', path.join(root, 'missing-codex'));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Codex data directory unavailable/);
  assert.equal(flush('codex', '--codex-home', codex).status, 0);
  store = await UsageStore.load(path.join(shared, 'usage-v3.json'));
  assert.deepEqual(Object.keys(store.data.records).sort(), ['claude:msg_one', 'codex:resp_one']);
  assert.equal(store.data.sourceHealth?.codex?.status, 'ok');
});
