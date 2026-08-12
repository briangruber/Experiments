# Tiny Worlds

A keeper, five small planets, and the light they lost.

Each world is a sphere you can run all the way around in about ten seconds.
Gravity points at the core, so "up" is wherever you happen to be standing and
the horizon curves away under your feet. Every world has gone grey. Its last
sparks are still drifting somewhere on the surface — gather them all and the
world blooms outward from the exact spot where you caught the last one: colour
sweeps across the ground in a visible wavefront, dormant trees stand up and
green over, grass springs up behind the front, the sea turns from slate to
blue, and the beacon lights. A portal opens a few paces from where you were
standing — walk into it and it takes you to the next world. There is nothing to
press.

All five planets exist in one scene from the first frame. The ones you have not
reached yet are hanging in the sky the whole time, and the flight between them
is a real trip across the same space you were looking at.

A dormant world is not a safe one. **Gloom** patrol the surface and charge when
you come near; walking into one costs a spark you had already banked, and it
lands a few paces off for you to fetch back. Come down on one from above and it
bursts. On some worlds the sky falls too: a ring of light marks the ground where
a **meteor** will land, and it closes as the rock comes down. Nothing here can
kill you — you get knocked off your feet, you lose ground, you go again. Bloom
the world and it all stops: the light drives the gloom out and the sky settles.

| world | the twist | what it throws at you |
| --- | --- | --- |
| Verdance | ordinary gravity, ordinary grip | a couple of gloom |
| Amaranth | barely any gravity — a running jump nearly leaves the world | gloom, and a falling sky |
| Glacia | almost no ground friction | fewer gloom, heavier bombardment |
| Ember | night, lit only by your lantern | thick with gloom |
| The Heart | tiny, and it blooms on arrival | nothing at all |

## Running it

No build step. Serve the folder and open it:

```
cd tiny-worlds
python3 -m http.server 8000    # or any static server
```

Then open <http://localhost:8000/>.

`WASD` run · `Space` jump · `Shift` sprint · drag to look · wheel to zoom ·
`M` mute · `H` hide the interface · `` ` `` debug panel. On touch, the left half
of the screen is a thumbstick and a tap on the right half jumps.

On touch there is no backquote, so the panel opens from the gear chip in the
bottom-right corner — deliberately on the right, since the left half of the
screen is the thumbstick. Its buttons and readouts size up for a fingertip, and
the panel scrolls if the phone is short.

The debug panel (`` ` ``, the gear chip on touch, or `?debug=1`) jumps to any world, forces a bloom,
opens a portal, drops a meteor, clears the gloom, and shows live state. It
drives the game through the same `window.tinyWorlds` handle the harness uses,
so everything it does is scriptable.

Useful query parameters: `?world=2` starts on a given world, `?skipmenu=1`
skips the title card, `?dt=0.0166` forces a fixed timestep (what the capture
harness uses so a slow software renderer still advances real game time).

## Layout

```
index.html        entry point and import map
src/
  main.js         boot, game state machine, the loop
  worlds.js       the five worlds as data — gravity, grip, palette, light
  planet.js       terrain, sea, clouds, mist, props, sparks, the bloom front
  threats.js      meteors and gloom — everything a dormant world throws
  portal.js       the way out of a world you have woken
  debug.js        the ` panel: jump to a world, force any event, watch state
  player.js       the keeper: radial gravity, sphere walking, blended animation
  camera.js       chase camera that survives running over the poles
  engine.js       renderer, post chain, the shared sun and starfield
  assets.js       GLB loading, normalisation, procedural fallbacks
  fx.js           one pooled particle system for everything
  audio.js        runtime-synthesised music and sound — no audio files
  hud.js, ui.css  all DOM
assets/           Tripo-generated models (see below)
tools/            asset pipeline and capture harness
vendor/           three.js r169 + the addons used, vendored
```

## Assets

The models were generated with the Tripo API and are committed here, so the
game has no runtime dependency on it:

```
node tools/tripo.mjs               # build anything missing in the manifest
node tools/tripo.mjs keeper        # or one job
node tools/glb-info.mjs assets/*.glb
```

`tools/tripo.mjs` holds the prompt manifest and a ledger (`assets/tripo*.json`)
of task ids, so a re-run resumes finished work instead of paying for it twice.
The keeper is text → mesh → rig → four retargeted clips (idle, walk, run,
jump); the props are text → mesh. Everything is loaded through `src/assets.js`,
which normalises each model to unit height sitting on y=0 and swaps in a
procedural stand-in if a file is missing — the game still runs with the
`assets/` folder emptied.

`tools/assets.html` is a turntable contact sheet of every loaded asset, which
is the fastest way to check a fresh generation came back the right way up.

## Single-file build

```
node tools/bundle.mjs --out dist/tiny-worlds.html
```

Emits one self-contained HTML file — three.js, every module, and every model
inlined — for hosting somewhere that blocks external requests entirely (an
Artifact page cannot fetch a sibling script, and cannot fetch a `data:` URL
either, so the models ride along as base64 that `src/assets.js` hands straight
to `GLTFLoader.parse`). Roughly 11 MB. Tripo returns every retargeted clip as a complete model — the
same mesh and the same three JPEGs as every other clip of that character — so
`tools/strip-anim.mjs` reduces those files to their keyframes alone during the
build, which is the difference between 7 MB of models and 11. `--skip <file>`
drops a model entirely if you need it smaller still.

Both harnesses below take `--page dist/tiny-worlds.html` to run against the
bundle instead of the source tree, which is how the build gets tested.

## Capture harness

```
node tools/shot.mjs --out shots/verdance.png --world 0 --frames 60
node tools/shot.mjs --out shots/bloom.png --world 0 --bloom --nohud
node tools/shot.mjs --out shots/flight.png --world 0 --flight
```

It serves the folder, drives the game headlessly, and exits non-zero on any JS
or WebGL error and on a frame that came out flat — so it doubles as the smoke
test. Waits are counted in rendered frames rather than milliseconds, because
under software rendering a frame can take a second or more.

`tools/playthrough.mjs` is the end-to-end test: it clicks through the title
card, walks the keeper onto every spark on a world, and checks that the world
blooms, the beacon lights, the launch is offered, and the flight lands on the
next planet.

```
node tools/playthrough.mjs            # 17 checks, non-zero exit on any failure
node tools/playthrough.mjs --world 2  # 18, including the meteor storm
```
