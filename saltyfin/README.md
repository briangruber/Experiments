# Salty Fin

A cosy tropical monster-fishing prototype: a small boat, a reef you can see
straight through, a harbour village that lights up at dusk, and something very
large moving under the water.

Built to a set of concept paintings (`ref/`). The whole point of the thing is
the look — clear turquoise water over coral, soft ripples, the sun and moon
laying a shimmering path across the bay, and the leviathan reading as a shadow
beneath the surface — so it is organised as one module per visual concern and
each can be worked on without disturbing the others.

## Running it

```
node tools/serve.mjs           # http://127.0.0.1:8080
```

No build step. Three.js is vendored in `vendor/three/`; there are no
dependencies to install.

**Controls** — `W`/`S` throttle, `A`/`D` steer, `Shift` for more of it, drag to
orbit the camera, wheel to zoom. `1` day, `2` golden hour, `3` sunset, `4`
night, `T` to run the clock, `[`/`]` to nudge it.

## Capture

```
node tools/shot.mjs --out shots/day.png --preset day --w 1280 --h 720
node tools/shots.mjs                       # the whole checkpoint set
node tools/check.mjs                       # parse every source file
```

`shot.mjs` exits non-zero on any console error, on a frame that never arrived,
or on a flat image, so it doubles as the smoke test. It accepts `--preset`,
`--t <hour>`, `--cam <name|x,y,z,tx,ty,tz>`, `--boat <x,z,heading>`,
`--quality high|med|low` and `--hud`.

## How a frame is drawn

Four passes, in `src/main.js`:

1. **Refraction** — the underwater scene (seabed, coral, the leviathan) rendered
   with the real camera and clipped to `y < 0`, into a half-resolution target
   with a depth texture.
2. **Reflection** — the above-water scene through a mirrored camera, clipped to
   `y > 0`. Mirroring flips triangle winding, so the projection's X row is
   negated to flip it back; the water samples that target with a flipped U.
3. **Beauty** — everything, into a half-float HDR target.
4. **Post** — threshold, a mip-chain bloom, filmic tonemap, grade, vignette.

## Where things live

`CONTRACT.md` is the binding description of every module's shape, the layer
assignments, the frame context and the environment state. Read it before
changing anything.

The one rule worth repeating here: **every colour comes from `env`**, the
keyframed palette in `src/world/timeOfDay.js`. Materials own their albedo;
light, sky, water, fog and the intensity of every practical light come from the
time of day. That is what lets the same bay read as ref/01, ref/02 and ref/03
without a single per-preset special case.
