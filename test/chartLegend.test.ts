import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { STYLE } from '../src/panelStyle';
import { HOVER_STYLE } from '../src/dashboardHover';
import { Pricing } from '../src/pricing';
import { modelKey, summarize } from '../src/summary';
import { DayRecord, emptyBucket, TokenBucket } from '../src/types';
import { backgroundOf, colour, deltaE, parseCss, themeVariables, type Theme } from './cssColors';
import { costDrawing } from './costChart';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({ budgetLimit: 310 });
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const rules = parseCss(STYLE + HOVER_STYLE);
const THEMES: Theme[] = ['light', 'dark'];

/** Every model is priced at $1 per million output tokens, so `cost` in the fixtures is dollars. */
function month(costs: Record<string, number>, over: { source?: 'antigravity' | 'claude' | 'codex'; day?: string } = {}) {
  const source = over.source ?? 'antigravity';
  const rates = Object.fromEntries(Object.keys(costs).map((model) => [model, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }]));
  const days: Record<string, DayRecord> = {
    [over.day ?? '2026-10-21']: { [source]: Object.fromEntries(Object.entries(costs).map(([model, cost]) => [model, bucket(cost * 1e6)])) },
  };
  return summarize({ days, sessions: {} }, new Pricing(rates), NOW);
}

const dom = (html: string) => costDrawing(parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document);
const legendOf = (costs: Record<string, number>) => {
  const document = dom(renderBody(month(costs), cfg));
  const items = [...document.querySelectorAll('.by-model .legend-item')];
  return {
    named: items.filter((item) => !item.classList.contains('more')).map((item) => ({
      name: item.querySelector('.name')!.textContent!,
      swatch: item.querySelector('.swatch')!.getAttribute('class')!,
      title: item.getAttribute('title')!,
    })),
    more: items.find((item) => item.classList.contains('more')),
  };
};

test('the summary keeps each day\'s cost per model, keyed by tool and model, and leaves out a model that has no rate', () => {
  const pricing = new Pricing();
  const cost = (model: string, output: number): number => pricing.quote({ source: 'antigravity', model, tokens: bucket(output) }).cost ?? NaN;
  const days: Record<string, DayRecord> = {
    '2026-10-19': { antigravity: { 'mystery-model': bucket(1e6) } },
    '2026-10-20': { antigravity: { 'gemini-1.5-flash': bucket(2e6), 'gemini-1.5-pro': bucket(1e6) } },
  };
  const s = summarize({ days, sessions: {} }, pricing, NOW);
  const d20 = s.days.find((d) => d.day === '2026-10-20')!;
  assert.deepEqual(Object.keys(d20.byModel).sort(), [modelKey('antigravity', 'gemini-1.5-flash'), modelKey('antigravity', 'gemini-1.5-pro')].sort());
  assert.ok(Math.abs(d20.byModel[modelKey('antigravity', 'gemini-1.5-flash')] - cost('gemini-1.5-flash', 2e6)) < 1e-9);
  assert.ok(Math.abs(Object.values(d20.byModel).reduce((a, b) => a + b, 0) - d20.total) < 1e-9, 'the models add up to the day');
  assert.deepEqual(s.days.find((d) => d.day === '2026-10-19')!.byModel, {}, 'unpriced usage is not in the bars, as it is not in the total');
});

test('the legend lists models by cost and cuts after sorting, so the biggest spender is never behind "+N more"', () => {
  const costs: Record<string, number> = { 'zz-big-spender': 500 };
  for (let i = 0; i < 6; i++) costs[`gemini-cheap-${i}`] = 10 + i;
  for (let i = 0; i < 4; i++) costs[`claude-cheap-${i}`] = 20 + i;
  costs['gpt-cheap'] = 30;
  const { named, more } = legendOf(costs);
  assert.equal(named.length, 8);
  assert.equal(named[0].name, 'zz-big-spender', 'a model of the last family still leads when it costs the most');
  assert.deepEqual(named.map((n) => n.name), Object.entries(costs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name));
  assert.match(more!.textContent!, /^\+4 more$/);
  const hidden = Object.entries(costs).sort((a, b) => b[1] - a[1]).slice(8).map(([name]) => name);
  assert.equal(more!.getAttribute('title'), hidden.join(', '));
});

test('a model that costs nothing is not in the legend, and a month of one model has no "more" entry', () => {
  const { named, more } = legendOf({ 'gemini-a': 3, 'gemini-b': 0 });
  assert.deepEqual(named.map((n) => n.name), ['gemini-a']);
  assert.equal(more, undefined);
});

function classesOf(html: string, selector: string): string[][] {
  return [...dom(html).querySelectorAll(selector)].map((el) => [...el.classList]);
}

test('every swatch, bar segment, hover key and dot in the dashboard has a colour of its own, in both themes', () => {
  const costs: Record<string, number> = {};
  for (const [family, prefix] of [['gemini', 'gemini-m'], ['opus', 'claude-m'], ['gpt', 'gpt-m'], ['deepseek', 'deepseek-m'], ['unknown', 'mystery-m']]) {
    for (let i = 0; i < 4; i++) costs[`${prefix}${i}-${family}`] = 5 + i;
  }
  const html = renderBody(month(costs), cfg);
  const seen = new Set<string>();
  for (const selector of ['.by-model .legend-item .swatch', '.by-tool .legend-item .swatch', '.cols .seg', '.cols .tip .key', '.mcard .dot']) {
    const found = classesOf(html, selector);
    assert.ok(found.length > 0, `${selector} is in the page`);
    for (const classes of found) {
      seen.add(classes.join(' '));
      for (const theme of THEMES) assert.ok(backgroundOf(rules, theme, classes), `no ${theme} background for <${classes.join(' ')}>`);
    }
  }
  for (const family of ['gemini', 'opus', 'gpt', 'deepseek', 'unknown']) assert.ok([...seen].some((classes) => classes.split(' ').includes(family)), `${family} appears in the fixture`);
});

test('three models of one family get three clearly different colours, whatever the family, in both themes', () => {
  for (const [family, names] of [['deepseek', ['deepseek-x1', 'deepseek-x2', 'deepseek-x3']], ['unknown', ['mystery-a', 'mystery-b', 'mystery-c']], ['gemini', ['gemini-a', 'gemini-b', 'gemini-c']], ['opus', ['claude-a', 'claude-b', 'claude-c']], ['gpt', ['gpt-a', 'gpt-b', 'gpt-c']]] as const) {
    const { named } = legendOf(Object.fromEntries(names.map((name, i) => [name, 10 + i])));
    assert.equal(named.length, 3, family);
    for (const theme of THEMES) {
      const colours = named.map((n) => backgroundOf(rules, theme, n.swatch.split(' '))!);
      for (let i = 0; i < colours.length; i++) {
        for (let j = i + 1; j < colours.length; j++) {
          const wanted = family === 'deepseek' ? 20 : 12;
          assert.ok(deltaE(colours[i], colours[j]) >= wanted, `${family}/${theme}: ${colours[i]} and ${colours[j]} look alike`);
        }
      }
    }
  }
});

test('four models of one family still get four different shades', () => {
  const { named } = legendOf({ 'deepseek-a': 4, 'deepseek-b': 3, 'deepseek-c': 2, 'deepseek-d': 1 });
  assert.equal(new Set(named.map((n) => n.swatch)).size, 4);
});

const shadeOf = (swatch: string): string => swatch.match(/\bs\d\b/)?.[0] ?? 's0';
const shadesOf = (costs: Record<string, number>): Record<string, string> => Object.fromEntries(legendOf(costs).named.map((n) => [n.name, shadeOf(n.swatch)]));

test('the costliest model of a family wears the family\'s own colour, whatever its name, and a lone model always does', () => {
  for (const name of ['claude-sonnet-5-5', 'claude-opus-4-6', 'claude-haiku-5-5', 'gpt-6.2-sol', 'gpt-5.5', 'gemini-3.8-flash', 'deepseek-v4-pro', 'mystery-x', 'claude-a', 'claude-b']) {
    assert.equal(shadesOf({ [name]: 5 })[name], 's0', `${name} alone`);
  }
  for (const [big, small] of [['claude-sonnet-5-5', 'claude-haiku-5-5'], ['claude-opus-4-6', 'claude-sonnet-4-6'], ['gpt-5.4', 'gpt-5.5'], ['claude-b', 'claude-a']]) {
    const shades = shadesOf({ [big]: 9, [small]: 1 });
    assert.equal(shades[big], 's0', `${big} is the costlier one`);
    assert.equal(shades[small], 's2', `${small} takes the dark shade`);
  }
});

test('the models after the costliest take their shades in the order of their names, so a ranking change among them moves no colour', () => {
  const costs = { 'claude-opus-4-6': 90, 'claude-sonnet-4-6': 5, 'claude-haiku-5-5': 4, 'claude-3-haiku': 3 };
  const first = shadesOf(costs);
  assert.deepEqual(first, { 'claude-opus-4-6': 's0', 'claude-3-haiku': 's2', 'claude-haiku-5-5': 's1', 'claude-sonnet-4-6': 's3' });
  assert.deepEqual(shadesOf({ ...costs, 'claude-sonnet-4-6': 4, 'claude-haiku-5-5': 5 }), first, 'two of the others swap their costs');
  assert.equal(new Set(Object.values(first)).size, 4);
});

test('models of other families do not move a model\'s shade', () => {
  const alone = shadesOf({ 'claude-opus-4-6': 5 })['claude-opus-4-6'];
  const crowded = shadesOf({ 'claude-opus-4-6': 100, 'gemini-x': 90, 'gpt-x': 80, 'mystery-x': 70, 'deepseek-x': 60 });
  assert.equal(crowded['claude-opus-4-6'], alone);
  assert.deepEqual(Object.values(crowded), ['s0', 's0', 's0', 's0', 's0']);
});

test('the colours that tell tools and model families apart stay apart: no two are closer than 15 in either theme', () => {
  for (const theme of THEMES) {
    const variables = themeVariables(rules, theme);
    const palette = Object.fromEntries(['--gemini', '--opus', '--gpt', '--deepseek', '--unknown'].map((name) => [name, colour(variables[name], variables)!]));
    assert.ok(Object.values(palette).every(Boolean));
    const names = Object.keys(palette);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) assert.ok(deltaE(palette[names[i]], palette[names[j]]) > 15, `${theme}: ${names[i]} ${palette[names[i]]} and ${names[j]} ${palette[names[j]]} look alike`);
    }
    const tools = Object.fromEntries(['--antigravity', '--dsh', '--claude', '--codex'].map((name) => [name, colour(`var(${name})`, variables)!]));
    const toolNames = Object.keys(tools);
    for (let i = 0; i < toolNames.length; i++) {
      for (let j = i + 1; j < toolNames.length; j++) assert.ok(deltaE(tools[toolNames[i]], tools[toolNames[j]]) > 15, `${theme}: ${toolNames[i]} and ${toolNames[j]} look alike`);
    }
    for (const [tool, family] of [['--antigravity', '--gemini'], ['--dsh', '--deepseek'], ['--claude', '--opus'], ['--codex', '--gpt']]) assert.equal(tools[tool], palette[family], `${theme}: ${tool} wears the colour of ${family}`);
    assert.ok(deltaE(colour('var(--gpt)', variables)!, colour('var(--unknown)', variables)!) > 15, `${theme}: GPT and Other`);
  }
});

function day(hover: ReturnType<ReturnType<typeof dom>['querySelector']>): { rows: { label: string; amount: number }[]; total: number } {
  const rows = [...hover!.querySelectorAll('.by-model .tip-r')].map((row) => ({ label: row.querySelector('span')!.textContent!, amount: Number(row.querySelector('b')!.textContent!.slice(1)) }));
  return { rows, total: Number(hover!.querySelector('.tip-r.total b')!.textContent!.slice(1)) };
}

test('a day\'s hover names its six biggest models, sums the rest in one row, and still adds up to the day', () => {
  const costs = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`model-${String.fromCharCode(97 + i)}`, 13 - i]));
  const document = dom(renderBody(month(costs), cfg));
  const { rows, total } = day(document.querySelector('.col[data-focus="day-2026-10-21"] .tip'));
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.slice(0, 6).map((r) => r.label), ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f']);
  assert.equal(rows[6].label, '7 other models');
  assert.equal(rows[6].amount, 7 + 6 + 5 + 4 + 3 + 2 + 1);
  assert.ok(Math.abs(rows.reduce((sum, r) => sum + r.amount, 0) - total) < 0.011);
  const small = dom(renderBody(month({ 'model-a': 5, 'model-b': 4 }), cfg));
  assert.deepEqual(day(small.querySelector('.col[data-focus="day-2026-10-21"] .tip')).rows.map((r) => r.label), ['model-a', 'model-b']);
});

test('a day\'s hover is ordered by what that day cost, not by family and not by what the month cost', () => {
  const document = dom(renderBody(month({ 'gemini-small': 1, 'claude-big': 9, 'gpt-mid': 4, 'mystery-top': 20 }), cfg));
  assert.deepEqual(day(document.querySelector('.col[data-focus="day-2026-10-21"] .tip')).rows.map((r) => r.label), ['mystery-top', 'claude-big', 'gpt-mid', 'gemini-small']);
  const rates = Object.fromEntries(['m-early', 'm-late'].map((model) => [model, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }]));
  const days: Record<string, DayRecord> = {
    '2026-10-20': { antigravity: { 'm-early': bucket(9e6), 'm-late': bucket(1e6) } },
    '2026-10-21': { antigravity: { 'm-late': bucket(30e6), 'm-early': bucket(1e6) } },
  };
  const apart = dom(renderBody(summarize({ days, sessions: {} }, new Pricing(rates), NOW), cfg));
  assert.deepEqual(day(apart.querySelector('.col[data-focus="day-2026-10-20"] .tip')).rows.map((r) => r.label), ['m-early', 'm-late'], 'the month\'s biggest model is not first on a day it was small');
  assert.deepEqual(day(apart.querySelector('.col[data-focus="day-2026-10-21"] .tip')).rows.map((r) => r.label), ['m-late', 'm-early']);
});

test('the hover scrolls inside a bounded height instead of running off the page', () => {
  const tip = rules.find((rule) => rule.selectors.includes('.tip') && 'max-height' in rule.declarations)!;
  assert.match(tip.declarations['max-height'], /^min\(\d+px, \d+vh\)$/);
  assert.equal(tip.declarations['overflow-y'], 'auto');
});

test('the By model cards stop at twelve, the rest sit in a fold, and a huge list is cut with a pointer to the CSV', () => {
  const names = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`model-${String(i).padStart(3, '0')}`, 1000 - i]));
  const small = dom(renderBody(month(names(12)), cfg));
  assert.equal(small.querySelectorAll('[data-key="by-model"] > .mgrid > .mcard').length, 12);
  assert.equal(small.querySelector('[data-key="more-models"]'), null);

  const many = dom(renderBody(month(names(30)), cfg));
  assert.equal(many.querySelectorAll('[data-key="by-model"] > .mgrid > .mcard').length, 12);
  const fold = many.querySelector('[data-key="more-models"]')!;
  assert.equal(fold.querySelector('summary')!.textContent, '18 more models');
  assert.equal(fold.querySelectorAll('.mcard').length, 18);
  assert.equal(many.querySelector('[data-key="by-model"] .note'), null);

  const huge = dom(renderBody(month(names(75)), cfg));
  assert.equal(huge.querySelectorAll('[data-key="by-model"] .mcard').length, 60);
  assert.match(huge.querySelector('[data-key="by-model"] .note')!.textContent!, /^15 further models not listed here\. The CSV export has every model\.$/);
});
