import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stackLayout } from '../src/chartStack';

for (const [name, values, height] of [
  ['an exact-scale peak', [11.5, 3.6, 8, 1.9], 148],
  ['a dominant category and tiny ones', [24.99, 0.001, 0.002, 0.007], 148],
  ['a tiny daily total', [0.001, 0.002, 0.007], 2],
  ['more categories than fit at two pixels each', Array.from({ length: 100 }, (_, i) => i ? 0.0001 : 24.9901), 148],
] as const) {
  test(`separators and categories fit the daily height: ${name}`, () => {
    const layout = stackLayout(values, height);
    const total = layout.heights.reduce((sum, value) => sum + value, 0) + layout.gap * (values.length - 1);
    assert.ok(Math.abs(total - height) < 1e-9, `${total} must equal ${height}`);
    assert.ok(layout.heights.every((value) => Number.isFinite(value) && value > 0));
    assert.ok(layout.gap >= 0 && layout.gap <= 2);
  });
}

test('small categories stay visible when the daily height has room', () => {
  const layout = stackLayout([24.99, 0.001, 0.002, 0.007], 148);
  assert.deepEqual(layout.heights.slice(1), [2, 2, 2]);
  assert.equal(layout.gap, 2);
});

test('the same daily total keeps its height after regrouping', () => {
  for (const values of [[11.5, 3.6, 8, 1.9], [15.1, 9.9], [25]]) {
    const { gap, heights } = stackLayout(values, 148);
    assert.ok(Math.abs(heights.reduce((sum, value) => sum + value, 0) + gap * (values.length - 1) - 148) < 1e-9);
  }
});

test('many tiny categories do not crowd out the dominant category', () => {
  const values = Array.from({ length: 100 }, (_, i) => i ? 0.0001 : 24.9901);
  const { heights } = stackLayout(values, 148);
  assert.ok(heights[0] > 50 * heights[1]);
});

test('empty days and zero height need no space or separator', () => {
  assert.deepEqual(stackLayout([], 148), { gap: 0, heights: [] });
  assert.deepEqual(stackLayout([1, 2], 0), { gap: 0, heights: [0, 0] });
  assert.deepEqual(stackLayout([0], 2), { gap: 0, heights: [0] });
});

test('a single category uses the full daily height', () => {
  assert.deepEqual(stackLayout([25], 148), { gap: 0, heights: [148] });
});
