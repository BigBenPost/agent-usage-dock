import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderBody, renderPage } from '../src/panelHtml';
import { normalizeConfig } from '../src/configValues';
import { summarize } from '../src/summary';
import { Pricing } from '../src/pricing';
import { aggregate } from '../src/reconcile';

test('dashboard initializes, opens a session in its popup, traps Tab inside it, closes it, and takes a new render', () => {
  const cfg = normalizeConfig({});
  const facts = aggregate({ one: { id: 'one', source: 'antigravity', day: '2026-11-14', model: 'gemini-1.5-flash', session: 's', title: 'Example', tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } } });
  const summary = summarize(facts, new Pricing(), Date.parse('2026-11-14'));
  const html = renderPage(summary, cfg);
  const { window, document } = parseHTML(html);
  let focused: any = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  const posted: any[] = [];
  const context = {
    window, document, Element: window.Element, MutationObserver: window.MutationObserver,
    CSS: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c) },
    HTMLSelectElement: window.HTMLSelectElement, HTMLInputElement: window.HTMLInputElement, HTMLDetailsElement: window.HTMLElement,
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => {}, postMessage: (message: unknown) => posted.push(message) }),
  };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  assert.equal(posted[0].type, 'ready');
  document.querySelector('.scard-main')!.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(posted[1].type, 'openSession');
  assert.equal(posted[1].key, 'antigravity:s');
  assert.equal((document.getElementById('app') as any).inert, true);
  const message = new window.Event('message');
  Object.assign(message, { data: { type: 'render', theme: 'dark', html: renderBody(summary, cfg) } });
  window.dispatchEvent(message);
  assert.equal(document.body.classList.contains('theme-dark'), true);
  assert.equal(document.querySelectorAll('.scard[data-key]').length, 1);
  const detail = new window.Event('message');
  Object.assign(detail, { data: { type: 'detail', key: 'antigravity:s', html: '<button data-action="close">Close</button><button data-action="open-log">Open log</button>' } });
  window.dispatchEvent(detail);
  const keydown = (shiftKey: boolean) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Tab', shiftKey });
    document.dispatchEvent(event);
  };
  document.querySelector('[data-action="open-log"]')!.focus();
  keydown(false);
  assert.equal(focused, document.querySelector('[data-action="close"]'));
  keydown(true);
  assert.equal(focused, document.querySelector('[data-action="open-log"]'));
  document.querySelector('[data-action="close"]')!.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(posted.at(-1).type, 'closeSession');
  assert.equal((document.getElementById('app') as any).inert, false);
});
