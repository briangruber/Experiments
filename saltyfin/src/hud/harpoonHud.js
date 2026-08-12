// The harpoon interface.
//
// Reads `harpoon.state` and writes DOM, exactly as the fishing HUD does: it
// holds no game state of its own, so the tug-of-war can be tuned or driven
// from the console without this file knowing, and nothing here can desync
// from the sim. The module may not even exist yet when this is constructed -
// every update() bails if the handle or its state is missing, and every field
// it reads is treated as absent-until-proven so an older harpoon.js that has
// never heard of aiming still drives the parts it does know about.
//
// Three surfaces:
//
//   - one pill button, bottom-right, stacked above the fishing cast button.
//     It is the whole out-of-scope control scheme: tap to raise the spear
//     while the shot is offered, press-and-hold to cut once the line is live.
//     The hold's progress is painted INTO the button as a left-to-right fill,
//     so the gesture and its feedback are the same pixels.
//   - the scope: a full-screen aiming view with a vignette, a reticle, a
//     range readout and its own FIRE. It is the only place a throw can be
//     started from, because a throw you did not aim is a throw you did not
//     choose. The button hands off to it and hides.
//   - one status strip, top-centre under the quest card: line tension,
//     the creature's remaining fight, and a one-line hint. Above it, event
//     text fades in and out as the sim reports beats (hit, snap, give-up).
//
// The keyboard mirror is H: raise the spear while the shot is offered, fire
// while scoped, hold-to-cut while tethered. This module owns that listener the
// same way fishingHud owns KeyF.

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

/* --- the scope ------------------------------------------------------------- */
/* This one IS display-toggled, and that is not the rule being broken: the rule
   is about 3D effects, where mesh.visible drops a node out of the frame graph
   and the next reveal pops. This is a DOM plate, and while it is off it must
   not eat a single pointer event - an opacity-0 full-screen layer would eat
   every one of them. */
#sf-scope { position: fixed; inset: 0; z-index: 50; display: none;
  touch-action: none; cursor: crosshair;
  font: 600 11px/1.3 ui-sans-serif, system-ui, sans-serif; color: #dceaf7;
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
#sf-scope.sf-scope-on { display: block; }

/* The vignette: clear through the middle so the shot stays readable, dark at
   the edges so the eye is pushed to the centre and the frame reads as a tube
   rather than a filter. It takes no pointer events, because the plate under it
   is the aim pad and a drag has to start anywhere. */
#sf-scope .sf-scope-veil { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(circle at 50% 50%,
    rgba(4,10,20,0) 0, rgba(4,10,20,0) 15vmin,
    rgba(4,10,20,.30) 23vmin, rgba(4,10,20,.72) 40vmin); }

/* The reticle sits dead centre because that is where the aim ray points; the
   readout is positioned off the same centre rather than stacked with it, so
   growing a digit can never shove the crosshair off the axis it measures. */
#sf-scope .sf-scope-ret { position: absolute; left: 50%; top: 50%;
  width: min(34vmin, 208px); height: min(34vmin, 208px);
  transform: translate(-50%, -50%); pointer-events: none;
  color: rgba(214,236,255,.85);
  filter: drop-shadow(0 1px 3px rgba(0,0,0,.7)); }
#sf-scope .sf-scope-ret svg { width: 100%; height: 100%; overflow: visible; }
#sf-scope .sf-scope-mark { fill: none; stroke: currentColor; stroke-width: 1.3; }
#sf-scope .sf-scope-dot { fill: currentColor; stroke: none; }
#sf-scope .sf-scope-ring { fill: none; stroke: currentColor; stroke-width: 1.1;
  opacity: 0; }
/* One class on the root drives every part of the lock, so the crosshair, the
   ring, the number and the word can never disagree about whether there is
   something in front of the spear. */
#sf-scope.sf-scope-lock .sf-scope-ret { color: #ffc86b; }
#sf-scope.sf-scope-lock .sf-scope-ring { opacity: 1; }

#sf-scope .sf-scope-read { position: absolute; left: 50%; top: 50%;
  transform: translate(-50%, min(20vmin, 122px)); pointer-events: none;
  display: flex; align-items: baseline; gap: 10px; white-space: nowrap;
  letter-spacing: .18em; text-transform: uppercase; font-size: 10px;
  text-shadow: 0 1px 5px rgba(0,0,0,.75); }
#sf-scope .sf-scope-d { font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .12em; color: rgba(214,236,255,.9); }
#sf-scope .sf-scope-w { color: #ffc86b; opacity: 0; }
#sf-scope.sf-scope-lock .sf-scope-d { color: #ffc86b; }
#sf-scope.sf-scope-lock .sf-scope-w { opacity: 1; }

#sf-scope .sf-scope-hint { position: absolute; left: 50%;
  top: calc(16px + env(safe-area-inset-top)); transform: translateX(-50%);
  pointer-events: none; padding: 7px 13px; border-radius: 999px;
  border: 1px solid rgba(206,232,255,.18); background: rgba(8,20,36,.55);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  letter-spacing: .09em; font-size: 10px; color: rgba(214,236,255,.86);
  white-space: nowrap; }

#sf-scope .sf-scope-btns { position: absolute; left: 50%;
  bottom: calc(26px + env(safe-area-inset-bottom)); transform: translateX(-50%);
  display: flex; gap: 12px; }
#sf-scope-fire, #sf-scope-cancel { pointer-events: auto; cursor: pointer;
  min-height: 48px; min-width: 112px; padding: 0 22px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; border: 1px solid rgba(206,232,255,.24);
  background: rgba(8,20,36,.52);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: rgba(226,242,255,.86);
  font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .16em; text-transform: uppercase;
  box-shadow: 0 6px 22px rgba(0,0,0,.4); touch-action: none; }
#sf-scope-fire { border-color: rgba(255,200,107,.5); color: #ffe0ac;
  background: rgba(44,28,10,.55); }
#sf-scope-fire.sf-scope-down { background: rgba(255,200,107,.5); color: #1b1206; }
#sf-scope-cancel.sf-scope-down { background: rgba(122,178,232,.36); color: #fff; }
#sf-scope.sf-scope-lock #sf-scope-fire {
  box-shadow: 0 0 0 1px rgba(255,200,107,.5), 0 0 24px rgba(255,183,77,.42); }

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

// The crosshair: four arms with a clear gap at the middle so the animal is
// never hidden by the thing pointing at it, a dot for the exact axis, a
// perpendicular tick capping each arm, and the lock ring that only the amber
// state reveals.
const SVG_RETICLE = '<svg viewBox="0 0 120 120" aria-hidden="true">'
  + '<path class="sf-scope-mark" d="M60 22V48M60 72V98M22 60H48M72 60H98"/>'
  + '<path class="sf-scope-mark" d="M55 22H65M55 98H65M22 55V65M98 55V65"/>'
  + '<circle class="sf-scope-ring" cx="60" cy="60" r="13"/>'
  + '<circle class="sf-scope-dot" cx="60" cy="60" r="1.7"/>'
  + '</svg>';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function createHarpoonHud({ harpoon, ctx } = {}) {
  if (typeof document === 'undefined') return { update() {}, applyEnv() {}, dispose() {} };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // The module may be older than this HUD, or not built yet. Every call goes
  // through here so a missing aim()/nudgeAim() is a control that does nothing
  // rather than a throw that kills the frame.
  const call = (name, ...args) => {
    const fn = harpoon && harpoon[name];
    if (typeof fn === 'function') return fn.apply(harpoon, args);
    return undefined;
  };

  const go = document.createElement('div');
  go.id = 'sf-harpoon-go';
  go.dataset.sfUi = '';
  go.className = 'sf-harpoon-hidden';
  go.innerHTML = SVG_SPEAR + '<span class="sf-harpoon-go-t">HARPOON</span>';
  go.title = 'Harpoon  (H)';
  document.body.appendChild(go);

  // The scope. data-sf-ui is the whole reason a drag in here aims instead of
  // orbiting the chase camera as well: core/input.js latches on the press and
  // refuses any gesture that started inside a [data-sf-ui] subtree.
  const scope = document.createElement('div');
  scope.id = 'sf-scope';
  scope.dataset.sfUi = '';
  scope.innerHTML = `
    <div class="sf-scope-veil"></div>
    <div class="sf-scope-hint"></div>
    <div class="sf-scope-ret">${SVG_RETICLE}</div>
    <div class="sf-scope-read"><span class="sf-scope-d"></span><span class="sf-scope-w">Lock</span></div>
    <div class="sf-scope-btns">
      <div id="sf-scope-cancel">Cancel</div>
      <div id="sf-scope-fire">Fire</div>
    </div>`;
  document.body.appendChild(scope);

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
  const scopeHint = scope.querySelector('.sf-scope-hint');
  const scopeDist = scope.querySelector('.sf-scope-d');
  const scopeFire = scope.querySelector('#sf-scope-fire');
  const scopeCancel = scope.querySelector('#sf-scope-cancel');
  const toast = root.querySelector('.sf-harpoon-toast');
  const panel = root.querySelector('.sf-harpoon-panel');
  const dist = root.querySelector('.sf-harpoon-dist');
  const lineBar = root.querySelector('.sf-harpoon-line');
  const lineFill = root.querySelector('.sf-harpoon-line i');
  const fightBar = root.querySelector('.sf-harpoon-fight');
  const fightFill = root.querySelector('.sf-harpoon-fight i');
  const hint = root.querySelector('.sf-harpoon-hint');

  // The hints name the controls the player actually has, decided once - a
  // pointer does not change coarseness mid-fight.
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  hint.textContent = touch
    ? 'Throttle away to tire it - hold CUT LINE to let go'
    : 'Full throttle away to tire it - hold H or CUT LINE to let go';
  scopeHint.textContent = touch
    ? 'Drag to aim - FIRE to throw'
    : 'Drag or arrow keys to aim - H or FIRE to throw, Esc to cancel';

  // --- input -----------------------------------------------------------------

  // One button, two gestures, disambiguated by the sim's own state: a press
  // while the shot is offered raises the spear into the scope; a press while
  // the line is live is the start of the cut, and it is a HOLD - release always
  // lets go of the knife, whichever way the pointer leaves. TOO DEEP is inert
  // on purpose: the button is a label at that point, not a control.
  let holding = false;
  const goDown = (e) => {
    e.preventDefault();
    const s = harpoon && harpoon.state;
    if (!s) return;
    if (s.tethered) {
      holding = true;
      go.classList.add('sf-harpoon-down');
      call('holdCut', true);
    } else if (s.available && !s.aiming) {
      call('aim');
    }
  };
  const goUp = () => {
    go.classList.remove('sf-harpoon-down');
    if (!holding) return;
    holding = false;
    call('holdCut', false);
  };
  go.addEventListener('pointerdown', goDown);
  go.addEventListener('pointerup', goUp);
  go.addEventListener('pointerleave', goUp);
  go.addEventListener('pointercancel', goUp);
  // Kill the synthesized click / long-press callout on touch; the pointer
  // events above already fired by the time this runs.
  go.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // --- the scope's drag ------------------------------------------------------
  //
  // SIGNS. aimYaw is a world heading in boat.heading's convention: forward is
  // (sin h, 0, -cos h), so zero is north and INCREASING yaw swings to
  // starboard - to the RIGHT. aimPitch is + up.
  //
  // chaseCamera.js is the reference for what a drag means in this game, and it
  // reads (its "drag right, look right - the same sense as the helm"):
  //
  //     orbit      +=  pointer.dx * ORBIT_GAIN      // yaw = boat.heading + orbit
  //     orbitPitch -=  pointer.dy * PITCH_GAIN
  //
  // Since that orbit is ADDED to the heading, dx > 0 raises the view heading,
  // i.e. dragging right swings the view right and dragging left swings it
  // left. Matching it means dYaw = +dx * G, NOT -dx * G: negating here would
  // give a scope that swings opposite to the camera the player has been
  // driving with all game, which is the one thing a scope must not do.
  // Vertically the camera's sign carries over literally, and -dy is also what
  // "drag up, aim up" wants: dy < 0 going up, so -dy raises aimPitch.
  //
  // Gains are per-pointer for the same reason the camera's are: a thumb
  // travels further and lands with more slop than a cursor. Pitch is
  // deliberately 0.8x yaw - the useful pitch band is a few degrees wide and
  // the yaw band is the whole horizon.
  const GAIN_YAW = touch ? 0.0022 : 0.0030;
  const GAIN_PITCH = GAIN_YAW * 0.8;

  let dragId = null;
  let lastX = 0;
  let lastY = 0;

  const endDrag = (e) => {
    if (dragId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== dragId) return;
    const id = dragId;
    dragId = null;
    try {
      if (scope.hasPointerCapture && scope.hasPointerCapture(id)) scope.releasePointerCapture(id);
    } catch (err) { /* the pointer is already gone; nothing to release */ }
  };

  const scopeDown = (e) => {
    // The buttons are inside the aim pad, so they have to be carved out of it
    // by hand - otherwise a thumb landing on FIRE also starts swinging the aim
    // and the throw goes wherever the press wobbled to.
    if (e.target && typeof e.target.closest === 'function'
      && e.target.closest('#sf-scope-fire, #sf-scope-cancel')) return;
    e.preventDefault();
    endDrag();
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    // Capture so a drag that runs off the element - or off the window edge on
    // a phone - keeps aiming instead of freezing mid-swing.
    try { scope.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  };

  const scopeMove = (e) => {
    if (dragId === null || e.pointerId !== dragId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dx === 0 && dy === 0) return;
    call('nudgeAim', dx * GAIN_YAW, -dy * GAIN_PITCH);
  };

  scope.addEventListener('pointerdown', scopeDown);
  scope.addEventListener('pointermove', scopeMove);
  scope.addEventListener('pointerup', endDrag);
  scope.addEventListener('pointercancel', endDrag);
  scope.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

  // FIRE acts on the press, like a trigger: a throw that waited for the
  // release would land a frame after the moment the player picked.
  const press = (el, fn) => {
    const dn = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('sf-scope-down');
      fn();
    };
    const up = () => el.classList.remove('sf-scope-down');
    el.addEventListener('pointerdown', dn);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('pointercancel', up);
  };
  press(scopeFire, () => call('fire'));
  press(scopeCancel, () => call('cancelAim'));

  // H mirrors the button, and what it means follows the state: raise the spear
  // while the shot is offered, throw it while scoped, hold the knife while
  // tethered. Fire and aim want the edge so repeats are skipped there; the
  // hold wants the level, and key repeat re-asserting holdCut(true) is
  // harmless because keyup always ends it. The arrows are the mouse's stand-in
  // and DO want the repeat - held, they sweep.
  const AIM_STEP = 0.015;   // rad per keydown; at a normal repeat rate ~0.9 rad/s
  const onKey = (e) => {
    // A key typed into a text field is prose, and the town editor holding the
    // world means the world is not listening.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ctx?.editorHold) return;
    const s = harpoon && harpoon.state;
    if (!s) return;

    if (s.aiming) {
      switch (e.code) {
        case 'ArrowLeft': e.preventDefault(); call('nudgeAim', -AIM_STEP, 0); return;
        case 'ArrowRight': e.preventDefault(); call('nudgeAim', AIM_STEP, 0); return;
        case 'ArrowUp': e.preventDefault(); call('nudgeAim', 0, AIM_STEP); return;
        case 'ArrowDown': e.preventDefault(); call('nudgeAim', 0, -AIM_STEP); return;
        case 'Escape': if (!e.repeat) call('cancelAim'); return;
        case 'KeyH': case 'Space': case 'Enter':
          e.preventDefault();
          if (!e.repeat) call('fire');
          return;
        default: return;
      }
    }

    if (e.code !== 'KeyH') return;
    if (s.tethered) { call('holdCut', true); return; }
    if (e.repeat) return;
    if (s.available) call('aim');
  };
  const onKeyUp = (e) => {
    if (e.code !== 'KeyH') return;
    call('holdCut', false);
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
    const aiming = !!s.aiming;
    const reeling = !!s.reeling;

    // ---- the button ---------------------------------------------------------
    // Offered while there is something to do with it, and never during the
    // capsize drama - a control shown while the boat is rolling over is a lie.
    // A creature in range but below spear depth keeps the button visible and
    // dim: the wait for it to rise is part of the hunt, not a missing UI.
    // While the spear is out or coming back there is nothing to press, and
    // while the scope is up the scope owns the throw, so the pill stands down
    // rather than offering a second, differently-shaped FIRE.
    const nearDeep = !!s.nearDeep;
    const goOn = (available || tethered || nearDeep)
      && !s.capsizing && !aiming && !flight && !reeling;
    set('goOn', goOn, (v) => go.classList.toggle('sf-harpoon-hidden', !v));
    set('goDim', nearDeep && !available && !tethered,
      (v) => go.classList.toggle('sf-harpoon-dim', v));
    set('goLabel', tethered ? 'CUT LINE' : (available ? 'AIM' : 'TOO DEEP'),
      (v) => { goLabel.textContent = v; });

    // The cut's progress, painted into the button from the left. background-image
    // only: the base colour underneath stays whatever the CSS (and :active) says.
    const cut = tethered ? Math.round(clamp(num(s.cutHold), 0, 1) * 100) : 0;
    set('cut', cut, (v) => {
      go.style.backgroundImage = v > 0
        ? `linear-gradient(90deg, rgba(255,138,91,.55) ${v}%, rgba(255,138,91,0) ${v}%)`
        : '';
    });

    // ---- the scope ----------------------------------------------------------
    set('scopeOn', aiming, (v) => scope.classList.toggle('sf-scope-on', v));
    if (!aiming) {
      // The plate is gone; so is any drag that was riding it. Without this a
      // shot fired mid-drag leaves a captured pointer that would keep nudging
      // an aim nobody is looking at.
      endDrag();
    } else {
      const lock = !!s.onTarget;
      set('scopeLock', lock, (v) => scope.classList.toggle('sf-scope-lock', v));
      // Zero means the ray is pointed at open water, and "0 M" would read as a
      // range rather than as no answer.
      const lead = num(s.leadDist);
      set('scopeLead', lead > 0 ? `${Math.round(lead)} M` : '',
        (v) => { scopeDist.textContent = v; });
    }

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
      endDrag();
      // Every other listener this module added is on one of these three
      // elements, so removing them takes the listeners with them.
      root.remove();
      scope.remove();
      go.remove();
      style.remove();
    },
  };
}
