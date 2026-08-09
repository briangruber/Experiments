# Salty Fin — module contract

Everything in `src/` is a **module** with the same shape. `main.js` builds them,
adds their `group` to the scene, and calls `update()` once a frame and
`applyEnv()` whenever the lighting state changes. Nothing reaches across
modules except through the objects described here.

Read this before touching any file. If you need something that is not in the
contract, add it here first.

---

## Conventions

- **Y up. Water plane is `y = 0`. One unit = one metre.**
- `-Z` is world north. The camera looks roughly north by default.
- The player's boat is ~4.6 m long, ~1.9 m beam. The fisher sits ~0.9 m tall.
- The village island sits west/north-west of the start point, the lighthouse
  island east. Open sea to the north.
- ES modules, no build step. Three.js is vendored: `import * as THREE from 'three'`
  (import map in `index.html`). Never add an npm dependency.
- Nothing may print to the console at load or during a normal frame.
  `tools/shot.mjs` fails the build on any console error.
- All randomness goes through `core/rng.js` with an explicit seed, so the world
  is identical between runs and screenshots are comparable.

## Module shape

```js
export function createThing(opts) {
  const group = new THREE.Group();
  // ...
  return {
    group,                    // Object3D added to the scene (or null)
    update(ctx) {},           // once per frame
    applyEnv(env) {},         // when the environment/lighting state changes
    dispose() {},             // free geometry/material/textures
  };
}
```

`applyEnv` is called on the first frame and then only when `env` actually
changes, so it is the right place for expensive per-palette work. `update` is
hot — no allocation inside it.

## Layers

Objects declare which passes they appear in via `object.layers`.

| bit | name | meaning |
| --- | --- | --- |
| 0 | `LAYER.MAIN` | the beauty pass. Almost everything. |
| 1 | `LAYER.UNDERWATER` | rendered into the refraction target: seabed, coral, sunken rock, monster, fish. |
| 2 | `LAYER.REFLECTED` | rendered into the reflection target: sky, islands, village, boat, monster above water. |
| 3 | `LAYER.WATER` | the water surface itself. Never in refraction or reflection. |

`core/layers.js` exports `LAYER` and `setLayers(object3d, ...bits)` which walks
the subtree. Use it; setting `.layers` on a parent does not affect children.

## The frame context — `ctx`

Built fresh by `main.js` each frame and passed to every `update`.

```js
ctx = {
  time,        // scene clock in seconds, monotonic, drives all animation
  dt,          // seconds since last frame, clamped to [0, 0.05]
  frame,       // integer frame counter
  scene, camera, renderer,
  env,         // see below
  quality,     // { tier:'high'|'med'|'low'|'mobile', geometry, reflections,
               //   refractionScale, shadows, pixelRatio, backend, renderScale }
               // A module that scales its own detail MUST branch on the
               // `geometry` budget (0..1), never on the tier NAME — a name
               // ladder silently gives an unlisted tier the richest branch.
  boat: {      // written by gameplay/boatController before anything else reads it
    position,  // THREE.Vector3, hull centre at the waterline
    forward,   // THREE.Vector3, unit, points out the bow
    right,     // THREE.Vector3, unit
    heading,   // radians, 0 = north (-Z), grows clockwise
    speed,     // m/s along forward, signed
    throttle,  // -1..1
    turnRate,  // rad/s
    heel, trim,// radians
  },
  water,       // the water module's API, see below
  terrain,     // the terrain module's API, see below
  audioless: true,
}
```

## The environment — `env`

Produced by `world/timeOfDay.js`. This is the single source of truth for every
colour in the game. **No module invents a colour that should come from here.**
All colours are `THREE.Color` in *linear* space unless the name ends in `Srgb`.

```js
env = {
  key,                 // nearest named preset, for debugging
  hour,                // 0..24
  dayFactor,           // 1 full day, 0 full night — cheap blend for lots of things
  nightFactor,         // 1 - dayFactor, sharpened

  // --- key lights -------------------------------------------------------
  sunDir,              // Vector3, unit, from origin toward the sun
  sunColor, sunIntensity,
  moonDir, moonColor, moonIntensity, moonPhase,   // moonPhase 0..1, 1 = full
  keyDir, keyColor, keyIntensity,                 // whichever of sun/moon dominates
  ambientSky, ambientGround, ambientIntensity,    // hemisphere light

  // --- sky --------------------------------------------------------------
  skyZenith, skyHorizon, skyMid,
  sunHalo, sunHaloSize, sunDiscColor,
  starOpacity, milkyWayOpacity,
  cloudLit, cloudShadow, cloudRim, cloudCover, cloudOpacity,

  // --- atmosphere -------------------------------------------------------
  fogColor, fogNear, fogFar, hazeStrength, horizonGlow,

  // --- water ------------------------------------------------------------
  waterShallow,        // turquoise of knee-deep water over sand
  waterMid,            // over reef
  waterDeep,           // the body colour of deep water
  waterAbsorption,     // Vector3, per-channel extinction per metre
  waterScatter,        // Vector3, in-scattered colour
  causticStrength, foamBrightness, foamTint,
  specularStrength, roughness, glitterStrength, glitterSize,
  reflectionStrength,  // how much of the reflection target survives
  sunGlitterColor,     // colour of the sun/moon path on the water

  // --- practicals -------------------------------------------------------
  windowLight,         // Color, emissive of village windows
  windowIntensity, lanternIntensity, lighthouseIntensity, beamOpacity,

  // --- grade ------------------------------------------------------------
  exposure, bloomStrength, bloomThreshold, bloomRadius,
  saturation, contrast, vignette, grainStrength,
  lift, gain,          // Color each
}
```

`timeOfDay` interpolates between keyframed presets, so any hour is valid. Named
presets: `dawn 5.6`, `morning 8`, `day 12`, `afternoon 16`,
`golden 18.4`, `sunset 19.4`, `dusk 20.3`, `night 22.5`.

## Water API

```js
water = {
  group, update, applyEnv, dispose,
  sampleHeight(x, z, time) -> y,          // must match the vertex shader
  sampleNormal(x, z, time, out) -> out,   // Vector3
  disturb(x, z, strength, radius),        // stamp into the ripple sim (wake, splashes)
  setTargets({ refraction, refractionDepth, reflection }),
  material,
}
```

`sampleHeight` is what the boat floats on and what the camera uses to stay above
the surface, so it has to agree with the GPU to within a few centimetres.
Both sides use the same Gerstner train, defined once in `water/waves.js`.

## Terrain API

```js
terrain = {
  group, update, applyEnv, dispose,
  seabedHeight(x, z) -> y,   // negative below water; the reef and sand
  landHeight(x, z) -> y,     // island surface, -Infinity where there is no land
  isLand(x, z) -> bool,
  depthAt(x, z) -> metres of water, 0 on land
}
```

`seabedHeight` is the collision and shading authority. Coral, kelp and the
village are all placed by asking it. It is called a lot — keep it cheap and
allocation-free.

## Files and owners

| path | owns |
| --- | --- |
| `src/main.js` | wiring, passes, the frame loop |
| `src/core/renderer.js` | WebGLRenderer, render targets, quality tiers |
| `src/core/post.js` | bloom, tonemap, grade, vignette |
| `src/core/rng.js` | seeded random, value/simplex noise, fbm |
| `src/core/glsl.js` | shared GLSL chunks (hash, noise, fbm, tonemap, encode) |
| `src/core/layers.js` | `LAYER`, `setLayers` |
| `src/core/input.js` | keyboard/pointer state |
| `src/world/timeOfDay.js` | `env`, the whole palette |
| `src/sky/sky.js` | sky dome shader |
| `src/sky/clouds.js` | cloud layer |
| `src/sky/celestial.js` | sun disc, moon, stars |
| `src/water/waves.js` | the Gerstner/fbm wave definition, CPU + GLSL, shared |
| `src/water/surface.js` | water mesh, LOD, the render passes it needs |
| `src/water/waterMaterial.js` | the surface shader |
| `src/water/wake.js` | boat wake ripple simulation and trail |
| `src/water/caustics.js` | caustic texture used by the seabed |
| `src/terrain/seabed.js` | sand + reef heightfield |
| `src/terrain/coral.js` | instanced coral, kelp, urchins, sunken rock |
| `src/terrain/island.js` | cliff islands, beaches, grass caps |
| `src/terrain/vegetation.js` | pines, palms, bushes, grass |
| `src/models/boat.js` | the player dinghy |
| `src/models/fisher.js` | the character |
| `src/models/village.js` | houses, the Salty Fin, signage |
| `src/models/dock.js` | piers, pilings, tyres, lamps |
| `src/models/lighthouse.js` | tower and beam |
| `src/models/props.js` | crates, barrels, buoys, moored boats, sailboat |
| `src/creatures/monster.js` | the leviathan and its underwater shadow |
| `src/creatures/wildlife.js` | fish schools, gulls |
| `src/gameplay/boatController.js` | boat physics |
| `src/gameplay/chaseCamera.js` | the camera rig |
| `src/gameplay/quest.js` | objectives, the disturbance |
| `src/hud/hud.js` + `hud.css` | compass, banner, minimap, bars |

Do not edit a file you do not own.

## Running it

```
node tools/serve.mjs                 # http://127.0.0.1:8080
node tools/shot.mjs --out shots/day.png --preset day --w 1280 --h 720
```

`shot.mjs` exits non-zero on any console error, on a blank frame, or if the
scene never reached its first frame — it is the smoke test.
