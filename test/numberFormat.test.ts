import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heroTokenFigure } from '../src/panelHtml';
import { formatTokens, formatTokensCompact, scaleTokens, splitCompactTokens } from '../src/summary';

test('the compact format carries into the next unit instead of printing 1000k or 1000M', () => {
  const table: [number, string][] = [
    [0, '0'], [1, '1'], [999, '999'], [999.4, '999'], [999.5, '1k'], [1000, '1k'], [1499, '1k'], [1500, '2k'], [712_252, '712k'],
    [999_499, '999k'], [999_500, '1M'], [999_999, '1M'], [1_000_000, '1M'], [1_049_999, '1M'], [1_050_000, '1.1M'], [47_929_525, '47.9M'],
    [99_950_000, '100M'], [999_949_999, '999.9M'], [999_950_000, '1B'], [999_999_999, '1B'], [1e9, '1B'], [1_500_000_000, '1.5B'], [12_340_000_000, '12.3B'],
    [-5, '0'], [NaN, '0'], [Infinity, '0'], [-Infinity, '0'],
  ];
  for (const [n, expected] of table) assert.equal(formatTokensCompact(n), expected, String(n));
});

test('the card format carries too, and has a unit for billions', () => {
  const table: [number, string][] = [
    [0, '0'], [999, '999'], [1000, '1.0k'], [1500, '1.5k'], [999_949, '999.9k'], [999_950, '1.00M'], [999_999, '1.00M'], [1e6, '1.00M'],
    [1_234_567, '1.23M'], [107_410_000, '107.41M'], [999_994_999, '999.99M'], [999_995_000, '1.00B'], [999_999_999, '1.00B'], [1e9, '1.00B'], [12_345_678_901, '12.35B'],
  ];
  for (const [n, expected] of table) assert.equal(formatTokens(n), expected, String(n));
});

test('the hero split carries the same way, and keeps its decimal for the small unit', () => {
  assert.deepEqual(splitCompactTokens(999_500), { whole: '1', fraction: '.0M' });
  assert.deepEqual(splitCompactTokens(999_999_999), { whole: '1', fraction: '.0B' });
  assert.deepEqual(splitCompactTokens(1e9), { whole: '1', fraction: '.0B' });
  assert.deepEqual(splitCompactTokens(1_500_000_000), { whole: '1', fraction: '.5B' });
  assert.deepEqual(splitCompactTokens(47_929_525), { whole: '47', fraction: '.9M' });
  assert.deepEqual(splitCompactTokens(712_252), { whole: '712', fraction: 'k' });
  assert.deepEqual(splitCompactTokens(999.6), { whole: '1', fraction: 'k' });
  assert.deepEqual(splitCompactTokens(500), { whole: '500', fraction: '' });
  assert.deepEqual(splitCompactTokens(0), { whole: '0', fraction: '' });
  assert.deepEqual(splitCompactTokens(NaN), { whole: '0', fraction: '' });
});

const figure = (tokens: number): { whole: string; cents: string; label: string } => {
  const html = heroTokenFigure(tokens);
  return { whole: html.match(/class="int">([^<]*)</)![1], cents: html.match(/class="cents">([^<]*)</)![1], label: html.match(/aria-label="([^"]*)"/)![1] };
};

test('the hero figure reads in k, M and B, never as 1000.00M, and keeps the exact number for screen readers', () => {
  assert.deepEqual(figure(999), { whole: '999', cents: ' tok', label: '999 tokens' });
  assert.deepEqual(figure(1000), { whole: '1', cents: '.0k', label: '1,000 tokens' });
  assert.deepEqual(figure(999_949), { whole: '999', cents: '.9k', label: '999,949 tokens' });
  assert.deepEqual(figure(999_950), { whole: '1', cents: '.00M', label: '999,950 tokens' });
  assert.deepEqual(figure(14_250_000), { whole: '14', cents: '.25M', label: '14,250,000 tokens' });
  assert.deepEqual(figure(999_994_999), { whole: '999', cents: '.99M', label: '999,994,999 tokens' });
  assert.deepEqual(figure(999_995_000), { whole: '1', cents: '.00B', label: '999,995,000 tokens' });
  assert.deepEqual(figure(1e9), { whole: '1', cents: '.00B', label: '1,000,000,000 tokens' });
  assert.deepEqual(figure(12_345_678_901), { whole: '12', cents: '.35B', label: '12,345,678,901 tokens' });
  assert.match(heroTokenFigure(5), /^<div class="hero-figure" role="img" aria-label="5 tokens">/);
});

test('no format prints a figure of 1000 or more in a unit that has a bigger one, around any boundary', () => {
  const near: number[] = [];
  for (let power = 3; power <= 12; power++) {
    for (const offset of [-501, -500, -499, -51, -50, -49, -2, -1, 0, 1, 2, 49, 50, 51]) near.push(10 ** power + offset * 10 ** Math.max(0, power - 5));
  }
  for (let n = 999_000; n <= 1_000_100; n += 7) near.push(n);
  for (let n = 999_990_000; n <= 1_000_010_000; n += 997) near.push(n);
  const bad = /(?:^|[^\d.])1000(?:\.0+)?[kMB]\b|(?:^|[^\d.])1000(?:\.0+)?[kM]$/;
  for (const n of near) {
    const outputs = [formatTokens(n), formatTokensCompact(n), splitCompactTokens(n).whole + splitCompactTokens(n).fraction, figure(n).whole + figure(n).cents];
    for (const text of outputs) {
      if (n < 9.995e11) assert.doesNotMatch(text, bad, `${n} -> ${text}`);
    }
  }
});

test('scaleTokens picks the largest unit whose rounded figure stays under a thousand', () => {
  const digits = { k: 1, M: 2, B: 2 };
  assert.equal(scaleTokens(999, digits), undefined);
  assert.deepEqual(scaleTokens(1000, digits), { text: '1.0', unit: 'k' });
  assert.deepEqual(scaleTokens(999_950, digits), { text: '1.00', unit: 'M' });
  assert.deepEqual(scaleTokens(999_995_000, digits), { text: '1.00', unit: 'B' });
  assert.deepEqual(scaleTokens(5e12, digits), { text: '5000.00', unit: 'B' }, 'there is no unit above B to carry into');
});
