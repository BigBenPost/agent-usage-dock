import type { Config } from './config';
import { markdownText } from './markup';
import { budgetLevel, budgetMetric } from './statusText';
import { conversationFacts, FAMILIES, FAMILY_LABELS, formatTokensCompact, monthLabel, splitCompactTokens, Summary, usd, zeroFamilies } from './summary';

/** Commands the tooltip links to; the status bar must list exactly these as enabled. */
export const TOOLTIP_COMMANDS = ['agyTokenTracker.openPanel', 'agyTokenTracker.refresh'];

export interface TooltipOptions {
  /** Dark editor theme: picks the chart's text and line colours. */
  dark: boolean;
  /** Draw the daily chart as an image. Off falls back to text. */
  chart: boolean;
}

// Mid-tone colours that read on both light and dark hover backgrounds.
const COLORS = {
  accent: '#2a78d6',
  muted: '#8c8981',
  warning: '#fab219',
  critical: '#d03b3b',
  gemini: '#9334e6',
  opus: '#d4683a',
  deepseek: '#4d6bfe',
  gpt: '#7f79a1',
  composer: '#2f8f83',
  unknown: '#8c8981',
  input: '#1a73e8',
  cache: '#9334e6',
  output: '#188038',
};
const BAR_CELLS = 20;
/** Space between segments of a stacked bar, in the chart's pixels. */
const GAP = 1;

const span = (color: string, text: string): string => `<span style="color:${color};">${text}</span>`;
const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);
const sessionsText = (n: number, floor = false): string => `${n}${floor ? '+' : ''} ${n === 1 && !floor ? 'conversation' : 'conversations'}`;

/** A bar of `▰` and `▱`. Plain glyphs, so it still reads if the hover drops the colour. */
function bar(fraction: number, color: string): string {
  const f = Math.min(1, Math.max(0, fraction));
  const filled = f > 0 ? Math.max(1, Math.round(f * BAR_CELLS)) : 0;
  return span(color, '▰'.repeat(filled)) + span(COLORS.muted, '▱'.repeat(BAR_CELLS - filled));
}

const CARD = {
  dark: {
    bg: '#09090b',
    ink: '#f4f2ff',
    ink2: '#a9a6b8',
    muted: '#6a6779',
    track: '#ffffff1f',
    time: '#ffffff40',
    edge: '#ffffff14',
    gemini: '#c49bff',
    opus: '#ff8a5c',
    deepseek: '#6580ff',
    gpt: '#b0a9c9',
    composer: '#5cc6b6',
    unknown: '#8c8981',
    input: '#7c9cff',
    cache: '#c49bff',
    output: '#6ee7b7',
    warning: '#ffc069',
    critical: '#ff6b7a',
  },
  light: {
    bg: '#eceff3',
    ink: '#141820',
    ink2: '#565d6b',
    muted: '#9399a6',
    track: '#1418201a',
    time: '#14182033',
    edge: '#ffffffcc',
    gemini: '#8e44ad',
    opus: '#d4683a',
    deepseek: '#4d6bfe',
    gpt: '#7f79a1',
    composer: '#2f8f83',
    unknown: '#8c8981',
    input: '#1a73e8',
    cache: '#9334e6',
    output: '#188038',
    warning: '#e0a019',
    critical: '#d03b3b',
  },
};
const CARD_W = 344;
const PAD = 20;
const PLOT_H = 44;

/**
 * The whole hover as one SVG card, showing month total, month progress meter, daily stacked bars (In/Cache/Out),
 * split by token category and today.
 */
export function chartSvg(s: Summary, cfg: Config, dark: boolean): string {
  const c = dark ? CARD.dark : CARD.light;
  const W = CARD_W - 2 * PAD;
  const tokenLimit = cfg.budgetMode === 'cost' ? 0 : (cfg.tokenBudgetLimit ?? 0) * 1e6;
  const budget = tokenLimit > 0;

  const byDay = new Map(s.days.map((d) => [d.day, d]));
  const max = Math.max(0, ...s.days.map((d) => d.tokensTotal ?? 0));
  const slot = W / s.daysInMonth;
  const barW = Math.min(slot * 0.5, 5);
  const daysLeft = s.daysInMonth - s.dayOfMonth;

  const meter = (y: number, f: number, fill: string, label: string, right: string, glow: boolean): string => {
    const w = (W * Math.min(1, Math.max(0, f))).toFixed(1);
    return `<text x="0" y="${y}" font-size="11" fill="${c.ink2}">${label}</text><text x="${W}" y="${y}" font-size="11" fill="${c.muted}" text-anchor="end">${right}</text>`
      + `<rect x="0" y="${y + 7}" width="${W}" height="3" rx="1.5" fill="${c.track}"/>`
      + (glow ? `<rect x="0" y="${y + 7}" width="${w}" height="3" rx="1.5" fill="${fill}" opacity="0.7" filter="url(#glow)"/>` : '')
      + `<rect x="0" y="${y + 7}" width="${w}" height="3" rx="1.5" fill="${fill}"/>`;
  };

  const y = 108;
  const meters = meter(
    y,
    s.dayOfMonth / s.daysInMonth,
    c.time,
    `day ${s.dayOfMonth} of ${s.daysInMonth}`,
    daysLeft === 0 ? 'last day' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`,
    false,
  );

  const top = y + 24;
  const bars: string[] = [];
  for (let i = 1; i <= s.daysInMonth; i++) {
    const cx = (i - 1) * slot + slot / 2;
    const d = byDay.get(`${s.month}-${String(i).padStart(2, '0')}`);
    if (i > s.dayOfMonth && !(d?.tokensTotal && d.tokensTotal > 0)) {
      bars.push(`<circle cx="${cx.toFixed(1)}" cy="${PLOT_H - 1}" r="1" fill="${c.muted}"/>`);
      continue;
    }
    if (!d) continue;

    const dayTok = d.tokensTotal ?? 0;
    if (dayTok <= 0 || max <= 0) continue;
    const x = (cx - barW / 2).toFixed(1);
    const fams = d.tokensByFamily ?? zeroFamilies();
    let curY = PLOT_H;
    let occupied = false;
    for (const family of FAMILIES) {
      if (!(fams[family] > 0)) continue;
      const height = Math.max(1.5, (fams[family] / max) * (PLOT_H - GAP));
      curY -= height + (occupied ? GAP : 0);
      bars.push(`<rect x="${x}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${height.toFixed(1)}" rx="1.2" fill="${c[family]}"/>`);
      occupied = true;
    }
  }
  bars.push(`<circle cx="${((s.dayOfMonth - 1) * slot + slot / 2).toFixed(1)}" cy="${PLOT_H + 6}" r="1.6" fill="${c.ink}"/>`);

  const pace = budget ? tokenLimit / s.daysInMonth : 0;
  if (pace > 0 && max > 0 && pace <= max) {
    const py = (PLOT_H - (pace / max) * PLOT_H).toFixed(1);
    bars.unshift(dark
      ? `<line x1="0" x2="${W}" y1="${py}" y2="${py}" stroke="#c49bff" stroke-width="2.5" opacity="0.35" filter="url(#glow)"/><line x1="0" x2="${W}" y1="${py}" y2="${py}" stroke="#c49bff" stroke-width="0.75" opacity="0.8"/>`
      : `<line x1="0" x2="${W}" y1="${py}" y2="${py}" stroke="${c.ink2}" stroke-width="0.75" stroke-dasharray="2 2" opacity="0.6"/>`);
  }
  const empty = max > 0 ? '' : `<text x="${W / 2}" y="${PLOT_H / 2}" font-size="11" fill="${c.muted}" text-anchor="middle">No usage yet this month</text>`;

  const legendY = top + PLOT_H + 26;
  const famList = FAMILIES.map((key) => ({ key, label: FAMILY_LABELS[key], color: c[key], count: s.tokensByFamily?.[key] ?? 0 }));
  const activeFams = famList.filter((f) => f.count > 0);
  const items = activeFams.length > 0 ? activeFams : [famList[0]];
  const colX = items.map((_, i) => (i % 2) * 160);
  const totalTokens = s.tokensTotal;
  const legend = items.map((it, i) => {
    const x = colX[i];
    const y = legendY + Math.floor(i / 2) * 18;
    return `<circle cx="${x + 3.5}" cy="${y - 3.5}" r="3" fill="${it.color}"/><text x="${x + 11}" y="${y}" font-size="11" fill="${c.ink2}">${it.label} <tspan fill="${c.ink}" font-weight="500">${formatTokensCompact(it.count)}</tspan> ${pct(it.count, totalTokens).toFixed(0)}%</text>`;
  }).join('');

  const footY = legendY + Math.ceil(items.length / 2) * 18;
  const H = footY + 26;
  const talks = conversationFacts(s);
  const extra = talks?.count ? ` · ${sessionsText(talks.count, talks.floor)} · avg ${formatTokensCompact(talks.averageTokens)}` : '';

  const month = `${monthLabel(s.month)} · UTC`.toUpperCase();
  const { whole, fraction } = splitCompactTokens(s.tokensTotal);
  const budgetRight = budget
    ? `<text x="${W}" y="78" font-size="11.5" fill="${c.ink2}" text-anchor="end">of ${formatTokensCompact(tokenLimit)} budget</text>`
    : '';
  const heroFigureSvg = `<text x="0" y="78" fill="url(#fig)" font-weight="200"><tspan font-size="26" fill="${c.muted}">~</tspan><tspan font-size="48" letter-spacing="-2">${whole}</tspan><tspan font-size="19" fill="${c.muted}" dy="-20" dx="2">${fraction}</tspan></text>${budgetRight}`;

  const todayDisplay = formatTokensCompact(s.todayTokens);

  const backdrop = dark
    ? [['8%', '0%', '70%', '#ff8a5c', 0.22], ['95%', '10%', '65%', '#7c9cff', 0.2], ['55%', '105%', '60%', '#b794ff', 0.14]]
        .map(([cx, cy, r, color, o], i) => `<radialGradient id="a${i}" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="${color}" stop-opacity="${o}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`)
        .join('')
    : `<clipPath id="clip"><rect width="${CARD_W}" height="${H}" rx="10"/></clipPath><filter id="mist" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>`;
  const wash = dark
    ? [0, 1, 2].map((i) => `<rect width="${CARD_W}" height="${H}" rx="10" fill="url(#a${i})"/>`).join('')
    : `<g clip-path="url(#clip)"><g filter="url(#mist)"><ellipse cx="20" cy="0" rx="180" ry="110" fill="#ffc9b3" opacity="0.3"/><ellipse cx="340" cy="20" rx="170" ry="120" fill="#b5c6ff" opacity="0.33"/></g><rect width="${CARD_W}" height="${H}" fill="#ffffff" fill-opacity="0.5"/></g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${H}" viewBox="0 0 ${CARD_W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Ubuntu,'Droid Sans',sans-serif" text-rendering="geometricPrecision">`
    + `<defs><linearGradient id="acc"><stop offset="0" stop-color="#7c9cff"/><stop offset="1" stop-color="#c49bff"/></linearGradient>`
    + `<linearGradient id="fig" x1="0" y1="0" x2="0" y2="1"><stop offset="0.3" stop-color="${c.ink}"/><stop offset="1" stop-color="${c.ink}" stop-opacity="${dark ? 0.55 : 1}"/></linearGradient>`
    + `<filter id="glow" x="-10%" y="-300%" width="120%" height="700%"><feGaussianBlur stdDeviation="2.5"/></filter>${backdrop}</defs>`
    + `<rect width="${CARD_W}" height="${H}" rx="10" fill="${c.bg}"/>${wash}`
    + `<rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${H - 1}" rx="9.5" fill="none" stroke="${c.edge}"/>`
    + `<g transform="translate(${PAD},0)">`
    + `<text x="0" y="28" font-size="9" letter-spacing="1.2" fill="${c.muted}" font-weight="500">AGENT-USAGE-DOCK</text>`
    + `<text x="${W}" y="28" font-size="9" letter-spacing="1.0" fill="${c.muted}" text-anchor="end">${month}</text>`
    + heroFigureSvg
    + meters
    + `<g transform="translate(0,${top})">${bars.join('')}<line x1="0" x2="${W}" y1="${PLOT_H + 1.5}" y2="${PLOT_H + 1.5}" stroke="${c.track}"/>${empty}</g>`
    + legend
    + `<line x1="0" x2="${W}" y1="${footY - 4}" y2="${footY - 4}" stroke="${c.track}"/>`
    + `<text x="0" y="${footY + 12}" font-size="11" fill="${c.ink2}">Today <tspan fill="${c.ink}" font-weight="500">${todayDisplay}</tspan>${extra}</text>`
    + `</g></svg>`;
}

/** Markdown for the status bar hover. */
export function tooltipMarkdown(s: Summary, cfg: Config, opts: TooltipOptions = { dark: false, chart: true }): string {
  const money = cfg.budgetMode === 'cost';
  const tokenLimit = money ? 0 : (cfg.tokenBudgetLimit ?? 0) * 1e6;
  const metric = budgetMetric(s, cfg);
  const ratio = metric.limit > 0 ? metric.used / metric.limit : 0;
  const level = budgetLevel(s, cfg);
  const daysLeft = s.daysInMonth - s.dayOfMonth;
  const talks = conversationFacts(s);

  const out: string[] = [];
  if (opts.chart) {
    const alt = `agent-usage-dock: ${formatTokensCompact(s.tokensTotal)} tokens, today ${formatTokensCompact(s.todayTokens)}`;
    out.push(`![${alt}](data:image/svg+xml;base64,${Buffer.from(chartSvg(s, cfg, opts.dark)).toString('base64')})`);
  } else {
    out.push(`**agent-usage-dock** · ${monthLabel(s.month)} (UTC)`);
    out.push(`## ~${formatTokensCompact(s.tokensTotal)}${tokenLimit > 0 ? ` ${span(COLORS.muted, `of ${formatTokensCompact(tokenLimit)}`)}` : ''}`);
    out.push(`${bar(s.dayOfMonth / s.daysInMonth, COLORS.muted)} &nbsp;**day ${s.dayOfMonth} of ${s.daysInMonth}** · ${daysLeft === 0 ? 'last day' : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left`}`);
  }

  if (money) out.push(`Estimated cost: **${usd(s.total)}${s.unpriced.length ? ' + ?' : ''}**${metric.limit ? ` of ${usd(metric.limit)} budget` : ''}. Current rates; not an invoice.`);
  if (level === 'critical' && metric.limit > 0) {
    out.push(`$(error) ${ratio > 1 ? `Over budget by ${metric.format(metric.used - metric.limit)}` : ratio === 1 ? 'Budget reached' : 'Close to the budget'}`);
  } else if (level === 'warning' && metric.limit > 0) {
    out.push('$(warning) Budget is filling up');
  }

  if (!opts.chart) {
    out.push(
      `🔵 In **${formatTokensCompact(s.tokensBucket.input)}** &nbsp;&nbsp; 🟣 Cache **${formatTokensCompact(s.tokensBucket.cacheRead)}** &nbsp;&nbsp; 🟢 Out **${formatTokensCompact(s.tokensBucket.output)}**  \n`
        + `Today **${formatTokensCompact(s.todayTokens)}**${talks?.count ? ` ${span(COLORS.muted, `· ${sessionsText(talks.count, talks.floor)} · avg ${formatTokensCompact(talks.averageTokens)}`)}` : ''}`,
    );
  }

  if (s.unpriced?.length) {
    out.push(`$(warning) Unpriced usage: ${s.unpriced.map((m) => `\`${markdownText(m)}\``).join(', ')}`);
  }
  const since = markdownText(s.firstDay, 40);
  out.push(span(COLORS.muted, `Estimate from this machine's logs${since ? ` since ${since}` : ''}`));
  out.push('[$(link-external) Dashboard](command:agyTokenTracker.openPanel) &nbsp;&nbsp; [$(refresh) Refresh](command:agyTokenTracker.refresh)');

  return out.join('\n\n');
}
