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
  const layer = document.createElement('div');
  layer.id = 'touch';
  layer.innerHTML = `
    <div id="stick"><i></i></div>
    <button class="tbtn" id="t-fire">throw</button>
    <button class="tbtn" id="t-reel">winch</button>
    <button class="tbtn" id="t-cut">cut</button>`;
  document.body.appendChild(layer);

  const stick = layer.querySelector('#stick');
  const knob = stick.querySelector('i');
  let stickId = null;
  const R = 52;

  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    stick.setPointerCapture(e.pointerId);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    const s = Math.min(1, len / R) / len;
    dx *= s * R; dy *= s * R;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.stick.x = dx / R;
    input.stick.y = -dy / R;
  });
  const endStick = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    knob.style.transform = '';
    input.stick.x = 0; input.stick.y = 0;
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);

  const fire = layer.querySelector('#t-fire');
  fire.addEventListener('pointerdown', () => { input.firing = true; });
  fire.addEventListener('pointerup', () => { input.firing = false; input.fireReleased = true; });
  const reel = layer.querySelector('#t-reel');
  reel.addEventListener('pointerdown', () => { input.reeling = true; });
  reel.addEventListener('pointerup', () => { input.reeling = false; });
  layer.querySelector('#t-cut').addEventListener('pointerdown', () => input.pressed.add('KeyC'));

  // Dragging anywhere on the canvas swings the camera.
  let lookId = null, lx = 0, ly = 0;
  canvas.addEventListener('pointerdown', (e) => { lookId = e.pointerId; lx = e.clientX; ly = e.clientY; });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    input.look.x += (e.clientX - lx) * 1.6;
    input.look.y += (e.clientY - ly) * 1.6;
    lx = e.clientX; ly = e.clientY;
  });
  const endLook = () => { lookId = null; };
  canvas.addEventListener('pointerup', endLook);
  canvas.addEventListener('pointercancel', endLook);
}
