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

A swinging game has two channels and no more: **where you want to go**, and
**when to hold on**. Everything here is one of those two.

*Where* is a single signed intent axis — `lean` — that every direction control
feeds: `A`/`D`, the mouse, a thumb drag, a slide on the swing pad. Pushing your
view toward something *is* leaning toward it, so there is no separate notion of
turning to learn. One number decides which side the next web is thrown, which
way the arc banks, and which way the body leans.

The steering itself is the pump. It thrusts in the rope's tangent plane — along
the rope would only fight the constraint — but *within* that plane it aims
between the way you are already travelling and the way you are looking. It used
to thrust purely along travel, which is a throttle and not a rudder: it made you
faster along a path you could not change.

The signal is the **angle you are off by**, not how fast you moved the mouse.
That distinction is the whole thing. An intent derived from aim rate evaporates
the moment you stop moving the mouse, so lining the camera up on a target and
holding it there produced exactly nothing — which is what "it doesn't go where
I'm looking" was. An angular error persists until you are pointed at it.

Measured, from the harness:

| | effect |
| --- | --- |
| look 60° off travel, hold, touch nothing | 60° → 7-12° after one second |
| full lean, web throw | lands ~18 m left / right of travel |
| full lean, held 0.75 s on a rope | turns 73.5° left / 68.7° right |
| held turn key, free air | 2.0 rad/s |

### One button

| | desktop | touch |
| --- | --- | --- |
| swing | hold `Space` (or any mouse button) | hold **SWING** |
| turn | `A` / `D`, or move the mouse | slide your thumb — on the button or anywhere |
| dive for speed | `Shift` | **DIVE** |
| mid-air burst | `B` | **BOOST** |

A cyan ring marks the grip your next press would take, so you can time a swing
instead of guessing at one, and a gold arrow points at the next ring whenever it
is off screen. Three lines of coaching appear on a first run and never again.

Hold to swing, let go to fly. The web picks its own side using the same scoring
the two triggers use, and the camera leans gently toward the next ring when you
are not steering, so the course comes to you. A bot given nothing but this one
button and no aiming at all covers 1.37 km a minute at 61 km/h, against 1.71 km
at 68 for the full scheme driven with active steering — about four fifths of the
performance for a twentieth of the dexterity.

### Full controls

| | desktop | touch |
| --- | --- | --- |
| swing left | hold left mouse (or `Q`) | hold **WEB L** |
| swing right | hold right mouse (or `E`) | hold **WEB R** |
| aim | move the mouse | drag anywhere |
| turn | `A` / `D` | slide on a pad |
| reel in | `W` | **DIVE** |
| dive | `Shift` | **DIVE** |
| boost / jump | `Space` | **BOOST** |

Each trigger is a side, not just a hand: the left web searches to your left and
swings you around that way, the right web to your right. The `L` and `R` pips
either side of the reticle light up when that side has something to grab, so the
mapping is visible before you commit to it.

Either scheme: `R` respawn, `H` hide HUD, `M` mute, `Esc` pause.

Releasing at the bottom of the arc — fast, just starting to rise — scores a
*good* or *perfect release*. That is the one piece of timing the swing rewards,
so it is worth points rather than left to be discovered.

`A` / `D` turn the heading outright, at 2 rad/s. They used to apply a sideways
force only, which nudges your path without ever pointing you somewhere — and
since mouse-look was gated behind a held button, and that same button fires a
web, one-button play had no way to turn at all. Aiming now needs no button.

The camera lines itself up with your velocity after a moment of no steering, so
one thumb on a phone is enough.

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
  preview.mjs     contact sheet of generated meshes
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
skeleton but no animation clips. Ask for a **T-pose**: the solver below works
from whatever bind pose it is given, but a symmetric one keeps the blends clean.

Note that three's GLTFLoader sanitises node names on import, so `mixamorig:Hips`
arrives as `mixamorigHips` — matching only the colon form finds nothing, and a
character then renders in its bind pose with no error anywhere. `avatar.js`
strips either form and warns loudly if the expected bones are missing.

`tools/preview.mjs --pose swing <name>` renders a mesh through the real pose
solver, which is how that failure was caught. Rather than retargeting canned clips,
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
