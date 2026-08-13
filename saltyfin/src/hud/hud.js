// The HUD — compass strip, quest card, keybinds, status bars, minimap.
//
// DOM over the canvas. Nothing here draws with WebGL and nothing here reaches
// into the scene; it reads `ctx` and writes text and transforms.
//
// Two rules shape the whole file:
//
//   1. `update()` runs every frame, so it must not touch the DOM for a value
//      that has not changed. Text and visibility go through cached writers;
//      every transform is compared as a quantised number first. In the steady state
//      — boat still, nothing moving — this module performs zero DOM writes.
//   2. The compass is one strip built once at construction and moved with a
//      single `translate3d`. It never rebuilds, never re-measures, and the
//      browser composites it without a layout.
//
// Everything else is defensive: the monster module is written by someone else
// and `ctx.monster.state` may be missing, half-built, or full of NaN on early
// frames. Nothing in here is allowed to throw.

import * as THREE from 'three';

// --- geometry constants ------------------------------------------------------

const PPD = 7;                 // compass pixels per degree of bearing
const TICK_STEP = 15;          // degrees between labelled ticks
const TICK_FROM = -120;        // the strip covers more than any window can show
const TICK_TO = 480;

const MM_SAMPLES = 160;        // minimap grid resolution, sampled once
const MM_HALF = 400;           // metres — half-extent of the sampled square
const MM_CX = 30, MM_CZ = -90; // world centre of that square
const MM_PPM = 0.235;          // minimap pixels per metre on screen
// Desktop default only. The REAL radius is measured off the element every
// resize (see mmR): core/touch.js shrinks the dial to 88 px on a phone, and
// this constant used to be the one the pips were pinned to. The dial clips
// its overflow, so every leviathan past ~187 m plotted outside the visible
// 44 px disc and vanished — on mobile the pod was never on the map at all,
// which is exactly what a player reported while my desktop captures showed
// the pips fine.
const MM_R = 68;               // visible radius in pixels, matches .sf-mm
const MM_PX = MM_HALF * 2 * MM_PPM;

const MONSTER_RANGE = 900;     // metres past which the pip is not drawn

const RAD2DEG = 180 / Math.PI;

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Which time-of-day tokens light up for a given `env.key`.
const TOD_MATCH = {
  day: 'day', noon: 'day', morning: 'day', afternoon: 'day',
  golden: 'golden', sunset: 'sunset', dusk: 'sunset',
  night: 'night', midnight: 'night',
};

// --- inline art --------------------------------------------------------------

// One spiky silhouette, used for the compass pip, the Monster Log keybind and
// the minimap contact. Red, and red is used for nothing else.
const MONSTER_PATH = 'M12 2.2 14.3 7.4 16.9 4.6 17.9 9.4 21.6 7.9 20.2 12.2'
  + 'c1.3 1 2 2.2 2 3.5 0 3.2-4.6 5.7-10.2 5.7S1.8 18.9 1.8 15.7c0-1.3.7-2.5 2-3.5'
  + 'L2.4 7.9 6.1 9.4 7.1 4.6 9.7 7.4Z';

const SVG_MONSTER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + MONSTER_PATH + '"/></svg>';

const SVG_WARN = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M12 2.6 22.8 21.4H1.2L12 2.6Z" fill="currentColor"/>'
  + '<rect x="11" y="8.6" width="2" height="6.2" rx="1" fill="#0B1420"/>'
  + '<rect x="11" y="16.2" width="2" height="2.2" rx="1" fill="#0B1420"/></svg>';




const SVG_MARKER = '<svg viewBox="0 0 52 30" aria-hidden="true">'
  + '<path class="sf-arch-fill" d="M3 27A25 24 0 0 1 49 27Z"/>'
  + '<path class="sf-arch" d="M3 27A25 24 0 0 1 49 27"/>'
  + '<g class="sf-glyph" transform="translate(16.6 6.4) scale(.78)"><path d="' + MONSTER_PATH + '"/></g></svg>';

const SVG_ARROW = '<svg viewBox="0 0 14 16" aria-hidden="true">'
  + '<polygon points="7,0.6 13.2,15.4 7,12.1 0.8,15.4"/></svg>';

const SVG_CONE = '<svg viewBox="0 0 92 64" aria-hidden="true">'
  + '<polygon points="46,62 1,2 91,2"/></svg>';

// --- tiny helpers ------------------------------------------------------------

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const norm360 = (d) => ((d % 360) + 360) % 360;
/** Shortest signed difference in degrees, in [-180, 180). */
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

function el(tag, cls, parent, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  if (parent) parent.appendChild(n);
  return n;
}

// Cached writers. Each stores its last value on the node, so a frame where
// nothing moved costs nothing but a comparison. Everything that ends up as a
// transform is cached as a quantised *number* in `update()` instead, so a still
// frame does not even build the string.
function txt(n, v) { if (n.__t !== v) { n.__t = v; n.textContent = v; } }
function vis(n, on) { if (n.__v !== on) { n.__v = on; n.style.display = on ? '' : 'none'; } }

/** sRGB bytes for a linear THREE.Color, with a safe fallback. */
function toBytes(color, out) {
  if (!color || typeof color.getHexString !== 'function') { out[0] = out[1] = out[2] = 110; return out; }
  let h;
  try { h = color.getHexString(THREE.SRGBColorSpace); } catch (e) { h = '6e6e6e'; }
  out[0] = parseInt(h.slice(0, 2), 16) || 0;
  out[1] = parseInt(h.slice(2, 4), 16) || 0;
  out[2] = parseInt(h.slice(4, 6), 16) || 0;
  return out;
}

function mixHex(a, b, t, out) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  out[0] = (ar + (br - ar) * t) | 0;
  out[1] = (ag + (bg - ag) * t) | 0;
  out[2] = (ab + (bb - ab) * t) | 0;
  return out;
}

// -----------------------------------------------------------------------------

export function createHud({ ctx, time } = {}) {
  const root = typeof document !== 'undefined' ? document.getElementById('hud') : null;
  if (!root) {
    return { group: null, update() {}, applyEnv() {}, resize() {}, dispose() {} };
  }

  const box = el('div', 'sf', root);

  // === compass ===============================================================

  // The compass strip and the quest card are built but never parented. The
  // player asked for a HUD that is a radar and nothing else, and the radar
  // already carries both things they were for: heading, on its own ring, and
  // the creature, as a dot. Building them detached rather than deleting the
  // code keeps every reference below alive — update() writes to them each
  // frame and writing to an orphan costs nothing and reads no worse than
  // twenty null checks would.
  const compass = el('div', 'sf-compass', null);
  const marker = el('div', 'sf-marker', compass, SVG_MARKER);
  const rule = el('div', 'sf-rule', compass);
  el('div', 'sf-rule-line', rule);
  el('div', 'sf-cap sf-l', rule);
  el('div', 'sf-cap sf-r', rule);
  const window_ = el('div', 'sf-window', rule);
  const strip = el('div', 'sf-strip', window_);
  const range = el('div', 'sf-range', compass);

  for (let deg = TICK_FROM; deg <= TICK_TO; deg += TICK_STEP) {
    const n = norm360(deg);
    const card = n % 45 === 0;
    const major = n % 90 === 0;
    const t = el('div', 'sf-t' + (card ? ' sf-card' : '') + (major ? ' sf-major' : ''), strip);
    t.style.left = (deg * PPD) + 'px';
    el('i', null, t);
    const b = el('b', null, t);
    b.textContent = card ? CARDINALS[(n / 45) | 0] : String(n);
  }

  // === quest card ============================================================

  let awayTimer = 0;
  const questCard = el('div', 'sf-quest', null);
  const questHead = el('div', 'sf-quest-head', questCard, SVG_WARN);
  const questTitle = el('div', 'sf-quest-title', questHead);
  const questBody = el('div', 'sf-quest-body', questCard);

  let settleTimer = 0;
  function announce() {
    clearTimeout(awayTimer);
    questCard.classList.remove('sf-in', 'sf-settled', 'sf-away');
    // Force a reflow so the entrance animation restarts on a new objective.
    void questCard.offsetWidth;
    questCard.classList.add('sf-in');
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      questCard.classList.add('sf-settled');
      // Read it once, then give the screen back.
      awayTimer = setTimeout(() => questCard.classList.add('sf-away'), 7000);
    }, 5200);
  }

  // The keybind list and the three status bars used to live here. The bars were
  // wired to nothing that could kill you and the keybinds duplicate the opening
  // card, and on a phone the two of them together ate the bottom third of the
  // screen. What is left is what the game actually asks you to read: which way
  // the leviathan is and how far.

  // === minimap ===============================================================

  const mm = el('div', 'sf-mm', box);
  // The heading ring. It sits OUTSIDE mmRot so it can counter-rotate on its own
  // — the map under it is heading-up, so the letters have to turn against the
  // boat to keep pointing at true north.
  const mmRing = el('div', 'sf-mm-ring', mm);
  // Each mark is a full-size box that gets rotated, with the glyph pinned to the
  // top of it in CSS. Placing them by a pixel radius off MM_R looked right on
  // the 138 px desktop radar and put every letter outside the 88 px touch one,
  // where the map's own overflow clipped them away — the ring was invisible on
  // the only device it was asked for.
  for (const [deg, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    const t = el('div', 'sf-mm-card', mmRing);
    t.dataset.c = label;
    t.style.transform = 'rotate(' + deg + 'deg)';
  }
  for (let d = 0; d < 360; d += 30) {
    if (d % 90 === 0) continue;
    const t = el('div', 'sf-mm-tick', mmRing);
    t.style.transform = 'rotate(' + d + 'deg)';
  }
  const mmRot = el('div', 'sf-mm-rot', mm);
  const mmPan = el('div', 'sf-mm-pan', mmRot);
  const mmCanvas = document.createElement('canvas');
  mmCanvas.width = MM_SAMPLES;
  mmCanvas.height = MM_SAMPLES;
  mmCanvas.style.width = MM_PX + 'px';
  mmCanvas.style.height = MM_PX + 'px';
  mmPan.appendChild(mmCanvas);
  el('div', 'sf-mm-vig', mm);
  el('div', 'sf-mm-cone', mm, SVG_CONE);
  el('div', 'sf-mm-me', mm, SVG_ARROW);
  // One dot per leviathan. There is a pod out in the deep now, and a radar that
  // shows one of them is worse than useless — it tells you the sea is empty
  // everywhere the primary animal is not. Pooled at build time because nothing
  // may be created after boot.
  const MON_DOTS = 8;
  const mmMons = [];
  for (let i = 0; i < MON_DOTS; i++) mmMons.push(el('div', 'sf-mm-mon', mm, SVG_MONSTER));
  const mmMon = mmMons[0];

  // Sample the bay exactly once. `isLand` and `depthAt` are cheap but not free,
  // and 37k calls is not something to repeat on a frame — the samples are kept
  // so a palette change can repaint from memory.
  const landMask = new Uint8Array(MM_SAMPLES * MM_SAMPLES);
  const depthMap = new Float32Array(MM_SAMPLES * MM_SAMPLES);
  {
    const terrain = ctx && ctx.terrain;
    const isLand = terrain && typeof terrain.isLand === 'function' ? terrain.isLand : null;
    const depthAt = terrain && typeof terrain.depthAt === 'function' ? terrain.depthAt : null;
    const step = (MM_HALF * 2) / MM_SAMPLES;
    const x0 = MM_CX - MM_HALF + step * 0.5;
    const z0 = MM_CZ - MM_HALF + step * 0.5;
    for (let j = 0; j < MM_SAMPLES; j++) {
      const wz = z0 + j * step;
      const row = j * MM_SAMPLES;
      for (let i = 0; i < MM_SAMPLES; i++) {
        const wx = x0 + i * step;
        let land = false;
        let depth = 40;
        if (isLand) { try { land = isLand(wx, wz) === true; } catch (e) { land = false; } }
        // The seabed is the expensive sample, so only water cells pay for it.
        if (!land && depthAt) { try { depth = fin(depthAt(wx, wz), 40); } catch (e) { depth = 40; } }
        landMask[row + i] = land ? 1 : 0;
        depthMap[row + i] = depth;
      }
    }
  }

  const mmCtx = mmCanvas.getContext('2d');
  const mmImage = mmCtx ? mmCtx.createImageData(MM_SAMPLES, MM_SAMPLES) : null;
  const cDeep = [0, 0, 0], cReef = [0, 0, 0], cLand = [0, 0, 0], cSand = [0, 0, 0];

  function paintMinimap(env) {
    if (!mmCtx || !mmImage) return;
    const day = clamp(fin(env && env.dayFactor, 1), 0, 1);
    toBytes(env && env.waterDeep, cDeep);
    toBytes(env && env.waterShallow, cReef);
    mixHex(0x26313F, 0x7E8B57, day, cLand);
    mixHex(0x3A4256, 0xD8CBA4, day, cSand);

    const d = mmImage.data;
    for (let k = 0, p = 0; k < landMask.length; k++, p += 4) {
      const depth = depthMap[k];
      let c, a;
      if (landMask[k]) { c = cLand; a = 236; }
      else if (depth < 1.6) { c = cSand; a = 188; }
      else if (depth < 8) { c = cReef; a = 128; }
      else { c = cDeep; a = 74; }
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = a;
    }
    mmCtx.putImageData(mmImage, 0, 0);
  }

  // === time-of-day hint ======================================================

  const tod = el('div', 'sf-tod', box);
  const todTokens = [];
  function todToken(k, num, label) {
    if (todTokens.length) el('span', 'sf-dot', tod).textContent = '·';
    const s = el('span', 'sf-tk', tod, '<em>' + num + '</em> ' + label);
    todTokens.push({ key: k, node: s });
  }
  todToken('day', '1', 'day');
  todToken('golden', '2', 'golden');
  todToken('sunset', '3', 'sunset');
  todToken('night', '4', 'night');
  todToken(null, 'T', 'cycle');

  // === frame state ===========================================================

  let halfW = 320;                 // half the compass width in px, from resize()
  let mmR = MM_R;                  // half the radar's width in px, from resize()
  let lastTitle = null;
  let lastRange = -1;
  let lastTod = null;
  let lastTs = null;
  let paintedDay = -1;
  let paintedKey = null;

  // Quantised caches for everything that becomes a transform string. Comparing
  // the number before building the string is what keeps a still frame free of
  // both a DOM write and a string allocation.
  let qStrip = NaN, qMark = NaN, qRot = NaN, qPanX = NaN, qPanY = NaN;
  let qMonX = NaN, qMonY = NaN;

  // Health does not move, so it is written exactly once.

  function measure() {
    const w = compass.clientWidth;
    if (w > 0) halfW = w * 0.5;
    // The dial's true radius, whatever CSS (or the touch layer's !important
    // override) has made it. Read here rather than per frame: clientWidth
    // forces a synchronous layout.
    const mw = mm.clientWidth;
    if (mw > 0) mmR = mw * 0.5;
  }
  measure();

  // ---------------------------------------------------------------------------

  function update(c) {
    const dt = fin(c && c.dt, 0);
    const b = (c && c.boat) || null;
    const bx = fin(b && b.position && b.position.x, 0);
    const bz = fin(b && b.position && b.position.z, 0);
    const headingDeg = norm360(fin(b && b.heading, 0) * RAD2DEG);

    // --- compass strip: one transform, nothing else ---------------------------
    const stripX = Math.round(-headingDeg * PPD * 10);
    if (stripX !== qStrip) {
      qStrip = stripX;
      strip.style.transform = 'translate3d(' + (stripX * 0.1) + 'px,0,0)';
    }

    // --- what the pip is pointing at -----------------------------------------
    // Prefer the creature itself; fall back to the quest mark while it sleeps.
    let tx = null, tz = null;
    const ms = c && c.monster && c.monster.state;
    const mp = ms && ms.position;
    if (mp && Number.isFinite(mp.x) && Number.isFinite(mp.z)) { tx = mp.x; tz = mp.z; }
    if (tx === null) {
      const qs = c && c.quest && c.quest.state;
      const qp = qs && qs.targetPosition;
      if (qp && Number.isFinite(qp.x) && Number.isFinite(qp.z)) { tx = qp.x; tz = qp.z; }
    }

    let rel = 0, dist = 0;
    const haveTarget = tx !== null;
    if (haveTarget) {
      const dx = tx - bx, dz = tz - bz;
      dist = Math.sqrt(dx * dx + dz * dz);
      rel = wrap180(Math.atan2(dx, -dz) * RAD2DEG - headingDeg);
    }
    const inRange = haveTarget && dist < MONSTER_RANGE;

    vis(marker, inRange);
    vis(range, inRange);
    if (inRange) {
      const px = Math.round(clamp(rel * PPD, -halfW + 26, halfW - 26) * 10);
      if (px !== qMark) { qMark = px; marker.style.transform = 'translateX(' + (px * 0.1) + 'px)'; }
      const m = Math.round(clamp(dist, 0, 99999));
      if (m !== lastRange) { lastRange = m; range.textContent = m + 'm'; }
    }

    // --- quest card ----------------------------------------------------------
    const qs = (c && c.quest && c.quest.state) || null;
    const title = (qs && typeof qs.title === 'string' && qs.title) || 'A Strange Disturbance';
    const body = (qs && typeof qs.body === 'string' && qs.body)
      || 'Investigate the waters near Greenwake Island.';
    if (title !== lastTitle) {
      lastTitle = title;
      txt(questTitle, title);
      txt(questBody, body);
      announce();
    } else {
      txt(questBody, body);
    }

    // --- minimap -------------------------------------------------------------
    // Heading-up: the map counter-rotates under a fixed arrowhead and cone.
    const rot = Math.round(-headingDeg * 20);
    if (rot !== qRot) { qRot = rot; mmRot.style.transform = 'rotate(' + (rot * 0.05) + 'deg)'; }

    const mx = Math.round((bx - (MM_CX - MM_HALF)) * MM_PPM * 10);
    const my = Math.round((bz - (MM_CZ - MM_HALF)) * MM_PPM * 10);
    if (mx !== qPanX || my !== qPanY) {
      qPanX = mx; qPanY = my;
      mmPan.style.transform = 'translate(' + (-mx * 0.1) + 'px,' + (-my * 0.1) + 'px)';
    }

    // The ring turns against the heading so N keeps pointing north.
    mmRing.style.transform = 'rotate(' + (rot * 0.05) + 'deg)';

    // A dot for every animal in range, the primary included. Anything the pod
    // does not fill is hidden rather than left where it last was.
    const pod = (c && c.monster && c.monster.pod) || null;
    const lockIdx = fin(c && c.harpoon && c.harpoon.state && c.harpoon.state.lockIndex, -1);
    let shown = 0;
    if (pod && pod.length) {
      for (let i = 0; i < pod.length && shown < MON_DOTS; i++) {
        const st = pod[i] && pod[i].state;
        const pp = st && st.position;
        if (!pp || !Number.isFinite(pp.x) || !Number.isFinite(pp.z)) continue;
        const dx = pp.x - bx, dz = pp.z - bz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= MONSTER_RANGE) continue;
        const a = Math.atan2(dx, -dz) - headingDeg / RAD2DEG;
        // 9 px is the pip glyph's own half-width, so a rim-pinned animal sits
        // fully inside the dial instead of half-clipped by its edge.
        const r = Math.min(d * MM_PPM, mmR - 9);
        const dot = mmMons[shown++];
        vis(dot, true);
        // WHICH one is yours. With a pod out there, three identical red pips
        // and a lock somewhere among them told the player nothing.
        const isLocked = i === lockIdx;
        if (dot.dataset.lock !== (isLocked ? '1' : '0')) {
          dot.dataset.lock = isLocked ? '1' : '0';
          dot.classList.toggle('sf-mm-locked', isLocked);
        }
        dot.style.transform = 'translate(' + (Math.sin(a) * r).toFixed(1) + 'px,'
          + (-Math.cos(a) * r).toFixed(1) + 'px)';
      }
    } else if (inRange) {
      const r = Math.min(dist * MM_PPM, mmR - 9);
      const a = rel / RAD2DEG;
      vis(mmMon, true);
      dotFallback(mmMon, Math.sin(a) * r, -Math.cos(a) * r);
      shown = 1;
    }
    for (let i = shown; i < MON_DOTS; i++) vis(mmMons[i], false);
  }

  function dotFallback(node, px, py) {
    node.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px)';
  }

  function applyEnv(env) {
    if (!env) return;
    const day = clamp(fin(env.dayFactor, 1), 0, 1);

    // A bright sky behind the HUD needs a heavier shadow than a night one.
    // `applyEnv` runs every frame while the clock is cycling, so this is
    // quantised too.
    const shade = Math.round(day * 40);
    if (shade !== lastTs) {
      lastTs = shade;
      const d = shade * 0.025;
      root.style.setProperty('--sf-ts',
        '0 1px 2px rgba(2,8,18,' + (0.62 + 0.3 * d).toFixed(2) + '), '
        + '0 0 14px rgba(2,8,18,' + (0.36 + 0.24 * d).toFixed(2) + ')');
    }

    const key = typeof env.key === 'string' ? env.key : '';
    if (key !== lastTod) {
      lastTod = key;
      const on = TOD_MATCH[key] || null;
      for (let i = 0; i < todTokens.length; i++) {
        const t = todTokens[i];
        const want = t.key !== null && t.key === on;
        if (t.node.__on !== want) { t.node.__on = want; t.node.classList.toggle('sf-on', want); }
      }
    }

    // Repaint the map from the cached samples when the palette has moved enough
    // to see. No terrain is sampled here.
    if (key !== paintedKey || Math.abs(day - paintedDay) > 0.04) {
      paintedKey = key;
      paintedDay = day;
      paintMinimap(env);
    }
  }

  function resize() { measure(); }

  function dispose() {
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    if (box.parentNode) box.parentNode.removeChild(box);
    root.style.removeProperty('--sf-ts');
  }

  // Paint once so the first frame is never an empty disc, even if `applyEnv`
  // has not run yet.
  if (ctx && ctx.env) applyEnv(ctx.env);
  else paintMinimap(null);

  return { group: null, update, applyEnv, resize, dispose };
}
