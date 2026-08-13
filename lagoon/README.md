# Lagoon

Stylised shallow water — three.js + WebGPU, shaded entirely in TSL.

A cove with a timber dock, a dinghy on a drifting mooring, reef heads and a sand
floor you can read the ripples on. The point of the scene is the water: clear
turquoise over sand near the shore, absorbing to blue as the shelf falls away,
with caustics on the floor, lace at the waterline, foam collars where anything
stands in it, and a wake behind the boat.

Open `index.html` from a served folder. No build step, no assets, no network:
three is vendored in `vendor/`, and every surface in the scene is generated at
startup.

```
cd lagoon
python3 -m http.server 8000     # or any static server
```

## How the water is put together

The whole look comes from one idea, and it is worth stating plainly because
every parameter in the panel is downstream of it: **shallow tropical water is
not blue, it is a filter**. You are looking at sand through a medium that eats
red within a metre and green within about six. Give a shader that filter and the
turquoise, the depth gradient and the sense of "you could wade in there" all
arrive for free — no gradient ramp, no depth-tinted colour LUT.

So the surface shader (`src/water.js`) is, in order:

1. **Displace** the grid by a five-component Gerstner train, with the amplitude
   killed by depth so the swell goes glassy at the waterline (`src/fields.js`).
2. **Build a normal** from the same train, analytically, plus drifting ripple
   noise and the wake's gradient. Each ripple octave fades out once it is finer
   than a few pixels, which is the difference between a surface that shimmers
   and one that boils.
3. **Look up what is behind the surface** — `viewportSharedTexture`, offset along
   the normal for refraction, with the offset rejected if it lands on something
   in *front* of the water.
4. **Absorb**: `exp(-sigma * path)` per channel, where `path` comes from the
   depth buffer and `sigma` is inverted from the "shallow tint" colour so the
   control is a colour an artist picks, not three coefficients.
5. **Reflect** the procedural sky, weighted by Fresnel, plus a three-lobe sun
   (tight core, broad sheet, wide sheen) and cellular glitter.
6. **Foam**: shore lace, crest, wake, and contact.

The floor (`src/scene.js`) carries the other half of the journey — light lost on
the way *down* — and the caustics, because that is where light lands.

### Things that turned out to matter more than expected

- **Caustics are a net, not a texture.** Worley cells give blobs. Folding noise
  about zero (`1 - |n|`), sharpening it hard, and then both adding *and*
  multiplying two layers gives thin filaments that flare where they cross, which
  is what the eye recognises. Sampling each colour channel at a small spatial
  *offset* gives the dispersion fringes; changing the *scale* per channel instead
  turns the floor into an oil slick.
- **Two absorption legs, not one.** The water shader only knows the path from the
  surface to the eye. Looking straight down at six metres of water, that path is
  short and the floor stays suspiciously bright unless the floor material also
  attenuates the light that reached it. `lightThroughWater()` is shared by the
  floor and every prop so they agree.
- **Underwater paint has to be picked after the filter.** A coral colour chosen
  on a swatch reads as a black stain once two metres of water have taken its red
  and a third of its brightness. The reef palette in `src/props.js` is picked to
  land where it should *after* that loss.
- **Contact foam is nearly free.** The depth buffer already knows where the
  surface is about to touch something: a short path means a piling, a hull or a
  buoy is right there. A collar of white on that test does more for "this object
  is in the water" than anything on the object itself.

## Layout

```
index.html          entry point (import map -> vendor/three)
src/
  terrain.js        height field, floor + water geometry, depth texture
  fields.js         uniforms, wave train (GPU + CPU), caustics, sky, wake
  water.js          the surface material
  scene.js          floor material, sky dome, light-through-water
  props.js          dock, boat, reef, buoys, and the one prop material
  controls.js       orbit camera
  params.js         parameter schema, presets, camera framings
  ui.js / ui.css    control panel
  main.js           boot, frame loop, boat motion, capture hook
tools/shot.mjs      headless capture + smoke test
vendor/             three.js r184 build + BloomNode (MIT, see THREE-LICENSE)
```

One rule holds the thing together: **a phenomenon is described once.**
`terrain.js` is the only place that knows how deep the water is — the floor mesh
is baked from it, the water shader reads it back as a float texture, and the
boat's buoyancy calls the same function, so the hull cannot bob out of step with
the surface it is sitting in. Likewise the wave train is one table walked by both
the shader and the CPU.

## Controls

Drag to orbit, wheel to zoom, right-drag to pan, `1`–`5` for the framings,
`H` to hide the interface. The panel has the full parameter set and five presets.

URL parameters: `?preset=Golden%20Hour`, `?view=skim`, `?q=low|medium|high`,
`?webgl=1` (force the WebGL fallback), `?post=0`, `?ui=0`.

## Capture and smoke test

```
node tools/shot.mjs --out shots/frame.png --w 1280 --h 720 --view postcard
node tools/shot.mjs --out shots/gl.png --webgl --q low     # fallback path
```

It exits non-zero on any JS or GPU error and on a flat image, so it doubles as a
smoke test. Two notes about running WebGPU headless, both baked into the tool:

- Headless Chromium hands out a WebGPU device but **loses it the moment anything
  is presented to a canvas**. The page is therefore loaded with `?offscreen=1`,
  which stops it drawing to the canvas, and frames are pulled through
  `window.lagoon.capture()`, which renders into a texture and reads it back. Add
  `--onscreen` (with `--webgl`) to exercise the ordinary canvas path.
- WebGPU pads texture readback rows to 256 bytes, so a capture width that is not
  a multiple of 64 pixels comes back sheared. `--w` is rounded up.

The software adapter renders seconds per frame; read the fps number as "did it
advance", not as performance data.

## Compatibility

`WebGPURenderer` falls back to WebGL2 automatically, and the same TSL graph
compiles to both — the fallback is a supported path, not a degraded one, and
`--webgl` in the capture tool is there to keep it that way.

three is pinned at r184 rather than r185: r185 passes a `swizzle` field in its
texture-view descriptors that Chromium 141 rejects outright, which is a black
screen rather than a degraded one.
