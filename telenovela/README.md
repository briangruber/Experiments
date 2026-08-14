# Corazón de Gallina

A wordless telenovela, performed by chickens, in a hacienda courtyard at
midnight. Seven scenes, five minutes, not one line of dialogue — the plot is
carried entirely by posture, timing, camera language and an organ sting.

The birds, the courtyard, the tile and stucco textures and the rain are all
generated at load; the only assets on disk are three.js and the soundtrack,
which was generated too (see *Sound*).

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
| `1`–`7` | jump to a scene |
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
| 7 | CRÉDITOS | The cast take a bow each, and then the guilty parties are named. |

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

Tempo lives on `Director.pace`, a single multiplier over scene time that speeds
the acting, the camera moves and the cue spacing together. Scenes can opt out —
the credits run at 1.0 because they are paced by the announcer, who speaks at
his own speed.

## Sound

`tools/audio.mjs` generates the whole soundtrack with ElevenLabs and writes it
to `audio/` — six looping music beds, fifteen sound effects, and a Spanish
announcer who introduces the episode, signs off on the cliffhanger, and reads
the credits. It skips anything already on disk, so re-running costs nothing.

```
ELEVENLABS_API_KEY=... node tools/audio.mjs
node tools/audio.mjs --only vo-title --force     # redo one cue
```

`src/audio.js` plays it: beds crossfade on mood changes, rain and night
ambience ride a continuous gain, and the announcer ducks the music under
himself. It presents exactly the same surface as the procedural synth in
`src/score.js`, which stands by as a fallback for when the audio can't be
fetched or decoded — opening `index.html` straight off the filesystem, say.
The director's cues never have to know which one is running.

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
  audio.js      the soundtrack player, with score.js as its fallback
  post.js       DOF, bloom, diffusion, halation, grain, letterbox
  weather.js    rain and lightning
  score.js      the synthesised orchestra
  titles.js     title cards, driven off the director's clock
audio/          the generated soundtrack
vendor/three/   three.js r185 (MIT)
tools/audio.mjs generate the soundtrack (ElevenLabs)
tools/bundle.mjs flatten everything into one HTML file
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
`nuzzle`, `spurn`, `doubleTake`, `shudder`, `sigh`, `bow`.

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
exact scene and time, and exits non-zero on any WebGL/JS error, a dark frame, or
a soundtrack that failed to decode. `--page` points it at the bundled single
file instead of the source, so both builds get the same test.

```
node tools/shot.mjs --out shots/frame.png --scene 3 --at 14.2
node tools/shot.mjs --frames 0:4,2:16.5,5:34 --out shots/x.png
node tools/shot.mjs --contact shots/contact          # one frame per beat
```

Sampling happens inside the page's own render frame — a WebGL canvas reads back
black once the compositor has swapped.

## Exporting video

The **⏺ VIDEO** button records the piece and hands you a file. Two cuts:

- **Tráiler** — 55 s at 720p, assembled from ten beats. It cuts between them,
  which is both the right length for social and exactly how the genre
  advertises itself.
- **Episodio completo** — the whole thing at 540p.

Recording is real time and composites onto a mixing canvas, because
`MediaRecorder` can only capture a canvas and the title cards are DOM — they are
redrawn in 2D each frame so they survive into the file. Audio comes off the
soundtrack's master bus as a `MediaStream` track.

The container is H.264/AAC MP4 where the browser can encode it, falling back to
VP9/Opus WebM; the interface says which you are getting. Bitrate is chosen from
the cut's length so the file lands under 14 MiB, which is what the published
page's `downloads` capability will accept — served normally, it just downloads.
While recording, frame time is left unclamped: the audio runs on the wall clock
regardless, so the world has to as well, and a slow machine gets a choppy video
rather than a desynchronised one.

## Bundling

`tools/bundle.mjs` flattens the whole prototype — sources, three.js and the
soundtrack — into one self-contained HTML file with nothing to fetch:

```
node tools/bundle.mjs --out dist/corazon-de-gallina.html
```

Every module, including the two three.js files, gets its own function scope and
is handed its imports explicitly, so the minified vendor code can't collide with
anything and neither can our own top-level names. The audio is inlined as base64
data URIs, and everything except the `<title>` is escaped to pure ASCII so the
file survives being served without an explicit charset.

## Performance

One shadow-casting directional light, one shadowed spot, four unshadowed
practicals. Rain and splashes are single draws computed in the vertex shader;
feather scales and hackles are instanced. The post chain is one half-res blur
reused for defocus and diffusion plus one sixth-res chain for bloom and
halation. If the frame rate drops below ~26 fps the renderer drops resolution
rather than dropping the performance.
