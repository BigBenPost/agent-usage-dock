import { addPricingPart, bucketIdentity, PricingPart, quoteBucket, Tier } from './projection';
import { Pricing, referenceModel, ResolvedRate } from './pricing';
import { addBucket, DayRecord, emptyBucket, SessionRecord, Source, SOURCES, TOKEN_KEYS, TokenBucket, Tokens } from './types';

export type ModelFamily = 'gemini' | 'opus' | 'gpt' | 'deepseek' | 'composer' | 'unknown';

export function modelFamily(model: string): ModelFamily {
  const m = referenceModel(model);
  if (m.includes('deepseek')) return 'deepseek';
  if (m.startsWith('composer') || m.startsWith('cursor-')) return 'composer';
  if (m.includes('opus') || m.includes('claude') || m.includes('sonnet') || m.includes('haiku')) return 'opus';
  if (m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.includes('openai') || m.includes('chatgpt')) return 'gpt';
  return m.includes('gemini') ? 'gemini' : 'unknown';
}

export const FAMILY_LABELS: Record<ModelFamily, string> = {
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  opus: 'Claude',
  composer: 'Composer',
  unknown: 'Unknown / other',
  gpt: 'GPT',
};

export const FAMILIES: readonly ModelFamily[] = ['gemini', 'opus', 'gpt', 'deepseek', 'composer', 'unknown'];

export const zeroFamilies = (): Record<ModelFamily, number> => Object.fromEntries(FAMILIES.map((family) => [family, 0])) as Record<ModelFamily, number>;

/** The DSH log records DeepSeek under its alias, so the UI uses the canonical model id. Raw ids stay in the store and CSV. */
const MODEL_ALIASES: Record<string, string> = { 'deepseek-flash': 'deepseek-v4.1-flash' };

/**
 * The name the page shows, and the name that puts a model's rows together: the alias, or the name the price lookup uses (lower case,
 * without prefixes, dates and marks, `claude-opus-4.6` as `claude-opus-4-6`), so one model reads the same in every tool.
 */
export const modelLabel = (model: string): string => MODEL_ALIASES[model] ?? referenceModel(model);

export interface DayRow {
  day: string;
  bySource: Record<Source, number>;
  /** Cost per model, keyed by `modelKey(source, model)`. Models without a rate are left out, as they are from the total. */
  byModel: Record<string, number>;
  total: number;
  tokensTotal?: number;
  tokensBucket?: TokenBucket;
  tokensByFamily?: Record<ModelFamily, number>;
  /** Tokens per model, keyed like `byModel` but for every model that ran, priced or not, and per tool. */
  tokensByModel?: Record<string, number>;
  tokensBySource?: Record<Source, number>;
}

/** Models are told apart by source too: both tools can have a model of the same name. */
export const modelKey = (source: Source, model: string): string => `${source}\0${model}`;

export interface ModelRow {
  source: Source;
  model: string;
  tokens: TokenBucket;
  cost?: number;
  unpriced?: boolean;
  rate?: ResolvedRate;
  pricingParts?: PricingPart[];
}

/** One model as the page shows it: every tool and every spelling of the name that stands for it, summed. */
export interface ModelGroup {
  /** The shown name, the same for every spelling. */
  model: string;
  /** The names the tools gave it, as the ledger holds them. */
  names: string[];
  /** The tools it ran in, in the order the page lists tools. */
  sources: Source[];
  tokens: TokenBucket;
  cost?: number;
  unpriced?: boolean;
  /** The rate of the member with the most tokens. A model that ran in several tools can have more than one: see `kindRates`. */
  rate?: ResolvedRate;
  pricingParts?: PricingPart[];
  members: ModelRow[];
}

/** The slices of a model's tokens that were priced one way: a row of the summary has one per route and tier, and a row built by hand has itself. */
const partsOf = (row: ModelRow): PricingPart[] => row.pricingParts ?? [{ tier: 'fixed', tokens: row.tokens, cost: row.cost, unpriced: row.unpriced, rate: row.rate }];

/** The rate of the table or the settings for one kind of token in a part. Undefined when the part has none. */
function listRate(part: PricingPart, key: keyof Tokens): number | undefined {
  const rate = part.rate;
  if (!rate || rate.missing?.includes(key) || (part.unpriced && part.cost === undefined)) return undefined;
  return key === 'cacheWrite1h' ? rate.cacheWrite1h ?? rate.cacheWrite : rate[key];
}

/** Tokens of one kind that were priced at one rate in a model's card. */
export interface KindRate {
  /** Dollars per 1M tokens as they were charged, which is half the listed rate off peak. Undefined for tokens with no rate. */
  rate: number | undefined;
  /** The listed rate, which a card with one rate for the kind prints. */
  list: number | undefined;
  tokens: number;
  payers: { source: Source; provider?: string; tier: Tier }[];
}

/**
 * The rates that the tokens of one kind of a model were charged, the most tokens first. A model that ran in two tools can have an
 * override in each, and DSH tokens are charged at a peak or an off-peak rate, so a card cannot always print one rate for a kind. Empty
 * when the model never used the kind.
 */
export function kindRates(group: ModelGroup, key: keyof Tokens): KindRate[] {
  const byRate = new Map<number | undefined, KindRate>();
  for (const row of group.members) {
    for (const part of partsOf(row)) {
      const tokens = part.tokens[key];
      if (!(tokens > 0)) continue;
      const list = listRate(part, key);
      const rate = list !== undefined && part.tier === 'offpeak' ? list / 2 : list;
      let entry = byRate.get(rate);
      if (!entry) byRate.set(rate, entry = { rate, list, tokens: 0, payers: [] });
      entry.tokens += tokens;
      if (!entry.payers.some((payer) => payer.source === row.source && payer.provider === part.provider && payer.tier === part.tier)) entry.payers.push({ source: row.source, provider: part.provider, tier: part.tier });
    }
  }
  return [...byRate.values()].sort((a, b) => b.tokens - a.tokens || (a.rate ?? Infinity) - (b.rate ?? Infinity));
}

/** The distinct rates that priced a model's tokens, as the table or the settings gave them: where they come from is what the card's source line says. */
export const ratesOf = (group: ModelGroup): ResolvedRate[] => [...new Set(group.members.flatMap((row) => partsOf(row).flatMap((part) => part.rate ?? [])))];

const tokenTotal = (t: TokenBucket): number => t.input + t.cacheRead + t.cacheWrite + t.cacheWrite1h + t.output;

/** The rows of a month with the spellings of one model, and the tools it ran in, put together. Biggest cost first, as the rows come. */
export function groupModels(rows: readonly ModelRow[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  const rateTokens = new Map<ModelGroup, number>();
  for (const row of rows) {
    const key = modelLabel(row.model);
    let group = groups.get(key);
    if (!group) groups.set(key, group = { model: key, names: [], sources: [], tokens: emptyBucket(), members: [] });
    group.members.push(row);
    if (!group.names.includes(row.model)) group.names.push(row.model);
    addBucket(group.tokens, row.tokens);
    if (row.cost !== undefined) group.cost = (group.cost ?? 0) + row.cost;
    if (row.unpriced) group.unpriced = true;
    if (row.pricingParts) group.pricingParts = [...(group.pricingParts ?? []), ...row.pricingParts];
    const size = tokenTotal(row.tokens);
    if (row.rate && (!group.rate || size > (rateTokens.get(group) ?? 0))) { group.rate = row.rate; rateTokens.set(group, size); }
  }
  for (const group of groups.values()) {
    group.sources = SOURCES.filter((source) => group.members.some((row) => row.source === source));
    group.names.sort();
  }
  return [...groups.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1));
}

/**
 * What the page says of a month's conversations: how many are recorded, whether that is only a floor (more than 1 percent of the
 * month's requests belong to no session, since the logs that held them were deleted before anything read them) and the average size of
 * a recorded one. Undefined while the sessions are not built yet.
 */
export function conversationFacts(s: Pick<Summary, 'sessions' | 'unattributed' | 'totalRequests'>): { count: number; floor: boolean; requestsOutside: number; averageTokens: number } | undefined {
  if (s.unattributed === undefined) return undefined;
  const requests = s.sessions.reduce((sum, r) => sum + r.tokens.requests, 0);
  const tokens = s.sessions.reduce((sum, r) => sum + r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.cacheWrite1h + r.tokens.output, 0);
  const requestsOutside = Math.max(0, s.totalRequests - requests);
  return { count: s.sessions.length, floor: requestsOutside > s.totalRequests * 0.01, requestsOutside, averageTokens: s.sessions.length ? tokens / s.sessions.length : 0 };
}

export interface SessionRow {
  /** Key in the store's `sessions`, `<source>:<id>`. */
  key: string;
  source: Source;
  id: string;
  title?: string;
  project?: string;
  /** First and last request over the whole session, epoch ms. */
  first: number;
  last: number;
  models: string[];
  /** This month's part of the session. */
  tokens: TokenBucket;
  cost: number;
  /** Some of the session's models have no rate, so `cost` is a lower bound. */
  unpriced: boolean;
  /** Looks recently active according to scanned source files. */
  active: boolean;
}

export interface SummaryInput {
  days: Record<string, DayRecord>;
  sourceHealth?: import('./store').StoreData['sourceHealth'];
  health?: { root: string; attemptedAt: string; succeededAt?: string; problems: string[] };
  legacy?: { days: Record<string, DayRecord>; before: number };
  sessions?: Record<string, SessionRecord>;
  firstDay?: string;
  /** Keys of the sessions that look in use. */
  active?: ReadonlySet<string>;
  /** Where the ledger and its archive are kept, which the page names. `health.root` is the folder of the Antigravity logs, not these. */
  storage?: { ledger: string; archive: string };
}

export interface Summary {
  health?: SummaryInput['health'];
  sourceHealth?: SummaryInput['sourceHealth'];
  storage?: SummaryInput['storage'];
  legacyHistory?: boolean;
  month: string;
  /** False for a past month, which has no "today" and is priced at the current rates. */
  isCurrent: boolean;
  /** Every month with recorded usage, plus this one and `month`, oldest first. */
  months: string[];
  today: string;
  /** Days of `month` elapsed (all of them for a past month) and its length, UTC. */
  dayOfMonth: number;
  daysInMonth: number;
  firstDay?: string;
  total: number;
  todayTotal: number;
  bySource: Record<Source, number>;
  days: DayRow[];
  models: ModelRow[];
  /** This month's sessions, most expensive first. */
  sessions: SessionRow[];
  /** This month's cost outside every session: requests logged without a session id, sessions deleted here, or logs deleted before sessions were tracked. Undefined while sessions are not tracked. */
  unattributed?: number;
  unpriced: string[];
  correctionFactor: number;
  tokensTotal: number;
  tokensBucket: TokenBucket;
  todayTokens: number;
  todayBucket: TokenBucket;
  tokensBySource: Record<Source, TokenBucket>;
  tokensByFamily: Record<ModelFamily, number>;
  totalRequests: number;
  /** The tools with recorded requests in any month, in the order the page lists tools. */
  recorded: Source[];
}

const bySourceTotals = <T>(init: () => T): Record<Source, T> => Object.fromEntries(SOURCES.map(source => [source, init()])) as Record<Source, T>;
const zeroBySource = (): Record<Source, number> => bySourceTotals(() => 0);

/** What an older store's totals leave once the logs have taken their requests out can be a bucket with tokens and no requests: it counts like any other. */
export const bucketHasUsage = (bucket: TokenBucket): boolean => bucket.requests > 0 || TOKEN_KEYS.some((key) => bucket[key] > 0);

function summarizeSessions(sessions: Record<string, SessionRecord>, month: string, pricing: Pricing, active: ReadonlySet<string>): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const [key, s] of Object.entries(sessions)) {
    const row: SessionRow = { key, source: s.source, id: s.id, title: s.title, project: s.project, first: s.first, last: s.last, models: [], tokens: emptyBucket(), cost: 0, unpriced: false, active: active.has(key) };
    const models = new Set<string>();
    for (const [day, byModel] of Object.entries(s.days)) {
      if (!day.startsWith(month)) continue;
      for (const [key, bucket] of Object.entries(byModel)) {
        const { model } = bucketIdentity(s.source, key);
        if (!bucketHasUsage(bucket)) continue;
        addBucket(row.tokens, bucket);
        models.add(model);
        const quote = quoteBucket(pricing, s.source, key, bucket);
        if (quote.unpriced) row.unpriced = true;
        row.cost += quote.cost ?? 0;
      }
    }
    if (!bucketHasUsage(row.tokens)) continue;
    row.models = [...models].sort();
    rows.push(row);
  }
  const sessionTokens = (r: SessionRow) => r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite + r.tokens.cacheWrite1h + r.tokens.output;
  return rows.sort((a, b) => b.cost - a.cost || sessionTokens(b) - sessionTokens(a) || b.last - a.last);
}

const hasUsage = (day: DayRecord): boolean => Object.values(day).some((byModel) => Object.values(byModel ?? {}).some((b) => b.requests > 0));

/** The months worth offering in the month switcher: those with recorded requests, plus `extra`. Oldest first. */
function monthsWithUsage(days: Record<string, DayRecord>, ...extra: string[]): string[] {
  const months = new Set(extra);
  for (const [day, record] of Object.entries(days)) {
    if (hasUsage(record)) months.add(day.slice(0, 7));
  }
  return [...months].sort();
}

/**
 * The month to pin the dashboard to, or undefined to follow the present one. Whatever the page sends that is not
 * a month with usage falls back to following, so a stray message cannot select an empty or invented month.
 */
export function pinnedMonth(requested: unknown, months: readonly string[], current: string): string | undefined {
  return typeof requested === 'string' && requested !== current && months.includes(requested) ? requested : undefined;
}

/** Prices one UTC month: the one `now` falls in, or `selected`. */
export function summarize({ days, sessions, firstDay, health, sourceHealth, legacy, storage, active = new Set() }: SummaryInput, pricing: Pricing, now = Date.now(), selected?: string): Summary {
  const today = new Date(now).toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const month = selected ?? currentMonth;
  const isCurrent = month === currentMonth;
  const bySource = zeroBySource();
  const tokensBySource = bySourceTotals(emptyBucket);
  const tokensByFamily = zeroFamilies();
  const tokensBucket: TokenBucket = emptyBucket();
  const todayBucket: TokenBucket = emptyBucket();
  const models = new Map<string, ModelRow>();
  const unpriced = new Set<string>();
  const rows: DayRow[] = [];
  let total = 0;
  let todayTotal = 0;

  for (const day of Object.keys(days).filter((d) => d.startsWith(month)).sort().reverse()) {
    const row: DayRow = { day, bySource: zeroBySource(), byModel: {}, total: 0, tokensTotal: 0, tokensBucket: emptyBucket(), tokensByFamily: zeroFamilies(), tokensByModel: {}, tokensBySource: zeroBySource() };
    const dayBucket = emptyBucket();
    const dayTokensByFamily = zeroFamilies();
    for (const source of SOURCES) {
      for (const [bucketKey, bucket] of Object.entries(days[day][source] ?? {})) {
        const { model, provider, tier } = bucketIdentity(source, bucketKey);
        addBucket(tokensBucket, bucket);
        addBucket(tokensBySource[source], bucket);
        addBucket(dayBucket, bucket);
        const tok = bucket.input + bucket.cacheRead + bucket.cacheWrite + bucket.cacheWrite1h + bucket.output;
        const fam = modelFamily(model);
        dayTokensByFamily[fam] += tok;
        tokensByFamily[fam] += tok;
        row.tokensBySource![source] += tok;
        const modelId = modelKey(source, model);
        row.tokensByModel![modelId] = (row.tokensByModel![modelId] ?? 0) + tok;
        if (day === today) {
          addBucket(todayBucket, bucket);
        }
        const key = `${source}\0${model}`;
        const quote = pricing.quote({ source, model, provider, tier, tokens: bucket });
        let m = models.get(key);
        if (!m) {
          m = { source, model, tokens: emptyBucket(), rate: quote.rate };
          models.set(key, m);
        }
        addBucket(m.tokens, bucket);
        addPricingPart(m.pricingParts ??= [], provider, quote, bucket);
        if (quote.unpriced) {
          m.unpriced = true;
          unpriced.add(model);
        }
        const cost = quote.cost;
        if (cost === undefined) continue;
        m.cost = (m.cost ?? 0) + cost;
        row.bySource[source] += cost;
        row.byModel[modelKey(source, model)] = (row.byModel[modelKey(source, model)] ?? 0) + cost;
        row.total += cost;
      }
    }
    row.tokensBucket = dayBucket;
    row.tokensTotal = dayBucket.input + dayBucket.cacheRead + dayBucket.cacheWrite + dayBucket.cacheWrite1h + dayBucket.output;
    row.tokensByFamily = dayTokensByFamily;
    rows.push(row);
    total += row.total;
    for (const s of SOURCES) bySource[s] += row.bySource[s];
    if (day === today) todayTotal = row.total;
  }

  const sessionRows = sessions ? summarizeSessions(sessions, month, pricing, active) : [];
  const unattributed = sessions ? Math.max(0, total - sessionRows.reduce((sum, s) => sum + s.cost, 0)) : undefined;

  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const recorded = SOURCES.filter((source) => Object.values(days).some((record) => Object.values(record[source] ?? {}).some((b) => b.requests > 0)));

  const tokensTotal = tokensBucket.input + tokensBucket.cacheRead + tokensBucket.cacheWrite + tokensBucket.cacheWrite1h + tokensBucket.output;
  const todayTokens = todayBucket.input + todayBucket.cacheRead + todayBucket.cacheWrite + todayBucket.cacheWrite1h + todayBucket.output;
  const totalRequests = tokensBucket.requests;

  return {
    health, sourceHealth, storage, legacyHistory: !!legacy && Object.keys(legacy.days).length > 0,
    month,
    isCurrent,
    months: monthsWithUsage(days, currentMonth, month),
    today,
    dayOfMonth: isCurrent ? Number(today.slice(8, 10)) : daysInMonth,
    daysInMonth,
    firstDay,
    total,
    todayTotal,
    bySource,
    days: rows,
    models: [...models.values()].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1)),
    sessions: sessionRows,
    unattributed: unattributed !== undefined && unattributed < 0.005 ? 0 : unattributed,
    unpriced: [...unpriced].sort(),
    correctionFactor: pricing.correctionFactor,
    tokensTotal,
    tokensBucket,
    todayTokens,
    todayBucket,
    tokensBySource,
    tokensByFamily,
    totalRequests,
    recorded,
  };
}

function csvField(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(days: Record<string, DayRecord>, pricing: Pricing): string {
  const lines = ['day,source,model,requests,input,cache_read,cache_write,cache_write_1h,output,estimated_usd,provider,tier,estimate_note'];
  for (const day of Object.keys(days).sort()) {
    for (const source of SOURCES) {
      const rows = new Map<string, { model: string; provider?: string; tier: ReturnType<typeof bucketIdentity>['tier']; tokens: TokenBucket }>();
      for (const [key, tokens] of Object.entries(days[day][source] ?? {})) {
        const identity = bucketIdentity(source, key);
        const { model, provider } = identity;
        const tier = pricing.quote({ source, ...identity, tokens }).tier;
        const rowKey = JSON.stringify([model, provider, tier]);
        let row = rows.get(rowKey);
        if (!row) rows.set(rowKey, row = { model, provider, tier, tokens: emptyBucket() });
        addBucket(row.tokens, tokens);
      }
      for (const { model, provider, tier, tokens: b } of rows.values()) {
        const quote = pricing.quote({ source, model, provider, tier, tokens: b });
        const cost = quote.cost;
        lines.push(
          [day, source, csvField(model), b.requests, ...TOKEN_KEYS.map((k) => b[k]), cost === undefined ? '' : cost.toFixed(4), csvField(provider ?? ''), quote.tier, csvField(quote.note ?? '')].join(','),
        );
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function usd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}

const SCALES = [
  { unit: 'B', size: 1e9 },
  { unit: 'M', size: 1e6 },
  { unit: 'k', size: 1e3 },
] as const;
export type TokenUnit = typeof SCALES[number]['unit'];

/** `n` in the largest unit whose rounded figure stays below 1000, so 999_500 reads in M rather than as 1000k. Undefined below 1000. */
export function scaleTokens(n: number, digits: Record<TokenUnit, number>): { text: string; unit: TokenUnit } | undefined {
  let at = SCALES.findIndex(({ size }) => n >= size);
  if (at < 0) return undefined;
  for (;; at--) {
    const { unit, size } = SCALES[at];
    const rounded = (n / size).toFixed(digits[unit]);
    if (at === 0 || Number(rounded) < 1000) return { text: rounded, unit };
  }
}

export function formatTokens(n: number): string {
  const scaled = scaleTokens(n, { k: 1, M: 2, B: 2 });
  return scaled ? `${scaled.text}${scaled.unit}` : String(n);
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `October 2026` for a `YYYY-MM` month; anything else prints as nothing, so a damaged day key cannot put text on the page. */
export function monthLabel(month: unknown): string {
  const match = typeof month === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month) : null;
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : '';
}

/** `1 session`, `2 sessions`. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Compact token format for status bar and cards: `712k`, `29.0M`, `1.4B`. A trailing `.0` is dropped. */
export function formatTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const whole = n < 1e3 ? Math.round(n) : n;
  const scaled = scaleTokens(whole, { k: 0, M: 1, B: 1 });
  return scaled ? `${+scaled.text}${scaled.unit}` : `${whole}`;
}

/** Splits compact tokens into whole and fractional parts for hero number styling. */
export function splitCompactTokens(n: number): { whole: string; fraction: string } {
  if (!Number.isFinite(n) || n <= 0) return { whole: '0', fraction: '' };
  const rounded = n < 1e3 ? Math.round(n) : n;
  const scaled = scaleTokens(rounded, { k: 0, M: 1, B: 1 });
  if (!scaled) return { whole: String(rounded), fraction: '' };
  if (scaled.unit === 'k') return { whole: scaled.text, fraction: 'k' };
  const [whole, fraction] = scaled.text.split('.');
  return { whole, fraction: `.${fraction}${scaled.unit}` };
}

/** Compact span for session lengths: `45m`, `3h 05m`, `2d 4h`. */
export function formatSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
