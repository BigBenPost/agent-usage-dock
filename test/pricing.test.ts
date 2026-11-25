import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pricing } from '../src/pricing';

test('an override with no usable field does not make an unknown model free', () => {
  for (const override of [{}, { input: 'abc' }, { input: -1, output: NaN }]) {
    const pricing = new Pricing({ 'my-model': override as never });
    assert.equal(pricing.rateFor('my-model'), undefined, JSON.stringify(override));
    assert.equal(pricing.quote({ source: 'antigravity', model: 'my-model', tokens: { input: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 } }).cost, undefined);
  }
});

test('an override with one usable field changes only that field', () => {
  const rate = new Pricing({ 'gemini-1.5-flash': { output: 12, input: 'x' as never } }).rateFor('gemini-1.5-flash');
  assert.deepEqual([rate?.input, rate?.output, rate?.overridden], [0.075, 12, true]);
  const unknown = new Pricing({ 'my-model': { output: 3 } }).rateFor('my-model');
  assert.deepEqual([unknown?.input, unknown?.output, unknown?.overridden], [0, 3, true]);
});

test('a known model with an unusable override stays on the built-in rate and is not marked overridden', () => {
  const rate = new Pricing({ 'gemini-1.5-flash': {} }).rateFor('gemini-1.5-flash');
  assert.deepEqual([rate?.input, rate?.overridden], [0.075, false]);
});

test('gemini-1.5-pro has its own list price instead of falling through as unpriced', () => {
  const rate = new Pricing({}).rateFor('gemini-1.5-pro');
  assert.deepEqual([rate?.input, rate?.cacheRead, rate?.cacheWrite, rate?.output], [1.25, 0.3125, 1.25, 5]);
});
