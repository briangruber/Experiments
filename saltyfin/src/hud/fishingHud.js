// The fishing interface.
//
// Reads `fishing.state` and writes DOM. It holds no game state of its own, so
// the minigame can be tuned, replayed or driven from the console without this
// file knowing, and nothing here can desync from the sim.
//
// Two things shape the layout.
//
// The player is looking at a LURE in the middle of the water, and every readout
// has to be legible without taking the eye off it. So the strike ring is drawn
// around screen centre where the lure is, the jig meter is a thin bar under it,
// and the tension gauge is a wide strip low enough to sit in peripheral vision.
// Nothing lives in a corner that would need a saccade to read.
//
// And every control is one thumb. The action button is a big disc in the
// bottom-right — tap to set the hook, hold to reel — and the whole left half of
// the screen is the jig pad: drag down and the lure goes down. They never both
// matter at the same instant, but they are on opposite sides so that a player
// who keeps a thumb on each is never wrong.
//
// The same actions are on the keyboard: W/S or the arrows jig, Space strikes
// and reels, F leaves.

const CSS = `
#sf-fish { position: fixed; inset: 0; z-index: 55; pointer-events: none;
  font: 600 11px/1.3 ui-sans-serif, system-ui, sans-serif;
  color: #dceaf7; -webkit-user-select: none; user-select: none; display: none; }
#sf-fish.on { display: block; }
/* The sailing HUD stands down for the duration. Down there the radar points at
   nothing you can steer toward and the keyboard hint row is for a helm that is
   not answering — and the player asked for a HUD that is only what it needs to
   be. body.sf-fishing is set by this module and read by nobody else. */
body.sf-fishing #hud { opacity: 0; pointer-events: none; transition: opacity .3s ease; }
body.sf-fishing #touch .drive, body.sf-fishing #touch .times,
body.sf-fishing #touch .stick { display: none; }
body.sf-fishing #fps { opacity: .35; }

/* --- the cast button, the only part visible while sailing ----------------- */
#sf-fish-go { position: fixed; z-index: 46; pointer-events: auto; cursor: pointer;
  right: max(14px, env(safe-area-inset-right));
  bottom: calc(150px + env(safe-area-inset-bottom));
  display: flex; align-items: center; gap: 7px;
  padding: 9px 14px 9px 11px; border-radius: 999px;
  border: 1px solid rgba(206,232,255,.24); background: rgba(8,20,36,.52);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: rgba(226,242,255,.86);
  font: 700 10px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .16em; text-transform: uppercase;
  -webkit-user-select: none; user-select: none; }
#sf-fish-go:active { background: rgba(122,178,232,.36); color: #fff; }
#sf-fish-go svg { width: 15px; height: 15px; fill: currentColor; }
#sf-fish-go.hidden { display: none; }

/* --- the jig pad ---------------------------------------------------------- */
#sf-fish .pad { position: absolute; left: 0; top: 0; bottom: 0; width: 52%;
  pointer-events: auto; touch-action: none; }

/* --- the ring around the lure --------------------------------------------- */
#sf-fish .ring { position: absolute; left: 50%; top: 50%; width: 210px; height: 210px;
  margin: -105px 0 0 -105px; opacity: 0; transition: opacity .12s ease; }
#sf-fish .ring.on { opacity: 1; }
#sf-fish .ring svg { width: 100%; height: 100%; overflow: visible; }
#sf-fish .ring .tgt { fill: none; stroke: rgba(226,242,255,.30); stroke-width: 1.5;
  stroke-dasharray: 4 6; }
#sf-fish .ring .band { fill: none; stroke: rgba(255,196,90,.30); stroke-width: 9; }
#sf-fish .ring .cur { fill: none; stroke: #EAF4FF; stroke-width: 2.5; }
#sf-fish .ring.hot .cur { stroke: #FFD166; stroke-width: 4; }
#sf-fish .ring .lbl { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 10px);
  white-space: nowrap; letter-spacing: .2em; text-transform: uppercase;
  font-size: 10px; color: rgba(255,209,102,.95); text-shadow: 0 1px 6px rgba(0,0,0,.7); }

/* --- readouts ------------------------------------------------------------- */
#sf-fish .stack { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(112px + env(safe-area-inset-bottom));
  width: min(78vw, 430px); display: flex; flex-direction: column; gap: 7px; }
#sf-fish .cap { display: flex; justify-content: space-between; align-items: baseline;
  letter-spacing: .16em; text-transform: uppercase; font-size: 9px;
  color: rgba(196,222,244,.66); text-shadow: 0 1px 4px rgba(0,0,0,.6); }
#sf-fish .bar { position: relative; height: 7px; border-radius: 999px;
  background: rgba(6,16,28,.55); border: 1px solid rgba(206,232,255,.18);
  overflow: hidden; }
#sf-fish .bar i { position: absolute; inset: 0 auto 0 0; width: 0;
  background: #7FD4E8; transition: none; }
/* The jig band, painted into the track so the target is a PLACE and not a
   number to compare against. */
#sf-fish .bar.jig u { position: absolute; top: 0; bottom: 0; background: rgba(126,226,168,.26);
  border-left: 1px solid rgba(126,226,168,.5); border-right: 1px solid rgba(126,226,168,.5); }
#sf-fish .bar.jig i { background: #7EE2A8; }
#sf-fish .bar.jig.cold i { background: #6E8CA0; }
#sf-fish .bar.jig.hot i { background: #FF8A5B; }
/* A gradient painted on the FILL is a lie: the fill is sized to the value, so
   its red end is always at the tip and a line at 30% looks as close to parting
   as one at 90%. The colour has to be a function of the value, not of the
   element's own width. */
#sf-fish .bar.ten i { background: #7EE2A8; }
#sf-fish .bar.ten.mid i { background: #FFD166; }
#sf-fish .bar.ten.warn i { background: #FF6B4A; }
#sf-fish .bar.ten { height: 11px; }
#sf-fish .bar.ten.warn { box-shadow: 0 0 0 1px rgba(255,107,74,.7), 0 0 16px rgba(255,107,74,.45); }
#sf-fish .bar.line i { background: #EAF4FF; }

/* --- the action button ---------------------------------------------------- */
#sf-fish .act { position: absolute; pointer-events: auto; cursor: pointer;
  right: max(16px, env(safe-area-inset-right));
  bottom: calc(24px + env(safe-area-inset-bottom));
  width: 96px; height: 96px; border-radius: 50%;
  border: 1.5px solid rgba(206,232,255,.32);
  background: radial-gradient(circle at 50% 42%, rgba(28,64,98,.72), rgba(8,20,36,.66));
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center; text-align: center;
  letter-spacing: .16em; text-transform: uppercase; font-size: 11px;
  box-shadow: 0 6px 22px rgba(0,0,0,.4); touch-action: none; }
#sf-fish .act.down { background: radial-gradient(circle at 50% 42%, rgba(122,178,232,.62), rgba(24,66,104,.7));
  color: #fff; }
#sf-fish .act.strike { border-color: rgba(255,209,102,.85);
  box-shadow: 0 0 0 1px rgba(255,209,102,.5), 0 0 26px rgba(255,183,77,.45); }

/* --- leave, and the running tally ---------------------------------------- */
#sf-fish .leave { position: absolute; pointer-events: auto; cursor: pointer;
  right: max(14px, env(safe-area-inset-right)); top: max(12px, env(safe-area-inset-top));
  padding: 8px 12px; border-radius: 999px;
  border: 1px solid rgba(206,232,255,.22); background: rgba(8,20,36,.55);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  letter-spacing: .16em; text-transform: uppercase; font-size: 9px; }
#sf-fish .leave:active { background: rgba(122,178,232,.36); color: #fff; }
#sf-fish .tally { position: absolute; left: max(14px, env(safe-area-inset-left));
  top: max(12px, env(safe-area-inset-top));
  letter-spacing: .18em; text-transform: uppercase; font-size: 9px;
  color: rgba(196,222,244,.62); text-shadow: 0 1px 4px rgba(0,0,0,.6); }

/* --- messages and the catch card ------------------------------------------ */
#sf-fish .msg { position: absolute; left: 50%; top: 50%; transform: translate(-50%, 96px);
  white-space: nowrap; letter-spacing: .14em; text-transform: uppercase; font-size: 10px;
  color: rgba(226,242,255,.9); text-shadow: 0 1px 8px rgba(0,0,0,.8);
  opacity: 0; transition: opacity .2s ease; }
#sf-fish .msg.on { opacity: 1; }
#sf-fish .hint { position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(150px + env(safe-area-inset-bottom));
  padding: 7px 13px; border-radius: 999px; white-space: nowrap;
  border: 1px solid rgba(206,232,255,.18); background: rgba(8,20,36,.55);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  letter-spacing: .09em; font-size: 10px; color: rgba(214,236,255,.86);
  opacity: 0; transition: opacity .25s ease; }
#sf-fish .hint.on { opacity: 1; }

#sf-fish .card { position: absolute; left: 50%; top: 30%; transform: translate(-50%,-50%) scale(.94);
  min-width: 232px; padding: 16px 22px 18px; border-radius: 14px; text-align: center;
  border: 1px solid rgba(255,209,102,.34); background: rgba(9,22,38,.86);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 14px 44px rgba(0,0,0,.5);
  opacity: 0; pointer-events: none; transition: opacity .22s ease, transform .22s ease; }
#sf-fish .card.on { opacity: 1; transform: translate(-50%,-50%) scale(1); }
#sf-fish .card .k { letter-spacing: .22em; text-transform: uppercase; font-size: 9px;
  color: rgba(255,209,102,.85); }
#sf-fish .card .n { margin-top: 7px; font: 700 19px/1.15 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .01em; color: #F2F8FF; }
#sf-fish .card .l { margin-top: 3px; font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: rgba(160,208,244,.92); }
#sf-fish .card .pb { margin-top: 9px; display: inline-block; padding: 3px 9px; border-radius: 999px;
  background: rgba(255,209,102,.18); border: 1px solid rgba(255,209,102,.4);
  letter-spacing: .18em; text-transform: uppercase; font-size: 8px; color: #FFD166; }

@media (pointer: fine) and (min-width: 900px) {
  #sf-fish .pad { display: none; }
  #sf-fish .act { width: 84px; height: 84px; }
}
`;

const SVG_ROD = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M3 20.4c4.6.4 8.3-1.2 11-4.7l1.5 1.2 1.2-1.6L15 14l4.4-5.8 1.5 1.2 1.2-1.6-4.3-3.3-1.2 1.6 1.5 1.2L13.6 13l-1.7-1.3-1.2 1.6 1.6 1.2c-2.3 2.9-5.3 4.2-9.3 4Z"/>'
  + '</svg>';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createFishingHud({ fishing, ctx } = {}) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // The cast button lives outside the overlay: it is the only piece that shows
  // while sailing, and the overlay it would otherwise sit in is display:none.
  const go = document.createElement('div');
  go.id = 'sf-fish-go';
  go.dataset.sfUi = '';
  go.innerHTML = SVG_ROD + '<span>Fish</span>';
  go.title = 'Stop and fish  (F)';
  document.body.appendChild(go);

  const root = document.createElement('div');
  root.id = 'sf-fish';
  root.dataset.sfUi = '';
  root.innerHTML = `
    <div class="pad"></div>
    <div class="tally"></div>
    <div class="leave">Leave</div>
    <div class="ring">
      <svg viewBox="0 0 100 100">
        <circle class="tgt" cx="50" cy="50" r="13"></circle>
        <circle class="band" cx="50" cy="50" r="20.5"></circle>
        <circle class="cur" cx="50" cy="50" r="46"></circle>
      </svg>
      <div class="lbl">Now</div>
    </div>
    <div class="msg"></div>
    <div class="hint"></div>
    <div class="stack">
      <div class="row jigrow">
        <div class="cap"><span>Jig</span><span class="jigv"></span></div>
        <div class="bar jig"><u></u><i></i></div>
      </div>
      <div class="row tenrow">
        <div class="cap"><span>Line tension</span><span class="tenv"></span></div>
        <div class="bar ten"><i></i></div>
      </div>
      <div class="row linerow">
        <div class="cap"><span>Line out</span><span class="linev"></span></div>
        <div class="bar line"><i></i></div>
      </div>
    </div>
    <div class="act">Reel</div>
    <div class="card">
      <div class="k">Landed</div>
      <div class="n"></div>
      <div class="l"></div>
      <div class="pb">Personal best</div>
    </div>`;
  document.body.appendChild(root);

  const el = (s) => root.querySelector(s);
  const pad = el('.pad');
  const ring = el('.ring');
  const ringCur = el('.ring .cur');
  const ringLbl = el('.ring .lbl');
  const act = el('.act');
  const card = el('.card');
  const msg = el('.msg');
  const hint = el('.hint');
  const tally = el('.tally');
  const jigRow = el('.jigrow');
  const tenRow = el('.tenrow');
  const lineRow = el('.linerow');
  const jigFill = el('.bar.jig i');
  const jigBand = el('.bar.jig u');
  const jigBar = el('.bar.jig');
  const jigV = el('.jigv');
  const tenFill = el('.bar.ten i');
  const tenBar = el('.bar.ten');
  const tenV = el('.tenv');
  const lineFill = el('.bar.line i');
  const lineV = el('.linev');

  // The jig band, in the same 0..1 of the bar the fill uses. JIG_HOT in
  // fishing.js is the full-scale end, so the band lands at 13%..37%.
  const BAR_MAX = 2.3;
  jigBand.style.left = `${(0.30 / BAR_MAX) * 100}%`;
  jigBand.style.width = `${((1.45 - 0.30) / BAR_MAX) * 100}%`;

  // --- input ---------------------------------------------------------------
  // The pad is a relative drag, not an absolute position: wherever the thumb
  // lands is neutral, and how far it moves from there is how hard the lure is
  // worked. An absolute pad would teleport the lure on first touch.
  let padId = null, padY = 0;
  const PAD_RANGE = 96;      // px of travel for full deflection

  const padStart = (e) => {
    const t = e.changedTouches ? e.changedTouches[0] : e;
    padId = e.changedTouches ? t.identifier : 'mouse';
    padY = t.clientY;
    fishing.setJig(0);
  };
  const padMove = (e) => {
    if (padId === null) return;
    const list = e.changedTouches ? [...e.changedTouches] : [e];
    for (const t of list) {
      const id = e.changedTouches ? t.identifier : 'mouse';
      if (id !== padId) continue;
      fishing.setJig(clamp((t.clientY - padY) / PAD_RANGE, -1, 1));
      // Trail the anchor so a long stroke keeps working instead of pinning at
      // full deflection and going quiet.
      const over = (t.clientY - padY) - clamp(t.clientY - padY, -PAD_RANGE, PAD_RANGE);
      padY += over;
    }
  };
  const padEnd = () => { padId = null; fishing.setJig(0); };

  pad.addEventListener('touchstart', (e) => { e.preventDefault(); padStart(e); }, { passive: false });
  pad.addEventListener('touchmove', (e) => { e.preventDefault(); padMove(e); }, { passive: false });
  pad.addEventListener('touchend', padEnd);
  pad.addEventListener('touchcancel', padEnd);
  pad.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') padStart(e); });
  window.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') padMove(e); });
  window.addEventListener('pointerup', () => { if (padId === 'mouse') padEnd(); });

  // The action button. A press is BOTH a tap and the start of a hold — the
  // strike wants the edge, the fight wants the level, and asking the player to
  // learn two different gestures for one button would be the wrong lesson.
  const actDown = (e) => {
    e.preventDefault();
    act.classList.add('down');
    fishing.press();
    fishing.setHold(true);
  };
  const actUp = () => { act.classList.remove('down'); fishing.setHold(false); };
  act.addEventListener('touchstart', actDown, { passive: false });
  act.addEventListener('touchend', actUp);
  act.addEventListener('touchcancel', actUp);
  act.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') actDown(e); });
  window.addEventListener('pointerup', actUp);

  go.addEventListener('click', () => fishing.start());
  el('.leave').addEventListener('click', () => fishing.stop());
  card.addEventListener('click', () => fishing.press());

  const onKey = (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyF') { fishing.toggle(); return; }
    if (!fishing.state.active) return;
    if (e.code === 'Escape') { fishing.stop(); return; }
    if (e.code === 'Space') { fishing.press(); fishing.setHold(true); }
  };
  const onKeyUp = (e) => { if (e.code === 'Space') fishing.setHold(false); };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);

  // --- painting ------------------------------------------------------------
  // Every write is guarded on a cached value. update() runs every frame and a
  // style write that changes nothing still costs a style recalculation.
  const prev = {};
  const set = (key, v, fn) => { if (prev[key] !== v) { prev[key] = v; fn(v); } };
  const show = (node, on) => { if (node.dataset.on !== (on ? '1' : '0')) { node.dataset.on = on ? '1' : '0'; node.style.display = on ? '' : 'none'; } };

  const CIRC = 2 * Math.PI * 46;

  function update() {
    const s = fishing.state;
    const on = s.active;
    set('on', on, (v) => {
      root.classList.toggle('on', v);
      go.classList.toggle('hidden', v);
      document.body.classList.toggle('sf-fishing', v);
    });
    if (!on) return;

    const fighting = s.mode === 'fight';
    const striking = s.mode === 'strike';

    // ---- the ring ---------------------------------------------------------
    set('ringOn', striking, (v) => ring.classList.toggle('on', v));
    if (striking) {
      // r goes 46 -> 13 as the ring closes; the band at 20.5 is the window.
      const r = 13 + (46 - 13) * s.ring;
      ringCur.setAttribute('r', r.toFixed(2));
      set('hot', s.hookWindow, (v) => {
        ring.classList.toggle('hot', v);
        ringLbl.style.opacity = v ? '1' : '0';
      });
    }

    // ---- rows -------------------------------------------------------------
    // The jig meter is advice, and once a fish has committed the advice is
    // wrong — it would read "too still" at the exact moment the only thing
    // that matters is the ring.
    show(jigRow, s.mode === 'jig');
    show(tenRow, fighting);
    show(lineRow, fighting);

    if (s.mode === 'jig') {
      const w = clamp(s.jigSpeed / BAR_MAX, 0, 1);
      set('jw', Math.round(w * 200), () => { jigFill.style.width = `${w * 100}%`; });
      const cold = s.jig <= 0.02 && s.jigSpeed < 0.9;
      const hot = s.jig < 0;
      set('jc', `${cold}${hot}`, () => {
        jigBar.classList.toggle('cold', cold);
        jigBar.classList.toggle('hot', hot);
      });
      const label = hot ? 'too wild' : cold ? 'too still' : 'good';
      set('jl', label, (v) => { jigV.textContent = v; });
    }

    if (fighting) {
      const t = clamp(s.tension, 0, 1);
      set('tw', Math.round(t * 200), () => { tenFill.style.width = `${t * 100}%`; });
      set('tzone', t > 0.80 ? 2 : t > 0.55 ? 1 : 0, (v) => {
        tenBar.classList.toggle('mid', v === 1);
        tenBar.classList.toggle('warn', v === 2);
      });
      set('tv', t > 0.86 ? 'ease off!' : t < 0.1 ? 'slack' : '', (v) => { tenV.textContent = v; });
      const lw = clamp(1 - s.line / Math.max(s.lineMax, 0.001), 0, 1);
      set('lw', Math.round(lw * 200), () => { lineFill.style.width = `${lw * 100}%`; });
      set('lv', `${s.line.toFixed(1)} m`, (v) => { lineV.textContent = v; });
    }

    // ---- the button -------------------------------------------------------
    const label = striking ? 'Hook' : fighting ? 'Reel' : s.mode === 'landed' ? 'Nice' : 'Jig';
    set('act', label, (v) => { act.textContent = v; });
    set('actHot', striking && s.hookWindow, (v) => act.classList.toggle('strike', v));

    // ---- text -------------------------------------------------------------
    set('msg', s.message || '', (v) => {
      msg.textContent = v;
      msg.classList.toggle('on', !!v);
    });
    set('hint', s.mode === 'jig' ? (s.hint || '') : '', (v) => {
      hint.textContent = v;
      hint.classList.toggle('on', !!v);
    });
    set('tally', s.tally ? `${s.tally} landed` : '', (v) => { tally.textContent = v; });

    const cardOn = s.mode === 'landed' && !!s.catchName;
    set('card', cardOn ? `${s.catchName}|${s.catchLen}|${s.catchBest}` : '', (v) => {
      card.classList.toggle('on', !!v);
      if (!v) return;
      card.querySelector('.n').textContent = s.catchName;
      card.querySelector('.l').textContent = `${s.catchLen} cm`;
      card.querySelector('.pb').style.display = s.catchBest ? '' : 'none';
    });
  }

  return {
    root,
    update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      root.remove();
      go.remove();
      style.remove();
    },
  };
}
