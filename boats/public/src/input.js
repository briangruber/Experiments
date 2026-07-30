// Keyboard, mouse-look and a touch layer. Aiming is camera-relative: the
// reticle is always screen centre, so "point the boat's camera at the monster"
// and "aim the harpoon" are the same action.

export function createInput(canvas) {
  const keys = new Set();
  const pressed = new Set();
  const input = {
    keys, pressed,
    look: { x: 0, y: 0 },   // consumed mouse delta
    wheel: 0,
    firing: false,          // held: charging the throw
    fireReleased: false,
    reeling: false,
    pointerLocked: false,
    touch: false,
    stick: { x: 0, y: 0 },
    typing: false,
    aimAssist: false,
    setDockPrompt: null,
    down: (code) => keys.has(code),
    once(code) {
      if (!pressed.has(code)) return false;
      pressed.delete(code);
      return true;
    },
    consumeLook() {
      const l = { x: input.look.x, y: input.look.y };
      input.look.x = 0; input.look.y = 0;
      return l;
    },
    consumeWheel() { const w = input.wheel; input.wheel = 0; return w; },
    consumeFire() { const f = input.fireReleased; input.fireReleased = false; return f; },
    // Called at the end of each frame: a press nobody asked about is stale by
    // the next one, and otherwise the set grows for the whole session.
    endFrame() { pressed.clear(); },
  };

  addEventListener('keydown', (e) => {
    if (input.typing) {
      if (e.code === 'Escape' || e.code === 'Enter') pressed.add(e.code);
      return;
    }
    if (e.repeat) return;
    keys.add(e.code);
    pressed.add(e.code);
    if (e.code === 'Space') {
      input.firing = true;
      e.preventDefault();
    }
    if (['Tab', 'KeyR', 'KeyC', 'KeyE'].includes(e.code)) e.preventDefault();
  });

  addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'Space' && input.firing) { input.firing = false; input.fireReleased = true; }
  });

  addEventListener('blur', () => { keys.clear(); input.firing = false; });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      if (!input.pointerLocked) { canvas.requestPointerLock?.(); return; }
      input.firing = true;
    }
    if (e.button === 2) input.reeling = true;
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0 && input.firing) { input.firing = false; input.fireReleased = true; }
    if (e.button === 2) input.reeling = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  addEventListener('mousemove', (e) => {
    if (!input.pointerLocked) return;
    input.look.x += e.movementX;
    input.look.y += e.movementY;
  });

  document.addEventListener('pointerlockchange', () => {
    input.pointerLocked = document.pointerLockElement === canvas;
  });

  canvas.addEventListener('wheel', (e) => {
    input.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  }, { passive: false });

  /* ------------------------------------------------------------ touch */

  if (matchMedia('(pointer: coarse)').matches) {
    input.touch = true;
    document.body.classList.add('touch');
    buildTouchUI(input, canvas);
  }

  return input;
}

function buildTouchUI(input, canvas) {
  // Aiming with one thumb while steering with the other is not a thing a human
  // can do, so touch play gets a lock-on instead of a crosshair.
  input.aimAssist = true;

  const layer = document.createElement('div');
  layer.id = 'touch';
  layer.innerHTML = `
    <div id="stick-zone"><div id="stick" hidden><i></i></div></div>
    <div id="touch-actions">
      <button class="tbtn throw" id="t-throw" aria-label="throw harpoon"><b>THROW</b><small>hold</small></button>
      <button class="tbtn" id="t-winch" aria-label="winch"><b>WINCH</b></button>
      <button class="tbtn small" id="t-cut" aria-label="cut rope"><b>CUT</b></button>
    </div>
    <button class="tchip" id="t-dock" hidden>⚓ Dock</button>
    <div id="touch-chips">
      <button class="tchip" id="t-crews" aria-label="crews at sea">Crews</button>
      <button class="tchip" id="t-talk" aria-label="talk">Talk</button>
    </div>`;
  document.body.appendChild(layer);

  /* ------------------------------------------------- floating left stick */

  const zone = layer.querySelector('#stick-zone');
  const stick = layer.querySelector('#stick');
  const knob = stick.querySelector('i');
  const R = 54;
  let stickId = null;

  zone.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId;
    // The stick appears under the thumb rather than making the thumb find it.
    stick.hidden = false;
    stick.style.left = `${e.clientX}px`;
    stick.style.top = `${e.clientY}px`;
    zone.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    const cx = parseFloat(stick.style.left);
    const cy = parseFloat(stick.style.top);
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const s = Math.min(1, len / R) / len;
    dx *= s * R; dy *= s * R;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // Small deadzone so resting a thumb does not creep the boat.
    input.stick.x = Math.abs(dx) < 8 ? 0 : dx / R;
    input.stick.y = Math.abs(dy) < 8 ? 0 : -dy / R;
  });
  const endStick = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    stick.hidden = true;
    knob.style.transform = '';
    input.stick.x = 0; input.stick.y = 0;
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick);

  /* ----------------------------------------------------------- actions */

  const hold = (el, down, up) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); down(); });
    const release = () => { el.classList.remove('on'); up?.(); };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  };

  hold(layer.querySelector('#t-throw'),
    () => { input.firing = true; },
    () => { if (input.firing) { input.firing = false; input.fireReleased = true; } });
  hold(layer.querySelector('#t-winch'),
    () => { input.reeling = true; },
    () => { input.reeling = false; });

  const tap = (el, code) => el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    input.pressed.add(code);
  });
  tap(layer.querySelector('#t-cut'), 'KeyC');
  tap(layer.querySelector('#t-dock'), 'KeyE');
  tap(layer.querySelector('#t-talk'), 'KeyT');
  tap(layer.querySelector('#t-crews'), 'Tab');

  input.dockButton = layer.querySelector('#t-dock');
  input.setDockPrompt = (on) => { input.dockButton.hidden = !on; };

  /* -------------------------------------------------------------- look */

  // Only the right of the screen swings the camera; the left belongs to the
  // stick, and the buttons swallow their own touches before they reach here.
  let lookId = null, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.clientX < innerWidth * 0.42) return;
    lookId = e.pointerId;
    lx = e.clientX; ly = e.clientY;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    input.look.x += (e.clientX - lx) * 1.5;
    input.look.y += (e.clientY - ly) * 1.5;
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = (e) => { if (e.pointerId === lookId) lookId = null; };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
}
