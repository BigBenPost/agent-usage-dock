import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { SCRIPT } from '../src/panelScript';
import { STYLE } from '../src/panelStyle';
import { Pricing } from '../src/pricing';
import { modelKey, summarize } from '../src/summary';
import { emptyBucket, type DayRecord, type TokenBucket } from '../src/types';
import { parseCss } from './cssColors';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const rate = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const pricing = new Pricing({ 'm-a': rate, 'm-c': rate });
const bucket = (over: Partial<TokenBucket>): TokenBucket => ({ ...emptyBucket(), requests: 1, ...over });

/** m-a and m-c cost $1 per million tokens; mystery-unpriced has no price, so only the token drawing has it. */
const DAYS: Record<string, DayRecord> = {
  '2026-10-19': { antigravity: { 'm-a': bucket({ input: 1e6 }), 'mystery-unpriced': bucket({ output: 2e6 }) }, claude: { 'm-c': bucket({ cacheRead: 3e6 }) } },
  '2026-10-21': { antigravity: { 'm-a': bucket({ output: 4e6 }) } },
};

function page(days: Record<string, DayRecord> = DAYS, config: Partial<Config> | Record<string, unknown> = {}, selected?: string) {
  const html = renderBody(summarize({ days, sessions: {} }, pricing, NOW, selected), normalizeConfig(config as Record<string, unknown>));
  return parseHTML(`<html><body>${html}</body></html>`).document;
}
const texts = (nodes: Iterable<{ textContent: string | null }>): string[] => [...nodes].map((node) => node.textContent!.trim());

test('the daily chart card follows the Cost and Tokens switch: it carries the same attribute as the ring, and has both drawings', () => {
  const document = page();
  const card = document.querySelector('.gchart')!;
  assert.equal(card.getAttribute('data-pie'), 'cost');
  assert.ok(card.hasAttribute('data-pie-card'));
  assert.deepEqual([...card.children].filter((c) => c.classList.contains('metric')).map((c) => c.className), ['metric metric-cost', 'metric metric-tokens']);
  assert.deepEqual(texts(card.querySelectorAll('h2 .metric')), ['Daily spend (UTC)', 'Daily tokens (UTC)']);
  assert.equal(card.querySelector('.metric-cost .cols')!.getAttribute('aria-label'), 'Daily spend, one column per day. The arrow keys move between days.');
  assert.equal(card.querySelector('.metric-tokens .cols')!.getAttribute('aria-label'), 'Daily tokens, one column per day. The arrow keys move between days.');
  assert.equal(card.querySelectorAll('[data-group-set]').length, 2, 'the By model and By tool buttons are shared');
  const rules = parseCss(STYLE);
  const hides = (selector: string) => rules.some((rule) => rule.selectors.includes(selector) && rule.declarations.display === 'none');
  assert.ok(hides('.gchart[data-pie="cost"] .metric-tokens') && hides('.gchart[data-pie="tokens"] .metric-cost'), 'one drawing shows at a time');
  assert.ok(rules.some((rule) => rule.selectors.includes('.gchart .metric') && rule.declarations.display === 'contents'), 'and neither is a box of its own in the card');
  assert.match(SCRIPT, /applyPie\(\); thinDayLabels\(\); return;/, 'the day labels are thinned to the drawing that shows once the unit changes');
});

test('each day keeps its tokens per model and per tool, for models with a price and for those without', () => {
  const s = summarize({ days: DAYS, sessions: {} }, pricing, NOW);
  const day = s.days.find((d) => d.day === '2026-10-19')!;
  assert.equal(day.tokensTotal, 6e6);
  assert.deepEqual(day.tokensByModel, { [modelKey('antigravity', 'm-a')]: 1e6, [modelKey('antigravity', 'mystery-unpriced')]: 2e6, [modelKey('claude', 'm-c')]: 3e6 });
  assert.deepEqual({ ...day.tokensBySource }, { antigravity: 3e6, dsh: 0, claude: 3e6, codex: 0, cursor: 0 });
  assert.deepEqual(day.byModel, { [modelKey('antigravity', 'm-a')]: 1, [modelKey('claude', 'm-c')]: 3 }, 'the cost keeps leaving out what has no price');
});

test('the token drawing has its own scale, bars, peak and axis, in tokens', () => {
  const tokens = page().querySelector('div.metric-tokens')!;
  assert.deepEqual(texts(tokens.querySelectorAll('.yaxis span')), ['0', '5M', '10M'], 'six million tokens on a ten million scale');
  const height = (day: string) => Number(tokens.querySelector(`.col[data-focus="day-2026-10-${day}-tokens"] .stack`)!.getAttribute('style')!.match(/height:([\d.]+)%/)![1]);
  assert.equal(height('19'), 60);
  assert.equal(height('21'), 40);
  assert.deepEqual(texts(tokens.querySelectorAll('.peak')), ['6M'], 'the peak is said in tokens, above the busiest day');
  const cost = page().querySelector('div.metric-cost')!;
  assert.deepEqual(texts(cost.querySelectorAll('.yaxis span')), ['$0', '$2.5', '$5'], 'the cost drawing is as it was');
  assert.equal(cost.querySelectorAll('.col').length, 21);
  assert.equal(tokens.querySelectorAll('.col').length, 21);
});

test('a day names its tokens, by model and by tool, in its hover and in its accessible name, and the hover does not add requests', () => {
  const document = page();
  const tokens = document.querySelector('.metric-tokens .col[data-focus="day-2026-10-19-tokens"]')!;
  assert.equal(tokens.getAttribute('aria-label'), '2026-10-19: 6.00M tokens. By model: m-c 3.00M, mystery-unpriced 2.00M, m-a 1.00M. By tool: Antigravity 3.00M, Claude Code 3.00M.');
  const rows = (selector: string) => [...tokens.querySelectorAll(selector)].map((row) => `${row.querySelector('span')!.textContent} ${row.querySelector('b')!.textContent}`);
  assert.deepEqual(rows('.by-model .tip-r'), ['m-c 3.00M', 'mystery-unpriced 2.00M', 'm-a 1.00M']);
  assert.deepEqual(rows('.by-tool .tip-r'), ['Antigravity 3.00M', 'Claude Code 3.00M']);
  assert.equal(tokens.querySelector('.tip-r.total b')!.textContent, '6.00M');
  assert.doesNotMatch(tokens.querySelector('.tip')!.textContent!, /request/i);
  assert.equal(tokens.querySelector('.tip')!.getAttribute('aria-hidden'), 'true');
  const cost = document.querySelector('.metric-cost .col[data-focus="day-2026-10-19"]')!;
  assert.equal(cost.getAttribute('aria-label'), '2026-10-19: $4.00. By model: m-c $3.00, m-a $1.00. By tool: Antigravity $1.00, Claude Code $3.00.');
});

test('a model without a price is in the token legend and the token bars, not in the cost ones', () => {
  const document = page();
  const legend = (unit: string) => texts(document.querySelectorAll(`.metric-${unit} .legend .by-model .legend-item`));
  assert.deepEqual(legend('cost'), ['m-a$5.00', 'm-c$3.00']);
  assert.deepEqual(legend('tokens'), ['m-a5.00M', 'm-c3.00M', 'mystery-unpriced2.00M']);
  assert.deepEqual(texts(document.querySelectorAll('.metric-tokens .legend .by-tool .legend-item')), ['Antigravity7.00M', 'Claude Code3.00M']);
  assert.equal(document.querySelectorAll('.metric-cost .col[data-focus="day-2026-10-19"] .by-model .seg').length, 2);
  assert.equal(document.querySelectorAll('.metric-tokens .col[data-focus="day-2026-10-19-tokens"] .by-model .seg').length, 3);
});

test('a model has the same colour in the bars, the legend, the hover and the ring, in cost and in tokens', () => {
  const document = page();
  const swatch = (selector: string) => Object.fromEntries([...document.querySelectorAll(selector)].map((item) => [item.querySelector('.name')!.textContent, item.querySelector('.swatch')!.getAttribute('class')!.replace('swatch ', '')]));
  const cost = swatch('.metric-cost .legend .by-model .legend-item');
  const tokens = swatch('.metric-tokens .legend .by-model .legend-item');
  for (const [name, classes] of Object.entries(cost)) assert.equal(tokens[name], classes, `${name}: the priced models keep their colour`);
  const ring = Object.fromEntries([...document.querySelectorAll('.pie-tokens .pie-legend li')].map((li) => [li.querySelector('.pie-name bdi')!.textContent, li.querySelector('.swatch')!.getAttribute('class')!.replace('swatch ', '')]));
  assert.deepEqual(tokens, ring, 'the token drawing wears the colours of the token ring');
});

test('each drawing is one tab stop with names of its own, so that a refresh finds the one that shows', () => {
  const document = page();
  const stops = (unit: string) => [...document.querySelectorAll(`.metric-${unit} .col`)].filter((col) => col.getAttribute('tabindex') === '0').map((col) => col.getAttribute('data-focus'));
  assert.deepEqual(stops('cost'), ['day-2026-10-21']);
  assert.deepEqual(stops('tokens'), ['day-2026-10-21-tokens']);
  const names = [...document.querySelectorAll('[data-focus]')].map((el) => el.getAttribute('data-focus')!);
  assert.equal(new Set(names).size, names.length, 'no focus name is used twice');
});

test('usage with no price still reaches its day in tokens: the chart runs to it, with the note, while the cost chart ends today', () => {
  const document = page({ '2026-10-21': DAYS['2026-10-21'], '2026-10-24': { antigravity: { 'mystery-unpriced': bucket({ output: 1e6 }) } } });
  assert.equal(document.querySelectorAll('.metric-cost .col').length, 21);
  assert.equal(document.querySelector('.metric-cost .chart-foot .note'), null);
  assert.equal(document.querySelectorAll('.metric-tokens .col').length, 24);
  assert.match(document.querySelector('.metric-tokens .chart-foot .note')!.textContent!, /Usage is dated after today on 1 day/);
  assert.match(document.querySelector('.metric-tokens .col[data-focus="day-2026-10-24-tokens"]')!.getAttribute('aria-label')!, /^2026-10-24 \(after today\): 1\.00M tokens\./);
  assert.equal(document.querySelector('.metric-tokens .xaxis')!.children.length, 24);
});

test('a month with usage and nothing to price still draws its tokens, and says what each drawing lacks', () => {
  const unpriced = page({ '2026-10-20': { antigravity: { 'mystery-unpriced': bucket({ output: 2e6 }) } } });
  assert.equal(texts(unpriced.querySelectorAll('.metric-cost .empty')).join(), 'Usage recorded. No estimated charges are available for this month.');
  assert.equal(unpriced.querySelectorAll('.metric-tokens .col').length, 21);
  assert.ok(unpriced.querySelector('.gchart [data-group-set]'), 'the grouping buttons are there for the drawing that has bars');
  const nothing = page({ '2026-10-20': { antigravity: { 'm-a': bucket({}) } } });
  assert.equal(texts(nothing.querySelectorAll('.metric-tokens .empty')).join(), 'Usage recorded with no tokens.');
  assert.equal(texts(page({}).querySelectorAll('.gchart .empty')).join('|'), 'No usage recorded this month yet.|No usage recorded this month yet.');
  assert.equal(page({}).querySelector('.gchart [data-group-set]'), null, 'no bars, no grouping buttons');
});

test('the even pace follows the budget of the unit: a token budget draws it in tokens only, a dollar budget in dollars only, and no budget draws none', () => {
  const tokenBudget = page(DAYS, { budgetMode: 'tokens', tokenBudgetLimit: 31, budgetLimit: 62 });
  const pace = tokenBudget.querySelector('.metric-tokens .pace')!;
  assert.ok(Math.abs(Number(pace.getAttribute('style')!.match(/bottom:([\d.]+)%/)![1]) - 10) < 0.01, 'a million a day on a ten million scale is 10% up');
  assert.match(tokenBudget.querySelector('.metric-tokens .legend')!.textContent!, /Even pace 1\.00M a day2 days above/);
  assert.equal(tokenBudget.querySelector('.metric-cost .pace'), null);
  assert.doesNotMatch(tokenBudget.querySelector('.metric-cost .legend')!.textContent!, /Even pace/);

  const costBudget = page(DAYS, { budgetMode: 'cost', budgetLimit: 31, tokenBudgetLimit: 62 });
  assert.ok(costBudget.querySelector('.metric-cost .pace'));
  assert.equal(costBudget.querySelector('.metric-tokens .pace'), null);
  assert.doesNotMatch(costBudget.querySelector('.metric-tokens .legend')!.textContent!, /Even pace/);

  for (const none of [{}, { budgetMode: 'tokens' }, { budgetMode: 'cost' }]) {
    const document = page(DAYS, none);
    assert.equal(document.querySelectorAll('.pace').length, 0, JSON.stringify(none));
    assert.doesNotMatch(document.querySelector('.gchart')!.textContent!, /Even pace/, JSON.stringify(none));
  }
  const off = page(DAYS, { budgetMode: 'tokens', tokenBudgetLimit: 31 * 100 });
  assert.equal(off.querySelector('.metric-tokens .pace'), null);
  assert.match(off.querySelector('.metric-tokens .legend')!.textContent!, /Even pace 100\.00M a day0 days above \(off the scale\)/);
});

test('a past month draws its tokens whole and takes its way in at its busiest day', () => {
  const document = page({ '2026-09-02': { antigravity: { 'm-a': bucket({ output: 1e6 }) } }, '2026-09-17': { antigravity: { 'm-a': bucket({ output: 9e6 }) } } }, {}, '2026-09');
  assert.equal(document.querySelectorAll('.metric-tokens .col').length, 30);
  assert.deepEqual([...document.querySelectorAll('.metric-tokens .col')].filter((c) => c.getAttribute('tabindex') === '0').map((c) => c.getAttribute('data-focus')), ['day-2026-09-17-tokens']);
  assert.equal(document.querySelector('.metric-tokens .peak')!.textContent, '9M');
});
