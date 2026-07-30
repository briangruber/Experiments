export function createInput(canvas) {
  const keys = new Set();
  const state = {
    forward: false,
    back: false,
    left: false,
    right: false,
    boost: false,
    lookDX: 0,
    lookDY: 0,
    lookYaw: 0.15,
    lookPitch: 0.22,
    zoom: 14,
    pointerLocked: false,
  };

  const sync = () => {
    state.forward = keys.has('KeyW') || keys.has('ArrowUp');
    state.back = keys.has('KeyS') || keys.has('ArrowDown');
    state.left = keys.has('KeyA') || keys.has('ArrowLeft');
    state.right = keys.has('KeyD') || keys.has('ArrowRight');
    state.boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('Space');
  };

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    sync();
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.code); sync(); });

  // Mouse look when pointer locked; drag look otherwise (mobile-friendly).
  let dragging = false;
  let lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging && !state.pointerLocked) return;
    const dx = e.movementX || (e.clientX - lastX);
    const dy = e.movementY || (e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    state.lookYaw -= dx * 0.0035;
    state.lookPitch += dy * 0.0028;
    state.lookPitch = Math.max(-0.15, Math.min(0.55, state.lookPitch));
  });
  canvas.addEventListener('wheel', (e) => {
    state.zoom = Math.max(8, Math.min(28, state.zoom + e.deltaY * 0.01));
    e.preventDefault();
  }, { passive: false });

  // Touch virtual stick (left half = drive, right half = look).
  const touches = new Map();
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, side: t.clientX < innerWidth * 0.45 ? 'drive' : 'look' });
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      const s = touches.get(t.identifier);
      if (!s) continue;
      s.x = t.clientX; s.y = t.clientY;
      if (s.side === 'drive') {
        const dx = (s.x - s.x0) / 60;
        const dy = (s.y - s.y0) / 60;
        state.forward = dy < -0.25;
        state.back = dy > 0.35;
        state.left = dx < -0.25;
        state.right = dx > 0.25;
        state.boost = Math.hypot(dx, dy) > 1.1;
      } else {
        state.lookYaw -= (s.x - s.x0) * 0.0008;
        state.lookPitch += (s.y - s.y0) * 0.0006;
        state.lookPitch = Math.max(-0.15, Math.min(0.55, state.lookPitch));
        s.x0 = s.x; s.y0 = s.y;
      }
    }
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      const s = touches.get(t.identifier);
      touches.delete(t.identifier);
      if (s?.side === 'drive') {
        state.forward = state.back = state.left = state.right = state.boost = false;
      }
    }
  });

  return state;
}
