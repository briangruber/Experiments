# Salty Fin Bay

A playable prototype of the cosy-harbour fishing look: take a dinghy out into a
stylised bay, find a shoal, hook a fish, fight it in, and run the catch back to
the shop on the quay.

Open `harbor/index.html` over any static server (it is ES modules, so `file://`
will not do):

```
python3 -m http.server 8000      # then visit /harbor/index.html
```

| key | |
| --- | --- |
| `W` / `S` | throttle ahead / astern |
| `A` / `D` | steer |
| `Shift` | boost |
| `Space` | cast · hook · hold to reel |
| drag | look around (recentres itself) |
| `H` | hide the interface |

The loop: drive into the ring of ripples marking a shoal, ease off the throttle,
cast, wait for the bobber to dip, hit `Space` the moment it does, then hold and
release `Space` to keep the gold window on the fish until the catch bar fills.
Eight fish fill the hold; the Salty Fin buys them when you come alongside the
quay by the ladder. Shoals run dry after a few fish and new ones appear
elsewhere in the bay.

## How it is built

No asset pipeline and nothing to download - every object is generated from
primitives in `geom.js` at load time, which is also why the look holds together:
one palette, one builder, flat-shaded facets everywhere.

```
geom.js     mesh builder - box/wedge/cyl/ball/torus/loft/field, a transform
            stack, sRGB->linear colour, flat face normals
world.js    the bay: seabed heightfield, village, quay, islands, lighthouse,
            kelp, moored boats. Bakes into two meshes (above water, below water)
boat.js     dinghy hull (a double loft with a capped gunwale), the angler, rod,
            bobber, fish and gulls; arcade boat physics that rides the swell
game.js     shoals, particles, and the cast/bite/fight/land/sell state machine
render.js   frame graph and GL resources
shaders.js  all five programs
main.js     input, chase camera, per-frame draw list, HUD glue
ui.js       DOM layer for the HUD
```

### The frame

```
shadow       one directional map (1536²) over the boat and the village
foam         wake stamps accumulate into a world-space field that decays
refraction   everything below the waterline, into its own buffer
main         sky, everything above the waterline, then the sea on top
bloom        small bright-pass blur for the glitter and the lanterns
present      tonemap, saturation, soft contrast, vignette
```

Both geometry passes write **view distance into alpha**. That is what makes the
water work: the sea shader reads the refraction buffer, subtracts its own
distance, and gets the thickness of water under every pixel - which drives the
colour ramp, how clearly the bed shows through, and where the surf line sits
around the rocks.

Two things about that buffer are load-bearing:

- The "no bed here" clear value has to stay inside half-float range. `1e6`
  stores as `Inf`, and a linear tap that mixes `Inf` against a zero weight
  returns `NaN`, which reaches the tonemap and paints the whole sea black.
- Reflections bend the surface normal back towards vertical before sampling the
  sky. A mirror-sharp cloud deck turns every ripple into a white streak; painted
  water wants a soft sheen.

The boat's wave sampling in `boat.js` and the swell in the water vertex shader
are the same three sines with the same speeds. If one is edited the other has to
follow, or the hull floats above or below its own sea.

## Capturing

```
node tools/harbor-shot.mjs --out shots/bay.png --wait 6000 \
     --pose "-18,44,3.14159" --quality 0.5
node tools/harbor-shot.mjs --out shots/run.png --hold KeyW --wait 8000
```

Exits non-zero on any JS or WebGL error, so it doubles as the smoke test.
`window.bay` exposes `setPose`, `gotoShoal`, `snapCamera`, `press` and `hold`
for scripted runs. Note that a headless box has no GPU - WebGL falls back to
SwiftShader at a few frames a second - so judge the look from these captures,
never the framerate.

## Known limits

- The bay is a single scene with no time of day, weather, or save state.
- Fish species differ only in value, size and how hard they fight.
- Collision is a list of circles, so you can nose into a corner of the quay that
  a hull would not fit.
- The adaptive resolution ladder only ever steps down, never back up.
