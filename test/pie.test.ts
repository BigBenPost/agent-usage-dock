import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentLabel, pieLayout, ringPath } from '../src/pie';

const entries = (values: number[]) => values.map((value, i) => ({ item: `m${i}`, value }));

test('slices come biggest first, their shares add up to the whole, and each starts where the one before ended', () => {
  const layout = pieLayout(entries([10, 60, 30]), 8);
  assert.deepEqual(layout.slices.map((slice) => slice.item), ['m1', 'm2', 'm0']);
  assert.equal(layout.total, 100);
  assert.deepEqual(layout.slices.map((slice) => +slice.share.toFixed(2)), [0.6, 0.3, 0.1]);
  assert.equal(layout.slices[0].start, 0);
  layout.slices.forEach((slice, i) => { if (i) assert.ok(Math.abs(slice.start - layout.slices[i - 1].end) < 1e-12); });
  assert.ok(Math.abs(layout.slices.at(-1)!.end - 1) < 1e-9);
  assert.equal(layout.rest, undefined);
});

test('entries without a positive value are dropped, and equal values keep the order they came in', () => {
  const layout = pieLayout([{ item: 'a', value: 5 }, { item: 'zero', value: 0 }, { item: 'nan', value: NaN }, { item: 'negative', value: -3 }, { item: 'b', value: 5 }, { item: 'inf', value: Infinity }], 8);
  assert.deepEqual(layout.slices.map((slice) => slice.item), ['a', 'b']);
  assert.equal(layout.total, 10);
});

test('past the limit the smallest fold into one rest slice that closes the ring', () => {
  const layout = pieLayout(entries([100, 90, 80, 70, 60, 50, 40, 30, 20, 10]), 8);
  assert.equal(layout.slices.length, 8);
  assert.equal(layout.rest?.count, 2);
  assert.equal(layout.rest?.value, 30);
  assert.ok(Math.abs(layout.rest!.share - 30 / 550) < 1e-12);
  assert.ok(Math.abs(layout.rest!.start - layout.slices.at(-1)!.end) < 1e-12);
  assert.equal(layout.rest?.end, 1);
});

test('one entry over the limit is shown as itself, since a rest slice of one would only hide its name', () => {
  const layout = pieLayout(entries([9, 8, 7, 6, 5, 4, 3, 2, 1]), 8);
  assert.equal(layout.slices.length, 9);
  assert.equal(layout.rest, undefined);
});

test('nothing positive means no slices and a total of zero', () => {
  assert.deepEqual(pieLayout([], 8), { total: 0, slices: [] });
  assert.deepEqual(pieLayout(entries([0, 0]), 8), { total: 0, slices: [] });
});

test('a quarter of the ring runs from twelve o\'clock to three o\'clock, inside and out', () => {
  assert.equal(ringPath(50, 50, 46, 28, 0, 0.25), 'M 50 4 A 46 46 0 0 1 96 50 L 78 50 A 28 28 0 0 0 50 22 Z');
});

test('a slice of more than half a turn takes the long way round', () => {
  const path = ringPath(50, 50, 46, 28, 0, 0.75);
  assert.match(path, /A 46 46 0 1 1 /);
  assert.match(path, /A 28 28 0 1 0 /);
});

test('a slice that fills the ring is two circles, to be filled with the even-odd rule', () => {
  const path = ringPath(50, 50, 46, 28, 0, 1);
  assert.equal(path.match(/M /g)?.length, 2);
  assert.equal(path.match(/Z/g)?.length, 2);
  assert.doesNotMatch(path, /NaN|undefined/);
});

test('no outline of any slice contains a number that is not a number', () => {
  for (const [start, end] of [[0, 0.001], [0.3, 0.3000001], [0.999, 1], [0.5, 0.5001], [0, 0.9999]]) assert.doesNotMatch(ringPath(50, 50, 46, 28, start, end), /NaN|Infinity/);
});

test('percentages are whole numbers, and a slice that exists never reads as 0%', () => {
  assert.equal(percentLabel(0.664), '66%');
  assert.equal(percentLabel(1), '100%');
  assert.equal(percentLabel(0.004), '<1%');
  assert.equal(percentLabel(0.0049), '<1%');
  assert.equal(percentLabel(0.005), '1%');
  assert.equal(percentLabel(0), '0%');
  assert.equal(percentLabel(NaN), '0%');
  assert.equal(percentLabel(-1), '0%');
});
