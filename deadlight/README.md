# DEADLIGHT

A first-person jump-scare game that runs in the browser on WebGPU. Sublevel
three of a decommissioned hospital: find six fuses, start the generator, reach
the lift. Something else is down here, and the mannequins are not where you
left them.

**Every mesh in the game is generated** — props, mannequins and the creature
all come out of [Tripo](https://developers.tripo3d.ai) from text prompts, and
the creature is auto-rigged and animated there too. Nothing was modelled by
hand and nothing was downloaded. The building itself (walls, floor, ceiling)
is procedural, and so is every sound.

```
node tools/serve.mjs      # then open http://localhost:8080
```

WebGPU needs a secure context, so it has to be served — opening `index.html`
off the filesystem will not work. Chrome/Edge 113+ or Safari 18+.

## Controls

| | |
| --- | --- |
| `W` `A` `S` `D` | move |
| `Shift` | run (costs breath, and it is loud) |
| `Ctrl` / `C` | crouch (quiet, slow) |
| `F` | torch |
| `E` | take / use |
| `1`–`6` | trigger a specific scare — see below |
| `M` | mute |
| `Esc` | release the mouse |

## For streamers

The parts built specifically for playing this in front of an audience:

- **Seeded runs.** The seed is in the URL and on the HUD. `LINK` on the title
  screen copies a link to that exact layout — same rooms, same fuse placement,
  same mannequins — so chat can run the seed that just went badly.
- **Heart rate.** The BPM readout is a real readout: the director tracks how
  frightened it thinks the player is, and the number and the pulse both come
  off that. It is the largest thing on the HUD because it is the thing the
  audience is watching.
- **Chaos keys.** `1`–`6` fire a named scare on demand, bypassing the
  director's cooldown — whisper, blackout, mannequin-behind, apparition,
  static, charge. Bind them to channel points, or hand them to a moderator.
- **The report card.** Every run ends on a card built to be screenshotted:
  time, fuses, scares, peak BPM, closest encounter, the seed, and a plain
  English name for the worst moment. `COPY RESULT` puts all of it plus the
  seed link on the clipboard.

## How it plays

Light is the whole economy. The torch is the only thing that makes the level
legible, and it is also the loudest thing you can do — the creature hears it
from across the level. Running is fast and loud, crouching is quiet and slow,
and the torch battery only recharges while it is off. Every fuse you collect
raises the pressure: the creature gets faster, the mannequins take longer
strides, and the director gets impatient.

The mannequins never move while you can see them. That is the entire
mechanic — you never witness the movement, only the difference between where
one was and where it is now.

Nothing is placed by hand. A **scare director** watches the run and picks its
moments, refusing to fire while you are already frightened, so the quiet
stretches are as designed as the loud ones. Roughly four scares in five cannot
hurt you.

## Generating the assets

The generated GLBs are committed, so the game runs without an API key. To
rebuild them:

```
export TRIPO_API_KEY=...
npm install
npm run assets            # generate.mjs, then optimize.mjs
```

`tools/generate.mjs` submits every prompt in `tools/assets.manifest.mjs`,
auto-rigs the creature as a biped and retargets preset animations onto it,
resuming from `assets/generation.json` if interrupted. The full set is 16
assets, about 400 credits and seven minutes wall-clock at eight jobs in
parallel.

`tools/optimize.mjs` then does the work that makes the output shippable:

- **Weight.** Raw meshes arrive as 2K PBR sets; textures are resized per role
  and re-encoded to WebP. The whole set goes from ~19 MB to 6.7 MB.
- **Clip merging.** Each retarget comes back as a complete skinned GLB
  carrying one animation. The rigs are identical, so the clips are copied onto
  a single base mesh and rewired to its bones by name — one file, every clip.
- **De-rooting.** Tripo bakes root displacement into a retargeted clip: `walk`
  translates the root 1.3 units over 2.4 seconds. That is measured (it is how
  the game picks a playback rate that stops the feet skating) and then
  flattened, and its *direction* is measured too — which is how the game knows
  which way the model faces without a hand-tuned constant. That matters more
  than it sounds: successive generations of the same prompt came out facing
  `+X` and then `−X`. See `forwardYaw` in `assets/manifest.json`.
- **Measurement.** Tripo normalises everything into a unit box, so bounds are
  written to the manifest and the game applies a wrapper transform at load
  rather than baking one into skinned geometry. Skinned meshes are measured
  from their POSITION accessors rather than the scene graph: glTF says a
  skinned mesh's node transform is ignored, and on this creature trusting it
  buried the model to the knees.

### On Tripo's auto-rigger

This is the fussiest part of the pipeline by a wide margin, and everything it
gets wrong it gets wrong *silently* — the bind pose is always immaculate, the
file always loads, the clips are always present and correctly named. You only
find out by posing the mesh. Three failures showed up building this, and all
three are worth knowing about:

**The mesh has to be riggable.** The first creature — *"elongated spindly
limbs, long clawed fingers"* — rigged into spaghetti. The rigger is fitting a
human skeleton to a silhouette it must segment into limbs, and thin separated
geometry gives it nothing to attach to. Prompt for solid connected limbs,
human proportions and mitten hands, and put the horror in the head and skin.

**The rigger is not deterministic.** The same prompt run three times produced
skeletons of 52, 62 and 78 bones. The 62-bone one animated beautifully; the
others tore or crumpled. Generating a creature is therefore a *sampling*
problem, not a one-shot one.

**Preset names are not promises.** On rig v2.5, `preset:run` retargets to a
horizontal superman dive and `preset:slash` to a mid-air backflip — with the
mesh perfectly intact, so nothing flags them. `preset:hurt` makes a far better
attack than the preset named after attacking. The shipped creature has three
clips, and `src/creature.js` resolves the rest through a fallback chain.

Three tools exist for this:

```
node tools/creature-bakeoff.mjs                 # candidate prompts, in parallel
node tools/verify-rig.mjs --all                 # pose every rig and measure it
open .../tools/inspect.html?file=../assets/creature.glb&clip=walk   # look at one
```

`verify-rig.mjs` is the one that matters. It CPU-skins a sample of vertices at
a dozen points through every clip and measures two things a size check alone
will miss:

- **spread** — how far posed vertices depart from bind bounds. Catches a torn
  rig, which explodes into the tens.
- **height** — how tall the posed mesh stands relative to bind. Catches a
  *collapsed* retarget, where the skeleton is sound but the model ends up
  folded on the floor with entirely ordinary bounds.

It exits non-zero on either, so `npm run assets` will not quietly ship a
creature that falls apart the moment it takes a step.

## Verifying it

```
node tools/shot.mjs --out shots/frame.png --play 8
```

Boots the real game in headless Chromium, waits for assets, starts a run,
drives it, fires the director's entire catalogue, and exits non-zero on any
page exception, console error, failed request or lost graphics device. Useful
flags: `--pose creature|mannequin` stages an asset in front of the camera,
`--report` captures the end-of-run card, `--scare-shot` keeps a frame
mid-scare, `--seed`.

By default it captures through three's **WebGL** backend running the identical
scene, materials and TSL post chain. That is a property of the harness, not
the game: a container with no GPU typically creates a WebGPU device on the
software adapter and then drops it, which renders as a perfectly black canvas
with no error anywhere. `--webgpu` drives the real backend where the driver
supports it. `?backend=webgl` does the same thing in a browser.

## Layout

```
index.html                  entry point
src/
  main.js                   boot, menus, frame loop
  game.js                   objectives, interaction, escalation, end of run
  level.js                  seeded rooms + corridors, collision, pathing, geometry
  world.js                  scene, dressing, torch, practical lights
  creature.js               AI state machine over the Tripo clips
  mannequins.js             the ones that move when you are not looking
  director.js               scare scheduling, heart rate, jumpscares
  player.js                 controller, and how much noise it makes
  assets.js                 GLB loading and normalisation
  materials.js              procedural concrete, tile and plaster
  audio.js                  every sound, synthesised
  post.js                   TSL post chain
  render.js                 WebGPU renderer
  hud.js                    HUD and report card
tools/
  assets.manifest.mjs       every prompt in the game
  tripo.mjs                 Tripo v3 client
  generate.mjs              prompts → assets/raw/
  optimize.mjs              assets/raw/ → assets/
  creature-bakeoff.mjs      compare candidate creature prompts
  verify-rig.mjs            pose every rig and measure it (exits non-zero)
  rigcheck.html             the CPU-skinning harness verify-rig drives
  vendor.mjs                copy three into vendor/
  serve.mjs                 static server
  shot.mjs                  headless smoke test and capture
  inspect.html              single-asset turntable
```

`vendor/` holds three r185 (`tools/vendor.mjs` refreshes it) so the prototype
runs by serving its own folder with no build step. `assets/generation.json`
records the Tripo task id behind every shipped mesh.

## Content warning

Sudden loud noise and flashing imagery, on purpose. That is the genre, but it
is worth knowing before you put headphones on.
