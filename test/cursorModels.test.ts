import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { canonicalModel } from '../src/modelNames';
import { renderBody, renderPage, renderSessionDetail } from '../src/panelHtml';
import { ringSpan } from '../src/pie';
import { Pricing, referenceModel } from '../src/pricing';
import { aggregate } from '../src/reconcile';
import { buildSessionDetail } from '../src/sessionDetail';
import { groupModels, modelFamily, modelLabel, summarize } from '../src/summary';
import { emptyBucket, isScanned, SCANNED_SOURCES, SOURCE_LABELS, SOURCES, type DayRecord, type TokenBucket, type UsageRecord } from '../src/types';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const cfg = normalizeConfig({});
const bucket = (requests: number, output: number, over: Partial<TokenBucket> = {}): TokenBucket => ({ ...emptyBucket(), requests, output, ...over });

/** Every model name in a Cursor usage ledger that runs to 14,000 events, and the name each should read as everywhere on the page. */
const CURSOR_NAMES: [string, string][] = [
  ['claude-4.6-opus-max-thinking', 'claude-opus-4-6'], ['claude-opus-4-7-thinking-max', 'claude-opus-4-7'], ['claude-4.5-opus-high-thinking', 'claude-opus-4-5'],
  ['claude-4.1-opus-thinking', 'claude-opus-4-1'], ['claude-4.6-opus-high-thinking', 'claude-opus-4-6'], ['gpt-5.5-extra-high', 'gpt-5.5'],
  ['claude-opus-4-7-thinking-xhigh', 'claude-opus-4-7'], ['claude-opus-5-5-max', 'claude-opus-5-5'], ['composer-2.5', 'composer-2.5'],
  ['claude-4.6-opus-max', 'claude-opus-4-6'], ['claude-4-opus-thinking', 'claude-opus-4'], ['gemini-3-pro-preview', 'gemini-3-pro-preview'],
  ['gpt-5.5-extra-high-fast', 'gpt-5.5-fast'], ['composer-2.5-fast', 'composer-2.5-fast'], ['claude-4.6-sonnet-high-thinking', 'claude-sonnet-4-6'],
  ['claude-opus-5-5-xhigh', 'claude-opus-5-5'], ['gpt-5.4-xhigh', 'gpt-5.4'], ['gemini-4-argon-high', 'gemini-4-argon'],
  ['claude-4.6-sonnet-max-thinking', 'claude-sonnet-4-6'], ['gpt-5.5-high', 'gpt-5.5'], ['gpt-5.1-codex', 'gpt-5.1-codex'],
  ['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5'], ['default', 'cursor-auto'], ['gpt-5.5-medium', 'gpt-5.5'], ['claude-opus-5-5-high', 'claude-opus-5-5'],
  ['agent_review', 'cursor-agent-review'], ['claude-4.6-opus-low-thinking', 'claude-opus-4-6'], ['claude-opus-5-5-medium', 'claude-opus-5-5'],
  ['gpt-5.6-terra-medium', 'gpt-5.6-terra'], ['composer-2', 'composer-2'], ['composer-2-fast', 'composer-2-fast'], ['gemini-3.5-flash', 'gemini-3.5-flash'],
  ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview'], ['gpt-5.4-high', 'gpt-5.4'], ['gpt-5', 'gpt-5'], ['claude-opus-4-7-max', 'claude-opus-4-7'],
  ['gpt-5.4-medium', 'gpt-5.4'], ['gpt-5.2-codex-xhigh', 'gpt-5.2-codex'], ['composer-1', 'composer-1'], ['gemini-3.8-flash-high', 'gemini-3.8-flash'],
  ['gpt-5.2', 'gpt-5.2'], ['claude-opus-5-5-low', 'claude-opus-5-5'], ['claude-4.6-sonnet-medium-thinking', 'claude-sonnet-4-6'],
  ['gemini-4-argon', 'gemini-4-argon'], ['claude-4-sonnet-thinking', 'claude-sonnet-4'],
];

test('Cursor\'s spellings of a model read as the name every other tool gives it: no effort, no thinking mark, Anthropic\'s order', () => {
  for (const [name, expected] of CURSOR_NAMES) assert.equal(canonicalModel(name), expected, name);
  assert.equal(canonicalModel('claude-sonnet-5-5'), 'claude-sonnet-5-5', 'a name that needs no change is the name');
  assert.equal(canonicalModel('claude-3-5-sonnet'), 'claude-3-5-sonnet', 'the Claude 3 models keep the version first');
  assert.equal(canonicalModel('claude-opus-4-6-thinking'), 'claude-opus-4-6', 'and so does Antigravity\'s Claude with thinking');
  assert.equal(canonicalModel('Claude-4.6-Opus-HIGH'), 'claude-opus-4-6');
  assert.equal(canonicalModel('gpt-5.5-fast'), 'gpt-5.5-fast', '-fast is priced apart and stays');
  assert.equal(canonicalModel('gemini-4-hydrogen-tiered-high'), 'gemini-4-hydrogen-tiered-high', 'tiered-high is part of this model name');
  assert.equal(canonicalModel('o3-mini-high'), 'o3-mini');
  for (const kept of ['gemini-2.5-flash-thinking-exp', 'deepseek-v4.1-flash', 'unknown-model', 'highway-model', 'max']) assert.equal(canonicalModel(kept), kept, kept);
});

test('a mark comes off only the models of the maker that uses it: gpt-5.1-codex-max and kimi-k2-thinking are models of their own', () => {
  assert.equal(canonicalModel('gpt-5.1-codex-max'), 'gpt-5.1-codex-max');
  assert.equal(canonicalModel('gpt-5.1-codex-max-high'), 'gpt-5.1-codex-max');
  assert.equal(canonicalModel('gpt-5.2-codex-max'), 'gpt-5.2-codex-max');
  assert.equal(canonicalModel('kimi-k2-thinking'), 'kimi-k2-thinking');
  assert.equal(canonicalModel('gemini-4-argon-thinking'), 'gemini-4-argon-thinking');
  assert.equal(canonicalModel('claude-sonnet-4-5-thinking'), 'claude-sonnet-4-5');
  assert.equal(modelLabel('deepseek-v3'), 'deepseek-v3', 'a version at the end of a name is part of it unless the name is a Claude model on Bedrock or Vertex');
  assert.equal(modelLabel('claude-3-5-sonnet-v2@20241022'), 'claude-3-5-sonnet');
  assert.equal(new Pricing().rateFor('gpt-5.1-codex-max', 'codex'), undefined, 'a model the tables do not know stays unpriced rather than borrowing the price of another');
});

test('the dotted, dated and prefixed spellings of a Claude model are the model: one card for Antigravity, Claude Code and Cursor', () => {
  const s = month({
    '2026-11-20': {
      antigravity: { 'claude-opus-4.6': bucket(1, 1e6) },
      claude: { 'claude-opus-4-6-20260115': bucket(1, 1e6), 'claude-sonnet-4-5-20250929': bucket(1, 1e6) },
      cursor: { 'claude-4.6-opus-max-thinking': bucket(1, 1e6), 'claude-4.5-sonnet-thinking': bucket(1, 1e6) },
    },
  });
  const groups = groupModels(s.models);
  assert.deepEqual(groups.map((g) => [g.model, g.sources.join('+'), g.tokens.requests]).sort(), [['claude-opus-4-6', 'antigravity+claude+cursor', 3], ['claude-sonnet-4-5', 'claude+cursor', 2]]);
});

test('a mode of Cursor with a name of its own is counted in its family, in the month and in the day', () => {
  assert.equal(modelFamily('default'), 'composer');
  assert.equal(modelFamily('agent_review'), 'composer');
  assert.equal(modelFamily('claude-4.6-opus-max-thinking'), 'opus');
  const s = month({ '2026-11-20': { cursor: { default: bucket(1, 1e6), 'composer-2.5': bucket(1, 1e6) } } });
  assert.equal(s.tokensByFamily.composer, 2e6);
  assert.equal(s.tokensByFamily.unknown, 0);
  assert.equal(s.days[0].tokensByFamily!.composer, 2e6);
});

test('the page shows the plain name, and the ledger keeps the one the tool wrote', () => {
  assert.equal(modelLabel('claude-4.6-opus-max-thinking'), 'claude-opus-4-6');
  assert.equal(modelLabel('deepseek-flash'), 'deepseek-v4.1-flash', 'the DSH alias still reads as before');
  assert.equal(referenceModel('claude-4.6-opus-max-thinking'), 'claude-opus-4-6');
  assert.equal(referenceModel('Claude-4.5-Sonnet-Thinking'), 'claude-sonnet-4-5');
  assert.equal(referenceModel('default'), 'cursor-auto');
});

test('Cursor is the fifth tool: the ledger holds it, nothing scans it, and the name and colour belong to Cursor', () => {
  assert.deepEqual([...SOURCES], ['antigravity', 'dsh', 'claude', 'codex', 'cursor']);
  assert.deepEqual([...SCANNED_SOURCES], ['antigravity', 'dsh', 'claude', 'codex']);
  assert.equal(SOURCE_LABELS.cursor, 'Cursor');
  assert.deepEqual(SOURCES.map(isScanned), [true, true, true, true, false]);
  const rec: UsageRecord = { id: 'cursor:1', source: 'cursor', day: '2026-11-20', model: 'claude-4.6-opus-high-thinking', tokens: { input: 1, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 0, output: 4 }, session: 'abc123', ts: Date.parse('2026-11-20T10:00:00Z') };
  const { days, sessions } = aggregate({ [rec.id]: rec }, undefined, [], true);
  assert.equal(days['2026-11-20'].cursor!['claude-4.6-opus-high-thinking'].requests, 1, 'the ledger keeps the name the ledger of Cursor gave');
  assert.deepEqual(Object.keys(sessions), ['cursor:abc123']);
});

test('Composer is a family of its own, and so are Cursor\'s Auto and review modes', () => {
  for (const model of ['composer-2.5', 'composer-2-fast', 'cursor-auto', 'cursor-agent-review']) assert.equal(modelFamily(model), 'composer', model);
  assert.equal(modelFamily('claude-opus-4-6'), 'opus');
});

test('every model in the ledger of Cursor is priced from the tables or from your settings', () => {
  const pricing = new Pricing({ 'claude-opus-4*': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 } });
  const unpriced: string[] = [];
  for (const [name] of CURSOR_NAMES) if (!pricing.rateFor(name, 'cursor')) unpriced.push(name);
  assert.deepEqual(unpriced, []);
  const price = (name: string) => { const r = pricing.rateFor(name, 'cursor')!; return [r.input, r.cacheRead, r.output]; };
  assert.deepEqual(price('composer-2.5'), [0.5, 0.2, 2.5]);
  assert.deepEqual(price('composer-2.5-fast'), [3, 0.5, 15], 'the rates of Cursor\'s own page');
  assert.deepEqual(price('gpt-5.5-extra-high-fast'), [10, 1, 60], 'fast runs at twice the rate');
  assert.deepEqual(price('gpt-5.2-codex-xhigh'), [1.75, 0.175, 14]);
  assert.deepEqual(price('claude-4.6-opus-max-thinking'), [5, 0.5, 25], 'your wildcard for claude-opus-4* reaches Cursor\'s spelling of the model');
  assert.equal(pricing.rateFor('claude-4.6-opus-max-thinking', 'cursor')!.overridden, true);
  assert.deepEqual(price('claude-opus-5-5-xhigh'), [4, 0.2, 20], 'the table\'s Claude rows serve Cursor too');
  assert.deepEqual(price('gemini-4-argon-high'), [2, 0.1, 10]);
  assert.deepEqual(price('gemini-4-hydrogen-xhigh'), [1.5, 0.075, 7.5]);
  assert.deepEqual(price('gemini-4-neon-high'), [3, 0.15, 15]);
  assert.deepEqual(price('gemini-4-carbon-high'), [2, 0.1, 10]);
  assert.deepEqual(price('gemini-3.5-flash'), [1.5, 0.15, 9]);
  assert.equal(new Pricing().rateFor('composer-2.5', 'claude'), undefined, 'the Composer rows belong to Cursor, not to every tool');
  const scoped = new Pricing({ 'cursor/gpt-5.5': { output: 31 } });
  assert.equal(scoped.rateFor('gpt-5.5', 'cursor')!.output, 31, 'a rate scoped to Cursor reaches Cursor');
  assert.equal(scoped.rateFor('gpt-5.5-extra-high', 'cursor')!.output, 31, 'under every spelling of the model');
  assert.equal(scoped.rateFor('gpt-5.5', 'codex')!.output, 30, 'and no other tool');
});

const month = (days: Record<string, DayRecord>) => summarize({ days, sessions: {} }, new Pricing({ 'claude-opus-4*': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 } }), NOW);

test('a model that ran in two tools, or under two spellings, is one row with every tool named', () => {
  const s = month({
    '2026-11-20': {
      claude: { 'claude-opus-4-6': bucket(2, 1e6) },
      cursor: { 'claude-4.6-opus-max-thinking': bucket(3, 1e6), 'claude-4.6-opus-high-thinking': bucket(1, 1e6), 'composer-2.5': bucket(1, 1e6) },
      antigravity: { 'claude-opus-4-6-thinking': bucket(1, 1e6) },
    },
  });
  assert.equal(s.models.length, 5, 'the summary keeps a row for each tool and each spelling, which is what the rate picker lists');
  const groups = groupModels(s.models);
  assert.deepEqual(groups.map((g) => g.model), ['claude-opus-4-6', 'composer-2.5']);
  const opus = groups[0];
  assert.deepEqual(opus.sources, ['antigravity', 'claude', 'cursor'], 'in the order the page lists tools');
  assert.deepEqual(opus.names, ['claude-4.6-opus-high-thinking', 'claude-4.6-opus-max-thinking', 'claude-opus-4-6', 'claude-opus-4-6-thinking']);
  assert.equal(opus.tokens.requests, 7);
  assert.ok(Math.abs(opus.cost! - 4 * 25) < 1e-9, 'four million output tokens at $25');
  assert.equal(opus.members.length, 4);
  assert.equal(opus.rate!.output, 25);
  assert.equal(s.recorded.join(), 'antigravity,claude,cursor');
});

test('the cards, the legend and the ring show that one model once, with a capsule for each tool, and the chart adds its days up across tools', () => {
  const days: Record<string, DayRecord> = {
    '2026-11-20': { claude: { 'claude-opus-4-6': bucket(2, 1e6) }, cursor: { 'claude-4.6-opus-max-thinking': bucket(3, 1e6), 'composer-2.5': bucket(1, 1e6) } },
    '2026-11-21': { cursor: { 'claude-4.6-opus-high-thinking': bucket(1, 2e6) } },
  };
  const { document } = parseHTML(renderBody(month(days), cfg));
  const cards = [...document.querySelectorAll('.mcard.model')];
  assert.deepEqual(cards.map((card) => card.querySelector('.name')!.textContent), ['claude-opus-4-6', 'composer-2.5']);
  const opus = cards[0];
  assert.deepEqual([...opus.querySelectorAll('.chips > .chip:not(.share)')].map((chip) => chip.textContent), ['Claude Code', 'Cursor', '6 requests']);
  assert.equal(opus.querySelector('.name')!.getAttribute('title'), 'claude-4.6-opus-high-thinking, claude-4.6-opus-max-thinking, claude-opus-4-6', 'the hover has the names the tools wrote');
  assert.equal(opus.className, 'mcard model f-opus');
  assert.deepEqual([...cards[1].querySelectorAll('.chips > .chip:not(.share)')].map((chip) => chip.textContent), ['Cursor', '1 request']);

  const legend = [...document.querySelectorAll('.pie-cost .pie-legend li')].map((li) => [li.querySelector('.pie-name')!.firstChild!.textContent, li.querySelector('small')!.textContent]);
  assert.deepEqual(legend, [['claude-opus-4-6', 'Claude Code · Cursor'], ['composer-2.5', 'Cursor']]);
  const slices = [...document.querySelectorAll('.pie-cost .slice')].map((slice) => slice.getAttribute('title'));
  assert.deepEqual(slices, ['claude-opus-4-6 (Claude Code, Cursor): $100.00, 98%', 'composer-2.5 (Cursor): $2.50, 2%']);

  const chart = [...document.querySelectorAll('.metric-cost .col')].find((col) => col.getAttribute('data-focus') === 'day-2026-11-20')!;
  assert.match(chart.getAttribute('aria-label')!, /By model: claude-opus-4-6 \$50\.00, composer-2\.5 \$2\.50\./, 'a day adds up the tools of a model');
  assert.equal([...document.querySelectorAll('.metric-cost .by-model .legend-item')].filter((item) => !item.classList.contains('more')).length, 2, 'the chart legend has the model once');
});

test('the popup of a session lists one row for a model that the tool spelled two ways', () => {
  const session = { source: 'cursor' as const, id: 'abc', first: NOW - 1000, last: NOW, days: { '2026-11-20': { 'claude-4.6-opus-max-thinking': bucket(2, 1e6), 'claude-4.6-opus-high-thinking': bucket(1, 1e6), 'composer-2.5': bucket(1, 1e6) } } };
  const detail = buildSessionDetail('cursor:abc', session, new Pricing(), '2026-11');
  assert.deepEqual(detail.models.map((m) => [m.model, m.tokens.requests]), [['claude-opus-4-6', 3], ['composer-2.5', 1]]);
  const html = renderSessionDetail(detail);
  assert.match(html, /Cursor · Claude/);
  assert.match(html, /Cursor keeps no log on this machine, so only the usage totals of this session are available\./);
  assert.equal([...html.matchAll(/claude-opus-4-6/g)].length, 2, 'once in the title hover and once in the name');
});

test('the legend shows four rows and folds the rest under one line that says how many models that is, which opens both legends together', () => {
  const models = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter, i) => [`gemini-${letter}`, bucket(1, (10 - i) * 1e6)]));
  const summary = summarize({ days: { '2026-11-20': { antigravity: models } }, sessions: {} }, new Pricing(Object.fromEntries(Object.keys(models).map((m) => [m, { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 }]))), NOW);
  const html = renderPage(summary, cfg);
  const { document, window } = parseHTML(html);
  for (const mode of ['cost', 'tokens']) {
    const wrap = document.querySelector(`.pie-legend-wrap.pie-${mode}`)!;
    assert.equal(wrap.querySelectorAll(':scope > .pie-legend > li').length, 4, mode);
    const fold = wrap.querySelector('details.pie-more')!;
    assert.equal(fold.getAttribute('data-key'), 'pie-more');
    assert.equal(fold.querySelector('summary')!.textContent, '4 more models', 'six named models and the rest folded into one slice make eight');
    assert.equal(fold.querySelectorAll('li').length, 3, 'two more slices and the slice of the rest');
    assert.equal(fold.hasAttribute('open'), false);
  }
  assert.deepEqual([...document.querySelectorAll('details.pie-more > summary')].map((s) => s.getAttribute('data-focus')), ['pie-more-cost', 'pie-more-tokens'], 'each summary has a focus name of its own');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const posts: unknown[] = [];
  runInNewContext(script, {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver, CSS: { escape: (value: string) => value },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => undefined, postMessage: (m: unknown) => posts.push(m) }),
  });
  assert.ok(script.includes("details[data-key=\"' + CSS.escape(d.dataset.key) + '\"]"), 'opening one fold opens the folds of the same key');
});

test('a small list needs no fold: five rows are all shown, because a fold for one row saves nothing', () => {
  const five = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((letter, i) => [`gemini-${letter}`, bucket(1, (10 - i) * 1e6)]));
  const summary = summarize({ days: { '2026-11-20': { antigravity: five } }, sessions: {} }, new Pricing(Object.fromEntries(Object.keys(five).map((m) => [m, { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 }]))), NOW);
  const { document } = parseHTML(renderBody(summary, cfg));
  assert.equal(document.querySelectorAll('.pie-cost .pie-legend li').length, 5);
  assert.equal(document.querySelector('details.pie-more'), null);
});

test('the ring is thin and its slices are set apart by a hair of space, and a slice too narrow for that is a sliver', () => {
  assert.deepEqual(ringSpan(0, 1, 0.004), [0, 1], 'a ring of one slice has no neighbour to leave room for');
  const [from, to] = ringSpan(0.2, 0.5, 0.004);
  assert.ok(Math.abs(from - 0.202) < 1e-12 && Math.abs(to - 0.498) < 1e-12);
  const [a, b] = ringSpan(0.3, 0.3002, 0.004);
  assert.ok(Math.abs(b - a - 0.004) < 1e-12, 'a model that exists is always drawn');
  assert.ok(a < 0.3001 && b > 0.3001, 'around its middle');
  const { document } = parseHTML(renderBody(month({ '2026-11-20': { claude: { 'claude-opus-4-6': bucket(1, 1e6) }, cursor: { 'composer-2.5': bucket(1, 1e6) } } }), cfg));
  const path = document.querySelector('.pie-cost .slice')!.getAttribute('d')!;
  assert.match(path, / A 46 46 /, 'the outside is as before');
  assert.match(path, / A 39\.5 39\.5 /, 'and the inside is close to it, where it was far');
});
