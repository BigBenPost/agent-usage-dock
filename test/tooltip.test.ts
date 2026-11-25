import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { Pricing } from '../src/pricing';
import { gaugeGlyph, statusBarLabel, statusBarText } from '../src/statusText';
import { FAMILY_LABELS, summarize } from '../src/summary';
import { chartSvg, TOOLTIP_COMMANDS, tooltipMarkdown } from '../src/tooltip';
import { DayRecord, emptyBucket, SessionRecord, TokenBucket } from '../src/types';
import { deltaE } from './cssColors';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg: Config = { dashboardTheme: 'light', timeZone: 'UTC', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', budgetLimit: 0, tokenBudgetLimit: 5, warningThreshold: 0.75, criticalThreshold: 0.9, pollIntervalSeconds: 60, correctionFactor: 1, rates: {} };
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, input: 10_000, cacheRead: 50_000, output });

const session: SessionRecord = { source: 'antigravity', id: 's1', project: 'p', first: NOW, last: NOW, days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e6) } } };
const data = {
  days: {
    '2026-10-20': { antigravity: { 'gemini-1.5-flash': bucket(5e5) } },
    '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } },
  },
  sessions: { 'antigravity:s1': session },
  firstDay: '2026-10-12',
};

const sum = (d: Parameters<typeof summarize>[0] = data) => summarize(d, new Pricing(), NOW);
const md = (over: Partial<Config> = {}, opts = { dark: false, chart: false }, d: Parameters<typeof summarize>[0] = data): string => tooltipMarkdown(sum(d), { ...cfg, ...over }, opts);

test('the status bar shows today, the month and the real percentage of the budget used', () => {
  // 1.62M total of 5M token budget, today 1.06M
  assert.equal(statusBarText(sum(), cfg), '1.1M | 1.6M · 32%');
  assert.equal(statusBarText(sum(), { ...cfg, tokenBudgetLimit: 0 }), '1.1M | 1.6M');
  assert.equal(statusBarLabel(sum(), { ...cfg, tokenBudgetLimit: 0 }), 'agent-usage-dock: 1.1M today, 1.6M this month');
});

test('the gauge and ring styles put a glyph in front of the amounts', () => {
  assert.equal(statusBarText(sum(), { ...cfg, statusBarStyle: 'gauge' }), '▃ 1.1M | 1.6M');
  assert.equal(statusBarText(sum(), { ...cfg, statusBarStyle: 'ring' }), '◔ 1.1M | 1.6M');
  assert.deepEqual([0, 0.03, 0.2, 0.61, 0.95, 1, 3, -1].map(gaugeGlyph), ['▁', '▁', '▂', '▅', '█', '█', '█', '▁']);
});

test('the hover links to the commands the status bar trusts, and every one of them is a command the extension contributes', () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
  const contributed = manifest.contributes.commands.map((c: { command: string }) => c.command);
  for (const chart of [true, false]) {
    const linked = [...md({}, { dark: false, chart }).matchAll(/\]\(command:([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(linked.length >= 2);
    assert.deepEqual([...new Set(linked)].sort(), [...TOOLTIP_COMMANDS].sort(), `chart ${chart}`);
  }
  for (const command of TOOLTIP_COMMANDS) assert.ok(contributed.includes(command), `${command} is in package.json`);
});

test('chartSvg renders an agent-usage-dock SVG card', () => {
  const svg = chartSvg(sum(), cfg, false);
  assert.match(svg, /AGENT-USAGE-DOCK/);
  assert.doesNotMatch(svg, /ANTIGRAVITY TOKEN USAGE/);
  assert.match(svg, /OCTOBER 2026/);
  assert.match(svg, /of 5M budget/);
  assert.match(svg, />day 21 of 31</);
  assert.match(svg, />10 days left</);
  assert.doesNotMatch(svg, /% used/);
  assert.match(svg, /Today <tspan[^>]*>1\.1M<\/tspan>/);
  assert.match(svg, /Gemini <tspan[^>]*>1\.6M<\/tspan>/);
});

test('chartSvg renders Gemini (purple) and Claude (orange) model families', () => {
  const mixedData = {
    days: {
      '2026-10-20': { antigravity: { 'gemini-1.5-flash': bucket(5e5) } },
      '2026-10-21': { antigravity: { 'claude-opus-4.6': bucket(1e6) } },
    },
    sessions: {},
  };
  const svg = chartSvg(summarize(mixedData, new Pricing(), NOW), cfg, false);
  assert.match(svg, /Gemini <tspan[^>]*>560k<\/tspan>/);
  assert.match(svg, /Claude <tspan[^>]*>1\.1M<\/tspan>/);
  assert.doesNotMatch(svg, /Opus/);
  // Gemini is purple (#8e44ad in light), Claude is orange (#d4683a in light)
  assert.match(svg, /fill="#8e44ad"/);
  assert.match(svg, /fill="#d4683a"/);
});

test('markdown tooltip renders token usage with command links', () => {
  const text = md();
  assert.match(text, /\*\*agent-usage-dock\*\*/);
  assert.match(text, /## ~1\.6M/);
  assert.match(text, /day 21 of 31/);
  assert.match(text, /\[\$\(link-external\) Dashboard\]\(command:agyTokenTracker\.openPanel\)/);
  assert.match(text, /\[\$\(refresh\) Refresh\]\(command:agyTokenTracker\.refresh\)/);
  assert.match(text, /since 2026-10-12/);
});

const everyFamily: Record<string, DayRecord> = {
  '2026-10-21': {
    antigravity: {
      'gemini-1.5-flash': { ...bucket(1e6) }, 'claude-opus-4-6': { ...bucket(1e6) }, 'gpt-4o': { ...bucket(1e6) }, 'deepseek-chat': { ...bucket(1e6) }, 'mystery-model': { ...bucket(1e6) },
    },
    cursor: { 'composer-2.5': { ...bucket(1e6) } },
  },
};

/** The legend of the SVG card as `label -> colour`. */
function legendColours(svg: string): Record<string, string> {
  return Object.fromEntries([...svg.matchAll(/<circle[^>]*fill="(#[0-9a-f]{6})"\/><text[^>]*>([^<]*?) <tspan/g)].map((m) => [m[2], m[1]]));
}

test('the hover legend names a family as the dashboard does, for all six, instead of calling every Claude model Opus', () => {
  for (const dark of [false, true]) {
    const labels = Object.keys(legendColours(chartSvg(summarize({ days: everyFamily, sessions: {} }, new Pricing(), NOW), cfg, dark)));
    assert.deepEqual(labels.sort(), Object.values(FAMILY_LABELS).sort(), dark ? 'dark' : 'light');
  }
  assert.equal(FAMILY_LABELS.opus, 'Claude');
});

test('in the hover card no two families are closer than 15 in colour, in either theme, GPT and Other included', () => {
  for (const dark of [false, true]) {
    const colours = legendColours(chartSvg(summarize({ days: everyFamily, sessions: {} }, new Pricing(), NOW), cfg, dark));
    const names = Object.keys(colours);
    assert.equal(names.length, 6);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) assert.ok(deltaE(colours[names[i]], colours[names[j]]) > 15, `${dark ? 'dark' : 'light'}: ${names[i]} ${colours[names[i]]} and ${names[j]} ${colours[names[j]]}`);
    }
  }
});

const costCfg = (over: Partial<Config> = {}): Config => normalizeConfig({ budgetMode: 'cost', budgetLimit: 20, tokenBudgetLimit: 5, ...over });
const paid = new Pricing({ 'paid-model': { input: 10, cacheRead: 10, cacheWrite: 10, output: 10 } });
const priced = (extra: Record<string, TokenBucket> = {}) => summarize({ days: { '2026-10-21': { antigravity: { 'paid-model': bucket(1e6), ...extra } } }, sessions: {} }, paid, NOW);

test('the text-only hover in cost mode shows dollars against the dollar budget, and not the token budget', () => {
  const s = priced();
  for (const chart of [false, true]) {
    const text = tooltipMarkdown(s, costCfg(), { dark: false, chart });
    assert.match(text, /Estimated cost: \*\*\$[\d.]+\*\* of \$20\.00 budget\. Current rates; not an invoice\./, `chart ${chart}`);
    assert.doesNotMatch(text, /Estimated cost: \*\*\d/);
  }
  const textOnly = tooltipMarkdown(s, costCfg(), { dark: false, chart: false });
  assert.doesNotMatch(textOnly, /of 5M/, 'the stale token budget stays out of a cost-mode hover');
  assert.match(textOnly, /## ~1\.1M(?! )/);
  assert.match(tooltipMarkdown(s, costCfg({ budgetLimit: 0 }), { dark: false, chart: false }), /Estimated cost: \*\*\$[\d.]+\*\*\. Current rates/);
  assert.match(tooltipMarkdown(s, normalizeConfig({ tokenBudgetLimit: 5 }), { dark: false, chart: false }), /## ~1\.1M <span style="color:#8c8981;">of 5M<\/span>/, 'token mode keeps its budget');
  assert.doesNotMatch(tooltipMarkdown(s, normalizeConfig({ tokenBudgetLimit: 5 }), { dark: false, chart: false }), /Estimated cost/);
});

test('an unpriced total in a cost-mode hover carries its dollar sign too', () => {
  const s = priced({ 'unknown-model': bucket(5) });
  assert.deepEqual(s.unpriced, ['unknown-model']);
  assert.match(tooltipMarkdown(s, costCfg(), { dark: false, chart: false }), /Estimated cost: \*\*\$10\.60 \+ \?\*\* of \$20\.00 budget/);
});

test('model names in the unpriced line cannot break out of their code span or become a link, and stay short', () => {
  const hostile = ['evil`[open](command:workbench.action.reloadWindow)<img src=x onerror=alert(1)>', 'a'.repeat(200), 'back`tick', 'new\nline', '\u202ereversed'];
  const days: Record<string, DayRecord> = { '2026-10-21': { antigravity: Object.fromEntries(hostile.map((name) => [name, bucket(1)])) } };
  const s = summarize({ days, sessions: {} }, new Pricing(), NOW);
  assert.equal(s.unpriced.length, hostile.length);
  const line = md({}, { dark: false, chart: false }, { days, sessions: {} }).split('\n\n').find((part) => part.startsWith('$(warning) Unpriced usage: '))!;
  const spans = [...line.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  assert.equal(spans.length, hostile.length);
  assert.equal(line.replace(/`[^`]*`/g, '').replace('$(warning) Unpriced usage: ', '').replace(/, /g, ''), '', 'nothing but code spans');
  for (const span of spans) assert.match(span, /^[\w.:/@+ -]{0,60}$/);
  assert.ok(spans.some((span) => span.length === 60));
});

test('the first day reaches the hover as plain text whatever it holds, and a value that is not a string cannot throw', () => {
  const values = ['<img src=x onerror=alert(1)>[x](command:workbench.action.reloadWindow)`', '2026-10-12<b>', 5, { toString: () => '<i>' }, { toString() { throw new Error('no'); } }, null, undefined, ['<u>']];
  values.forEach((firstDay, index) => {
    for (const chart of [false, true]) {
      const text = md({}, { dark: false, chart }, { ...data, firstDay: firstDay as string });
      const note = text.split('\n\n').find((part) => part.includes("Estimate from this machine's logs"))!;
      assert.doesNotMatch(note.replace(/<span style="color:#8c8981;">|<\/span>/g, ''), /[<>\[\]()`]/, `value ${index}`);
    }
  });
  assert.match(md({}, { dark: false, chart: false }, { ...data, firstDay: '2026-10-12' }), /logs since 2026-10-12<\/span>/);
});

test('usage dated after today is drawn in the hover chart instead of stretching its scale and vanishing', () => {
  const later: Record<string, DayRecord> = { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e5) } }, '2026-10-25': { antigravity: { 'gemini-1.5-flash': bucket(9e5) } } };
  const svg = chartSvg(summarize({ days: later, sessions: {} }, new Pricing(), NOW), cfg, false);
  const bars = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx="1\.2"/g)].map((m) => ({ x: Number(m[1]), height: Number(m[2]) }));
  assert.equal(bars.length, 2, 'both days are drawn');
  assert.ok(bars[1].x > bars[0].x);
  assert.ok(bars[1].height > 5 * bars[0].height, 'the later day is the tall one, so the scale it set is the scale on show');
});
