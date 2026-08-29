// The things you can click, and where they live.
//
// This table is the rule the prototype arrived at, written down: a repaint
// holds large geometry and loses small objects, so anything the player can
// click is generated as its own sprite and placed at a coordinate we control,
// never painted into the backdrop and hoped for.
//
// The first pass proved it with a teacup. The second proved it again with a
// building: at a strength high enough to actually look painted, the tavern's
// door disappeared and its sign moved, taking three hotspots out of alignment
// at once. So the tavern is in here too. What is left in the plate — sky, sea,
// horizon, pilings, planks — is exactly the set of things nobody clicks.
//
// Each rect is the sprite's box in room space. tools/props.mjs renders the
// procedural art inside that box, repaints it, cuts its background away, and
// writes a PNG that drops back into the same box — so a regenerated prop is
// never a re-annotation.

export const PROP_RECTS = {
  tavern: [0, 96, 470, 540],
  barrel: [498, 526, 132, 152],
  crates: [792, 542, 172, 178],
  nets:   [1002, 550, 236, 164],
  cup:    [384, 426, 62, 72],
};

// Draws the procedural version of a prop into a context whose origin is the
// top-left of that prop's rect. Used by the blockout page to make the
// conditioning image, and by the game whenever a generated sprite is missing.
export function paintProp(art, ctx, name, room) {
  const [x, y] = PROP_RECTS[name];
  ctx.save();
  ctx.translate(-x, -y);
  if (name === 'tavern') art.paintTavern(ctx, room);
  else if (name === 'barrel') art.paintBarrel(ctx);
  else if (name === 'crates') art.paintCrates(ctx);
  else if (name === 'nets') art.paintNets(ctx);
  else if (name === 'cup') art.paintCup(ctx, room, false);
  ctx.restore();
}

// Generated sprites, when tools/props.mjs has produced them. Same contract as
// the plate: missing is normal, and the procedural art stands in.
export async function loadProps() {
  const inline = globalThis.window?.__ASSETS?.props;
  const out = {};
  await Promise.all(Object.keys(PROP_RECTS).map((name) => new Promise((resolve) => {
    const src = inline?.[name] ?? `./assets/props/${name}.png`;
    if (inline && !inline[name]) { resolve(); return; }
    const img = new Image();
    img.onload = () => { out[name] = img; resolve(); };
    img.onerror = () => resolve();
    img.src = src;
  })));
  return out;
}
