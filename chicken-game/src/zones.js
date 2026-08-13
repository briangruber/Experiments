// Geography, shared by the simulation and the renderer so they can never
// disagree about where a wall is.
//
// The world is two rectangles joined by one doorway. Chickens steer in
// straight lines, so a chicken may only ever target a point inside her own
// zone — anything else walks her into a wall. Crossing between zones is a
// deliberate behavior (goOutside / goInside) that aims at the doorway first.

export const WALL_Z = 5;                 // the coop's +Z wall, and the border

export const COOP = { x0: -4.35, x1: 4.35, z0: -4.35, z1: 4.35 };
export const YARD = { x0: -6.1, x1: 6.1, z0: 5.65, z1: 14.1 };

// The pop-hole. `band` is the stretch of z the doorway occupies; inside it a
// chicken is squeezed to the opening's width whichever side she came from.
export const DOOR = {
  x: -2.5,
  halfWidth: 0.62,
  top: 1.55,
  band: { z0: 4.7, z1: 5.35 },
  inside: { x: -2.5, z: 3.85 },          // staging point on the coop side
  outside: { x: -2.5, z: 6.3 },          // staging point on the yard side
};

export const zoneOf = (z) => (z > WALL_Z ? 'yard' : 'coop');
export const bounds = (zone) => (zone === 'yard' ? YARD : COOP);

// Keep a chicken inside whichever rectangle she is in, letting her through
// the doorway only when it is open and she is lined up with it. Returns true
// if she was blocked by a shut door, which is worth a squawk.
export function clampToZone(c, world) {
  const d = world.door;
  const p = c.pos;
  // Bertha does not fit through a pop-hole, which settles the question of
  // whether the matriarch ever goes outside.
  const lane = !c.big && Math.abs(p.x - DOOR.x) <= DOOR.halfWidth;
  const passable = lane && d.open;
  let blocked = false;

  if (p.z > DOOR.band.z1) {
    // Out in the yard.
    p.x = clamp(p.x, YARD.x0, YARD.x1);
    const near = passable ? DOOR.band.z0 : DOOR.band.z1 + 0.05;
    if (p.z < near && !passable) blocked = true;
    p.z = clamp(p.z, near, YARD.z1);
  } else if (p.z < DOOR.band.z0) {
    // Inside the coop.
    p.x = clamp(p.x, COOP.x0, COOP.x1);
    const far = passable ? DOOR.band.z1 : DOOR.band.z0 - 0.05;
    if (p.z > far && !passable) blocked = true;
    p.z = clamp(p.z, COOP.z0, far);
  } else {
    // Standing in the doorway itself.
    if (passable) {
      p.x = clamp(p.x, DOOR.x - DOOR.halfWidth + 0.1, DOOR.x + DOOR.halfWidth - 0.1);
    } else {
      // The door shut on her. Shove her out to the nearer side.
      p.z = p.z < WALL_Z ? DOOR.band.z0 - 0.06 : DOOR.band.z1 + 0.06;
      blocked = true;
    }
  }

  c.zone = zoneOf(p.z);
  return blocked;
}

function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
