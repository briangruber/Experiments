# DEADLIGHT

A first-person jump-scare game that runs in the browser on WebGPU. Sublevel
three of a decommissioned hospital: throw three breakers in an order printed
somewhere else, find four ward tags that spell a lift code, and get out.
Three monsters are down here, and the mannequins are not where you left them.

**Every mesh in the game is generated** — props, mannequins and the creature
all come out of [Tripo](https://developers.tripo3d.ai) from text prompts, and
the creature is auto-rigged and animated there too. Nothing was modelled by
hand and nothing was downloaded. The building itself (walls, floor, ceiling)
is procedural, and so is every sound.

```
node tools/serve.mjs      # then open http://localhost:8080
```

WebGPU needs a secure context, so it has to be served — opening `index.html`
off the filesystem will not work. Chrome/Edge 113+ or Safari 18+ get WebGPU;
anything older falls back to WebGL, which runs the same scene and post chain
and says so on the menu.

## Controls

| | |
| --- | --- |
| `W` `A` `S` `D` | move |
| `Shift` | run (costs breath, and it is loud) |
| `Ctrl` / `C` | crouch (quiet, slow) |
| `F` | torch |
| `E` | take / use |
| `1`–`6` | trigger a specific scare — see below |
| `Space` | skip a cutscene |
| `M` | mute |
| `Esc` | release the mouse |

## On a phone

Landscape only — it asks you to rotate, because a first-person game in
portrait is a letterbox with a thumb over it. Left thumb anywhere on the left
of the screen summons a movement stick; the right half is the look pad; torch,
use, run and crouch are buttons under the right thumb. USE only appears when
there is something to use, so there is no dead button to fumble for while
something walks toward you. Starting a run asks for fullscreen and a landscape
lock, both of which are improvements where the browser allows them and nothing
where it does not.

Phones get their own quality tier (`src/quality.js`): a smaller shadow map, no
bloom, a lower render scale, denser fog and about half the dressing. Same
monsters, same puzzles, same scares — the tier only ever changes quantities,
because a cut-down horror game is not worth shipping. Force one with
`?quality=phone|tablet|desktop`.

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

Light is the whole economy, and every threat in the game is attached to a
control the player is already holding.

**The puzzles are information, not objects.** Nothing is carried. The breaker
order is printed on a maintenance diagram in one room and executed on three
switches in others; the lift code is four digits, one per ward tag, scattered.
So the player is always crossing the level holding something in their head,
and everything the dark does to them is now interfering with the task rather
than merely happening near it. Forgetting the code is a real failure state,
and re-walking a corridor you already survived to re-read a tag is the most
reliable fear this game produces. Guessing has teeth: a wrong breaker trips
the floor, a wrong code sounds an alarm, and both are heard everywhere.

**Three monsters, and they hunt by different senses**, so no single posture is
safe:

| | wakes on | notes |
| --- | --- | --- |
| **watcher** | your torch touching it | stands perfectly still until then. Already in the level when you start — some of the figures in the dark are furniture and some are not |
| **hunter** | sound, and torchlight at range | patrols, investigates, follows. Arrives with the first objective |
| **crawler** | sound only, blind | very fast. Joins when the power comes back, which flips every habit built up to that point |

Torch on and moving wakes watchers and draws hunters; torch off and running
feeds crawlers; torch off and crouched is safe and takes all night, which is
its own kind of pressure once something is already awake.

The mannequins never move while you can see them. That is the entire
mechanic — you never witness the movement, only the difference between where
one was and where it is now.

Nothing is placed by hand. A **scare director** watches the run and picks its
moments, refusing to fire while you are already frightened, so the quiet
stretches are as designed as the loud ones. Roughly four scares in five cannot
hurt you.

**Cutscenes** are short, skippable and run on the live frame loop rather than
as video — so a scripted shot can stage a real monster in the real level and
hand back a world that actually changed while you were watching. There are
three: the opening drift through the room you wake in, the moment the power
comes back and the corridor is fully lit for the only time in the game, and
the lift doors closing on whatever nearly got there first.

## Generating the assets

The generated GLBs are committed, so the game runs without an API key. To
rebuild them:

```
export TRIPO_API_KEY=...
npm install
npm run assets            # generate.mjs, then optimize.mjs
```

`tools/generate.mjs` submits every prompt in `tools/assets.manifest.mjs`,
auto-rigs each monster as a biped and retargets preset animations onto it,
resuming from `assets/generation.json` if interrupted. The full set is 22
assets — 16 props, 3 mannequins, 3 rigged monsters — at roughly 900 credits.

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
others tore or crumpled. Generating a monster is therefore a *sampling*
problem, not a one-shot one — which is what `tools/monster-bakeoff.mjs` is:
it generates every candidate prompt in the manifest, rigs each, gives each two
test clips, poses them all, and promotes the best. It earned its keep on the
first run, throwing out a 78-bone creature that had a flawless bind pose and
folded in half the moment it moved.

**Preset names are not promises.** On rig v2.5, `preset:run` retargets to a
horizontal superman dive and `preset:slash` to a mid-air backflip — with the
mesh perfectly intact, so nothing flags them. `preset:hurt` makes a far better
attack than the preset named after attacking. The shipped creature has three
clips, and `src/creature.js` resolves the rest through a fallback chain.

Three tools exist for this:

```
node tools/monster-bakeoff.mjs --promote        # sample, verify, pin the winners
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

The height check is applied per clip role, and that distinction was paid for:
locomotion has to stay upright, but a *reaction* clip is supposed to double the
character over. `preset:hurt` — which every monster here uses as its lunge —
ends in a deep crouch that measures 0.4 of bind height with every limb
perfectly intact. Judging both by the strict floor flagged three healthy
monsters in a row, which is the failure a checker can least afford: a test
that cries wolf gets widened until it stops catching anything.

It exits non-zero on either failure, so `npm run assets` will not quietly ship
a monster that falls apart the moment it takes a step.

## Verifying it

```
node tools/shot.mjs --out shots/frame.png --play 8
```

Boots the real game in headless Chromium, waits for assets, starts a run,
drives it, fires the director's entire catalogue, and exits non-zero on any
page exception, console error, failed request or lost graphics device. Useful
flags: `--pose creature|watcher|crawler|mannequin` stages an asset in front of
the camera, `--solve` drives both puzzles end to end, `--watcher` proves the
torch-wakes-it mechanic, `--report` captures the end-of-run card,
`--scare-shot` keeps a frame mid-scare, `--intro` captures the opening.

`--device phone|tablet|portrait` emulates a touch device — viewport, touch,
mobile user agent, quality tier — and drives the game with synthetic pointer
events rather than a keyboard, because a keyboard the device does not have
proves nothing. It is emulation, not a phone: it cannot tell you whether a
given iPhone's Safari has WebGPU, or how hot the thing gets. It does answer
everything that was actually broken — layout, controls, and whether the game
runs at all once the desktop assumptions are removed.

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
  monster.js                one state machine, three sense profiles
  puzzles.js                breaker sequence, lift code, and the read panel
  cutscene.js               scripted camera, and the three scripts
  mannequins.js             the ones that move when you are not looking
  director.js               scare scheduling, heart rate, jumpscares
  player.js                 controller, and how much noise it makes
  assets.js                 GLB loading and normalisation
  materials.js              procedural concrete, tile and plaster
  quality.js                device tier, and what the game costs on it
  touch.js                  virtual stick, look pad and thumb buttons
  audio.js                  every sound, synthesised
  post.js                   TSL post chain
  render.js                 WebGPU renderer
  hud.js                    HUD and report card
tools/
  assets.manifest.mjs       every prompt in the game
  tripo.mjs                 Tripo v3 client
  generate.mjs              prompts → assets/raw/
  optimize.mjs              assets/raw/ → assets/
  monster-bakeoff.mjs       sample candidate prompts, verify, promote winners
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
