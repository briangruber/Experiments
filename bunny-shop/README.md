# Hop & Shop

A very small grocery for very demanding rabbits.

Rabbits hop in off the meadow, loiter by the shelves having a quiet crisis about
cabbage, and eventually queue at your counter. Read the order, click the crates
to bag the produce, ring the brass bell, take their money. They are not patient.
You can pet them, which helps.

![The shop, mid-morning](screenshot.png)

Every model in `assets/` — the rabbits, their walk cycles, the produce, the
fixtures — was generated with the Tripo text-to-3D API and is rebuildable from
`tools/assets.config.mjs`.

## Playing

Serve the folder and open `index.html`. There is no build step.

```
python3 -m http.server 8000     # or any static server
```

- **Click a crate** on the counter to put one of that item in the bag. Number
  keys `1`–`6` do the same.
- **Click the bell** (or press space) to ring the order up. Ringing early is
  free, but the rabbit will comment.
- **Click a rabbit** to pet it. Worth seven seconds of patience, once each.
- Bagging the wrong thing costs patience and part of the tip.
- Three rabbits leaving unhappy and the warren stops coming.

Days get busier: shorter gaps between customers, longer orders, less patience.
From day two there is a chance of a customer who is very clearly three rabbits
in a trench coat, and who orders accordingly.

## How it is put together

```
index.html            entry point and the HUD markup
src/
  config.js           shop geometry, stock list and every tuning number
  scene.js            renderer, room, lighting, prop placement
  assets.js           GLB loading, and normalising whatever the generator sent
  bunny.js            one customer: rig, clips, walking, the trench coat stack
  game.js             the rules — spawning, queueing, orders, scoring
  dialogue.js         everything the rabbits say
  ui.js / ui.css      HUD, tickets and the speech bubbles
  audio.js            synthesised sound; no audio files
vendor/three/         pinned three.js runtime, so the folder runs offline
assets/               generated models (committed) and the task ledger
tools/                asset pipeline, optimiser, capture and tests
```

Two decisions are load-bearing:

**The room is built, the contents are generated.** Walls, floor, counter run and
rug are primitives with canvas textures. Text-to-3D is very good at a cabbage
and very bad at a flat wall, and stretching a generated counter across the shop
smeared its cash register into a puddle — so the counter is joinery and the
generated one became a back counter where its detail is visible.

**The game owns position, the clips own the pose.** Tripo's baked animations
carry a little residual root travel; `bunny.js` strips horizontal motion from
the root track and keeps the vertical bounce, so walking is driven by the game
and the hop still looks like a hop.

## Rebuilding the assets

Needs `TRIPO_API_KEY`.

```
npm install
npm run assets:list      # what exists, what would be generated, and the balance
npm run assets           # generate anything missing
npm run optimize         # strip and recompress — 50MB of GLB down to 5MB
```

The pipeline keys a ledger (`assets/ledger/<name>.json`) off a hash of each
step's request, so re-running is free and editing one prompt rebuilds only that
asset. Rigging and animation are chained off the generated mesh automatically:
`text_to_model` → `animate_rig` → one `animate_retarget` per clip.

`tools/optimize.mjs` does most of the size work. Each animation export ships a
full duplicate of the rabbit — mesh, skeleton and 2K textures — when the game
only wants the clip, and animation tracks address nodes by name, so the meshes
and textures can be deleted outright. Originals are kept in `assets/raw/`
(gitignored) and the optimiser always works from those.

## Tests

```
npm test                 # 22 assertions over the actual game rules
npm run shot             # a screenshot of the shop
```

`tools/playtest.mjs` steps the simulation directly rather than waiting on
wall-clock time, so a full day of trading takes about a second and the results
are deterministic. It covers a clean sale end to end, wrong items, petting,
patience running out, the day rolling over, losing, restarting, and four
unattended minutes without the shop floor filling up.

`tools/shot.mjs` serves the folder, drives a headless browser and exits non-zero
on any page error, so it doubles as a smoke test. Useful flags:

```
node tools/shot.mjs --out shots/a.png --sim 30          # fast-forward 30s of game time
node tools/shot.mjs --out shots/b.png --cam 2.6,2.3,6.2 --look 2.8,1,1.3
node tools/shot.mjs --out shots/c.png --eval "window.__game.day = 5"
node tools/shot.mjs --out shots/d.png --play 25000      # random clicking
```

`--sim` exists because software rendering runs at a few frames a second, and the
frame loop clamps `dt`, so waiting ten real seconds advances the game by about
one. Stepping the simulation directly sidesteps that entirely.
