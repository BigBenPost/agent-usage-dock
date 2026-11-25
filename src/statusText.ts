import type { Config } from './config';
import { formatTokensCompact, Summary, usd } from './summary';

export type StatusBarStyle = 'percent' | 'gauge' | 'ring';

/** Dollars for the status bar: cents below $10, whole dollars from there. */
export function compactUsd(n: number): string {
  return n >= 10 ? `$${Math.round(n)}` : usd(n);
}

/** A ring that fills in quarters with the budget used: ○ ◔ ◑ ◕ ●. */
export function ringGlyph(ratio: number): string {
  return ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.max(0, Math.round(ratio * 4)))];
}

/** A block that rises in eighths with the budget used: ▁ to █. The nearest of eight, never empty. */
export function gaugeGlyph(ratio: number): string {
  return ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'][Math.min(8, Math.max(1, Math.round(ratio * 8))) - 1];
}

/**
 * The whole-number share for the status bar. Under the budget it never reads 100%, and just over it reads "100%+" rather
 * than 100% or a misleading 101%.
 */
export function pctShort(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  if (ratio < 1) return `${Math.min(99, rounded)}%`;
  if (ratio > 1 && rounded <= 100) return '100%+';
  return `${rounded}%`;
}

/**
 * `12k | 304k` or `12k | 304k · 61%` (today tokens, month tokens, share of budget used).
 */
export function statusBarText(s: Summary, cfg: Config): string {
  const metric = budgetMetric(s, cfg);
  const tokenLimit = metric.limit;
  const amounts = cfg.budgetMode === 'cost' ? `${compactUsd(s.todayTotal)} | ${compactUsd(s.total)}${s.unpriced.length ? ' +?' : ''}` : `${formatTokensCompact(s.todayTokens)} | ${formatTokensCompact(s.tokensTotal)}`;
  if (tokenLimit <= 0) return amounts;

  const ratio = metric.used / tokenLimit;
  if (cfg.statusBarStyle === 'gauge') return `${gaugeGlyph(ratio)} ${amounts}`;
  if (cfg.statusBarStyle === 'ring') return `${ringGlyph(ratio)} ${amounts}`;
  return `${amounts} · ${pctShort(ratio)}`;
}

/** For screen readers, which would otherwise read the glyphs and miss the colour of the level bar. */
export function statusBarLabel(s: Summary, cfg: Config): string {
  const metric = budgetMetric(s, cfg);
  const amounts = cfg.budgetMode === 'cost'
    ? `estimated cost ${usd(s.todayTotal)} today, ${usd(s.total)} this month${s.unpriced.length ? ', plus unpriced usage' : ''}`
    : `${formatTokensCompact(s.todayTokens)} today, ${formatTokensCompact(s.tokensTotal)} this month`;
  if (metric.limit <= 0) return `agent-usage-dock: ${amounts}`;
  const ratio = metric.used / metric.limit;
  const level = budgetLevel(s, cfg);
  const state = level === 'critical'
    ? (metric.used > metric.limit ? ', over budget' : metric.used === metric.limit ? ', budget reached' : ', close to the budget')
    : level === 'warning'
      ? ', budget is filling up'
      : '';
  return `agent-usage-dock: ${amounts}, ${pctShort(ratio)} of ${metric.format(metric.limit)}${state}`;
}

export type BudgetLevel = 'ok' | 'warning' | 'critical';

/** Without a budget there is nothing to be close to, whatever the thresholds say (a threshold of 0 would otherwise always trip). */
export function budgetLevel(s: Summary, cfg: Config): BudgetLevel {
  const metric = budgetMetric(s, cfg);
  if (metric.limit <= 0) return 'ok';
  const ratio = metric.used / metric.limit;
  return ratio >= cfg.criticalThreshold ? 'critical' : ratio >= cfg.warningThreshold ? 'warning' : 'ok';
}

export type LevelBar = 'green' | 'amber' | 'red';

/** The colour of the bar in front of the status bar item: green until the warning threshold. Nothing without a budget, since there is nothing to measure against. */
export function levelBar(s: Summary, cfg: Config): LevelBar | undefined {
  if (budgetMetric(s, cfg).limit <= 0) return undefined;
  const level = budgetLevel(s, cfg);
  return level === 'critical' ? 'red' : level === 'warning' ? 'amber' : 'green';
}

export function budgetMetric(s: Summary, cfg: Config): { used: number; limit: number; label: string; format: (n: number) => string } {
  return cfg.budgetMode === 'cost'
    ? { used: s.total, limit: cfg.budgetLimit, label: 'Estimated cost', format: usd }
    : { used: s.tokensTotal, limit: (cfg.tokenBudgetLimit ?? 0) * 1e6, label: 'Token', format: formatTokensCompact };
}
