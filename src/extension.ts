import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { recordedDshSession, type RecordedDshSession } from './collectors/dsh';
import { archiveDir, backupDir } from './backup';
import { installCli } from './cliInstall';
import { Config, inheritedRates, ownRates, readConfig, SECTION, settingTarget } from './config';
import { SessionProvider, UsagePanel } from './panel';
import { buildOfflineSnapshot, ExportCancelledError, renderOfflineHtml } from './offlineExport';
import { renderSessionDetail, renderSessionError, renderSessionMissing } from './panelHtml';
import { dataPaths, dshHome, sharedCliFile, sharedDir, sharedStoreFile } from './paths';
import { Pricing, type Rate } from './pricing';
import { rateChoices, rateOverride } from './rateEdit';
import { UsageStatusBar } from './statusBar';
import { UsageRuntime, type UsageSnapshot } from './usageRuntime';
import { activeSessionKeys } from './sessionActivity';
import { buildSessionDetail, findSession } from './sessionDetail';
import { findSessionLog, readSessionInfo } from './sessionInfo';
import { pinnedMonth, summarize, Summary, toCsv } from './summary';
import { isDisplayZone } from './timeZone';
import { TOKEN_KEYS, type SessionRecord } from './types';

const RETRY = 'Retry';
const OPEN_DATA_FOLDER = 'Open Data Folder';
const SHOW_LOG = 'Show Log';
declare const __DOCK_BUNDLE_VERSION__: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('agent-usage-dock');
  const statusBar = new UsageStatusBar();
  context.subscriptions.push(log, statusBar);

  let cfg: Config = readConfig();
  let pricing = new Pricing(cfg.rates, cfg.correctionFactor);
  const runtime = new UsageRuntime();
  context.subscriptions.push(runtime);
  let store: { data: UsageSnapshot } | undefined;
  let summary: Summary | undefined;
  let viewMonth: string | undefined;
  let inFlight: Promise<void> | undefined;
  let rerun = false;
  let timer: NodeJS.Timeout | undefined;
  let armedSeconds: number | undefined;
  let loading: Promise<void> | undefined;
  let warning: Promise<void> | undefined;
  let loadFailure: string | undefined;
  let reportedFailure = '';
  let lastProblems = '';
  const cancellation = new AbortController();
  context.subscriptions.push({ dispose: () => cancellation.abort() });

  const stamp = () => new Date().toISOString();
  const activeKeys = (): Set<string> => activeSessionKeys(store?.data.files ?? {}, Date.now());
  const input = (data: UsageSnapshot) => ({ ...data, active: activeKeys(), storage: { ledger: sharedStoreFile(), archive: archiveDir(sharedStoreFile()) } });

  const dashboard = (): Summary | undefined => (store && summary && viewMonth ? summarize(input(store.data), pricing, Date.now(), viewMonth) : summary);

  const render = (): void => {
    if (!store) return;
    summary = summarize(input(store.data), pricing);
    viewMonth = pinnedMonth(viewMonth, summary.months, summary.month);
    statusBar.update(summary, cfg);
    const shown = dashboard();
    if (UsagePanel.isOpen && shown) UsagePanel.update(shown, cfg);
  };

  const loadStore = (): Promise<void> => (loading ??= (async () => {
    try {
      const opened = await runtime.load();
      for (const aside of opened.recovered ?? []) {
        log.appendLine('Corrupt store preserved at ' + aside);
        void vscode.window.showWarningMessage('agent-usage-dock: damaged working store preserved; recovering from the archive.');
      }
      store = { data: opened.data };
      loadFailure = undefined;
      if (reportedFailure) log.appendLine(`${stamp()} stored usage loaded after an earlier failure`);
      reportedFailure = '';
      render();
      // Stable copy of the CLI. Waiting for its lock must not hold the commands back.
      void installCli(path.join(context.extensionPath, 'dist', 'cli.js'), sharedCliFile()).catch((err) => {
        log.appendLine(`Could not install CLI: ${err}`);
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      loadFailure = text;
      if (text !== reportedFailure) {
        reportedFailure = text;
        log.appendLine(`${stamp()} could not load stored usage: ${err instanceof Error ? err.stack : text}`);
      }
      statusBar.showError('could not load stored usage');
    }
  })().finally(() => { loading = undefined; }));

  const ensureStore = async (): Promise<{ data: UsageSnapshot } | undefined> => {
    if (!store) await loadStore();
    return store;
  };

  const unavailable = (): Promise<void> => {
    if (warning) return warning;
    const shown: Promise<void> = (async () => {
      const message = loadFailure
        ? `agent-usage-dock could not load its stored usage: ${loadFailure}`
        : 'agent-usage-dock is still loading its stored usage. Try again in a moment.';
      const choice = await vscode.window.showWarningMessage(message, RETRY, OPEN_DATA_FOLDER, SHOW_LOG);
      warning = undefined;
      if (choice === RETRY) {
        if (await ensureStore()) void poll();
        else await unavailable();
      } else if (choice === OPEN_DATA_FOLDER) {
        await vscode.env.openExternal(vscode.Uri.file(sharedDir()));
      } else if (choice === SHOW_LOG) {
        log.show(true);
      }
    })().finally(() => { if (warning === shown) warning = undefined; });
    return (warning = shown);
  };

  const runPoll = async (rebuild = false): Promise<void> => {
    const current = await ensureStore();
    if (!current) return;
    const started = Date.now();
    try {
      const reply = await runtime.refresh(cfg, rebuild);
      current.data = reply.data;
      const { changed, files, problems, backup } = reply.result!;
      if (reply.pruneError) log.appendLine(`${stamp()} could not forget logs that are gone: ${reply.pruneError}`);
      if (backup) log.appendLine(`${stamp()} rebuild: history saved to ${backup}`);
      render();
      const unread = problems.join('\n');
      if (unread !== lastProblems) {
        lastProblems = unread;
        if (unread) log.appendLine(`${stamp()} unreadable logs:\n${unread}`);
      }
      if (changed) {
        log.appendLine(`${stamp()} ${changed} usage records added or updated from ${files} files in ${Date.now() - started} ms`);
      }
    } catch (err) {
      log.appendLine(`${stamp()} poll failed: ${err instanceof Error ? err.stack : String(err)}`);
      statusBar.showError(err instanceof Error ? err.message : String(err));
      return;
    }
  };

  const setTimeZone = (zone: unknown): void => {
    if (!isDisplayZone(zone)) return;
    const config = vscode.workspace.getConfiguration(SECTION);
    void Promise.resolve(config.update('timeZone', zone, settingTarget(config, 'timeZone'))).then(undefined, (err) =>
      log.appendLine(`${stamp()} could not save time zone: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  let cachedDsh: { id: string; session: RecordedDshSession } | undefined;
  const dshSession = async (current: { data: UsageSnapshot }, id: string) => {
    const session = await recordedDshSession(current.data.files, id, dshHome(cfg.dshHome), cachedDsh?.id === id ? cachedDsh.session : undefined, cancellation.signal);
    if (session) cachedDsh = { id, session };
    return session;
  };
  const sessionLog = (rec: SessionRecord) => findSessionLog(rec.source, rec.id, dataPaths(cfg.antigravityHome).brain, cfg, store?.data.files);

  const configureRates = async (): Promise<void> => {
    const shown = dashboard();
    if (!shown) return;
    const choices = rateChoices(shown.models, pricing);
    if (!choices.length) {
      void vscode.window.showInformationMessage('agent-usage-dock: no models recorded in the selected month.');
      return;
    }
    const choice = await vscode.window.showQuickPick(choices, { title: 'Configure Rates', placeHolder: 'Choose a model and provider route', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    const labels: Record<keyof Rate, string> = { input: 'Input', output: 'Output', cacheRead: 'Cache read', cacheWrite: 'Cache write', cacheWrite1h: 'Cache write (1h)' };
    const rateConfig = vscode.workspace.getConfiguration(SECTION);
    const existing = ownRates(rateConfig)[choice.key];
    const inheritedOverrides = inheritedRates(rateConfig, choice.key);
    const fallback = new Pricing(inheritedOverrides).rateFor(choice.model.model, choice.model.source, choice.provider);
    const inherited: Partial<Rate> = {};
    const answers: Partial<Record<keyof Rate, string>> = {};
    for (const key of TOKEN_KEYS) {
      if (fallback && !fallback.missing?.includes(key)) inherited[key] = key === 'cacheWrite1h' ? fallback.cacheWrite1h ?? fallback.cacheWrite : fallback[key];
      const value = await vscode.window.showInputBox({
        title: `${choice.label} · ${labels[key]}`,
        value: existing?.[key]?.toString() ?? '',
        prompt: `USD per million tokens. Blank follows ${inherited[key] ?? 'the inherited rate (currently unpriced)'}.`,
        ignoreFocusOut: true,
        validateInput: text => !text.trim() || (Number.isFinite(Number(text)) && Number(text) >= 0) ? undefined : 'Enter a non-negative rate or leave it blank',
      });
      if (value === undefined) return;
      answers[key] = value;
    }
    const config = vscode.workspace.getConfiguration(SECTION);
    const rates = { ...ownRates(config) };
    const override = rateOverride(answers, inherited);
    if (Object.keys(override).length) rates[choice.key] = override;
    else delete rates[choice.key];
    if (!existing && !Object.keys(override).length) return;
    await config.update('rates', rates, settingTarget(config, 'rates'));
  };

  const sessionProvider: SessionProvider = {
    detail: async (key) => {
      try {
        const current = store;
        const rec = findSession(current?.data.sessions, key);
        if (!current || !rec) return renderSessionMissing();
        const dsh = rec.source === 'dsh' ? await dshSession(current, rec.id) : undefined;
        const file = rec.source === 'dsh' ? dsh?.file : await sessionLog(rec);
        const info = dsh ? { ...dsh, file: path.dirname(dsh.file), folder: true }
          : file ? await readSessionInfo(rec.source, file).catch(() => undefined) : undefined;
        return renderSessionDetail(buildSessionDetail(key, rec, pricing, viewMonth ?? summary?.month ?? '', info, activeKeys().has(key)), cfg.timeZone);
      } catch (err) {
        log.appendLine(`${stamp()} session details failed: ${err instanceof Error ? err.stack : String(err)}`);
        return renderSessionError();
      }
    },
    openLog: async (key) => {
      try {
        const current = store;
        const rec = findSession(current?.data.sessions, key);
        const file = !current ? undefined : rec?.source === 'dsh' ? (await dshSession(current, rec.id))?.file : rec && await sessionLog(rec);
        if (!file) {
          void vscode.window.showInformationMessage('agent-usage-dock: log file not found.');
          return;
        }
        if (rec?.source === 'dsh') { await vscode.env.openExternal(vscode.Uri.file(path.dirname(file))); return; }
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      } catch (err) {
        void vscode.window.showWarningMessage(`agent-usage-dock: could not open log (${err instanceof Error ? err.message : String(err)}).`);
      }
    },
    setMonth: (requested) => {
      if (!summary) return;
      viewMonth = pinnedMonth(requested, summary.months, summary.month);
      render();
    },
    setTimeZone,
    configureRates,
  };

  /** One poll at a time. A settings change that arrives mid-poll sets `rerun`, so the changed settings are read once more afterwards. */
  const start = (rebuild = false): Promise<void> => (inFlight = (async () => {
    try {
      await runPoll(rebuild);
      while (rerun) {
        rerun = false;
        await runPoll();
      }
    } finally {
      inFlight = undefined;
    }
  })());
  const poll = (): Promise<void> => inFlight ?? start();

  const schedule = (): void => {
    if (timer) clearInterval(timer);
    armedSeconds = cfg.pollIntervalSeconds;
    timer = setInterval(() => void poll(), armedSeconds * 1000);
  };

  const setBudget = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration(SECTION);
    const money = cfg.budgetMode === 'cost';
    const current = money ? cfg.budgetLimit : cfg.tokenBudgetLimit ?? 0;
    const value = await vscode.window.showInputBox({
      title: money ? 'Set Monthly Estimated Cost Budget' : 'Set Monthly Token Budget',
      prompt: money ? 'Monthly estimated cost budget in dollars. 0 disables the budget.' : 'Monthly token budget in millions of tokens (e.g. 50 = 50M tokens). Enter 0 to turn off budget indicators.',
      value: current.toString(),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? undefined : money ? 'Enter a non-negative dollar amount' : 'Enter a non-negative number in millions of tokens'),
    });
    if (value === undefined) return;
    const budget = Number(value);
    const key = money ? 'budgetLimit' : 'tokenBudgetLimit';
    await config.update(key, budget, settingTarget(config, key));
    void vscode.window.showInformationMessage(budget === 0 ? 'agent-usage-dock: budget indicators turned off.' : `agent-usage-dock: monthly budget set to ${budget}${money ? ' dollars' : 'M tokens'}.`);
  };

  const openPanel = () => {
    if (!UsagePanel.isOpen) viewMonth = undefined;
    const shown = dashboard();
    if (shown) UsagePanel.show(shown, cfg, sessionProvider, vscode.Uri.joinPath(context.extensionUri, 'media', 'gemini.svg'));
  };

  const exportCsv = async () => {
    const current = store;
    if (!current) return;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'agent-usage-dock.csv')),
      filters: { CSV: ['csv'] },
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(toCsv(current.data.days, pricing), 'utf8'));
  };

  const exportOfflineHtml = async () => {
    const current = store;
    if (!current) return;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `agent-usage-dock-${today}.html`)),
      filters: { HTML: ['html'] },
      title: 'Export Offline HTML (contains session metadata and first prompt summaries — store privately)',
    });
    if (!uri) return;

    try {
      const html = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'agent-usage-dock: Exporting offline HTML', cancellable: true },
        async (progress, token) => {
          const controller = new AbortController();
          const abortAll = () => controller.abort();
          const sub = token.onCancellationRequested(abortAll);
          const onExtDispose = cancellation.signal.addEventListener('abort', abortAll);
          void onExtDispose;
          try {
            progress.report({ message: 'Refreshing local usage…' });
            await poll();
            if (token.isCancellationRequested || controller.signal.aborted) throw new ExportCancelledError();

            const themeKind = vscode.window.activeColorTheme?.kind;
            const resolvedTheme = themeKind === vscode.ColorThemeKind.Dark || themeKind === vscode.ColorThemeKind.HighContrast ? 'dark' : 'light';
            const pluginVersion = typeof __DOCK_BUNDLE_VERSION__ === 'string'
              ? __DOCK_BUNDLE_VERSION__
              : (context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '1.3.1';

            let lastPct = 0;
            const snapshot = await buildOfflineSnapshot(current.data, cfg, {
              pluginVersion,
              resolvedTheme,
              signal: controller.signal,
              onProgress: (done, total) => {
                const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
                const increment = Math.max(0, pct - lastPct);
                lastPct = pct;
                progress.report({ message: `Collecting session details (${done}/${total})…`, increment });
              },
            });
            if (token.isCancellationRequested || controller.signal.aborted) throw new ExportCancelledError();
            progress.report({ message: 'Generating HTML…' });
            return renderOfflineHtml(snapshot);
          } finally {
            sub.dispose();
            cancellation.signal.removeEventListener('abort', abortAll);
          }
        },
      );
      await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf8'));
      void vscode.window.showInformationMessage('agent-usage-dock: Offline HTML exported. It contains session metadata and first prompt summaries — keep it in a private location.');
    } catch (err) {
      if (err instanceof ExportCancelledError) return;
      const msg = err instanceof Error ? err.message : String(err);
      log.appendLine(`${stamp()} offline HTML export failed: ${err instanceof Error ? err.stack : msg}`);
      void vscode.window.showErrorMessage(`agent-usage-dock: could not export offline HTML (${msg}).`);
    }
  };

  const rebuildHistory = async () => {
    const ok = await vscode.window.showWarningMessage(
      `Rebuild re-reads enabled local source logs still on disk and merges them with the permanent history archive. Backups are saved in ${backupDir(sharedStoreFile())}.`,
      { modal: true },
      'Rebuild',
    );
    if (ok !== 'Rebuild') return;
    while (inFlight) await inFlight;
    await start(true);
  };

  /** Every command is registered before the store is read, so a store that cannot be loaded does not leave "command not found" behind. */
  const command = (id: string, run: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, () => (store ? run() : unavailable())));

  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });
  command('agyTokenTracker.refresh', () => poll());
  command('agyTokenTracker.openPanel', openPanel);
  command('agyTokenTracker.setBudget', setBudget);
  command('agyTokenTracker.configureRates', configureRates);
  command('agyTokenTracker.exportCsv', exportCsv);
  command('agyTokenTracker.exportOfflineHtml', exportOfflineHtml);
  command('agyTokenTracker.rebuildHistory', rebuildHistory);
  // Backward-compatible aliases
  command('agyTokenMonitor.refresh', () => poll());
  command('agyTokenMonitor.openPanel', openPanel);
  command('agyTokenMonitor.setBudget', setBudget);
  command('agyTokenMonitor.exportCsv', exportCsv);
  command('agyTokenMonitor.rebuildHistory', rebuildHistory);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => render()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION) && !e.affectsConfiguration('agyTokenMonitor')) return;
      cfg = readConfig();
      pricing = new Pricing(cfg.rates, cfg.correctionFactor);
      if (cfg.pollIntervalSeconds !== armedSeconds) schedule();
      render();
      if (inFlight) rerun = true;
      else void poll();
    }),
  );

  schedule();
  void poll();
}

export function deactivate(): void {}
