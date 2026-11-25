/** Literal characters plus `*`, matched in O(pattern.length * value.length) time and O(value.length) space. */
export function matchesGlob(pattern: string, value: string): boolean {
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (let p = 0; p < pattern.length; p++) {
    const char = pattern[p];
    const next = new Uint8Array(value.length + 1);
    if (char === '*') next[0] = previous[0];
    for (let i = 1; i <= value.length; i++) {
      next[i] = char === '*' ? previous[i] | next[i - 1] : Number(char === value[i - 1] && !!previous[i - 1]);
    }
    previous = next;
  }
  return !!previous[value.length];
}
