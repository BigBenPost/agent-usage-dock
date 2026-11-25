/** Enough CSS to answer "what colour does this element end up with" from the dashboard's own stylesheet, without a browser. */

export interface Rule {
  selectors: string[];
  declarations: Record<string, string>;
  media?: string;
}

function declarations(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of block.split(';')) {
    const at = part.indexOf(':');
    if (at > 0) result[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return result;
}

export function parseCss(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (text: string, media?: string): void => {
    let from = 0;
    while (from < text.length) {
      const open = text.indexOf('{', from);
      if (open < 0) break;
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        const char = text[close++];
        if (char === '{') depth++;
        else if (char === '}') depth--;
      }
      const prelude = text.slice(from, open).trim();
      const inner = text.slice(open + 1, close - 1);
      if (prelude.startsWith('@')) walk(inner, prelude);
      else rules.push({ selectors: prelude.split(',').map((selector) => selector.trim()), declarations: declarations(inner), media });
      from = close;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return rules;
}

export type Theme = 'light' | 'dark';

/** The custom properties the page has under a theme: the base block, then the dark block over it. */
export function themeVariables(rules: Rule[], theme: Theme): Record<string, string> {
  const variables: Record<string, string> = {};
  const blocks = rules.filter((rule) => !rule.media && rule.selectors.some((selector) => selector.startsWith('body') && !selector.includes(' ')) && '--page' in rule.declarations);
  const base = blocks.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === 'body');
  const dark = blocks.find((rule) => rule.selectors.some((selector) => selector.startsWith('body.theme-dark')));
  for (const rule of theme === 'dark' ? [base, dark] : [base]) {
    for (const [name, value] of Object.entries(rule?.declarations ?? {})) if (name.startsWith('--')) variables[name] = value;
  }
  return variables;
}

const expand = (hex: string): string => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex).toLowerCase();

function channels(hex: string): [number, number, number] {
  const full = expand(hex);
  return [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const toHex = (rgb: number[]): string => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** `rgba(r, g, b, a)` laid over an opaque hex colour. */
export function over(value: string | undefined, below: string): string | undefined {
  const match = value ? /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value.trim()) : null;
  if (!match) return undefined;
  const alpha = Number(match[4]);
  const under = channels(below);
  return toHex([1, 2, 3].map((i) => Number(match[i]) * alpha + under[i - 1] * (1 - alpha)));
}

/** A hex colour from a value made of hex colours, `var()` and `color-mix(in srgb, ...)`; undefined for anything else (gradients, transparent). */
export function colour(value: string | undefined, variables: Record<string, string>): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const variable = /^var\((--[\w-]+)\)$/.exec(text);
  if (variable) return colour(variables[variable[1]], variables);
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(text)) return expand(text);
  const mix = /^color-mix\(in srgb,\s*(\S+)\s+(\d+)%,\s*(\S+)\)$/.exec(text);
  if (mix) {
    const [a, b] = [colour(mix[1], variables), colour(mix[3], variables)];
    if (!a || !b) return undefined;
    const [from, to] = [channels(a), channels(b)];
    return toHex(from.map((v, i) => (v * Number(mix[2]) + to[i] * (100 - Number(mix[2]))) / 100));
  }
  return undefined;
}

/** The background that an element with these classes gets from rules made only of classes: the most specific wins, the later one on a tie. */
export function backgroundOf(rules: Rule[], theme: Theme, classes: string[]): string | undefined {
  const variables = themeVariables(rules, theme);
  let best: { weight: number; value: string } | undefined;
  for (const rule of rules) {
    if (rule.media) continue;
    const value = rule.declarations.background ?? rule.declarations['background-color'];
    if (value === undefined) continue;
    for (const selector of rule.selectors) {
      if (!/^(?:\.[\w-]+)+$/.test(selector)) continue;
      const needed = selector.slice(1).split('.');
      if (!needed.every((name) => classes.includes(name))) continue;
      if (!best || needed.length >= best.weight) best = { weight: needed.length, value };
    }
  }
  return best ? colour(best.value, variables) : undefined;
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference; below about 10 two small marks read as the same colour. */
export function deltaE(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
