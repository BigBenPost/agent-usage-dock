import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as vm from 'node:vm';
import type { Config } from '../src/config';
import { renderBody, renderPage, renderSessionDetail, renderSessionError, renderSessionMissing } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { StoreData } from '../src/store';
import { summarize } from '../src/summary';
import { emptyBucket, SessionRecord, TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg: Config = { dashboardTheme: 'light', timeZone: 'UTC', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', budgetLimit: 100, warningThreshold: 0.75, criticalThreshold: 0.9, pollIntervalSeconds: 60, correctionFactor: 1, rates: {} };

const bucket = (output: number, over: Partial<TokenBucket> = {}): TokenBucket => ({ ...emptyBucket(), requests: 1, output, ...over });

function session(id: string, project: string, output: number, day = '2026-10-21'): SessionRecord {
  const first = Date.parse(`${day}T09:00:00Z`);
  return { source: 'antigravity', id, project, first, last: first + 3_600_000, days: { [day]: { 'gemini-1.5-flash': bucket(output) } } };
}

function data(sessions?: Record<string, SessionRecord>): Pick<StoreData, 'days' | 'sessions' | 'firstDay'> {
  return {
    days: { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } },
    sessions,
    firstDay: '2026-10-21',
  };
}

const body = (d: ReturnType<typeof data>, over: Partial<Config> = {}): string => renderBody(summarize(d, new Pricing(), NOW), { ...cfg, ...over });

test('the page lists sessions with their cost and escapes names from the logs', () => {
  const html = body(data({ 'antigravity:s1': session('s1-abcdef', '<img src=x onerror=alert(1)>', 1e6) }));
  assert.match(html, /Cost per session/);
  assert.match(html, /data-key="antigravity:s1"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&#60;img src=x/);
});

test('the header names the dashboard and offers a contact email, with a mailto link', () => {
  const html = body(data());
  assert.match(html, /<h1><svg class="brand" role="img" aria-label="Google Gemini"[^>]*>.*<\/svg><span class="usage">agent-usage-dock<\/span><\/h1>/s);
  assert.match(html, /Have a problem\? Contact <a href="mailto:zhang\.xijue@u\.nus\.edu"[^>]*>zhang\.xijue@u\.nus\.edu<\/a>/);
});

test('each session card shows all five token counts with their exact values, and a totals card sums them', () => {
  const rec = session('s1', 'proj', 2000);
  rec.days['2026-10-21']['gemini-1.5-flash'] = bucket(2000, { input: 1500, cacheRead: 3_000_000, cacheWrite: 40_000, cacheWrite1h: 0 });
  const html = body(data({ 'antigravity:s1': rec }));
  const card = html.match(/<article class="scard antigravity"[\s\S]*?<\/article>/)?.[0] ?? '';
  for (const label of ['Input', 'Cache read', 'Cache write', 'Cache write 1h', 'Output']) assert.match(card, new RegExp(`class="t" title="${label}: [\\d,]+"`));
  assert.match(card, /<b>1\.5k<\/b><small>In<\/small>/);
  assert.match(card, /<b>3\.00M<\/b><small>C\.read<\/small>/);
  assert.match(card, /aria-label="[^"]*Input 1,500 · Cache read 3,000,000 · Cache write 40,000 · Cache write 1h 0 · Output 2,000"/);
  assert.match(html, /<div class="scard total">[\s\S]*All · 1 session[\s\S]*3\.00M/);
  assert.deepEqual([...card.matchAll(/ (data-[\w-]+)=/g)].map((m) => m[1]).filter((name) => name !== 'data-focus'), ['data-key'], 'a card carries its key and nothing the page does not read');
});

test('one control sorts the sessions, and it covers time, cost and every token type', () => {
  const html = body(data({ 'claude:s1': session('s1', 'proj', 1e6) }));
  assert.doesNotMatch(html, /data-sort-preset|Quick sort/);
  assert.equal(html.match(/data-menu="sort"/g)?.length, 1);
  assert.equal(html.match(/data-menu-toggle="sort"/g)?.length, 1);
  for (const v of ['cost:desc', 'last:desc', 'first:asc', 'first:desc', 'requests:desc', 'input:desc', 'cacheRead:desc', 'cacheWrite:desc', 'cacheWrite1h:desc', 'output:desc', 'project:asc']) {
    assert.match(html, new RegExp(`data-sort-option="${v}"`));
  }
});

test('the page starts on the most recent sessions first, and the sort control says so', () => {
  const html = renderPage(summarize(data({ 'claude:s1': session('s1', 'proj', 1e6) }), new Pricing(), NOW), cfg);
  assert.match(html, /var state = \{ sortKey: 'last', sortDir: 'desc'/);
  assert.match(html, /data-menu-toggle="sort"[^>]*><span class="multi-label">Most recent activity<\/span>/);
  assert.match(html, /data-sort-option="last:desc"[^>]*aria-pressed="true"><span class="menu-check" aria-hidden="true"><\/span><span>Most recent activity<\/span>/);
});

test('a card shows its time range, and both dates when it crosses midnight', () => {
  const rec = session('s1', 'proj', 1e6);
  assert.match(body(data({ 'antigravity:s1': rec })), /10-21 09:00 → 10:00 · 1 req/);
  rec.last = Date.parse('2026-10-22T01:30:00Z');
  assert.match(body(data({ 'antigravity:s1': rec })), /10-21 09:00 → 10-22 01:30/);
});

test('only the active page of session cards is rendered', () => {
  const sessions = Object.fromEntries(Array.from({ length: 18 }, (_, i) => ['antigravity:s' + i, session('s' + i, 'p', 1e5 * (i + 1))]));
  const summary = summarize(data(sessions), new Pricing(), NOW);
  const first = renderBody(summary, cfg);
  const second = renderBody(summary, cfg, { sort: 'last:desc', sources: [], page: 1 });
  assert.equal(first.match(/<article class="scard antigravity"/g)?.length, 15);
  assert.equal(second.match(/<article class="scard antigravity"/g)?.length, 3);
  assert.match(first, /1–15 of 18/);
  assert.match(second, /16–18 of 18/);
  assert.match(second, /data-focus="sessions-next" data-page="2" disabled/);
  assert.doesNotMatch(body(data({ 'claude:s1': session('s1', 'p', 1) })), /class="session-pages"/);
});

test('the page says so while sessions are still being built, and when there are none', () => {
  assert.match(body(data(undefined)), /Building session history/);
  assert.match(body(data({})), /No sessions recorded this month yet/);
});

test('hero card shows hero figure and stats', () => {
  const d = data({});
  assert.match(body(d), /hero-figure/);
  assert.match(body(d), /class="stats"/);
});

test('the page applies the configured theme, defaults to light, and its script allows nothing else', () => {
  const page = (theme: Config['dashboardTheme']) => renderPage(summarize(data({}), new Pricing(), NOW), { ...cfg, dashboardTheme: theme });
  assert.match(page('light'), /<body class="theme-light">/);
  assert.match(page('dark'), /<body class="theme-dark">/);
  assert.match(page('auto'), /<body class="theme-auto">/);
  const html = page('light');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.doesNotThrow(() => new vm.Script(script), 'the page script must be valid JavaScript');
  assert.match(html, /<div id="app" tabindex="-1">/);
  assert.doesNotMatch(html, /id="drawer"/);
});

test('Mist (light) and Noir (dark) give each tool the colour of its model family: Claude Code orange, Codex the GPT lavender grey, DSH DeepSeek blue, Cursor the teal of Composer', () => {
  const html = renderPage(summarize(data({}), new Pricing(), NOW), cfg);
  assert.match(html, /--opus: #d4683a;[^}]*--antigravity: var\(--gemini\); --dsh: var\(--deepseek\); --claude: var\(--opus\); --codex: var\(--gpt\); --cursor: var\(--composer\); --accent: #141820;/);
  assert.match(html, /--opus: #ff8a5c;[^}]*--antigravity: var\(--gemini\); --dsh: var\(--deepseek\); --claude: var\(--opus\); --codex: var\(--gpt\); --cursor: var\(--composer\); --accent: #c4b5ff;/);
  assert.match(html, /--composer: #2f8f83;/);
  assert.match(html, /--composer: #5cc6b6;/);
  assert.match(html, /--gpt: #7f79a1; --deepseek: #4d6bfe;/);
  assert.match(html, /--gpt: #b0a9c9; --deepseek: #6580ff;/);
  assert.match(html, /\.meter \.fill \{[^}]*var\(--accent\)/);
});

test('the month total sets its cents small and keeps the full amount for screen readers', () => {
  const html = body(data());
  assert.match(html, /<div class="hero-figure" role="img" aria-label="[\d,]+ tokens"><span class="int">\d+<\/span><span class="cents">\.\d\d[MBk]<\/span><\/div>/);
});

test('the hero card displays Token Usage with heroTokenFigure and stats grid', () => {
  const html = body(data());
  assert.match(html, /<h2 class="eyebrow">Token Usage<\/h2>/);
  assert.match(html, /class="card-meta">1 request/);
  assert.match(html, /class="stats"[\s\S]*CONVERSATIONS/);
});

test('an empty month renders without a chart', () => {
  const html = renderBody(summarize({ days: {}, sessions: {} }, new Pricing(), NOW), cfg);
  assert.match(html, /No usage recorded this month yet/);
});

const sessionDetail = (info?: Parameters<typeof buildSessionDetail>[4]) => {
  const rec = session('abc-123', 'my-project', 1e6);
  rec.days['2026-10-21']['gemini-1.5-flash'] = bucket(1e6, { input: 1e6, cacheRead: 1e6 });
  return buildSessionDetail('antigravity:abc-123', rec, new Pricing(), '2026-10', info);
};

test('the session popup shows what the log says, escaped, with the cost split by token type', () => {
  const html = renderSessionDetail(
    sessionDetail({ file: '/logs/abc-123.jsonl', title: 'Fix <b>the</b> sort', firstPrompt: 'Please <script>x</script> help', cwd: '/work/my-project', branch: 'main' }),
  );
  assert.match(html, /<h2 class="pop-title"><bdi>Fix &#60;b&#62;the&#60;\/b&#62; sort<\/bdi><\/h2>/);
  assert.match(html, /<div class="sub"><bdi>my-project<\/bdi><\/div>/);
  assert.match(html, /Please &#60;script&#62;x&#60;\/script&#62; help/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /\/work\/my-project/);
  assert.match(html, /data-action="open-log"/);
  assert.match(html, /abc-123/);
  for (const label of ['Input', 'Cache read', 'Cache write', 'Cache write 1h', 'Output']) assert.match(html, new RegExp(`<span class="p-label">${label}</span>`));
  assert.match(html, /<button type="button" class="icon-btn" data-action="close"/);
});

test('the session popup explains when the log is gone, and a missing session says so', () => {
  const html = renderSessionDetail(sessionDetail(undefined));
  assert.match(html, /no longer on disk/);
  assert.doesNotMatch(html, /data-action="open-log"/);
  assert.match(html, /abc-123/);
  assert.match(renderSessionMissing(), /Session not found[\s\S]*data-action="close"[\s\S]*not in the usage store any more/);
  assert.match(renderSessionError(), /Could not load this session[\s\S]*data-action="close"/);
});

test('the hero card displays the three-metric statistics grid, with the cost in the ring', () => {
  const html = body(data({}));
  assert.match(html, /class="card-meta">1 request/);
  assert.match(html, /<dl class="stats">/);
  assert.match(html, /<dt>TODAY<\/dt>/);
  assert.doesNotMatch(html, /<dt>COST<\/dt>/);
  assert.match(html, /<dt>REQUESTS<\/dt>/);
  assert.match(html, /<dt>CONVERSATIONS<\/dt>/);
  assert.match(html, /<text class="pie-total"[^>]*>\$[\d.,]+<\/text><text class="pie-unit"[^>]*>est\. cost<\/text>/);
});

test('the hero card displays token usage figure and eyebrow', () => {
  const html = body(data({}));
  assert.match(html, /<h2 class="eyebrow">Token Usage<\/h2>/);
  assert.match(html, /class="hero-figure"/);
});

test('By model comes before Cost per session', () => {
  const html = body(data({ 'claude:s1': session('s1', 'p', 1e6) }));
  const model = html.indexOf('data-key="by-model"');
  const sessions = html.indexOf('Cost per session');
  const health = html.indexOf('data-key="collection-status"');
  assert.ok(model > 0 && sessions > model && health > sessions);
});

test('By model is a set of cards with five token tiles each, and the layout pairs the month card with the chart', () => {
  const html = body(data({}));
  assert.match(html, /<div class="pair"><section class="card hero">[\s\S]*Daily spend/);
  const model = html.match(/<article class="mcard model f-gemini">[\s\S]*?<\/article>/)?.[0] ?? '';
  assert.match(model, /gemini-1.5-flash/);
  assert.match(model, /1 request</);
  assert.equal(model.match(/class="tiles"/g)?.length, 1);
  assert.equal(model.match(/class="tile"/g)?.length, 1, 'the one kind of token the model used');
  assert.equal(model.match(/class="tile off"/g)?.length, 4, 'and a dash for each of the four it did not');
  assert.doesNotMatch(html, /<table class="sessions"/);
});

test('two columns of cards from 900px, and opening a card moves nothing: it shows in a popup', () => {
  const html = renderPage(summarize(data({}), new Pricing(), NOW), cfg);
  assert.match(html, /@media \(min-width: 900px\) \{ \.slist, \.mgrid \{ grid-template-columns: repeat\(2,/);
  assert.doesNotMatch(html, /\.scard\.open \{[^}]*grid-column/);
  assert.doesNotMatch(html, /sdetail/);
  assert.match(html, /<div id="popup" hidden><div id="pop-card" class="pop-card" tabindex="-1" role="dialog" aria-modal="true"/);
  assert.match(html, /<div id="scrim" hidden><\/div>/);
  assert.match(html, /#popup \{ position: fixed; inset: 0;/);
  assert.match(html, /@media \(min-width: 1000px\) \{ \.pair \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});

test('token values carry their exact number on hover, because narrow cards truncate them', () => {
  const rec = session('s1', 'proj', 2000);
  rec.days['2026-10-21']['gemini-1.5-flash'] = bucket(2000, { cacheRead: 107_410_000 });
  const html = body(data({ 'antigravity:s1': rec }));
  assert.match(html, /title="Cache read: 107,410,000"><b>107\.41M<\/b>/);
});

test('with only a few days of data the chart tooltip is centred on its wide column instead of hanging outside the card', () => {
  const early = renderBody(summarize({ days: { '2026-10-02': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } }, sessions: {} }, new Pricing(), Date.parse('2026-10-03T10:00:00Z')), cfg);
  assert.match(early, /class="tip center"/);
  assert.doesNotMatch(early, /class="tip left-of"/);
  assert.match(body(data({})), /class="tip left-of"/);
});

test('a drag that starts inside the popup and ends outside does not close it, and a stray correction factor is escaped', () => {
  const page = renderPage(summarize(data({}), new Pricing(), NOW), cfg);
  assert.match(page, /downTarget === t/);
  const odd = summarize(data({}), new Pricing({}, '<b>x</b>' as unknown as number), NOW);
  assert.doesNotMatch(renderBody(odd, cfg), /<b>x<\/b>/);
});
