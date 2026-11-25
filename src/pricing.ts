import { canonicalModel } from './modelNames';
import { Source, TOKEN_KEYS, Tokens } from './types';
import { DSH_ESTIMATE, DeepSeekSku, deepSeekModelSku, deepSeekSku, tierOf, Tier } from './projection';

export interface Rate {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Defaults to the short cache-write rate when only that rate is specified. */
  cacheWrite1h?: number;
  output: number;
}

export interface RateEntry extends Rate {
  match: string | string[];
  note?: string;
}

export interface ResolvedRate extends Rate {
  note?: string;
  overridden: boolean;
  missing?: (keyof Tokens)[];
}

export interface Quote {
  cost?: number;
  breakdown?: Record<keyof Tokens, number>;
  unpriced: boolean;
  tier: Tier;
  note?: string;
  rate?: ResolvedRate;
}

export type RateOverrides = Record<string, Partial<Rate>>;

const ANTHROPIC = 'Historical Anthropic reference · https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'Historical OpenAI reference · https://developers.openai.com/api/docs/pricing';
const GOOGLE = 'Historical Google reference · https://ai.google.dev/gemini-api/docs/pricing';
const OPENAI_STANDARD = OPENAI + ' (prompts up to 272K tokens)';
const CURSOR = 'Cursor list price · https://cursor.com/docs/models';
const CURSOR_FITTED = 'Cursor price, fitted to the list value in a Cursor usage ledger · https://cursor.com/docs/models';
const DEEPSEEK = 'Official DeepSeek reference · https://api-docs.deepseek.com/quick_start/pricing/ (peak rates)';
const USER_OVERRIDE = 'User override';

/** One Anthropic table for every source that reports Claude models, so a model never has two prices. */
export const ANTHROPIC_RATES: RateEntry[] = [
  { match: 'claude-sonnet-5-5', input: 2, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4, output: 10, note: ANTHROPIC },
  { match: ['claude-fable-5-1', 'claude-mythos-5-1'], input: 10, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20, output: 50, note: ANTHROPIC },
  { match: ['claude-fable-5', 'claude-mythos-5'], input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50, note: ANTHROPIC },
  { match: 'claude-opus-5-5', input: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20, note: ANTHROPIC },
  { match: 'claude-opus-5', input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25, note: ANTHROPIC },
  { match: ['claude-opus-4', 'claude-opus-4-1', 'claude-3-opus'], input: 15, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30, output: 75, note: ANTHROPIC },
  { match: ['claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8'], input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25, note: ANTHROPIC },
  { match: 'claude-sonnet-5', input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10, note: ANTHROPIC },
  { match: ['claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-3-5-sonnet', 'claude-3-7-sonnet'], input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15, note: ANTHROPIC },
  { match: 'claude-haiku-5-5', input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, output: 0.5, note: ANTHROPIC + ' (prompts up to 100K tokens)' },
  { match: 'claude-haiku-4-5', input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5, note: ANTHROPIC },
  { match: 'claude-3-5-haiku', input: 0.8, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6, output: 4, note: ANTHROPIC },
  { match: 'claude-3-haiku', input: 0.25, cacheRead: 0.025, cacheWrite: 0.3125, cacheWrite1h: 0.5, output: 1.25, note: ANTHROPIC },
];

export const CODEX_RATES: RateEntry[] = [
  { match: 'gpt-6.2-astra', input: 8, cacheRead: 0.4, cacheWrite: 10, output: 40, note: OPENAI_STANDARD },
  { match: 'gpt-6.2-sol', input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, note: OPENAI_STANDARD },
  { match: 'gpt-6.1-sol', input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10, note: OPENAI_STANDARD },
  { match: 'gpt-6.1-terra', input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5, note: OPENAI_STANDARD },
  { match: 'gpt-6-astra', input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50, note: OPENAI_STANDARD },
  { match: 'gpt-6-sol', input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, note: OPENAI_STANDARD },
  { match: 'gpt-6-luna', input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5, note: OPENAI_STANDARD },
  { match: 'gpt-5.6-sol', input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20, note: OPENAI_STANDARD },
  { match: 'gpt-5.6-terra', input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12, note: OPENAI_STANDARD },
  { match: 'gpt-5.6-luna', input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2, note: OPENAI_STANDARD },
  { match: 'gpt-5.5-fast', input: 10, cacheRead: 1, cacheWrite: 10, output: 60, note: 'Fast mode runs at higher rates that no price page states; twice the standard rate here, as a Cursor usage ledger suggests · https://cursor.com/docs/models' },
  { match: 'gpt-5.5', input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30, note: OPENAI_STANDARD },
  { match: 'gpt-5.4', input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15, note: OPENAI_STANDARD },
  { match: 'gpt-5.3-codex', input: 1.75, cacheRead: 0.175, cacheWrite: 1.75, output: 14, note: OPENAI_STANDARD },
  { match: ['gpt-5.2', 'gpt-5.2-codex'], input: 1.75, cacheRead: 0.175, cacheWrite: 1.75, output: 14, note: OPENAI_STANDARD },
  { match: ['gpt-5', 'gpt-5-codex', 'gpt-5.1', 'gpt-5.1-codex'], input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10, note: OPENAI_STANDARD },
];

/**
 * Cursor's own models and modes. Cursor's page lists Composer 2.5 and its fast variant; the older Composer models, Auto and the
 * review agent are no longer on it, so their rates are fitted to the list value in a Cursor usage ledger. The cache-write rate is the
 * input rate, as the page gives none.
 */
export const CURSOR_RATES: RateEntry[] = [
  { match: 'composer-2.5', input: 0.5, cacheRead: 0.2, cacheWrite: 0.5, output: 2.5, note: CURSOR },
  { match: 'composer-2.5-fast', input: 3, cacheRead: 0.5, cacheWrite: 3, output: 15, note: CURSOR },
  { match: 'composer-2', input: 0.5, cacheRead: 0.2, cacheWrite: 0.5, output: 2.5, note: CURSOR_FITTED },
  { match: 'composer-2-fast', input: 1.5, cacheRead: 0.35, cacheWrite: 1.5, output: 7.5, note: CURSOR_FITTED },
  { match: 'composer-1', input: 1.25, cacheRead: 0.125, cacheWrite: 1.25, output: 10, note: CURSOR_FITTED },
  { match: 'cursor-auto', input: 1.25, cacheRead: 0.25, cacheWrite: 1.25, output: 6, note: CURSOR_FITTED },
  { match: 'cursor-agent-review', input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25, note: CURSOR_FITTED },
];

/** The Antigravity table. Its Claude models resolve through `ANTHROPIC_RATES`. */
export const DEFAULT_RATES: RateEntry[] = [
  { match: ['gemini-1.5-flash-8b', 'gemini-flash-lite', 'flash_lite', 'gemini-2.0-flash-lite'], input: 0.0375, cacheRead: 0.01, cacheWrite: 0.0375, output: 0.15, note: GOOGLE },
  { match: 'gemini-1.5-flash', input: 0.075, cacheRead: 0.01875, cacheWrite: 0.075, output: 0.30, note: GOOGLE },
  { match: ['gemini-2.0-flash', 'gemini-2.0-flash-exp', 'gemini-2.5-flash'], input: 0.10, cacheRead: 0.025, cacheWrite: 0.10, output: 0.40, note: GOOGLE },
  { match: 'gemini-3.8-flash', input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 3.75, note: GOOGLE + ' (introductory rate through 2026-12-31)' },
  { match: ['gemini-1.5-pro', 'gemini-1.5-pro-exp', 'gemini-2.5-pro'], input: 1.25, cacheRead: 0.3125, cacheWrite: 1.25, output: 5.0, note: GOOGLE },
  { match: ['gemini-3-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro', 'gemini-3.1-pro-preview'], input: 2, cacheRead: 0.2, cacheWrite: 2, output: 12, note: GOOGLE },
  { match: 'gemini-3.5-flash', input: 1.5, cacheRead: 0.15, cacheWrite: 1.5, output: 9, note: CURSOR },
  { match: ['gemini-4-hydrogen', 'gemini-4-hydrogen-tiered-high'], input: 1.5, cacheRead: 0.075, cacheWrite: 1.5, output: 7.5, note: GOOGLE },
  { match: 'gemini-4-neon', input: 3, cacheRead: 0.15, cacheWrite: 3, output: 15, note: GOOGLE },
  { match: 'gemini-4-argon', input: 2, cacheRead: 0.1, cacheWrite: 2, output: 10, note: CURSOR },
  { match: 'gemini-4-carbon', input: 2, cacheRead: 0.1, cacheWrite: 2, output: 10, note: GOOGLE + ' (introductory rate through 2026-11-30)' },
  { match: 'gemini-1.0-pro', input: 0.50, cacheRead: 0.50, cacheWrite: 0.50, output: 1.50, note: GOOGLE },
  { match: 'gpt-4o-mini', input: 0.15, cacheRead: 0.075, cacheWrite: 0.15, output: 0.60, note: OPENAI },
  { match: ['o3-mini', 'o1-mini'], input: 1.10, cacheRead: 0.55, cacheWrite: 1.10, output: 4.40, note: OPENAI },
  { match: ['o1', 'o3'], input: 15.0, cacheRead: 7.50, cacheWrite: 15.0, output: 60.0, note: OPENAI },
  { match: 'gpt-4o', input: 2.50, cacheRead: 1.25, cacheWrite: 2.50, output: 10.0, note: OPENAI },
];

/** Per million tokens at peak; DeepSeek does not charge for cache writes. */
export const DEEPSEEK_RATES: Record<DeepSeekSku, Rate> = {
  flash: { input: .30, cacheRead: .006, cacheWrite: 0, output: 1.20 },
  pro: { input: 1.32, cacheRead: .044, cacheWrite: 0, output: 3.96 },
};

type FixedSource = Exclude<Source, 'dsh'>;
const TABLES: Record<FixedSource, ReadonlyMap<string, RateEntry>> = {
  antigravity: rateTable(DEFAULT_RATES),
  claude: rateTable(ANTHROPIC_RATES),
  codex: rateTable(CODEX_RATES),
  /** Cursor runs the models of every maker beside its own, so it prices from all the tables. Their names do not overlap. */
  cursor: rateTable([...ANTHROPIC_RATES, ...CODEX_RATES, ...DEFAULT_RATES, ...CURSOR_RATES]),
};

function rateTable(entries: RateEntry[]): Map<string, RateEntry> {
  return new Map(entries.flatMap(entry => [entry.match].flat().map(model => [model, entry])));
}

/** The spelling price tables use: lower case, without provider prefixes, release dates, `-latest`, version suffixes, effort or thinking marks, and `claude-4.5` written `claude-4-5`. */
export function referenceModel(model: string): string {
  return canonicalModel(model.toLowerCase()
    .replace(/^(?:publishers\/[^/]+\/)?models\//, '')
    .replace(/^(?:[a-z][a-z-]{1,7}\.)?anthropic[./]/, '')
    .replace(/@\d{8}$/, '')
    .replace(/^(claude-.*?)-v\d+(?::\d+)?$/, '$1')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/-latest$/, '')
    .replace(/^(claude-(?:[a-z]+-)?\d+)\.(?=\d)/, '$1-'));
}

function builtInRate(model: string, source: FixedSource): RateEntry | undefined {
  const reference = referenceModel(model);
  const deepSeek = deepSeekModelSku(reference);
  if (deepSeek) return { match: reference, ...DEEPSEEK_RATES[deepSeek], note: DEEPSEEK };
  const table = source === 'antigravity' && reference.startsWith('claude-') ? TABLES.claude : TABLES[source];
  return table.get(model) ?? table.get(reference);
}

export function rateScope(source: Source, provider?: string): string {
  return provider ? source + '[' + provider + ']/' : source + '/';
}

const scopedKey = /^(?:antigravity|dsh|claude|codex|cursor)(?:\[[^\]]+\])?\//;
const wildcard = (pattern: string) => new RegExp('^' + pattern.split('*')
  .map(part => part.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('.*') + '$');

function cleanOverride(value: unknown): Partial<Rate> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<Rate>;
  const clean: Partial<Rate> = {};
  for (const key of TOKEN_KEYS) {
    const rate = source[key];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) clean[key] = rate;
  }
  return Object.keys(clean).length ? clean : undefined;
}

export class Pricing {
  private readonly entries: { scope: string; model: string; pattern?: RegExp; rate: Partial<Rate> }[] = [];
  private readonly resolved = new Map<string, ResolvedRate | undefined>();

  constructor(overrides: RateOverrides = {}, readonly correctionFactor = 1) {
    for (const [key, value] of Object.entries(overrides)) {
      const rate = cleanOverride(value);
      if (!rate) continue;
      const scope = scopedKey.exec(key)?.[0] ?? '';
      const model = key.slice(scope.length);
      this.entries.push({ scope, model, pattern: model.includes('*') ? wildcard(model) : undefined, rate });
    }
  }

  private override(model: string, source: Source, provider?: string): Partial<Rate> {
    const names = [...new Set([model, referenceModel(model)])];
    const scoped = (scope: string) => {
      const mine = this.entries.filter(entry => entry.scope === scope);
      for (const name of names) { const exact = mine.find(entry => !entry.pattern && entry.model === name); if (exact) return exact.rate; }
      for (const name of names) { const match = mine.find(entry => entry.pattern?.test(name)); if (match) return match.rate; }
    };
    return { ...scoped(''), ...scoped(rateScope(source)), ...(provider && scoped(rateScope(source, provider))) };
  }

  rateFor(model: string, source: Source = 'antigravity', provider?: string): ResolvedRate | undefined {
    const cacheKey = JSON.stringify([source, provider, model]);
    if (this.resolved.has(cacheKey)) return this.resolved.get(cacheKey);

    const sku = source === 'dsh' ? deepSeekSku(model, provider) : undefined;
    const base = source === 'dsh' ? sku && DEEPSEEK_RATES[sku] : builtInRate(model, source);
    const user = this.override(model, source, provider);
    const overridden = Object.keys(user).length > 0;
    let resolved: ResolvedRate | undefined;
    if (base || overridden) {
      const merged = { ...base, ...user };
      const missing = TOKEN_KEYS.filter(key => (key === 'cacheWrite1h' ? merged.cacheWrite1h ?? merged.cacheWrite : merged[key]) === undefined);
      resolved = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...merged, overridden, missing };
    }
    this.resolved.set(cacheKey, resolved);
    return resolved;
  }

  quote(input: { source: Source; provider?: string; model: string; ts?: number; tier?: Tier; tokens: Tokens }): Quote {
    const rate = this.rateFor(input.model, input.source, input.provider);
    const official = input.source === 'dsh' && !!deepSeekSku(input.model, input.provider);
    const tier = official ? input.tier ?? (input.ts === undefined ? 'fixed' : tierOf(input.ts)) : 'fixed';
    const note = input.source === 'dsh'
      ? official ? DSH_ESTIMATE : rate ? 'Custom fixed rate' : 'Unpriced provider/model route'
      : rate?.overridden ? USER_OVERRIDE : input.source === 'antigravity' ? undefined : rate?.note;
    const usable = official && tier === 'fixed' ? undefined : rate;
    const used = TOKEN_KEYS.filter(key => input.tokens[key] > 0);
    const missing = used.filter(key => !usable || usable.missing?.includes(key));
    const unpriced = missing.length > 0;
    if (unpriced && missing.length === used.length) return { tier, rate, note, unpriced };

    const multiplier = (tier === 'offpeak' ? .5 : 1) * this.correctionFactor;
    const breakdown = Object.fromEntries(TOKEN_KEYS.map(key => {
      const price = key === 'cacheWrite1h' ? usable?.cacheWrite1h ?? usable?.cacheWrite : usable?.[key];
      return [key, input.tokens[key] * (price ?? 0) / 1e6 * multiplier];
    })) as Record<keyof Tokens, number>;
    const cost = Object.values(breakdown).reduce((sum, amount) => sum + amount, 0);
    const estimateNote = unpriced ? [note, 'Subtotal excludes unpriced token types'].filter(Boolean).join(' · ') : note;
    return { tier, rate, note: estimateNote, unpriced, breakdown, cost };
  }
}
