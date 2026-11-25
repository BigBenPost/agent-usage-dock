import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody, renderPage, sessionView, type SessionView } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize, type Summary } from '../src/summary';
import { emptyBucket, SOURCES, type SessionRecord, type Source } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const MODELS: Record<Source, string> = { antigravity: 'gemini-1.5-flash', dsh: 'mystery-dsh', claude: 'claude-opus-4-6', codex: 'gpt-5.5', cursor: 'composer-2.5' };

const session = (source: Source, id: string, last = NOW): SessionRecord => ({
  source, id, project: `${source}-${id}`, first: last - 3_600_000, last, days: { '2026-10-21': { [MODELS[source]]: { ...emptyBucket(), requests: 1, input: 100_000 } } },
});
const sessionsOf = (sources: readonly Source[], each = 1): Record<string, SessionRecord> => Object.fromEntries(
  sources.flatMap((source) => Array.from({ length: each }, (_, i) => [`${source}:${i}`, session(source, String(i), NOW - i * 1000)])),
);
const month = (sources: readonly Source[] = SOURCES, each = 1): Summary => summarize({ days: {}, sessions: sessionsOf(sources, each) }, new Pricing(), NOW);

const page = (summary: Summary, view?: Partial<SessionView>) => parseHTML(renderBody(summary, cfg, sessionView(view))).document;
const texts = (nodes: Iterable<{ textContent: string | null }>): string[] => [...nodes].map((node) => node.textContent?.trim() ?? '');
const ticked = (document: ReturnType<typeof page>): string[] => [...document.querySelectorAll('input[data-filter]')].filter((box) => box.hasAttribute('checked')).map((box) => box.getAttribute('data-filter')!);
type Elem = ReturnType<typeof page>['body'];
type Box = { checked: boolean } & Elem;
const shown = (document: ReturnType<typeof page>): string[] => [...document.querySelectorAll('.scard[data-key]')].map((card) => card.getAttribute('data-key')!);

test('the tools filter is one dropdown that opens shut, with a box for All and one for each tool that has sessions', () => {
  const document = page(month());
  assert.equal(document.querySelectorAll('[data-filter][aria-pressed]').length, 0, 'the row of buttons is gone');
  const toggle = document.querySelector('[data-multi-toggle]')!;
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'true');
  assert.equal(toggle.getAttribute('aria-controls'), 'filter-menu-list');
  assert.equal(toggle.querySelector('.multi-label')!.textContent, 'All tools');
  const list = document.querySelector('#filter-menu-list')!;
  assert.ok(list.hasAttribute('hidden'));
  assert.equal(list.getAttribute('aria-label'), 'Show sessions of');
  assert.deepEqual(texts(list.querySelectorAll('.multi-item')), ['All tools', 'Antigravity', 'DSH', 'Claude Code', 'Codex', 'Cursor']);
  assert.deepEqual(ticked(document), ['antigravity', 'dsh', 'claude', 'codex', 'cursor'], 'every tool is ticked while none is picked');
  assert.ok(document.querySelector('input[data-filter-all]')!.hasAttribute('checked'));
  assert.equal(document.querySelector('.slist')!.getAttribute('data-sources'), '');
});

test('picking tools lists only their sessions, names them on the button and on the total, and unticks All', () => {
  const one = page(month(SOURCES, 2), { sources: ['claude'] });
  assert.deepEqual(shown(one), ['claude:0', 'claude:1']);
  assert.equal(one.querySelector('[data-multi] .multi-label')!.textContent, 'Claude Code');
  assert.deepEqual(ticked(one), ['claude']);
  assert.equal(one.querySelector('input[data-filter-all]')!.hasAttribute('checked'), false);
  assert.equal(one.querySelector('.slist')!.getAttribute('data-sources'), 'claude');
  assert.match(one.querySelector('.scard.total .name')!.textContent!, /^Claude Code · 2 sessions$/);

  const two = page(month(SOURCES, 2), { sources: ['codex', 'claude'] });
  assert.deepEqual(shown(two).sort(), ['claude:0', 'claude:1', 'codex:0', 'codex:1']);
  assert.equal(two.querySelector('[data-multi] .multi-label')!.textContent, 'Claude Code + Codex');
  assert.match(two.querySelector('.scard.total .name')!.textContent!, /^Claude Code \+ Codex · 4 sessions$/);

  const three = page(month(SOURCES, 1), { sources: ['antigravity', 'claude', 'codex'] });
  assert.equal(three.querySelector('[data-multi] .multi-label')!.textContent, '3 of 5 tools');
  assert.equal(shown(three).length, 3);
});

test('every tool picked is the same as none picked, and a tool with no sessions is ignored', () => {
  const all = page(month(), { sources: [...SOURCES] });
  assert.equal(all.querySelector('[data-multi] .multi-label')!.textContent, 'All tools');
  assert.equal(all.querySelector('.slist')!.getAttribute('data-sources'), '');
  assert.equal(shown(all).length, 5);

  const partial = month(['claude', 'codex']);
  const absent = page(partial, { sources: ['dsh'] });
  assert.equal(absent.querySelector('[data-multi] .multi-label')!.textContent, 'All tools');
  assert.equal(shown(absent).length, 2);
  assert.deepEqual(texts(absent.querySelectorAll('#filter-menu-list .multi-item')), ['All tools', 'Claude Code', 'Codex'], 'only the tools that have sessions are offered');
  const mixed = page(partial, { sources: ['dsh', 'codex'] });
  assert.equal(mixed.querySelector('[data-multi] .multi-label')!.textContent, 'Codex');
  assert.deepEqual(shown(mixed), ['codex:0']);
});

test('with one tool there is nothing to choose, so there is no dropdown', () => {
  const document = page(month(['claude']));
  assert.equal(document.querySelector('[data-multi]'), null);
  assert.equal(shown(document).length, 1);
});

test('paging and sorting keep the picked tools', () => {
  const many = month(['claude', 'codex'], 12);
  const second = page(many, { sources: ['claude'], page: 0 });
  assert.equal(shown(second).length, 12);
  assert.equal(second.querySelector('.slist')!.getAttribute('data-sources'), 'claude');
  const sorted = page(many, { sources: ['codex'], sort: 'cost:desc' });
  assert.equal(sorted.querySelector('.slist')!.getAttribute('data-sort'), 'cost:desc');
  assert.deepEqual(new Set(shown(sorted).map((key) => key.split(':')[0])), new Set(['codex']));
});

function boot(summary: Summary, saved?: unknown) {
  const html = renderPage(summary, cfg);
  const { window, document } = parseHTML(html);
  Object.defineProperty(document, 'activeElement', { get: () => document.body });
  const saves: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const context = {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => saved, setState: (state: unknown) => saves.push(JSON.parse(JSON.stringify(state))), postMessage: (message: Record<string, unknown>) => posts.push(JSON.parse(JSON.stringify(message))) }),
  };
  // A browser keeps `checked` of a freshly rendered box in step with its attribute; the stand-in DOM does not, so this does.
  const shimBoxes = () => {
    for (const input of document.querySelectorAll('input[type="checkbox"]')) {
      Object.defineProperty(input, 'checked', {
        configurable: true,
        get: () => input.hasAttribute('checked'),
        set: (on: boolean) => { if (on) input.setAttribute('checked', ''); else input.removeAttribute('checked'); },
      });
    }
  };
  shimBoxes();
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  const fire = (target: Elem, type: string, init: Record<string, unknown> = {}) => {
    const event = new window.Event(type, { bubbles: true });
    Object.assign(event, init);
    target.dispatchEvent(event);
  };
  const box = (name: string) => document.querySelector(`input[data-filter="${name}"]`) as unknown as Box;
  return {
    document, saves, posts, window,
    views: () => posts.filter((post) => post.type === 'setSessionView').map((post) => (post.view as SessionView).sources),
    toggle: () => fire(document.querySelector('[data-multi-toggle]')!, 'click'),
    tick: (name: string, on: boolean) => { box(name).checked = on; fire(box(name), 'change'); },
    tickAll: () => { const all = document.querySelector('input[data-filter-all]') as unknown as Box; all.checked = true; fire(all, 'change'); },
    press: (key: string) => fire(document.body, 'keydown', { key }),
    click: (target: Elem) => fire(target, 'click'),
    open: () => !document.querySelector('#filter-menu-list')!.hasAttribute('hidden'),
    render: (body: string) => {
      const event = new window.Event('message');
      Object.assign(event, { data: { type: 'render', theme: 'light', html: body } });
      window.dispatchEvent(event);
      shimBoxes();
    },
  };
}

test('the button opens and shuts the list, and a click elsewhere or Escape shuts it', () => {
  const app = boot(month());
  assert.equal(app.open(), false);
  app.toggle();
  assert.equal(app.open(), true);
  assert.equal(app.document.querySelector('[data-multi-toggle]')!.getAttribute('aria-expanded'), 'true');
  assert.ok(app.document.querySelector('[data-multi]')!.classList.contains('open'));
  app.click(app.document.querySelector('#filter-menu-list .multi-item')!);
  assert.equal(app.open(), true, 'a click inside the list keeps it open');
  app.click(app.document.querySelector('h1')!);
  assert.equal(app.open(), false, 'a click elsewhere shuts it');
  app.toggle();
  app.toggle();
  assert.equal(app.open(), false, 'the button shuts it again');
  app.toggle();
  app.press('Escape');
  assert.equal(app.open(), false);
  assert.equal(app.document.querySelector('[data-multi-toggle]')!.getAttribute('aria-expanded'), 'false');
});

test('ticking and unticking tools asks the extension for exactly the ticked tools', () => {
  const app = boot(month());
  app.toggle();
  app.tick('dsh', false);
  assert.deepEqual(app.views().at(-1), ['antigravity', 'claude', 'codex', 'cursor']);
  app.tick('antigravity', false);
  app.tick('claude', false);
  app.tick('cursor', false);
  assert.deepEqual(app.views().at(-1), ['codex']);
  assert.equal(app.saves.at(-1)!.sources !== undefined && JSON.stringify(app.saves.at(-1)!.sources), '["codex"]');
});

test('unticking the last tool or ticking them all, or ticking All, goes back to every tool', () => {
  const app = boot(month(['claude', 'codex']));
  app.tick('claude', false);
  assert.deepEqual(app.views().at(-1), ['codex']);
  app.tick('codex', false);
  assert.deepEqual(app.views().at(-1), [], 'nothing left ticked means every tool');
  app.tick('claude', true);
  app.tick('codex', true);
  assert.deepEqual(app.views().at(-1), [], 'every tool ticked means every tool');
  app.tick('claude', false);
  app.tickAll();
  assert.deepEqual(app.views().at(-1), []);
});

test('the menu stays open and the picked tools stay picked when the page refreshes', () => {
  const summary = month(SOURCES, 2);
  const app = boot(summary);
  app.toggle();
  app.tick('codex', false);
  app.render(renderBody(summary, cfg, sessionView({ sources: ['antigravity', 'dsh', 'claude'] })));
  assert.equal(app.open(), true, 'a refresh does not shut the menu');
  assert.deepEqual([...app.document.querySelectorAll('input[data-filter]')].filter((box) => box.hasAttribute('checked')).map((box) => box.getAttribute('data-filter')), ['antigravity', 'dsh', 'claude']);
  assert.equal(app.saves.at(-1)!.sources !== undefined && JSON.stringify(app.saves.at(-1)!.sources), '["antigravity","dsh","claude"]');
});

test('the picked tools come back with the page, and what an older version saved is not mistaken for them', () => {
  const again = boot(month(), { sources: ['claude', 'codex'] });
  assert.deepEqual(again.posts.find((post) => post.type === 'ready')!.view, { sort: 'last:desc', sources: ['claude', 'codex'], page: 0 });
  const older = boot(month(), { filter: 'claude' });
  assert.deepEqual((older.posts.find((post) => post.type === 'ready')!.view as SessionView).sources, []);
  const junk = boot(month(), { sources: 'claude' });
  assert.deepEqual((junk.posts.find((post) => post.type === 'ready')!.view as SessionView).sources, []);
});

test('opening a session shuts the menu', () => {
  const app = boot(month());
  app.toggle();
  assert.equal(app.open(), true);
  app.click(app.document.querySelector('.scard-main')!);
  assert.equal(app.open(), false);
});

test('the sort menu shares the dropdown behavior, closes the tools menu when opened, and picks a sort order', () => {
  const app = boot(month());
  const sortMenu = () => app.document.querySelector('[data-menu="sort"]')!;
  const sortToggle = () => app.document.querySelector('[data-menu-toggle="sort"]')!;
  const sortList = () => app.document.querySelector('#sort-menu-list')!;
  const sortOpen = () => !sortList().hasAttribute('hidden');

  assert.equal(sortOpen(), false);
  app.toggle();
  assert.equal(app.open(), true);
  app.click(sortToggle());
  assert.equal(app.open(), false, 'opening sort shuts the tools menu');
  assert.equal(sortOpen(), true);
  assert.ok(sortMenu().classList.contains('open'));
  assert.equal(sortToggle().getAttribute('aria-expanded'), 'true');

  app.click(app.document.querySelector('[data-sort-option="cost:desc"]')!);
  assert.equal(sortOpen(), false, 'picking a sort order shuts the menu');
  assert.equal(sortToggle().getAttribute('aria-expanded'), 'false');
  assert.equal(sortToggle().querySelector('.multi-label')!.textContent, 'Highest cost');
  assert.equal(app.document.querySelector('[data-sort-option="cost:desc"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(app.document.querySelector('[data-sort-option="last:desc"]')!.getAttribute('aria-pressed'), 'false');
  assert.equal((app.posts.at(-1)!.view as SessionView).sort, 'cost:desc');

  app.click(sortToggle());
  assert.equal(sortOpen(), true);
  app.press('Escape');
  assert.equal(sortOpen(), false);
});
