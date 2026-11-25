import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderSessionDetail } from '../src/panelHtml';
import { STYLE } from '../src/panelStyle';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { plural, summarize } from '../src/summary';
import { chartSvg } from '../src/tooltip';
import { emptyBucket, type SessionRecord, type TokenBucket } from '../src/types';
import { parseCss, themeVariables } from './cssColors';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const bucket = (requests: number): TokenBucket => ({ ...emptyBucket(), requests, input: 1e6, output: 1e5 });
const session = (requests: number): SessionRecord => ({ source: 'claude', id: 's1', project: 'proj', first: NOW - 3_600_000, last: NOW, days: { '2026-10-21': { 'claude-opus-4-6': bucket(requests) } } });
const month = (requests: number) => summarize({ days: { '2026-10-21': { claude: { 'claude-opus-4-6': bucket(requests) } } }, sessions: { 'claude:s1': session(requests) } }, new Pricing(), NOW);

const rules = parseCss(STYLE);
const declarations = (selector: string, media?: string): Record<string, string> => Object.assign({}, ...rules.filter((rule) => rule.selectors.includes(selector) && rule.media === media).map((rule) => rule.declarations));

test('every count of requests is written with thousands separators, as the totals at the top are', () => {
  const summary = month(2533);
  const document = parseHTML(renderBody(summary, cfg)).document;
  assert.deepEqual([...document.querySelectorAll('.mcard .chips .chip')].slice(0, 2).map((chip) => chip.textContent), ['Claude Code', '2,533 requests']);
  assert.match(document.querySelector('.scard[data-key] .srow2')!.textContent!, /· 2,533 req$/);
  assert.match(document.querySelector('.scard.total .srow2')!.textContent!, /^2,533 requests$/);
  assert.match(document.querySelector('.stat dd')!.parentElement!.parentElement!.textContent!, /2,533/);
  const detail = parseHTML(renderSessionDetail(buildSessionDetail('claude:s1', session(2533), new Pricing(), '2026-10'))).document;
  const requestsBlock = [...detail.querySelectorAll('.d-grid > div')].find((block) => /Requests/.test(block.textContent!))!;
  assert.match(requestsBlock.textContent!, /2,533/);
  assert.deepEqual([...detail.querySelectorAll('td.n')].map((cell) => cell.textContent).filter((text) => /^\d/.test(text!)).slice(0, 2), ['2,533', '2,533']);
});

test('a single request is not "1 requests" anywhere', () => {
  const document = parseHTML(renderBody(month(1), cfg)).document;
  assert.equal([...document.querySelectorAll('.mcard .chips .chip')][1].textContent, '1 request');
  assert.match(document.querySelector('.scard.total .srow2')!.textContent!, /^1 request$/);
  assert.doesNotMatch(document.body.textContent!, /\b1 requests\b/);
  assert.equal(plural(1, 'session'), '1 session');
  assert.equal(plural(0, 'session'), '0 sessions');
  assert.equal(plural(12345, 'session'), '12,345 sessions');
});

test('the month switcher and the two Cost per session dropdowns all use the same custom menu control', () => {
  const document = parseHTML(renderBody(summarize({ days: { '2026-10-21': { claude: { 'claude-opus-4-6': bucket(3) } } }, sessions: { 'claude:a': session(3), 'codex:b': { ...session(3), source: 'codex', id: 'b' } } }, new Pricing(), NOW), cfg)).document;
  assert.equal(document.querySelectorAll('select').length, 0);
  const menus = [...document.querySelectorAll('.multi')];
  assert.equal(menus.length, 3);
  assert.equal(document.querySelectorAll('.monthnav .multi').length, 1);
  assert.equal(document.querySelectorAll('.sortbar .multi').length, 2);
  for (const menu of menus) {
    assert.ok(menu.querySelector(':scope > button.multi-btn > .multi-label'));
    assert.ok(menu.querySelector(':scope > button.multi-btn > .caret'));
    assert.ok(menu.querySelector(':scope > .multi-list'));
  }
});

test('every disclosure turns the same small chevron, whether it is a card or a part inside one', () => {
  const fold = declarations('.diagnostic > summary::before');
  assert.equal(fold.width, '5px');
  assert.equal(fold['border-right'], declarations('.caret')['border-right']);
  assert.equal(declarations('.diagnostic > summary::-webkit-details-marker').display, 'none');
  assert.deepEqual(declarations('details.fold > summary::before'), fold);
  assert.ok(rules.some((rule) => rule.selectors.includes('details.fold[open] > summary::before') && rule.selectors.includes('.diagnostic[open] > summary::before')));
});

test('the pills of the session bar share a height, and the round buttons share the border of the other controls', () => {
  assert.equal(declarations('.segmented button').padding, '3px 13px');
  assert.equal(declarations('.multi-btn').padding, '4px 12px');
  assert.match(declarations('.icon-btn').border, /var\(--hair-2\)/);
  assert.match(declarations('.multi-btn').border, /var\(--hair-2\)/);
  assert.match(declarations('.session-pages .linkbtn').border, /var\(--hair-2\)/);
});

test('the figures of the overview each have their caption on a line of its own, and the token labels are the label style of the page', () => {
  assert.equal(declarations('.stat dd small').display, 'block');
  assert.equal(declarations('.stat dd small')['margin-left'], undefined);
  const label = declarations('.stat dt');
  const tokens = declarations('.tok5 small');
  for (const property of ['font-size', 'font-weight', 'letter-spacing', 'text-transform']) assert.equal(tokens[property], label[property], property);
  assert.equal(declarations('.tok5 .t', '@media (max-width: 560px)').padding, undefined, 'no padding that pushes the narrow columns off the left edge of the card');
});

test('the link to the rates takes the side of the lines above it', () => {
  assert.equal(declarations('.meta .linkbtn')['align-self'], 'flex-start');
  assert.equal(declarations('.meta .linkbtn', '@media (min-width: 700px)')['align-self'], 'flex-end');
});

test('the chart in the status bar hover draws each model family in the colour the dashboard gives it, in both themes', () => {
  const day = { antigravity: { 'gemini-1.5-flash': bucket(5), 'deepseek-x': bucket(4) }, claude: { 'claude-opus-4-6': bucket(3) }, codex: { 'gpt-5.5': bucket(2) } };
  const summary = summarize({ days: { '2026-10-20': day }, firstDay: '2026-10-01' }, new Pricing(), NOW);
  for (const theme of ['light', 'dark'] as const) {
    const variables = themeVariables(rules, theme);
    const svg = chartSvg(summary, cfg, theme === 'dark');
    for (const family of ['--gemini', '--opus', '--gpt', '--deepseek']) {
      const wanted = variables[family].toLowerCase();
      assert.ok(svg.toLowerCase().includes(`fill="${wanted}"`), `${theme}: ${family} ${wanted} is drawn in the hover chart`);
    }
  }
});

const cards = (pricing: Pricing, models: Record<string, Record<string, TokenBucket>>) => {
  const days = { '2026-10-21': models };
  return [...parseHTML(renderBody(summarize({ days, sessions: {} }, pricing, NOW), cfg)).document.querySelectorAll('.mcard')];
};

test('a model card always has the five tiles, with the count and the rate that prices it, and a dash for a kind the model did not use', () => {
  const [claude, codex] = cards(new Pricing(), { claude: { 'claude-sonnet-5-5': { ...emptyBucket(), requests: 1, input: 5, cacheRead: 7, output: 3 } }, codex: { 'gpt-6.2-sol': { ...emptyBucket(), requests: 1, input: 2, cacheWrite1h: 4 } } });
  const tile = (card: ReturnType<typeof cards>[number]) => [...card.querySelectorAll('.tile')].map((t) => [t.querySelector('small')!.textContent, t.querySelector('b')!.textContent, t.querySelector('em')!.textContent]);
  assert.deepEqual(tile(claude), [['In', '5', '$2'], ['C.read', '7', '$0.1'], ['C.write', '–', '$2.5'], ['W 1h', '–', '$4'], ['Out', '3', '$10']]);
  assert.deepEqual(tile(codex), [['In', '2', '$2'], ['C.read', '–', '$0.1'], ['C.write', '–', '$2.5'], ['W 1h', '4', '$2.5'], ['Out', '–', '$10']], 'the one-hour write is priced like the write when it has no rate of its own');
  assert.deepEqual([...claude.querySelectorAll('.tile')].map((t) => t.classList.contains('off')), [false, false, true, true, false], 'the unused kinds are marked, so they can be dimmed');
  assert.match(claude.querySelector('.tile')!.getAttribute('title')!, /^Input: 5 tokens at \$2 per 1M$/);
  assert.match(claude.querySelectorAll('.tile')[2].getAttribute('title')!, /^Cache write: none used at \$2\.5 per 1M$/);
});

test('the source of the rates is one line under the tiles, and the pages the built-in rates come from are in its hover, not on the card', () => {
  const [claude, codex] = cards(new Pricing(), { claude: { 'claude-sonnet-5-5': bucket(1) }, codex: { 'gpt-6.2-sol': bucket(1) } });
  assert.equal(claude.querySelector('.rate-foot')!.textContent, 'Per 1M tokens · built in');
  assert.equal(claude.querySelector('.rate-foot')!.getAttribute('title'), 'Historical Anthropic reference · https://platform.claude.com/docs/en/about-claude/pricing');
  assert.equal(codex.querySelector('.rate-foot')!.textContent, 'Per 1M tokens · built in');
  assert.match(codex.querySelector('.rate-foot')!.getAttribute('title')!, /^Historical OpenAI reference \(prompts up to 272K tokens\) · https:\/\/developers\.openai\.com\//);
  for (const card of [claude, codex]) assert.doesNotMatch(card.textContent!, /https?:\/\//);
});

test('rates from the settings say so, a rate that is missing shows a question mark, and a model without rates says unpriced', () => {
  const [own] = cards(new Pricing({ 'claude-sonnet-5-5': { input: 3 } }), { claude: { 'claude-sonnet-5-5': bucket(1) } });
  assert.equal(own.querySelector('.tile em')!.textContent, '$3');
  assert.equal(own.querySelector('.rate-foot')!.textContent, 'Per 1M tokens · your settings');
  assert.equal(own.querySelector('.rate-foot b')!.textContent, 'your settings');

  const [partial] = cards(new Pricing({ 'mystery-model': { input: 1 } }), { antigravity: { 'mystery-model': { ...bucket(1), input: 5 } } });
  assert.deepEqual([...partial.querySelectorAll('.tile')].map((t) => t.querySelector('em')!.textContent), ['$1', '?', '?', '?', '?']);
  assert.equal(partial.querySelector('.rate-foot')!.getAttribute('title'), null, 'no page to point to');

  const [none] = cards(new Pricing(), { antigravity: { 'mystery-model': bucket(1) } });
  assert.equal(none.querySelectorAll('.tile').length, 5, 'the five tiles are there without rates');
  assert.equal(none.querySelector('.tile em'), null);
  assert.equal(none.querySelector('.rate-foot'), null);
  assert.equal(none.querySelector('.cost .warn')!.textContent, 'unpriced');
});

test('the facts of a model are capsules: its tool, its requests and its share, the share filled to its length in the family colour', () => {
  const [card] = cards(new Pricing(), { claude: { 'claude-sonnet-5-5': { ...emptyBucket(), requests: 3, input: 3e6 } }, codex: { 'gpt-6.2-sol': { ...emptyBucket(), requests: 1, input: 1e6 } } });
  const chips = [...card.querySelectorAll('.chips > .chip')];
  assert.equal(chips.length, 3);
  assert.equal(chips[2].classList.contains('share'), true);
  assert.equal(chips[2].querySelector('.share-cost .v')!.textContent, '75%');
  assert.equal(chips[2].querySelector('.share-cost i')!.getAttribute('style'), 'width:75.0%');
  assert.equal(chips[2].querySelector('.share-tokens i')!.getAttribute('style'), 'width:75.0%');
  assert.ok(card.classList.contains('f-opus'), 'the card carries its family so the fill takes the family colour');
  const [unpriced] = cards(new Pricing(), { antigravity: { 'mystery-model': bucket(1) } });
  assert.equal(unpriced.querySelector('.share-cost .v')!.textContent, '–');
  assert.equal(unpriced.querySelector('.share-cost i'), null, 'no fill for a share that does not exist');
});

test('the sessions have one control for their order, with every order in it', () => {
  const document = parseHTML(renderBody(month(3), cfg)).document;
  assert.equal(document.querySelectorAll('[data-menu="sort"]').length, 1);
  assert.equal(document.querySelectorAll('.sortbar .segmented, [data-sort-preset]').length, 0);
  assert.equal(document.querySelectorAll('[data-menu="sort"] [data-sort-option]').length, 12);
  assert.equal(document.querySelector('[data-menu="sort"] [data-sort-option][aria-pressed="true"]')!.getAttribute('data-sort-option'), 'last:desc');
});

test('the switch hides the other ring and the other shares through the data-pie of whatever card holds them', () => {
  for (const [mode, hidden] of [['cost', 'tokens'], ['tokens', 'cost']]) {
    assert.equal(declarations(`[data-pie="${mode}"] .pie-${hidden}`).display, 'none', `${mode}: ring`);
    assert.equal(declarations(`[data-pie="${mode}"] .chip.share > .share-${hidden}`).display, 'none', `${mode}: shares`);
  }
  assert.equal(declarations('.hero-row').display, 'flex');
  assert.equal(declarations('.hero-row .hero-figure').margin, '0');
});
