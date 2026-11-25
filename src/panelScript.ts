import { HOVER_SCRIPT } from './dashboardHover';
export const SCRIPT = `${HOVER_SCRIPT}
(function () {
  var host = (typeof window !== 'undefined' && window.__DOCK_HOST__) || (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined);
  var state = { sortKey: 'last', sortDir: 'desc', page: 0, open: {}, openKey: null, sources: [], group: 'model', pie: 'cost' };
  var saved = host && host.getState();
  if (saved) for (var k in state) if (k in saved) state[k] = saved[k];
  if (state.group !== 'tool') state.group = 'model';
  if (state.pie !== 'tokens') state.pie = 'cost';
  if (!Array.isArray(state.sources)) state.sources = [];
  var openMenu = null;
  var app = document.getElementById('app');
  var popup = document.getElementById('popup');
  var popCard = document.getElementById('pop-card');
  var scrim = document.getElementById('scrim');
  var detail = null;
  var shown = null;
  var deferred = false;
  var dayStop = null;
  var LOADING = '<p class="d-loading">Loading…</p>';
  function save() { if (host) host.setState(state); }
  function post(m) { if (host) host.postMessage(m); }
  function sessionView() { return { sort: state.sortKey + ':' + state.sortDir, sources: state.sources, page: state.page }; }
  function chooseSessions(sort, sources, page) {
    var pair = sort.split(':');
    state.sortKey = pair[0]; state.sortDir = pair[1]; state.sources = sources; state.page = page;
    save(); post({ type: 'setSessionView', view: sessionView() });
  }

  // Keep a menu inside its card so a right-side button aligns its menu to its right edge unless narrow wrapping leaves room only on the right.
  function placeMenu(menu, list) {
    list.style.left = '';
    list.style.right = '';
    if (typeof list.getBoundingClientRect !== 'function') return;
    var card = menu.closest('.card') || app;
    var cardRect = card.getBoundingClientRect();
    var btnRect = menu.getBoundingClientRect();
    var listRect = list.getBoundingClientRect();
    if (!listRect.width || !cardRect.width) return;
    var overhang = listRect.right > cardRect.right - 12 || (menu.dataset.menu === 'sort' && listRect.width > btnRect.width);
    if (overhang && btnRect.right - listRect.width >= cardRect.left + 8) {
      list.style.left = 'auto';
      list.style.right = '0';
    }
  }

  // Menus are open or shut for the page, not for one render: a refresh replaces the markup, so this puts them back as they were.
  function applyMenu() {
    app.querySelectorAll('[data-menu]').forEach(function (menu) {
      var isOpen = menu.dataset.menu === openMenu;
      menu.classList.toggle('open', isOpen);
      var list = menu.querySelector('.multi-list');
      if (list) {
        list.hidden = !isOpen;
        if (isOpen) placeMenu(menu, list);
      }
      var toggle = menu.querySelector('[data-menu-toggle]');
      if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));
    });
  }
  function setMenu(name) { openMenu = name || null; applyMenu(); }

  function applySort(sort) {
    var menu = app.querySelector('[data-menu="sort"]');
    if (!menu) return;
    var picked = null;
    menu.querySelectorAll('[data-sort-option]').forEach(function (item) {
      var on = item.dataset.sortOption === sort;
      item.setAttribute('aria-pressed', String(on));
      if (on) picked = item.textContent;
    });
    var label = menu.querySelector('.multi-label');
    if (label && picked) label.textContent = picked;
    var toggle = menu.querySelector('[data-menu-toggle="sort"]');
    if (toggle && picked) toggle.setAttribute('aria-label', 'Sort sessions: ' + picked);
  }

  // Every ticked tool, or every tool when none is: the page lists the sessions of all tools as one choice.
  function pickedSources(changed) {
    var boxes = Array.prototype.slice.call(app.querySelectorAll('input[data-filter]'));
    if (changed && changed.hasAttribute('data-filter-all')) return [];
    var ticked = boxes.filter(function (box) { return box.checked; }).map(function (box) { return box.dataset.filter; });
    return ticked.length === boxes.length ? [] : ticked;
  }

  // The boxes show the picked tools and nothing else. A click that picks nothing new (All, while every tool is shown) sends no new page, so the browser's own toggle would otherwise stay.
  function applyFilter() {
    var every = state.sources.length === 0;
    app.querySelectorAll('input[data-filter-all]').forEach(function (box) { box.checked = every; });
    app.querySelectorAll('input[data-filter]').forEach(function (box) { box.checked = every || state.sources.indexOf(box.dataset.filter) >= 0; });
  }

  // The bars, their hover and the legend come in both stackings; the card says which one shows. A refresh replaces the card, so this runs again.
  function applyGroup() {
    app.querySelectorAll('[data-group-card]').forEach(function (c) { c.dataset.group = state.group; });
    app.querySelectorAll('[data-group-set]').forEach(function (b) {
      var pressed = b.dataset.groupSet === state.group;
      b.classList.toggle('active', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    });
  }

  function applyPie() {
    app.querySelectorAll('[data-pie-card]').forEach(function (c) { c.dataset.pie = state.pie; });
    app.querySelectorAll('[data-pie-set]').forEach(function (b) {
      var pressed = b.dataset.pieSet === state.pie;
      b.classList.toggle('active', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    });
  }

  function applySections() {
    app.querySelectorAll('details[data-key]').forEach(function (d) {
      if (d.dataset.key in state.open) d.open = state.open[d.dataset.key];
    });
  }

  function markSelected() {
    app.querySelectorAll('.scard[data-key]').forEach(function (c) { c.classList.toggle('open', c.dataset.key === state.openKey); });
  }

  function selectionInPopup() {
    var selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    if (!selection || selection.isCollapsed) return false;
    return !!((selection.anchorNode && popCard.contains(selection.anchorNode)) || (selection.focusNode && popCard.contains(selection.focusNode)));
  }

  // The opened session shows in a popup card above the page, so opening one never moves the list. Its details arrive from
  // the extension and are kept here across refreshes. The card is rebuilt only when its content changed, and not while text in it is
  // selected, which a rebuild would clear: the newer content is shown once the selection is gone.
  function showPopup() {
    var isOpen = !!state.openKey;
    popup.hidden = !isOpen;
    scrim.hidden = !isOpen;
    app.inert = isOpen;
    if (isOpen) app.setAttribute('aria-hidden', 'true');
    else app.removeAttribute('aria-hidden');
    if (!isOpen) { shown = null; deferred = false; return; }
    var html = detail && detail.key === state.openKey ? detail.html : LOADING;
    if (html === shown) { deferred = false; return; }
    if (shown !== null && selectionInPopup()) { deferred = true; return; }
    deferred = false;
    var top = popCard.scrollTop;
    var focused = document.activeElement;
    var hadFocus = focused === popCard || popCard.contains(focused);
    var action = hadFocus && focused instanceof Element ? focused.getAttribute('data-action') : null;
    popCard.innerHTML = html;
    shown = html;
    popCard.scrollTop = top;
    if (hadFocus) {
      var replacement = action && popCard.querySelector('[data-action="' + CSS.escape(action) + '"]');
      (replacement || popCard).focus();
    }
  }

  document.addEventListener('selectionchange', function () {
    if (deferred && !selectionInPopup()) showPopup();
  });

  // The day columns are one tab stop that the arrow keys move; a refresh replaces the columns, so the stop is put back where it was.
  function restoreDayStop() {
    app.querySelectorAll('.cols').forEach(function (cols) {
      var days = cols.querySelectorAll('.col');
      var keep = null;
      for (var i = 0; i < days.length; i++) if (dayStop && days[i].getAttribute('data-focus') === dayStop) keep = days[i];
      if (!keep) return;
      for (var j = 0; j < days.length; j++) days[j].setAttribute('tabindex', days[j] === keep ? '0' : '-1');
    });
  }

  function stepDay(e) {
    var col = e.target instanceof Element ? e.target.closest('.col') : null;
    if (!col || e.altKey || e.ctrlKey || e.metaKey) return;
    var days = Array.prototype.slice.call(col.parentElement.querySelectorAll('.col'));
    var at = days.indexOf(col);
    var targets = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: days.length - 1 };
    if (!Object.prototype.hasOwnProperty.call(targets, e.key)) return;
    e.preventDefault();
    var to = Math.max(0, Math.min(days.length - 1, targets[e.key]));
    dayStop = days[to].getAttribute('data-focus');
    days.forEach(function (day, i) { day.setAttribute('tabindex', i === to ? '0' : '-1'); });
    days[to].focus();
  }
  app.addEventListener('keydown', stepDay);

  function syncSessions() {
    var list = app.querySelector('.slist');
    if (!list) return;
    var pair = list.dataset.sort.split(':');
    state.sortKey = pair[0]; state.sortDir = pair[1];
    state.sources = list.dataset.sources ? list.dataset.sources.split(',') : [];
    state.page = Number(list.dataset.page);
    markSelected();
    save();
  }



  // Show every Nth day label, as many as fit in the chart's real width. Runs again whenever the page is resized.
  function thinDayLabels() {
    app.querySelectorAll('.xaxis').forEach(function (axis) {
      if (!axis.children.length || !axis.getBoundingClientRect().width) return;
      var labels = axis.children;
      var n = labels.length;
      var step = Math.max(1, Math.ceil(18 / (axis.getBoundingClientRect().width / n)));
      var today = -1;
      for (var i = 0; i < n; i++) if (labels[i].classList.contains('today')) today = i;
      for (var j = 0; j < n; j++) {
        var shown = j % step === 0;
        if (today >= 0 && j !== today && Math.abs(j - today) < step) shown = false;
        labels[j].style.visibility = shown || j === today ? '' : 'hidden';
      }
    });
  }

  function openSession(key) {
    setMenu(null);
    state.openKey = key;
    detail = null;
    save();
    markSelected();
    showPopup();
    post({ type: 'openSession', key: key });
    popCard.focus();
  }

  function closeSession() {
    var key = state.openKey;
    state.openKey = null;
    detail = null;
    save();
    markSelected();
    showPopup();
    post({ type: 'closeSession' });
    var btn = key && app.querySelector('.scard[data-key="' + CSS.escape(key) + '"] .scard-main');
    var fallback = app.querySelector('[data-month-select], button:not([disabled]), select:not([disabled])');
    if (!btn && !fallback) app.tabIndex = -1;
    (btn || fallback || app).focus();
  }

  // The popup and the selection belong to the month on screen, so both are dropped before the page changes month.
  function chooseMonth(month) {
    if (state.openKey) closeSession();
    state.page = 0;
    save();
    post({ type: 'setMonth', month: month });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (openMenu && !t.closest('[data-menu]')) setMenu(null);
    var toggle = t.closest('[data-menu-toggle], [data-multi-toggle]');
    if (toggle) {
      var which = toggle.dataset.menuToggle || 'filter';
      setMenu(openMenu === which ? null : which);
      return;
    }
    var sortBtn = t.closest('[data-sort-option]');
    if (sortBtn && app.contains(sortBtn)) {
      var sort = sortBtn.dataset.sortOption;
      setMenu(null);
      applySort(sort);
      chooseSessions(sort, state.sources, 0);
      var sortToggle = app.querySelector('[data-menu-toggle="sort"]');
      if (sortToggle) sortToggle.focus();
      return;
    }
    var page = t.closest('button[data-page]');
    if (page && !page.disabled) { chooseSessions(sessionView().sort, state.sources, Number(page.dataset.page)); return; }
    if (t.closest('[data-action="configure-rates"]')) { post({ type: 'configureRates' }); return; }
    if (t.closest('[data-action="open-log"]')) { post({ type: 'openLog', key: state.openKey }); return; }
    if (t.closest('[data-action="close"]') || ((t === scrim || t === popup) && downTarget === t)) { closeSession(); return; }
    var pie = t.closest('[data-pie-set]');
    if (pie) { state.pie = pie.dataset.pieSet === 'tokens' ? 'tokens' : 'cost'; save(); applyPie(); thinDayLabels(); return; }
    var group = t.closest('[data-group-set]');
    if (group) { state.group = group.dataset.groupSet === 'tool' ? 'tool' : 'model'; save(); applyGroup(); return; }
    var zone = t.closest('[data-zone]');
    if (zone) { post({ type: 'setTimeZone', zone: zone.dataset.zone }); return; }
    var month = t.closest('[data-month]');
    if (month && app.contains(month)) {
      if (month.closest('[data-menu="month"]')) setMenu(null);
      chooseMonth(month.dataset.month);
      return;
    }
    var main = t.closest('.scard-main');
    if (main && app.contains(main)) openSession(main.closest('.scard').dataset.key);
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t instanceof HTMLInputElement && (t.hasAttribute('data-filter') || t.hasAttribute('data-filter-all'))) {
      chooseSessions(sessionView().sort, pickedSources(t), 0);
      applyFilter();
    }
  });

  // A drag that starts inside the card (selecting a path or prompt) and ends outside it must not count as a click outside.
  var downTarget = null;
  document.addEventListener('mousedown', function (e) { downTarget = e.target; });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Tab' && state.openKey) {
      var items = Array.prototype.slice.call(popCard.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(function (el) { return !el.hidden && !el.closest('[hidden]'); });
      var first = items[0] || popCard, last = items[items.length - 1] || popCard;
      if (!popCard.contains(document.activeElement) || document.activeElement === popCard || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    var target = e.target instanceof Element ? e.target : null;
    if (target && !e.altKey && !e.ctrlKey && !e.metaKey) {
      var menu = target.closest('[data-menu]');
      if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
        var list = menu.querySelector('.multi-list');
        var choices = list ? Array.prototype.slice.call(list.querySelectorAll('input:not([disabled]), button.multi-item:not([disabled])')) : [];
        if (choices.length) {
          e.preventDefault();
          if (openMenu !== menu.dataset.menu) {
            setMenu(menu.dataset.menu);
            var active = choices.find(function (el) { return el.getAttribute('aria-pressed') === 'true'; });
            (e.key === 'ArrowUp' || e.key === 'End' ? choices[choices.length - 1] : active || choices[0]).focus();
          } else {
            var idx = choices.indexOf(target);
            var next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : idx < 0 ? 0 : (idx + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
            choices[next].focus();
          }
          return;
        }
      }
    }
    if (e.key !== 'Escape') return;
    if (openMenu) {
      var closed = openMenu;
      setMenu(null);
      var toggle = app.querySelector('[data-menu-toggle="' + CSS.escape(closed) + '"]');
      if (toggle) toggle.focus();
      return;
    }
    if (state.openKey) closeSession();
  });

  // Tabbing out of an open menu shuts it.
  document.addEventListener('focusin', function (e) {
    if (openMenu && !(e.target instanceof Element && e.target.closest('[data-menu]'))) setMenu(null);
  });

  // 'toggle' does not bubble, so listen in the capture phase.
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.key) return;
    state.open[d.dataset.key] = d.open;
    save();
    // The legend is in the page twice, by cost and by tokens, and opening one opens the other.
    app.querySelectorAll('details[data-key="' + CSS.escape(d.dataset.key) + '"]').forEach(function (other) { if (other !== d && other.open !== d.open) other.open = d.open; });
    if (d.open) thinDayLabels();
  }, true);

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'render') {
      var focused = document.activeElement;
      var restore = focused instanceof Element && app.contains(focused);
      var anchor = restore ? focused.getAttribute('data-focus') : null;
      if (typeof m.html !== 'string') return;
      document.body.classList.remove('theme-light', 'theme-dark', 'theme-auto');
      document.body.classList.add('theme-' + (m.theme === 'dark' || m.theme === 'auto' ? m.theme : 'light'));
      app.innerHTML = m.html;
      applyGroup();
      applyPie();
      applySections();
      syncSessions();
      applyMenu();
      restoreDayStop();
      thinDayLabels();
      if (restore) {
        var target = anchor && app.querySelector('[data-focus="' + CSS.escape(anchor) + '"]:not([disabled])');
        var fallback = app.querySelector('.session-pages button:not([disabled])') || app.querySelector('[data-focus="session-sort"]') || app.querySelector('[data-month-select]');
        (target || fallback || app).focus({ preventScroll: true });
      }
    } else if (m.type === 'detail' && m.key === state.openKey && typeof m.html === 'string') {
      detail = { key: m.key, html: m.html };
      showPopup();
    }
  });

  applyGroup();
  applyPie();
  applySections();
  markSelected();
  thinDayLabels();
  if (typeof ResizeObserver === 'function') new ResizeObserver(thinDayLabels).observe(app);
  if (state.openKey) {
    showPopup();
    post({ type: 'openSession', key: state.openKey });
  }
  post({ type: 'ready', view: sessionView() });
})();
`;
