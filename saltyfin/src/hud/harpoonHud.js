// The harpoon interface.
//
// Reads `harpoon.state` and writes DOM, exactly as the fishing HUD does: it
// holds no game state of its own, so the tug-of-war can be tuned or driven
// from the console without this file knowing, and nothing here can desync
// from the sim. The module may not even exist yet when this is constructed -
// every update() bails if the handle or its state is missing.
//
// Two surfaces:
//
//   - one pill button, bottom-right, stacked above the fishing cast button.
//     It is the whole control scheme: tap to throw while the shot is offered,
//     press-and-hold to cut once the line is live. The hold's progress is
//     painted INTO the button as a left-to-right fill, so the gesture and its
//     feedback are the same pixels.
//   - one status strip, top-centre under the quest card: line tension,
//     the creature's remaining fight, and a one-line hint. Above it, event
//     text fades in and out as the sim reports beats (hit, snap, give-up).
//
// The keyboard mirror is H: fire on the press while the shot is offered,
// hold-to-cut while tethered. This module owns that listener the same way
// fishingHud owns KeyF.

const CSS = `
/* --- the call to action, stacked 56px above #sf-fish-go ------------------- */
#sf-harpoon-go { position: fixed; z-index: 46; pointer-events: auto; cursor: pointer;
  right: max(14px, env(safe-area-inset-right));
  bottom: calc(206px + env(safe-area-inset-bottom));
  display: flex; align-items: center; gap: 7px;
  padding: 9px 14px 9px 11px; border-radius: 999px;
  border: 1px solid rgba(206,232,255,.24); background: rgba(8,20,36,.52);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: rgba(226,242,255,.86);
  font: 700 10px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .16em; text-transform: uppercase;
  -webkit-user-select: none; user-select: none; touch-action: none;
  -webkit-touch-callout: none; }
#sf-harpoon-go:active, #sf-harpoon-go.sf-harpoon-down {
  background-color: rgba(122,178,232,.36); color: #fff; }
#sf-harpoon-go svg { width: 15px; height: 15px; fill: currentColor; }
#sf-harpoon-go.sf-harpoon-hidden { display: none; }
/* In range but the animal is too deep to reach: the button stays, dimmed,
   naming the reason - absence read as a bug, a dim button reads as "wait". */
#sf-harpoon-go.sf-harpoon-dim { opacity: .45; cursor: default; }

/* --- the status strip ------------------------------------------------------ */
#sf-harpoon { position: fixed; z-index: 46; left: 50%; top: 64px;
  transform: translateX(-50%); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  font: 600 11px/1.3 ui-sans-serif, system-ui, sans-serif;
  color: #dceaf7; -webkit-user-select: none; user-select: none; }

/* The toast is always in flow so its arrival never shoves the bars around;
   it simply has no opacity until the sim gives it words. */
#sf-harpoon .sf-harpoon-toast { padding: 7px 13px; border-radius: 999px;
  border: 1px solid rgba(206,232,255,.22); background: rgba(8,20,36,.6);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  letter-spacing: .14em; text-transform: uppercase; font-size: 10px;
  color: rgba(226,242,255,.92); white-space: nowrap; opacity: 0; }

#sf-harpoon .sf-harpoon-panel { display: flex; flex-direction: column;
  gap: 7px; align-items: center; }
#sf-harpoon .sf-harpoon-row { width: 160px; }
#sf-harpoon .sf-harpoon-cap { display: flex; justify-content: space-between;
  align-items: baseline; margin-bottom: 3px;
  letter-spacing: .16em; text-transform: uppercase; font-size: 9px;
  color: rgba(196,222,244,.66); text-shadow: 0 1px 4px rgba(0,0,0,.6); }
#sf-harpoon .sf-harpoon-bar { position: relative; height: 7px; border-radius: 999px;
  background: rgba(6,16,28,.55); border: 1px solid rgba(206,232,255,.18);
  overflow: hidden; }
#sf-harpoon .sf-harpoon-bar i { position: absolute; inset: 0 auto 0 0; width: 0; }

/* Tension. Two fixed colours swapped by class - the colour is a function of
   the VALUE, never a gradient on the fill (see fishingHud for why a gradient
   on a value-sized fill is a lie). */
#sf-harpoon .sf-harpoon-line i { background: #FFD166; }
#sf-harpoon .sf-harpoon-line.sf-harpoon-hot i { background: #FF6B4A; }
#sf-harpoon .sf-harpoon-line.sf-harpoon-warn { box-shadow:
  0 0 0 1px rgba(255,107,74,.7), 0 0 14px rgba(255,107,74,.4); }

/* The creature's fight, draining toward the win. */
#sf-harpoon .sf-harpoon-fight i { background: #7FD4E8; }
#sf-harpoon .sf-harpoon-fight.sf-harpoon-win i {
  animation: sf-harpoon-pulse .8s ease-in-out infinite; }
@keyframes sf-harpoon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

#sf-harpoon .sf-harpoon-hint { letter-spacing: .09em; font-size: 10px;
  color: rgba(214,236,255,.8); text-shadow: 0 1px 4px rgba(0,0,0,.6);
  white-space: nowrap; }
`;

// A barbed spear, same 24-box and single-path style as the fishing rod glyph.
const SVG_SPEAR = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M21.2 2.8 15 4.1l2.1 2.1-8.9 8.9-2-.7-2.9 2.9 3.2 1.1 1.1 3.2'
  + ' 2.9-2.9-.7-2 8.9-8.9 2.1 2.1 1.3-6.2Z"/>'
  + '</svg>';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createHarpoonHud({ harpoon, ctx } = {}) {
  if (typeof document === 'undefined') return { update() {}, applyEnv() {}, dispose() {} };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const go = document.createElement('div');
  go.id = 'sf-harpoon-go';
  go.dataset.sfUi = '';
  go.className = 'sf-harpoon-hidden';
  go.innerHTML = SVG_SPEAR + '<span class="sf-harpoon-go-t">HARPOON</span>';
  go.title = 'Harpoon  (H)';
  document.body.appendChild(go);

  const root = document.createElement('div');
  root.id = 'sf-harpoon';
  root.dataset.sfUi = '';
  root.innerHTML = `
    <div class="sf-harpoon-toast"></div>
    <div class="sf-harpoon-panel" style="display:none">
      <div class="sf-harpoon-row">
        <div class="sf-harpoon-cap"><span>Line</span><span class="sf-harpoon-dist"></span></div>
        <div class="sf-harpoon-bar sf-harpoon-line"><i></i></div>
      </div>
      <div class="sf-harpoon-row">
        <div class="sf-harpoon-cap"><span>Fight</span></div>
        <div class="sf-harpoon-bar sf-harpoon-fight"><i></i></div>
      </div>
      <div class="sf-harpoon-hint"></div>
    </div>`;
  document.body.appendChild(root);

  const goLabel = go.querySelector('.sf-harpoon-go-t');
  const toast = root.querySelector('.sf-harpoon-toast');
  const panel = root.querySelector('.sf-harpoon-panel');
  const dist = root.querySelector('.sf-harpoon-dist');
  const lineBar = root.querySelector('.sf-harpoon-line');
  const lineFill = root.querySelector('.sf-harpoon-line i');
  const fightBar = root.querySelector('.sf-harpoon-fight');
  const fightFill = root.querySelector('.sf-harpoon-fight i');
  const hint = root.querySelector('.sf-harpoon-hint');

  // The hint names the controls the player actually has, decided once - a
  // pointer does not change coarseness mid-fight.
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  hint.textContent = touch
    ? 'Throttle away to tire it - hold CUT LINE to let go'
    : 'Full throttle away to tire it - hold H or CUT LINE to let go';

  // --- input -----------------------------------------------------------------

  // One button, two gestures, disambiguated by the sim's own state: a press
  // while the shot is offered is the throw; a press while the line is live is
  // the start of the cut, and it is a HOLD - release always lets go of the
  // knife, whichever way the pointer leaves.
  let holding = false;
  const goDown = (e) => {
    e.preventDefault();
    const s = harpoon && harpoon.state;
    if (!s) return;
    if (s.tethered) {
      holding = true;
      go.classList.add('sf-harpoon-down');
      harpoon.holdCut(true);
    } else if (s.available) {
      harpoon.fire();
    }
  };
  const goUp = () => {
    go.classList.remove('sf-harpoon-down');
    if (!holding) return;
    holding = false;
    if (harpoon && harpoon.holdCut) harpoon.holdCut(false);
  };
  go.addEventListener('pointerdown', goDown);
  go.addEventListener('pointerup', goUp);
  go.addEventListener('pointerleave', goUp);
  go.addEventListener('pointercancel', goUp);
  // Kill the synthesized click / long-press callout on touch; the pointer
  // events above already fired by the time this runs.
  go.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // H mirrors the button. Fire wants the edge so repeats are skipped there;
  // the hold wants the level, and key repeat re-asserting holdCut(true) is
  // harmless because keyup always ends it.
  const onKey = (e) => {
    if (e.code !== 'KeyH') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ctx?.editorHold) return;
    const s = harpoon && harpoon.state;
    if (!s) return;
    if (s.tethered) { harpoon.holdCut(true); return; }
    if (e.repeat) return;
    if (s.available) harpoon.fire();
  };
  const onKeyUp = (e) => {
    if (e.code !== 'KeyH') return;
    if (harpoon && harpoon.holdCut) harpoon.holdCut(false);
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);

  // --- painting ----------------------------------------------------------------
  // Every write is guarded on a cached value, same as the fishing HUD: update()
  // runs every frame and a style write that changes nothing still costs a style
  // recalculation. Continuous values are quantised into the guard key so a
  // slowly-moving number writes at most a couple of hundred times per sweep.
  const prev = {};
  const set = (key, v, fn) => { if (prev[key] !== v) { prev[key] = v; fn(v); } };
  const show = (node, on) => {
    if (node.dataset.on !== (on ? '1' : '0')) {
      node.dataset.on = on ? '1' : '0';
      node.style.display = on ? '' : 'none';
    }
  };

  function update() {
    if (!harpoon || !harpoon.state) return;
    const s = harpoon.state;
    const tethered = !!s.tethered;
    const flight = !!s.flight;
    const available = !!s.available;

    // ---- the button ---------------------------------------------------------
    // Offered while there is something to do with it, and never during the
    // capsize drama - a control shown while the boat is rolling over is a lie.
    // A creature in range but below spear depth keeps the button visible and
    // dim: the wait for it to rise is part of the hunt, not a missing UI.
    const nearDeep = !!s.nearDeep;
    const goOn = (available || tethered || nearDeep) && !s.capsizing;
    set('goOn', goOn, (v) => go.classList.toggle('sf-harpoon-hidden', !v));
    set('goDim', nearDeep && !available && !tethered,
      (v) => go.classList.toggle('sf-harpoon-dim', v));
    set('goLabel', tethered ? 'CUT LINE' : (available ? 'HARPOON' : 'TOO DEEP'),
      (v) => { goLabel.textContent = v; });

    // The cut's progress, painted into the button from the left. background-image
    // only: the base colour underneath stays whatever the CSS (and :active) says.
    const cut = tethered ? Math.round(clamp(num(s.cutHold), 0, 1) * 100) : 0;
    set('cut', cut, (v) => {
      go.style.backgroundImage = v > 0
        ? `linear-gradient(90deg, rgba(255,138,91,.55) ${v}%, rgba(255,138,91,0) ${v}%)`
        : '';
    });

    // ---- the strip ----------------------------------------------------------
    show(panel, tethered || flight);
    if (tethered || flight) {
      const t = clamp(num(s.tension), 0, 1);
      set('lw', Math.round(t * 200), () => { lineFill.style.width = `${t * 100}%`; });
      set('lhot', t > 0.75, (v) => lineBar.classList.toggle('sf-harpoon-hot', v));
      set('lwarn', t > 0.85, (v) => lineBar.classList.toggle('sf-harpoon-warn', v));

      const strain = clamp(num(s.strain), 0, 1);
      const f = 1 - strain;
      set('fw', Math.round(f * 200), () => { fightFill.style.width = `${f * 100}%`; });
      set('fwin', strain > 0.85, (v) => fightBar.classList.toggle('sf-harpoon-win', v));

      const d = s.distance;
      const dTxt = (tethered || available) && Number.isFinite(d) ? `${Math.round(d)} m` : '';
      set('dist', dTxt, (v) => { dist.textContent = v; });
    }

    // ---- the toast ----------------------------------------------------------
    // Independent of the strip: "line snapped" arrives on the exact frame
    // tethered goes false, and the words have to outlive the bars.
    const msgT = num(s.msgT);
    const msgOn = !!s.msg && msgT < 3;
    set('msg', msgOn ? s.msg : '', (v) => { toast.textContent = v; });
    const op = msgOn ? (msgT <= 2.2 ? 1 : clamp(1 - (msgT - 2.2) / 0.8, 0, 1)) : 0;
    set('msgOp', Math.round(op * 50), (v) => { toast.style.opacity = `${v / 50}`; });
  }

  return {
    update,
    applyEnv() {},
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      root.remove();
      go.remove();
      style.remove();
    },
  };
}
