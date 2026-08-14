# Sea dragon — state, the open bug, and what was already tried

Hand this file to a fresh session. It is written so that reading it plus
`AGENTS.md` is enough to continue without the conversation it came from.

Branch: `claude/three-webgpu-port`. Everything below is in the three.js demo
(`demo/three-main.js` + `src/gpu/tsl/`), not the raw-GL one.

## What works

- **The animal.** `demo/dragonModel.js` (rigged GLB, quantised by
  `tools/glb.mjs`). It arrived with 60 bones and **no animation channels**, so
  the swim is authored: a travelling sine wave down the body in the vertex
  stage, amplitude ramped in from the head (`src/gpu/tsl/creature.js`).
  `prototypes/dragon-swim.html` pins that the crest marches aft and the head
  stays still.
- **The behaviour** (`demo/seadragon.js`): holds a station off your shoulder,
  bounded yaw rate, sprints to keep up, circles you when you stop, and **rises
  and closes in past `sdRushSpeed`**.
- **The mound.** `swellLift()` in `src/gpu/tsl/water-surface.js` — a capsule
  along the spine that lifts the surface *and* feeds the slope. The slope half
  is not optional: a mound wearing the flat sea's normals is invisible except
  in silhouette.
- **Follow** button / `G` — a camera mode for tuning it while it swims.
- **Settings**: its own `SEA DRAGON` group in `demo/schema.js`.
- `npm run check:dragon` covers visible / swimming / holding station, with the
  horizon row computed from the camera rather than assumed.

## The one open bug, and it explains two symptoms

**The animal has no depth buffer of its own.** It is drawn straight over the
sea with `depthTest: false`, because the sea is opaque and has already written
a nearer depth. Two things follow, and they are the same bug:

1. **You can see its teeth through its skull.** Front-face culling sorts a
   closed convex body; a head with an open jaw is not one, so the far teeth are
   front-facing, they draw, and the last triangle in index order wins.
2. **Fins cannot break the surface.** Anything above the waterline is
   discarded, because without depth it would paint over the sky.

### What was tried, and why each failed — do not repeat these

- **Clear the depth buffer before the draw.** Does not work on this renderer:
  clearing depth mid-frame restarts the render pass and takes the colour
  attachment with it. The sea came out flat grey. Measured, reverted.
- **Alpha blending to fade it with depth.** That IS the see-through. The fade
  now lives in the colour instead (mix toward the sea's own colour on the same
  Beer-Lambert law), which is what water actually does to a submerged body.

### The fix

Render it into a target that has its own depth, and composite that into the
sea. The implementation exists and is preserved at commit **`230c301`**
(`src/gpu/tsl/underwater-driver.js`, plus the sampling in
`water-surface.js`). Revert-the-revert onto it rather than rewriting.

**It has one unexplained fault, and this is the thing to debug first:** the
submerged pass renders *nothing*. Proven by isolation — with the mound
switched off, turning the whole animal on changed **130 pixels of a 256000
pixel frame**. First suspect is a silently-failed shader compile in that pass;
check the console for a program-link error and try the creature material on an
ordinary on-screen mesh to see whether it compiles at all.

Also on that branch, already correct and worth keeping:

- The composite belongs in the sea's **diffuse** term (the radiance leaving the
  water upward). Put it there and Fresnel, foam, glitter and haze all apply
  themselves — foam passing *over* the animal is what stops it reading as
  pasted on.
- Do **not** blend into the target. Blending premultiplies by alpha and the sea
  multiplies by it again. RGB is radiance, ALPHA is coverage.
- Guard the sample with `select( sane, mix( … ), diffuse )` — the guard must be
  **around the whole mix**, because `mix(a, b, 0)` is still NaN if `b` is.
  A NaN there washes the entire ocean white.

## Two process notes that cost real time here

- **A boot timeout is a boot failure until proven otherwise.** Three checks
  "timed out after 120 s" waiting for `window.abyssal` and were read as sandbox
  contention; the app was not booting at all (a duplicate `const`). Run one
  check alone before blaming the environment.
- **Isolate before tuning.** Three commits were spent tuning the brightness of
  a buffer that was empty. If a change is not doing what you expect, switch off
  everything else that touches the same pixels and confirm the thing you are
  tuning is contributing at all.
