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
#touch .zone.drive { left: 0; width: 50%; }
#touch .zone.look  { right: 0; width: 50%; }
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
#touch .times button { appearance: none; border: 1px solid rgba(206,232,255,.24);
  background: rgba(8,20,36,.46); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  color: rgba(226,242,255,.82); border-radius: 999px; padding: 7px 12px;
  font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .12em;
  text-transform: uppercase; }
#touch .times button:active { background: rgba(122,178,232,.34); color: #fff; }
#touch .times button:focus-visible { outline: 2px solid #ff9a3c; outline-offset: 2px; }
#touch.hidden { display: none; }
@media (min-width: 900px) and (pointer: fine) { #touch { display: none; } }

/* HUD adjustments that only make sense once there is a thumb on the glass.
   These live here rather than in hud.css so the HUD module stays the single
   owner of its own layout and this file stays the single owner of touch. */
@media (pointer: coarse) {
  /* Keyboard shortcuts are noise on a phone, and the game's own time-of-day
     hint row is replaced by the buttons above. */
  #hud .sf-keys, #hud .sf-tod { display: none !important; }
  /* Lift the bars clear of the time row and shrink the minimap so the two
     bottom corners stop meeting in the middle on a narrow screen. */
  #hud .sf-bars { bottom: calc(56px + env(safe-area-inset-bottom)) !important; }
  #hud .sf-mm { width: 104px !important; height: 104px !important;
    bottom: calc(56px + env(safe-area-inset-bottom)) !important; }
  #hud .sf-quest { max-width: min(60vw, 260px) !important; }
  #hud .sf-compass { top: max(8px, env(safe-area-inset-top)) !important;
    width: min(88vw, 460px) !important; }
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
    <div class="stick"><div class="nub"></div><div class="hint">drive</div></div>
    <div class="times">
      <button data-code="Digit1">Day</button>
      <button data-code="Digit2">Golden</button>
      <button data-code="Digit3">Sunset</button>
      <button data-code="Digit4">Night</button>
      <button data-code="KeyT">Cycle</button>
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

  const setStick = (dx, dy) => {
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    const turn = Math.abs(dx) < DEAD ? 0 : Math.max(-1, Math.min(1, dx / RANGE));
    const fwd = Math.abs(dy) < DEAD ? 0 : Math.max(-1, Math.min(1, -dy / RANGE));
    input.setTouchAxes(fwd, turn);
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
