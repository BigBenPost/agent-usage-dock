import type { Config } from './config';
import type { RateOverrides } from './pricing';
import { isDisplayZone } from './timeZone';

/** Timers hold at most 2^31 ms (24.8 days); beyond that Node fires every millisecond. A day is far more than anyone needs. */
const MAX_POLL_SECONDS = 86_400;

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/**
 * Turns whatever the settings hold into a usable Config. Settings are free-form JSON: a string where a number belongs
 * (`"pollIntervalSeconds": "x"`) must fall back to the default instead of becoming NaN in a timer or a division.
 */
export function normalizeConfig(raw: Record<string, unknown>): Config {
  const theme = raw.dashboardTheme;
  const style = raw.statusBarStyle;
  return {
    antigravityEnabled: raw.antigravityEnabled !== false,
    claudeEnabled: raw.claudeEnabled !== false,
    codexEnabled: raw.codexEnabled !== false,
    dshEnabled: raw.dshEnabled !== false,
    dshHome: typeof raw.dshHome === 'string' ? raw.dshHome : '',
    claudeHome: typeof raw.claudeHome === 'string' ? raw.claudeHome : '',
    codexHome: typeof raw.codexHome === 'string' ? raw.codexHome : '',
    budgetMode: raw.budgetMode === 'cost' ? 'cost' : 'tokens',
    dashboardTheme: theme === 'auto' || theme === 'dark' ? theme : 'light',
    timeZone: isDisplayZone(raw.timeZone) ? raw.timeZone : 'SGT',
    tooltipChart: raw.tooltipChart !== false,
    statusBarStyle: style === 'gauge' || style === 'ring' ? style : 'percent',
    levelIndicator: raw.levelIndicator === 'ring' ? 'ring' : 'bar',
    antigravityHome: typeof raw.antigravityHome === 'string' && raw.antigravityHome ? raw.antigravityHome : '',
    tokenBudgetLimit: num(raw.tokenBudgetLimit, 0, 0),
    budgetLimit: num(raw.budgetLimit, 0, 0),
    warningThreshold: num(raw.warningThreshold, 0.75, 0, 1),
    criticalThreshold: Math.max(num(raw.warningThreshold, 0.75, 0, 1), num(raw.criticalThreshold, 0.9, 0, 1)),
    pollIntervalSeconds: num(raw.pollIntervalSeconds, 60, 15, MAX_POLL_SECONDS),
    correctionFactor: num(raw.correctionFactor, 1, 0),
    rates: raw.rates && typeof raw.rates === 'object' && !Array.isArray(raw.rates) ? (raw.rates as RateOverrides) : {},
  };
}
