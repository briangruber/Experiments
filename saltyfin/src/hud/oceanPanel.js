// The ocean settings panel.
//
// A sheet of sliders over the canvas, driven entirely by the schema in
// water/settings.js — this file knows about "a control has a min, a max and a
// label" and nothing else, so adding a knob is one entry there and no change
// here.
//
// Built for a thumb first. The rows are 44 px of touch target with the slider
// stretched across the full width, the sheet slides up from the bottom on a
// phone and sits as a column on the right on a desktop, and it never covers the
// bottom third of the screen — that is where the water the player is judging
// is, and a settings panel that hides the thing being set is useless. It closes
// on Escape and on Done, and on nothing else — not on a tap outside, because a
// thumb reaching for the helm must not throw it away mid-adjustment.
//
// Like touch.js, this module owns its own markup and its own stylesheet and
// reaches into nothing else's.

import { oceanSettings } from '../water/settings.js';

const CSS = `
/* The root spans the viewport so the sheet can be positioned against it, but it
   does NOT take pointer events — only the sheet does. That is deliberate and it
   is the whole ergonomic point: with a scrim over the canvas you cannot drive
   while you tune, and tuning water you are not moving through tells you very
   little. There is no tap-outside-to-dismiss for the same reason — a stray
   thumb on the helm must not throw the panel away mid-adjustment. Done, or Esc. */
#sf-ocean { position: fixed; inset: 0; z-index: 70; display: none;
  pointer-events: none;
  font: 500 12px/1.4 ui-sans-serif, system-ui, sans-serif;
  -webkit-user-select: none; user-select: none; }
#sf-ocean.on { display: block; }
#sf-ocean .sf-sheet { position: absolute; pointer-events: auto;
  overflow-y: auto; overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: rgba(7, 18, 32, .82); backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
  border: 1px solid rgba(206, 232, 255, .16);
  box-shadow: 0 12px 44px rgba(0, 0, 0, .45); color: #dbeaf8; }

/* Desktop: a column on the right, clear of the compass and the minimap. */
#sf-ocean .sf-sheet { top: 64px; right: 14px; width: 306px; max-height: calc(100vh - 190px);
  border-radius: 14px; padding: 12px 14px 16px; }
/* Phone: a bottom sheet, capped so the horizon and the near water stay visible. */
@media (pointer: coarse), (max-width: 720px) {
  #sf-ocean .sf-sheet { top: auto; left: 0; right: 0; width: auto;
    bottom: 0; max-height: 56vh;
    border-radius: 16px 16px 0 0; border-bottom: 0;
    padding: 10px 16px calc(18px + env(safe-area-inset-bottom)); }
  /* The top 44% keeps both touch zones, so the helm and the camera still work
     with the sheet up — see the pointer-events note above. */
}

#sf-ocean .sf-head { display: flex; align-items: center; justify-content: space-between;
  gap: 10px; position: sticky; top: 0; z-index: 1; margin: -2px -2px 6px;
  padding: 6px 2px 8px; background: linear-gradient(rgba(7,18,32,.96), rgba(7,18,32,.72)); }
#sf-ocean .sf-title { font: 700 10px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .18em; text-transform: uppercase; color: rgba(214, 236, 255, .82); }
#sf-ocean .sf-head button { appearance: none; border: 1px solid rgba(206, 232, 255, .22);
  background: rgba(12, 28, 48, .7); color: #cfe4f6; border-radius: 999px;
  padding: 6px 11px; font: 700 9px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
#sf-ocean .sf-head button:active { background: rgba(122, 178, 232, .34); color: #fff; }
#sf-ocean .sf-head .sf-actions { display: flex; gap: 6px; }

#sf-ocean .sf-group { font: 700 9px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .18em; text-transform: uppercase; color: rgba(140, 190, 235, .72);
  margin: 14px 0 4px; padding-bottom: 5px;
  border-bottom: 1px solid rgba(206, 232, 255, .12); }
#sf-ocean .sf-group:first-of-type { margin-top: 2px; }

/* Thirteen controls have to fit a 56vh sheet without the scroll becoming the
   experience, so the row is as tight as a 26 px thumb target allows: one line
   of label, the hint tucked under it at 10 px, and the slider's own box doing
   double duty as the row's bottom padding. */
#sf-ocean .sf-row { padding: 5px 0 1px; }
#sf-ocean .sf-row .sf-line { display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; }
#sf-ocean .sf-row label { color: rgba(226, 242, 255, .92); font-size: 12px; }
#sf-ocean .sf-row .sf-val { font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: rgba(150, 200, 240, .9); font-variant-numeric: tabular-nums; }
#sf-ocean .sf-row .sf-hint { display: block; margin: 1px 0 0; font-size: 10px; line-height: 1.3;
  color: rgba(176, 203, 227, .55); }
#sf-ocean .sf-row.sf-off .sf-val { color: rgba(176, 203, 227, .42); }

/* One slider style for both pointers — 44 px of hit area with a 3 px visible
   track, so the thumb target is honest without the control looking heavy. */
#sf-ocean input[type=range] { appearance: none; -webkit-appearance: none;
  display: block; width: 100%; height: 26px; margin: 0; background: transparent;
  cursor: pointer; touch-action: pan-y; }
#sf-ocean input[type=range]::-webkit-slider-runnable-track { height: 3px; border-radius: 2px;
  background: rgba(206, 232, 255, .2); }
#sf-ocean input[type=range]::-moz-range-track { height: 3px; border-radius: 2px;
  background: rgba(206, 232, 255, .2); }
#sf-ocean input[type=range]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none;
  width: 17px; height: 17px; margin-top: -7px; border-radius: 50%;
  background: #bcdcf6; border: 1px solid rgba(9, 22, 38, .6);
  box-shadow: 0 1px 5px rgba(0, 0, 0, .45); }
#sf-ocean input[type=range]::-moz-range-thumb { width: 17px; height: 17px; border-radius: 50%;
  background: #bcdcf6; border: 1px solid rgba(9, 22, 38, .6); }
#sf-ocean input[type=range]:focus-visible { outline: 2px solid #ff9a3c; outline-offset: 3px; }
`;

/** Three significant-ish figures without the trailing-zero noise. */
function fmt(v, step) {
  const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(dp);
}

export function createOceanPanel({ settings = oceanSettings } = {}) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sf-ocean';
  // See core/input.js: anything inside this attribute is UI, and a drag that
  // starts here must never reach the camera. Without it, dragging a slider on a
  // phone orbited the view under the panel — a touch nobody preventDefaults
  // replays itself as a mouse drag on window.
  root.dataset.sfUi = '';
  root.innerHTML = '<div class="sf-sheet"></div>';
  const sheet = root.querySelector('.sf-sheet');

  const head = document.createElement('div');
  head.className = 'sf-head';
  head.innerHTML = '<span class="sf-title">Ocean</span>'
    + '<span class="sf-actions"><button data-act="reset">Reset</button>'
    + '<button data-act="close">Done</button></span>';
  sheet.appendChild(head);

  // key -> the two elements that have to follow the value when something other
  // than this slider changes it (a reset, or a console call).
  const rows = new Map();

  for (const group of settings.groups) {
    const h = document.createElement('div');
    h.className = 'sf-group';
    h.textContent = group.title;
    sheet.appendChild(h);

    for (const c of group.controls) {
      const row = document.createElement('div');
      row.className = 'sf-row';
      const id = 'sf-oc-' + c.key;
      row.innerHTML = '<div class="sf-line"><label></label><span class="sf-val"></span></div>';
      row.querySelector('label').textContent = c.label;
      row.querySelector('label').setAttribute('for', id);

      // Hint above the slider, not below it: on a phone the thumb covers the
      // line directly under the track while it is being dragged.
      if (c.hint) {
        const hint = document.createElement('span');
        hint.className = 'sf-hint';
        hint.textContent = c.hint;
        row.appendChild(hint);
      }

      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.value = String(settings.get(c.key));
      row.appendChild(input);

      const val = row.querySelector('.sf-val');
      const paint = (v) => {
        val.textContent = v <= c.min + 1e-9 && c.min === 0 ? 'off' : fmt(v, c.step);
        row.classList.toggle('sf-off', v <= c.min + 1e-9 && c.min === 0);
      };
      paint(settings.get(c.key));

      // `input`, not `change`: the value has to move while the thumb is down,
      // because watching the water change under the drag IS the interface.
      input.addEventListener('input', () => {
        const v = Number(input.value);
        paint(v);
        settings.set(c.key, v);
      });

      rows.set(c.key, { input, paint });
      sheet.appendChild(row);
    }
  }

  // A reset (or a console `saltyfin.ocean.set`) has to move the sliders too.
  const unsubscribe = settings.subscribe((key) => {
    const keys = key ? [key] : [...rows.keys()];
    for (const k of keys) {
      const r = rows.get(k);
      if (!r) continue;
      const v = settings.get(k);
      // Skip the element that is being dragged — writing .value mid-drag can
      // snap the thumb out from under the finger on some engines.
      if (document.activeElement !== r.input) r.input.value = String(v);
      r.paint(v);
    }
  });

  function open() { root.classList.add('on'); }
  function close() { root.classList.remove('on'); }
  function toggle() { root.classList.toggle('on'); }
  const isOpen = () => root.classList.contains('on');

  head.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (act === 'close') close();
    else if (act === 'reset') settings.reset();
  });
  const onKey = (e) => {
    if (e.code === 'Escape' && isOpen()) { close(); return; }
    // A key that nothing else in the game uses, and it is not in the drive or
    // helm sets — see core/input.js.
    if (e.code === 'KeyO' && !e.metaKey && !e.ctrlKey && !e.altKey) toggle();
  };
  window.addEventListener('keydown', onKey);

  document.body.appendChild(root);

  return {
    root,
    open,
    close,
    toggle,
    isOpen,
    dispose() {
      window.removeEventListener('keydown', onKey);
      unsubscribe();
      root.remove();
      style.remove();
    },
  };
}
