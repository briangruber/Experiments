// Touch controls, for phones and tablets. Built only when the device actually
// has a coarse pointer (or `?touch=1` forces it), so a desktop never sees them.
//
// Left thumb drives: a floating stick that appears wherever the thumb lands on
// the left half — forward/back is throttle, left/right is helm. Right half is
// the camera: drag to orbit, pinch to zoom. The time-of-day row sends the same
// key events main.js already listens for, so there is one code path for both.
//
// This module owns its own markup and its own stylesheet. It does not touch the
// HUD, so the two can be worked on independently.

const CSS = `
#touch { position: fixed; inset: 0; z-index: 40; pointer-events: none;
  touch-action: none; -webkit-user-select: none; user-select: none; }
#touch .zone { position: absolute; top: 0; bottom: 0; pointer-events: auto; }
/* The helm zone starts clear of the throttle lever, so the thumb that steers
   and the thumb that sets the revs never argue over the same pixels. */
#touch .zone.drive { left: 96px; width: calc(50% - 96px); }
#touch .zone.look  { right: 0; width: 50%; }

/* --- the throttle ---------------------------------------------------------
   A lever, not a spring: it stays where it is left, and there is a detent at
   neutral that a drag from ahead CATCHES on before it can reach astern. That
   catch is the whole reason this is not just a slider - it is how you stop a
   boat without accidentally ordering full astern. */
#touch .thr { position: absolute; left: max(12px, env(safe-area-inset-left));
  top: 50%; transform: translateY(-50%);
  width: 66px; height: min(58vh, 300px); pointer-events: auto; touch-action: none; }
#touch .thr-track { position: absolute; inset: 0; border-radius: 33px;
  border: 1.5px solid rgba(214,236,255,.30);
  background: linear-gradient(180deg,
    rgba(94,168,120,.20) 0%, rgba(94,168,120,.10) 38%,
    rgba(10,26,44,.34) 46%, rgba(10,26,44,.34) 54%,
    rgba(198,120,90,.10) 62%, rgba(198,120,90,.20) 100%);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
/* The neutral band, drawn where the detent actually is so the eye and the
   thumb agree about where the lever will catch. */
#touch .thr-neutral { position: absolute; left: 4px; right: 4px; top: 50%;
  height: 34px; transform: translateY(-50%); border-radius: 17px;
  border: 1px solid rgba(214,236,255,.30);
  background: rgba(10,26,44,.30); }
#touch .thr-n { position: absolute; left: 0; right: 0; top: 50%;
  transform: translateY(-50%); text-align: center;
  font: 700 8px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .18em;
  color: rgba(214,236,255,.62); }
#touch .thr-lever { position: absolute; left: 3px; right: 3px; top: 50%;
  height: 46px; margin-top: -23px; border-radius: 23px;
  border: 1.5px solid rgba(226,242,255,.70);
  background: linear-gradient(180deg, rgba(214,236,255,.34), rgba(150,190,224,.26));
  box-shadow: 0 3px 12px rgba(0,0,0,.42);
  display: flex; align-items: center; justify-content: center; }
#touch .thr-lever::after { content: ''; width: 26px; height: 2px; border-radius: 2px;
  background: rgba(255,255,255,.66);
  box-shadow: 0 -5px 0 rgba(255,255,255,.4), 0 5px 0 rgba(255,255,255,.4); }
#touch .thr-lever.on { border-color: #fff;
  background: linear-gradient(180deg, rgba(236,248,255,.46), rgba(170,208,240,.34)); }
#touch .thr-cap { position: absolute; left: 0; right: 0; text-align: center;
  font: 700 8px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .16em;
  color: rgba(214,236,255,.5); pointer-events: none; }
#touch .thr-cap.ahead { top: 8px; }
#touch .thr-cap.astern { bottom: 8px; }
#touch .stick { position: absolute; width: 128px; height: 128px; margin: -64px 0 0 -64px;
  border-radius: 50%; border: 1.5px solid rgba(214,236,255,.34);
  background: radial-gradient(circle at 50% 50%, rgba(10,26,44,.30), rgba(10,26,44,.16));
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  opacity: 0; transition: opacity .16s ease; }
#touch .stick.on { opacity: 1; }
#touch .nub { position: absolute; width: 54px; height: 54px; margin: -27px 0 0 -27px;
  border-radius: 50%; border: 1.5px solid rgba(226,242,255,.62);
  background: rgba(190,222,248,.26); box-shadow: 0 2px 10px rgba(0,0,0,.30); }
#touch .hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
  font: 600 9px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .16em;
  text-transform: uppercase; color: rgba(214,236,255,.5); white-space: nowrap; }
#touch .times { position: absolute; left: 50%; bottom: max(14px, env(safe-area-inset-bottom));
  transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; }
#touch .times button { appearance: none; border: 1px solid rgba(206,232,255,.20);
  background: rgba(8,20,36,.40); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  color: rgba(226,242,255,.74); border-radius: 999px; padding: 5px 9px;
  font: 600 9px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .10em;
  text-transform: uppercase; }
#touch .times button:active { background: rgba(122,178,232,.34); color: #fff; }
/* The settings key, set apart from the four time presets because it opens a
   sheet rather than setting the hour. On a phone this is the ONLY way in: the
   panel was bound to the O key and nothing else, so every slider in it was
   unreachable without a keyboard. */
#touch .times button.cfg { border-color: rgba(255,196,120,.42); color: #ffdcae;
  margin-left: 8px; }
#touch .times button.cfg:active { background: rgba(255,170,90,.34); color: #fff; }
#touch .times button:focus-visible { outline: 2px solid #ff9a3c; outline-offset: 2px; }
#touch.hidden { display: none; }
@media (min-width: 900px) and (pointer: fine) { #touch { display: none; } }

/* HUD adjustments that only make sense once there is a thumb on the glass.
   These live here rather than in hud.css so the HUD module stays the single
   owner of its own layout and this file stays the single owner of touch. */
@media (pointer: coarse) {
  /* The on-screen buttons replace the keyboard hint row. */
  #hud .sf-tod { display: none !important; }
  /* The time-of-day row owns the bottom centre, and on a narrow phone it reaches
     far enough left to sit under the renderer badge — five pills across 390px.
     Lift the badge clear of it. !important because main.js sets the badge's
     position inline, and inline loses to an important rule. */
  /* The player asked for a HUD that is the radar and nothing else, and the
     badge is a HUD element however small. It is also the only way into the
     renderer switch and the GPU profiler, so it does not just get deleted —
     tapping the radar opens the same menu. See main.js. */
  #fps { display: none !important; }
  /* Small, and clear of the button row. */
  #hud .sf-mm { width: 88px !important; height: 88px !important;
    right: max(10px, env(safe-area-inset-right)) !important;
    bottom: calc(54px + env(safe-area-inset-bottom)) !important; }
  #hud .sf-quest { max-width: min(58vw, 250px) !important; }
  #hud .sf-compass { top: max(8px, env(safe-area-inset-top)) !important;
    width: min(88vw, 440px) !important; }
}
@media (pointer: coarse) and (orientation: portrait) {
  #touch .stick { width: 108px; height: 108px; margin: -54px 0 0 -54px; }
}
`;

const DEAD = 8;      // px of slop before the stick registers
const RANGE = 52;    // px from centre for full deflection

export function createTouchControls({ input, onTimePreset } = {}) {
  const coarse = matchMedia('(pointer: coarse)').matches
    || navigator.maxTouchPoints > 0
    || new URLSearchParams(location.search).get('touch') === '1';
  if (!coarse) return { root: null, dispose() {} };

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="zone drive"></div>
    <div class="zone look"></div>
    <div class="thr" id="sf-throttle">
      <div class="thr-track sf-thr-track">
        <div class="thr-cap ahead">Ahead</div>
        <div class="thr-neutral"><div class="thr-n">N</div></div>
        <div class="thr-cap astern">Astern</div>
      </div>
      <div class="thr-lever sf-thr-lever"></div>
    </div>
    <div class="stick"><div class="nub"></div><div class="hint">helm</div></div>
    <div class="times" data-sf-ui>
      <button data-code="Digit1">Day</button>
      <button data-code="Digit2">Golden</button>
      <button data-code="Digit3">Sunset</button>
      <button data-code="Digit4">Night</button>
      <button data-code="KeyT">Cycle</button>
      <button data-code="KeyO" class="cfg">Ocean</button>
    </div>`;
  document.body.appendChild(root);

  const drive = root.querySelector('.drive');
  const look = root.querySelector('.look');
  const stick = root.querySelector('.stick');
  const nub = root.querySelector('.nub');

  let driveId = null, ox = 0, oy = 0;
  let lookId = null, lx = 0, ly = 0;
  const pinch = new Map();
  let pinchDist = 0;

  // The stick is the HELM now, and only the helm: the throttle moved to its
  // own lever, and a stick that also set the revs meant every course
  // correction nudged the speed. Vertical travel is still drawn, because a
  // thumb does not move in a straight line and a nub that refuses to follow
  // it feels broken — it simply does not command anything.
  const setStick = (dx, dy) => {
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    const turn = Math.abs(dx) < DEAD ? 0 : Math.max(-1, Math.min(1, dx / RANGE));
    input.setTouchTurn(turn);
  };

  const onDriveStart = (e) => {
    if (driveId !== null) return;
    const t = e.changedTouches[0];
    driveId = t.identifier; ox = t.clientX; oy = t.clientY;
    stick.style.left = ox + 'px'; stick.style.top = oy + 'px';
    stick.classList.add('on');
    setStick(0, 0);
  };
  const onDriveMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== driveId) continue;
      let dx = t.clientX - ox, dy = t.clientY - oy;
      const len = Math.hypot(dx, dy);
      if (len > RANGE) { dx *= RANGE / len; dy *= RANGE / len; }
      setStick(dx, dy);
    }
  };
  const onDriveEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== driveId) continue;
      driveId = null;
      stick.classList.remove('on');
      setStick(0, 0);
    }
  };

  const onLookStart = (e) => {
    for (const t of e.changedTouches) {
      pinch.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }
    if (pinch.size === 2) pinchDist = spread();
  };
  const spread = () => {
    const [a, b] = [...pinch.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const onLookMove = (e) => {
    for (const t of e.changedTouches) {
      if (pinch.has(t.identifier)) pinch.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (t.identifier !== lookId || pinch.size > 1) continue;
      input.addTouchLook(t.clientX - lx, t.clientY - ly);
      lx = t.clientX; ly = t.clientY;
    }
    if (pinch.size === 2) {
      const d = spread();
      if (pinchDist > 0) input.addTouchZoom((pinchDist - d) * 0.02);
      pinchDist = d;
    }
  };
  const onLookEnd = (e) => {
    for (const t of e.changedTouches) {
      pinch.delete(t.identifier);
      if (t.identifier === lookId) lookId = null;
    }
    if (pinch.size < 2) pinchDist = 0;
    if (pinch.size === 1 && lookId === null) {
      const [id] = [...pinch.keys()];
      const p = pinch.get(id);
      lookId = id; lx = p.x; ly = p.y;
    }
  };

  // --- the throttle lever -----------------------------------------------------
  //
  // Position is remembered in `lever` (-1 astern .. +1 ahead) and the thumb
  // moves it relatively, so grabbing it never makes it jump. Two rules give it
  // the feel of a real control head:
  //
  //   NEUTRAL BAND   anything within 0.10 of centre commands exactly zero, so
  //                  idle is a place you can find without looking
  //   THE DETENT     a drag coming DOWN out of ahead stops dead at neutral and
  //                  stays there until the thumb has travelled DETENT_PX
  //                  further. You cannot fall into reverse while trying to
  //                  slow down — which is the whole reason boats have a detent
  //                  and the reason a plain slider would be wrong here.
  const NEUTRAL = 0.10;
  const DETENT_PX = 26;
  let lever = 0;               // the commanded position, latched
  let thrId = null;
  let thrY = 0;                // last touch y
  let thrRaw = 0;              // lever position before the detent is applied
  let caught = 0;              // px travelled since the detent grabbed; 0 = free

  const thrEl = root.querySelector('.thr');
  const thrLever = root.querySelector('.thr-lever');
  const thrTrack = root.querySelector('.thr-track');

  const paintLever = () => {
    const h = thrTrack.clientHeight || 260;
    const travel = (h - 52) * 0.5;
    thrLever.style.transform = `translateY(${(-lever * travel).toFixed(1)}px)`;
  };

  const commitLever = () => {
    const v = Math.abs(lever) < NEUTRAL ? 0 : lever;
    input.setThrottleLever(v);
    paintLever();
  };

  const onThrStart = (e) => {
    if (thrId !== null) return;
    const t = e.changedTouches[0];
    thrId = t.identifier;
    thrY = t.clientY;
    thrRaw = lever;
    caught = 0;
    thrLever.classList.add('on');
  };
  const onThrMove = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== thrId) continue;
      const h = thrTrack.clientHeight || 260;
      const travel = Math.max(40, (h - 52) * 0.5);
      const dy = t.clientY - thrY;
      thrY = t.clientY;
      const was = thrRaw;
      thrRaw = Math.max(-1, Math.min(1, thrRaw - dy / travel));
      // Coming down out of ahead: catch at neutral, and hold there until the
      // thumb has pushed DETENT_PX further down.
      if (was > NEUTRAL && thrRaw <= NEUTRAL && caught === 0) caught = 1e-6;
      if (caught > 0) {
        caught += Math.max(0, dy);
        thrRaw = Math.max(thrRaw, 0);
        if (caught < DETENT_PX) { lever = 0; commitLever(); continue; }
        caught = 0;             // released from the detent; astern is allowed
        // Just PAST the band, not on its edge: landing exactly on NEUTRAL
        // would still command zero and the detent would read as a dead zone
        // the lever could never escape.
        thrRaw = -(NEUTRAL + 0.02);
      }
      lever = thrRaw;
      commitLever();
    }
  };
  const onThrEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== thrId) continue;
      thrId = null;
      caught = 0;
      thrLever.classList.remove('on');
      // It STAYS. That is what a lever is.
    }
  };

  thrEl.addEventListener('touchstart', (e) => { e.preventDefault(); onThrStart(e); }, { passive: false });
  thrEl.addEventListener('touchmove', (e) => { e.preventDefault(); onThrMove(e); }, { passive: false });
  thrEl.addEventListener('touchend', onThrEnd);
  thrEl.addEventListener('touchcancel', onThrEnd);
  // Claim the axis at build time so boatController reads the lever's zero
  // rather than latching the old stick's cruise on the first frame.
  input.setThrottleLever(0);
  paintLever();

  const stop = (e) => e.preventDefault();
  drive.addEventListener('touchstart', (e) => { stop(e); onDriveStart(e); }, { passive: false });
  drive.addEventListener('touchmove', (e) => { stop(e); onDriveMove(e); }, { passive: false });
  drive.addEventListener('touchend', onDriveEnd);
  drive.addEventListener('touchcancel', onDriveEnd);
  look.addEventListener('touchstart', (e) => { stop(e); onLookStart(e); }, { passive: false });
  look.addEventListener('touchmove', (e) => { stop(e); onLookMove(e); }, { passive: false });
  look.addEventListener('touchend', onLookEnd);
  look.addEventListener('touchcancel', onLookEnd);

  root.querySelector('.times').addEventListener('click', (e) => {
    const code = e.target?.dataset?.code;
    if (!code) return;
    onTimePreset?.(code);
  });

  return {
    root,
    dispose() {
      root.remove();
      style.remove();
    },
  };
}
