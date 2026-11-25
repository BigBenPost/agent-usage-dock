import * as vscode from 'vscode';
import { LEVEL_BAR_ICONS, LEVEL_RING_ICONS, STATUS_BAR_ICON } from './brand';
import { Config, LevelIndicator } from './config';
import { budgetLevel, levelBar, statusBarLabel, statusBarText } from './statusText';
import { Summary } from './summary';
import { TOOLTIP_COMMANDS, tooltipMarkdown } from './tooltip';

const OPEN_DASHBOARD = 'agyTokenTracker.openPanel';
const errorBackground = (): vscode.ThemeColor => new vscode.ThemeColor('statusBarItem.errorBackground');

export class UsageStatusBar implements vscode.Disposable {
  /** Priority 99.6, between the editor's own items (100.x, Copilot's quota item included) and Cursor Usage Monitor's pair at 98 and 99. A fraction keeps other extensions from sharing it. */
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99.6);
  /** Markdown last put in the hover; an open hover is not rebuilt while it would read the same. */
  private lastTooltip: string | undefined;
  private indicator: LevelIndicator = 'bar';
  private budgetMode: Config['budgetMode'] = 'tokens';

  constructor() {
    this.item.name = 'agent-usage-dock';
    this.item.command = OPEN_DASHBOARD;
    this.item.text = `${STATUS_BAR_ICON} …tok`;
    this.item.tooltip = 'agent-usage-dock estimate: reading logs…';
    this.item.show();
  }

  update(s: Summary, cfg: Config): void {
    this.item.command = OPEN_DASHBOARD;
    // The level is a colour glyph inside the text, because an item has one text colour and its background can only be the editor's amber or red.
    // The bar leads and the ring follows with nothing between: each glyph carries its own space.
    // The glyph colours do not hold up against every status bar (red on the default blue is 1.1:1), so a critical level also takes the editor's error background.
    this.indicator = cfg.levelIndicator;
    this.budgetMode = cfg.budgetMode;
    const level = levelBar(s, cfg);
    const bar = level && cfg.levelIndicator === 'bar' ? LEVEL_BAR_ICONS[level] : '';
    const ring = level && cfg.levelIndicator === 'ring' ? LEVEL_RING_ICONS[level] : '';
    this.item.text = `${bar}${STATUS_BAR_ICON} ${statusBarText(s, cfg)}${ring}`;
    this.item.accessibilityInformation = { label: statusBarLabel(s, cfg), role: 'button' };
    this.item.backgroundColor = budgetLevel(s, cfg) === 'critical' ? errorBackground() : undefined;

    // The chart in the tooltip is an image, so its text colours follow the editor theme; extension.ts re-renders when the theme changes.
    const kind = vscode.window.activeColorTheme.kind;
    const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const health = s.health?.problems.length ? '\n\n**Incomplete scan** — open the dashboard for collection errors.' : '';
    const markdown = tooltipMarkdown(s, cfg, { dark, chart: cfg.tooltipChart }) + health;
    if (markdown === this.lastTooltip) return;
    this.lastTooltip = markdown;
    const md = new vscode.MarkdownString(markdown);
    md.supportThemeIcons = true;
    // The tooltip colours its bars with inline styles, and links to two commands of this extension.
    md.supportHtml = true;
    md.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
    this.item.tooltip = md;
  }

  /** The item stays clickable: the dashboard command answers even when the store is not ready. */
  showError(message: string): void {
    this.lastTooltip = undefined;
    const unknown = this.budgetMode === 'cost' ? '~$?' : '?tok';
    this.item.text = `${this.indicator === 'bar' ? LEVEL_BAR_ICONS.red : ''}${STATUS_BAR_ICON} ${unknown} $(error)`;
    this.item.backgroundColor = errorBackground();
    this.item.accessibilityInformation = { label: `agent-usage-dock: error, ${message}`, role: 'button' };
    this.item.tooltip = `agent-usage-dock error: ${message}\nSee the "agent-usage-dock" output channel.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
