import { CONTACT_EMAIL, GEMINI_ICON } from './brand';
import { stackLayout } from './chartStack';
import { attr, esc, plain, text, untrusted } from './markup';
import { percentLabel, pieLayout, ringPath, ringSpan, type PieMode } from './pie';
import { budgetMetric } from './statusText';
import type { Config } from './config';
import type { PricingPart } from './projection';
import { ACTIVE_WINDOW_MS, isScanned, Source, SOURCE_LABELS, SOURCES, Tokens } from './types';

import type { SessionDetail } from './sessionDetail';
import { conversationFacts, type DayRow, FAMILIES, FAMILY_LABELS, formatSpan, formatTokens, formatTokensCompact, groupModels, type KindRate, kindRates, ModelFamily, modelFamily, modelLabel, ModelGroup, modelKey, monthLabel, MONTH_NAMES, plural, ratesOf, scaleTokens, SessionRow, Summary, usd } from './summary';
import { DISPLAY_ZONES, DisplayZone, isDisplayZone, stamp, ZONE_ORDER } from './timeZone';

const SESSIONS_SHOWN = 15;
const IN_USE = `In use: its log was written to in the last ${ACTIVE_WINDOW_MS / 60_000} minutes, according to the most recent scan.`;
const IN_USE_AT_EXPORT = `Active at export: its log was written to in the last ${ACTIVE_WINDOW_MS / 60_000} minutes before this snapshot was exported.`;
const THEMES = ['light', 'auto', 'dark'] as const;

export interface RenderOptions {
  offline?: { exportedAt: string };
}

/** The theme the page may use; anything else falls back to light, since the value ends up in a class name. */
export const dashboardTheme = (value: unknown): typeof THEMES[number] => THEMES.find((theme) => theme === value) ?? 'light';
/** A source as a class name and a label. A value outside the four sources prints as a neutral entry rather than as markup. */
const sourceClass = (value: unknown): string => SOURCES.find((source) => source === value) ?? 'unknown';
const sourceLabel = (value: unknown): string => SOURCE_LABELS[sourceClass(value) as Source] ?? 'Unknown source';
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A whole number with thousands separators, as the totals at the top of the page print it. */
const count = (n: number): string => n.toLocaleString('en-US');

const STATUS_ICONS = {
  warning:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Zm-.75 4.5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z"/></svg>',
  critical:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 3.5h1.5v4.5h-1.5V4.5Zm0 6h1.5V12h-1.5v-1.5Z"/></svg>',
};

/** Token types in display order. */
const TOKEN_COLS: { key: keyof Tokens; label: string; short: string }[] = [
  { key: 'input', label: 'Input', short: 'In' },
  { key: 'cacheRead', label: 'Cache read', short: 'C.read' },
  { key: 'cacheWrite', label: 'Cache write', short: 'C.write' },
  { key: 'cacheWrite1h', label: 'Cache write 1h', short: 'W 1h' },
  { key: 'output', label: 'Output', short: 'Out' },
];

const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
/** `Oct 1 – Oct 31`: the billing month, always whole and always UTC, whatever zone session times are shown in. */
const monthRange = (month: string, days: number): string => {
  const name = (MONTH_NAMES[Number(plain(month).slice(5, 7)) - 1] ?? '').slice(0, 3);
  return `${name} 1 – ${name} ${days}`;
};

/** Smallest 1 / 2 / 2.5 / 5 / 10 step at or above `x`, so axis ticks land on clean numbers. */
function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const unit = 10 ** Math.floor(Math.log10(x));
  return ([1, 2, 2.5, 5, 10].find((m) => x <= m * unit) ?? 10) * unit;
}

/**
 * A dollar amount of the daily chart: two decimals from a cent up, as everywhere. Below a cent it takes the decimals that keep two
 * significant digits, up to six, so a few hundredths of a cent do not read $0.00 under a bar that is drawn; an amount smaller than
 * that says so. `trim` drops trailing zeros, for the axis.
 */
function dollars(n: number, trim = false): string {
  const digits = n > 0 && n < 0.01 ? Math.min(6, 1 - Math.floor(Math.log10(n))) : 2;
  if (n > 0 && Number(n.toFixed(digits)) === 0) return 'under $0.000001';
  return `$${trim ? +n.toFixed(digits) : n.toFixed(digits)}`;
}

function axisLabel(n: number): string {
  if (n >= 1000) return `$${+(n / 1000).toFixed(1)}K`;
  return dollars(n, true);
}

/** `500M`, `1.25B`: a tick of the token axis, with only the digits the clean steps of the axis need. */
function tokenAxisLabel(n: number): string {
  const scaled = scaleTokens(n, { k: 0, M: 2, B: 2 });
  return scaled ? `${+scaled.text}${scaled.unit}` : String(Math.round(n));
}

const tokenCell = (n: number): string => (n > 0 ? formatTokens(n) : '<span class="zero">–</span>');

const URL_IN_TEXT = /https?:\/\/\S+/g;
const URL_WITH_SEPARATOR = /\s*(?:·\s*)?https?:\/\/\S+/g;

/** How a payer of a rate reads in a hover: the tool, with the route and the tier when DSH has them. */
function payerLabel({ source, provider, tier }: KindRate['payers'][number]): string {
  const details = [provider, tier === 'peak' ? 'peak' : tier === 'offpeak' ? 'off-peak' : undefined].filter(Boolean).join(', ');
  return details ? `${sourceLabel(source)} (${details})` : sourceLabel(source);
}

/**
 * A tile for each of the five kinds of token, with the count and the rate that prices it. A kind the model never used keeps its tile with
 * a dash, so every card has the same five and none looks half empty. A kind whose tokens were charged at more than one rate, as a model
 * that ran in two tools or in both DSH tiers can have, says `mixed`, and its hover lists the rates. The tiles reflow to the width they
 * have: a narrow strip shows two or three to a line.
 */
function tokenTiles(m: ModelGroup): string {
  const t = m.tokens;
  const tiles = TOKEN_COLS.map((c) => {
    const used = t[c.key] > 0;
    const rates = kindRates(m, c.key);
    if (rates.length > 1) {
      const tokens = (n: number): string => `${n.toLocaleString('en-US')} tokens`;
      const lines = rates.map((r) => `${r.rate === undefined ? 'no rate' : `$${r.rate} per 1M`} · ${r.payers.map(payerLabel).join(' + ')} · ${tokens(r.tokens)}`);
      return `<span class="tile" title="${attr(`${c.label}: ${tokens(t[c.key])} at mixed rates\n${lines.join('\n')}`)}"><small>${c.short}</small><b>${formatTokens(t[c.key])}</b><em>mixed</em></span>`;
    }
    const r = m.rate;
    let rate: string | undefined;
    if (rates.length) rate = rates[0].list === undefined ? (r ? '?' : undefined) : `$${rates[0].list}`;
    else if (r) rate = r.missing?.includes(c.key) ? '?' : `$${r[c.key] ?? r.cacheWrite}`;
    const priced = rate && rate !== '?' ? ` at ${rate} per 1M` : '';
    const hover = used ? `${c.label}: ${t[c.key].toLocaleString('en-US')} tokens${priced}` : `${c.label}: none used${priced}`;
    return `<span class="tile${used ? '' : ' off'}" title="${attr(hover)}"><small>${c.short}</small><b>${used ? formatTokens(t[c.key]) : '–'}</b>${rate ? `<em>${esc(rate)}</em>` : ''}</span>`;
  });
  return `<span class="tiles">${tiles.join('')}</span>`;
}

/**
 * Where the rates on a card come from: the settings, the table that ships with the extension, or both when the tools of a model have
 * theirs from different places. The reference pages of the table are in the hover.
 */
function rateFoot(m: ModelGroup): string {
  const rates = ratesOf(m);
  if (!rates.length) return '';
  const notes = [...new Set(rates.map((r) => r.note ?? ''))];
  const hover = [...new Set([...notes.map((note) => note.replace(URL_WITH_SEPARATOR, '').trim()), ...notes.flatMap((note) => note.match(URL_IN_TEXT) ?? [])])].filter(Boolean).join(' · ');
  const yours = rates.filter((r) => r.overridden).length;
  const source = yours === rates.length ? '<b>your settings</b>' : yours ? '<b>your settings</b> and built in' : 'built in';
  return `<span class="rate-foot"${hover ? ` title="${attr(hover)}"` : ''}>Per 1M tokens · ${source}</span>`;
}

const costLabel = (cost: number | undefined, unpriced?: boolean, digits = 2): string =>
  cost === undefined ? '<span class="warn">unpriced</span>' : `${usd(cost, digits)}${unpriced ? ' <span class="warn" title="Some token types have no rate">+?</span>' : ''}`;

function pricingParts(parts?: PricingPart[]): string {
  return (parts ?? []).filter(part => part.tier !== 'fixed' || part.provider).map(part =>
    `<span class="rate-foot">${attr(part.provider ?? 'unknown provider')} · ${esc(part.tier)} · ${count(part.tokens.requests)} req · ${costLabel(part.cost, part.unpriced, 6)}</span>`).join('');
}

/** `14.25M` with the unit set small in `.cents`, matching the hero figure style. Carries into the next unit (`1.00B`, never `1000.00M`). */
export function heroTokenFigure(tokens: number): string {
  const exact = tokens.toLocaleString('en-US');
  const scaled = scaleTokens(tokens, { k: 1, M: 2, B: 2 });
  const [whole, dec] = scaled ? scaled.text.split('.') : [String(tokens), ''];
  const cents = scaled ? `.${dec}${scaled.unit}` : ' tok';
  return `<div class="hero-figure" role="img" aria-label="${exact} tokens"><span class="int">${whole}</span><span class="cents">${cents}</span></div>`;
}

function hero(s: Summary, cfg: Config): string {
  const totalTokens = s.tokensTotal;
  const metric = budgetMetric(s, cfg);
  const tokenLimit = metric.limit;
  const hasTokenBudget = tokenLimit > 0;

  let budget = '';
  if (hasTokenBudget) {
    const ratio = metric.used / tokenLimit;
    const level = ratio >= cfg.criticalThreshold ? 'critical' : ratio >= cfg.warningThreshold ? 'warning' : 'ok';
    const status =
      level === 'ok' || !s.isCurrent
        ? ''
        : `<span class="status ${level}">${STATUS_ICONS[level]}${ratio > 1 ? `Over budget by ${metric.format(metric.used - tokenLimit)}` : ratio === 1 ? 'Budget reached' : level === 'critical' ? 'Critical: close to the budget' : 'Warning: budget is filling up'}</span>`;
    const aside = !s.isCurrent ? 'current budget' : ratio >= 1 ? '' : `${metric.format(tokenLimit - metric.used)} left`;
    budget = `<div class="bar-block">
        <div class="bar-head"><span>${metric.label} budget <b>${(ratio * 100).toFixed(1)}% of ${metric.format(tokenLimit)}</b></span><span>${aside}</span></div>
        <div class="meter ${level}" role="meter" aria-valuemin="0" aria-valuemax="${tokenLimit}" aria-valuenow="${Math.min(metric.used, tokenLimit)}" aria-valuetext="${esc(`${metric.format(metric.used)} of ${metric.format(tokenLimit)}`)}" aria-label="${esc(metric.label)} against ${s.isCurrent ? 'budget' : 'the current budget'}">
          <div class="fill" style="width:${Math.min(100, ratio * 100).toFixed(2)}%"></div>
          <i class="tick" aria-hidden="true" style="left:${Math.min(100, cfg.warningThreshold * 100)}%" title="Warning threshold"></i>
          <i class="tick" aria-hidden="true" style="left:${Math.min(100, cfg.criticalThreshold * 100)}%" title="Critical threshold"></i>
        </div>
        ${status}
      </div>`;
  }

  const avgReq = s.totalRequests > 0 ? ` <small>avg ${formatTokens(Math.round(totalTokens / s.totalRequests))}</small>` : '';
  const talks = conversationFacts(s);
  const avgSess = talks?.count ? ` <small>avg ${formatTokens(Math.round(talks.averageTokens))}</small>` : '';
  const conversations = talks ? `${talks.count}${talks.floor ? '+' : ''}` : '–';
  const conversationsHover = talks?.floor ? ` title="${attr(`At least this many: ${plural(talks.requestsOutside, 'request')} of the month belong to no recorded conversation: the logs that held them were deleted before they were read, or they carry no conversation id.`)}"` : '';

  return `<section class="card hero">
    <div>
      <div class="card-head"><h2 class="eyebrow">${s.isCurrent ? 'Token Usage' : 'Month Total Tokens'}</h2><span class="card-meta">${s.totalRequests.toLocaleString('en-US')} ${s.totalRequests === 1 ? 'request' : 'requests'}</span></div>
      ${heroPie(s, heroTokenFigure(totalTokens))}
    </div>
    ${budget}
    <dl class="stats">
      ${s.isCurrent ? `<div class="stat hero-today" title="${esc(s.today)} UTC · ${s.todayTokens.toLocaleString('en-US')} tokens"><dt>TODAY</dt><dd><b>${formatTokens(s.todayTokens)}</b> <small>${esc(s.today)}</small></dd></div>` : `<div class="stat"><dt>TODAY</dt><dd>–</dd></div>`}
      <div class="stat"><dt>REQUESTS</dt><dd>${s.totalRequests.toLocaleString('en-US')}${avgReq}</dd></div>
      <div class="stat"${conversationsHover}><dt>CONVERSATIONS</dt><dd>${conversations}${avgSess}</dd></div>
    </dl>
  </section>`;
}

/** Models in the legend before the rest fold into "+N more". */
const MODELS_SHOWN = 8;
/** Models named in one day's hover before the rest are summed into one row. */
const HOVER_MODELS = 6;
/**
 * The shades of a family in the order they are handed out: its own colour, the dark one, the light one and the lightest. The two pale
 * shades are weak against a light page, so they only come up once a family has three or four models.
 */
const SHADE_ORDER = [0, 2, 1, 3];

const shadeClass = (shade: number): string => (shade ? ` s${shade}` : '');

interface ShadedModel { m: ModelGroup; shade: number; family: ModelFamily }

const grouped = new WeakMap<Summary, ModelGroup[]>();
/** The month's models as the page shows them: a model that ran in several tools, or under several spellings, is one. */
function modelsOf(s: Summary): ModelGroup[] {
  let groups = grouped.get(s);
  if (!groups) grouped.set(s, groups = groupModels(s.models));
  return groups;
}
const toolsOf = (m: ModelGroup): string => m.sources.map(sourceLabel).join(' · ');

/**
 * The models with a cost this month, biggest first, each with its shade of its family's colour. The costliest model of a family wears
 * the family's own colour, so a lone Claude model is Claude orange; the others follow in the order of their names, which keeps a
 * ranking change among them from moving a colour.
 */
function shadedModels(s: Summary): ShadedModel[] {
  const priced = modelsOf(s).filter((m) => (m.cost ?? 0) > 0);
  const identity = (m: ModelGroup): string => m.model;
  const families = new Map<ModelFamily, ModelGroup[]>();
  for (const m of priced) families.set(modelFamily(m.model), [...(families.get(modelFamily(m.model)) ?? []), m]);
  const shadeOf = new Map<ModelGroup, number>();
  for (const models of families.values()) {
    const costliest = [...models].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || byText(identity(a), identity(b)))[0];
    const others = models.filter((m) => m !== costliest).sort((a, b) => byText(identity(a), identity(b)));
    [costliest, ...others].forEach((m, i) => shadeOf.set(m, SHADE_ORDER[i % SHADE_ORDER.length]));
  }
  return priced
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || byText(identity(a), identity(b)))
    .map((m) => ({ m, shade: shadeOf.get(m) ?? 0, family: modelFamily(m.model) }));
}

function stackGroup(group: 'model' | 'tool', segments: [string, number][]): string {
  const { gap, heights } = stackLayout(segments.map(([, value]) => value), 100);
  return `<span class="by by-${group}" style="gap:${gap}%">${segments.map(([colour], i) => `<i class="seg ${colour}" style="height:${heights[i]}%"></i>`).join('')}</span>`;
}

/**
 * The models with tokens this month, biggest first, in the colours the ring gives them. The priced ones keep the colours of the cost
 * chart; the ones without a price, which that chart leaves out, take the next free shade of their family.
 */
function tokenModels(s: Summary): ShadedModel[] {
  const shades = pieShades(s);
  return modelsOf(s)
    .filter((m) => tokenSum(m.tokens) > 0)
    .sort((a, b) => tokenSum(b.tokens) - tokenSum(a.tokens) || byText(a.model, b.model))
    .map((m) => ({ m, ...shades.get(m)! }));
}

/** What the chart draws in one of its two units, estimated cost or tokens, so that one function draws both. */
interface ChartView {
  kind: 'cost' | 'tokens';
  /** Said in the name of the group of columns. */
  noun: string;
  models: ShadedModel[];
  total: (d: DayRow) => number;
  ofModel: (d: DayRow, m: ModelGroup) => number;
  ofTool: (d: DayRow, source: Source) => number;
  modelSum: (m: ModelGroup) => number;
  toolSum: (source: Source) => number;
  /** An amount as the hover and the legend print it, then above the tallest bar and on the axis. */
  show: (n: number) => string;
  peak: (n: number) => string;
  axis: (n: number) => string;
  /** The budget divided by the days of the month when the budget is in this unit, else 0. */
  pace: number;
  /** What the card says in place of the bars. */
  empty: string;
}

/**
 * The bars, stacked by model or by tool, in estimated cost or in tokens. All four drawings are in the page, and the card's `data-group`
 * and `data-pie` say which shows (the second is the Cost and Tokens switch of the card above), so switching needs no message to the
 * extension. The legend sits under the chart and the chart expands responsively to fill the card. The columns of each drawing are one
 * tab stop: the page moves it between days with the arrow keys.
 */
function dailyChart(s: Summary, cfg: Config): string {
  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const afterToday = (day: string): boolean => s.isCurrent && day > s.today;
  const grid = [0, 0.5, 1].map((f) => `<i class="grid" style="bottom:${f * 100}%"></i>`).join('');
  const tokenLimit = cfg.budgetMode !== 'cost' ? (cfg.tokenBudgetLimit ?? 0) * 1e6 : 0;
  const nothing = s.isCurrent ? 'No usage recorded this month yet.' : `No usage recorded in ${esc(monthLabel(s.month))}.`;

  const views: ChartView[] = [
    {
      kind: 'cost', noun: 'spend', models: shadedModels(s),
      total: (d) => d.total,
      ofModel: (d, m) => m.members.reduce((sum, member) => sum + (d.byModel[modelKey(member.source, member.model)] ?? 0), 0),
      ofTool: (d, source) => d.bySource[source],
      modelSum: (m) => m.cost ?? 0,
      toolSum: (source) => s.bySource[source],
      show: (n) => dollars(n), peak: (n) => (n >= 100 ? usd(n, 0) : dollars(n)), axis: axisLabel,
      pace: cfg.budgetMode === 'cost' && cfg.budgetLimit > 0 ? cfg.budgetLimit / s.daysInMonth : 0,
      empty: s.totalRequests > 0 ? (s.unpriced.length ? 'Usage recorded. No estimated charges are available for this month.' : 'Usage recorded with zero estimated cost.') : nothing,
    },
    {
      kind: 'tokens', noun: 'tokens', models: tokenModels(s),
      total: (d) => d.tokensTotal ?? 0,
      ofModel: (d, m) => m.members.reduce((sum, member) => sum + (d.tokensByModel?.[modelKey(member.source, member.model)] ?? 0), 0),
      ofTool: (d, source) => d.tokensBySource?.[source] ?? 0,
      modelSum: (m) => tokenSum(m.tokens),
      toolSum: (source) => tokenSum(s.tokensBySource[source]),
      show: formatTokens, peak: formatTokensCompact, axis: tokenAxisLabel,
      pace: tokenLimit > 0 ? tokenLimit / s.daysInMonth : 0,
      empty: s.totalRequests > 0 ? 'Usage recorded with no tokens.' : nothing,
    },
  ];
  const biggest = (view: ChartView): number => Math.max(0, ...s.days.map(view.total));

  const drawing = (view: ChartView): string => {
    const max = biggest(view);
    if (!(max > 0)) return `<div class="metric metric-${view.kind}"><p class="empty">${view.empty}</p></div>`;
    // The chart runs to today, or to the last day with something to draw in this unit.
    const lastUsed = Math.max(0, ...s.days.filter((d) => view.total(d) > 0).map((d) => Number(d.day.slice(8, 10))));
    const dayCount = Math.max(s.dayOfMonth, lastUsed);
    const days = Array.from({ length: dayCount }, (_, i) => `${s.month}-${String(i + 1).padStart(2, '0')}`);
    const labels = days.map((day) => `<span${day === s.today ? ' class="today"' : ''}>${Number(day.slice(8))}</span>`).join('');
    const top = niceCeil(max);
    const peak = s.days.find((d) => view.total(d) === max)?.day;
    const stopDay = s.isCurrent ? s.today : peak ?? days[days.length - 1];
    const pctHeight = (v: number): number => (v > 0 ? Math.max(2, +((v / top) * 100).toFixed(1)) : 0);
    const stacked = FAMILIES.flatMap((family) => view.models.filter((x) => x.family === family));
    const after = days.filter(afterToday).filter((day) => { const d = byDay.get(day); return d !== undefined && view.total(d) > 0; }).length;
    const focus = (day: string): string => `day-${esc(day)}${view.kind === 'tokens' ? '-tokens' : ''}`;

    const cols = days
      .map((day, i) => {
        const d = byDay.get(day);
        const total = d ? view.total(d) : 0;
        const height = pctHeight(total);
        const toolSegs: [Source, number][] = d ? SOURCES.filter((src) => view.ofTool(d, src) > 0).map((src) => [src, view.ofTool(d, src)]) : [];
        const modelSegs: [string, number][] = d ? stacked.filter(({ m }) => view.ofModel(d, m) > 0).map(({ m, shade, family }) => [`${family}${shadeClass(shade)}`, view.ofModel(d, m)]) : [];
        const ranked = d ? view.models.map((x) => ({ ...x, value: view.ofModel(d, x.m) })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value) : [];
        const named = ranked.slice(0, HOVER_MODELS);
        const rest = ranked.slice(HOVER_MODELS);
        const restValue = rest.reduce((sum, x) => sum + x.value, 0);
        // Beside the column rather than over it, so the hovered bar stays visible.
        const anchor = dayCount < 8 ? 'center' : i >= dayCount / 2 ? 'left-of' : '';
        const row = (key: string, amount: number, label: string): string => `<div class="tip-r"><i class="key ${key}"></i><b>${view.show(amount)}</b><span>${label}</span></div>`;
        const heading = `${esc(day)}${afterToday(day) ? ' · after today' : ''}`;
        const tip = d
          ? `<div class="tip ${anchor}" aria-hidden="true"><div class="tip-h">${heading}</div>
          <div class="by by-model">${named.map(({ m, shade, family, value }) => row(`${family}${shadeClass(shade)}`, value, untrusted(modelLabel(m.model)))).join('')}${rest.length ? row('rest', restValue, plural(rest.length, 'other model')) : ''}</div>
          <div class="by by-tool">${toolSegs.map(([src, value]) => row(src, value, SOURCE_LABELS[src])).join('')}</div>
          <div class="tip-r total"><b>${view.show(total)}</b><span>Total</span></div></div>`
          : `<div class="tip ${anchor}" aria-hidden="true"><div class="tip-h">${heading}</div><div class="tip-r"><span>No usage recorded</span></div></div>`;
        const unit = view.kind === 'tokens' ? ' tokens' : '';
        const spoken = d
          ? `${day}${afterToday(day) ? ' (after today)' : ''}: ${view.show(total)}${unit}. By model: ${[...named.map(({ m, value }) => `${plain(modelLabel(m.model))} ${view.show(value)}`), ...(rest.length ? [`${plural(rest.length, 'other model')} ${view.show(restValue)}`] : [])].join(', ') || 'none'}. By tool: ${toolSegs.map(([src, value]) => `${SOURCE_LABELS[src]} ${view.show(value)}`).join(', ') || 'none'}.`
          : `${day}${afterToday(day) ? ' (after today)' : ''}: no usage`;
        const stack = `${day === peak && d ? `<span class="peak">${view.peak(total)}</span>` : ''}${stackGroup('model', modelSegs)}${stackGroup('tool', toolSegs)}`;
        return `<div class="col" role="img" tabindex="${day === stopDay ? 0 : -1}" data-focus="${focus(day)}" aria-label="${attr(spoken)}"><div class="stack" style="height:${height}%">${stack}</div>${tip}</div>`;
      })
      .join('');

    const drawn = view.pace > 0 && view.pace <= top;
    const paceLine = drawn ? `<i class="pace" style="bottom:${((view.pace / top) * 100).toFixed(2)}%"></i>` : '';
    const ticks = [0, 0.5, 1].map((f) => `<span style="bottom:${f * 100}%">${view.axis(top * f)}</span>`).join('');

    const item = (swatch: string, name: string, amount: string, title = name): string => `<span class="legend-item" title="${attr(title)}"><i class="swatch ${swatch}"></i><span class="name">${untrusted(name)}</span><small>${amount}</small></span>`;
    const shown = view.models.slice(0, MODELS_SHOWN);
    const more = view.models.slice(MODELS_SHOWN);
    const modelLegend =
      shown.map(({ m, shade, family }) => item(`${family}${shadeClass(shade)}`, modelLabel(m.model), view.show(view.modelSum(m)), m.names.join(', '))).join('') +
      (more.length ? `<span class="legend-item more" title="${attr(more.map(({ m }) => m.model).join(', '))}">+${more.length} more</span>` : '');
    const toolLegend = SOURCES.filter((src) => view.toolSum(src) > 0)
      .map((src) => item(src, SOURCE_LABELS[src], view.show(view.toolSum(src))))
      .join('');
    const over = s.days.filter((d) => view.total(d) > view.pace).length;
    const paceItem =
      view.pace > 0
        ? `<span class="legend-item" title="The monthly budget divided by the days in the month"><i class="dash"></i><span class="name">Even pace ${view.show(view.pace)} a day</span><small>${plural(over, 'day')} above${drawn ? '' : ' (off the scale)'}</small></span>`
        : '';
    const afterNote = after ? `<p class="note">Usage is dated after today on ${plural(after, 'day')} and drawn on its date. A clock that runs ahead can cause this.</p>` : '';

    return `<div class="metric metric-${view.kind}"><div class="chart" style="--cols:${dayCount}">
      <div class="yaxis" aria-hidden="true">${ticks}</div>
      <div class="plot">${grid}<div class="cols" role="group" aria-label="Daily ${view.noun}, one column per day. The arrow keys move between days.">${cols}</div>${paceLine}</div>
      <div class="xaxis" aria-hidden="true">${labels}</div>
    </div>
    <div class="chart-foot"><div class="legend"><span class="by by-model">${modelLegend}</span><span class="by by-tool">${toolLegend}</span>${paceItem}</div>${afterNote}</div></div>`;
  };

  const toggle = views.some((view) => biggest(view) > 0)
    ? `<div class="segmented small" role="group" aria-label="Group the bars by"><button type="button" data-focus="group-model" data-group-set="model" aria-pressed="true">By model</button><button type="button" data-focus="group-tool" data-group-set="tool" aria-pressed="false">By tool</button></div>`
    : '';

  return `<section class="card gchart" data-group-card data-group="model" data-pie-card data-pie="cost">
    <div class="card-head"><h2 class="eyebrow"><span class="metric metric-cost">Daily spend (UTC)</span><span class="metric metric-tokens">Daily tokens (UTC)</span></h2>${toggle}</div>
    ${views.map(drawing).join('')}
  </section>`;
}

const tok5 = (t: Tokens): string =>
  `<span class="tok5">${TOKEN_COLS.map((c) => `<span class="t" title="${c.label}: ${t[c.key].toLocaleString('en-US')}"><b>${tokenCell(t[c.key])}</b><small>${c.short}</small></span>`).join('')}</span>`;

/** `10-30 02:35 → 03:15`, or with both dates when the session crosses midnight. */
function timeRange(first: number, last: number, zone: DisplayZone): string {
  const a = stamp(first, zone);
  const b = stamp(last, zone);
  return a.slice(0, 5) === b.slice(0, 5) ? `${a} → ${b.slice(6)}` : `${a} → ${b}`;
}

/**
 * A card is one button. Its name is cut to one line, so the full title and the exact token counts are in its tooltip, which shows
 * on keyboard focus too, and in its accessible name.
 */
function sessionCard(r: SessionRow, maxCost: number, zone: DisplayZone, offline = false): string {
  const t = r.tokens;
  const source = sourceClass(r.source);
  const names = [r.title, r.project].map((value) => plain(value).trim()).filter(Boolean);
  const tool = SOURCES.find((candidate) => candidate === source);
  const unnamed = tool && !isScanned(tool) ? `${SOURCE_LABELS[tool]} conversation` : 'unknown project';
  const fullName = names.join(' · ') || unnamed;
  const exact = TOKEN_COLS.map((c) => `${c.label} ${t[c.key].toLocaleString('en-US')}`).join(' · ');
  const range = timeRange(r.first, r.last, zone);
  const spoken = `${fullName}, ${usd(r.cost)}${r.unpriced ? ' plus unpriced usage' : ''}, ${sourceLabel(source)}, ${range}, ${plural(t.requests, 'request')}${r.active ? (offline ? ', active at export' : ', in use') : ''}. ${exact}`;
  const fam = modelFamily(r.models[0] ?? '');
  const activeTag = r.active ? (offline ? ' · <b class="inuse">Active at export</b>' : ' · <b class="inuse">In use</b>') : '';
  return `<article class="scard ${source}" data-key="${esc(r.key)}">
    <button type="button" class="scard-main" aria-haspopup="dialog" title="${attr(`${fullName}\n${exact}`)}" aria-label="${attr(spoken)}" data-focus="session-${esc(r.key)}">
      <span class="srow1"><i class="dot ${fam}"></i><b class="name">${names.length ? names.map(untrusted).join(' · ') : unnamed}</b><b class="cost">${costLabel(r.cost, r.unpriced)}</b></span>
      <span class="srow2">${sourceLabel(source)} · ${range} · ${count(t.requests)} req${activeTag}</span>
      ${tok5(t)}
      <span class="hbar"><i class="${fam}" style="width:${Math.max(r.cost > 0 ? 2 : 0, pct(r.cost, maxCost)).toFixed(1)}%"></i></span>
    </button>
  </article>`;
}

const SORT_OPTIONS: [string, string][] = [
  ['cost:desc', 'Highest cost'],
  ['cost:asc', 'Lowest cost'],
  ['last:desc', 'Most recent activity'],
  ['first:desc', 'Newest start'],
  ['first:asc', 'Oldest start'],
  ['requests:desc', 'Most requests'],
  ['input:desc', 'Most input'],
  ['cacheRead:desc', 'Most cache read'],
  ['cacheWrite:desc', 'Most cache write'],
  ['cacheWrite1h:desc', 'Most cache write 1h'],
  ['output:desc', 'Most output'],
  ['project:asc', 'Project A–Z'],
];

/** `sources` are the tools whose sessions are listed; none means every tool. */
export interface SessionView { sort: string; sources: Source[]; page: number }

/** What the page asked to see, reduced to what it may ask for: a listed sort, known sources once each, a page that is a whole number from 0. */
export function sessionView(value: unknown): SessionView {
  const input = value && typeof value === 'object' ? value as { sort?: unknown; sources?: unknown; page?: unknown } : {};
  const sort = SORT_OPTIONS.find(([option]) => option === input.sort)?.[0] ?? 'last:desc';
  const asked: unknown[] = Array.isArray(input.sources) ? input.sources : [];
  const sources = SOURCES.filter((candidate) => asked.includes(candidate));
  const page = Number.isSafeInteger(input.page) ? Math.max(0, input.page as number) : 0;
  return { sort, sources, page };
}

function sortedSessions(sessions: SessionRow[], sort: string): SessionRow[] {
  const [key, direction] = sort.split(':');
  const number = (row: SessionRow) => key === 'cost' || key === 'last' || key === 'first' ? row[key] : row.tokens[key as keyof SessionRow['tokens']];
  const compare = key === 'project'
    ? (a: SessionRow, b: SessionRow) => byText(plain(a.project).toLowerCase(), plain(b.project).toLowerCase())
    : (a: SessionRow, b: SessionRow) => number(a) - number(b);
  const multiplier = direction === 'asc' ? 1 : -1;
  return sessions.sort((a, b) => multiplier * compare(a, b) || b.cost - a.cost || byText(a.key, b.key));
}

function sessionsSection(s: Summary, zone: DisplayZone, view: SessionView, offline = false): string {
  const head = (sub: string, extra = ''): string =>
    `<div class="card-head"><div><h2 class="eyebrow">Cost per session</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${extra}</div>`;
  if (s.unattributed === undefined) {
    return `<section class="card">${head('')}<p class="empty">Building session history from your logs…</p></section>`;
  }
  const note = s.unattributed
    ? `<p class="note">A further ${usd(s.unattributed)} ${s.isCurrent ? 'this month' : `in ${esc(monthLabel(s.month))}`} belongs to no session: requests logged without a session id, legacy aggregates or logs deleted before sessions were tracked.</p>`
    : '';
  if (!s.sessions.length) {
    return `<section class="card">${head('')}<p class="empty">${s.isCurrent ? 'No sessions recorded this month yet.' : `No sessions recorded in ${esc(monthLabel(s.month))}.`}</p>${note}</section>`;
  }
  const present = SOURCES.filter((src) => s.sessions.some((r) => r.source === src));
  const picked = present.filter((src) => view.sources.includes(src));
  const sources = picked.length === present.length ? [] : picked;
  const rows = sortedSessions(s.sessions.filter(row => !sources.length || sources.includes(row.source)), view.sort);
  const lastPage = Math.max(0, Math.ceil(rows.length / SESSIONS_SHOWN) - 1);
  const page = Math.min(lastPage, view.page);
  const start = page * SESSIONS_SHOWN;
  const totals = rows.reduce(
    (acc, r) => {
      acc.requests += r.tokens.requests;
      acc.cost += r.cost;
      acc.maxCost = Math.max(acc.maxCost, r.cost);
      acc.unpriced ||= r.unpriced;
      for (const c of TOKEN_COLS) acc.tokens[c.key] += r.tokens[c.key];
      return acc;
    },
    { requests: 0, cost: 0, maxCost: 0, unpriced: false, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 } },
  );
  const scope = !sources.length ? 'All tools' : sources.length <= 2 ? sources.map(src => SOURCE_LABELS[src]).join(' + ') : `${sources.length} of ${present.length} tools`;
  const item = (attributes: string, checked: boolean, label: string, dot = ''): string =>
    `<label class="multi-item"><input type="checkbox" ${attributes}${checked ? ' checked' : ''}>${dot}<span>${label}</span></label>`;
  const filter =
    present.length > 1
      ? `<div class="multi" data-multi data-menu="filter">
        <button type="button" class="multi-btn" data-focus="filter-menu" data-multi-toggle data-menu-toggle="filter" aria-haspopup="true" aria-expanded="false" aria-controls="filter-menu-list"><span class="multi-label">${esc(scope)}</span><span class="caret" aria-hidden="true"></span></button>
        <div class="multi-list" id="filter-menu-list" role="group" aria-label="Show sessions of" hidden>
          ${item('data-focus="filter-all" data-filter-all', !sources.length, 'All tools')}
          <div class="multi-sep" role="separator"></div>
          ${present.map(src => item(`data-focus="filter-${src}" data-filter="${src}"`, !sources.length || sources.includes(src), esc(SOURCE_LABELS[src]), `<i class="dot ${src}"></i>`)).join('\n          ')}
        </div>
      </div>`
      : '';
  const sortLabel = SORT_OPTIONS.find(([v]) => v === view.sort)?.[1] ?? SORT_OPTIONS[0][1];
  const sortMenu = `<div class="multi" data-menu="sort">
      <button type="button" class="multi-btn" data-focus="session-sort" data-menu-toggle="sort" aria-haspopup="true" aria-expanded="false" aria-controls="sort-menu-list" aria-label="${attr(`Sort sessions: ${sortLabel}`)}"><span class="multi-label">${esc(sortLabel)}</span><span class="caret" aria-hidden="true"></span></button>
      <div class="multi-list" id="sort-menu-list" role="group" aria-label="Sort sessions" hidden>
        ${SORT_OPTIONS.map(([v, l]) => `<button type="button" class="multi-item" data-sort-option="${esc(v)}" data-focus="sort-${esc(v)}" aria-pressed="${v === view.sort}"><span class="menu-check" aria-hidden="true"></span><span>${l}</span></button>`).join('\n        ')}
      </div>
    </div>`;
  const sortbar = `<div class="sortbar">
      ${filter}
      ${sortMenu}
    </div>`;
  const zones = `<div class="zonebar">Times in <div class="segmented small" role="group" aria-label="Time zone of session times">${ZONE_ORDER.map((z) => `<button type="button" data-focus="zone-${z}" data-zone="${z}" aria-pressed="${z === zone}" title="${esc(DISPLAY_ZONES[z].name)}"${z === zone ? ' class="active"' : ''}>${z}</button>`).join('')}</div></div>`;
  const pages = lastPage ? `<nav class="session-pages" aria-label="Session pages">
    <button type="button" class="linkbtn" data-focus="sessions-prev" data-page="${page - 1}"${page === 0 ? ' disabled' : ''}>Previous</button>
    <span>${start + 1}–${Math.min(rows.length, start + SESSIONS_SHOWN)} of ${rows.length}</span>
    <button type="button" class="linkbtn" data-focus="sessions-next" data-page="${page + 1}"${page === lastPage ? ' disabled' : ''}>Next</button>
  </nav>` : '';
  return `<section class="card">
    ${head(`${plural(rows.length, 'session')} in ${esc(monthLabel(s.month))}.${zones}`, sortbar)}
    <div class="slist" data-sort="${esc(view.sort)}" data-sources="${esc(sources.join(','))}" data-page="${page}">${rows.slice(start, start + SESSIONS_SHOWN).map(r => sessionCard(r, totals.maxCost, zone, offline)).join('')}</div>
    ${pages}
    <div class="scard total"><span class="srow1"><b class="name">${sources.length ? sources.map(src => esc(SOURCE_LABELS[src])).join(' + ') : 'All'} · ${plural(rows.length, 'session')}</b><b class="cost">${costLabel(totals.cost, totals.unpriced)}</b></span><span class="srow2">${plural(totals.requests, 'request')}</span>${tok5(totals.tokens)}</div>
    ${note}
  </section>`;
}

/** Model cards shown before the rest fold away, and the most that are listed at all; the CSV export has every model. */
const MODEL_CARDS_SHOWN = 12;
const MODEL_CARDS_MAX = 60;

/** Models named in the pie before the rest fold into one slice. */
const PIE_MODELS = 6;
/** The ring is thin and its slices are set apart by a hair of space, to sit with the hairlines and capsules of the cards. */
const RING = { outer: 46, inner: 39.5, gap: 0.004 };
const ring = (start: number, end: number): string => ringPath(50, 50, RING.outer, RING.inner, ...ringSpan(start, end, RING.gap));
/** Legend rows shown before the rest fold under "N more models"; a single row more is shown, since a fold for one row saves nothing. */
const LEGEND_SHOWN = 4;
const tokenSum = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite + t.cacheWrite1h + t.output;

/**
 * A shade for every model of the month. The priced ones keep the shade the daily chart gives them, so a model has one colour across
 * the page; the others, which the chart leaves out, take the next shade of their family that is still free.
 */
function pieShades(s: Summary): Map<ModelGroup, { family: ModelFamily; shade: number }> {
  const out = new Map<ModelGroup, { family: ModelFamily; shade: number }>();
  const taken = new Map<ModelFamily, Set<number>>();
  for (const { m, shade, family } of shadedModels(s)) {
    out.set(m, { family, shade });
    taken.set(family, (taken.get(family) ?? new Set<number>()).add(shade));
  }
  const identity = (m: ModelGroup): string => m.model;
  for (const m of [...modelsOf(s)].sort((a, b) => byText(identity(a), identity(b)))) {
    if (out.has(m)) continue;
    const family = modelFamily(m.model);
    const used = taken.get(family) ?? new Set<number>();
    taken.set(family, used);
    const shade = SHADE_ORDER.find((candidate) => !used.has(candidate)) ?? SHADE_ORDER[0];
    used.add(shade);
    out.set(m, { family, shade });
  }
  return out;
}

/**
 * The month's token figure with each model's share of the month: a legend under the figure and a ring beside it, by estimated cost or by
 * tokens. Both are in the page and the row's `data-pie` says which shows, so the switch needs no message to the extension. Models without
 * a price have no share of the cost and are named under the legend instead. The model cards below carry the same shares.
 */
function heroPie(s: Summary, figure: string): string {
  if (!s.models.length) return `<div class="hero-row">${figure}</div>`;
  const shades = pieShades(s);
  const ordered = [...modelsOf(s)].sort((a, b) => byText(a.model, b.model));
  const view = (mode: PieMode): { legend: string; ring: string } => {
    const money = mode === 'cost';
    const format = (value: number): string => (money ? usd(value) : formatTokens(value));
    const layout = pieLayout(ordered.map((m) => ({ item: m, value: money ? m.cost ?? 0 : tokenSum(m.tokens) })), PIE_MODELS);
    const unpriced = money ? ordered.filter((m) => !((m.cost ?? 0) > 0) && m.unpriced) : [];
    const partly = money ? ordered.filter((m) => (m.cost ?? 0) > 0 && m.unpriced) : [];
    const named = (models: ModelGroup[]): string => `${models.slice(0, 3).map((m) => plain(modelLabel(m.model))).join(', ')}${models.length > 3 ? ' and more' : ''}`;
    const left = [
      unpriced.length ? `${plural(unpriced.length, 'model')} without a price ${unpriced.length === 1 ? 'is' : 'are'} left out: ${named(unpriced)}.` : '',
      partly.length ? `${plural(partly.length, 'model')} partly priced ${partly.length === 1 ? 'is' : 'are'} a lower bound: ${named(partly)}.` : '',
    ].filter(Boolean).join(' ');
    const note = left ? `<p class="note">${esc(left)}</p>` : '';
    const unit = money ? (unpriced.length || partly.length ? 'est. cost + ?' : 'est. cost') : 'tokens';
    const centre = (total: number): string => `<text class="pie-total" x="50" y="50" text-anchor="middle">${esc(format(total))}</text><text class="pie-unit" x="50" y="59" text-anchor="middle">${unit}</text>`;
    if (!layout.total) {
      const empty = money ? 'No priced usage in this month.' : 'No tokens recorded in this month.';
      return {
        legend: `<div class="pie-legend-wrap pie-${mode}"><p class="note">${empty}</p>${note}</div>`,
        ring: `<div class="pie-view pie-${mode}"><svg class="pie-svg" viewBox="0 0 100 100" role="img" aria-label="${attr(`${money ? 'Estimated cost' : 'Tokens'} by model: ${empty.toLowerCase()}${left ? ` ${left}` : ''}`)}"${left ? ` title="${attr(left)}"` : ''}><path class="slice empty" fill-rule="evenodd" d="${ring(0, 1)}"/>${centre(0)}</svg></div>`,
      };
    }
    const described = ({ item, value, share }: { item: ModelGroup; value: number; share: number }): string => `${plain(modelLabel(item.model))} (${item.sources.map(sourceLabel).join(', ')}): ${format(value)}, ${percentLabel(share)}`;
    const paths = layout.slices.map((slice) => {
      const { family, shade } = shades.get(slice.item)!;
      return `<path class="slice ${family}${shadeClass(shade)}" fill-rule="evenodd" d="${ring(slice.start, slice.end)}" title="${attr(described(slice))}"/>`;
    }).join('');
    const restPath = layout.rest
      ? `<path class="slice rest" fill-rule="evenodd" d="${ring(layout.rest.start, layout.rest.end)}" title="${attr(`${plural(layout.rest.count, 'other model')}: ${format(layout.rest.value)}, ${percentLabel(layout.rest.share)}`)}"/>`
      : '';
    const rows = layout.slices.map((slice) => {
      const { family, shade } = shades.get(slice.item)!;
      return { models: 1, html: `<li><i class="swatch ${family}${shadeClass(shade)}"></i><span class="pie-name">${untrusted(modelLabel(slice.item.model))}<small>${esc(toolsOf(slice.item))}</small></span><b>${esc(format(slice.value))}</b><span class="pie-pct">${percentLabel(slice.share)}</span></li>` };
    });
    if (layout.rest) rows.push({ models: layout.rest.count, html: `<li><i class="swatch rest"></i><span class="pie-name">${plural(layout.rest.count, 'other model')}</span><b>${esc(format(layout.rest.value))}</b><span class="pie-pct">${percentLabel(layout.rest.share)}</span></li>` });
    const folded = rows.length > LEGEND_SHOWN + 1 ? rows.slice(LEGEND_SHOWN) : [];
    const listed = rows.slice(0, rows.length - folded.length);
    const more = folded.length
      ? `<details class="diagnostic pie-more" data-key="pie-more"><summary data-focus="pie-more-${mode}">${plural(folded.reduce((sum, row) => sum + row.models, 0), 'more model')}</summary><ul class="pie-legend">${folded.map((row) => row.html).join('')}</ul></details>`
      : '';
    const spoken = `${money ? 'Estimated cost' : 'Tokens'} by model: ${layout.slices.slice(0, 5).map((slice) => `${plain(modelLabel(slice.item.model))} ${percentLabel(slice.share)}`).join(', ')}${layout.slices.length > 5 || layout.rest ? ' and others' : ''}.${left ? ` ${left}` : ''}`;
    return {
      legend: `<div class="pie-legend-wrap pie-${mode}"><ul class="pie-legend">${listed.map((row) => row.html).join('')}</ul>${more}${note}</div>`,
      ring: `<div class="pie-view pie-${mode}"><svg class="pie-svg" viewBox="0 0 100 100" role="img" aria-label="${attr(spoken)}"${left ? ` title="${attr(left)}"` : ''}>${paths}${restPath}${centre(layout.total)}</svg></div>`,
    };
  };
  const cost = view('cost');
  const tokens = view('tokens');
  return `<div class="hero-row" data-pie-card data-pie="cost">
      <div class="hero-left">
        ${figure}
        <div class="segmented small" role="group" aria-label="Show shares by"><button type="button" data-focus="pie-cost" data-pie-set="cost" aria-pressed="true" class="active">Cost</button><button type="button" data-focus="pie-tokens" data-pie-set="tokens" aria-pressed="false">Tokens</button></div>
        ${cost.legend}${tokens.legend}
      </div>
      <div class="hero-ring">${cost.ring}${tokens.ring}</div>
    </div>`;
}

/** What share of the month's priced cost and of its tokens each model has: the label and the fraction behind it. */
function modelShares(s: Summary): Map<ModelGroup, { cost: { label: string; fraction: number }; tokens: { label: string; fraction: number } }> {
  const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
  const models = modelsOf(s);
  const totalCost = models.reduce((sum, m) => sum + positive(m.cost ?? 0), 0);
  const totalTokens = models.reduce((sum, m) => sum + positive(tokenSum(m.tokens)), 0);
  const of = (value: number, total: number) => { const fraction = total > 0 ? positive(value) / total : 0; return { label: percentLabel(fraction), fraction }; };
  return new Map(models.map((m) => [m, {
    cost: m.cost === undefined ? { label: '–', fraction: 0 } : of(m.cost, totalCost),
    tokens: of(tokenSum(m.tokens), totalTokens),
  }]));
}

function modelCards(s: Summary): string {
  const shares = modelShares(s);
  const fill = (fraction: number): string => (fraction > 0 ? `<i style="width:${Math.max(3, fraction * 100).toFixed(1)}%"></i>` : '');
  const card = (m: ModelGroup): string => {
    const fam = modelFamily(m.model);
    const share = shares.get(m)!;
    return `<article class="mcard model f-${fam}">
        <span class="srow1"><i class="dot ${fam}"></i><b class="name" title="${attr(m.names.join(', '))}">${untrusted(modelLabel(m.model))}</b><b class="cost">${costLabel(m.cost, m.unpriced)}</b></span>
        <span class="chips">${m.sources.map((source) => `<span class="chip">${sourceLabel(source)}</span>`).join('')}<span class="chip">${plural(m.tokens.requests, 'request')}</span><span class="chip share"><span class="share-cost" title="Share of the month's estimated cost">${fill(share.cost.fraction)}<span class="v">${share.cost.label}</span></span><span class="share-tokens" title="Share of the month's tokens">${fill(share.tokens.fraction)}<span class="v">${share.tokens.label}</span></span></span></span>
        ${tokenTiles(m)}
        ${rateFoot(m)}
        ${pricingParts(m.pricingParts)}
      </article>`;
  };
  const all = modelsOf(s);
  const listed = all.slice(0, MODEL_CARDS_MAX);
  const folded = listed.slice(MODEL_CARDS_SHOWN);
  const unlisted = all.length - listed.length;
  const fold = folded.length
    ? `<details class="diagnostic" data-key="more-models"><summary data-focus="more-models-toggle">${plural(folded.length, 'more model')}</summary><div class="mgrid">${folded.map(card).join('')}</div></details>`
    : '';
  const omitted = unlisted > 0 ? `<p class="note">${plural(unlisted, 'further model')} not listed here. The CSV export has every model.</p>` : '';
  return `<details class="card fold" data-key="by-model" data-pie-card data-pie="cost" open><summary data-focus="by-model-toggle"><h2 class="eyebrow">By model</h2></summary>
    <div class="mgrid">${listed.slice(0, MODEL_CARDS_SHOWN).map(card).join('')}</div>
    ${fold}${omitted}
  </details>`;
}

/** Previous and next arrows step through the months with usage; the menu jumps to any of them. `data-month` is what the page sends back. */
function monthNav(s: Summary): string {
  const at = s.months.indexOf(s.month);
  const step = (label: string, month: string | undefined, glyph: string, focus: string): string =>
    `<button type="button" class="icon-btn" aria-label="${label}" data-focus="${focus}"${month ? ` data-month="${esc(month)}"` : ' disabled'}>${glyph}</button>`;
  const currentLabel = monthLabel(s.month);
  const options = [...s.months].reverse().map((m) =>
    `<button type="button" class="multi-item" data-month="${esc(m)}" data-focus="month-${esc(m)}" aria-pressed="${m === s.month}"><span class="menu-check" aria-hidden="true"></span><span>${esc(monthLabel(m))}</span></button>`
  ).join('\n        ');
  const monthMenu = `<div class="multi" data-menu="month">
      <button type="button" class="multi-btn" data-month-select data-focus="month-select" data-menu-toggle="month" aria-haspopup="true" aria-expanded="false" aria-controls="month-menu-list" aria-label="${attr(`Month: ${currentLabel}`)}"><span class="multi-label">${esc(currentLabel)}</span><span class="caret" aria-hidden="true"></span></button>
      <div class="multi-list" id="month-menu-list" role="group" aria-label="Month" hidden>
        ${options}
      </div>
    </div>`;
  return `<nav class="monthnav" aria-label="Month">
    ${step('Previous month', s.months[at - 1], '‹', 'month-prev')}
    ${monthMenu}
    ${step('Next month', s.months[at + 1], '›', 'month-next')}
    ${s.isCurrent ? '' : '<button type="button" class="linkbtn" data-month="current" data-focus="month-current">Current month</button>'}
  </nav>`;
}

function exportStamp(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : plain(iso);
}

/** Everything inside the page's `#app` element. Sent to the open page as a message on each update, so the page itself never reloads. */
export function renderBody(s: Summary, cfg: Config, view = sessionView(undefined), options?: RenderOptions): string {
  const since = text(s.firstDay);
  const offline = options?.offline;
  const contact = `<div class="sub">Have a problem? Contact <a href="mailto:${CONTACT_EMAIL}" data-focus="contact">${CONTACT_EMAIL}</a></div>`;
  const meta = offline
    ? `<div class="sub">Offline snapshot · exported ${esc(exportStamp(offline.exportedAt))}</div>${since ? `<div class="sub">Estimate from logs tracked since ${esc(since)}</div>` : ''}${contact}`
    : `<div class="sub">Estimate from this machine's logs${since ? `, tracked since ${esc(since)}` : ''}</div>${contact}<button type="button" class="linkbtn" data-action="configure-rates" data-focus="configure-rates">Configure rates</button>`;
  return `<div class="page">
<header class="top">
  <div><h1>${GEMINI_ICON}<span class="usage">agent-usage-dock</span></h1>${monthNav(s)}<div class="sub">${monthRange(s.month, s.daysInMonth)} · billing cycle UTC${s.isCurrent ? '' : ' · priced at the current rates'}</div></div>
  <div class="meta">${meta}</div>
</header>
${s.health?.problems.length ? '<p class="banner warn">Incomplete scan: some usage may be missing. See Collection status below.</p>' : ''}
${s.unpriced.length ? `<p class="banner warn">Some token types are unpriced and excluded from estimated costs. Models affected: ${s.unpriced.map(untrusted).join(', ')}.</p>` : ''}
<div class="pair">${hero(s, cfg)}${dailyChart(s, cfg)}</div>
${modelCards(s)}
${sessionsSection(s, cfg.timeZone, view, !!offline)}
${renderHealth(s)}
<ul class="notes">
  <li>Historical months are recalculated at current rates. Verify provider and context tiers before setting a money budget.</li>
  <li>Correction factor: ${esc(s.correctionFactor)}. Rates and the factor are set in the <code>agyTokenTracker</code> settings.</li>
  <li>Your provider's billing dashboard is the source of truth. Not counted: usage from other machines on the same key, calls not written to the logs, and logs deleted before their first collection.</li>
</ul>
</div>`;
}

const CLOSE_BUTTON = '<button type="button" class="icon-btn" data-action="close" aria-label="Close">×</button>';

/** The first of these that is not blank. */
const firstText = (...values: unknown[]): string | undefined => values.map((value) => plain(value).trim()).find(Boolean);

/** The content of the popup card that opens when a session is clicked. */
export function renderSessionDetail(d: SessionDetail, zone: DisplayZone = 'UTC', options?: RenderOptions): string {
  const shownZone = isDisplayZone(zone) ? zone : 'UTC';
  const offline = !!options?.offline;
  const info = d.info;
  const dl = (rows: [string, string | undefined][]): string =>
    `<dl class="facts">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const openBtn = offline ? '' : ` <button type="button" class="linkbtn inline" data-action="open-log">${info?.folder ? 'Open folder' : 'Open log'}</button>`;
  const about = info
    ? dl([
        ['First prompt', info.firstPrompt ? `<div class="quote">${untrusted(info.firstPrompt)}</div>` : undefined],
        ['Directory', info.cwd ? `<span class="mono">${untrusted(info.cwd)}</span>` : undefined],
        ['Branch', info.branch ? `<span class="mono">${untrusted(info.branch)}</span>` : undefined],
        ['Session', `<span class="mono">${untrusted(d.id)}</span>`],
        ['Log', `<span class="mono">${untrusted(info.file)}</span>${openBtn}`],
      ])
    : `${dl([['Session', `<span class="mono">${untrusted(d.id)}</span>`]])}<p class="sub">${isScanned(d.source) ? 'The log for this session is no longer on disk, so only its usage totals are available.' : `${sourceLabel(d.source)} keeps no log on this machine, so only the usage totals of this session are available.`}</p>`;

  const costParts = d.parts.reduce((sum, p) => sum + p.cost, 0);
  const maxPart = Math.max(...d.parts.map((p) => p.cost), 0);
  const parts = TOKEN_COLS.map((c) => {
    const p = d.parts.find((x) => x.key === c.key)!;
    return `<li><span class="p-label">${c.label}</span><span class="p-tok">${tokenCell(p.tokens)}</span><span class="p-cost">${usd(p.cost)}</span><span class="p-share">${pct(p.cost, costParts).toFixed(0)}%</span><div class="hbar"><i class="${sourceClass(d.source)}" style="width:${pct(p.cost, maxPart).toFixed(1)}%"></i></div></li>`;
  }).join('');

  const dayRows = d.days
    .map((x) => `<tr><td>${esc(x.day)}</td><td class="n">${count(x.requests)}</td><td class="n cost">${costLabel(x.cost, x.unpriced)}</td></tr>`)
    .join('');
  const modelRows = d.models
    .map((m) => `<tr><td class="wrap" title="${attr(m.model)}"><i class="dot ${modelFamily(m.model)}" style="margin-right:6px"></i>${untrusted(modelLabel(m.model))}${pricingParts(m.pricingParts)}</td><td class="n">${count(m.tokens.requests)}</td><td class="n cost">${costLabel(m.cost, m.unpriced)}</td></tr>`)
    .join('');
  const lifetimeNote = Math.abs(d.cost - d.monthCost) >= 0.005 ? `<div class="sub">${usd(d.monthCost)} in ${esc(monthLabel(d.month))}</div>` : '';
  const inUse = d.active ? `<section class="d-sec"><p class="sub">${esc(offline ? IN_USE_AT_EXPORT : IN_USE)}</p></section>` : '';

  const title = firstText(info?.title, d.title);
  const project = firstText(d.project);
  const headFam = modelFamily(d.models[0]?.model ?? '');
  return `<header class="pop-head">
    <div>
      <div class="eyebrow"><i class="dot ${headFam}"></i>${sourceLabel(d.source)} · ${FAMILY_LABELS[headFam]}</div>
      <h2 class="pop-title">${untrusted(title ?? project ?? 'Session')}</h2>
      ${title && project && project !== title ? `<div class="sub">${untrusted(project)}</div>` : ''}
    </div>
    ${CLOSE_BUTTON}
  </header>
  <section class="d-sec"><h3 class="eyebrow">About this session</h3>${about}</section>
  <section class="d-sec">
    <div class="d-grid">
      <div><div class="eyebrow">Cost, whole session</div><div class="d-big">${usd(d.cost)}${d.unpriced ? ' <span class="warn" title="Some models have no rate">+?</span>' : ''}</div>${lifetimeNote}</div>
      <div><div class="eyebrow">Requests</div><div class="d-big">${count(d.tokens.requests)}</div></div>
      <div><div class="eyebrow">Started</div><div class="d-mid">${stamp(d.first, shownZone)}</div><div class="sub">${shownZone}</div></div>
      <div><div class="eyebrow">Last active</div><div class="d-mid">${stamp(d.last, shownZone)}</div><div class="sub">${formatSpan(d.last - d.first)} after start</div></div>
    </div>
  </section>
  ${d.source === 'dsh' ? '<p class="sub">UTC weekday/time estimate; holidays not adjusted. Costs exclude unpriced usage.</p>' : ''}
  <section class="d-sec"><h3 class="eyebrow">Where the cost went</h3><ul class="parts">${parts}</ul></section>
  <section class="d-sec"><h3 class="eyebrow">By day (UTC)</h3><table><thead><tr><th>Day</th><th class="n">Requests</th><th class="n">Cost</th></tr></thead><tbody>${dayRows}</tbody></table></section>
  <section class="d-sec"><h3 class="eyebrow">By model</h3><table><thead><tr><th>Model</th><th class="n">Requests</th><th class="n">Cost</th></tr></thead><tbody>${modelRows}</tbody></table></section>
  ${inUse}`;
}

/** Detail content for a session that is no longer in the store. */
export function renderSessionMissing(): string {
  return `<header class="pop-head"><h2 class="pop-title">Session not found</h2>${CLOSE_BUTTON}</header><p class="sub">This session is not in the usage store any more, for example after Rebuild History.</p>`;
}

/** Detail content when a session's details could not be built. */
export function renderSessionError(): string {
  return `<header class="pop-head"><h2 class="pop-title">Could not load this session</h2>${CLOSE_BUTTON}</header><p class="sub">Try again after the next refresh; the agent-usage-dock output channel has the details.</p>`;
}

const HEALTH_LABELS: Record<string, string> = { ok: 'Ready', incomplete: 'Incomplete', disabled: 'Disabled', 'not-found': 'Not installed' };

/** How a source reads in the header and on its card: working, in need of attention, or quietly absent. */
const healthTone = (status?: string): 'ready' | 'attention' | 'absent' | 'pending' =>
  status === 'ok' ? 'ready' : status === 'incomplete' ? 'attention' : status === 'not-found' ? 'absent' : 'pending';

function renderHealth(s: Summary): string {
  const stamp = (value?: string): string => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : 'Never';
  const sources = SOURCES.map(source => ({ source, h: s.sourceHealth?.[source] }));
  const problems = [...new Set([...(s.health?.problems ?? []), ...sources.flatMap(({ h }) => h?.problems ?? [])])];
  const attention = problems.length > 0 || sources.some(({ h }) => h?.status === 'incomplete');
  // A tool that keeps nothing on this machine is not scanned: it has records or it has none, and they come from a ledger that was brought in.
  const imported = (source: Source): boolean => !isScanned(source) && s.recorded.includes(source);
  const stateOf = (h: { status: string } | undefined, source: Source): string => (isScanned(source) ? (h ? HEALTH_LABELS[h.status] ?? 'Unknown' : 'Not scanned') : imported(source) ? 'Imported' : 'No data');
  const toneOf = (h: { status: string } | undefined, source: Source): ReturnType<typeof healthTone> => (isScanned(source) ? healthTone(h?.status) : imported(source) ? 'ready' : 'absent');
  const flag = attention ? `<span class="health-flag attention"><i class="health-dot"></i>Needs attention${problems.length ? ` · ${plural(problems.length, 'issue')}` : ''}</span>` : '';
  const chips = sources.map(({ source, h }) => `<span class="health-chip ${toneOf(h, source)}"><i class="dot ${source}"></i><b>${SOURCE_LABELS[source]}</b><em>${stateOf(h, source)}</em></span>`).join('');
  const since = text(s.firstDay);
  const card = ({ source, h }: (typeof sources)[number]): string => {
    if (!isScanned(source)) {
      const note = `${SOURCE_LABELS[source]} keeps no usage on this machine, so its records come from a ledger that is brought in.`;
      return `<article class="mcard source-health"><div class="srow1"><i class="dot ${source}"></i><b class="name">${SOURCE_LABELS[source]}</b><span class="health-badge ${imported(source) ? 'ready' : 'pending'}">${stateOf(h, source)}</span></div><p class="health-note">${note}</p></article>`;
    }
    const badge = h?.status === 'ok' ? 'ready' : h?.status === 'incomplete' ? 'attention' : 'pending';
    const facts = h?.status === 'not-found'
      ? `<p class="health-note">No data folder at <code>${untrusted(h.root)}</code>. ${SOURCE_LABELS[source]} is not installed on this machine, or has not run here.</p>`
      : `<dl class="health-facts"><dt>Last success</dt><dd>${esc(stamp(h?.succeededAt))}</dd></dl>${h?.problems.length ? `<p class="health-issue">${untrusted(h.problems[0])}</p>` : ''}${h?.root ? `<details class="diagnostic" data-key="log-folder-${source}"><summary data-focus="log-folder-${source}-toggle">Log folder</summary><code>${untrusted(h.root)}</code></details>` : ''}`;
    return `<article class="mcard source-health"><div class="srow1"><i class="dot ${source}"></i><b class="name">${SOURCE_LABELS[source]}</b><span class="health-badge ${badge}">${stateOf(h, source)}</span></div>${facts}</article>`;
  };
  const paths = s.storage ? [['Ledger file', s.storage.ledger], ['Archive folder', s.storage.archive]].map(([label, where]) => `<p class="mono"><b>${label}</b> ${untrusted(where)}</p>`).join('') : '';
  const title = paths ? (problems.length ? 'Storage and issue details' : 'Storage details') : 'Issue details';
  const storage = paths || problems.length
    ? `<details class="diagnostic" data-key="storage-details"><summary data-focus="storage-details-toggle">${title}</summary>${paths}${problems.length ? `<ul>${problems.map(p => `<li>${untrusted(p)}</li>`).join('')}</ul>` : ''}</details>`
    : '';
  return `<details class="card fold collection" data-key="collection-status"><summary data-focus="collection-toggle"><h2 class="eyebrow">Collection status</h2><span class="health-summary">${flag}${chips}</span></summary>
    <div class="mgrid">${sources.map(card).join('')}</div>
    <div class="collection-foot"><span>Usage since ${esc(since || 'no records yet')}</span><span>Last scan ${esc(stamp(s.health?.attemptedAt))}</span></div>
    ${storage}
    ${s.legacyHistory ? '<p class="banner warn">Legacy aggregate history: exact overlap and model attribution cannot be recovered for deleted logs. Surviving pre-migration records consume the preserved baseline; totals may include unverified legacy usage.</p>' : ''}
  </details>`;
}
