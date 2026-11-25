export type PieMode = 'cost' | 'tokens';

export interface PieSlice<T> {
  item: T;
  value: number;
  /** Fraction of the total, 0 to 1. */
  share: number;
  /** Where the slice starts and ends round the ring, as fractions of a turn clockwise from twelve o'clock. */
  start: number;
  end: number;
}

export interface PieRest {
  count: number;
  value: number;
  share: number;
  start: number;
  end: number;
}

export interface PieLayout<T> {
  total: number;
  slices: PieSlice<T>[];
  rest?: PieRest;
}

/**
 * Lays out the biggest `max` entries and folds the remainder into one rest slice. A single leftover entry is shown as itself, since a
 * rest slice of one model would only hide its name. Entries without a positive value are dropped; ties keep the order they came in.
 */
export function pieLayout<T>(entries: readonly { item: T; value: number }[], max: number): PieLayout<T> {
  const positive = entries.filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);
  const total = positive.reduce((sum, entry) => sum + entry.value, 0);
  const shown = positive.length > max + 1 ? positive.slice(0, max) : positive;
  const folded = positive.slice(shown.length);
  let at = 0;
  const slices = shown.map(({ item, value }) => {
    const share = value / total;
    const slice = { item, value, share, start: at, end: at + share };
    at += share;
    return slice;
  });
  if (!folded.length) return { total, slices };
  const value = folded.reduce((sum, entry) => sum + entry.value, 0);
  return { total, slices, rest: { count: folded.length, value, share: value / total, start: at, end: 1 } };
}

const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * The outline of one slice of a ring, `start` and `end` being fractions of a turn clockwise from twelve o'clock. A slice that fills the
 * whole ring is two half circles, outside and inside, to be filled with the even-odd rule.
 */
export function ringPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const point = (radius: number, fraction: number): string => {
    const angle = fraction * 2 * Math.PI - Math.PI / 2;
    return `${round(cx + radius * Math.cos(angle))} ${round(cy + radius * Math.sin(angle))}`;
  };
  if (end - start >= 0.9999) {
    const circle = (radius: number, sweep: 0 | 1): string =>
      `M ${round(cx + radius)} ${round(cy)} A ${radius} ${radius} 0 1 ${sweep} ${round(cx - radius)} ${round(cy)} A ${radius} ${radius} 0 1 ${sweep} ${round(cx + radius)} ${round(cy)} Z`;
    return `${circle(outer, 1)} ${circle(inner, 0)}`;
  }
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}

/**
 * The part of a slice that is drawn: a hair of space is left between neighbours, and a slice too narrow for that is still drawn as a
 * sliver, so that a model that exists never disappears. All values are fractions of a turn.
 */
export function ringSpan(start: number, end: number, gap: number, sliver = gap): [number, number] {
  if (end - start >= 0.9999) return [start, end];
  const drawn = Math.max(end - start - gap, sliver);
  const middle = (start + end) / 2;
  return [middle - drawn / 2, middle + drawn / 2];
}

/** `66%`, `4%`, `<1%`: whole percents, with a floor so that a slice that exists never reads as 0%. */
export function percentLabel(share: number): string {
  if (!(share > 0)) return '0%';
  const percent = share * 100;
  return percent < 0.5 ? '<1%' : `${Math.round(percent)}%`;
}
