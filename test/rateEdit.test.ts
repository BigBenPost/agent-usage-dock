import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pricing } from '../src/pricing';
import { rateOverride } from '../src/rateEdit';

const builtin = new Pricing().rateFor('gemini-1.5-flash');

test('Configure Rates keeps only the values that differ from the built-in rate', () => {
  assert.ok(builtin);
  // the prompts are prefilled with the rates in effect, so untouched answers come back as they were
  const answers = { input: '0.075', cacheRead: '0.01875', cacheWrite: '0.075', cacheWrite1h: '', output: '0.50' };
  assert.deepEqual(rateOverride(answers, builtin), { output: 0.50 });
});

test('answers equal to the built-in rate, or blank, leave no override', () => {
  assert.deepEqual(rateOverride({ input: '0.075', cacheRead: '0.01875', cacheWrite: '0.075', cacheWrite1h: ' ', output: '0.3' }, builtin), {});
});

test('a model with no built-in rate keeps every filled answer, zero included', () => {
  assert.deepEqual(rateOverride({ input: '1', cacheRead: '0', cacheWrite: '', output: '5' }, undefined), { input: 1, cacheRead: 0, output: 5 });
});
