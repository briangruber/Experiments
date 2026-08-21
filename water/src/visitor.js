// The thing in the dark at the back of the tank.
//
// An easter egg, so it is deliberately not in the interface and never
// announced: it comes out of the fog on its own every few minutes, crosses the
// tank, and goes back into it. Typing `fish` brings it out on demand, which is
// how anyone who suspects it can confirm it.
//
// It is a rigid mesh with no skeleton, so the swimming is faked: yaw sway is
// the tail beat, roll leans it into the turn, and a slow bob carries the whole
// body. Read together at a distance through this much fog, that is enough —
// what sells it is that it is barely visible, not that it articulates.
//
// Both backends drive this the same way; only the mesh construction differs, so
// they hand one in.

const CROSS = 22;        // seconds end to end: slow enough to be uncanny
const IDLE_MIN = 150;    // earliest it will come out on its own, seconds
const IDLE_MAX = 420;    // and the latest

export function createVisitor(THREE, mesh, tankHalf) {
  const state = {
    mesh,
    t: 0,                       // 0..1 across the tank, or -1 when away
    next: IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN),
    // each visit picks its own lane and direction, so it is never the same
    lane: 0, depth: 0, dir: 1, phase: 0, fade: 1,
  };
  mesh.visible = false;

  function begin() {
    state.t = 0;
    state.dir = Math.random() < 0.5 ? 1 : -1;
    state.lane = (Math.random() - 0.5) * 0.9 * tankHalf;
    // The camera aims up toward the waterline, so the visible band sits above
    // the tank's centre: a fish swimming at mid-depth crosses off the bottom
    // of the frame entirely.
    state.depth = (-0.06 + Math.random() * 0.30) * tankHalf;
    state.phase = Math.random() * 6.283;
    mesh.visible = true;
  }

  function update(dt, tankHalfNow) {
    const h = tankHalfNow ?? tankHalf;
    if (!mesh.visible) {
      state.next -= dt;
      if (state.next <= 0) {
        state.next = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
        begin();
      }
      return;
    }

    state.t += dt / CROSS;
    if (state.t >= 1) { mesh.visible = false; state.t = -1; return; }

    // Comes forward out of the far fog, turns at the near end and goes back
    // into it. A straight crossing on z runs through the camera, which sits
    // just outside the front glass — the fish arrived as a wall of scales
    // rather than as something glimpsed.
    const u = state.t;
    const s = Math.sin(Math.PI * u);            // 0 at both ends, 1 at the apex
    // Stays INSIDE the tank. Starting outside it was the whole reason it
    // seemed to blink into existence: beyond the glass there is no water in
    // front of it to fog it and nothing behind it but black, so it arrived as
    // a crisp lit object on an empty background.
    const z = (-0.95 + 0.85 * s) * h;
    const drift = (u - 0.5) * 0.8 * h * state.dir;
    const sway = Math.sin(u * 9.0 + state.phase);
    const x = state.lane + drift + sway * 0.13 * h;
    const y = state.depth + Math.sin(u * 5.5 + state.phase) * 0.05 * h;
    mesh.position.set(x, y, z);

    // Heading from the path's own tangent, so the turn at the apex comes out
    // as an arc rather than a snap. The tail beat is added on top of it.
    const dz = 0.85 * Math.PI * Math.cos(Math.PI * u);
    const dx = 0.8 * state.dir + Math.cos(u * 9.0 + state.phase) * 9.0 * 0.13;
    const beat = Math.cos(u * 9.0 + state.phase);
    mesh.rotation.set(
      Math.sin(u * 5.5 + state.phase) * 0.09,
      Math.atan2(dx, dz) + beat * 0.16,
      -beat * 0.14);
    // Dissolve in and out. The volume does most of the work — it is deepest
    // in the water at both ends — but the last of it has to be faded or the
    // mesh still switches off mid-swim.
    state.fade = 1 - Math.min(1, Math.min(u, 1 - u) / 0.22);
    mesh.updateMatrixWorld();
  }

  // A word rather than a single key, because every single key is already a
  // shortcut — and the word has to avoid them too. `fish` was the obvious
  // choice and the wrong one: F is fullscreen and H hides the interface, so
  // typing it summoned the fish behind a hidden interface in fullscreen.
  // s/w/i/m are all unbound (Space O R X B C P Q H F are not).
  const WORD = 'swim';
  let typed = '';
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-WORD.length);
    if (typed === WORD && !mesh.visible) begin();
  });

  return { update, begin, state };
}
