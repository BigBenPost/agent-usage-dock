import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import type { Config } from '../src/config';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize, type Summary } from '../src/summary';
import { emptyBucket, type DayRecord, type TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const attempted = new Date(NOW).toISOString();

function month(over: { problems?: string[]; days?: Record<string, DayRecord> } = {}): Summary {
  const days = over.days ?? { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(1e6) } } };
  return summarize({
    days,
    sessions: { 'antigravity:s': { source: 'antigravity', id: 's', title: 'A session', first: NOW, last: NOW, days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e6) } } } },
    health: { root: '/store', attemptedAt: attempted, succeededAt: attempted, problems: over.problems ?? [] },
    sourceHealth: { antigravity: { root: '/logs/antigravity', status: over.problems?.length ? 'incomplete' : 'ok', attemptedAt: attempted, succeededAt: attempted, problems: over.problems ?? [] } },
  }, new Pricing(), NOW);
}

type Page = ReturnType<typeof boot>;

/** The dashboard's own script running against its own markup, the way the editor's webview runs it. */
function boot(summary: Summary, config: Config = cfg, saved?: unknown) {
  const html = renderPage(summary, config);
  const { window, document } = parseHTML(html);
  let focused: unknown = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function (this: unknown) { focused = this; };
  const posted: { type: string; [key: string]: unknown }[] = [];
  const saves: { open: Record<string, boolean> }[] = [];
  const context = {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => saved, setState: (state: unknown) => saves.push(JSON.parse(JSON.stringify(state))), postMessage: (m: { type: string }) => posted.push(m) }),
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  return {
    window, document, posted, saves,
    get focused() { return focused as { getAttribute: (name: string) => string | null } | null; },
    focus: (element: unknown) => { focused = element; },
    send: (data: unknown) => {
      const event = new window.Event('message');
      Object.assign(event, { data });
      window.dispatchEvent(event);
    },
    render: (body: string, theme = 'light') => {
      const event = new window.Event('message');
      Object.assign(event, { data: { type: 'render', theme, html: body } });
      window.dispatchEvent(event);
    },
    toggle: (key: string, open: boolean) => {
      const details = document.querySelector(`details[data-key="${key}"]`)!;
      details.open = open;
      details.dispatchEvent(new window.Event('toggle', { bubbles: true }));
    },
    key: (target: unknown, key: string, extra: Record<string, unknown> = {}) => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(event, { key, ...extra });
      (target as { dispatchEvent: (e: unknown) => void }).dispatchEvent(event);
      return event as unknown as { defaultPrevented: boolean };
    },
  };
}

const bodyOf = (summary: Summary): string => renderBody(summary, cfg);

test('a poll that changes the data keeps the nested diagnostics open, and the focus on the one the user was in', () => {
  const page = boot(month({ problems: ['one'] }));
  const { document } = page;
  page.toggle('collection-status', true);
  page.toggle('storage-details', true);
  page.toggle('log-folder-antigravity', true);
  page.focus(document.querySelector('[data-focus="storage-details-toggle"]'));

  page.render(bodyOf(month({ problems: ['one', 'two'] })));
  assert.match(document.querySelector('[data-key="storage-details"]')!.textContent!, /two/, 'the new data is on the page');
  for (const key of ['collection-status', 'storage-details', 'log-folder-antigravity']) assert.equal(document.querySelector(`details[data-key="${key}"]`)!.open, true, key);
  assert.equal(page.focused!.getAttribute('data-focus'), 'storage-details-toggle');
  assert.equal(document.querySelector('.session-pages button:not([disabled])') === page.focused, false);

  page.toggle('storage-details', false);
  page.render(bodyOf(month({ problems: ['one', 'two', 'three'] })));
  assert.equal(document.querySelector('details[data-key="storage-details"]')!.open, false, 'a diagnostic the user closed stays closed');
  assert.equal(document.querySelector('details[data-key="log-folder-antigravity"]')!.open, true);
});

test('what the user opened is remembered in the saved state, nested sections included, and comes back with the page', () => {
  const first = boot(month({ problems: ['one'] }));
  first.toggle('collection-status', true);
  first.toggle('log-folder-antigravity', true);
  const saved = first.saves.at(-1)!;
  assert.equal(saved.open['log-folder-antigravity'], true);
  const again = boot(month({ problems: ['one'] }), cfg, saved);
  assert.equal(again.document.querySelector('details[data-key="log-folder-antigravity"]')!.open, true);
  assert.equal(again.document.querySelector('details[data-key="collection-status"]')!.open, true);
});

const detailA = '<header class="pop-head"><h2>Title</h2><button type="button" data-action="close">x</button></header><p class="quote">the first prompt</p>';
const detailB = '<header class="pop-head"><h2>Title, renamed</h2><button type="button" data-action="close">x</button></header><p class="quote">the first prompt</p>';

function openPopup(): Page {
  const page = boot(month());
  page.document.querySelector('.scard-main')!.dispatchEvent(new page.window.Event('click', { bubbles: true }));
  assert.equal(page.posted.at(-1)!.type, 'openSession');
  return page;
}

test('the popup is rebuilt only when its content changed', () => {
  const page = openPopup();
  const card = page.document.getElementById('pop-card')!;
  assert.match(card.innerHTML, /Loading/);
  page.send({ type: 'detail', key: 'antigravity:s', html: detailA });
  assert.equal(card.innerHTML, detailA);
  const quote = card.querySelector('.quote') as unknown as { marker?: boolean };
  quote.marker = true;
  page.send({ type: 'detail', key: 'antigravity:s', html: detailA });
  assert.equal((card.querySelector('.quote') as unknown as { marker?: boolean }).marker, true, 'the same content is the same nodes');
  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  assert.equal(card.innerHTML, detailB);
  assert.equal((card.querySelector('.quote') as unknown as { marker?: boolean }).marker, undefined);
});

test('while text in the popup is selected a newer content waits, and appears once the selection is gone', () => {
  const page = openPopup();
  const card = page.document.getElementById('pop-card')!;
  page.send({ type: 'detail', key: 'antigravity:s', html: detailA });
  const inside = card.querySelector('.quote')!;
  const selection = { isCollapsed: false, anchorNode: inside, focusNode: inside };
  (page.window as unknown as { getSelection: () => unknown }).getSelection = () => selection;

  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  assert.equal(card.innerHTML, detailA, 'a selection is not wiped by a refresh');
  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  assert.equal(card.innerHTML, detailA);

  page.document.dispatchEvent(new page.window.Event('selectionchange'));
  assert.equal(card.innerHTML, detailA, 'still selected');
  Object.assign(selection, { isCollapsed: true });
  page.document.dispatchEvent(new page.window.Event('selectionchange'));
  assert.equal(card.innerHTML, detailB);
});

test('a selection that reaches into the popup from outside, or one outside it, behaves as it should', () => {
  const page = openPopup();
  const card = page.document.getElementById('pop-card')!;
  page.send({ type: 'detail', key: 'antigravity:s', html: detailA });
  const win = page.window as unknown as { getSelection: () => unknown };
  win.getSelection = () => ({ isCollapsed: false, anchorNode: page.document.body, focusNode: card.querySelector('.quote') });
  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  assert.equal(card.innerHTML, detailA, 'a drag that ends inside the card holds it too');
  win.getSelection = () => ({ isCollapsed: false, anchorNode: page.document.body, focusNode: page.document.body });
  page.document.dispatchEvent(new page.window.Event('selectionchange'));
  assert.equal(card.innerHTML, detailB, 'a selection in the page behind does not');
});

test('closing the popup with a selection left in it, and opening it again, shows the new content', () => {
  const page = openPopup();
  const card = page.document.getElementById('pop-card')!;
  page.send({ type: 'detail', key: 'antigravity:s', html: detailA });
  (page.window as unknown as { getSelection: () => unknown }).getSelection = () => ({ isCollapsed: false, anchorNode: card.querySelector('.quote'), focusNode: card.querySelector('.quote') });
  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  page.document.querySelector('[data-action="close"]')!.dispatchEvent(new page.window.Event('click', { bubbles: true }));
  assert.equal(page.posted.at(-1)!.type, 'closeSession');
  (page.window as unknown as { getSelection: () => unknown }).getSelection = () => ({ isCollapsed: true });
  page.document.querySelector('.scard-main')!.dispatchEvent(new page.window.Event('click', { bubbles: true }));
  assert.match(card.innerHTML, /Loading/);
  page.send({ type: 'detail', key: 'antigravity:s', html: detailB });
  assert.equal(card.innerHTML, detailB);
});

function daysMonth(): Summary {
  const days: Record<string, DayRecord> = {};
  for (const d of ['18', '19', '20', '21']) days[`2026-10-${d}`] = { antigravity: { 'gemini-1.5-flash': bucket(1e6) } };
  return month({ days });
}

const tabStops = (document: Page['document']): string[] => [...document.querySelectorAll('.metric-cost .col')].filter((el) => el.getAttribute('tabindex') === '0').map((el) => el.getAttribute('data-focus')!);

test('the day columns are one tab stop that the arrow keys, Home and End move, and a refresh leaves it where it was', () => {
  const page = boot(daysMonth());
  const { document } = page;
  const column = (day: string) => document.querySelector(`.metric-cost .col[data-focus="day-2026-10-${day}"]`)!;
  assert.deepEqual(tabStops(document), ['day-2026-10-21'], 'today is the way in');
  assert.equal(document.querySelectorAll('.metric-cost .col[tabindex="-1"]').length, 20);

  page.focus(column('21'));
  assert.equal(page.key(column('21'), 'ArrowLeft').defaultPrevented, true);
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-20');
  assert.deepEqual(tabStops(document), ['day-2026-10-20']);
  page.key(page.focused, 'ArrowLeft');
  page.key(page.focused, 'ArrowRight');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-20');
  page.key(page.focused, 'Home');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-01');
  assert.equal(page.key(page.focused, 'ArrowLeft').defaultPrevented, true, 'the first day is the end of the line, not a way out');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-01');
  page.key(page.focused, 'End');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-21');
  assert.equal(page.key(page.focused, 'ArrowRight').defaultPrevented, true);
  assert.deepEqual(tabStops(document), ['day-2026-10-21']);

  page.key(page.focused, 'ArrowLeft');
  page.key(page.focused, 'ArrowLeft');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-19');
  page.render(bodyOf(daysMonth()));
  assert.deepEqual(tabStops(document), ['day-2026-10-19'], 'the refresh did not send the stop back to today');
  assert.equal(page.focused!.getAttribute('data-focus'), 'day-2026-10-19', 'nor the focus');
  assert.equal(document.querySelectorAll('.metric-cost .col[tabindex="-1"]').length, 20);
});

test('keys the chart has no use for are left to the page', () => {
  const page = boot(daysMonth());
  const today = page.document.querySelector('.col[data-focus="day-2026-10-21"]')!;
  page.focus(today);
  for (const key of ['Tab', 'a', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'PageDown', 'toString', 'constructor']) {
    assert.equal(page.key(today, key).defaultPrevented, false, key);
    assert.equal(page.focused, today, key);
  }
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(page.key(today, 'ArrowLeft', extra).defaultPrevented, false, JSON.stringify(extra));
    assert.equal(page.focused, today);
  }
  assert.equal(page.key(page.document.querySelector('.scard-main'), 'ArrowLeft').defaultPrevented, false, 'arrows outside the chart are not taken');
});

test('a render message names a theme the page knows, or the page stays light; it ignores a body that is not text', () => {
  const page = boot(month());
  const classes = () => [...page.document.body.classList];
  page.render(bodyOf(month()), 'dark');
  assert.deepEqual(classes(), ['theme-dark']);
  page.render(bodyOf(month()), 'auto');
  assert.deepEqual(classes(), ['theme-auto']);
  for (const theme of ['x" onload="alert(1)', 'dark light', '', undefined as never, 5 as never]) {
    page.render(bodyOf(month()), theme);
    assert.deepEqual(classes(), ['theme-light'], String(theme));
  }
  const before = page.document.getElementById('app')!.innerHTML;
  page.send({ type: 'render', theme: 'dark', html: { toString: () => '<b>x</b>' } });
  page.send({ type: 'render', theme: 'dark' });
  assert.equal(page.document.getElementById('app')!.innerHTML, before);
  page.send({ type: 'detail', key: 'antigravity:s', html: 5 });
  page.send(null);
  page.send('render');
});
