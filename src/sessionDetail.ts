import { addPricingPart, bucketIdentity, PricingPart } from './projection';
import { Pricing } from './pricing';
import type { SessionInfo } from './sessionInfo';
import { bucketHasUsage, modelLabel } from './summary';
import { addBucket, emptyBucket, SessionRecord, Source, TOKEN_KEYS, TokenBucket, Tokens } from './types';

export interface DetailDay {
  day: string;
  requests: number;
  cost: number;
  unpriced?: boolean;
  models: string[];
}

export interface DetailModel {
  pricingParts?: PricingPart[];
  model: string;
  tokens: TokenBucket;
  /** Undefined when the model has no rate. */
  cost?: number;
  unpriced?: boolean;
}

export interface DetailPart {
  key: keyof Tokens;
  tokens: number;
  cost: number;
}

/** Everything the session drawer shows: totals over the whole life of the session, plus what the log says it was about. */
export interface SessionDetail {
  key: string;
  source: Source;
  id: string;
  /** The conversation title the store has for the session; the log may know a better one (`info.title`). */
  title?: string;
  project?: string;
  first: number;
  last: number;
  tokens: TokenBucket;
  cost: number;
  /** Some models have no rate, so `cost` is a lower bound. */
  unpriced: boolean;
  /** The part of `cost` that falls in `month`. */
  month: string;
  monthCost: number;
  parts: DetailPart[];
  days: DetailDay[];
  models: DetailModel[];
  /** Undefined when the log is no longer on disk. */
  info?: SessionInfo;
  /** Recently active according to scanned source files. */
  active: boolean;
}

/** The session stored under `key`. The key comes from the page, so names such as `__proto__` must not resolve to anything. */
export function findSession(sessions: Record<string, SessionRecord> | undefined, key: string): SessionRecord | undefined {
  return sessions && Object.prototype.hasOwnProperty.call(sessions, key) ? sessions[key] : undefined;
}

export function buildSessionDetail(key: string, s: SessionRecord, pricing: Pricing, month: string, info?: SessionInfo, active = false): SessionDetail {
  const tokens = emptyBucket();
  const models = new Map<string, DetailModel>();
  const parts: Record<keyof Tokens, DetailPart> = Object.fromEntries(TOKEN_KEYS.map((k) => [k, { key: k, tokens: 0, cost: 0 }])) as Record<keyof Tokens, DetailPart>;
  const days: DetailDay[] = [];
  let cost = 0;
  let monthCost = 0;
  let unpriced = false;

  for (const day of Object.keys(s.days).sort()) {
    const row: DetailDay = { day, requests: 0, cost: 0, models: [] };
    for (const [key, bucket] of Object.entries(s.days[day])) {
      const { model, provider, tier } = bucketIdentity(s.source, key);
      if (!bucketHasUsage(bucket)) continue;
      addBucket(tokens, bucket);
      row.requests += bucket.requests;
      // One row for a model, whatever spelling the tool gave it in each request.
      const label = modelLabel(model);
      row.models.push(label);
      let m = models.get(label);
      if (!m) models.set(label, (m = { model: label, tokens: emptyBucket() }));
      addBucket(m.tokens, bucket);
      const quote = pricing.quote({ source: s.source, model, provider, tier, tokens: bucket });
      addPricingPart(m.pricingParts ??= [], provider, quote, bucket);
      for (const k of TOKEN_KEYS) parts[k].tokens += bucket[k];
      if (quote.unpriced) {
        row.unpriced = true;
        m.unpriced = true;
        unpriced = true;
      }
      const split = quote.breakdown;
      if (!split) continue;
      const c = quote.cost ?? 0;
      m.cost = (m.cost ?? 0) + c;
      row.cost += c;
      for (const k of TOKEN_KEYS) parts[k].cost += split[k];
    }
    if (!row.models.length) continue;
    cost += row.cost;
    if (day.startsWith(month)) monthCost += row.cost;
    days.push(row);
  }

  return {
    key,
    source: s.source,
    id: s.id,
    title: s.title,
    project: s.project,
    first: s.first,
    last: s.last,
    tokens,
    cost,
    unpriced,
    month,
    monthCost,
    parts: TOKEN_KEYS.map((k) => parts[k]),
    days,
    models: [...models.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    info,
    active,
  };
}
