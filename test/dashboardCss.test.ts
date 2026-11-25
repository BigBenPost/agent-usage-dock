import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { HOVER_STYLE } from '../src/dashboardHover';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage, renderSessionDetail, renderSessionError, renderSessionMissing } from '../src/panelHtml';
import { SCRIPT } from '../src/panelScript';
import { STYLE } from '../src/panelStyle';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import { summarize } from '../src/summary';
import { emptyBucket, type DayRecord, type SessionRecord, type TokenBucket } from '../src/types';
import { colour, contrast, over, parseCss, themeVariables, type Theme } from './cssColors';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const rules = parseCss(STYLE + HOVER_STYLE);
const THEMES: Theme[] = ['light', 'dark'];
const attempted = new Date(NOW).toISOString();

/** Pages that between them show every element, state and message the dashboard can print. */
function variants(): { bodies: string[]; details: string[] } {
  const rates = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`m-${i}`, { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 }]));
  const days: Record<string, DayRecord> = {};
  for (let d = 1; d <= 21; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    days[day] = { antigravity: { 'gemini-1.5-flash': bucket(1e6), 'mystery-unpriced': bucket(1e3), 'deepseek-a': bucket(2e5) }, claude: { 'claude-opus-4-6': bucket(4e5) }, codex: { 'gpt-5.5': bucket(3e5) }, cursor: { 'composer-2.5': bucket(1e5), 'claude-4.6-opus-high-thinking': bucket(1e5) } };
    for (let i = 0; i < 30; i++) days[day].antigravity![`m-${i}`] = bucket(1e4 + i);
  }
  days['2026-10-25'] = { antigravity: { 'gemini-1.5-flash': bucket(1e6) } };
  days['2026-09-02'] = { claude: { 'claude-opus-4-6': bucket(1e6) } };
  const sessions: Record<string, SessionRecord> = {};
  for (let i = 0; i < 40; i++) {
    const source = (['antigravity', 'claude', 'codex', 'cursor'] as const)[i % 4];
    const model = source === 'antigravity' ? 'gemini-1.5-flash' : source === 'claude' ? 'claude-opus-4-6' : source === 'codex' ? 'gpt-5.5' : 'composer-2.5';
    sessions[`${source}:s${i}`] = { source, id: `s${i}`, title: `Session ${i}`, project: `p${i % 4}`, first: NOW - i * 1e6, last: NOW - i * 1e5, days: { '2026-10-21': { [model]: bucket(1e5 + i) } } };
  }
  const health = { root: '/store', attemptedAt: attempted, succeededAt: attempted, problems: ['one'] };
  const sourceHealth = {
    antigravity: { root: '/a', status: 'incomplete' as const, attemptedAt: attempted, problems: ['x'] },
    claude: { root: '/c', status: 'ok' as const, attemptedAt: attempted, succeededAt: attempted, problems: [] },
    codex: { root: '/d', status: 'not-found' as const, attemptedAt: attempted, problems: [] },
    dsh: { root: '/e', status: 'disabled' as const, attemptedAt: attempted, problems: [] },
  };
  const bodies: string[] = [];
  const pricing = new Pricing(rates);
  for (const config of [{}, { tokenBudgetLimit: 1 }, { tokenBudgetLimit: 1.1 }, { tokenBudgetLimit: 60 }, { tokenBudgetLimit: 50, budgetLimit: 1 }, { budgetMode: 'cost', budgetLimit: 1 }, { budgetMode: 'cost', budgetLimit: 1000 }, { tokenBudgetLimit: 2.5, warningThreshold: 0.5 }]) {
    for (const selected of [undefined, '2026-09']) {
      for (const withSessions of [sessions, undefined, {}]) {
        const s = summarize({ days, sessions: withSessions, firstDay: '2026-09-01', legacy: { days: { '2026-09-01': { claude: { x: bucket(1) } } }, before: 1 }, health, sourceHealth }, pricing, NOW, selected);
        bodies.push(renderPage(s, normalizeConfig(config)));
        const active = new Set(Object.keys(sessions).slice(0, 3));
        bodies.push(renderBody(summarize({ days, sessions: withSessions, active }, pricing, NOW, selected), normalizeConfig(config)));
      }
    }
  }
  bodies.push(renderBody(summarize({ days: { '2026-10-02': { claude: { 'claude-opus-4-6': bucket(1e6) } } }, sessions: {} }, pricing, Date.parse('2026-10-03T10:00:00Z')), normalizeConfig({})));
  bodies.push(renderBody(summarize({ days: {}, sessions: {} }, pricing, NOW), normalizeConfig({})));
  bodies.push(renderBody(summarize({ days: {}, sessions: {} }, pricing, NOW, '2026-09'), normalizeConfig({})));
  const details: string[] = [renderSessionMissing(), renderSessionError()];
  const rec = sessions['claude:s1'];
  for (const info of [undefined, { file: '/f', title: 't', firstPrompt: 'p', cwd: '/c', branch: 'b' }, { file: '/f', folder: true }]) {
    details.push(renderSessionDetail(buildSessionDetail('claude:s1', rec, pricing, '2026-10', info, true)));
    details.push(renderSessionDetail(buildSessionDetail('antigravity:s0', { ...sessions['antigravity:s0'], days: { ...sessions['antigravity:s0'].days, '2026-09-01': { 'gemini-1.5-flash': bucket(5) } } }, pricing, '2026-10', info)));
  }
  return { bodies, details };
}

/** Classes that the script puts on elements and the editor puts on the body. */
const ADDED_AT_RUNTIME = new Set(['active', 'open', 'theme-light', 'theme-dark', 'theme-auto', 'vscode-light', 'vscode-high-contrast-light']);

function cssClasses(): Set<string> {
  const names = new Set<string>();
  for (const rule of rules) for (const selector of rule.selectors) for (const match of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) names.add(match[1]);
  return names;
}

test('every class the stylesheet names is on something the dashboard prints, so dead rules cannot linger', () => {
  const { bodies, details } = variants();
  const used = new Set<string>(ADDED_AT_RUNTIME);
  for (const html of [...bodies, ...details, SCRIPT]) {
    for (const match of html.matchAll(/class="([^"]*)"/g)) match[1].split(/\s+/).forEach((name) => name && used.add(name));
  }
  for (const family of ['gemini', 'opus', 'gpt', 'deepseek', 'composer', 'unknown']) used.add(family);
  const unused = [...cssClasses()].filter((name) => !used.has(name)).sort();
  assert.deepEqual(unused, []);
});

test('every custom property the stylesheet defines is read somewhere, and every one it reads is defined', () => {
  const defined = new Set<string>();
  const read = new Set<string>();
  for (const rule of rules) {
    for (const [name, value] of Object.entries(rule.declarations)) {
      if (name.startsWith('--')) defined.add(name);
      for (const match of value.matchAll(/var\((--[\w-]+)/g)) read.add(match[1]);
    }
  }
  assert.deepEqual([...defined].filter((name) => !read.has(name)), []);
  assert.deepEqual([...read].filter((name) => !defined.has(name) && !name.startsWith('--vscode-') && name !== '--cols'), []);
});

test('every data attribute in the markup is read by the page script or the stylesheet', () => {
  const { bodies, details } = variants();
  const names = new Set<string>();
  for (const html of [...bodies, ...details]) {
    const { document } = parseHTML(html.includes('<html') ? html : `<html><body>${html}</body></html>`);
    for (const element of document.querySelectorAll('*')) for (const attribute of element.attributes) if (attribute.name.startsWith('data-')) names.add(attribute.name);
  }
  const camel = (name: string) => name.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const unread = [...names].filter((name) => !SCRIPT.includes(name) && !SCRIPT.includes(`dataset.${camel(name)}`) && !STYLE.includes(`[${name}`));
  assert.deepEqual(unread, []);
});

test('the narrow layout has no gutter left over from the checkbox that is gone', () => {
  const narrow = rules.filter((rule) => rule.media === '@media (max-width: 560px)');
  assert.ok(narrow.length > 0);
  assert.equal(narrow.find((rule) => rule.selectors.includes('.scard-main'))!.declarations.padding, '10px');
  assert.doesNotMatch(STYLE, /44px|\.pick\b/);
});

test('under forced colours the bars, swatches, meters, ticks and toggles stay visible and say which is pressed', () => {
  const forced = rules.filter((rule) => rule.media === '@media (forced-colors: active)');
  assert.ok(forced.length > 0);
  const selectors = forced.flatMap((rule) => rule.selectors);
  for (const wanted of ['.seg', '.swatch', '.key', '.dot', '.hbar i', '.meter .fill', '.meter .tick', '.segmented button[aria-pressed="true"]', '.tip', '.pace', '.health-dot']) {
    assert.ok(selectors.includes(wanted), `${wanted} has a forced-colours rule`);
  }
  const keeps = (selector: string) => forced.find((rule) => rule.selectors.includes(selector) && rule.declarations['forced-color-adjust'] === 'none');
  for (const painted of ['.seg', '.swatch', '.key', '.dot', '.hbar i', '.meter .fill', '.health-dot']) assert.ok(keeps(painted), `${painted} keeps its own colour`);
  for (const outlined of ['.seg', '.swatch', '.key', '.dot']) {
    assert.match(forced.find((rule) => rule.selectors.includes(outlined) && rule.declarations.outline)!.declarations.outline, /CanvasText/, `${outlined} has an edge that shows on either canvas`);
  }
  for (const frame of ['.hbar', '.meter']) assert.match(forced.find((rule) => rule.selectors.includes(frame) && rule.declarations.border)!.declarations.border, /CanvasText/);
  const pressed = forced.find((rule) => rule.selectors.includes('.segmented button[aria-pressed="true"]'))!.declarations;
  assert.equal(pressed.background, 'Highlight');
  assert.equal(pressed.color, 'HighlightText');
  assert.equal(pressed['forced-color-adjust'], 'none', 'otherwise the browser lays a canvas-coloured backplate behind the label and the highlight text vanishes on it');
  assert.ok(forced.find((rule) => rule.selectors.includes('.segmented button') && /ButtonText/.test(rule.declarations.border ?? '')), 'an unpressed toggle still has an outline');
  assert.ok(forced.some((rule) => rule.selectors.includes('.meter .fill') && rule.declarations.background === 'Highlight'), 'the meter fill is the highlight colour');
  const system = /^(Canvas|CanvasText|Highlight|HighlightText|ButtonText|none|transparent)\b/;
  for (const rule of forced) {
    for (const [name, value] of Object.entries(rule.declarations)) {
      if (name === 'background' || name === 'color' || name.endsWith('-color')) assert.match(value, system, `${rule.selectors[0]} { ${name}: ${value} } is a system colour`);
    }
  }
});

/** The background of a chip: the track colour over a card over the page. */
function chip(theme: Theme): string {
  const variables = themeVariables(rules, theme);
  const page = colour(variables['--page'], variables)!;
  const card = over(variables['--card'], page)!;
  return over(variables['--track'], card)!;
}

test('text on a chip is legible in both themes: code, and the Ready, Needs attention and pending badges', () => {
  for (const theme of THEMES) {
    const variables = themeVariables(rules, theme);
    const background = chip(theme);
    for (const [name, value] of [['--ink', variables['--ink']], ['--ink-2', variables['--ink-2']], ['--positive', variables['--positive']], ['--warn-ink', variables['--warn-ink']]] as const) {
      assert.ok(contrast(colour(value, variables)!, background) >= 4.5, `${theme}: ${name} on a chip is ${contrast(colour(value, variables)!, background).toFixed(2)}:1`);
    }
  }
  const code = rules.find((rule) => !rule.media && rule.selectors.includes('code'))!;
  assert.equal(code.declarations.color, 'inherit', 'the editor\'s preformatted colour does not reach it');
  assert.equal(code.declarations.background, 'var(--track)', 'and neither does the editor\'s preformatted background');
  assert.doesNotMatch(STYLE, /textPreformat/);
  const notes = rules.find((rule) => !rule.media && rule.selectors.includes('.notes'))!;
  for (const theme of THEMES) {
    const variables = themeVariables(rules, theme);
    assert.ok(contrast(colour(notes.declarations.color, variables)!, chip(theme)) >= 4.5, `${theme}: code inside the notes`);
  }
  const diagnostic = rules.find((rule) => !rule.media && rule.selectors.includes('.diagnostic'))!;
  for (const theme of THEMES) {
    const variables = themeVariables(rules, theme);
    assert.ok(contrast(colour(diagnostic.declarations.color, variables)!, chip(theme)) >= 4.5, `${theme}: code inside a diagnostic`);
  }
});

test('the body text the dashboard prints most is legible on the page and on a card, in both themes', () => {
  for (const theme of THEMES) {
    const variables = themeVariables(rules, theme);
    const page = colour(variables['--page'], variables)!;
    const card = over(variables['--card'], page)!;
    for (const name of ['--ink', '--ink-2', '--muted', '--warn-ink', '--positive']) {
      for (const [where, background] of [['page', page], ['card', card]] as const) {
        assert.ok(contrast(colour(variables[name], variables)!, background) >= 4.5, `${theme}: ${name} on the ${where} is ${contrast(colour(variables[name], variables)!, background).toFixed(2)}:1`);
      }
    }
  }
});
