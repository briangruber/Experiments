/* Panes 95 window manager: z-order, drag, resize, minimise/maximise,
   taskbar buttons, and modal dialogs. Applications never touch the DOM
   outside the .win-body they are handed. */

import { h, svg, clear, drag, clamp, $ } from './dom.js';
import { icon, ICONS } from './icons.js';
import * as A from './audio.js';

const layer   = () => $('#windows');
const tasks   = () => $('#tasks');
const modals  = () => $('#modal-layer');

const open = new Map();      // id -> win
let zTop = 100;
let cascade = 0;
let active = null;

export const windows = () => [...open.values()];
export const getWindow = id => open.get(id) || null;

function smallIcon(name) {
  const el = (ICONS[name] || ICONS.doc)();
  el.setAttribute('width', 16); el.setAttribute('height', 16);
  return el;
}

function tbtnGlyph(kind) {
  const s = svg('svg', { viewBox: '0 0 9 8', width: 9, height: 8, 'shape-rendering': 'crispEdges' });
  const r = (x, y, w, hh) => s.append(svg('rect', { x, y, width: w, height: hh, fill: '#000' }));
  if (kind === 'min') r(1, 6, 7, 2);
  if (kind === 'max') { r(0, 0, 9, 8); s.append(svg('rect', { x: 1, y: 2, width: 7, height: 5, fill: '#c0c0c0' })); }
  if (kind === 'restore') {
    r(2, 0, 7, 3); s.append(svg('rect', { x: 3, y: 1, width: 5, height: 1, fill: '#c0c0c0' }));
    r(0, 3, 7, 5); s.append(svg('rect', { x: 1, y: 5, width: 5, height: 2, fill: '#c0c0c0' }));
  }
  if (kind === 'close') {
    s.setAttribute('viewBox', '0 0 8 8');
    s.append(svg('path', {
      d: 'M0 1h1V0h1v1h1v1h2V1h1V0h1v1h1v1H7v1H6v2h1v1h1v1H7v1H6V7H5V6H3v1H2v1H0V7h1V6h1V5h1V3H2V2H1z',
      fill: '#000',
    }));
  }
  return s;
}

/**
 * Open (or focus, when `id` names an already-open window) an application
 * window. Returns a handle the application keeps for its lifetime.
 */
export function openWindow(opts) {
  const {
    id = 'win-' + (++cascade), title = 'Untitled', icon: iconName = 'doc',
    width = 480, height = 340, minWidth = 220, minHeight = 120,
    x, y, resizable = true, maximised = false, menu = null, status = null,
    taskbar = true, onClose, onResize, onFocus, chromeless = false,
    parent = null,
  } = opts;

  const existing = open.get(id);
  if (existing) { existing.focus(); return existing; }

  // An MDI child is confined to its parent's client area and keeps no
  // taskbar button of its own: the frame window already has one.
  const host = parent || layer();
  const mdi = !!parent;
  const area = host.getBoundingClientRect();
  const w = Math.min(width, area.width - 12);
  const hh = Math.min(height, area.height - 12);
  const step = (cascade++ % 8) * 22;
  const left = x != null ? x : clamp(Math.round((area.width - w) / 2 - 60) + step, 4, area.width - w - 4);
  const top  = y != null ? y : clamp(Math.round((area.height - hh) / 2 - 40) + step, 4, area.height - hh - 4);

  const ttext = h('div.ttext', {}, title);
  const btnMin = h('button.tbtn', { type: 'button', title: 'Minimize' }, tbtnGlyph('min'));
  const btnMax = h('button.tbtn', { type: 'button', title: 'Maximize' }, tbtnGlyph('max'));
  const btnCls = h('button.tbtn', { type: 'button', title: 'Close' }, tbtnGlyph('close'));

  const titlebar = h('div.win-title', {},
    smallIcon(iconName), ttext,
    h('div.tbtns', {}, resizable ? [btnMin, btnMax] : [btnMin], btnCls));

  const body = h('div.win-body');
  const statusbar = status ? h('div.win-status') : null;
  const grip = resizable ? h('div.win-grip') : null;

  const el = h('div.win.opening', {
    style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px' },
  }, chromeless ? [] : [titlebar], menu ? buildMenu(menu) : null, body, statusbar, grip);

  if (mdi) el.classList.add('mdi');
  host.append(el);
  setTimeout(() => el.classList.remove('opening'), 200);

  const win = {
    id, el, body, titlebar,
    get title() { return ttext.textContent; },
    setTitle(t) { ttext.textContent = t; if (taskEl) taskEl.querySelector('span').textContent = t; },
    setStatus(parts) {
      if (!statusbar) return;
      clear(statusbar);
      for (const p of [].concat(parts)) statusbar.append(h('span', {}, p));
    },
    focus() { focus(win); },
    close() { closeWindow(win); },
    flash(on = true) { if (taskEl) taskEl.classList.toggle('flash', on); },
    minimise() { setMin(true); },
    restore() { setMin(false); },
    get minimised() { return el.classList.contains('minimised'); },
    onClose,
    size() { return { w: el.offsetWidth, h: el.offsetHeight }; },
  };
  open.set(id, win);

  /* Taskbar button ---------------------------------------------------- */
  let taskEl = null;
  if (taskbar && !mdi) {
    taskEl = h('button.task', {
      type: 'button',
      onclick: () => {
        if (active === win && !win.minimised) setMin(true);
        else { setMin(false); focus(win); }
      },
    }, smallIcon(iconName), h('span', {}, title));
    tasks().append(taskEl);
  }
  win.taskEl = taskEl;

  function setMin(on) {
    el.classList.toggle('minimised', on);
    if (on) {
      taskEl && taskEl.classList.remove('on');
      if (active === win) { active = null; el.classList.remove('active'); }
      const next = [...open.values()].filter(v => !v.minimised)
        .sort((a, b) => (+a.el.style.zIndex) - (+b.el.style.zIndex)).pop();
      if (next) focus(next);
    } else { taskEl && taskEl.classList.remove('flash'); focus(win); }
  }

  /* Behaviour --------------------------------------------------------- */
  el.addEventListener('pointerdown', () => focus(win), true);

  let dx0 = 0, dy0 = 0;
  drag(titlebar, ev => {
    if (ev.target.closest('.tbtn')) return false;
    if (el.classList.contains('maxed')) return false;
    dx0 = el.offsetLeft; dy0 = el.offsetTop; focus(win);
    el.style.willChange = 'left, top';
  }, (mx, my) => {
    const a = host.getBoundingClientRect();
    el.style.left = clamp(dx0 + mx, mdi ? 0 : 8 - el.offsetWidth, a.width - 40) + 'px';
    el.style.top  = clamp(dy0 + my, 0, a.height - 24) + 'px';
  }, () => { el.style.willChange = ''; });

  if (grip) {
    let w0 = 0, h0 = 0;
    drag(grip, () => { w0 = el.offsetWidth; h0 = el.offsetHeight; focus(win); },
      (mx, my) => {
        el.style.width  = Math.max(minWidth,  w0 + mx) + 'px';
        el.style.height = Math.max(minHeight, h0 + my) + 'px';
        onResize && onResize(win);
      }, () => onResize && onResize(win));
  }

  btnMin.addEventListener('click', () => { A.click(); setMin(true); });
  btnCls.addEventListener('click', () => { A.click(); closeWindow(win); });

  let restoreBox = null;
  function toggleMax() {
    A.click();
    if (el.classList.contains('maxed')) {
      Object.assign(el.style, restoreBox);
      el.classList.remove('maxed');
      clear(btnMax).append(tbtnGlyph('max'));
    } else {
      restoreBox = { left: el.style.left, top: el.style.top,
                     width: el.style.width, height: el.style.height };
      Object.assign(el.style, { left: '0px', top: '0px', width: '100%', height: '100%' });
      el.classList.add('maxed');
      clear(btnMax).append(tbtnGlyph('restore'));
    }
    onResize && onResize(win);
  }
  if (resizable) {
    btnMax.addEventListener('click', toggleMax);
    titlebar.addEventListener('dblclick', ev => {
      if (!ev.target.closest('.tbtn')) toggleMax();
    });
  }
  win.toggleMax = toggleMax;

  if (status) win.setStatus(status);
  if (maximised && resizable) toggleMax();
  focus(win);
  if (onFocus) win.onFocusCb = onFocus;
  return win;
}

/**
 * A real menu bar with drop-downs.
 *
 * `defs` is [{ label, items: [{ label, accel, onclick, disabled } | '-'] }].
 * Modelled on the Go To menu in America Online 2.x, which is where the
 * accelerators in the Halcyon menus come from: Keyword was Ctrl+K, the
 * Lobby was Ctrl+L, Favorite Places was Ctrl+B.
 */
export function menuBar(defs) {
  const bar = h('div.win-menu');
  let openMenu = null;

  const closeAll = () => {
    if (!openMenu) return;
    openMenu.pop.remove();
    openMenu.btn.classList.remove('on');
    openMenu = null;
    document.removeEventListener('pointerdown', onAway, true);
  };
  const onAway = ev => { if (!ev.target.closest('.win-menu')) closeAll(); };

  for (const def of defs) {
    const label = typeof def === 'string' ? def : def.label;
    const btn = h('button', { type: 'button' });
    btn.append(h('u', {}, label[0]), label.slice(1));

    const show = () => {
      const wasOpen = openMenu && openMenu.btn === btn;
      closeAll();
      if (wasOpen || !def.items || !def.items.length) return;

      const pop = h('div.menu-pop');
      for (const it of def.items) {
        if (it === '-') { pop.append(h('div.menu-sep')); continue; }
        const row = h('button.menu-item', {
          type: 'button',
          disabled: !!it.disabled,
          onclick: () => { closeAll(); if (it.onclick) it.onclick(); else A.beep(); },
        }, h('span', {}, it.label), h('em', {}, it.accel || ''));
        pop.append(row);
      }
      bar.append(pop);
      pop.style.left = (btn.offsetLeft) + 'px';
      btn.classList.add('on');
      openMenu = { btn, pop };
      document.addEventListener('pointerdown', onAway, true);
    };

    btn.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      if (!def.items || !def.items.length) {
        closeAll();
        if (def.onclick) def.onclick(); else A.beep();
        return;
      }
      show();
    });
    btn.addEventListener('pointerenter', () => { if (openMenu && openMenu.btn !== btn) show(); });
    bar.append(btn);
  }

  bar.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeAll(); });
  bar.close = closeAll;
  return bar;
}

function buildMenu(items) {
  return menuBar(items.map(it => typeof it === 'string'
    ? { label: it, items: [] }
    : (it.items ? it : { label: it.label, items: [], onclick: it.onclick })));
}

export function focus(win) {
  if (active === win && win.el.style.zIndex) return;
  if (active) { active.el.classList.remove('active'); active.taskEl?.classList.remove('on'); }
  active = win;
  win.el.classList.add('active');
  win.el.style.zIndex = ++zTop;
  win.taskEl?.classList.add('on');
  win.taskEl?.classList.remove('flash');
  win.el.classList.remove('minimised');
  win.onFocusCb && win.onFocusCb(win);
}

export function closeWindow(win) {
  if (!open.has(win.id)) return;
  if (win.onClose && win.onClose(win) === false) return;
  open.delete(win.id);
  win.el.remove();
  win.taskEl?.remove();
  if (active === win) {
    active = null;
    const next = [...open.values()].filter(v => !v.minimised)
      .sort((a, b) => (+a.el.style.zIndex) - (+b.el.style.zIndex)).pop();
    if (next) focus(next);
  }
}

export function closeAll() { [...open.values()].forEach(closeWindow); }

/* ── Dialogs ─────────────────────────────────────────────────────────── */

/**
 * The 95 message box. `buttons` are labels; resolves with the chosen one,
 * or null if closed. `input` turns it into a prompt.
 */
export function dialog({
  title = 'Panes 95', message = '', icon: kind = 'info',
  buttons = ['OK'], input = null, sound = true, extra = null,
} = {}) {
  return new Promise(resolve => {
    if (sound) kind === 'error' ? A.ding() : A.beep();
    const back = h('div.modal-back');
    let field = null;
    if (input != null) {
      field = h('input.field', {
        type: 'text', value: String(input.value ?? ''),
        maxLength: input.maxLength || 64, spellcheck: false,
        style: { width: '100%', marginTop: '8px' },
      });
    }

    const dlg = h('div.win.dialog.active', {},
      h('div.win-title', {},
        h('div.ttext', {}, title),
        h('div.tbtns', {}, h('button.tbtn', {
          type: 'button', onclick: () => done(null),
        }, tbtnGlyph('close')))),
      h('div.win-body', {},
        h('div.dlg-row', {},
          h('div.dlg-icon', {}, iconSized(kind, 32)),
          h('div', { style: { flex: '1' } },
            h('div.dlg-msg.selectable', {}, ...String(message).split('\n')
              .flatMap((l, i) => i ? [h('br'), l] : [l])),
            field, extra))),
      h('div.dlg-btns', {},
        buttons.map((b, i) => h('button.btn', {
          type: 'button', onclick: () => done(b),
        }, b))));

    modals().append(back, dlg);
    setTimeout(() => (field || dlg.querySelector('.btn'))?.focus(), 20);

    const key = ev => {
      if (ev.key === 'Escape') done(null);
      if (ev.key === 'Enter' && field) { ev.preventDefault(); done(buttons[0]); }
    };
    dlg.addEventListener('keydown', key);

    function done(choice) {
      back.remove(); dlg.remove();
      resolve(field && choice === buttons[0]
        ? { button: choice, value: field.value }
        : (field ? { button: choice, value: null } : choice));
    }
  });
}

function iconSized(name, size) {
  const el = icon(name, size);
  el.classList.remove('glyph');
  return el;
}

export const alertBox = (message, title = 'Panes 95', kind = 'info') =>
  dialog({ message, title, icon: kind });
export const confirmBox = (message, title = 'Confirm') =>
  dialog({ message, title, icon: 'warn', buttons: ['OK', 'Cancel'] }).then(b => b === 'OK');
