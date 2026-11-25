export interface StackLayout {
  gap: number;
  heights: number[];
}

/** Fits separators and visible small categories inside a day's fixed height. */
export function stackLayout(values: readonly number[], height: number): StackLayout {
  const heights = values.map(() => 0);
  if (height <= 0 || !values.length || !values.some((v) => v > 0)) return { gap: 0, heights };
  const gap = values.length > 1 ? Math.min(2, height / (2 * values.length)) : 0;
  let remaining = height - gap * (values.length - 1);
  const minimum = Math.min(2, remaining / (2 * values.length));
  let pending = values.map((_, i) => i);
  while (pending.length) {
    const weight = pending.reduce((sum, i) => sum + values[i], 0);
    const small = pending.filter((i) => (remaining * values[i]) / weight < minimum);
    if (!small.length) {
      for (const i of pending) heights[i] = (remaining * values[i]) / weight;
      break;
    }
    for (const i of small) heights[i] = minimum;
    remaining = Math.max(0, remaining - small.length * minimum);
    const fixed = new Set(small);
    pending = pending.filter((i) => !fixed.has(i));
  }
  return { gap, heights };
}
