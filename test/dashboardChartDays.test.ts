import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { emptyBucket, type DayRecord, type TokenBucket } from '../src/types';
import { costDrawing } from './costChart';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const rate = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const pricing = new Pricing({ 'unit-model': rate });
const usage = (cost: number): DayRecord => ({ antigravity: { 'unit-model': bucket(cost * 1e6) } });

function chart(days: Record<string, DayRecord>, config: Partial<Config> | Record<string, unknown> = {}, selected?: string, now = NOW) {
  const html = renderBody(summarize({ days, sessions: {} }, pricing, now, selected), normalizeConfig(config as Record<string, unknown>));
  return costDrawing(parseHTML(`<html><body>${html}</body></html>`).document);
}

const tabStop = (document: ReturnType<typeof chart>) => document.querySelector('.col[tabindex="0"]')!.getAttribute('data-focus');

test('usage dated after today is drawn on its own day, with a note that says so, instead of stretching the axis in silence', () => {
  const document = chart({ '2026-10-21': usage(2), '2026-10-25': usage(18) });
  const columns = document.querySelectorAll('.col');
  assert.equal(columns.length, 25, 'the chart runs to the last day with usage');
  assert.equal(document.querySelector('.chart')!.getAttribute('style'), '--cols:25');
  const later = document.querySelector('.col[data-focus="day-2026-10-25"]')!;
  assert.equal(later.getAttribute('aria-label')!.split('. ')[0], '2026-10-25 (after today): $18.00');
  assert.match(later.querySelector('.tip-h')!.textContent!, /^2026-10-25 · after today$/);
  assert.ok(Number(later.querySelector('.stack')!.getAttribute('style')!.match(/height:([\d.]+)%/)![1]) > 80, 'the bar is as tall as the scale says');
  assert.match(document.querySelector('.chart-foot .note')!.textContent!, /^Usage is dated after today on 1 day and drawn on its date\./);
  assert.equal(document.querySelector('.col[data-focus="day-2026-10-22"]')!.getAttribute('aria-label'), '2026-10-22 (after today): no usage');
  assert.equal(tabStop(document), 'day-2026-10-21', 'the way in is still today');
  assert.equal(document.querySelector('.xaxis')!.children.length, 25);
});

test('two days after today are counted, and the end of the month is reachable', () => {
  const document = chart({ '2026-10-21': usage(1), '2026-10-27': usage(1), '2026-10-31': usage(1) });
  assert.equal(document.querySelectorAll('.col').length, 31);
  assert.match(document.querySelector('.chart-foot .note')!.textContent!, /on 2 days and drawn/);
});

test('without usage after today the chart ends today and carries no note', () => {
  const document = chart({ '2026-10-19': usage(1), '2026-10-21': usage(2) });
  assert.equal(document.querySelectorAll('.col').length, 21);
  assert.equal(document.querySelector('.chart-foot .note'), null);
  assert.ok(![...document.querySelectorAll('.col')].some((c) => c.getAttribute('aria-label')!.includes('after today')));
});

test('a day after today that has usage but no price is not drawn, since it has no bar to draw', () => {
  const document = chart({ '2026-10-21': usage(1), '2026-10-24': { antigravity: { 'priceless-model': bucket(1e6) } } });
  assert.equal(document.querySelectorAll('.col').length, 21);
  assert.equal(document.querySelector('.chart-foot .note'), null);
});

test('a past month is whole, has no "after today", and its way in is its busiest day', () => {
  const document = chart({ '2026-09-02': usage(1), '2026-09-17': usage(9), '2026-09-30': usage(2) }, {}, '2026-09');
  assert.equal(document.querySelectorAll('.col').length, 30);
  assert.equal(document.querySelector('.chart-foot .note'), null);
  assert.ok(![...document.querySelectorAll('.col')].some((c) => c.getAttribute('aria-label')!.includes('after today')));
  assert.equal(tabStop(document), 'day-2026-09-17');
});

test('a month with few days elapsed still centres each hover on its wide column, and still draws a day after today', () => {
  const early = Date.parse('2026-10-03T10:00:00Z');
  const document = chart({ '2026-10-02': usage(1), '2026-10-06': usage(3) }, {}, undefined, early);
  assert.equal(document.querySelectorAll('.col').length, 6);
  assert.ok([...document.querySelectorAll('.tip')].every((tip) => tip.classList.contains('center')));
});

const costMode = (over: Record<string, unknown> = {}) => ({ budgetMode: 'cost', budgetLimit: 31, ...over });
const days = { '2026-10-20': usage(2), '2026-10-21': usage(4) };

test('in cost mode the even pace is the dollar budget over the days of the month, drawn on the dollar axis and named in the legend', () => {
  const document = chart(days, costMode());
  const pace = document.querySelector('.pace')!;
  assert.ok(pace, 'the pace line is drawn');
  const bottom = Number(pace.getAttribute('style')!.match(/bottom:([\d.]+)%/)![1]);
  assert.ok(Math.abs(bottom - (1 / 5) * 100) < 0.01, `a dollar a day on a $5 scale is 20% up, not ${bottom}%`);
  const legend = document.querySelector('.legend')!.textContent!;
  assert.match(legend, /Even pace \$1\.00 a day2 days above/);
});

test('in token mode there is no dollar pace, even with a dollar budget left over in the settings', () => {
  for (const config of [{ budgetLimit: 31 }, { budgetLimit: 31, tokenBudgetLimit: 5 }, { budgetMode: 'tokens', budgetLimit: 31 }]) {
    const document = chart(days, config);
    assert.equal(document.querySelector('.pace'), null, JSON.stringify(config));
    assert.doesNotMatch(document.querySelector('.legend')!.textContent!, /Even pace/, JSON.stringify(config));
  }
});

test('in cost mode without a dollar budget there is no pace either, whatever the token budget says', () => {
  for (const config of [costMode({ budgetLimit: 0 }), costMode({ budgetLimit: 0, tokenBudgetLimit: 5 }), { budgetMode: 'cost' }]) {
    const document = chart(days, config);
    assert.equal(document.querySelector('.pace'), null, JSON.stringify(config));
    assert.doesNotMatch(document.querySelector('.legend')!.textContent!, /Even pace/);
  }
});

test('a pace above the scale is named and marked off the scale, and not drawn', () => {
  const document = chart(days, costMode({ budgetLimit: 31 * 100 }));
  assert.equal(document.querySelector('.pace'), null);
  assert.match(document.querySelector('.legend')!.textContent!, /Even pace \$100\.00 a day0 days above \(off the scale\)/);
});
