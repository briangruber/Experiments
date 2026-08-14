# Sea dragon — how it is rendered, and what is still open

Hand this file to a fresh session. It is written so that reading it plus
`AGENTS.md` is enough to continue without the conversation it came from.

Everything below is in the three.js demo (`demo/three-main.js` +
`src/gpu/tsl/`), not the raw-GL one.

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
- **The mound.** `swellLift()` in `src/gpu/tsl/water-surface.js` lifts the
  surface *and* feeds the slope (the slope half is not optional: a mound
  wearing the flat sea's normals is invisible except in silhouette) — and its
  spine now **curves with the same travelling sine wave the mesh swims**
  (`uSwellWaves`/`uSwellSweep`/`uSwellPhase`, fed the same source values as
  `creature.js`'s `uCreatureWaves`/`uCreatureAmp`/`uCreaturePhase`). It used to
  be a straight capsule and read as water displaced by a plank; reported
  exactly that. `node tools/check-swell-curve.mjs` is a pure CPU-algebra check
  that the mound's curve lands on the same point the mesh's own vertex stage
  does — no GPU needed, since it is two formulas that either agree or don't.
- **Spray at the waterline.** Fed into the sea's own `foamMask` from inside the
  refraction block, gated by `path` — the same reconstructed distance from the
  sea surface down to the body the extinction uses — so it traces the body's
  ACTUAL silhouette from the refraction pass's depth, not a shape guessed from
  the mound. `sdSpray` / `sdSprayDepth` in the schema; 0 turns it off.
  `node tools/run-probe.mjs prototypes/spray-breach-probe.html` isolates it by
  proximity to the surface (near/mid/far), not just by the animal's presence.
- **The refraction pass** — see below. This is what puts the animal *in* the
  water rather than on it, and it is what closed the two bugs this document
  used to be about.
- **Follow** button / `G` — a camera mode for tuning it while it swims.
- **Settings**: its own `SEA DRAGON` group in `demo/schema.js`.
- `npm run check:dragon` covers visible / swimming / holding station /
  breaching, with the horizon row computed from the camera rather than assumed.
  `node tools/run-probe.mjs prototypes/refraction-probe.html` covers the pass
  itself, off the buffer rather than off the picture.

## How it is drawn now: the refraction pass

The ocean is opaque, writes depth, and computes everything about the water
analytically — it never reads what is behind it. So a submerged mesh drawn
before the sea is hidden and one drawn after it is pasted on top. There are now
three pieces, ported from `claude/saltyfin-webgpu`, which had already solved
this on the same three.js node renderer:

| file | what it is |
| --- | --- |
| `src/gpu/tsl/refraction-driver.js` | a half-resolution RGBA half-float target **with its own float depth texture**. Cleared to transparent black and the far plane; alpha is coverage by contract. |
| `src/gpu/tsl/water-clip.js` | the waterline split, as **two uniforms** (`sign`, `height`) hung off `maskNode` — or `waterClipDiscard()` for the hand-written materials this project is mostly made of. |
| `src/gpu/tsl/water-surface.js` | the lookup: screen-space UV offset by how far the surface normal has been bent from flat, the offset sample rejected when it lands nearer than the surface, and the **depth reconstructing the water column** that drives the extinction. |

Order in the frame (`demo/three-main.js`):

1. `drawDragonUnder()` — the submerged half, into the refraction target, with
   the clip at `CLIP.BELOW`. Before anything else, because the sea reads this
   target while it shades itself.
2. the sea, which composites the lookup into its **diffuse** term — the
   radiance leaving the water upward.
3. `drawDragonOver()` — the breaching half, into the HDR frame with the clip at
   `CLIP.ABOVE`, depth-tested against the sea that just wrote depth.

Four things that are load-bearing, three of them bought with a real defect:

- **The composite belongs in the sea's diffuse term.** Put it there and
  Fresnel, foam, glitter and haze all apply themselves — foam passing *over*
  the animal is what stops it reading as pasted on.
- **Do not blend into the target.** Blending premultiplies by alpha and the sea
  multiplies by it again. RGB is radiance, ALPHA is coverage.
- **Guard the sample with `select( sane, mix( … ), diffuse )`** — the guard must
  be **around the whole mix**, because `mix(a, b, 0)` is still NaN if `b` is.
  A NaN there washes the entire ocean white.
- **The split is a uniform, not a material flag.** `clippingContextCacheKey`,
  `side`, `depthWrite`, `transparent` and blending are all components of
  `WebGPUBackend.getRenderCacheKey`, so toggling any of them per pass forces a
  synchronous pipeline creation per material per pass — measured on the
  reference implementation at ~55 pipeline creations a frame and 11 fps on a
  phone. `src/gpu/tsl/water-clip.js` has the argument in full; read it before
  touching the waterline split.

### What this replaced, and what not to try again

The animal used to be drawn once, after the sea, with `depthTest: false`. Two
symptoms followed, and they were the same bug — it had no depth buffer:

1. **You could see its teeth through its skull.** Front-face culling sorts a
   closed convex body; a head with an open jaw is not one, so the far teeth were
   front-facing, they drew, and the last triangle in index order won.
2. **Fins could not break the surface.** Anything above the waterline had to be
   discarded, because without depth it would paint over the sky.

Both are gone: it is a double-sided depth-tested mesh in both passes, and
`sdMinDepth` is now a staging choice rather than a backstop.

Do not repeat these:

- **Clearing the depth buffer before the draw.** Does not work on this
  renderer: clearing depth mid-frame restarts the render pass and takes the
  colour attachment with it. The sea came out flat grey. Measured, reverted.
- **Alpha blending to fade it with depth.** That IS the see-through.
- **Fading the body by its own depth below mean sea level** (which is what the
  first two attempts did, first in alpha and then in colour). It is the wrong
  quantity: it is only right looking straight down, and at the angle you ride
  at a body three metres under is thirty metres of water away. The fade is the
  reconstructed column now, and it lives in the sea.

## Measured

`npm run check:dragon`, Sheltered Water, 640x400, WebGL2 backend, A/B on
`sdEnabled` against a two-frame control of 0 changed pixels:

| | pixels changed | mean shift | above the horizon |
| --- | --- | --- | --- |
| the old depth-test-off draw | 25066 | 18.7 / 255 | 0 |
| the refraction pass | 24995 | 22.4 / 255 | 0 |

So it covers the same amount of sea and reads about a fifth harder, with
nothing reaching the sky.

The same check's BREACHING claim — the animal brought to the surface with the
sea's lookup and the mound both switched off, so the only thing left is the
above-water draw — reports **4432 px changed at mean 50.7 / 255**. Under the old
draw that number was zero by construction.

`node tools/run-probe.mjs prototypes/refraction-probe.html`, which measures the
buffer rather than the picture:

- the refraction target comes back with **352 of its 104x65 texels covered**
  (5.2%), mean radiance 0.0177, **0 non-finite** — against **0 covered** with
  `sdEnabled 0`. The pass that used to render nothing renders the animal.
- switching ONLY the sea's lookup moves **4700 of 64000 pixels**, mean 0.039 —
  so the ocean shader is genuinely sampling it, which is the half that used to
  fail silently.
- the same animal at 12 m instead of 3.5 m shifts the sea by **0.0168 instead of
  0.039**. Nothing but the reconstructed water column can produce that: the
  body's own colour does not know where the eye is.

## Still open

- **The waterline cuts at MEAN sea level plus a seam**, not at the displaced
  surface. `demo/three-main.js` scales the seam with `swellAmount`, and both
  half-spaces deliberately over-include, but in a big swell a fin at the
  waterline is still cut by up to the local wave height. Fixing it properly
  means evaluating the cascade displacement in the mask — four array texture
  reads and a mip chain in the vertex stage of every clipped material — and is
  out of scope until something needs it.
- **The facade does not use any of this.** `createAbyssal`'s `scene` option
  still draws the caller's meshes into the HDR frame against the sea's depth,
  so a user's submerged mesh is hidden rather than refracted. The pieces are
  exported (`setRefractionTextures`, `applyWaterClip`, `TslRefraction`); the
  wiring in `src/gpu/abyssal.js` is not written.
- **`drawDragonOver()` runs every frame**, even when the animal is entirely
  submerged and the clip discards all of it. One mesh, so it has not been worth
  a CPU-side gate — and a gate that guessed the swum body's extent wrong would
  clip fins off, which is worse than the draw.

## Two process notes that cost real time here

- **A boot timeout is a boot failure until proven otherwise.** Three checks
  "timed out after 120 s" waiting for `window.abyssal` and were read as sandbox
  contention; the app was not booting at all (a duplicate `const`). Run one
  check alone before blaming the environment.
- **Isolate before tuning.** Three commits were spent tuning the brightness of
  a buffer that was empty. If a change is not doing what you expect, switch off
  everything else that touches the same pixels and confirm the thing you are
  tuning is contributing at all. `prototypes/refraction-probe.html` exists
  because of that: it reads the target back and counts covered texels rather
  than judging the finished picture.
