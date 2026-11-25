import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderSessionDetail } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { summarize, type Summary } from '../src/summary';
import { emptyBucket, type DayRecord, type SessionRecord, type TokenBucket } from '../src/types';
import { costDrawing } from './costChart';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const bucket = (output: number, over: Partial<TokenBucket> = {}): TokenBucket => ({ ...emptyBucket(), requests: 1, output, ...over });
const attempted = new Date(NOW).toISOString();
const rate = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const rates = { 'm-a': rate, 'm-b': rate, 'm-c': rate };

function month(config: Record<string, unknown> = { tokenBudgetLimit: 50 }, over: { selected?: string; days?: Record<string, DayRecord> } = {}): { summary: Summary; html: string; document: ReturnType<typeof parseHTML>['document'] } {
  const days = over.days ?? Object.fromEntries(['18', '19', '20', '21'].map((d) => [`2026-10-${d}`, { antigravity: { 'm-a': bucket(2e6, { input: 5e5 }), 'm-b': bucket(1e6) }, claude: { 'm-c': bucket(1e6) } }]));
  const sessions: Record<string, SessionRecord> = {
    'antigravity:s1': { source: 'antigravity', id: 's1', title: 'A rather long conversation title that the card has to cut', project: 'my-project', first: NOW - 7_200_000, last: NOW - 3_600_000, days: { '2026-10-21': { 'm-a': bucket(2e6, { input: 1500, cacheRead: 3_000_000, cacheWrite: 40_000 }) } } },
  };
  const summary = summarize({
    days, sessions, firstDay: '2026-10-01',
    health: { root: '/store', attemptedAt: attempted, succeededAt: attempted, problems: [] },
    sourceHealth: { antigravity: { root: '/a', status: 'ok', attemptedAt: attempted, succeededAt: attempted, problems: [] } },
  }, new Pricing(rates), NOW, over.selected);
  const html = renderBody(summary, normalizeConfig(config));
  return { summary, html, document: costDrawing(parseHTML(`<html><body>${html}</body></html>`).document) };
}

const texts = (nodes: Iterable<{ textContent: string | null }>): string[] => [...nodes].map((n) => n.textContent!.trim());

test('the sections of the dashboard are headings, so a screen reader can list and jump between them', () => {
  const { document } = month();
  assert.equal(document.querySelectorAll('h1').length, 1);
  assert.deepEqual(texts(document.querySelectorAll('h2')), ['Token Usage', 'Daily spend (UTC)', 'By model', 'Cost per session', 'Collection status']);
  assert.equal(document.querySelectorAll('div.eyebrow').length, 0, 'no section title is left as a bare div');
  for (const heading of document.querySelectorAll('h1, h2')) assert.ok(heading.textContent!.trim(), 'no empty heading');
  assert.equal(document.querySelector('[data-key="by-model"] > summary h2')!.textContent, 'By model', 'a fold\'s title is its heading');
  assert.equal(document.querySelector('[data-key="collection-status"] > summary h2')!.textContent, 'Collection status');
  assert.deepEqual(texts(month({}, { selected: '2026-09', days: { '2026-09-02': { claude: { 'm-c': bucket(1e6) } } } }).document.querySelectorAll('h2')).slice(0, 2), ['Month Total Tokens', 'Daily spend (UTC)']);
});

test('the popup\'s own sections are headings below its title, and its labels stay plain labels', () => {
  const rec: SessionRecord = { source: 'antigravity', id: 's1', title: 'T', first: NOW, last: NOW + 5000, days: { '2026-10-21': { 'm-a': bucket(1e6) } } };
  const html = renderSessionDetail(buildSessionDetail('antigravity:s1', rec, new Pricing(rates), '2026-10'));
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.deepEqual(texts(document.querySelectorAll('h2')), ['T']);
  assert.deepEqual(texts(document.querySelectorAll('h3')), ['About this session', 'Where the cost went', 'By day (UTC)', 'By model']);
  assert.deepEqual(texts(document.querySelectorAll('.d-grid .eyebrow')), ['Cost, whole session', 'Requests', 'Started', 'Last active']);
  assert.equal(document.querySelectorAll('.d-grid h2, .d-grid h3').length, 0);
});

test('the month total is an image with its exact number as its name, and the budget meter has the ARIA meter attributes it needs', () => {
  const { document } = month();
  const figure = document.querySelector('.hero-figure')!;
  assert.equal(figure.getAttribute('role'), 'img');
  assert.equal(figure.getAttribute('aria-label'), '18,000,000 tokens');
  const meter = document.querySelector('.meter')!;
  assert.equal(meter.getAttribute('role'), 'meter');
  assert.equal(meter.getAttribute('aria-valuemin'), '0');
  assert.equal(meter.getAttribute('aria-valuemax'), '50000000');
  assert.equal(meter.getAttribute('aria-valuenow'), '18000000');
  assert.equal(meter.getAttribute('aria-valuetext'), '18M of 50M');
  assert.equal(meter.getAttribute('aria-label'), 'Token against budget');
  assert.deepEqual([...meter.querySelectorAll('.tick')].map((tick) => tick.getAttribute('aria-hidden')), ['true', 'true']);
  const over = month({ tokenBudgetLimit: 5 }).document.querySelector('.meter')!;
  assert.equal(over.getAttribute('aria-valuenow'), over.getAttribute('aria-valuemax'), 'a value past the budget is held at the top of the range');
  assert.equal(month({}).document.querySelector('.meter'), null, 'no budget, no meter');
  assert.equal(month({ budgetMode: 'cost', budgetLimit: 5 }).document.querySelector('.meter')!.getAttribute('aria-label'), 'Estimated cost against budget');
});

test('a name goes only where ARIA allows one: every labelled element is a control, a landmark or has a role that takes a name', () => {
  const { document } = month({ tokenBudgetLimit: 5 });
  const NAMEABLE_TAGS = new Set(['button', 'select', 'nav', 'a', 'svg']);
  const NAMEABLE_ROLES = new Set(['img', 'meter', 'group', 'dialog']);
  for (const element of document.querySelectorAll('[aria-label]')) {
    const role = element.getAttribute('role');
    assert.ok(NAMEABLE_TAGS.has(element.tagName.toLowerCase()) || (role && NAMEABLE_ROLES.has(role)), `<${element.tagName.toLowerCase()} class="${element.getAttribute('class')}"> has an aria-label and no role to carry it`);
  }
  for (const element of document.querySelectorAll('[role]')) assert.ok(NAMEABLE_ROLES.has(element.getAttribute('role')!), element.getAttribute('role')!);
  for (const control of document.querySelectorAll('button')) assert.ok(control.getAttribute('aria-label') || control.textContent!.trim(), `a button without a name: ${control.outerHTML.slice(0, 80)}`);
  for (const select of document.querySelectorAll('select')) assert.ok(select.getAttribute('aria-label'));
});

test('a day column is an image with a name that holds the day, its total and what it was spent on; the axes and the hover are left out of the tree', () => {
  const { document } = month();
  const label = (day: string) => document.querySelector(`.col[data-focus="day-2026-10-${day}"]`)!.getAttribute('aria-label')!;
  assert.equal(label('21'), '2026-10-21: $4.50. By model: m-a $2.50, m-b $1.00, m-c $1.00. By tool: Antigravity $3.50, Claude Code $1.00.');
  assert.equal(label('03'), '2026-10-03: no usage');
  for (const column of document.querySelectorAll('.col')) {
    assert.equal(column.getAttribute('role'), 'img');
    assert.ok(column.getAttribute('aria-label')!.startsWith(column.getAttribute('data-focus')!.slice(4)));
    assert.equal(column.querySelector('.tip')!.getAttribute('aria-hidden'), 'true');
  }
  const group = document.querySelector('.cols')!;
  assert.equal(group.getAttribute('role'), 'group');
  assert.match(group.getAttribute('aria-label')!, /arrow keys/);
  assert.equal(document.querySelector('.yaxis')!.getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelector('.xaxis')!.getAttribute('aria-hidden'), 'true');
});

test('a day with many models says its biggest six and sums the rest, in its name as in its hover', () => {
  const names = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m-${String.fromCharCode(97 + i)}`, bucket((10 - i) * 1e6)]));
  const many = Object.fromEntries(Object.keys(names).map((m) => [m, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }]));
  const s = summarize({ days: { '2026-10-21': { antigravity: names } }, sessions: {} }, new Pricing(many), NOW);
  const document = parseHTML(`<html><body>${renderBody(s, normalizeConfig({}))}</body></html>`).document;
  const label = document.querySelector('.col[data-focus="day-2026-10-21"]')!.getAttribute('aria-label')!;
  assert.equal(label, '2026-10-21: $55.00. By model: m-a $10.00, m-b $9.00, m-c $8.00, m-d $7.00, m-e $6.00, m-f $5.00, 4 other models $10.00. By tool: Antigravity $55.00.');
});

test('the columns are one tab stop: today when the month is the present one, the busiest day when it is a past one', () => {
  const stops = (html: Iterable<{ getAttribute: (n: string) => string | null }>) => [...html].filter((el) => el.getAttribute('tabindex') === '0').map((el) => el.getAttribute('data-focus'));
  const now = month();
  assert.deepEqual(stops(now.document.querySelectorAll('.col')), ['day-2026-10-21']);
  assert.equal(now.document.querySelectorAll('.col').length, 21);
  assert.equal(now.document.querySelectorAll('.col[tabindex="-1"]').length, 20);
  const past = month({}, { selected: '2026-09', days: { '2026-09-02': { claude: { 'm-c': bucket(1e6) } }, '2026-09-17': { claude: { 'm-c': bucket(5e6) } }, '2026-09-20': { claude: { 'm-c': bucket(2e6) } } } });
  assert.deepEqual(stops(past.document.querySelectorAll('.col')), ['day-2026-09-17']);
  assert.equal(past.document.querySelectorAll('.col').length, 30);
});

test('a session card is named in full, with the exact counts, and shows both on hover and focus through its tooltip', () => {
  const { document } = month();
  const card = document.querySelector('.scard-main')!;
  const title = 'A rather long conversation title that the card has to cut · my-project';
  const exact = 'Input 1,500 · Cache read 3,000,000 · Cache write 40,000 · Cache write 1h 0 · Output 2,000,000';
  assert.equal(card.getAttribute('title'), `${title}\n${exact}`);
  const spoken = card.getAttribute('aria-label')!;
  assert.ok(spoken.startsWith(`${title}, $`));
  assert.ok(spoken.endsWith(`1 request. ${exact}`));
  assert.match(spoken, /, Antigravity, \d\d-\d\d \d\d:\d\d → \d\d:\d\d, 1 request\./);
  assert.equal(card.getAttribute('aria-haspopup'), 'dialog');
  assert.match(card.querySelector('.name')!.textContent!, /^A rather long conversation title that the card has to cut · my-project$/, 'the cut is done by CSS, so the whole title is in the text');
  const unnamed = parseHTML(`<html><body>${renderBody(summarize({ days: { '2026-10-21': { antigravity: { 'm-a': bucket(1e6) } } }, sessions: { 'antigravity:x': { source: 'antigravity', id: 'x', first: NOW, last: NOW, days: { '2026-10-21': { 'm-a': bucket(1e6) } } } } }, new Pricing(rates), NOW), normalizeConfig({}))}</body></html>`).document;
  assert.ok(unnamed.querySelector('.scard-main')!.getAttribute('aria-label')!.startsWith('unknown project, $'));
});

test('the full model id stays on the page even where the card cuts or wraps it', () => {
  const longId = `m-${'x'.repeat(80)}`;
  const s = summarize({ days: { '2026-10-21': { antigravity: { [longId]: bucket(1e6) } } }, sessions: {} }, new Pricing({ [longId]: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), NOW);
  const document = parseHTML(`<html><body>${renderBody(s, normalizeConfig({}))}</body></html>`).document;
  assert.equal(document.querySelector('.mcard .name')!.textContent, longId);
  assert.equal(document.querySelector('.mcard .name')!.getAttribute('title'), longId);
  assert.equal(document.querySelector('.by-model .legend-item .name')!.textContent, longId);
  assert.equal(document.querySelector('.by-model .legend-item')!.getAttribute('title'), longId);
});
