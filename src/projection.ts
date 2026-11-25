import type { Pricing, Quote, ResolvedRate } from './pricing';
import { addBucket, emptyBucket, Source, TokenBucket, UsageRecord } from './types';

export type Tier = 'peak' | 'offpeak' | 'fixed';
export const DSH_ESTIMATE = 'UTC weekday/time estimate; holidays not adjusted';

export function tierOf(ts: number): 'peak' | 'offpeak' {
  const d = new Date(ts), h = d.getUTCHours();
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)) ? 'peak' : 'offpeak';
}

export type DeepSeekSku = 'flash' | 'pro';

/** `deepseek-chat` and `deepseek-reasoner` are the older names of the flash model. */
const FLASH_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner']);
const PRO_MODELS = new Set(['deepseek-pro', 'deepseek-v4-pro']);
const OFFICIAL_ROUTES = new Set(['deepseek', 'deepseek-account', 'deepseek-official']);

export function deepSeekModelSku(model: string): DeepSeekSku | undefined {
  return FLASH_MODELS.has(model) ? 'flash' : PRO_MODELS.has(model) ? 'pro' : undefined;
}

/** The DSH routes that bill at DeepSeek's own prices, peak and off-peak. Any other route keeps its tokens and has no price of its own. */
export function deepSeekSku(model: string, provider?: string): DeepSeekSku | undefined {
  return provider !== undefined && OFFICIAL_ROUTES.has(provider) ? deepSeekModelSku(model) : undefined;
}

/** Only derived buckets carry routing/tier metadata; request model identities stay unchanged. */
export function accountingKey(rec: UsageRecord): string {
  if (rec.source !== 'dsh') return rec.model;
  const tier = deepSeekSku(rec.model, rec.provider) ? tierOf(rec.ts!) : 'fixed';
  return JSON.stringify([rec.provider ?? '', rec.model, tier]);
}

export function bucketIdentity(source: Source, key: string): { model: string; provider?: string; tier: Tier } {
  if (source === 'dsh') {
    try {
      const [provider, model, tier] = JSON.parse(key);
      if (typeof provider === 'string' && typeof model === 'string' && ['peak', 'offpeak', 'fixed'].includes(tier)) return { provider: provider || undefined, model, tier };
    } catch { /* A legacy DSH bucket without routing cannot be priced implicitly. */ }
  }
  return { model: key, tier: 'fixed' };
}

export function quoteBucket(pricing: Pricing, source: Source, key: string, tokens: TokenBucket) {
  return pricing.quote({ source, ...bucketIdentity(source, key), tokens });
}

export interface PricingPart {
  provider?: string;
  tier: Tier;
  tokens: TokenBucket;
  cost?: number;
  note?: string;
  unpriced?: boolean;
  /** The list rate that priced these tokens. The cost follows it, halved off peak, so a card reads the rate here and not from the model. */
  rate?: ResolvedRate;
}

export function addPricingPart(parts: PricingPart[], provider: string | undefined, quote: Quote, tokens: TokenBucket): void {
  let part = parts.find(p => p.provider === provider && p.tier === quote.tier);
  if (!part) { part = { provider, tier: quote.tier, tokens: emptyBucket(), note: quote.note, rate: quote.rate }; parts.push(part); }
  addBucket(part.tokens, tokens);
  if (quote.cost !== undefined) part.cost = (part.cost ?? 0) + quote.cost;
  if (quote.unpriced) part.unpriced = true;
}
