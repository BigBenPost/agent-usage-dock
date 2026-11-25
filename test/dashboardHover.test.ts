import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { HOVER_SCRIPT } from '../src/dashboardHover';

class Element {
  attrs = new Map<string, string>();
  hidden = false;
  textContent = '';
  id = '';
  style: Record<string, string> = {};
  parent: Element | null = null;
  getAttribute(key: string): string | null { return this.attrs.get(key) ?? null; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  removeAttribute(key: string): void { this.attrs.delete(key); }
  closest(): Element | null { return this.attrs.has('data-hover') ? this : this.parent?.closest() ?? null; }
  getBoundingClientRect() { return { left: 290, top: 570, bottom: 596, width: 260, height: 80 }; }
  addEventListener() {}
}

function dashboard() {
  const handlers = new Map<string, (event: any) => void>();
  const target = new Element();
  target.setAttribute('title', 'Cannot select <private & active> session');
  target.setAttribute('aria-describedby', 'existing-help');
  let tip: Element;
  let hit = target;
  let refresh: () => void;
  const document = {
    body: { appendChild: (el: Element) => { tip = el; } },
    documentElement: new Element(),
    createElement: () => new Element(),
    querySelectorAll: () => [target, hit].filter((el, i, all) => el.attrs.has('title') && all.indexOf(el) === i),
    getElementById: () => new Element(),
    elementFromPoint: () => hit,
    activeElement: target,
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  };
  runInNewContext(HOVER_SCRIPT, {
    document, Element,
    window: { innerWidth: 320, innerHeight: 600, addEventListener() {} },
    MutationObserver: class {
      constructor(callback: () => void) { refresh = callback; }
      observe() {}
    },
  });
  return {
    target, get tip() { return tip!; },
    send: (name: string, extra = {}) => handlers.get(name)!({ target: hit, clientX: 310, clientY: 590, ...extra }),
    replace: () => {
      hit = new Element();
      hit.setAttribute('title', 'Updated selection reason');
      refresh!();
      return hit;
    },
  };
}

test('hover text stays literal, fits the viewport and preserves accessible descriptions', () => {
  const d = dashboard();
  d.send('pointermove');
  assert.equal(d.tip.hidden, false);
  assert.equal(d.tip.textContent, 'Cannot select <private & active> session');
  assert.equal(d.target.getAttribute('title'), null);
  assert.equal(d.target.getAttribute('aria-describedby'), 'existing-help dashboard-tooltip');
  assert.equal(d.tip.style.left, '52px');
  assert.equal(d.tip.style.top, '502px');
  d.send('focusout');
  assert.equal(d.tip.hidden, true);
  assert.equal(d.target.getAttribute('aria-describedby'), 'existing-help');
});

test('a stationary hover follows a dashboard replacement and remains visible on scroll', () => {
  const d = dashboard();
  d.send('pointerover');
  const replacement = d.replace();
  assert.equal(d.tip.hidden, false);
  assert.equal(d.tip.textContent, 'Updated selection reason');
  assert.equal(d.target.getAttribute('aria-describedby'), 'existing-help');
  assert.equal(replacement.getAttribute('aria-describedby'), 'dashboard-tooltip');
  d.send('scroll');
  assert.equal(d.tip.hidden, false);
});

test('keyboard focus shows the reason and Escape dismisses it until the next interaction', () => {
  const d = dashboard();
  d.send('focusin');
  assert.equal(d.tip.hidden, false);
  let stopped = false;
  d.send('keydown', { key: 'Escape', stopImmediatePropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(d.tip.hidden, true);
  d.send('pointermove');
  assert.equal(d.tip.hidden, true);
  d.send('focusin');
  assert.equal(d.tip.hidden, false);
});

test('a hover that repeats the element\'s own label is not announced a second time, and one that adds to it is', () => {
  const d = dashboard();
  d.target.setAttribute('aria-label', 'Cannot select <private & active> session, and more words');
  d.send('pointermove');
  assert.equal(d.tip.hidden, false, 'it still shows');
  assert.equal(d.target.getAttribute('aria-describedby'), 'existing-help', 'but is not added as a description');
  d.send('focusout');
  assert.equal(d.target.getAttribute('aria-describedby'), 'existing-help');

  const e = dashboard();
  e.target.setAttribute('aria-label', 'Session');
  e.send('pointermove');
  assert.equal(e.target.getAttribute('aria-describedby'), 'existing-help dashboard-tooltip');
  e.send('focusout');
  assert.equal(e.target.getAttribute('aria-describedby'), 'existing-help');

  const f = dashboard();
  f.target.setAttribute('data-hover', 'Full title\nInput 1,500 · Output 2,000');
  f.target.setAttribute('aria-label', 'Full title, $1.00, Antigravity. Input 1,500 · Output 2,000');
  f.send('pointermove');
  assert.equal(f.tip.textContent, 'Full title\nInput 1,500 · Output 2,000');
  assert.equal(f.target.getAttribute('aria-describedby'), 'existing-help', 'the first line of a card\'s hover is the name its label starts with');
});
