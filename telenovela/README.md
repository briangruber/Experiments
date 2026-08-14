# Corazón de Gallina

A wordless telenovela, performed by chickens, in a hacienda courtyard at
midnight. Six scenes, four minutes, not one line of dialogue — the plot is
carried entirely by posture, timing, camera language and a synthesised organ
sting.

Everything is generated at load: the birds, the courtyard, the tile and stucco
textures, the rain, the score. The only asset on disk is three.js itself.

## Running it

Serve this folder and open `index.html`. There is no build step.

```
python3 -m http.server 8080     # then open http://localhost:8080/telenovela/
```

Press **▶ REPRODUCIR** to start (the browser needs a click before it will let
the orchestra play).

| key | |
| --- | --- |
| `space` | pause |
| `←` `→` | previous / next scene |
| `1`–`6` | jump to a scene |
| `R` | restart |
| `M` | mute |
| `H` | hide the interface |

## The episode

| # | scene | what happens |
| --- | --- | --- |
| 1 | PRELUDIO | Rosalinda alone at the fountain. Something at the gate. |
| 2 | EL ENCUENTRO | Esteban arrives. The almost-kiss. A rack focus finds Valentina behind the palm. |
| 3 | LA REVELACIÓN | The cloth comes off the egg. Three reactions, each closer. Thunder; Don Gallo in the archway. |
| 4 | LA BOFETADA | The slap, in slow motion, held on a frozen frame. |
| 5 | EL GEMELO MALVADO | Esteban has a twin. A dolly zoom while Rosalinda works it out. |
| 6 | CONTINUARÁ | The faint, the catch, the laughing villains — and the egg hatches. |

## The tropes, and where they live

The genre vocabulary is implemented, not illustrated. Each of these is a real
mechanism in the code rather than a hand-animated moment:

- **The crash zoom** — `move: { type: 'snapZoom' }` in `camera.js` steps the
  distance in three hard jumps rather than gliding.
- **The dolly zoom** — `dollyZoom` pulls the camera back while lengthening the
  lens, so the subject holds size and the courtyard folds up behind her.
- **The whip pan** — `whip: true` collapses the camera springs to almost
  nothing and hands the post pass a directional smear.
- **The rack focus reveal** — `cam.rackFocus(valentina)` walks the focus plane
  off the lovers and onto the villainess, using the depth buffer.
- **The slap** — plays at 0.3× speed, then `dir.freeze(0.42)` holds a single
  frame while the grain comes up.
- **Shot / reverse shot, over-the-shoulder, dutch angles, low-angle
  entrances** — all shot parameters, not bespoke camera paths.
- **The diffusion filter** — the soft glow that makes everyone look forgiven,
  cranked up for the romance and pulled back for the storm.

## How it is put together

```
index.html
src/
  main.js       bootstrap, loop, controls, capture hooks
  chicken.js    the rig — one procedural bird, built from primitives
  acting.js     Actor: emotion, gesture library, look-at, walking, leg IK
  cast.js       the six characters and their wardrobe
  sets.js       the courtyard, generated textures, lighting
  camera.js     the cinematographer — shot sizes, lenses, moves, focus
  director.js   the screenplay: a cue list per scene
  post.js       DOF, bloom, diffusion, halation, grain, letterbox
  weather.js    rain and lightning
  score.js      the synthesised orchestra
  titles.js     title cards, driven off the director's clock
vendor/three/   three.js r185 (MIT)
tools/shot.mjs  headless capture and smoke test
```

The layering is the point. `director.js` never touches a transform: it asks
for a shot in film terms and gives actors direction in verbs.

```js
[13.9, (c, d) => {
  esteban.gesture('slapped');
  c.score.slap();
  c.cam.shake(1.4, 2.6);
  d.freeze(0.42);
}],
```

### The rig

One `makeChicken(spec)` builds every bird; the characters differ only in
colour, size, wardrobe and a rooster flag. Posing goes through a flat channel
dictionary (`bodyPitch`, `neckExtend`, `lid`, `wingLLift`, `tailFan`, …) which
is composed each frame as **idle → emotion → look-at → gesture**, all additive.
Feet are solved with two-bone IK against world-space plants, so a walking bird
keeps its feet on the ground through turns; the head does the chicken
stabilisation hold, staying put in world space and then darting forward.

Secondary motion is sprung: comb and wattles lag the skull, the tail lags the
body. It is most of what sells a head turn.

### Acting

Emotions are continuous (`anger`, `sorrow`, `love`, `fear`, `pride`, `shock`)
and drive the whole body — brows, lids, hackles, tail carriage, stance.
Gestures layer on top with their own envelopes: `gasp`, `slap`, `slapped`,
`swoon`, `faint`, `catcher`, `laugh`, `sob`, `accuse`, `scheme`, `crow`,
`nuzzle`, `spurn`, `doubleTake`, `shudder`, `sigh`.

### Cinematography

Shot sizes are framed off the subject: wides off the body, anything from a
medium close-up in off the *head*, so the chick doesn't get an unusable macro
shot. Two house rules worth knowing about:

- Close-ups orient off where the character's face is pointing, not their body.
  An actor looking over her shoulder would otherwise be shot from behind the
  skull.
- A chicken's eyes are on the sides of its head, so a frontal close-up shows
  two eyes and no beak. Tight shots get nudged onto a three-quarter unless the
  shot passes `strictAngle`.

The camera is also fenced inside the courtyard walls. When a requested position
lands outside, it swings round to the nearest angle that fits and keeps its
distance, rather than sliding in toward the subject and wrecking the framing.

## Capture and smoke test

`tools/shot.mjs` serves the folder, drives it in headless Chromium, seeks to an
exact scene and time, and exits non-zero on any WebGL/JS error or a dark frame.

```
node tools/shot.mjs --out shots/frame.png --scene 3 --at 14.2
node tools/shot.mjs --frames 0:4,2:16.5,5:34 --out shots/x.png
node tools/shot.mjs --contact shots/contact          # one frame per beat
```

Sampling happens inside the page's own render frame — a WebGL canvas reads back
black once the compositor has swapped.

## Performance

One shadow-casting directional light, one shadowed spot, four unshadowed
practicals. Rain and splashes are single draws computed in the vertex shader;
feather scales and hackles are instanced. The post chain is one half-res blur
reused for defocus and diffusion plus one sixth-res chain for bloom and
halation. If the frame rate drops below ~26 fps the renderer drops resolution
rather than dropping the performance.
