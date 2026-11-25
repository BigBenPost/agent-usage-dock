import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';

const cfg = normalizeConfig({});
const now = Date.parse('2026-11-22T08:00:00Z');
const summary = () => summarize({ days: { '2026-11-22': { antigravity: { 'gemini-1.5-flash': { requests: 2, input: 100, cacheRead: 200, cacheWrite: 50, cacheWrite1h: 25, output: 25 } } } }, sessions: {} }, new Pricing(), now);

test('hero card displays token figure and statistics grid', () => {
  const { document } = parseHTML(renderBody(summary(), cfg));
  const hero = document.querySelector('.hero')!;
  assert.match(hero.querySelector('.hero-figure')!.getAttribute('aria-label')!, /400 tokens/);
  assert.equal(hero.querySelector('.hero-today b')!.textContent, '400');
  assert.match(hero.querySelector('.stats')!.textContent!, /TODAY[\s\S]*REQUESTS[\s\S]*CONVERSATIONS/);
  assert.doesNotMatch(hero.querySelector('.stats')!.textContent!, /COST/);
  assert.match(hero.querySelector('.hero-ring .pie-cost .pie-total')!.textContent!, /^\$/, 'the cost is the centre of the ring');
});

test('Daily spend is the only dashboard daily chart and token totals remain in the hero', () => {
  const s = summary();
  s.unpriced = ['unknown-model'];
  const { document } = parseHTML(renderBody(s, cfg));
  assert.equal(document.querySelector('[data-key="by-day"]'), null);
  assert.equal(document.querySelectorAll('.gchart').length, 1, 'one card for the daily chart');
  assert.equal(document.querySelectorAll('.chart').length, 2, 'drawn in cost and in tokens, one of which shows');
  assert.equal(document.querySelectorAll('.gchart .metric-cost .col').length, 22);
  assert.equal(document.querySelector('.hero-figure')!.getAttribute('aria-label'), '400 tokens');
  assert.equal(document.querySelector('.xaxis .today')!.textContent, '22');
});

test('empty and historical months have honest empty states and no Today summary', () => {
  const s = summarize({ days: {}, sessions: {} }, new Pricing(), now, '2026-10');
  const { document } = parseHTML(renderBody(s, cfg));
  assert.equal(document.querySelector('.hero-today'), null);
  assert.match(document.querySelector('.gchart')!.textContent!, /No usage recorded in October 2026/);
  assert.equal(document.querySelector('.chart'), null);
});

test('collection is closed by default but exposes deduplicated problems in its summary', () => {
  const s = summary();
  const problem = '<script>bad</script> & unreadable';
  s.health = { root: '/private/store', attemptedAt: new Date(now).toISOString(), problems: [problem] };
  s.sourceHealth = { dsh: { root: '/private/dsh', status: 'incomplete', attemptedAt: new Date(now).toISOString(), problems: [problem] } };
  const { document } = parseHTML(renderBody(s, cfg));
  const card = document.querySelector('[data-key="collection-status"]')!;
  assert.equal(card.hasAttribute('open'), false);
  assert.match(card.querySelector('summary')!.textContent!, /Needs attention · 1 issue/);
  assert.doesNotMatch(card.querySelector('summary')!.textContent!, /private/);
  assert.equal(card.querySelector('script'), null);
  assert.match(card.querySelector('.diagnostic ul')!.textContent!, /<script>bad<\/script> & unreadable/);
  assert.match(card.textContent!, /2026-11-22 08:00:00 UTC/);
});

test('disabled and absent sources do not make successful collection appear incomplete', () => {
  const s = summary();
  const attemptedAt = new Date(now).toISOString();
  s.sourceHealth = {
    antigravity: { root: '/logs', status: 'ok', attemptedAt, succeededAt: attemptedAt, problems: [] },
    dsh: { root: '/dsh', status: 'disabled', attemptedAt, problems: [] },
    claude: { root: '/claude', status: 'not-found', attemptedAt, problems: [] },
  };
  const { document } = parseHTML(renderBody(s, cfg));
  const headline = document.querySelector('[data-key="collection-status"] > summary')!.textContent!;
  for (const expected of [/AntigravityReady/, /DSHDisabled/, /Claude CodeNot installed/, /CodexNot scanned/, /CursorNo data/]) assert.match(headline, expected);
  assert.doesNotMatch(headline, /Needs attention/);
  assert.match(document.querySelector('.source-health .health-facts')!.textContent!, /2026-11-22 08:00:00 UTC/);
  assert.equal(document.querySelectorAll('.source-health').length, 5);
  assert.match(document.querySelectorAll('.source-health')[2].textContent!, /Claude CodeNot installed/);
});
