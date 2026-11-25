import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { recordedDshSession } from './collectors/dsh';
import type { FileState } from './collectors/lines';
import type { Config } from './config';
import { HOVER_STYLE } from './dashboardHover';
import { OfflineSnapshot, SNAPSHOT_SCHEMA_VERSION, safeJsonForScript, snapshotToConfig } from './offlineSnapshot';
import { dashboardTheme, renderBody, sessionView } from './panelRender';
import { SCRIPT } from './panelScript';
import { STYLE } from './panelStyle';
import { claudeHome, codexHome, dataPaths, dshHome } from './paths';
import { Pricing } from './pricing';
import { activeSessionKeys } from './sessionActivity';
import { findSessionLog, readSessionInfo, type SessionInfo } from './sessionInfo';
import type { StoreData } from './store';
import { summarize } from './summary';
import { isScanned, type SessionRecord } from './types';

export class ExportCancelledError extends Error {
  constructor() {
    super('Offline HTML export cancelled');
  }
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new ExportCancelledError();
};

export interface CollectSessionInfosOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Reads metadata and first-prompt summaries for every recorded session with bounded concurrency.
 * Missing logs or per-session read failures leave that session's entry undefined without failing the export.
 */
export async function collectSessionInfos(
  sessions: Record<string, SessionRecord>,
  files: Record<string, FileState>,
  cfg: Pick<Config, 'antigravityHome' | 'dshHome' | 'claudeHome' | 'codexHome'>,
  options: CollectSessionInfosOptions = {},
): Promise<Record<string, SessionInfo | undefined>> {
  const entries = Object.entries(sessions);
  const infos: Record<string, SessionInfo | undefined> = Object.create(null);
  const total = entries.length;
  if (!total) return infos;

  const brain = dataPaths(cfg.antigravityHome).brain;
  const dshRoot = dshHome(cfg.dshHome);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, total));
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(options.signal);
      const index = next++;
      if (index >= total) return;
      const [key, rec] = entries[index];
      try {
        if (rec.source === 'dsh') {
          const dsh = await recordedDshSession(files, rec.id, dshRoot, undefined, options.signal);
          if (dsh) infos[key] = { file: path.dirname(dsh.file), folder: true, title: dsh.title, firstPrompt: dsh.firstPrompt };
        } else if (isScanned(rec.source)) {
          const file = await findSessionLog(rec.source, rec.id, brain, cfg, files);
          throwIfAborted(options.signal);
          if (file) infos[key] = await readSessionInfo(rec.source, file);
        }
      } catch (err) {
        if (err instanceof ExportCancelledError || options.signal?.aborted) throw new ExportCancelledError();
        // Missing or unreadable log: preserve session usage totals without fabricating log details.
      }
      done++;
      options.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return infos;
}

export interface BuildSnapshotOptions {
  pluginVersion: string;
  now?: number;
  resolvedTheme?: 'light' | 'dark';
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Captures a consistent, point-in-time snapshot of all retained usage, configuration, and session details.
 * Clones the ledger before reading session logs so concurrent background polls cannot introduce drift.
 */
export async function buildOfflineSnapshot(
  data: Pick<StoreData, 'days' | 'sessions' | 'firstDay' | 'legacy' | 'health' | 'sourceHealth' | 'files'>,
  cfg: Config,
  options: BuildSnapshotOptions,
): Promise<OfflineSnapshot> {
  throwIfAborted(options.signal);
  const now = options.now ?? Date.now();
  const cloned = structuredClone({
    days: data.days,
    sessions: data.sessions ?? {},
    firstDay: data.firstDay,
    legacy: data.legacy,
    health: data.health,
    sourceHealth: data.sourceHealth,
    files: data.files,
  });
  const active = [...activeSessionKeys(cloned.files, now)].sort();
  const resolvedTheme: 'light' | 'dark' = cfg.dashboardTheme === 'auto'
    ? (options.resolvedTheme ?? 'light')
    : cfg.dashboardTheme;

  const sessionInfos = await collectSessionInfos(cloned.sessions, cloned.files, {
    antigravityHome: cfg.antigravityHome,
    dshHome: cfg.dshHome,
    claudeHome: claudeHome(cfg.claudeHome),
    codexHome: codexHome(cfg.codexHome),
  }, {
    signal: options.signal,
    onProgress: options.onProgress,
  });

  throwIfAborted(options.signal);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    exportedAt: new Date(now).toISOString(),
    now,
    config: {
      rates: structuredClone(cfg.rates),
      correctionFactor: cfg.correctionFactor,
      budgetMode: cfg.budgetMode === 'cost' ? 'cost' : 'tokens',
      budgetLimit: cfg.budgetLimit,
      tokenBudgetLimit: cfg.tokenBudgetLimit ?? 0,
      warningThreshold: cfg.warningThreshold,
      criticalThreshold: cfg.criticalThreshold,
      timeZone: cfg.timeZone,
      dashboardTheme: resolvedTheme,
    },
    data: {
      days: cloned.days,
      sessions: cloned.sessions,
      firstDay: cloned.firstDay,
      legacy: cloned.legacy,
      health: cloned.health,
      sourceHealth: cloned.sourceHealth,
      active,
    },
    sessionInfos,
  };
}

function defaultOfflineScript(): string {
  const candidates = [
    path.resolve(__dirname, 'offline.js'),
    path.resolve(__dirname, '..', 'dist', 'offline.js'),
    path.resolve(__dirname, '..', '..', 'dist', 'offline.js'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next location
    }
  }
  throw new Error('Could not find offline dashboard bundle (dist/offline.js). Run npm run build first.');
}

/**
 * Generates a self-contained offline HTML document with embedded CSS, JS, snapshot JSON, and strict SHA-256 CSP.
 */
export function renderOfflineHtml(snapshot: OfflineSnapshot, offlineScript = defaultOfflineScript()): string {
  const cfg = snapshotToConfig(snapshot);
  const pricing = new Pricing(cfg.rates, cfg.correctionFactor);
  const active = new Set(snapshot.data.active);
  const summary = summarize({ ...snapshot.data, active }, pricing, snapshot.now);
  const initialBody = renderBody(summary, cfg, sessionView(undefined), { offline: { exportedAt: snapshot.exportedAt } });

  const combinedScript = `${offlineScript}\n${SCRIPT}`;
  const hash = createHash('sha256').update(combinedScript).digest('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; form-action 'none'; base-uri 'none';`;
  const snapshotJson = safeJsonForScript(snapshot);

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>agent-usage-dock · Offline Snapshot</title>
<style>${STYLE}${HOVER_STYLE}</style>
</head><body class="theme-${dashboardTheme(cfg.dashboardTheme)}">
<div id="app" tabindex="-1">${initialBody}</div>
<div id="scrim" hidden></div>
<div id="popup" hidden><div id="pop-card" class="pop-card" tabindex="-1" role="dialog" aria-modal="true" aria-label="Session details"></div></div>
<script id="dock-snapshot" type="application/json">${snapshotJson}</script>
<script>${combinedScript}</script>
</body></html>`;
}
