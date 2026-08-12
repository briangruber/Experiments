# Skyline

A web-swinging game for the browser and the phone. Fire a web at a building,
swing, let go at the bottom of the arc, and thread the chain of rings laid out
across the skyline before the combo timer runs out.

Built on three.js r185 with the WebGPU renderer, falling back to WebGL2. There
is no build step: serve the folder and open `index.html`.

```
cd swing
python3 -m http.server 8000     # or any static server
```

## Controls

| | desktop | touch |
| --- | --- | --- |
| fire a web | hold left / right mouse (or `Q` / `E`) | hold **WEB L** / **WEB R** |
| aim and steer | move the mouse (pointer lock) | drag anywhere |
| reel in | `W` | **DIVE** |
| dive | `Shift` | **DIVE** |
| boost / jump | `Space` | **BOOST** |
| respawn | `R` | — |
| hide HUD / mute / pause | `H` / `M` / `Esc` | — |

The camera lines itself up with your velocity after a moment of no steering, so
one thumb on a phone is enough: hold a web, let go, hold the other.

## How it plays

A web is a **one-sided distance constraint** — it only pulls when the rope is
taut, never pushes. That single detail is what makes the motion a pendulum
instead of a rigid arm, and it is why letting go at the bottom of the arc throws
you furthest.

Reeling in applies a pull toward the anchor *and* ratchets the rope length down
behind you, so a well-timed pull on the downswing converts height into speed the
way conservation of angular momentum says it should. Diving trades altitude for
speed against a lower drag coefficient (terminal velocity ~90 m/s tucked, ~55
upright). Brushing a wall at speed without hitting it scores a close call;
hitting it costs most of your momentum but never ends the run.

## Layout

```
index.html        entry point and import map
src/
  main.js         boot, renderer selection, frame loop, event wiring
  city.js         procedural skyline: merged chunk geometry + AABB grid
  player.js       swing physics and collision response
  camera.js       chase camera, auto-align, speed framing
  avatar.js       poses the rigged hero by solving bone directions
  web.js          the web strand
  rings.js        ring course, scoring, combo
  fx.js           particles, motion trail, blob shadow
  world.js        sky, light, Tripo props on the rooftops
  textures.js     every surface, painted into canvases at load
  input.js        one input state for mouse, keyboard and touch
  audio.js        synthesised wind, thwips and pickups
  hud.js          DOM HUD
tools/
  shot.mjs        headless capture + smoke test
  bundle.mjs      fold everything into one self-contained HTML file
  tripo.mjs       Tripo3D asset pipeline
assets/           generated meshes + manifest.json (prompt and task id each)
vendor/three/     three.js r185, WebGPU build
```

The city is generated once from a seed: ~1100 boxes across 676 lots, merged into
49 chunks so the renderer sees about a hundred draw calls. The same boxes are
filed into a uniform grid that the swing raycast, the camera's occlusion check
and the player's collision query all run against, so physics never touches the
render meshes.

## Renderer selection

`navigator.gpu` existing is not enough to commit to WebGPU: a browser can expose
it and still reject descriptors this version of three.js emits. Since a canvas
keeps the first context type it is given, discovering that on the real canvas
would leave nowhere to fall back to. So boot renders a textured quad on a
throwaway 8×8 canvas first, watches for anything thrown — including the async
device errors that never reach a `try`/`catch` — and only then picks a backend.
Chromium 141 fails that probe and plays on WebGL2; newer builds pass it.

Force either path with `?webgpu` or `?webgl` for testing. The current backend is
printed under the Play button.

## Assets

The hero and the rooftop props were generated with Tripo3D. Every prompt and
task id is recorded in `assets/manifest.json`.

```
TRIPO_API_KEY=... node tools/tripo.mjs gen water_tower "…" --faces 4000
TRIPO_API_KEY=... node tools/tripo.mjs gen hero "…" --faces 18000 --rig
```

`--rig` runs Tripo's rigging pass, which returns the mesh with a Mixamo-named
skeleton but no animation clips. Rather than retargeting canned clips,
`avatar.js` authors each pose as a set of *directions* — for every bone, where
its child should point in character space — and solves the rotation that gets it
there. That is independent of whatever bind pose the generator produced, and it
lets the web arm aim at the real anchor point instead of approximating it.

## Single-file build

`tools/bundle.mjs` inlines three.js, the sources, the stylesheet and every mesh
as a data URI, producing one HTML file that loads with no network access at all
— which is what embedding it under a strict CSP requires.

```
npm i esbuild
node tools/bundle.mjs --out dist/skyline.html
node tools/bundle.mjs --out dist/page.html --body    # host supplies <head>/<body>
```

About 7 MB, most of it meshes. `src/assets.js` is the seam: served from a folder
the loaders use relative paths, bundled they get the inlined data URIs, and
neither loader knows which mode it is in.

Verify a build the same way as the folder — `--page` points the harness at it:

```
node tools/shot.mjs --page dist/skyline.html --sim 45
```

## Capture and smoke test

`tools/shot.mjs` boots the game in headless Chromium, plays it by driving the
same input object the player uses, and writes a PNG. It exits non-zero on any
page or console error, so it is also the regression test.

```
node tools/shot.mjs --out shots/frame.png --wait 6000
node tools/shot.mjs --out shots/phone.png --w 390 --h 844 --touch
node tools/shot.mjs --out shots/skyline.png --freeze "700,300,700,0,80,0"
node tools/shot.mjs --out shots/hero.png --follow      # clean chase framing
```

Captures always stop the loop and draw a single settled frame before shooting:
left running, the software rasteriser starves the screenshot and it never
resolves.

Note that headless Chromium rasterises in software here, so the reported `fps`
measures SwiftShader, not the game.

### Play-testing without a GPU

Because software rasterisation manages a fraction of a frame per second, none of
the above can tell you whether the game is any *good*. `main.js` therefore
exposes `step(dt)`, which advances the whole simulation without drawing, and
`--sim` runs it at a fixed timestep driven by a bot that chases the ring course:

```
node tools/shot.mjs --sim 90            # 90 s of play in a couple of seconds
node tools/shot.mjs --sim 24 --trace    # twice-a-second position/speed/state dump
```

It reports distance, average and peak speed, time spent attached, the longest
stall, every gameplay event, and — when a run ends badly — where it ended, what
was within reach, and whether the anchor search and ring gate still work from
there. A healthy 90-second run looks roughly like:

```
km 1.8   avgKmh 72   maxKmh 251   pctAttached 71   longestStallSeconds 0.2
```

This is what found the bug that mattered: an inverted sign in the anchor fan's
pitch rotation meant every "upward" ray searched the pavement, so webs anchored
below the player and every arc bled altitude. Nothing about the rendered frames
made that obvious; the numbers made it unmissable.

The bot is a crude proportional controller and rarely threads a 9 m ring, so a
low ring count in a sim run is expected — `ringGateWorks` in the report confirms
the pickup itself still fires.
