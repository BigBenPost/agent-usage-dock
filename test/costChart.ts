/**
 * The Daily spend card draws its chart twice, in estimated cost and in tokens, and the Cost and Tokens switch decides which one shows.
 * A test that is about the cost drawing (its columns, its legend, its pace) reads the page without the other one.
 */
export function costDrawing<D extends { querySelectorAll(selector: string): Iterable<{ remove(): void }> }>(document: D): D {
  for (const node of [...document.querySelectorAll('.gchart .metric-tokens')]) node.remove();
  return document;
}
