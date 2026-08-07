// Keyboard + pointer state. Polled, not evented, so the sim reads a consistent
// snapshot for the whole frame.

export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();     // edge, cleared at endFrame
  const released = new Set();
  const pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, locked: false, wheel: 0 };
  let enabled = true;

  const onKeyDown = (e) => {
    if (!enabled) return;
    if (e.repeat) return;
    down.add(e.code);
    pressed.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e) => { down.delete(e.code); released.add(e.code); };
  const onBlur = () => { down.clear(); pointer.down = false; };
  const onMove = (e) => {
    if (pointer.locked) { pointer.dx += e.movementX || 0; pointer.dy += e.movementY || 0; }
    else {
      pointer.dx += e.clientX - pointer.x;
      pointer.dy += e.clientY - pointer.y;
    }
    pointer.x = e.clientX; pointer.y = e.clientY;
  };
  const onDown = () => { pointer.down = true; };
  const onUp = () => { pointer.down = false; };
  const onWheel = (e) => { pointer.wheel += Math.sign(e.deltaY); };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);
  target.addEventListener('mousemove', onMove);
  target.addEventListener('mousedown', onDown);
  target.addEventListener('mouseup', onUp);
  target.addEventListener('wheel', onWheel, { passive: true });

  const AXES = {
    forward: [['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']],
    turn: [['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']],
  };

  return {
    pointer,
    isDown: (code) => down.has(code),
    wasPressed: (code) => pressed.has(code),
    wasReleased: (code) => released.has(code),
    any: (...codes) => codes.some((c) => down.has(c)),
    /** -1..1 from a named axis. */
    axis(name) {
      const [pos, neg] = AXES[name];
      return (pos.some((c) => down.has(c)) ? 1 : 0) - (neg.some((c) => down.has(c)) ? 1 : 0);
    },
    setEnabled(v) { enabled = v; if (!v) down.clear(); },
    endFrame() { pressed.clear(); released.clear(); pointer.dx = 0; pointer.dy = 0; pointer.wheel = 0; },
    dispose() {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      target.removeEventListener('mousemove', onMove);
      target.removeEventListener('mousedown', onDown);
      target.removeEventListener('mouseup', onUp);
      target.removeEventListener('wheel', onWheel);
    },
  };
}
