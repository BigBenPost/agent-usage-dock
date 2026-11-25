import { snapshotToConfig, type OfflineSnapshot } from './offlineSnapshot';
import { dashboardTheme, renderBody, renderSessionDetail, renderSessionMissing, sessionView, type RenderOptions } from './panelRender';
import { Pricing } from './pricing';
import { buildSessionDetail, findSession } from './sessionDetail';
import { pinnedMonth, summarize } from './summary';
import { isDisplayZone } from './timeZone';

declare const document: {
  getElementById(id: string): { textContent: string | null } | null;
};
declare const window: {
  __DOCK_HOST__?: {
    getState(): unknown;
    setState(state: unknown): void;
    postMessage(message: unknown): void;
  };
  dispatchEvent(event: unknown): boolean;
};
declare const MessageEvent: new (type: string, init?: { data?: unknown }) => unknown;

(function () {
  const el = document.getElementById('dock-snapshot');
  if (!el?.textContent) return;
  const snapshot = JSON.parse(el.textContent) as OfflineSnapshot;
  const pricing = new Pricing(snapshot.config.rates, snapshot.config.correctionFactor);
  const active = new Set(snapshot.data.active);
  const renderOpts: RenderOptions = { offline: { exportedAt: snapshot.exportedAt } };

  let cfg = snapshotToConfig(snapshot);
  let memState: unknown = undefined;
  let view = sessionView(undefined);
  let viewMonth: string | undefined = undefined;
  let openKey: string | undefined = undefined;

  const summaryFor = (month?: string) => summarize(
    { ...snapshot.data, active },
    pricing,
    snapshot.now,
    month,
  );

  let current = summaryFor();
  viewMonth = pinnedMonth(undefined, current.months, current.month);

  const emit = (data: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  };

  const pushBody = () => {
    current = summaryFor(viewMonth);
    viewMonth = pinnedMonth(viewMonth, current.months, current.month);
    const html = renderBody(current, cfg, view, renderOpts);
    emit({ type: 'render', theme: dashboardTheme(cfg.dashboardTheme), html });
  };

  const pushDetail = (key: string) => {
    const rec = findSession(snapshot.data.sessions, key);
    if (!rec) {
      emit({ type: 'detail', key, html: renderSessionMissing() });
      return;
    }
    const info = Object.prototype.hasOwnProperty.call(snapshot.sessionInfos, key) ? snapshot.sessionInfos[key] : undefined;
    const detail = buildSessionDetail(key, rec, pricing, viewMonth ?? current.month, info, active.has(key));
    emit({ type: 'detail', key, html: renderSessionDetail(detail, cfg.timeZone, renderOpts) });
  };

  window.__DOCK_HOST__ = {
    getState: () => memState,
    setState: (next: unknown) => { memState = next; },
    postMessage: (m: unknown) => {
      if (!m || typeof m !== 'object') return;
      const msg = m as { type?: unknown; key?: unknown; month?: unknown; zone?: unknown; view?: unknown };
      if (msg.type === 'ready') {
        view = sessionView(msg.view);
        pushBody();
      } else if (msg.type === 'setMonth') {
        view = { ...view, page: 0 };
        viewMonth = pinnedMonth(msg.month, current.months, current.month);
        pushBody();
      } else if (msg.type === 'setSessionView') {
        view = sessionView(msg.view);
        pushBody();
      } else if (msg.type === 'setTimeZone') {
        if (!isDisplayZone(msg.zone)) return;
        cfg = { ...cfg, timeZone: msg.zone };
        pushBody();
        if (openKey) pushDetail(openKey);
      } else if (msg.type === 'openSession' && typeof msg.key === 'string') {
        openKey = msg.key;
        pushDetail(msg.key);
      } else if (msg.type === 'closeSession') {
        openKey = undefined;
      }
    },
  };
})();
