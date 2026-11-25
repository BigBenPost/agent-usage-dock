import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize, type Summary } from '../src/summary';
import { emptyBucket, type DayRecord, type Source, type TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const bucket = (input: number, output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, input, output });

function month(entries: [Source, string, TokenBucket][]): Summary {
  const day: DayRecord = {};
  for (const [source, model, tokens] of entries) ((day[source] ??= {})[model] = tokens);
  return summarize({ days: { '2026-10-20': day }, firstDay: '2026-10-01' }, new Pricing(), NOW);
}

const mixed = (): Summary => month([
  ['claude', 'claude-sonnet-5-5', bucket(1_000_000, 1_000_000)],
  ['antigravity', 'gemini-3.8-flash', bucket(2_000_000, 0)],
  ['codex', 'gpt-6.2-sol', bucket(0, 500_000)],
  ['antigravity', 'mystery-model', bucket(3_000_000, 0)],
]);

const page = (summary: Summary) => parseHTML(renderBody(summary, cfg)).document;
type Doc = ReturnType<typeof page>;
const texts = (nodes: Iterable<{ textContent: string | null }>): string[] => [...nodes].map((node) => node.textContent ?? '');
const slices = (document: Doc, mode: 'cost' | 'tokens') => [...document.querySelectorAll(`.hero-ring .pie-${mode} .slice`)];
const hover = (slice: ReturnType<typeof slices>[number]): string => slice.getAttribute('title') ?? '';
const shares = (document: Doc, kind: 'cost' | 'tokens'): number[] => [...document.querySelectorAll(`.mcard .share-${kind}`)].filter((el) => /\d/.test(el.textContent!)).map((el) => Number(el.textContent!.replace(/[^\d.]/g, '')));
const cardOf = (document: Doc, model: string) => [...document.querySelectorAll('.mcard')].find((card) => card.querySelector('.name')?.textContent === model)!;

test('the overview card has the figure, the switch and the legend on the left and the ring on the right, and By model has no ring of its own', () => {
  const document = page(mixed());
  const row = document.querySelector('.hero [data-pie-card]')!;
  assert.equal(row.getAttribute('data-pie'), 'cost');
  const left = row.querySelector('.hero-left')!;
  const ring = row.querySelector('.hero-ring')!;
  assert.deepEqual([...row.children].map((child) => child.className), ['hero-left', 'hero-ring'], 'the ring is the right-hand column');
  assert.ok(left.querySelector('.hero-figure'));
  assert.equal(left.querySelectorAll('.pie-legend-wrap').length, 2, 'a legend for each of the two rings');
  assert.deepEqual([...left.children].map((child) => child.className.split(' ')[0]), ['hero-figure', 'segmented', 'pie-legend-wrap', 'pie-legend-wrap'], 'the switch comes between the figure and the legend');
  assert.equal(slices(document, 'cost').length, 3, 'the models with a price');
  assert.equal(slices(document, 'tokens').length, 4, 'every model');
  assert.match(document.querySelector('.pie-cost .pie-total')!.textContent!, /^\$/);
  assert.match(document.querySelector('.pie-tokens .pie-total')!.textContent!, /M$/);
  assert.equal(document.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost + ?');
  assert.equal(document.querySelector('.pie-tokens .pie-unit')!.textContent, 'tokens');
  const buttons = [...left.querySelectorAll('[data-pie-set]')];
  assert.deepEqual(buttons.map((b) => b.getAttribute('data-pie-set')), ['cost', 'tokens']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
  assert.equal(ring.querySelector('[data-pie-set]'), null, 'no switch beside the ring');
  const inOrder = [...document.querySelectorAll('.hero *')];
  assert.ok(inOrder.indexOf(row) < inOrder.indexOf(document.querySelector('.hero .stats')!), 'the statistics come below');
  const byModel = document.querySelector('[data-key="by-model"]')!;
  assert.equal(byModel.querySelector('svg'), null);
  assert.equal(byModel.querySelector('.pie-legend, .pie-block'), null);
  assert.equal(byModel.getAttribute('data-pie'), 'cost', 'the cards follow the switch');
});

test('each legend row gives the model, its tool, its amount and its share, and the shares add up to the whole', () => {
  const document = page(mixed());
  const rows = [...document.querySelectorAll('.pie-tokens .pie-legend li')];
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent!, /mystery-modelAntigravity/);
  assert.equal(rows[0].querySelector('b')!.textContent, '3.00M');
  const percents = (list: typeof rows) => list.map((row) => Number(row.querySelector('.pie-pct')!.textContent!.replace('%', '')));
  const sum = percents(rows).reduce((a, b) => a + b, 0);
  assert.ok(sum >= 98 && sum <= 102, `token shares add up to ${sum}`);
  const costRows = [...document.querySelectorAll('.pie-cost .pie-legend li')];
  assert.equal(costRows.length, 3, 'the model without a price is not in the cost legend');
  assert.match(costRows[0].textContent!, /claude-sonnet-5-5Claude Code/);
  assert.match(costRows[0].querySelector('b')!.textContent!, /^\$/);
  assert.match(document.querySelector('.pie-cost.pie-legend-wrap .note')!.textContent!, /1 model without a price is left out: mystery-model\.$/);
  assert.equal(document.querySelector('.pie-tokens.pie-legend-wrap .note'), null);
});

test('the overview keeps today, requests and conversations, and the cost is the centre of the ring', () => {
  const document = page(mixed());
  assert.deepEqual(texts(document.querySelectorAll('.hero .stat dt')), ['TODAY', 'REQUESTS', 'CONVERSATIONS']);
  assert.doesNotMatch(document.querySelector('.hero .stats')!.textContent!, /COST/);
});

test('a model without a price has no share of the cost, and the cost ring says so; the token ring keeps it', () => {
  const document = page(mixed());
  const spoken = document.querySelector('.pie-cost .pie-svg')!.getAttribute('aria-label')!;
  assert.match(spoken, /1 model without a price is left out: mystery-model\.$/);
  assert.match(document.querySelector('.pie-cost .pie-svg')!.getAttribute('title')!, /1 model without a price is left out: mystery-model\./);
  assert.doesNotMatch(slices(document, 'cost').map(hover).join('|'), /mystery-model/);
  assert.equal(document.querySelector('.pie-tokens .pie-svg')!.getAttribute('title'), null);
  assert.match(slices(document, 'tokens').map(hover).join('|'), /mystery-model/);
  const card = cardOf(document, 'mystery-model');
  assert.equal(card.querySelector('.share-cost')!.textContent, '–');
  assert.match(card.querySelector('.share-tokens')!.textContent!, /^\d+%$/);
});

test('every model card carries its share of the month by cost and by tokens, and the shares add up to the whole', () => {
  const document = page(mixed());
  const cost = shares(document, 'cost');
  const tokens = shares(document, 'tokens');
  assert.equal(cost.length, 3, 'the unpriced model has none');
  assert.equal(tokens.length, 4);
  for (const [label, list] of [['cost', cost], ['tokens', tokens]] as const) {
    const sum = list.reduce((a, b) => a + b, 0);
    assert.ok(sum >= 98 && sum <= 102, `${label} shares add up to ${sum}`);
  }
  assert.equal(cardOf(document, 'claude-sonnet-5-5').querySelector('.share-tokens')!.textContent, '27%');
});

test('each slice says in its hover which model, which tool, how much and what share', () => {
  const document = page(mixed());
  assert.deepEqual(slices(document, 'tokens').map(hover), [
    'mystery-model (Antigravity): 3.00M, 40%',
    'claude-sonnet-5-5 (Claude Code): 2.00M, 27%',
    'gemini-3.8-flash (Antigravity): 2.00M, 27%',
    'gpt-6.2-sol (Codex): 500.0k, 7%',
  ]);
});

test('the ring gives a model the same colour the daily chart gives it', () => {
  const document = page(mixed());
  const chart = new Map<string, string>();
  for (const item of document.querySelectorAll('.legend-item')) {
    const name = item.querySelector('.name')?.textContent;
    const swatch = item.querySelector('.swatch')?.getAttribute('class');
    if (name && swatch) chart.set(name, swatch.replace('swatch ', ''));
  }
  assert.ok(chart.size >= 3);
  for (const slice of slices(document, 'cost')) {
    const name = hover(slice).split(' (')[0];
    assert.equal(slice.getAttribute('class')!.replace('slice ', ''), chart.get(name), name);
  }
});

test('beyond six models the rest fold into one slice and one legend row; a seventh model alone is shown by name', () => {
  const many = (n: number) => month(Array.from({ length: n }, (_, i) => ['antigravity', `model-${i + 1}`, bucket((i + 1) * 1_000, 0)] as [Source, string, TokenBucket]));
  const eight = page(many(8));
  assert.equal(slices(eight, 'tokens').length, 7, 'six slices and the rest');
  assert.match(hover(eight.querySelector('.pie-tokens .slice.rest')!), /^2 other models: /);
  assert.match(texts(eight.querySelectorAll('.pie-tokens .pie-legend li')).at(-1)!, /^2 other models/);
  const seven = page(many(7));
  assert.equal(slices(seven, 'tokens').length, 7);
  assert.equal(seven.querySelector('.pie-tokens .slice.rest'), null);
  assert.equal(seven.querySelectorAll('.pie-tokens .pie-legend li').length, 7);
  assert.equal(eight.querySelectorAll('.mcard .share-tokens').length, 8, 'every card has its share, folded or not');
});

test('a single model fills the whole ring and has the whole month', () => {
  const document = page(month([['codex', 'gpt-6.2-sol', bucket(1_000, 1_000)]]));
  const path = slices(document, 'tokens')[0].getAttribute('d')!;
  assert.equal(path.match(/M /g)?.length, 2);
  assert.equal(document.querySelector('.mcard .share-tokens')!.textContent, '100%');
  assert.equal(document.querySelector('.mcard .share-cost')!.textContent, '100%');
});

test('model names from logs are text in the hovers, the labels and the cards, never markup', () => {
  const hostile = [
    '<img src=x onerror=alert(1)>',
    'a" onmouseover="alert(2)" x="',
    '</svg><script>alert(3)</script>',
  ];
  const document = page(month(hostile.map((name, i) => ['antigravity', name, bucket((i + 1) * 1_000, 0)] as [Source, string, TokenBucket])));
  assert.equal(document.querySelectorAll('img, [onerror], [onmouseover], [onload]').length, 0);
  assert.equal(document.querySelectorAll('script').length, 0);
  assert.ok(slices(document, 'tokens').some((slice) => hover(slice).includes('<img src=x onerror=alert(1)>')));
  for (const svg of document.querySelectorAll('.pie-svg')) assert.equal(svg.getAttribute('role'), 'img');
  assert.match(document.querySelector('.pie-tokens .pie-svg')!.getAttribute('aria-label')!, /^Tokens by model: /);
});

test('with no models there is no ring, and with none priced the cost ring is empty and says why while the token ring still draws', () => {
  assert.equal(page(month([])).querySelector('.hero-ring'), null);
  const document = page(month([['antigravity', 'mystery-model', bucket(1_000, 0)]]));
  assert.equal(document.querySelectorAll('.pie-cost .slice').length, 1);
  assert.equal(document.querySelectorAll('.pie-cost .slice.empty').length, 1);
  assert.equal(document.querySelector('.pie-cost .pie-total')!.textContent, '$0.00');
  assert.equal(document.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost + ?');
  assert.match(document.querySelector('.pie-cost .pie-svg')!.getAttribute('aria-label')!, /no priced usage in this month\. 1 model without a price is left out: mystery-model\.$/);
  assert.equal(slices(document, 'tokens').length, 1);
  assert.equal(document.querySelector('.pie-tokens .slice.empty'), null);
});

function boot(summary: Summary, saved?: unknown) {
  const html = renderPage(summary, cfg);
  const { window, document } = parseHTML(html);
  Object.defineProperty(document, 'activeElement', { get: () => document.body });
  const saves: Record<string, unknown>[] = [];
  const context = {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => saved, setState: (state: unknown) => saves.push(JSON.parse(JSON.stringify(state))), postMessage: () => undefined }),
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  return {
    document, saves,
    click: (selector: string) => document.querySelector(selector)!.dispatchEvent(new window.Event('click', { bubbles: true })),
    render: (body: string) => {
      const event = new window.Event('message');
      Object.assign(event, { data: { type: 'render', theme: 'light', html: body } });
      window.dispatchEvent(event);
    },
  };
}

const pressed = (document: Doc): string[] => [...document.querySelectorAll('[data-pie-set]')].map((b) => `${b.getAttribute('data-pie-set')}:${b.getAttribute('aria-pressed')}`);
const modes = (document: Doc): string[] => [...document.querySelectorAll('[data-pie-card]')].map((card) => card.getAttribute('data-pie')!);

test('the switch shows the other ring and the other shares, marks its button, is saved, survives a refresh and comes back with the page', () => {
  const first = boot(mixed());
  assert.deepEqual(pressed(first.document), ['cost:true', 'tokens:false']);
  assert.deepEqual(modes(first.document), ['cost', 'cost', 'cost'], 'the ring, the daily chart and the model cards');
  first.click('[data-pie-set="tokens"]');
  assert.deepEqual(modes(first.document), ['tokens', 'tokens', 'tokens']);
  assert.deepEqual(pressed(first.document), ['cost:false', 'tokens:true']);
  assert.equal(first.saves.at(-1)!.pie, 'tokens');

  first.render(renderBody(mixed(), cfg));
  assert.deepEqual(modes(first.document), ['tokens', 'tokens', 'tokens'], 'a refresh keeps it');
  assert.deepEqual(pressed(first.document), ['cost:false', 'tokens:true']);

  const again = boot(mixed(), first.saves.at(-1));
  assert.deepEqual(modes(again.document), ['tokens', 'tokens', 'tokens']);
  again.click('[data-pie-set="cost"]');
  assert.deepEqual(modes(again.document), ['cost', 'cost', 'cost']);
});

test('a saved value that is not one of the two rings falls back to cost', () => {
  const page = boot(mixed(), { pie: '<script>alert(1)</script>' });
  assert.deepEqual(modes(page.document), ['cost', 'cost', 'cost']);
});

test('the page turns the slice hovers into the text of its own tooltip, as it does for every other hover', () => {
  const app = boot(mixed());
  const slice = app.document.querySelector('.pie-tokens .slice')!;
  assert.equal(slice.getAttribute('title'), null);
  assert.equal(slice.getAttribute('data-hover'), 'mystery-model (Antigravity): 3.00M, 40%');
  assert.match(app.document.querySelector('.pie-cost .pie-svg')!.getAttribute('data-hover')!, /1 model without a price is left out: mystery-model\./);
});
