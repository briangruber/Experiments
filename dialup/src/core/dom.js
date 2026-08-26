/* Tiny DOM helpers. Every module builds its UI with h() rather than
   innerHTML, so nothing a bot or another user types can ever be parsed
   as markup. Where we genuinely want rich content (web pages in the
   browser app) it goes through an explicit, whitelisted builder. */

export function h(tag, props = {}, ...kids) {
  const parts = tag.split(/(?=[.#])/);
  const el = document.createElement(parts.shift() || 'div');
  for (const p of parts) {
    if (p[0] === '.') el.classList.add(...p.slice(1).split(/\s+/).filter(Boolean));
    else el.id = p.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const frag = (...kids) => add(document.createDocumentFragment(), kids);

/** Namespaced h() for inline SVG icons. */
export function svg(tag, props = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Pointer drag helper. onMove gets (dx, dy, ev) from the press origin. */
export function drag(handle, onStart, onMove, onEnd) {
  handle.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const x0 = ev.clientX, y0 = ev.clientY;
    if (onStart && onStart(ev) === false) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    const move = e => onMove(e.clientX - x0, e.clientY - y0, e);
    const up = e => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd && onEnd(e);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/** Double-click that also works for the icon grid's click-then-click. */
export function onDouble(el, fn) {
  let last = 0;
  el.addEventListener('pointerdown', ev => {
    const now = performance.now();
    if (now - last < 420) { last = 0; fn(ev); } else last = now;
  });
}

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const pick = arr => arr[(Math.random() * arr.length) | 0];
export const chance = p => Math.random() < p;
export const randInt = (lo, hi) => lo + ((Math.random() * (hi - lo + 1)) | 0);

/** Deterministic small hash, for stable per-name colours and avatars. */
export function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  return x >>> 0;
}
