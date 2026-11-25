import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { temporaryDirectory } from './temp';
import { captureIntervals, FakeUri, installFakeVscode } from './vscodeFake';

const fake = installFakeVscode();
const { activate } = require('../src/extension') as typeof import('../src/extension');

const ENVIRONMENT = ['HOME', 'USERPROFILE', 'AGY_TOKEN_TRACKER_HOME', 'AGY_TOKEN_MONITOR_HOME', 'ANTIGRAVITY_HOME', 'DSH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const today = new Date().toISOString().slice(0, 10);

const claudeLine = (n: number, model: string) => JSON.stringify({
  type: 'assistant', timestamp: `${today}T0${n}:00:00.000Z`, sessionId: 'sess-1', requestId: `req_${n}`, uuid: `u${n}`, cwd: '/work/proj',
  message: { id: `msg_${n}`, model, usage: { input_tokens: 1000 * n, output_tokens: 500 } },
});

/** Activates the extension against throwaway folders only, with the Claude Code log holding one request of each of `models`. */
async function launch(models: string[], settings: Record<string, unknown> = {}) {
  const root = await temporaryDirectory('review-extension-');
  const [state, claude, codex, antigravity, extension] = ['state', 'claude', 'codex', 'antigravity', 'extension'].map((name) => path.join(root, name));
  await Promise.all([path.join(claude, 'projects', 'proj'), path.join(codex, 'sessions'), antigravity, path.join(extension, 'dist'), path.join(extension, 'media')].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(extension, 'dist', 'cli.js'), '// agent-usage-dock 1.3.0\nrun();\n');
  await fs.writeFile(path.join(claude, 'projects', 'proj', 'sess-1.jsonl'), models.map((model, i) => claudeLine(i + 1, model)).join('\n') + '\n');
  const saved = ENVIRONMENT.map((name) => process.env[name]);
  for (const name of ENVIRONMENT) delete process.env[name];
  Object.assign(process.env, { HOME: root, USERPROFILE: root, AGY_TOKEN_TRACKER_HOME: state });
  fake.reset();
  fake.user.agyTokenTracker = { claudeHome: claude, codexHome: codex, antigravityHome: antigravity, dshEnabled: false, pollIntervalSeconds: 15, ...settings };
  const intervals = captureIntervals();
  const context = { subscriptions: [] as { dispose(): unknown }[], extensionPath: extension, extensionUri: new FakeUri(extension) };
  await activate(context as never);
  const waitFor = async (label: string, condition: () => boolean) => {
    for (let waited = 0; !condition(); waited += 10) {
      if (waited > 8000) throw new Error(`timed out waiting for ${label}\n${fake.log}`);
      await sleep(10);
    }
  };
  await waitFor('the first poll', () => /usage records added or updated/.test(fake.log));
  return {
    state, antigravity, waitFor,
    command: (id: string) => fake.commands.get(id)!,
    close: async () => {
      for (const subscription of [...context.subscriptions].reverse()) subscription.dispose();
      await sleep(40);
      intervals.restore();
      ENVIRONMENT.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    },
  };
}

test('the dashboard names the ledger file and the archive folder the extension really uses, not the log folder of Antigravity', async () => {
  const app = await launch(['claude-sonnet-5-5']);
  try {
    app.command('agyTokenTracker.openPanel')();
    const panel = fake.panels[0];
    panel.send({ type: 'ready' });
    await app.waitFor('the page', () => panel.posted('render').length > 0);
    const { document } = parseHTML(String(panel.posted('render')[0].html));
    const fold = document.querySelector('[data-key="storage-details"]')!;
    assert.deepEqual([...fold.querySelectorAll('p.mono')].map((p) => [p.querySelector('b')!.textContent, p.querySelector('bdi')!.textContent]), [
      ['Ledger file', path.join(app.state, 'usage-v3.json')],
      ['Archive folder', path.join(app.state, 'archive')],
    ]);
    assert.doesNotMatch(fold.textContent!, new RegExp(path.basename(app.antigravity)));
    const card = [...document.querySelectorAll('.source-health')].find((article) => article.querySelector('.name')!.textContent === 'Antigravity');
    assert.equal(card?.querySelector('details code')?.textContent, app.antigravity, 'the log folder stays on the card of its tool');
  } finally { await app.close(); }
});

test('Configure Rates writes the rates of the scope it saves to and no others, so the rates of the user do not end up in a workspace file', async () => {
  const app = await launch(['claude-sonnet-5-5', 'a-unpriced']);
  try {
    fake.user.agyTokenTracker.rates = { 'claude/other-model': { input: 9 }, 'claude/a-unpriced': { input: 1 } };
    fake.workspaceValues.agyTokenTracker = { rates: { 'claude/a-unpriced': { output: 2 } } };
    fake.quickPickAnswers.push((choices) => choices.find((choice: { label: string }) => choice.label === 'a-unpriced'));
    fake.inputAnswers.push('7', '', '', '', '');
    await app.command('agyTokenTracker.configureRates')();
    assert.deepEqual(fake.updates.map((update) => [update.key, update.value, update.target]), [['rates', { 'claude/a-unpriced': { input: 7 } }, 2]],
      'the workspace file gets the workspace rates with this model changed, and not the rate of another model that only the user set');
  } finally { await app.close(); }
});

test('Configure Rates carries the rates of the old section over to the new one while the new one has none', async () => {
  const app = await launch(['a-unpriced']);
  try {
    fake.user.agyTokenMonitor = { rates: { 'claude/other-model': { input: 9 } } };
    fake.quickPickAnswers.push((choices) => choices.find((choice: { label: string }) => choice.label === 'a-unpriced'));
    fake.inputAnswers.push('7', '', '', '', '');
    await app.command('agyTokenTracker.configureRates')();
    assert.deepEqual(fake.updates.map((update) => [update.key, update.value, update.target]), [['rates', { 'claude/other-model': { input: 9 }, 'claude/a-unpriced': { input: 7 } }, 1]]);
  } finally { await app.close(); }
});
