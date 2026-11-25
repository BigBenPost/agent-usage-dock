import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage, renderSessionDetail, sessionView, type SessionView } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { modelLabel, summarize, type Summary } from '../src/summary';
import { emptyBucket, SOURCES, type DayRecord, type SessionRecord, type TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const bucket = (output: number, over: Partial<TokenBucket> = {}): TokenBucket => ({ ...emptyBucket(), requests: 1, output, ...over });
const cfg = normalizeConfig({ tokenBudgetLimit: 1 });

/** Every character that has ever broken out of markup, in one string. */
const PAYLOAD = '"\'><img src=x onerror=alert(1)></style></script><svg onload=alert(2)>`${7*7}$(error)[x](command:workbench.action.reloadWindow)';
const BIDI = '\u202e';

const KNOWN_TAGS = new Set(['html', 'head', 'meta', 'style', 'body', 'script', 'title', 'div', 'span', 'b', 'i', 'small', 'button', 'select', 'option', 'details', 'summary', 'h1', 'h2', 'h3', 'p', 'ul', 'li', 'a', 'article', 'section', 'header', 'nav', 'dl', 'dt', 'dd',
  'svg', 'path', 'text', 'defs', 'lineargradient', 'stop', 'bdi', 'em', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br']);

const HOSTILE_MODEL = `${PAYLOAD}-model`;
const HOSTILE_SESSION: SessionRecord = { source: 'antigravity', id: PAYLOAD, title: PAYLOAD, project: PAYLOAD, first: NOW, last: NOW + 1000, days: { '2026-10-21': { [HOSTILE_MODEL]: bucket(1e6) } } };
const HOSTILE_INFO = { file: PAYLOAD, title: PAYLOAD, firstPrompt: PAYLOAD, cwd: PAYLOAD, branch: PAYLOAD };

function hostileSummary(): Summary {
  const days: Record<string, DayRecord> = {
    '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6), [HOSTILE_MODEL]: bucket(1e6) }, claude: { [`claude-${PAYLOAD}`]: bucket(5e5) } },
  };
  const rec = HOSTILE_SESSION;
  const attempted = new Date(NOW).toISOString();
  return summarize({
    days,
    sessions: { [`antigravity:${PAYLOAD}`]: rec },
    firstDay: PAYLOAD,
    health: { root: PAYLOAD, attemptedAt: attempted, problems: [PAYLOAD] },
    sourceHealth: { antigravity: { root: PAYLOAD, status: 'incomplete', attemptedAt: attempted, problems: [PAYLOAD] } },
  }, new Pricing({ [HOSTILE_MODEL]: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), NOW);
}

const dom = (html: string) => parseHTML(html).document;

test('the page carries exactly one script, the policy that allows only that script, and nothing that could load anything', () => {
  const html = renderPage(hostileSummary(), cfg);
  const document = dom(html);
  const script = document.querySelectorAll('script');
  assert.equal(script.length, 1);
  const hash = createHash('sha256').update(script[0].textContent!).digest('base64');
  const policies = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  assert.equal(policies.length, 1);
  assert.equal(policies[0].getAttribute('content'), `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; form-action 'none'; base-uri 'none';`);
  const content = policies[0].getAttribute('content')!;
  const directives = new Map(content.split(';').map((part: string) => part.trim()).filter(Boolean).map((part: string) => [part.split(' ')[0], part.split(' ').slice(1)] as const));
  assert.deepEqual([...directives.keys()], ['default-src', 'style-src', 'script-src', 'form-action', 'base-uri']);
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  assert.deepEqual(directives.get('base-uri'), ["'none'"]);
  assert.deepEqual(directives.get('style-src'), ["'unsafe-inline'"]);
  assert.deepEqual(directives.get('script-src'), [`'sha256-${hash}'`]);
  assert.doesNotMatch(content, /\*|https?:|data:|unsafe-eval|blob:/);
  for (const forbidden of ['img', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'link', 'base', 'audio', 'video', 'source', 'canvas', 'foreignobject']) {
    assert.equal(document.querySelectorAll(forbidden).length, 0, forbidden);
  }
  assert.deepEqual([...document.querySelectorAll('[href]')].map((el) => el.getAttribute('href')), ['mailto:xijue.zhang@rakuten.com']);
  assert.equal(document.querySelectorAll('[src], [srcset], [action], [formaction]').length, 0);
});

test('hostile text in every field of the data comes out as text: no new tags, no event attributes, no scripts', () => {
  const s = hostileSummary();
  const detail = renderSessionDetail(buildSessionDetail(`antigravity:${PAYLOAD}`, HOSTILE_SESSION, new Pricing(), '2026-10', HOSTILE_INFO), 'UTC');
  for (const [name, html] of [['page', renderPage(s, cfg)], ['detail', `<html><body>${detail}</body></html>`]] as const) {
    const document = dom(html);
    const tags = new Set([...document.querySelectorAll('*')].map((el) => el.tagName.toLowerCase()));
    assert.deepEqual([...tags].filter((tag) => !KNOWN_TAGS.has(tag)), [], `${name}: an element that nothing in the dashboard writes`);
    const handlers = [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${el.tagName}:${a.name}`)).filter((attribute) => /:on/i.test(attribute));
    assert.deepEqual(handlers, [], `${name}: event attributes`);
    assert.equal(document.querySelectorAll('script').length, name === 'page' ? 1 : 0);
    assert.equal(document.querySelectorAll('img, svg[onload]').length, 0);
  }
});

test('quotes in a model name, a session key or a path stay inside the attribute that holds them', () => {
  const s = hostileSummary();
  const document = dom(renderPage(s, cfg));
  const model = HOSTILE_MODEL;
  assert.ok([...document.querySelectorAll('.mcard .name')].some((el) => el.getAttribute('title') === model), 'the card title is the model name, whole');
  assert.ok([...document.querySelectorAll('.legend-item')].some((el) => el.getAttribute('title') === model), 'the legend title is the model name, whole');
  const card = document.querySelector('.scard')!;
  assert.equal(card.getAttribute('data-key'), `antigravity:${PAYLOAD}`);
  assert.ok(card.querySelector('.scard-main')!.getAttribute('data-focus')!.endsWith(PAYLOAD));
  assert.ok(card.querySelector('.scard-main')!.getAttribute('aria-label')!.startsWith(`${PAYLOAD} · ${PAYLOAD}, `));
  assert.ok(card.querySelector('.scard-main')!.getAttribute('title')!.startsWith(`${PAYLOAD} · ${PAYLOAD}\n`));
  assert.ok([...document.querySelectorAll('.col')].some((el) => el.getAttribute('aria-label')!.includes(modelLabel(model))), 'the column label carries the model name as text');
});

test('esc is what keeps a quote from ending an attribute: the same page with a quote in a title has one attribute, not two', () => {
  const sneaky = { 'x" data-injected="1': bucket(1e6) };
  const document = dom(renderBody(summarize({ days: { '2026-10-21': { antigravity: sneaky } }, sessions: {} }, new Pricing({ 'x" data-injected="1': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), NOW), cfg));
  assert.equal(document.querySelectorAll('[data-injected]').length, 0);
  assert.equal(document.querySelector('.mcard .name')!.getAttribute('title'), 'x" data-injected="1');
  const single = dom(renderBody(summarize({ days: { '2026-10-21': { antigravity: { "x' data-injected='1": bucket(1e6) } } }, sessions: {} }, new Pricing({ "x' data-injected='1": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }), NOW), cfg));
  assert.equal(single.querySelectorAll('[data-injected]').length, 0);
});

test('every interpolation that is not text is allow-listed where it is printed: sort, source, tier, theme and month', () => {
  const s = summarize({ days: { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } }, sessions: { 'antigravity:a': { source: 'antigravity', id: 'a', first: NOW, last: NOW, days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e6) } } } } }, new Pricing(), NOW);
  const evil = '" onclick="alert(1)" x="';
  s.sessions[0].source = evil as never;
  s.models[0].source = evil as never;
  s.models[0].pricingParts = [{ provider: evil, tier: evil as never, tokens: bucket(1) }];
  s.months = [evil, `${evil}-01`, '<img src=x onerror=1>-01', '2026-10'];
  const view = { sort: evil, sources: [evil], page: 0 } as unknown as SessionView;
  const html = renderBody(s, { ...cfg, timeZone: 'UTC' }, view);
  const document = dom(html);
  assert.equal(document.querySelectorAll('[onclick]').length, 0);
  assert.equal(document.querySelector('.slist')!.getAttribute('data-sort'), evil, 'the sort is a value of its attribute, and no more');
  assert.equal(document.querySelector('.scard')!.getAttribute('class'), 'scard unknown');
  assert.equal(document.querySelector('.mcard')!.getAttribute('class'), 'mcard model f-gemini');
  assert.match(document.querySelector('.scard .srow2')!.textContent!, /^Unknown source · /);
  assert.deepEqual([...document.querySelectorAll('[data-menu="month"] [data-month]')].map((o) => [o.getAttribute('data-month'), o.textContent]), [['2026-10', 'October 2026'], ['<img src=x onerror=1>-01', ''], [`${evil}-01`, ''], [evil, '']]);
  const body = renderBody({ ...s, month: evil }, cfg);
  assert.doesNotMatch(body, /onclick="alert/);
  assert.match(dom(renderPage(s, { ...cfg, dashboardTheme: evil as never })).querySelector('body')!.getAttribute('class')!, /^theme-light$/);
  for (const theme of ['light', 'auto', 'dark'] as const) assert.equal(dom(renderPage(s, { ...cfg, dashboardTheme: theme })).querySelector('body')!.getAttribute('class'), `theme-${theme}`);
});

test('a first day that is not a day, or not even a string, prints as text and cannot throw in either place it appears', () => {
  const s = hostileSummary();
  for (const firstDay of [5, { toString: () => '<b>x</b>' }, ['<u>'], null, undefined, true, { toString() { throw new Error('no'); } }]) {
    const body = renderBody({ ...s, firstDay: firstDay as never }, cfg);
    assert.doesNotMatch(body, /<b>x<\/b>|<u>/);
    assert.match(body, /Usage since /);
  }
  assert.match(renderBody({ ...s, firstDay: 5 as never }, cfg), /tracked since 5/);
  assert.match(renderBody({ ...s, firstDay: 0 as never }, cfg), /tracked since 0/);
  assert.match(renderBody({ ...s, firstDay: undefined }, cfg), /Usage since no records yet/);
  assert.doesNotMatch(renderBody({ ...s, firstDay: undefined }, cfg), /tracked since/);
  assert.match(renderBody({ ...s, firstDay: '2026-10-01' }, cfg), /tracked since 2026-10-01/);
});

test('titles, projects, paths, prompts and branches lose their directional controls, and are isolated from the text around them', () => {
  const rec: SessionRecord = { source: 'claude', id: 'b1', title: `normal ${BIDI}title`, project: `proj${BIDI}gpj`, first: NOW, last: NOW + 1000, days: { '2026-10-21': { 'claude-opus-4-6': bucket(1e6) } } };
  const s = summarize({
    days: { '2026-10-21': { claude: { 'claude-opus-4-6': bucket(1e6) } } },
    sessions: { 'claude:b1': rec },
    health: { root: `/store${BIDI}/root`, attemptedAt: new Date(NOW).toISOString(), problems: [`problem ${BIDI}text`] },
    sourceHealth: { claude: { root: `/logs${BIDI}/claude`, status: 'incomplete', attemptedAt: new Date(NOW).toISOString(), problems: [`bad ${BIDI}line`] } },
  }, new Pricing(), NOW);
  const detail = renderSessionDetail(buildSessionDetail('claude:b1', rec, new Pricing(), '2026-10', {
    file: `/home/u/invoice${BIDI}gpj.exe`, title: `Fix ${BIDI}this`, firstPrompt: `prompt ${BIDI}reversed`, cwd: `/home/u/${BIDI}proj`, branch: `fea${BIDI}ture`,
  }), 'UTC');
  const page = renderPage(s, cfg);
  for (const [name, html] of [['page', page], ['detail', detail]] as const) {
    assert.doesNotMatch(html, /[\u202A-\u202E\u2066-\u2069]/, `${name} holds no directional control`);
  }
  const card = dom(page).querySelector('.scard .name')!;
  assert.equal(card.innerHTML, '<bdi>normal title</bdi> · <bdi>projgpj</bdi>');
  const parts = dom(`<html><body>${detail}</body></html>`);
  assert.deepEqual([...parts.querySelectorAll('.facts dd bdi')].map((el) => el.textContent), ['prompt reversed', '/home/u/proj', 'feature', 'b1', '/home/u/invoicegpj.exe']);
  assert.equal(parts.querySelector('.pop-title bdi')!.textContent, 'Fix this');
  assert.ok(parts.querySelector('.facts .mono + button'), 'the Open log button is a sibling of the path, not part of it');
  const health = dom(page);
  assert.deepEqual([...health.querySelectorAll('.diagnostic code bdi')].map((el) => el.textContent), ['/logs/claude']);
  assert.ok([...health.querySelectorAll('.health-issue bdi, .diagnostic li bdi')].every((el) => !/[\u202A-\u202E]/.test(el.textContent!)));
});

test('the sort, the source and the page the dashboard may be asked for are allow-listed and clamped', () => {
  assert.deepEqual(sessionView(undefined), { sort: 'last:desc', sources: [], page: 0 });
  for (const junk of [null, 5, 'x', [], true, () => 1]) assert.deepEqual(sessionView(junk), { sort: 'last:desc', sources: [], page: 0 });

  const offered = [...dom(renderBody(summarize({ days: {}, sessions: { 'claude:a': { source: 'claude', id: 'a', first: NOW, last: NOW, days: { '2026-10-21': { 'claude-opus-4-6': bucket(1) } } } } }, new Pricing(), NOW), cfg)).querySelectorAll('[data-menu="sort"] [data-sort-option]')].map((o) => o.getAttribute('data-sort-option')!);
  assert.equal(offered.length, 12);
  for (const sort of offered) assert.equal(sessionView({ sort }).sort, sort);
  for (const sort of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'cost:sideways', 'COST:DESC', ' cost:desc', 'cost:desc ', 'cost', '', null, 5, {}, ['cost:desc'], 'cost:desc\n']) {
    assert.equal(sessionView({ sort }).sort, 'last:desc', JSON.stringify(sort));
  }

  for (const source of SOURCES) assert.deepEqual(sessionView({ sources: [source] }).sources, [source]);
  assert.deepEqual(sessionView({ sources: ['codex', 'claude', 'codex'] }).sources, ['claude', 'codex'], 'once each, in the order of the tools');
  assert.deepEqual(sessionView({ sources: [...SOURCES].reverse() }).sources, [...SOURCES]);
  for (const sources of ['claude', 'all', 'ALL', 'Claude', '__proto__', 'constructor', 'toString', '', null, 5, {}, [], ['all'], ['ALL', 'Claude'], ['__proto__', 'constructor', 'toString', 'hasOwnProperty'], [null, 5, {}, ['claude']], { 0: 'claude', length: 1 }]) {
    assert.deepEqual(sessionView({ sources }).sources, [], JSON.stringify(sources));
  }
  assert.deepEqual(sessionView({ source: 'claude' }).sources, [], 'the old single value is not read');

  for (const [page, expected] of [[0, 0], [3, 3], [2 ** 53 - 1, 2 ** 53 - 1], [-1, 0], [-1e9, 0], [1.5, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0], ['3', 0], [2 ** 53, 0], [null, 0], [{}, 0], [[2], 0]] as const) {
    assert.equal(sessionView({ page }).page, expected, String(page));
  }
  assert.ok(Object.is(sessionView({ page: -0 }).page, 0) || sessionView({ page: -0 }).page === 0);
});

test('a page number far beyond the list shows the last page, and an unlisted tool shows everything', () => {
  const sessions = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`antigravity:s${i}`, { source: 'antigravity' as const, id: `s${i}`, first: NOW + i, last: NOW + i, days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e5 * (i + 1)) } } }]));
  const s = summarize({ days: { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } }, sessions }, new Pricing(), NOW);
  const document = dom(renderBody(s, cfg, sessionView({ page: 2 ** 53 - 1 })));
  assert.equal(document.querySelectorAll('.scard[data-key]').length, 3);
  assert.equal(document.querySelector('.slist')!.getAttribute('data-page'), '1');
  assert.match(document.querySelector('.session-pages')!.textContent!, /16–18 of 18/);
  assert.equal(dom(renderBody(s, cfg, sessionView({ sources: ['codex'] }))).querySelector('.slist')!.getAttribute('data-sources'), '');
});

interface Fixture { key: string; first: number; last: number; project?: string; tokens: Partial<TokenBucket> }

const FIXTURES: Fixture[] = [
  { key: 'claude:a', first: 100, last: 900, project: 'beta', tokens: { requests: 3, input: 40, cacheRead: 7, cacheWrite: 1, cacheWrite1h: 9, output: 12 } },
  { key: 'claude:b', first: 300, last: 500, project: 'Alpha', tokens: { requests: 9, input: 10, cacheRead: 70, cacheWrite: 5, cacheWrite1h: 2, output: 30 } },
  { key: 'claude:c', first: 200, last: 700, project: 'alpha', tokens: { requests: 1, input: 25, cacheRead: 30, cacheWrite: 8, cacheWrite1h: 4, output: 6 } },
  { key: 'claude:d', first: 500, last: 500, project: undefined, tokens: { requests: 5, input: 60, cacheRead: 3, cacheWrite: 2, cacheWrite1h: 1, output: 20 } },
  { key: 'claude:e', first: 400, last: 800, project: 'Zed', tokens: { requests: 2, input: 5, cacheRead: 1, cacheWrite: 9, cacheWrite1h: 8, output: 5 } },
  { key: 'claude:f', first: 600, last: 500, project: 'zed', tokens: { requests: 4, input: 15, cacheRead: 20, cacheWrite: 3, cacheWrite1h: 7, output: 40 } },
  { key: 'claude:h', first: 450, last: 650, project: 'twin', tokens: { requests: 2, input: 11, cacheRead: 11, cacheWrite: 11, cacheWrite1h: 11, output: 11 } },
  { key: 'claude:g', first: 450, last: 650, project: 'twin', tokens: { requests: 2, input: 11, cacheRead: 11, cacheWrite: 11, cacheWrite1h: 11, output: 11 } },
];

function sortedKeys(sort: string): string[] {
  const days: Record<string, DayRecord> = { '2026-10-21': { claude: {} } };
  const sessions: Record<string, SessionRecord> = {};
  for (const f of FIXTURES) {
    const id = f.key.split(':')[1];
    const full = { ...emptyBucket(), ...f.tokens } as TokenBucket;
    sessions[f.key] = { source: 'claude', id, project: f.project, first: f.first, last: f.last, days: { '2026-10-21': { 'unit-model': full } } };
    const total = days['2026-10-21'].claude!['unit-model'] ?? emptyBucket();
    for (const key of ['requests', 'input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output'] as const) total[key] += full[key];
    days['2026-10-21'].claude!['unit-model'] = total;
  }
  const s = summarize({ days, sessions }, new Pricing({ 'unit-model': { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6, output: 1e6 } }), NOW);
  return [...dom(renderBody(s, cfg, sessionView({ sort }))).querySelectorAll('.scard[data-key]')].map((el) => el.getAttribute('data-key')!);
}

/** The order that the sort control promises: by the named value, then the dearer session, then the key. */
function expectedKeys(sort: string): string[] {
  const [field, direction] = sort.split(':');
  const cost = (f: Fixture): number => (f.tokens.input ?? 0) + (f.tokens.cacheRead ?? 0) + (f.tokens.cacheWrite ?? 0) + (f.tokens.cacheWrite1h ?? 0) + (f.tokens.output ?? 0);
  const value = (f: Fixture): number | string => {
    if (field === 'cost') return cost(f);
    if (field === 'last' || field === 'first') return f[field];
    if (field === 'project') return (f.project ?? '').toLowerCase();
    return f.tokens[field as keyof TokenBucket] ?? 0;
  };
  const sign = direction === 'asc' ? 1 : -1;
  return [...FIXTURES].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    const primary = x < y ? -1 : x > y ? 1 : 0;
    return sign * primary || cost(b) - cost(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }).map((f) => f.key);
}

test('each of the twelve sorts puts the sessions in the order it names, breaking ties by cost and then by key', () => {
  const offered = [...dom(renderBody(summarize({ days: {}, sessions: { 'claude:a': { source: 'claude', id: 'a', first: NOW, last: NOW, days: { '2026-10-21': { 'claude-opus-4-6': bucket(1) } } } } }, new Pricing(), NOW), cfg)).querySelectorAll('[data-menu="sort"] [data-sort-option]')].map((o) => o.getAttribute('data-sort-option')!);
  assert.equal(offered.length, 12);
  for (const sort of offered) assert.deepEqual(sortedKeys(sort), expectedKeys(sort), sort);
  assert.notDeepEqual(sortedKeys('cost:desc'), sortedKeys('cost:asc'));
});

test('sorting leaves the summary\'s own order alone, and a source filter keeps only that source', () => {
  const s = summarize({
    days: { '2026-10-21': { claude: { 'claude-opus-4-6': bucket(2e6) }, codex: { 'gpt-5.5': bucket(1e6) } } },
    sessions: {
      'claude:a': { source: 'claude', id: 'a', first: NOW - 10, last: NOW + 5, days: { '2026-10-21': { 'claude-opus-4-6': bucket(1e6) } } },
      'codex:b': { source: 'codex', id: 'b', first: NOW, last: NOW + 9, days: { '2026-10-21': { 'gpt-5.5': bucket(1e6) } } },
    },
  }, new Pricing(), NOW);
  const before = s.sessions.map((r) => r.key);
  const order = (view: Partial<SessionView>) => [...dom(renderBody(s, cfg, sessionView(view))).querySelectorAll('.scard[data-key]')].map((el) => el.getAttribute('data-key'));
  assert.deepEqual(order({ sort: 'last:desc' }), ['codex:b', 'claude:a']);
  assert.deepEqual(order({ sort: 'first:asc' }), ['claude:a', 'codex:b']);
  assert.deepEqual(order({ sources: ['claude'] }), ['claude:a']);
  assert.deepEqual(order({ sources: ['codex'] }), ['codex:b']);
  assert.deepEqual(order({ sources: ['claude', 'codex'] }), ['codex:b', 'claude:a']);
  assert.deepEqual(s.sessions.map((r) => r.key), before);
});
