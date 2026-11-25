import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { acquireFileLock } from '../src/fileLock';
import { UsageStore } from '../src/store';
import { temporaryDirectory } from './temp';
import { captureIntervals, type CapturedTimers, FakeUri, installFakeVscode } from './vscodeFake';

const fake = installFakeVscode();
const { activate } = require('../src/extension') as typeof import('../src/extension');

const COMMANDS = [
  'agyTokenTracker.refresh', 'agyTokenTracker.openPanel', 'agyTokenTracker.setBudget', 'agyTokenTracker.configureRates', 'agyTokenTracker.exportCsv', 'agyTokenTracker.exportOfflineHtml', 'agyTokenTracker.rebuildHistory',
  'agyTokenMonitor.refresh', 'agyTokenMonitor.openPanel', 'agyTokenMonitor.setBudget', 'agyTokenMonitor.exportCsv', 'agyTokenMonitor.rebuildHistory',
];
const BUTTONS = ['Retry', 'Open Data Folder', 'Show Log'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const today = new Date().toISOString().slice(0, 10);

const claudeLine = (n: number, over: { model?: string; session?: string; title?: string } = {}) => JSON.stringify({
  type: 'assistant', timestamp: `${today}T0${n}:00:00.000Z`, sessionId: over.session ?? 'sess-1', requestId: `req_${over.session ?? 'sess-1'}_${n}`, uuid: `u${over.session ?? 'sess-1'}${n}`, cwd: '/work/proj',
  message: { id: `msg_${over.session ?? 'sess-1'}_${n}`, model: over.model ?? 'claude-sonnet-5-5', usage: { input_tokens: 1000 * n, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 } },
});

interface Launched {
  root: string;
  state: string;
  claude: string;
  storeFile: string;
  context: { subscriptions: { dispose(): unknown }[]; extensionPath: string; extensionUri: FakeUri };
  intervals: CapturedTimers;
  command(id: string): (...args: unknown[]) => Promise<unknown>;
  waitFor(label: string, condition: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  writeLog(name: string, ...lines: string[]): Promise<void>;
  close(): Promise<void>;
}

const ENVIRONMENT = ['HOME', 'USERPROFILE', 'AGY_TOKEN_TRACKER_HOME', 'AGY_TOKEN_MONITOR_HOME', 'ANTIGRAVITY_HOME', 'DSH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

/** Activates the extension against throwaway folders only: the home folder, the shared store and every log root are under one temporary directory. */
async function launch(options: { settings?: Record<string, unknown>; prepare?: (root: string, state: string) => Promise<void>; logs?: boolean } = {}): Promise<Launched> {
  const root = await temporaryDirectory('extension-');
  const [state, claude, codex, agy, extension] = ['state', 'claude', 'codex', 'agy', 'extension'].map(name => path.join(root, name));
  await Promise.all([path.join(claude, 'projects', 'proj'), path.join(codex, 'sessions'), agy, path.join(extension, 'dist'), path.join(extension, 'media')].map(dir => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(extension, 'dist', 'cli.js'), '// agent-usage-dock 1.3.0\nrun();\n');
  const saved = ENVIRONMENT.map(name => process.env[name]);
  for (const name of ENVIRONMENT) delete process.env[name];
  Object.assign(process.env, { HOME: root, USERPROFILE: root, AGY_TOKEN_TRACKER_HOME: state });
  fake.reset();
  fake.user.agyTokenTracker = { claudeHome: claude, codexHome: codex, antigravityHome: agy, dshEnabled: false, antigravityEnabled: false, pollIntervalSeconds: 15, ...options.settings };
  const intervals = captureIntervals();
  if (options.logs !== false) await fs.writeFile(path.join(claude, 'projects', 'proj', 'sess-1.jsonl'), [claudeLine(1), claudeLine(2)].join('\n') + '\n');
  await options.prepare?.(root, state);
  const context = { subscriptions: [] as { dispose(): unknown }[], extensionPath: extension, extensionUri: new FakeUri(extension) };
  await activate(context as never);
  const waitFor: Launched['waitFor'] = async (label, condition, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n${fake.log}`);
      await sleep(10);
    }
  };
  return {
    root, state, claude, storeFile: path.join(state, 'usage-v3.json'), context, intervals, waitFor,
    command: id => {
      const handler = fake.commands.get(id);
      assert.ok(handler, `${id} is registered`);
      return async (...args) => handler(...args);
    },
    writeLog: (name, ...lines) => fs.writeFile(path.join(claude, 'projects', 'proj', name), lines.join('\n') + '\n'),
    close: async () => {
      for (const subscription of [...context.subscriptions].reverse()) subscription.dispose();
      await sleep(40);
      intervals.restore();
      ENVIRONMENT.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    },
  };
}

const polled = (app: Launched) => app.waitFor('the first poll', () => /usage records added or updated/.test(fake.log));
const answerOnce = (...answers: (string | undefined)[]) => fake.warningAnswers.push(...answers);

test('activation registers every command, reads the store and the logs, shows the totals and installs the CLI', async () => {
  const app = await launch();
  try {
    assert.deepEqual([...fake.commands.keys()].sort(), [...COMMANDS].sort());
    await polled(app);
    const stored = await UsageStore.load(app.storeFile);
    assert.deepEqual(Object.keys(stored.data.records).sort(), ['claude:msg_sess-1_1', 'claude:msg_sess-1_2']);
    assert.equal(fake.statusBarItem.command, 'agyTokenTracker.openPanel');
    assert.doesNotMatch(String(fake.statusBarItem.text), /…tok/);
    await app.waitFor('the CLI copy', () => fs.readFile(path.join(app.state, 'cli.js'), 'utf8').then(text => /agent-usage-dock 1\.3\.0/.test(text), () => false));
    assert.equal(app.intervals.timers.length, 1);
    assert.equal(app.intervals.timers[0].ms, 15_000);
  } finally { await app.close(); }
});

test('the dashboard opens, renders and shows the detail of a session', async () => {
  const app = await launch();
  try {
    await polled(app);
    await app.command('agyTokenTracker.openPanel')();
    const panel = fake.panels[0];
    assert.ok(panel, 'a panel was created');
    assert.equal(panel.viewType, 'agyTokenTracker');
    panel.send({ type: 'ready' });
    await app.waitFor('the page content', () => panel.posted('render').length > 0);
    assert.match(String(panel.posted('render')[0].html), /claude:sess-1/);
    panel.send({ type: 'openSession', key: 'claude:sess-1' });
    await app.waitFor('the session detail', () => panel.posted('detail').length > 0);
    assert.equal(panel.posted('detail')[0].key, 'claude:sess-1');
    panel.dispose();
  } finally { await app.close(); }
});

test('an unreadable store leaves every command registered, and each one says why and offers the way out', async () => {
  const app = await launch({ prepare: (_root, state) => fs.mkdir(state, { recursive: true }).then(() => fs.writeFile(path.join(state, 'usage-v3.json'), JSON.stringify({ version: 99, days: {} }))) });
  try {
    await app.waitFor('the failure to be logged', () => /could not load stored usage/.test(fake.log));
    assert.deepEqual([...fake.commands.keys()].sort(), [...COMMANDS].sort());
    for (const id of COMMANDS) {
      const before = fake.warnings.length;
      await app.command(id)();
      assert.equal(fake.warnings.length, before + 1, `${id} shows one warning`);
      const warning = fake.warnings[fake.warnings.length - 1];
      assert.deepEqual(warning.items, BUTTONS, id);
      assert.match(warning.message, /unsupported store version 99/, id);
    }
    assert.deepEqual([fake.panels.length, fake.inputs.length, fake.infos.length], [0, 0, 0], 'no command ran its normal job');
    answerOnce('Open Data Folder', 'Show Log');
    await app.command('agyTokenTracker.refresh')();
    await app.command('agyTokenTracker.refresh')();
    assert.deepEqual(fake.external, [app.state]);
    assert.equal(fake.channel.shown, 1);
  } finally { await app.close(); }
});

test('the status bar item stays clickable while the store is unavailable, and clicking it explains why', async () => {
  const app = await launch({ prepare: (_root, state) => fs.mkdir(state, { recursive: true }).then(() => fs.writeFile(path.join(state, 'usage-v3.json'), JSON.stringify({ version: 99, days: {} }))) });
  try {
    await app.waitFor('the failure to be logged', () => /could not load stored usage/.test(fake.log));
    const clicked = fake.statusBarItem.command;
    assert.equal(clicked, 'agyTokenTracker.openPanel');
    await app.command(clicked as string)();
    assert.match(fake.warnings.at(-1)?.message ?? '', /unsupported store version 99/);
  } finally { await app.close(); }
});

test('a store that fails to load is retried on the poll interval and heals by itself, and the log reports only a changed reason', async () => {
  const app = await launch({ prepare: (_root, state) => fs.mkdir(state, { recursive: true }).then(() => fs.writeFile(path.join(state, 'usage-v3.json'), JSON.stringify({ version: 99, days: {} }))) });
  try {
    await app.waitFor('the failure to be logged', () => /could not load stored usage/.test(fake.log));
    const [timer] = app.intervals.timers;
    const failures = () => (fake.log.match(/could not load stored usage/g) ?? []).length;
    timer.callback();
    timer.callback();
    await sleep(100);
    assert.equal(failures(), 1, 'the same reason is logged once');
    await fs.writeFile(app.storeFile, JSON.stringify({ version: 98, days: {} }));
    timer.callback();
    await app.waitFor('the new reason', () => failures() === 2);
    assert.match(fake.log, /unsupported store version 98/);

    await fs.rm(app.storeFile);
    timer.callback();
    await polled(app);
    assert.match(fake.log, /stored usage loaded after an earlier failure/);
    assert.ok((await UsageStore.load(app.storeFile)).data.records['claude:msg_sess-1_1']);
    const before = fake.warnings.length;
    await app.command('agyTokenTracker.refresh')();
    assert.equal(fake.warnings.length, before, 'commands work once the store is ready');
    assert.doesNotMatch(String(fake.statusBarItem.text), /\$\(error\)/);
  } finally { await app.close(); }
});

test('Retry on the warning tries again at once, and a failure that persists is reported again', async () => {
  const app = await launch({ prepare: (_root, state) => fs.mkdir(state, { recursive: true }).then(() => fs.writeFile(path.join(state, 'usage-v3.json'), JSON.stringify({ version: 99, days: {} }))) });
  try {
    await app.waitFor('the failure to be logged', () => /could not load stored usage/.test(fake.log));
    answerOnce('Retry', undefined);
    await app.command('agyTokenTracker.openPanel')();
    assert.equal(fake.warnings.length, 2, 'the failed retry shows the reason again');
    answerOnce('Retry');
    await fs.rm(app.storeFile);
    const pending = app.command('agyTokenTracker.openPanel')();
    await pending;
    await polled(app);
    assert.ok((await UsageStore.load(app.storeFile)).data.records['claude:msg_sess-1_2']);
  } finally { await app.close(); }
});

test('a damaged archive is reported with its file and the README pointer, and is not moved', async () => {
  const archive = (state: string) => path.join(state, 'archive', 'history-ledger-v3.json');
  const app = await launch({ prepare: async (_root, state) => { await fs.mkdir(path.dirname(archive(state)), { recursive: true }); await fs.writeFile(archive(state), '{broken'); } });
  try {
    await app.waitFor('the failure to be logged', () => /could not load stored usage/.test(fake.log));
    await app.command('agyTokenTracker.exportCsv')();
    const message = fake.warnings[0].message;
    assert.ok(message.includes(archive(app.state)) && message.includes('README'), message);
    assert.equal(await fs.readFile(archive(app.state), 'utf8'), '{broken');
    assert.deepEqual((await fs.readdir(path.dirname(archive(app.state)))), ['history-ledger-v3.json']);
  } finally { await app.close(); }
});

test('a settings change that arrives during a poll gets one more poll afterwards, with the new settings', async () => {
  const app = await launch();
  try {
    await polled(app);
    const other = path.join(app.root, 'claude-two');
    await fs.mkdir(path.join(other, 'projects', 'p2'), { recursive: true });
    await fs.writeFile(path.join(other, 'projects', 'p2', 'sess-2.jsonl'), claudeLine(3, { session: 'sess-2' }) + '\n');

    const lock = await acquireFileLock(app.storeFile);
    const poll = app.command('agyTokenTracker.refresh')();
    await sleep(150);
    await fake.setSetting('claudeHome', other);
    await sleep(150);
    assert.equal((await UsageStore.load(app.storeFile)).data.records['claude:msg_sess-2_3'], undefined, 'the poll in flight is still waiting for the store');
    await lock.release();
    await poll;
    await app.waitFor('the poll with the new settings', async () => !!(await UsageStore.load(app.storeFile)).data.records['claude:msg_sess-2_3']);
    assert.match(fake.log, /1 usage records added or updated/);
  } finally { await app.close(); }
});

test('the poll timer is re-armed only when the interval changes', async () => {
  const app = await launch();
  try {
    await polled(app);
    const { timers } = app.intervals;
    assert.deepEqual(timers.map(t => [t.ms, t.cleared]), [[15_000, false]]);
    await fake.setSetting('dashboardTheme', 'dark');
    await fake.setSetting('budgetLimit', 20);
    await fake.setSetting('rates', {});
    assert.deepEqual(timers.map(t => [t.ms, t.cleared]), [[15_000, false]], 'other settings leave the timer alone');
    await fake.setSetting('pollIntervalSeconds', 30);
    assert.deepEqual(timers.map(t => [t.ms, t.cleared]), [[15_000, true], [30_000, false]]);
    await fake.setSetting('pollIntervalSeconds', 30);
    assert.equal(timers.length, 2);
  } finally { await app.close(); }
});

test('Export CSV writes the usage table where the save dialog says, and nothing when it is cancelled', async () => {
  const app = await launch();
  try {
    await polled(app);
    await app.command('agyTokenTracker.exportCsv')();
    const target = path.join(app.root, 'usage.csv');
    fake.saveTo = target;
    await app.command('agyTokenTracker.exportCsv')();
    const [header, row] = (await fs.readFile(target, 'utf8')).trim().split('\n');
    assert.match(header, /^day,source,model,requests,/);
    assert.match(row, new RegExp(`^${today},claude,claude-sonnet-5-5,2,`));
    await app.command('agyTokenMonitor.exportCsv')();
  } finally { await app.close(); }
});

test('Set Monthly Budget saves the limit in the unit of the budget mode, and a change re-renders the status bar', async () => {
  const app = await launch();
  try {
    await polled(app);
    fake.inputAnswers.push('1');
    await app.command('agyTokenTracker.setBudget')();
    assert.deepEqual(fake.updates.map(u => [u.key, u.value, u.target]), [['tokenBudgetLimit', 1, 1]]);
    assert.match(fake.infos[0], /monthly budget set to 1M tokens/);
    await app.waitFor('the percentage', () => /\d+%/.test(String(fake.statusBarItem.text)));

    await fake.setSetting('budgetMode', 'cost');
    fake.updates.length = 0;
    fake.inputAnswers.push('5');
    await app.command('agyTokenTracker.setBudget')();
    assert.deepEqual(fake.updates.map(u => [u.key, u.value]), [['budgetLimit', 5]]);
    assert.match(fake.inputs[1].title ?? '', /Cost Budget/);

    fake.updates.length = 0;
    fake.inputAnswers.push('0');
    await app.command('agyTokenTracker.setBudget')();
    assert.match(fake.infos[fake.infos.length - 1], /budget indicators turned off/);
    fake.inputAnswers.push(undefined);
    await app.command('agyTokenTracker.setBudget')();
    assert.deepEqual(fake.updates.map(u => u.value), [0], 'cancelling changes nothing');
  } finally { await app.close(); }
});

test('Configure Rates offers unpriced models first in code-unit order, asks the five rates in order, and saves only the changes', async () => {
  const app = await launch({ logs: false });
  try {
    await app.writeLog('rates.jsonl', claudeLine(1), claudeLine(2, { model: 'a-unpriced' }), claudeLine(3, { model: 'B-unpriced' }));
    await app.command('agyTokenTracker.refresh')();
    await app.waitFor('the poll that reads them', () => /3 usage records added or updated/.test(fake.log));
    fake.quickPickAnswers.push(choices => choices.find((choice: { label: string }) => choice.label === 'a-unpriced'));
    fake.inputAnswers.push('7', '', '', '', '70');
    await app.command('agyTokenTracker.configureRates')();
    assert.deepEqual(fake.quickPicks[0].labels, ['B-unpriced', 'a-unpriced', 'claude-sonnet-5-5']);
    assert.deepEqual(fake.inputs.map(input => input.title?.split(' · ').pop()), ['Input', 'Cache read', 'Cache write', 'Cache write (1h)', 'Output']);
    assert.deepEqual(fake.updates.map(u => [u.key, u.value, u.target]), [['rates', { 'claude/a-unpriced': { input: 7, output: 70 } }, 1]]);

    fake.updates.length = 0;
    fake.quickPickAnswers.push(choices => choices.find((choice: { label: string }) => choice.label === 'claude-sonnet-5-5'));
    fake.inputAnswers.push('', '', '', '', '');
    await app.command('agyTokenTracker.configureRates')();
    assert.deepEqual(fake.updates, [], 'nothing differs from the built-in rate');

    fake.inputAnswers.push('1', undefined);
    await app.command('agyTokenTracker.configureRates')();
    assert.deepEqual(fake.updates, [], 'cancelling part-way saves nothing');
  } finally { await app.close(); }
});

test('Rebuild History asks first, then re-reads the logs and keeps a copy of the store', async () => {
  const app = await launch();
  try {
    await polled(app);
    await app.command('agyTokenTracker.rebuildHistory')();
    assert.equal(fake.warnings.at(-1)?.modal, true);
    assert.deepEqual(fake.warnings.at(-1)?.items, ['Rebuild']);
    assert.doesNotMatch(fake.log, /rebuild: history saved/);

    answerOnce('Rebuild');
    await app.command('agyTokenMonitor.rebuildHistory')();
    assert.match(fake.log, /rebuild: history saved to .*usage-v3-pre-rebuild-/);
    const copies = (await fs.readdir(path.join(app.state, 'backups'))).filter(name => name.includes('pre-rebuild'));
    assert.equal(copies.length, 1);
    assert.equal(Object.keys((await UsageStore.load(app.storeFile)).data.records).length, 2, 'the rebuild loses nothing');
  } finally { await app.close(); }
});

test('after the first poll, cursors of logs that are gone and lie outside every source folder are forgotten, those of a disabled source are not', async () => {
  const cursor = { size: 1, mtimeMs: 1, offset: 1 };
  const app = await launch({
    prepare: async (root, state) => {
      const elsewhere = path.join(root, 'old-setting');
      await fs.mkdir(elsewhere, { recursive: true });
      await fs.writeFile(path.join(elsewhere, 'still-there.jsonl'), '');
      await fs.mkdir(state, { recursive: true });
      await fs.writeFile(path.join(state, 'usage-v3.json'), JSON.stringify({
        version: 3, records: {}, days: {},
        files: {
          [path.join(elsewhere, 'gone.jsonl')]: cursor,
          [path.join(elsewhere, 'still-there.jsonl')]: cursor,
          [path.join(root, 'agy', 'brain', 'c1', '.system_generated', 'logs', 'transcript.jsonl')]: cursor,
        },
      }));
    },
  });
  try {
    await polled(app);
    await app.waitFor('the pruned store', async () => !Object.keys((await UsageStore.load(app.storeFile)).data.files).some(key => key.endsWith('gone.jsonl')));
    const kept = Object.keys((await UsageStore.load(app.storeFile)).data.files).map(key => path.relative(app.root, key)).filter(key => !key.startsWith('claude'));
    assert.deepEqual(kept.sort(), [path.join('agy', 'brain', 'c1', '.system_generated', 'logs', 'transcript.jsonl'), path.join('old-setting', 'still-there.jsonl')]);
    assert.doesNotMatch(fake.log, /poll failed/);
  } finally { await app.close(); }
});

test('exportOfflineHtml writes a self-contained HTML file and leaves nothing on cancel', async () => {
  const app = await launch();
  try {
    await polled(app);
    const outFile = path.join(app.root, 'offline.html');
    fake.saveTo = undefined;
    await app.command('agyTokenTracker.exportOfflineHtml')();
    await assert.rejects(() => fs.stat(outFile));

    fake.saveTo = outFile;
    await app.command('agyTokenTracker.exportOfflineHtml')();
    const html = await fs.readFile(outFile, 'utf8');
    assert.match(html, /Offline snapshot · exported/);
    assert.match(html, /claude:sess-1/);
    assert.match(fake.infos.at(-1) ?? '', /private location/);
  } finally { await app.close(); }
});

test('disposing the extension stops the timer and unregisters the commands', async () => {
  const app = await launch();
  await polled(app);
  await app.close();
  assert.equal(app.intervals.timers[0].cleared, true);
  assert.equal(fake.commands.size, 0);
  assert.equal(fake.statusBarItem.disposed, true);
});
