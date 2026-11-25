import { createHash } from 'crypto';
import type { Config } from './config';
import { HOVER_STYLE } from './dashboardHover';
import { dashboardTheme, renderBody } from './panelRender';
import { SCRIPT } from './panelScript';
import { STYLE } from './panelStyle';
import type { Summary } from './summary';

export {
  dashboardTheme,
  heroTokenFigure,
  renderBody,
  renderSessionDetail,
  renderSessionError,
  renderSessionMissing,
  sessionView,
  type RenderOptions,
  type SessionView,
} from './panelRender';

const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');
const CONTENT_SECURITY_POLICY = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action 'none'; base-uri 'none';`;

/** The page. Later updates arrive as 'render' messages, so this is set once per panel. */
export function renderPage(s: Summary, cfg: Config): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">
<style>${STYLE}${HOVER_STYLE}</style>
</head><body class="theme-${dashboardTheme(cfg.dashboardTheme)}">
<div id="app" tabindex="-1">${renderBody(s, cfg)}</div>
<div id="scrim" hidden></div>
<div id="popup" hidden><div id="pop-card" class="pop-card" tabindex="-1" role="dialog" aria-modal="true" aria-label="Session details"></div></div>
<script>${SCRIPT}</script>
</body></html>`;
}
