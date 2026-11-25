import type { Config } from './config';
import type { RateOverrides } from './pricing';
import type { LegacyBaseline } from './reconcile';
import type { SessionInfo } from './sessionInfo';
import type { StoreData } from './store';
import type { DisplayZone } from './timeZone';
import type { DayRecord, SessionRecord } from './types';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface OfflineSnapshotConfig {
  rates: RateOverrides;
  correctionFactor: number;
  budgetMode: 'tokens' | 'cost';
  budgetLimit: number;
  tokenBudgetLimit: number;
  warningThreshold: number;
  criticalThreshold: number;
  timeZone: DisplayZone;
  dashboardTheme: 'light' | 'dark';
}

export interface OfflineSnapshot {
  schemaVersion: 1;
  pluginVersion: string;
  exportedAt: string;
  now: number;
  config: OfflineSnapshotConfig;
  data: {
    days: Record<string, DayRecord>;
    sessions: Record<string, SessionRecord>;
    firstDay?: string;
    legacy?: LegacyBaseline;
    health?: StoreData['health'];
    sourceHealth?: StoreData['sourceHealth'];
    active: string[];
  };
  sessionInfos: Record<string, SessionInfo | undefined>;
}

/** Builds a normalized Config object from an OfflineSnapshot for shared dashboard rendering. */
export function snapshotToConfig(snapshot: OfflineSnapshot): Config {
  return {
    dashboardTheme: snapshot.config.dashboardTheme,
    budgetMode: snapshot.config.budgetMode,
    timeZone: snapshot.config.timeZone,
    tooltipChart: true,
    statusBarStyle: 'percent',
    levelIndicator: 'bar',
    tokenBudgetLimit: snapshot.config.tokenBudgetLimit,
    budgetLimit: snapshot.config.budgetLimit,
    warningThreshold: snapshot.config.warningThreshold,
    criticalThreshold: snapshot.config.criticalThreshold,
    pollIntervalSeconds: 60,
    correctionFactor: snapshot.config.correctionFactor,
    rates: snapshot.config.rates,
  };
}

/** Escapes characters that could close or corrupt an inline `<script type="application/json">` block. */
export function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
