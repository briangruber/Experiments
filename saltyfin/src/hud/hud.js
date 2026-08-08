// The HUD — compass strip, quest card, keybinds, status bars, minimap.
//
// DOM over the canvas. Nothing here draws with WebGL and nothing here reaches
// into the scene; it reads `ctx` and writes text and transforms.
//
// Two rules shape the whole file:
//
//   1. `update()` runs every frame, so it must not touch the DOM for a value
//      that has not changed. Every writer below (`txt`, `tr`, `wid`, `vis`)
//      caches its last value on the node and returns early. In the steady state
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

const SVG_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.6'
  + 'C6.6 16.9 3.2 13.6 3.2 10.1 3.2 7.4 5.3 5.3 7.9 5.3c1.7 0 3.2.8 4.1 2.1'
  + '.9-1.3 2.4-2.1 4.1-2.1 2.6 0 4.7 2.1 4.7 4.8 0 3.5-3.4 6.8-8.8 10.5Z"/></svg>';

const SVG_BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M13.9 1.8 5 13.9h5.4L9.5 22.2l8.9-12.1h-5.3l.8-8.3Z"/></svg>';

const SVG_FISH = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M1.6 12c2.8-3.9 6.8-6 10.9-6 3.4 0 6.2 1.4 8 3.3l2.9-2.4v10.2l-2.9-2.4'
  + 'c-1.8 1.9-4.6 3.3-8 3.3-4.1 0-8.1-2.1-10.9-6Z"/>'
  + '<circle cx="7.4" cy="10.4" r="1" fill="#0B1420"/></svg>';

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
/** Shortest signed difference in degrees, in (-180, 180]. */
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

const _bytes = [0, 0, 0];
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

  const compass = el('div', 'sf-compass', box);
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

  const questCard = el('div', 'sf-quest', box);
  const questHead = el('div', 'sf-quest-head', questCard, SVG_WARN);
  const questTitle = el('div', 'sf-quest-title', questHead);
  const questBody = el('div', 'sf-quest-body', questCard);

  let settleTimer = 0;
  function announce() {
    questCard.classList.remove('sf-in', 'sf-settled');
    // Force a reflow so the entrance animation restarts on a new objective.
    void questCard.offsetWidth;
    questCard.classList.add('sf-in');
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      questCard.classList.add('sf-settled');
    }, 5200);
  }

  // === keybinds ==============================================================

  const keys = el('div', 'sf-keys', box);
  function keyRow(glyph, label) {
    const row = el('div', 'sf-key', keys);
    if (glyph === null) el('div', 'sf-cap-glyph', row, SVG_MONSTER);
    else el('div', 'sf-cap-key', row).textContent = glyph;
    el('div', 'sf-key-label', row).textContent = label;
  }
  keyRow('M', 'Map');
  keyRow(null, 'Monster Log');
  keyRow('E', 'Equip');

  // === status bars ===========================================================

  const bars = el('div', 'sf-bars', box);
  function barRow(cls, icon) {
    const row = el('div', 'sf-barrow ' + cls, bars);
    el('div', 'sf-badge', row, icon);
    const track = el('div', 'sf-bar', row);
    return el('div', 'sf-fill', track);
  }
  const fillHp = barRow('sf-hp', SVG_HEART);
  const fillEn = barRow('sf-en', SVG_BOLT);
  const fillCt = barRow('sf-ct', SVG_FISH);

  let hp = 0.88;
  let energy = 0.72;
  let creel = 0.74;

  // === minimap ===============================================================

  const mm = el('div', 'sf-mm', box);
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
  const mmMon = el('div', 'sf-mm-mon', mm, SVG_MONSTER);

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
  let qMonX = NaN, qMonY = NaN, qEnergy = -1, qCreel = -1;

  // Health does not move, so it is written exactly once.
  fillHp.style.width = (hp * 100).toFixed(1) + '%';

  function measure() {
    const w = compass.clientWidth;
    if (w > 0) halfW = w * 0.5;
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

    // --- bars ----------------------------------------------------------------
    const drive = clamp(Math.abs(fin(b && b.throttle, 0)), 0, 1);
    energy = clamp(energy + (drive > 0.05 ? -0.055 * drive : 0.075) * dt, 0.12, 1);
    const stage = clamp(fin(qs && qs.stage, 0), 0, 4);
    const creelTarget = clamp(0.74 + 0.08 * stage, 0, 0.98);
    creel += (creelTarget - creel) * Math.min(1, dt * 1.2);
    const en = Math.round(energy * 200);          // half-percent steps
    if (en !== qEnergy) { qEnergy = en; fillEn.style.width = (en * 0.5) + '%'; }
    const ct = Math.round(creel * 200);
    if (ct !== qCreel) { qCreel = ct; fillCt.style.width = (ct * 0.5) + '%'; }

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

    vis(mmMon, inRange);
    if (inRange) {
      const r = Math.min(dist * MM_PPM, MM_R - 10);
      const a = rel / RAD2DEG;
      const px = Math.round(Math.sin(a) * r * 10);
      const py = Math.round(-Math.cos(a) * r * 10);
      if (px !== qMonX || py !== qMonY) {
        qMonX = px; qMonY = py;
        mmMon.style.transform = 'translate(' + (px * 0.1) + 'px,' + (py * 0.1) + 'px)';
      }
    }
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
