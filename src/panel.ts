import * as vscode from 'vscode';
import { Config } from './config';
import { dashboardTheme, renderBody, renderPage, renderSessionError, sessionView } from './panelHtml';
import { Summary } from './summary';

/** What the dashboard asks of the extension: a session opened, or another month picked. */
export interface SessionProvider {
  /** HTML for the session drawer. Should not reject; a failure here leaves the drawer on its loading text. */
  detail(key: string): Promise<string>;
  openLog(key: string): Promise<void>;
  /** The month as the page sent it (`current` or a `YYYY-MM`), not checked. The extension decides what to show and updates the panel. */
  setMonth(month: unknown): void;
  /** The zone as the page sent it (`UTC` or `SGT`), not checked. The extension saves it in the settings, which re-renders the page. */
  setTimeZone(zone: unknown): void;
  configureRates?(): Promise<void>;
}

export class UsagePanel {
  private static current: UsagePanel | undefined;

  /** The session whose drawer is open in the page, refreshed together with the rest. */
  private openKey: string | undefined;
  private lastBody: string | undefined;
  private lastDetail: { key: string; html: string } | undefined;
  private detailGeneration = 0;
  private pendingDetail?: { generation: number; scope: string; again: boolean };
  private view = sessionView(undefined);
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private latest: { s: Summary; cfg: Config },
    private readonly sessions: SessionProvider,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      this.detailGeneration++;
      if (UsagePanel.current === this) UsagePanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m).catch(() => undefined));
    panel.onDidChangeViewState(() => panel.visible && this.push(false));
    panel.webview.html = renderPage(latest.s, latest.cfg);
  }

  static show(s: Summary, cfg: Config, sessions: SessionProvider, icon?: vscode.Uri): void {
    if (!UsagePanel.current) {
      // The page keeps its state (sorting, open drawer) while another tab is in front, instead of rebuilding from the initial HTML.
      const panel = vscode.window.createWebviewPanel('agyTokenTracker', 'agent-usage-dock', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
      panel.iconPath = icon;
      UsagePanel.current = new UsagePanel(panel, { s, cfg }, sessions);
    }
    UsagePanel.current.panel.reveal();
    UsagePanel.update(s, cfg);
  }

  static get isOpen(): boolean {
    return UsagePanel.current !== undefined;
  }

  static update(s: Summary, cfg: Config): void {
    const current = UsagePanel.current;
    if (!current) return;
    current.latest = { s, cfg };
    current.push(false);
  }

  /** Sends the current content to the page. Nothing is sent while the panel is hidden or when the content has not changed, unless `force` is set. The open popup is checked either way. */
  private push(force: boolean, refreshDetail = true): void {
    if (!force && !this.panel.visible) return;
    const { s, cfg } = this.latest;
    const body = renderBody(s, cfg, this.view);
    const theme = dashboardTheme(cfg.dashboardTheme);
    const key = `${theme}\0${body}`;
    if (!force && key === this.lastBody) {
      // The overview did not change, but what an open popup reads from the log (a title, whether the log exists) may have.
      if (refreshDetail) void this.sendDetail(false);
      return;
    }
    this.lastBody = key;
    void this.panel.webview.postMessage({ type: 'render', theme, html: body });
    if (refreshDetail) void this.sendDetail(false);
  }

  /** `explicit` is a request from the page, which has just cleared its popup; a refresh is skipped when the details are unchanged. */
  private async sendDetail(explicit: boolean): Promise<void> {
    const key = this.openKey;
    if (!key || this.disposed || !this.panel.visible) return;
    const scope = `${this.latest.s.month}:${this.latest.cfg.timeZone}`;
    if (this.pendingDetail?.generation === this.detailGeneration && this.pendingDetail.scope === scope) {
      this.pendingDetail.again = true;
      return;
    }
    const pending = { generation: this.detailGeneration, scope, again: false };
    this.pendingDetail = pending;
    const html = await this.sessions.detail(key).catch(() => renderSessionError());
    if (this.pendingDetail !== pending) return;
    this.pendingDetail = undefined;
    if (this.openKey !== key || pending.generation !== this.detailGeneration || this.disposed || !this.panel.visible) return;
    if (explicit || this.lastDetail?.key !== key || this.lastDetail.html !== html) {
      this.lastDetail = { key, html };
      void this.panel.webview.postMessage({ type: 'detail', key, html });
    }
    if (pending.again) void this.sendDetail(false);
  }

  private async onMessage(m: unknown): Promise<void> {
    if (!m || typeof m !== 'object') return;
    const { type, key, month, zone, view } = m as { type?: unknown; key?: unknown; month?: unknown; zone?: unknown; view?: unknown };
    if (type === 'ready') {
      this.view = sessionView(view);
      this.push(true);
    } else if (type === 'openSession' && typeof key === 'string') {
      this.detailGeneration++;
      this.openKey = key;
      await this.sendDetail(true);
    } else if (type === 'closeSession') {
      this.detailGeneration++;
      this.openKey = undefined;
      this.lastDetail = undefined;
    } else if (type === 'openLog' && typeof key === 'string') {
      await this.sessions.openLog(key);
    } else if (type === 'setMonth') {
      this.view = { ...this.view, page: 0 };
      this.sessions.setMonth(month);
    } else if (type === 'setSessionView') {
      this.view = sessionView(view);
      this.push(false, false);
    } else if (type === 'setTimeZone') {
      this.sessions.setTimeZone(zone);
    } else if (type === 'configureRates') {
      await this.sessions.configureRates?.();
    }
  }
}
