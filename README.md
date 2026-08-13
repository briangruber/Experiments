# Experiments

A collection of independent graphics and game prototypes. **One folder per
prototype, at the top level.** Nothing lives at the repository root except this
file and shared configuration.

That rule exists because the alternative was already causing damage: with one
prototype occupying the root, another branch had replaced the root `index.html`
with its own entry page, and a third had dropped its build scripts into the
shared `tools/`. Each prototype owning a folder means two of them can never
collide, and a branch can be merged without reading it first.

## Prototypes

| folder | what it is |
| --- | --- |
| `chicken-game/` | Chicken Game — a chicken coop and its outdoor run in three.js. Seven hens and a rooster run a weighted behavior AI with 56 states across two zones joined by a pop-hole door, under a day/night cycle they keep farm hours by: out all day, in at dusk, asleep on the roost at night. A hen can go broody and hatch a brood of chicks that trail after her. Reginald the rooster crows at first light, calls the hens over when he finds food, breaks up their fights and squares up to the fox. Presided over by Big Bertha, an enormous matriarch who mostly sleeps and does not fit through the door. Most nights a fox comes sniffing round the run: if the pop-hole was shut in time it leaves empty-handed, and if it wasn't it walks in and takes an egg — but shut the door too early and you lock chickens out in the dark with it. Toss seeds, drop a worm, send a hawk over, shoo the fox off. No text anywhere — thought bubbles and slapstick carry it. |
| `ocean/` | Abyssal — a real-time cinematic ocean simulator with a rideable wave runner. Multi-cascade FFT sea, volumetric clouds, GPU spray, persistent Kelvin wake. |

Other prototypes currently live on their own branches and follow the same
convention (`harbor/`, `boats/`, `cozy-fishing/`). They can be merged here as
they stabilise.

## Layout of a prototype

Each folder is self-contained — its own entry point, sources, and build and
capture tooling — so it can be opened, built and run without reference to
anything outside it:

```
<prototype>/
  index.html      entry point, opened directly or served
  src/            sources
  tools/          build, capture and measurement scripts
```

## Running one

Serve the prototype's folder and open `index.html`; there is no build step for
development. For `ocean/`, the capture and measurement harness lives in
`ocean/tools/`:

```
cd ocean
node tools/bundle.mjs --root . --out dist/abyssal.html   # single self-contained file
node tools/shot.mjs --out shots/frame.png --w 1280 --h 720
```

`tools/shot.mjs` exits non-zero on any WebGL or JS error, so it doubles as a
smoke test.

`chicken-game/` follows the same pattern with its own harness:

```
cd chicken-game
node tools/bundle.mjs --root . --out dist/chicken-game.html   # single self-contained file
node tools/shot.mjs --out shots/coop.png            # render + smoke test
node tools/shot.mjs --ff 3600 --camera "-0.9,1.25,4.6"   # fast-forward 2 min of coop time first
node tools/determinism.mjs                          # guards the multiplayer seam
```

`chicken-game/` runs a fixed-timestep simulation that is deliberately kept
independent of rendering, so the coop can later be shared between viewers.
`tools/determinism.mjs` replays one seed and one event list twice — once
stepped cleanly, once with rendering hammered at wildly varying frame rates —
and fails if the two worlds differ by a single bit. The rules that keeps
honest are written down in `chicken-game/src/net.js`; read them before adding
anything that draws from the simulation RNG.
