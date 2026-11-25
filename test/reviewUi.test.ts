import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage, renderSessionDetail, sessionView } from '../src/panelHtml';
import { Pricing, type ResolvedRate } from '../src/pricing';
import { aggregate, type LegacyBaseline } from '../src/reconcile';
import { buildSessionDetail } from '../src/sessionDetail';
import { statusBarText } from '../src/statusText';
import { groupModels, kindRates, type ModelRow, summarize, type Summary } from '../src/summary';
import { type DayRecord, emptyBucket, type SessionRecord, type Source, type TokenBucket, type UsageRecord } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-4-6';

const bucket = (requests: number, output: number): TokenBucket => ({ ...emptyBucket(), requests, output });
const closeTo = (actual: number, expected: number, message?: string): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} is not ${expected}`);
const record = (id: string, byModel: Record<string, TokenBucket>, day = '2026-10-20'): SessionRecord => ({
  source: 'claude', id, project: `project-${id}`, first: Date.parse(`${day}T09:00:00Z`), last: Date.parse(`${day}T10:00:00Z`), days: { [day]: byModel },
});

test('a session whose legacy totals were used up to no requests but still hold tokens stays in the list, the month and the drawer', () => {
  const day = '2026-10-20';
  const days: Record<string, DayRecord> = { [day]: { claude: { [SONNET]: bucket(0, 1e6) } } };
  const rec = record('residue', { [SONNET]: bucket(0, 1e6) });
  const s = summarize({ days, sessions: { 'claude:residue': rec } }, new Pricing(), NOW, '2026-10');

  closeTo(s.total, 10);
  assert.equal(s.totalRequests, 0);
  assert.deepEqual(s.sessions.map((row) => row.key), ['claude:residue'], 'the session is listed although it has no request left');
  const row = s.sessions[0];
  assert.equal(row.tokens.requests, 0);
  assert.equal(row.tokens.output, 1e6);
  closeTo(row.cost, 10, 'its cost');
  assert.deepEqual(row.models, [SONNET]);
  closeTo(s.sessions.reduce((sum, r) => sum + r.cost, 0) + s.unattributed!, s.total, 'sessions plus unattributed make the month');
  assert.equal(s.unattributed, 0);

  const detail = buildSessionDetail('claude:residue', rec, new Pricing(), '2026-10');
  assert.deepEqual(detail.tokens, row.tokens, 'the drawer shows the tokens of the list');
  closeTo(detail.cost, row.cost, 'the drawer shows the cost of the list');
  closeTo(detail.monthCost, row.cost);
  assert.deepEqual(detail.days.map((d) => [d.day, d.requests]), [[day, 0]]);
  assert.deepEqual(detail.models.map((m) => m.model), [SONNET]);
  closeTo(detail.models[0].cost!, 10);
});

test('the tokens a session holds in a bucket with no requests are part of its row and its drawer, beside the buckets that have requests', () => {
  const day = '2026-10-20';
  const byModel = { [SONNET]: bucket(1, 1e6), [OPUS]: bucket(0, 1e6) };
  const rec = record('both', byModel);
  const s = summarize({ days: { [day]: { claude: byModel } }, sessions: { 'claude:both': rec } }, new Pricing(), NOW, '2026-10');

  const row = s.sessions[0];
  assert.equal(row.tokens.requests, 1);
  assert.equal(row.tokens.output, 2e6, 'both buckets count');
  closeTo(row.cost, 10 + 25);
  assert.deepEqual(row.models, [OPUS, SONNET]);
  assert.equal(s.unattributed, 0, 'nothing of the month is left outside the session');

  const detail = buildSessionDetail('claude:both', rec, new Pricing(), '2026-10');
  assert.equal(detail.tokens.output, 2e6);
  closeTo(detail.cost, 35);
  assert.deepEqual(detail.days.map((d) => [d.day, d.requests]), [[day, 1]]);
  assert.deepEqual(detail.models.map((m) => m.model).sort(), [OPUS, SONNET]);
});

test('what an older store counted of a model the logs do not name is left with no requests after the logs take theirs, and stays in the session and the month', () => {
  const day = '2026-10-20';
  const snapshot = Date.parse(`${day}T10:00:00Z`);
  const legacy: LegacyBaseline = { days: { [day]: { claude: { [OPUS]: bucket(2, 2e6) } } }, before: snapshot, sessions: { 'claude:a': record('a', { [OPUS]: bucket(2, 2e6) }) } };
  const held = [1, 2].map((n): UsageRecord => ({ id: `claude:m${n}`, source: 'claude', day, model: SONNET, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 5e5 }, session: 'a', ts: snapshot - n * 1000 }));
  const facts = aggregate(Object.fromEntries(held.map((r) => [r.id, r])), legacy, [], true);
  assert.deepEqual(facts.sessions['claude:a'].days[day][OPUS], bucket(0, 1e6), 'two requests taken out of the two the older store counted leave their tokens and no requests');

  const s = summarize(facts, new Pricing(), NOW, '2026-10');
  closeTo(s.total, 10 + 25);
  const row = s.sessions[0];
  assert.equal(row.tokens.requests, 2);
  assert.equal(row.tokens.output, 2e6);
  closeTo(row.cost, 35, 'the session holds the tokens of the older store that no log names');
  assert.equal(s.unattributed, 0);
  assert.deepEqual(buildSessionDetail('claude:a', facts.sessions['claude:a'], new Pricing(), '2026-10').tokens, row.tokens);
});

test('a bucket with no requests and no tokens is still nothing: no row and no day in the drawer', () => {
  const rec = record('empty', { [SONNET]: bucket(0, 0) });
  const s = summarize({ days: { '2026-10-20': { claude: { [SONNET]: bucket(1, 1e6) } } }, sessions: { 'claude:empty': rec } }, new Pricing(), NOW, '2026-10');
  assert.deepEqual(s.sessions, []);
  assert.equal(s.unattributed, 10);
  const detail = buildSessionDetail('claude:empty', rec, new Pricing(), '2026-10');
  assert.deepEqual(detail.days, []);
  assert.deepEqual(detail.models, []);
  assert.equal(detail.cost, 0);
});

test('the page copes with a session of no requests and some tokens: card, total, count and drawer print numbers, not NaN or blanks', () => {
  const day = '2026-10-20';
  const rec = record('residue', { [SONNET]: bucket(0, 1e6) });
  const s = summarize({ days: { [day]: { claude: { [SONNET]: bucket(0, 1e6) } } }, sessions: { 'claude:residue': rec }, firstDay: day }, new Pricing(), NOW, '2026-10');
  const html = renderBody(s, cfg);
  const { document } = parseHTML(html);
  const card = document.querySelector('.scard[data-key="claude:residue"]')!;
  assert.ok(card, 'the card is on the page');
  assert.match(card.querySelector('.srow2')!.textContent!, / 0 req$/);
  assert.equal(card.querySelector('.cost')!.textContent, '$10.00');
  assert.match(card.querySelector('.scard-main')!.getAttribute('aria-label')!, /, 0 requests\./);
  assert.match(document.querySelector('.scard.total .name')!.textContent!, /All · 1 session$/);
  assert.equal(document.querySelector('.scard.total .cost')!.textContent, '$10.00');
  assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  assert.equal(document.querySelector('.note'), null, 'no cost is left outside the sessions');

  const drawer = parseHTML(`<div id="d">${renderSessionDetail(buildSessionDetail('claude:residue', rec, new Pricing(), '2026-10'))}</div>`).document;
  assert.deepEqual([...drawer.querySelectorAll('.d-big')].map((big) => big.textContent), ['$10.00', '0']);
  assert.deepEqual([...drawer.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)), [['2026-10-20', '0', '$10.00'], [SONNET, '0', '$10.00']]);
  assert.doesNotMatch(drawer.querySelector('#d')!.textContent!, /NaN|undefined|Infinity/);
});

type Doc = ReturnType<typeof parseHTML>['document'];
type Elem = Doc['body'];

const tiles = (card: Elem) => [...card.querySelectorAll('.tile')].map((tile) => ({ label: tile.querySelector('small')!.textContent, rate: tile.querySelector('em')?.textContent, hover: tile.getAttribute('title')! }));
const cardOf = (document: Doc, model: string) => [...document.querySelectorAll('.mcard')].find((card) => card.querySelector('.name')!.textContent === model)!;
const used = (requests: number, over: Partial<TokenBucket>): TokenBucket => ({ ...emptyBucket(), requests, ...over });
const modelsPage = (days: Record<string, DayRecord>, pricing = new Pricing()) => parseHTML(renderBody(summarize({ days: { '2026-10-20': days['2026-10-20'] }, sessions: {} }, pricing, NOW), cfg)).document;

test('a model that ran in two tools at two rates prints mixed for the kind they price differently, and its hover names each rate, tool and count', () => {
  const pricing = new Pricing({ 'claude/claude-opus-5': { input: 2 }, 'cursor/claude-opus-5': { input: 8 } });
  const document = modelsPage({ '2026-10-20': { claude: { 'claude-opus-5': used(2, { input: 2e6 }) }, cursor: { 'claude-opus-5': used(1, { input: 1e6 }) } } }, pricing);
  const card = cardOf(document, 'claude-opus-5');
  assert.equal(card.querySelector('.srow1 .cost')!.textContent, '$12.00', '2M at $2 and 1M at $8: no single rate gives this from 3M');
  const [input, ...others] = tiles(card);
  assert.deepEqual([input.label, input.rate], ['In', 'mixed']);
  assert.equal(input.hover, 'Input: 3,000,000 tokens at mixed rates\n$2 per 1M · Claude Code · 2,000,000 tokens\n$8 per 1M · Cursor · 1,000,000 tokens');
  assert.deepEqual(others.map((tile) => tile.rate), ['$0.5', '$6.25', '$10', '$25'], 'the kinds they price alike keep one rate');
  assert.deepEqual(others.map((tile) => tile.hover), ['Cache read: none used at $0.5 per 1M', 'Cache write: none used at $6.25 per 1M', 'Cache write 1h: none used at $10 per 1M', 'Output: none used at $25 per 1M']);
});

test('the rate of a kind is the rate of the tokens that used it, not of the member that has the most tokens', () => {
  const pricing = new Pricing({ 'cursor/claude-opus-5': { input: 2 } });
  const document = modelsPage({ '2026-10-20': { claude: { 'claude-opus-5': used(1, { output: 3e6 }) }, cursor: { 'claude-opus-5': used(1, { input: 1e6 }) } } }, pricing);
  const [input, , , , output] = tiles(cardOf(document, 'claude-opus-5'));
  assert.deepEqual([input.rate, input.hover], ['$2', 'Input: 1,000,000 tokens at $2 per 1M'], 'the input all ran in Cursor');
  assert.deepEqual([output.rate, output.hover], ['$25', 'Output: 3,000,000 tokens at $25 per 1M']);
});

test('DSH tokens at the peak and the off-peak tier are two rates, and the hover says which tier took how many', () => {
  const route = (tier: string) => JSON.stringify(['deepseek-account', 'deepseek-flash', tier]);
  const document = modelsPage({ '2026-10-20': { dsh: { [route('peak')]: used(1, { input: 1e6, output: 1e6 }), [route('offpeak')]: used(1, { input: 2e6 }) } } });
  const card = cardOf(document, 'deepseek-v4.1-flash');
  const [input, , , , output] = tiles(card);
  assert.deepEqual([input.rate, input.hover], ['mixed', 'Input: 3,000,000 tokens at mixed rates\n$0.15 per 1M · DSH (deepseek-account, off-peak) · 2,000,000 tokens\n$0.3 per 1M · DSH (deepseek-account, peak) · 1,000,000 tokens']);
  assert.deepEqual([output.rate, output.hover], ['$1.2', 'Output: 1,000,000 tokens at $1.2 per 1M'], 'a kind only the peak tier used has one rate');
  assert.equal(card.querySelector('.srow1 .cost')!.textContent, '$1.80', '1M input at $0.30 and 1M output at $1.20 at the peak, 2M input at half of $0.30 off peak');
});

test('a model whose tools price it alike prints the same card as before: one rate per tile, no mixed, the usual source line', () => {
  const document = modelsPage({ '2026-10-20': { claude: { 'claude-opus-5': used(2, { input: 2e6, output: 1e6 }) }, cursor: { 'claude-opus-5': used(1, { input: 1e6, output: 1e6 }) } } });
  const card = cardOf(document, 'claude-opus-5');
  assert.deepEqual(tiles(card).map((tile) => tile.rate), ['$5', '$0.5', '$6.25', '$10', '$25']);
  assert.equal(tiles(card)[0].hover, 'Input: 3,000,000 tokens at $5 per 1M');
  assert.doesNotMatch(card.innerHTML, /mixed/);
  assert.equal(card.querySelector('.rate-foot')!.textContent, 'Per 1M tokens · built in');
});

test('the line under the tiles does not claim one source of rates when one tool has yours and another the built-in table', () => {
  const pricing = new Pricing({ 'claude/claude-opus-5': { input: 2 } });
  const document = modelsPage({ '2026-10-20': { claude: { 'claude-opus-5': used(1, { input: 2e6 }) }, cursor: { 'claude-opus-5': used(1, { input: 1e6 }) } } }, pricing);
  const foot = cardOf(document, 'claude-opus-5').querySelector('.rate-foot')!;
  assert.equal(foot.textContent, 'Per 1M tokens · your settings and built in');
  assert.equal(foot.querySelector('b')!.textContent, 'your settings');
  assert.equal(foot.getAttribute('title'), 'Historical Anthropic reference · https://platform.claude.com/docs/en/about-claude/pricing', 'one reference page, said once');
  const own = modelsPage({ '2026-10-20': { claude: { 'claude-opus-5': used(1, { input: 2e6 }) } } }, pricing);
  assert.equal(cardOf(own, 'claude-opus-5').querySelector('.rate-foot')!.textContent, 'Per 1M tokens · your settings', 'one tool with yours is as before');
});

const resolved = (over: Partial<ResolvedRate> = {}): ResolvedRate => ({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, overridden: false, missing: [], ...over });
const row = (source: Source, tokens: Partial<TokenBucket>, rate?: ResolvedRate): ModelRow => ({ source, model: 'claude-opus-5', tokens: used(1, tokens), rate, cost: rate ? 1 : undefined, unpriced: rate ? undefined : true });

test('tokens that have no rate are one more rate of the model, so a card with some of its input unpriced does not claim one price', () => {
  const group = groupModels([row('claude', { input: 1e6 }, resolved()), row('cursor', { input: 2e6 })])[0];
  assert.deepEqual(kindRates(group, 'input').map(({ rate, tokens, payers }) => [rate, tokens, payers.map((payer) => payer.source)]), [[undefined, 2e6, ['cursor']], [2, 1e6, ['claude']]]);
  assert.deepEqual(kindRates(group, 'output'), [], 'a kind nobody used has no rate to speak of');
  const document = parseHTML(renderBody({ ...summarize({ days: {}, sessions: {} }, new Pricing(), NOW), models: group.members }, cfg)).document;
  const [input] = tiles(cardOf(document, 'claude-opus-5'));
  assert.deepEqual([input.rate, input.hover], ['mixed', 'Input: 3,000,000 tokens at mixed rates\nno rate · Cursor · 2,000,000 tokens\n$2 per 1M · Claude Code · 1,000,000 tokens']);
});

test('a kind whose tokens were all unpriced has no figure to print, and a rate from another tool does not fill the gap', () => {
  const group = groupModels([row('claude', { output: 1e6 }, resolved()), row('cursor', { input: 2e6 })])[0];
  assert.deepEqual(kindRates(group, 'input').map((entry) => entry.list), [undefined]);
  const document = parseHTML(renderBody({ ...summarize({ days: {}, sessions: {} }, new Pricing(), NOW), models: group.members }, cfg)).document;
  const [input, , , , output] = tiles(cardOf(document, 'claude-opus-5'));
  assert.deepEqual([input.rate, input.hover], ['?', 'Input: 2,000,000 tokens']);
  assert.deepEqual([output.rate, output.hover], ['$10', 'Output: 1,000,000 tokens at $10 per 1M']);
});

test('the route a rate came from is text in the hover, never markup', () => {
  const evil = '" onmouseover="alert(1)';
  const route = (provider: string) => JSON.stringify([provider, 'deepseek-flash', 'peak']);
  const pricing = new Pricing({ [`dsh[${evil}]/deepseek-flash`]: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
  const document = modelsPage({ '2026-10-20': { dsh: { [route('deepseek-account')]: used(1, { input: 1e6 }), [route(evil)]: used(1, { input: 1e6 }) } } }, pricing);
  assert.equal(document.querySelectorAll('[onmouseover]').length, 0);
  const [input] = tiles(cardOf(document, 'deepseek-v4.1-flash'));
  assert.equal(input.rate, 'mixed');
  assert.ok(input.hover.includes(`$1 per 1M · DSH (${evil}) · 1,000,000 tokens`), input.hover);
});

function boot(summary: Summary, saved?: unknown) {
  const html = renderPage(summary, cfg);
  const { window, document } = parseHTML(html);
  Object.defineProperty(document, 'activeElement', { get: () => document.body });
  const posts: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [];
  const context = {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => saved, setState: (state: unknown) => saves.push(JSON.parse(JSON.stringify(state))), postMessage: (message: Record<string, unknown>) => posts.push(JSON.parse(JSON.stringify(message))) }),
  };
  // A browser keeps `checked` of a freshly rendered box in step with its attribute; the stand-in DOM does not, so this does.
  const shimBoxes = () => {
    for (const input of document.querySelectorAll('input[type="checkbox"]')) {
      Object.defineProperty(input, 'checked', {
        configurable: true,
        get: () => input.hasAttribute('checked'),
        set: (on: boolean) => { if (on) input.setAttribute('checked', ''); else input.removeAttribute('checked'); },
      });
    }
  };
  shimBoxes();
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  const fire = (target: Elem, type: string) => target.dispatchEvent(new window.Event(type, { bubbles: true }));
  type Box = { checked: boolean } & Elem;
  const box = (selector: string) => document.querySelector(selector) as unknown as Box;
  return {
    document, window, posts, saves,
    views: () => posts.filter((post) => post.type === 'setSessionView').map((post) => (post.view as { sources: string[] }).sources),
    ticked: () => [...document.querySelectorAll('input[data-filter-all], input[data-filter]')].map((input) => `${input.hasAttribute('data-filter-all') ? 'all' : input.getAttribute('data-filter')}:${(input as unknown as Box).checked}`),
    // What a click on a box does in a browser: it flips first, then the click and the change are heard.
    click: (selector: string) => { const target = box(selector); target.checked = !target.checked; fire(target, 'click'); fire(target, 'change'); },
    render: (body: string) => {
      const event = new window.Event('message');
      Object.assign(event, { data: { type: 'render', theme: 'light', html: body } });
      window.dispatchEvent(event);
      shimBoxes();
    },
  };
}

test('the hover of a mixed tile reaches the page as the text of its own tooltip, like every other hover', () => {
  const pricing = new Pricing({ 'claude/claude-opus-5': { input: 2 }, 'cursor/claude-opus-5': { input: 8 } });
  const summary = summarize({ days: { '2026-10-20': { claude: { 'claude-opus-5': used(2, { input: 2e6 }) }, cursor: { 'claude-opus-5': used(1, { input: 1e6 }) } } }, sessions: {} }, pricing, NOW);
  const tile = boot(summary).document.querySelector('.mcard .tile')!;
  assert.equal(tile.getAttribute('title'), null);
  assert.equal(tile.getAttribute('data-hover'), 'Input: 3,000,000 tokens at mixed rates\n$2 per 1M · Claude Code · 2,000,000 tokens\n$8 per 1M · Cursor · 1,000,000 tokens');
  assert.equal(tile.querySelector('em')!.textContent, 'mixed');
});

const ringOf = (summary: Summary) => parseHTML(renderBody(summary, cfg)).document;
const PARTLY = { 'mystery-model': { input: 1 } };
const month = (models: Record<string, TokenBucket>, rates: Record<string, Partial<ResolvedRate>> = {}): Summary =>
  summarize({ days: { '2026-10-20': { antigravity: models } }, sessions: {}, firstDay: '2026-10-01' }, new Pricing(rates), NOW);

test('the cost ring says + ? when a model is priced in part, as the status bar and the model card do, and says that its cost is a lower bound', () => {
  const summary = month({ 'mystery-model': used(1, { input: 1e6, output: 1e6 }), 'gemini-1.5-flash': used(1, { input: 1e6 }) }, PARTLY);
  assert.ok(summary.models.find((m) => m.model === 'mystery-model')!.cost! > 0, 'a cost, and an unpriced part: the case of the report');
  assert.ok(summary.unpriced.includes('mystery-model'));
  const document = ringOf(summary);
  assert.equal(document.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost + ?');
  assert.equal(document.querySelector('.pie-cost.pie-legend-wrap .note')!.textContent, '1 model partly priced is a lower bound: mystery-model.');
  assert.equal(document.querySelector('.pie-tokens .pie-unit')!.textContent, 'tokens');
  assert.equal(document.querySelector('.pie-tokens.pie-legend-wrap .note'), null);
  assert.match(document.querySelector('.pie-cost .pie-svg')!.getAttribute('aria-label')!, /1 model partly priced is a lower bound: mystery-model\.$/);
  assert.equal(document.querySelector('.pie-cost .pie-svg')!.getAttribute('title'), '1 model partly priced is a lower bound: mystery-model.');
  assert.match(statusBarText(summary, { ...cfg, budgetMode: 'cost' }), /\+\?/, 'the status bar already said so');
  assert.match(cardOf(document, 'mystery-model').querySelector('.cost')!.textContent!, /\+\?$/, 'and so did the card');
});

test('models without a price and models priced in part are told apart in one sentence each, the first as it was', () => {
  const summary = month({ 'mystery-model': used(1, { input: 1e6, output: 1e6 }), 'other-mystery': used(1, { input: 1e6 }), 'gemini-1.5-flash': used(1, { input: 1e6 }) }, PARTLY);
  const document = ringOf(summary);
  assert.equal(document.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost + ?');
  assert.equal(document.querySelector('.pie-cost.pie-legend-wrap .note')!.textContent, '1 model without a price is left out: other-mystery. 1 model partly priced is a lower bound: mystery-model.');
  const several = month({ 'mystery-a': used(1, { input: 1e6, output: 1e6 }), 'mystery-b': used(1, { input: 1e6, output: 1e6 }), 'mystery-c': used(1, { input: 1e6, output: 1e6 }), 'mystery-d': used(1, { input: 1e6, output: 1e6 }) }, { 'mystery-*': { input: 1 } });
  assert.equal(ringOf(several).querySelector('.pie-cost.pie-legend-wrap .note')!.textContent, '4 models partly priced are a lower bound: mystery-a, mystery-b, mystery-c and more.');
});

test('with every model fully priced the ring says est. cost and has no note, and with none priced at all it still says what it did', () => {
  const priced = ringOf(month({ 'gemini-1.5-flash': used(1, { input: 1e6 }) }));
  assert.equal(priced.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost');
  assert.equal(priced.querySelector('.pie-cost.pie-legend-wrap .note'), null);
  const none = ringOf(month({ 'mystery-model': used(1, { input: 1e6 }) }));
  assert.equal(none.querySelector('.pie-cost .pie-unit')!.textContent, 'est. cost + ?');
  assert.deepEqual([...none.querySelectorAll('.pie-cost.pie-legend-wrap .note')].map((note) => note.textContent), ['No priced usage in this month.', '1 model without a price is left out: mystery-model.']);
});

const LEDGER = '/home/me/.agy-token-tracker/usage-v3.json';
const ARCHIVE = '/home/me/.agy-token-tracker/archive';
const attemptedAt = new Date(NOW).toISOString();
const storageOf = (summary: Summary) => parseHTML(renderBody(summary, cfg)).document.querySelector('[data-key="storage-details"]')!;

test('Storage details names the ledger file and the archive folder, not the log folder of Antigravity, and keeps the issue list', () => {
  const summary = summarize({ days: {}, health: { root: '/home/me/.gemini/antigravity', attemptedAt, succeededAt: attemptedAt, problems: ['one log could not be read'] }, storage: { ledger: LEDGER, archive: ARCHIVE } }, new Pricing(), NOW);
  const fold = storageOf(summary);
  assert.equal(fold.querySelector('summary')!.textContent, 'Storage and issue details');
  assert.deepEqual([...fold.querySelectorAll('p.mono')].map((p) => [p.querySelector('b')!.textContent, p.querySelector('bdi')!.textContent]), [['Ledger file', LEDGER], ['Archive folder', ARCHIVE]]);
  assert.deepEqual([...fold.querySelectorAll('li')].map((li) => li.textContent), ['one log could not be read']);
  assert.doesNotMatch(fold.textContent!, /antigravity/, 'the folder of the Antigravity logs is on its own card, as Log folder');
});

test('paths in Storage details are text, and without a path the fold holds the issues alone, or is not there when there are none', () => {
  const evil = '/tmp/<img src=x onerror=alert(1)>/usage-v3.json';
  const hostile = storageOf(summarize({ days: {}, storage: { ledger: evil, archive: '"><script>alert(2)</script>' } }, new Pricing(), NOW));
  assert.equal(hostile.querySelectorAll('img, script').length, 0);
  assert.equal(hostile.querySelector('summary')!.textContent, 'Storage details');
  assert.equal(hostile.querySelector('p.mono bdi')!.textContent, evil);

  const unnamed = parseHTML(renderBody(summarize({ days: {}, health: { root: '/home/me/.gemini/antigravity', attemptedAt, problems: ['x'] } }, new Pricing(), NOW), cfg)).document;
  assert.equal(unnamed.querySelector('[data-key="storage-details"] .mono'), null);
  assert.deepEqual([...unnamed.querySelectorAll('[data-key="storage-details"] li')].map((li) => li.textContent), ['x']);
  assert.equal(parseHTML(renderBody(summarize({ days: {} }, new Pricing(), NOW), cfg)).document.querySelector('[data-key="storage-details"]'), null, 'no path and no issue: nothing to open');
});

const TOOL_MODELS: Partial<Record<Source, string>> = { claude: 'claude-opus-4-6', codex: 'gpt-5.5', antigravity: 'gemini-1.5-flash' };
const sessionsOfTools = (tools: Source[]): Record<string, SessionRecord> => Object.fromEntries(tools.map((source) => [`${source}:s`, {
  source, id: 's', project: `${source}-project`, first: NOW - 3_600_000, last: NOW, days: { '2026-10-21': { [TOOL_MODELS[source]!]: used(1, { input: 100_000 }) } },
}]));
const toolsMonth = (): Summary => summarize({ days: {}, sessions: sessionsOfTools(['antigravity', 'claude', 'codex']) }, new Pricing(), NOW);
const ALL_TICKED = ['all:true', 'antigravity:true', 'claude:true', 'codex:true'];

test('with every tool listed, a click on the All tools box leaves it ticked: there is no state of no tools, so the box cannot be cleared', () => {
  const app = boot(toolsMonth());
  assert.deepEqual(app.ticked(), ALL_TICKED);
  app.click('input[data-filter-all]');
  assert.deepEqual(app.ticked(), ALL_TICKED, 'the click did not stay');
  assert.deepEqual(app.views().at(-1), [], 'and the sessions asked for are those of every tool');
  assert.equal(app.document.querySelector('[data-multi] .multi-label')!.textContent, 'All tools');
  app.click('input[data-filter-all]');
  assert.deepEqual(app.ticked(), ALL_TICKED, 'again, however often it is clicked');
});

test('the boxes follow the picked tools at once, without waiting for the page to be sent again', () => {
  const app = boot(toolsMonth());
  app.click('input[data-filter="claude"]');
  assert.deepEqual(app.views().at(-1), ['antigravity', 'codex']);
  assert.deepEqual(app.ticked(), ['all:false', 'antigravity:true', 'claude:false', 'codex:true'], 'All is not ticked while a tool is left out');
  app.click('input[data-filter-all]');
  assert.deepEqual(app.views().at(-1), []);
  assert.deepEqual(app.ticked(), ALL_TICKED, 'All brings every tool back');
  app.click('input[data-filter="antigravity"]');
  app.click('input[data-filter="codex"]');
  app.click('input[data-filter="claude"]');
  assert.deepEqual(app.views().at(-1), [], 'nothing left ticked means every tool');
  assert.deepEqual(app.ticked(), ALL_TICKED, 'and the boxes say so');
});

test('the boxes still follow the state when the page is sent again, and a state kept from before comes back ticked the way it was', () => {
  const summary = toolsMonth();
  const app = boot(summary);
  app.click('input[data-filter="codex"]');
  app.render(renderBody(summary, cfg, sessionView({ sources: ['antigravity', 'claude'] })));
  assert.deepEqual(app.ticked(), ['all:false', 'antigravity:true', 'claude:true', 'codex:false']);
  app.click('input[data-filter-all]');
  app.render(renderBody(summary, cfg, sessionView({})));
  assert.deepEqual(app.ticked(), ALL_TICKED);
});

const spend = (output: number, model = 'gemini-1.5-flash'): Summary => summarize({ days: { '2026-10-20': { antigravity: { [model]: used(1, { output }) } } }, sessions: {}, firstDay: '2026-10-01' }, new Pricing(), NOW);
const costChart = (summary: Summary) => parseHTML(renderBody(summary, cfg)).document.querySelector('.gchart div.metric-cost')!;

test('a month that costs a few hundredths of a cent draws distinct axis ticks and a peak that is not $0.00', () => {
  const chart = costChart(spend(1000));
  assert.deepEqual([...chart.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$0.00025', '$0.0005'], '$0.0003 on a scale to $0.0005');
  assert.deepEqual([...chart.querySelectorAll('.peak')].map((peak) => peak.textContent), ['$0.00030']);
  const column = chart.querySelector('.col[aria-label^="2026-10-20"]')!;
  assert.equal(column.querySelector('.tip .total b')!.textContent, '$0.00030');
  assert.deepEqual([...column.querySelectorAll('.tip-r b')].map((amount) => amount.textContent), ['$0.00030', '$0.00030', '$0.00030']);
  assert.match(column.getAttribute('aria-label')!, /: \$0\.00030\. By model: gemini-1\.5-flash \$0\.00030\. By tool: Antigravity \$0\.00030\.$/);
  assert.deepEqual([...chart.querySelectorAll('.legend-item small')].map((amount) => amount.textContent), ['$0.00030', '$0.00030']);
});

test('the decimals follow the size of the amount below a cent, and an amount too small for them says so rather than printing zero', () => {
  const peak = (output: number) => costChart(spend(output)).querySelector('.peak')!.textContent;
  assert.equal(peak(20_000), '$0.0060', 'six thousandths of a dollar');
  assert.equal(peak(33_000), '$0.0099');
  assert.equal(peak(1), 'under $0.000001', 'a thirtieth of a millionth of a dollar is not $0.000000');
  assert.equal(peak(10), '$0.000003', 'at the most six decimals');
  const small = costChart(spend(100));
  assert.deepEqual([...small.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$0.000025', '$0.00005'], '$0.00003 on its own scale');
  assert.equal(small.querySelector('.peak')!.textContent, '$0.000030');
});

test('amounts from a cent up print as they always did on the axis, the peak, the hover and the legend', () => {
  const chart = costChart(spend(123_456_789));
  assert.deepEqual([...chart.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$25', '$50']);
  assert.deepEqual([...chart.querySelectorAll('.peak')].map((peak) => peak.textContent), ['$37.04']);
  assert.equal(chart.querySelector('.tip .total b')!.textContent, '$37.04');
  const cent = costChart(spend(33_400));
  assert.deepEqual([...cent.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$0.01', '$0.02']);
  assert.equal(cent.querySelector('.peak')!.textContent, '$0.01');
  const hundreds = costChart(spend(400_000_000));
  assert.deepEqual([...hundreds.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$100', '$200']);
  assert.equal(hundreds.querySelector('.peak')!.textContent, '$120');
  const thousands = costChart(spend(4e9));
  assert.deepEqual([...thousands.querySelectorAll('.yaxis span')].map((tick) => tick.textContent), ['$0', '$1K', '$2K']);
  assert.equal(thousands.querySelector('.peak')!.textContent, '$1200');
});
