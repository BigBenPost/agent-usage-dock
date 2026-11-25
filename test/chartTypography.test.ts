import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfig } from '../src/configValues';
import { STYLE } from '../src/panelStyle';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { chartSvg } from '../src/tooltip';
import { emptyBucket } from '../src/types';
import { parseCss } from './cssColors';

const rules = parseCss(STYLE);
const declared = (selector: string, property: string): string | undefined => {
  for (const rule of rules) if (rule.selectors.includes(selector) && rule.declarations[property] !== undefined) return rule.declarations[property];
};

test('the page takes its typeface from the editor once; only paths and ids use the editor font', () => {
  const families = rules.filter((rule) => rule.declarations['font-family'] !== undefined);
  assert.deepEqual(families.map((rule) => rule.selectors.join(', ')).sort(), ['.mono', 'body']);
  assert.match(declared('body', 'font-family')!, /^var\(--vscode-font-family/);
});

test('the numbers in the charts and cards are set in that typeface, not in a code font', () => {
  assert.equal(declared('.tok5 b', 'font-family'), undefined);
  for (const selector of ['.yaxis span', '.xaxis', '.peak', '.pie-total', '.tok5']) assert.equal(declared(selector, 'font-variant-numeric'), 'tabular-nums', selector);
});

test('the figure in the ring is light like the other figures, and the emphasis in the charts is semibold at most', () => {
  assert.equal(declared('.pie-total', 'font-weight'), '300');
  assert.equal(declared('.pie-total', 'text-rendering'), 'geometricPrecision');
  assert.equal(declared('.xaxis .today', 'font-weight'), '600');
  assert.equal(declared('.tip-r b', 'font-weight'), '600');
  const heavy = rules.filter((rule) => ['700', '800', '900', 'bold', 'bolder'].includes(rule.declarations['font-weight'] ?? ''));
  assert.deepEqual(heavy.map((rule) => rule.selectors.join(', ')), []);
});

test('the chart in the status bar hover uses the page typeface rather than a display face of its own', () => {
  const day = { antigravity: { 'gemini-1.5-flash': { ...emptyBucket(), requests: 1, output: 1e6 } } };
  const svg = chartSvg(summarize({ days: { '2026-10-20': day }, firstDay: '2026-10-01' }, new Pricing(), Date.parse('2026-10-21T12:00:00Z')), normalizeConfig({}), false);
  const family = svg.match(/<svg [^>]*font-family="([^"]+)"/)![1];
  assert.match(family, /^-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui/);
  assert.doesNotMatch(family, /SF Pro Display/);
  assert.match(svg, /text-rendering="geometricPrecision"/);
});
