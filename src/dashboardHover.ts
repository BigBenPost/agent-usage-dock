export const HOVER_STYLE = `
  #dashboard-tooltip { position: fixed; z-index: 1000; width: max-content; max-width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: hidden; box-sizing: border-box; padding: 8px 11px; border-radius: 8px; pointer-events: none; white-space: pre-line; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; background: var(--tip-bg); color: var(--tip-ink); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22); }
`;

// Native title hovers on disabled controls vary across Electron versions and reset when the dashboard replaces its DOM.
export const HOVER_SCRIPT = `
(function () {
  var tip = document.createElement('div');
  tip.id = 'dashboard-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  var owner = null;
  var described = null;
  var repeated = false;
  var point = null;
  var dismissed = null;

  function prepare() {
    document.querySelectorAll('[title]').forEach(function (el) {
      el.setAttribute('data-hover', el.getAttribute('title'));
      el.removeAttribute('title');
    });
  }

  function hide() {
    if (owner && !repeated) {
      if (described === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', described);
    }
    owner = null;
    tip.hidden = true;
  }

  function show(target, mouse) {
    var next = target instanceof Element ? target.closest('[data-hover]') : null;
    if (next !== dismissed) dismissed = null;
    if (!next || !next.getAttribute('data-hover') || next === dismissed) { hide(); return; }
    if (owner !== next) {
      hide();
      owner = next;
      described = owner.getAttribute('aria-describedby');
      var label = owner.getAttribute('aria-label');
      var first = next.getAttribute('data-hover').split('\\n')[0];
      // A label that already says what the hover says is not read twice.
      repeated = label !== null && first !== '' && label.indexOf(first) !== -1;
      if (!repeated) owner.setAttribute('aria-describedby', (described ? described + ' ' : '') + tip.id);
    }
    var text = owner.getAttribute('data-hover');
    if (tip.textContent !== text) tip.textContent = text;
    tip.hidden = false;
    var anchor = owner.getBoundingClientRect();
    var bounds = tip.getBoundingClientRect();
    var x = mouse ? mouse.x + 12 : anchor.left;
    var y = mouse ? mouse.y + 16 : anchor.bottom + 6;
    if (y + bounds.height > window.innerHeight - 8) y = (mouse ? mouse.y : anchor.top) - bounds.height - 8;
    tip.style.left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  function refresh() {
    prepare();
    var focused = document.activeElement;
    if (point) show(document.elementFromPoint(point.x, point.y), point);
    else show(focused, null);
  }

  document.addEventListener('pointermove', function (e) {
    point = { x: e.clientX, y: e.clientY };
    show(e.target, point);
  }, true);
  document.addEventListener('pointerover', function (e) {
    point = { x: e.clientX, y: e.clientY };
    show(e.target, point);
  }, true);
  document.documentElement.addEventListener('pointerleave', function () { point = null; hide(); });
  document.addEventListener('focusin', function (e) { point = null; dismissed = null; show(e.target, null); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', function () { dismissed = owner; hide(); }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && owner) { dismissed = owner; hide(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('scroll', refresh, true);
  window.addEventListener('blur', function () { point = null; hide(); });
  window.addEventListener('resize', refresh);
  var observer = new MutationObserver(refresh);
  ['app', 'pop-card'].forEach(function (id) {
    var target = document.getElementById(id);
    if (target) observer.observe(target, { childList: true, subtree: true });
  });
  prepare();
})();
`;
