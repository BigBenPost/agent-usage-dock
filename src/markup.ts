/** Anything that reaches the page or a hover from a log or the store is coerced to text first; a stray number or object must never throw. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

export function esc(value: unknown): string {
  return text(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** The text without the embedding, override and isolate controls, which would reorder whatever is printed next to it. */
export const plain = (value: unknown): string => text(value).replace(BIDI_CONTROLS, '');

/** For an attribute value that shows text from a log. */
export const attr = (value: unknown): string => esc(plain(value));

/** Text from a log as an HTML fragment: stripped of directional controls, escaped, and isolated from its neighbours. */
export const untrusted = (value: unknown): string => `<bdi>${attr(value)}</bdi>`;

/** For Markdown that the editor renders with HTML on: only characters that cannot start markup or a link survive. */
export const markdownText = (value: unknown, max = 60): string => plain(value).replace(/[^\w .:/@+-]/g, '').slice(0, max);
