import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pricing } from '../src/pricing';
import { accountingKey, deepSeekModelSku, deepSeekSku, tierOf } from '../src/projection';
import { summarize } from '../src/summary';
import { emptyBucket, type Source, type TokenBucket } from '../src/types';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const peak = Date.parse('2026-11-23T02:00:00Z');
const offPeak = Date.parse('2026-11-21T02:00:00Z');
const million = (key: 'input' | 'cacheRead' | 'output') => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, [key]: 1e6 });

const FLASH = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner'];
const PRO = ['deepseek-pro', 'deepseek-v4-pro'];

test('every DeepSeek model name belongs to one price list, and other names to none', () => {
  for (const model of FLASH) assert.equal(deepSeekModelSku(model), 'flash', model);
  for (const model of PRO) assert.equal(deepSeekModelSku(model), 'pro', model);
  for (const model of ['deepseek-future', 'deepseek', 'gpt-6.2-sol', '']) assert.equal(deepSeekModelSku(model), undefined, model);
});

test('DSH bills at DeepSeek prices on its own routes, including the default route deepseek-official, and nowhere else', () => {
  for (const route of ['deepseek', 'deepseek-account', 'deepseek-official']) {
    for (const model of FLASH) assert.equal(deepSeekSku(model, route), 'flash', `${route}/${model}`);
    for (const model of PRO) assert.equal(deepSeekSku(model, route), 'pro', `${route}/${model}`);
  }
  for (const route of ['proxy', 'openrouter', '', undefined]) assert.equal(deepSeekSku('deepseek-flash', route), undefined, String(route));
});

test('the default DSH route is priced, at peak and at half price off peak', () => {
  const pricing = new Pricing();
  const quote = (model: string, ts: number, key: 'input' | 'cacheRead' | 'output' = 'input') => pricing.quote({ source: 'dsh', provider: 'deepseek-official', model, ts, tokens: million(key) });
  assert.equal(tierOf(peak), 'peak');
  assert.equal(tierOf(offPeak), 'offpeak');
  assert.equal(quote('deepseek-flash', peak).cost, .30);
  assert.equal(quote('deepseek-flash', offPeak).cost, .15);
  assert.equal(quote('deepseek-flash', peak, 'cacheRead').cost, .006);
  assert.equal(quote('deepseek-flash', peak, 'output').cost, 1.20);
  assert.equal(quote('deepseek-pro', peak).cost, 1.32);
  assert.equal(quote('deepseek-v4-pro', offPeak, 'output').cost, 1.98);
  assert.equal(quote('deepseek-reasoner', peak).cost, .30);
  assert.equal(quote('deepseek-flash', peak).unpriced, false);
});

test('a DeepSeek model has the same price whichever tool reports it, at the peak rate with no tier', () => {
  const pricing = new Pricing();
  for (const source of ['claude', 'codex', 'antigravity'] as const) {
    for (const model of FLASH) {
      const quote = pricing.quote({ source, model, tokens: million('input') });
      assert.equal(quote.cost, .30, `${source}/${model}`);
      assert.equal(quote.tier, 'fixed');
      assert.equal(quote.unpriced, false);
    }
    for (const model of PRO) assert.equal(pricing.quote({ source, model, tokens: million('output') }).cost, 3.96, `${source}/${model}`);
  }
  assert.match(pricing.quote({ source: 'claude', model: 'deepseek-v4-pro', tokens: million('input') }).note ?? '', /Official DeepSeek reference.*peak rates/);
  assert.equal(pricing.quote({ source: 'claude', model: 'deepseek-v4-pro-20261101', tokens: million('input') }).cost, 1.32, 'a dated spelling');
  assert.equal(pricing.quote({ source: 'codex', model: 'DeepSeek-V4-Flash', tokens: million('input') }).cost, .30, 'upper case');
});

test('a DeepSeek model that is not listed, and a DSH route that is not DeepSeek, stay unpriced', () => {
  const pricing = new Pricing();
  assert.equal(pricing.quote({ source: 'claude', model: 'deepseek-future', tokens: million('input') }).unpriced, true);
  assert.equal(pricing.quote({ source: 'dsh', provider: 'deepseek-official', model: 'deepseek-future', ts: peak, tokens: million('input') }).unpriced, true);
  assert.equal(pricing.quote({ source: 'dsh', provider: 'proxy', model: 'deepseek-flash', ts: peak, tokens: million('input') }).unpriced, true);
});

test('the user rates still win, field by field, over the DeepSeek defaults', () => {
  const pricing = new Pricing({ 'deepseek-v4-*': { input: 2 }, 'claude/deepseek-v4-pro': { output: 10 } });
  assert.equal(pricing.quote({ source: 'codex', model: 'deepseek-v4-pro', tokens: million('input') }).cost, 2);
  assert.equal(pricing.quote({ source: 'codex', model: 'deepseek-v4-pro', tokens: million('output') }).cost, 3.96);
  assert.equal(pricing.quote({ source: 'claude', model: 'deepseek-v4-pro', tokens: million('output') }).cost, 10);
});

test('a DSH month on the default route counts in the total and is not listed as unpriced', () => {
  const tokens: TokenBucket = { ...emptyBucket(), requests: 1, input: 1e6, output: 1e6 };
  const rec = { source: 'dsh' as Source, provider: 'deepseek-official', model: 'deepseek-flash', ts: peak };
  const key = accountingKey(rec as never);
  assert.equal(key, JSON.stringify(['deepseek-official', 'deepseek-flash', 'peak']));
  const summary = summarize({ days: { '2026-11-23': { dsh: { [key]: tokens } } }, firstDay: '2026-11-01' }, new Pricing(), NOW);
  assert.equal(summary.unpriced.length, 0);
  assert.ok(Math.abs(summary.total - 1.5) < 1e-9, `total ${summary.total}`);
});
