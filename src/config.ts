import * as vscode from 'vscode';
import { normalizeConfig } from './configValues';
import { RateOverrides } from './pricing';
import type { StatusBarStyle } from './statusText';
import type { DisplayZone } from './timeZone';
import { isObject } from './validation';

export const SECTION = 'agyTokenTracker';
export const LEGACY_SECTION = 'agyTokenMonitor';

export type DashboardTheme = 'light' | 'auto' | 'dark';

/** How the status bar shows the budget level: a thin bar in front of the mark, or a ring with a dot after the text. */
export type LevelIndicator = 'bar' | 'ring';

export interface Config {
  dashboardTheme: DashboardTheme;
  budgetMode?: 'tokens' | 'cost';
  /** Zone for the times on session cards and in the popup. Billing months and days stay UTC. */
  timeZone: DisplayZone;
  tooltipChart: boolean;
  statusBarStyle: StatusBarStyle;
  levelIndicator: LevelIndicator;
  antigravityHome?: string;
  antigravityEnabled?: boolean;
  dshHome?: string;
  dshEnabled?: boolean;
  claudeHome?: string;
  claudeEnabled?: boolean;
  codexHome?: string;
  codexEnabled?: boolean;
  tokenBudgetLimit?: number;
  budgetLimit: number;
  warningThreshold: number;
  criticalThreshold: number;
  pollIntervalSeconds: number;
  correctionFactor: number;
  rates: RateOverrides;
}

const MACHINE_KEYS = new Set(['antigravityHome', 'antigravityEnabled', 'dshHome', 'dshEnabled', 'claudeHome', 'claudeEnabled', 'codexHome', 'codexEnabled']);
const KEYS = [...MACHINE_KEYS, 'budgetMode', 'dashboardTheme', 'timeZone', 'tooltipChart', 'statusBarStyle', 'levelIndicator', 'tokenBudgetLimit', 'budgetLimit', 'warningThreshold', 'criticalThreshold', 'pollIntervalSeconds', 'correctionFactor', 'rates'];

export function settingTarget(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
  const value = config.inspect(key);
  if (!MACHINE_KEYS.has(key)) {
    if (value?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
    if (value?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

/** `over` laid on `base`, object by object, as VS Code lays one scope of an object setting on the one below. Neither is changed. */
function overlay(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(over)) {
    const below = out.get(key);
    out.set(key, isObject(value) ? overlay(isObject(below) ? below : {}, value) : value);
  }
  return Object.fromEntries(out);
}

/**
 * The value of an object setting across its scopes, the user's first and the folder's last, or undefined when no scope sets it. Taking only
 * the nearest scope would let a workspace that sets one model's rate drop every other rate of the user.
 */
function mergedScopes(inspected?: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }): unknown {
  const scopes = [inspected?.globalValue, inspected?.workspaceValue, inspected?.workspaceFolderValue];
  if (scopes.every((value) => value === undefined || value === null)) return undefined;
  return scopes.reduce<Record<string, unknown>>((merged, value) => (isObject(value) ? overlay(merged, value) : merged), {});
}

/**
 * The rates in the one scope that Configure Rates saves to, which is what it edits: `readConfig().rates` joins every scope, and writing
 * that back would copy the user's rates into a workspace file. The old section's rates stand in while the new section has none, so the
 * first save carries them over.
 */
export function ownRates(config: vscode.WorkspaceConfiguration): RateOverrides {
  const inspected = config.inspect('rates');
  const target = settingTarget(config, 'rates');
  const scope = target === vscode.ConfigurationTarget.WorkspaceFolder ? inspected?.workspaceFolderValue : target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
  const rates = mergedScopes(inspected) === undefined ? mergedScopes(vscode.workspace.getConfiguration(LEGACY_SECTION).inspect('rates')) : scope;
  return isObject(rates) ? rates as RateOverrides : {};
}

/** Effective rates after removing one model only from the scope the editor will write. */
export function inheritedRates(config: vscode.WorkspaceConfiguration, model: string): RateOverrides {
  const inspected = { ...config.inspect('rates') };
  const target = settingTarget(config, 'rates');
  const key = target === vscode.ConfigurationTarget.WorkspaceFolder ? 'workspaceFolderValue'
    : target === vscode.ConfigurationTarget.Workspace ? 'workspaceValue' : 'globalValue';
  const own = inspected[key];
  if (isObject(own)) {
    const rest = { ...own };
    delete rest[model];
    inspected[key] = rest;
  }
  return (mergedScopes(inspected) ?? {}) as RateOverrides;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration(SECTION);
  const legacy = vscode.workspace.getConfiguration(LEGACY_SECTION);
  const raw: Record<string, unknown> = {};
  for (const k of KEYS) {
    const explicit = (config: vscode.WorkspaceConfiguration): unknown => {
      const v = config.inspect(k);
      if (k === 'rates') return mergedScopes(v);
      return MACHINE_KEYS.has(k) ? v?.globalValue : v?.workspaceFolderValue ?? v?.workspaceValue ?? v?.globalValue;
    };
    raw[k] = explicit(c) ?? explicit(legacy) ?? (MACHINE_KEYS.has(k) ? c.inspect(k)?.defaultValue : c.get(k));
  }
  return normalizeConfig(raw);
}
