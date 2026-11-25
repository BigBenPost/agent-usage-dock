import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { installVscode } from './vscodeStub';

class ThemeColor { constructor(readonly id: string) {} }
class MarkdownString { supportThemeIcons = false; supportHtml = false; isTrusted: unknown; constructor(readonly value: string) {} }
interface FakeItem {
  text: string; tooltip?: unknown; color?: ThemeColor; backgroundColor?: ThemeColor; command?: string; name?: string; accessibilityInformation?: { label: string; role: string };
  visible: boolean; priority: number; show: () => void; hide: () => void; dispose: () => void;
}
const created: FakeItem[] = [];
installVscode({
  window: {
    createStatusBarItem: (_alignment: number, priority: number): FakeItem => {
      const fake: FakeItem = { text: '', visible: false, priority, show: () => void (fake.visible = true), hide: () => void (fake.visible = false), dispose: () => undefined };
      created.push(fake);
      return fake;
    },
    activeColorTheme: { kind: 1 },
  },
  StatusBarAlignment: { Right: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  ThemeColor,
  MarkdownString,
});
const { UsageStatusBar } = require('../src/statusBar') as typeof import('../src/statusBar');

const base = summarize({ days: {}, sessions: {} }, new Pricing());
const cfg: Config = normalizeConfig({ tokenBudgetLimit: 100 });
const ringCfg: Config = { ...cfg, levelIndicator: 'ring' };
const spent = (totalMillions: number) => ({ ...base, tokensTotal: totalMillions * 1e6, todayTokens: 0 });

const BAR = { green: '$(agy-bar-ok)', amber: '$(agy-bar-warning)', red: '$(agy-bar-critical)' };
const RING = { green: '$(agy-ring-ok)', amber: '$(agy-ring-warning)', red: '$(agy-ring-critical)' };

function make(): { bar: InstanceType<typeof UsageStatusBar>; item: FakeItem; before: number } {
  const before = created.length;
  const bar = new UsageStatusBar();
  return { bar, item: created[created.length - 1], before };
}

test('the status bar is one item, between the editor\'s own items and Cursor Usage Monitor\'s pair, and its text is never coloured', () => {
  const { bar, item, before } = make();
  assert.equal(created.length - before, 1, 'the level is a glyph in the text, not an item of its own');
  assert.equal(item.priority, 99.6);
  assert.equal(item.visible, true);
  for (const total of [10, 80, 95, 150]) {
    bar.update(spent(total), cfg);
    bar.update(spent(total), ringCfg);
    assert.equal(item.color, undefined);
  }
});

test('only a critical level takes the editor\'s error background, and it gives it back when the level drops', () => {
  const { bar, item } = make();
  const background = () => (item.backgroundColor as ThemeColor | undefined)?.id;
  for (const c of [cfg, ringCfg]) {
    for (const [total, expected] of [[10, undefined], [74, undefined], [80, undefined], [89, undefined], [90, 'statusBarItem.errorBackground'], [95, 'statusBarItem.errorBackground'], [150, 'statusBarItem.errorBackground'], [10, undefined]] as const) {
      bar.update(spent(total), c);
      assert.equal(background(), expected, `${total}M of 100M`);
    }
  }
  bar.update(spent(150), { ...cfg, tokenBudgetLimit: 0, warningThreshold: 0, criticalThreshold: 0 });
  assert.equal(background(), undefined, 'without a budget there is no level to be critical about');
  const money = normalizeConfig({ budgetMode: 'cost', budgetLimit: 10 });
  bar.update({ ...base, total: 9.5 }, money);
  assert.equal(background(), 'statusBarItem.errorBackground');
  bar.update({ ...base, total: 5 }, money);
  assert.equal(background(), undefined);
});

test('the hover is rebuilt only when what it says changed', () => {
  const { bar, item } = make();
  bar.update(spent(10), cfg);
  const first = item.tooltip;
  assert.ok(first instanceof MarkdownString);
  bar.update(spent(10), cfg);
  assert.equal(item.tooltip, first);
  bar.update(spent(11), cfg);
  assert.notEqual(item.tooltip, first);
  const second = item.tooltip;
  bar.showError('boom');
  bar.update(spent(11), cfg);
  assert.notEqual(item.tooltip, second);
  assert.ok(item.tooltip instanceof MarkdownString);
});

test('by default the level is a bar in front of the Gemini mark: green until the warning threshold, then amber, then red', () => {
  const { bar, item } = make();
  const text = (total: number, over: Partial<Config> = {}) => (bar.update(spent(total), { ...cfg, ...over }), item.text);
  assert.equal(text(10), `${BAR.green}$(agy-gemini) 0 | 10M · 10%`);
  assert.equal(text(74), `${BAR.green}$(agy-gemini) 0 | 74M · 74%`);
  assert.equal(text(80), `${BAR.amber}$(agy-gemini) 0 | 80M · 80%`);
  assert.equal(text(95), `${BAR.red}$(agy-gemini) 0 | 95M · 95%`);
  assert.equal(text(150), `${BAR.red}$(agy-gemini) 0 | 150M · 150%`);
  assert.doesNotMatch(text(95), /ring/);
});

test('with the ring, the mark leads and a ring with a dot follows the text with nothing between', () => {
  const { bar, item } = make();
  const text = (total: number, over: Partial<Config> = {}) => (bar.update(spent(total), { ...ringCfg, ...over }), item.text);
  assert.equal(text(10), `$(agy-gemini) 0 | 10M · 10%${RING.green}`);
  assert.equal(text(80), `$(agy-gemini) 0 | 80M · 80%${RING.amber}`);
  assert.equal(text(95), `$(agy-gemini) 0 | 95M · 95%${RING.red}`);
  assert.doesNotMatch(text(95), /bar/);
});

test('the gauge and ring styles keep the level glyph where it belongs, and there is none without a budget', () => {
  const { bar, item } = make();
  bar.update(spent(80), { ...cfg, statusBarStyle: 'ring' });
  assert.match(item.text, /^\$\(agy-bar-warning\)\$\(agy-gemini\) ◕ 0 \| 80M$/);
  bar.update(spent(80), { ...ringCfg, statusBarStyle: 'gauge' });
  assert.match(item.text, /^\$\(agy-gemini\) ▆ 0 \| 80M\$\(agy-ring-warning\)$/);
  for (const c of [cfg, ringCfg]) {
    bar.update(spent(10), { ...c, tokenBudgetLimit: 0, warningThreshold: 0, criticalThreshold: 0 });
    assert.match(item.text, /^\$\(agy-gemini\) 0 \| 10M$/, 'without a budget the mark is the only icon');
    assert.doesNotMatch(item.text, /bar|ring|pulse/);
  }
});

test('switching between the bar and the ring changes the text of the same item', () => {
  const { bar, item } = make();
  bar.update(spent(95), cfg);
  assert.ok(item.text.startsWith(BAR.red));
  bar.update(spent(95), ringCfg);
  assert.ok(item.text.endsWith(RING.red) && !item.text.includes('bar'));
  bar.update(spent(95), cfg);
  assert.ok(item.text.startsWith(BAR.red) && !item.text.includes('ring'));
});

test('clicking opens the dashboard, and the label for screen readers names the level whichever glyph is shown', () => {
  const { bar, item } = make();
  for (const c of [cfg, ringCfg]) {
    bar.update(spent(80), c);
    assert.equal(item.command, 'agyTokenTracker.openPanel');
    assert.match(item.accessibilityInformation?.label ?? '', /80% of 100M, budget is filling up$/);
    bar.update(spent(95), c);
    assert.match(item.accessibilityInformation?.label ?? '', /95% of 100M, close to the budget$/);
  }
});

test('initial status bar item shows gemini mark and pending tokens', () => {
  const { item } = make();
  assert.equal(item.text, '$(agy-gemini) …tok');
  assert.equal(item.name, 'agent-usage-dock');
});

test('an error shows a red bar in bar mode and only the error icon in ring mode, and the item stays clickable', () => {
  const { bar, item } = make();
  bar.update(spent(10), cfg);
  bar.showError('boom');
  assert.equal(item.text, `${BAR.red}$(agy-gemini) ?tok $(error)`);
  assert.equal(item.command, 'agyTokenTracker.openPanel');
  assert.equal((item.backgroundColor as ThemeColor).id, 'statusBarItem.errorBackground');
  bar.update(spent(10), ringCfg);
  bar.showError('boom');
  assert.equal(item.text, '$(agy-gemini) ?tok $(error)');
  assert.equal(item.command, 'agyTokenTracker.openPanel');
});

test('an error says so to screen readers instead of keeping the last good reading, and the next update takes it back', () => {
  const { bar, item } = make();
  bar.update(spent(10), cfg);
  assert.match(item.accessibilityInformation!.label, /10M this month/);
  bar.showError('could not read the store');
  assert.equal(item.accessibilityInformation!.role, 'button');
  assert.match(item.accessibilityInformation!.label, /error/);
  assert.match(item.accessibilityInformation!.label, /could not read the store/);
  assert.doesNotMatch(item.accessibilityInformation!.label, /this month|today/);
  assert.match(String(item.tooltip), /could not read the store/);
  bar.update(spent(10), cfg);
  assert.match(item.accessibilityInformation!.label, /10M this month/);
  assert.equal(item.backgroundColor, undefined);
});

test('the unknown amount in an error follows the budget mode: tokens never print a dollar sign', () => {
  const { bar, item } = make();
  bar.showError('before the first reading');
  assert.doesNotMatch(item.text, /\$\?/);
  for (const [config, expected] of [[cfg, /\?tok/], [ringCfg, /\?tok/], [normalizeConfig({ budgetMode: 'cost', budgetLimit: 10 }), /~\$\?/]] as const) {
    bar.update(spent(10), config);
    bar.showError('boom');
    assert.match(item.text, expected);
    if (config.budgetMode !== 'cost') assert.doesNotMatch(item.text, /~\$\?/);
  }
});

test('the hover is trusted for exactly its own two commands, draws icons and HTML, and links to nothing else', () => {
  const { bar, item } = make();
  for (const tooltipChart of [true, false]) {
    bar.update(spent(10 + Number(tooltipChart)), { ...cfg, tooltipChart });
    const md = item.tooltip as MarkdownString;
    assert.ok(md instanceof MarkdownString);
    assert.deepEqual(md.isTrusted, { enabledCommands: ['agyTokenTracker.openPanel', 'agyTokenTracker.refresh'] });
    assert.equal(md.supportHtml, true);
    assert.equal(md.supportThemeIcons, true);
    const targets = [...md.value.matchAll(/\]\(command:([^)]+)\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(targets, ['agyTokenTracker.openPanel', 'agyTokenTracker.refresh']);
    const tags = [...md.value.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0 && tags.every((tag) => tag === 'span'), 'HTML in the hover is the coloured spans and nothing else');
    for (const [, style] of md.value.matchAll(/<span style="([^"]*)"/g)) assert.match(style, /^color:#[0-9a-f]{6};$/i);
  }
});
