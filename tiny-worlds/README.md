# Tiny Worlds

A procedural exploration game about going tinier, forever. Every world is a
little planet-diorama hiding two to four shimmering rifts; each rift contains
a whole world roughly a thousand times smaller. Meadows give way to dew
gardens, then cells, molecules, atoms, quantum foam — and below the Planck
length physics gives up and the biomes come back as dream-stuff. There is no
bottom.

The whole universe is one 32-bit seed. Child worlds derive their seeds from
their parent's, so the same rift always leads to the same world, and climbing
back out returns you exactly where you were. Sizes are tracked as
log10(metres), so the descent never runs out of number.

## Playing

- **Click** a shimmering rift to dive into the world inside it (or scroll up
  near one).
- **Right-click / scroll down / Esc** to climb back out.
- **Brush** the drifting sparkles to gather stardust.
- **J** field notes · **M** sound · **N** new universe · **?** help.

Discovered worlds, stardust and your deepest depth persist in localStorage.
Share a universe by sharing the URL (`?seed=…`).

## Running

Serve this folder and open `index.html` (plain script tags, no build step —
opening the file directly also works):

```
cd tiny-worlds
python3 -m http.server 8000   # then open http://localhost:8000/
```

## Layout

```
index.html      entry point, HUD and styles
src/rng.js      seeded hashing + PRNG (the universe is deterministic)
src/names.js    syllable name generator, one voice per biome mood
src/themes.js   biome table: palettes, flora, fauna, scale bands, flavor text
src/world.js    world generation, scale formatting, milestones
src/draw.js     canvas renderer: planets, features, rifts, creatures
src/audio.js    tiny WebAudio synth (optional, muted-safe)
src/game.js     world stack, dive/surface transitions, input, HUD, saves
tools/shot.mjs  headless capture + smoke test
```

## Capture / smoke test

`tools/shot.mjs` loads the game headless, optionally dives N rifts deep, and
exits non-zero on any JS error:

```
node tools/shot.mjs --out shots/frame.png --seed 1337 --dives 3
node tools/shot.mjs --out shots/mid.png --middive     # mid-transition frame
node tools/shot.mjs --out shots/up.png --dives 2 --surface
```
