import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { installVscode } from './vscodeStub';

interface Posted { type: string; html?: string; theme?: string }
const posted: Posted[] = [];
const created: unknown[][] = [];
let onMessage: (m: unknown) => Promise<void> = async () => undefined;
let dispose: () => void = () => undefined;
let viewStateChanged: () => void = () => undefined;
const panel = {
  visible: true,
  webview: { html: '', postMessage: (m: Posted) => (posted.push(m), Promise.resolve(true)), onDidReceiveMessage: (fn: typeof onMessage) => (onMessage = fn) },
  onDidDispose: (fn: () => void) => (dispose = fn),
  onDidChangeViewState: (fn: () => void) => (viewStateChanged = fn),
  reveal: () => undefined,
};
installVscode({ window: { createWebviewPanel: (...args: unknown[]) => (created.push(args), panel) }, ViewColumn: { Active: 1, Beside: 2 } });
const { UsagePanel } = require('../src/panel') as typeof import('../src/panel');

const cfg: Config = normalizeConfig({});
const summary = () => summarize({ days: {}, sessions: {} }, new Pricing());
const settle = () => new Promise((r) => setTimeout(r, 10));
const kinds = () => posted.splice(0).map((m) => (m.type === 'detail' ? `detail:${m.html}` : m.type));
const months: unknown[] = [];
const zones: unknown[] = [];
const provider = (detail: () => Promise<string> = async () => '') => ({
  detail,
  openLog: async () => undefined,
  setMonth: (m: unknown) => void months.push(m),
  setTimeZone: (z: unknown) => void zones.push(z),
});

/** A dashboard with the popup of one session open, the way the page leaves it. */
async function openPopup(title: { value: string }): Promise<void> {
  dispose();
  panel.visible = true;
  posted.length = 0;
  UsagePanel.show(summary(), cfg, provider(async () => `<p>${title.value}</p>`));
  await onMessage({ type: 'ready' });
  await onMessage({ type: 'openSession', key: 'claude:s1' });
  await settle();
  assert.deepEqual(kinds().slice(-1), ['detail:<p>old title</p>']);
}

test('the dashboard tab gets the icon it is given', () => {
  dispose();
  const icon = { fsPath: '/ext/media/gemini.svg' };
  UsagePanel.show(summary(), cfg, provider(), icon as never);
  assert.equal((panel as { iconPath?: unknown }).iconPath, icon);
});

test('a month picked in the page is handed to the extension as sent, and the panel reports whether it is open', async () => {
  dispose();
  assert.equal(UsagePanel.isOpen, false);
  months.length = 0;
  UsagePanel.show(summary(), cfg, provider());
  assert.equal(UsagePanel.isOpen, true);
  await onMessage({ type: 'setMonth', month: '2026-09' });
  await onMessage({ type: 'setMonth', month: 'current' });
  await onMessage({ type: 'setMonth', month: { $ne: 1 } });
  assert.deepEqual(months, ['2026-09', 'current', { $ne: 1 }]);
  dispose();
  assert.equal(UsagePanel.isOpen, false);
});

test('an open popup follows its log even when the overview did not change', async () => {
  const title = { value: 'old title' };
  await openPopup(title);
  title.value = 'new title';
  UsagePanel.update(summary(), cfg);
  await settle();
  assert.deepEqual(kinds(), ['detail:<p>new title</p>']);
});

test('nothing is sent when neither the overview nor the popup changed', async () => {
  const title = { value: 'old title' };
  await openPopup(title);
  UsagePanel.update(summary(), cfg);
  await settle();
  assert.deepEqual(kinds(), []);
});

test('a hidden dashboard is not updated and does not read the log, and catches up when it is shown again', async () => {
  const title = { value: 'old title' };
  let reads = 0;
  dispose();
  panel.visible = true;
  posted.length = 0;
  UsagePanel.show(summary(), cfg, provider(async () => (reads++, `<p>${title.value}</p>`)));
  await onMessage({ type: 'ready' });
  await onMessage({ type: 'openSession', key: 'claude:s1' });
  await settle();
  kinds();
  assert.equal(reads, 1);

  panel.visible = false;
  title.value = 'new title';
  UsagePanel.update(summary(), { ...cfg, dashboardTheme: 'dark' });
  await onMessage({ type: 'openSession', key: 'claude:s2' });
  await settle();
  assert.equal(reads, 1, 'the log is not read for a page nobody can see, whether the poll or the page asks');
  assert.deepEqual(kinds(), []);

  panel.visible = true;
  viewStateChanged();
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(kinds(), ['render', 'detail:<p>new title</p>'], 'showing the dashboard again sends what it missed');
});

test('a time zone picked in the page is handed to the extension as sent', async () => {
  dispose();
  zones.length = 0;
  UsagePanel.show(summary(), cfg, provider());
  await onMessage({ type: 'setTimeZone', zone: 'SGT' });
  await onMessage({ type: 'setTimeZone', zone: { $ne: 1 } });
  assert.deepEqual(zones, ['SGT', { $ne: 1 }]);
});

test('a message the page has no business sending changes nothing, whatever its shape', async () => {
  dispose();
  const asked: string[] = [];
  UsagePanel.show(summary(), cfg, { ...provider(async () => (asked.push('detail'), '')), openLog: async () => void asked.push('openLog') });
  posted.length = 0;
  months.length = 0;
  zones.length = 0;
  const hostile = [null, undefined, 'x', 5, [], {}, { type: 5 }, { type: 'toString' }, { type: '__proto__' }, { type: 'constructor', key: 'x' }, { type: 'previewDelete', keys: ['antigravity:s1'] },
    { type: 'confirmDelete', token: 't', mode: 'permanent' }, { type: 'openSession', key: 5 }, { type: 'openSession', key: { toString: () => 'claude:s1' } }, { type: 'openLog', key: ['claude:s1'] }, { type: 'openLog' }];
  for (const message of hostile) await onMessage(message);
  await settle();
  assert.deepEqual(asked, []);
  assert.deepEqual([months, zones, posted], [[], [], []]);
});

test('the dashboard is created with scripts on, its state kept while hidden, no local resources and no command URIs', () => {
  dispose();
  created.length = 0;
  UsagePanel.show(summary(), cfg, provider());
  assert.equal(created.length, 1);
  const [viewType, title, column, options] = created[0];
  assert.equal(viewType, 'agyTokenTracker');
  assert.equal(title, 'agent-usage-dock');
  assert.equal(column, 1);
  assert.deepEqual(options, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(options, 'enableCommandUris'), false);
  UsagePanel.show(summary(), cfg, provider());
  assert.equal(created.length, 1, 'a second request reveals the open dashboard instead of making another');
});

test('the page gets the theme the settings name, and nothing else ends up in its class list', async () => {
  dispose();
  UsagePanel.show(summary(), cfg, provider());
  await onMessage({ type: 'ready' });
  const themeSent = (theme: unknown): string | undefined => {
    posted.length = 0;
    UsagePanel.update(summary(), { ...cfg, dashboardTheme: theme as never });
    return posted.find((m) => m.type === 'render')?.theme;
  };
  assert.equal(themeSent('dark'), 'dark');
  assert.equal(themeSent('auto'), 'auto');
  assert.equal(themeSent('light'), 'light');
  for (const hostile of ['x" onload="alert(1)', 'theme-dark bad', '"><script>', undefined, 5, {}]) {
    themeSent('dark');
    assert.equal(themeSent(hostile), 'light', String(typeof hostile));
  }
});

test('same-session details discard out-of-order requests and cannot return after close or disposal', async () => {
  dispose(); panel.visible = true; posted.length = 0;
  const pending: ((html: string) => void)[] = [];
  UsagePanel.show(summary(), cfg, provider(() => new Promise(resolve => pending.push(resolve))));
  void onMessage({ type: 'openSession', key: 'dsh:s1' });
  UsagePanel.update(summary(), { ...cfg, timeZone: 'UTC' });
  assert.equal(pending.length, 2);
  pending[1]('<p>new UTC</p>'); await settle();
  pending[0]('<p>old SGT</p>'); await settle();
  assert.deepEqual(kinds().filter(k => k.startsWith('detail:')), ['detail:<p>new UTC</p>']);
  void onMessage({ type: 'openSession', key: 'dsh:s1' });
  await onMessage({ type: 'closeSession' });
  pending[2]('<p>closed</p>'); await settle();
  assert.deepEqual(kinds(), []);
  void onMessage({ type: 'openSession', key: 'dsh:s1' });
  dispose(); pending[3]('<p>disposed</p>'); await settle();
  assert.deepEqual(kinds(), []);
});

test('repeated polling lets a slow first detail render and coalesces the follow-up', async () => {
  dispose(); panel.visible = true; posted.length = 0;
  const pending: ((html: string) => void)[] = [];
  const s = summary();
  UsagePanel.show(s, cfg, provider(() => new Promise(resolve => pending.push(resolve))));
  void onMessage({ type: 'openSession', key: 'dsh:slow' });
  for (let i = 0; i < 5; i++) UsagePanel.update(s, cfg);
  assert.equal(pending.length, 1);
  pending[0]('<p>first result</p>');
  await settle();
  assert.deepEqual(kinds().filter(kind => kind.startsWith('detail:')), ['detail:<p>first result</p>']);
  assert.equal(pending.length, 2);
  pending[1]('<p>updated result</p>');
  await settle();
  assert.deepEqual(kinds().filter(kind => kind.startsWith('detail:')), ['detail:<p>updated result</p>']);
  dispose();
});
