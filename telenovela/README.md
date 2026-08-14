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
| `1`–`8` | jump to a scene |
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
to `company/library/audio/` — six looping music beds, fifteen sound effects, and a Spanish
announcer who introduces the episode, signs off on the cliffhanger, and reads
the credits. It skips anything already on disk, so re-running costs nothing.

```
ELEVENLABS_API_KEY=... node tools/audio.mjs
node tools/audio.mjs --only vo-title --force     # redo one cue
```

`engine/audio.js` plays it. There is one music bed per mood and only ever one
sounding at a time: a mood change fades the outgoing cue out over at most 1.2 s
while the incoming one rises, because two different pieces crossfading slowly is
mud. Requests are compared against the bed last *asked for* rather than the one
currently playing — a bed can be several hundred milliseconds of decoding away
from existing, and checking the wrong thing once let a second copy of the
opening theme start and loop under the entire episode with nothing tracking it.
`--csp` runs assert exactly one live bed after a deliberately racy sequence.

Rain and night ambience are separate looping layers on their own gain, and are
meant to sit under the music. The announcer ducks it under himself. Clips arrive as data URIs in the bundled build, and are decoded
in-process rather than with `fetch` — fetching a data URI is a `connect-src`
request, which a strict CSP refuses, and the published page has one. Run the
harness with `--csp` to test under that policy. It presents exactly the same surface as the procedural synth in
`engine/score.js`, which stands by as a fallback for when the audio can't be
fetched or decoded — opening `index.html` straight off the filesystem, say.
The director's cues never have to know which one is running.

## How it is put together

```
index.html
engine/           everything that could stage any episode
  main.js         bootstrap, loop, controls, capture hooks
  chicken.js      the rig — one procedural bird, built from primitives
  acting.js       Actor: emotion, gesture library, look-at, walking, leg IK
  camera.js       the cinematographer — shot sizes, lenses, moves, focus
  director.js     the cue runner and the staging helpers
  audio.js        the soundtrack player, with score.js as its fallback
  post.js         DOF, bloom, diffusion, halation, grain, letterbox
  weather.js      rain and lightning
  score.js        the synthesised orchestra
  titles.js       title card state, driven off the director's clock
  cards.js        the one card renderer — live overlay, export and offline alike
  exporter.js     the stepped WebCodecs exporter — button and CLI drive it alike
  mp4.js          the minimal MP4 muxer the exporter writes with
  record.js       the realtime MediaRecorder fallback, and file delivery
company/          the troupe and its stock
  cast/           one file per character: spec + wardrobe
  sets/           courtyard.js — the set, generated textures, lighting
  props/          set dressing, and the generated GLB props under assets/
  library/        the shared sound library: manifest, timings, audio/
episodes/e01-corazon/
  episode.js      the manifest: scene order, deps, dialogue wiring, export cuts
  scenes/         one module per scene: meta (id, length, pace, beats) + cues
  marks.js        the standing marks every scene shares
  dialogue.js     the script, with subtitles.js wiring it into cues
  voice/          the rendered dialogue clips, each with a .mp3.hash sidecar
vendor/three/     three.js r185 (MIT)
tools/pipeline.mjs  one command from script to postable file (see below)
tools/audio.mjs   generate the sound library (ElevenLabs)
tools/voices.mjs  record and measure the dialogue (ElevenLabs)
tools/bundle.mjs  flatten everything into one HTML file
tools/shot.mjs    headless capture and smoke test
```

The layering is the point. A scene never touches a transform: it asks for a
shot in film terms and gives actors direction in verbs. And nothing addresses a
scene by its position — scenes carry ids (`entrada`, `bofetada`, …), the
dialogue and the trailer reference those ids, and the tools ask the running
page for the episode's shape, so a scene can be inserted or reordered without
renumbering anything.

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

## The pipeline

```
node tools/pipeline.mjs e01-corazon [--video] [--seconds N] [--skip-slow]
```

One command from script to postable file. The steps run in order, each prints
one line, the run stops on the first failure, and a summary table lands at the
end:

| step | what it does |
| --- | --- |
| **voices** | Compares every line in the episode's `dialogue.js` against its clip's committed `.mp3.hash` sidecar — the sha-256 of the Spanish text, the voice id and the delivery settings (`tools/voice-hash.mjs`). Only a missing or stale line is re-recorded, so an unchanged script makes **no** API call; moving a cue or rewording a subtitle never re-records anything. `voices.mjs` writes the sidecar whenever it records, which keeps the check honest. |
| **measure** | Rewrites the generated timing tables (`dialogue-timing.js`, `audio-timing.js`) only if some mp3 is newer than the table built from it. The tables are committed, so on a clean tree this skips. |
| **fit** | `tools/fit-dialogue.mjs` — pushes a dialogue cue later only when the line before it is still speaking, and rewrites `dialogue.js` only when something actually moved. |
| **check** | `tools/dialogue-check.mjs`, then the full audio timeline — which drives the real page through every scene and takes minutes, so `--skip-slow` skips it for tight loops. |
| **bundle** | `dist/<episode>.html`, plus `dist/corazon-de-gallina.html` for e01 — the name the published artifact expects, so redeploys keep their URL. |
| **smoke** | `tools/shot.mjs` on the module build and then on the bundle under the published CSP, at the first declared beat of three scenes: every frame lit, `fetch()` really blocked, every one-shot decoded, exactly one music bed, the opening bed alive after pressing play. |
| **video** | Only with `--video`: `tools/render.mjs`, trailer then full episode, forwarding `--seconds`. When the only ffmpeg around is Playwright's stripped build, this step says so and skips rather than failing the run. |

### Starting episode two

Copy the shape of `episodes/e01-corazon/`: an `episode.js` manifest, `scenes/`
with one module per scene (new scene ids), `marks.js`, a new `dialogue.js`,
`subtitles.js`, `voice-manifest.js` and `audio-manifest.js`. Two things to
know while doing it:

- **Line ids must be unique across episodes** — they name the mp3s and the
  rows of the shared one-shot timing table, so give e02's lines their own
  prefix (`e02-0a`, …) rather than reusing `dlg-*`.
- **The page plays one episode at a time**: `engine/main.js` imports the
  episode and `tools/bundle.mjs`'s `MODULES` list names its modules, so point
  both at the new directory.

Then:

```
ELEVENLABS_API_KEY=... node tools/pipeline.mjs e02-whatever
```

The pipeline records the new dialogue (no sidecars yet, so every line is
"stale" exactly once), measures it, fits the cues around the real clip
lengths, checks the timeline, bundles `dist/e02-whatever.html` and smokes both
builds. From then on, re-running costs nothing until the script changes.

## Capture and smoke test

`tools/shot.mjs` serves the folder, drives it in headless Chromium, seeks to an
exact scene and time, and exits non-zero on any WebGL/JS error, a dark frame, or
a soundtrack that failed to decode. `--page` points it at the bundled single
file instead of the source, so both builds get the same test.

```
node tools/shot.mjs --out shots/frame.png --scene revelacion --at 14.2
node tools/shot.mjs --frames entrada:4,encuentro:16.5,gemelo:34 --out shots/x.png   # ids or indices
node tools/shot.mjs --contact shots/contact    # one frame per beat each scene declares
node tools/shot.mjs --page /dist/corazon-de-gallina.html --csp   # as published
```

Sampling happens inside the page's own render frame — a WebGL canvas reads back
black once the compositor has swapped.

## Exporting video

The **⏺ VIDEO** button steps the piece through an encoder and hands you a
file. Two cuts:

- **Tráiler** — 55 s at 720p, assembled from ten beats. It cuts between them,
  which is both the right length for social and exactly how the genre
  advertises itself.
- **Episodio completo** — the whole thing at 540p.

There is one stepped exporter (`engine/exporter.js`), and both the button and
the CLI drive it. Where the browser has WebCodecs H.264 — every current
Chrome, hardware-accelerated on a Mac — the world is stepped a frame at a
time through the same offline contract `tools/render.mjs` uses, each
composited frame goes to a `VideoEncoder` as a `VideoFrame` (no
`canvas.toDataURL`, which measured as 99% of frame time in the old JPEG
pipe), the soundtrack renders through an `OfflineAudioContext` and gets
AAC-encoded, and `engine/mp4.js` muxes both into an MP4 written by hand:
`ftyp`, one `mdat` of samples in arrival order, `moov` last (legal
everywhere, just not "faststart"). Stepped means deterministic: faster than
watching it on real hardware, it cannot drop a frame, and the tab can be
hidden — the export loop yields through a `MessageChannel`, which background
throttling does not touch. A progress bar counts frames and the stop button
cancels.

The fallbacks, in order. A browser with H.264 but no AAC gets a silent MP4
plus the mixed soundtrack as a WAV beside it. A browser with no usable
WebCodecs keeps the old realtime `MediaRecorder` path exactly as it was:
composites onto a mixing canvas (the WebGL frame, then the title cards, drawn
by the same `engine/cards.js` renderer as the live page), audio off the master
bus, H.264/AAC MP4 or VP9/Opus WebM as the browser allows, and the
`fixMp4Duration` header repair afterwards, since `MediaRecorder` streams and
never writes a duration (`tools/fixvideo.mjs` runs the same repair on old
files from disk). The realtime path also stays in charge on a published page
when a cut is so long that even the floor bitrate cannot land under the
16 MiB `downloads`-capability ceiling — both exporters budget their bitrate
against that ceiling (`saveCapBytes`), so the artifact never loses the
ability to save.

The muxer is unit-tested in plain node — `node tools/test-mp4.mjs` builds a
file from synthetic chunks and parses every table back out — because the
development sandbox's Chromium has no H.264 or AAC encoder at all. The
encoder loop itself (feeding, backpressure via `encodeQueueSize` and
`dequeue`, flush) is proven in that sandbox by driving it with VP8 against
real stepped frames; the avc1+aac happy path needs a run on real hardware.

## Rendering offline

`tools/render.mjs` renders the piece to a file from the command line, without
recording a screen: the world is stepped by a fixed amount per frame, and the
soundtrack is rendered separately through an `OfflineAudioContext` against the
same clock. It cannot drop a frame or drift out of sync.

```
node tools/render.mjs --cut trailer --out dist/trailer.mp4
node tools/render.mjs --cut episode --fps 30 --w 1280 --h 720
```

It asks the page first whether the in-page WebCodecs exporter can run (the
same `engine/exporter.js` the button uses). If yes, the whole encode happens
inside the browser — ffmpeg never starts — and the finished file is pulled
out over the harness in ~8 MB base64 slices, because one giant `evaluate`
return falls over. `--pipe` forces the old path; `--kbps` pins the bitrate.

Otherwise it falls back to the JPEG pipe: every frame is `toDataURL`'d to
ffmpeg's stdin, the WAV is muxed in afterwards. That needs a full ffmpeg —
`brew install ffmpeg`, or `FFMPEG=/path/to/ffmpeg`. It probes the encoders
first and says what it found: H.264 + AAC in MP4 where available, VP8 WebM
otherwise, and it stops with a clear message rather than stalling on a pipe
if the encoder it needs is missing.

Either way it carries the sound (WAV beside the file when no audio encoder
exists on the fallback path). Seeking between trailer beats suppresses
one-shots — fast-forwarding through a scene passes every cue in it, and they
would otherwise all land on the same instant as one pile of thunder — while
letting the music beds follow along.

**Verified in part.** The page half — deterministic stepping, per-frame
capture, the offline soundtrack render, the VP8-driven encoder loop, and the
JPEG fallback end to end — is tested in the sandbox and works. The WebCodecs
H.264+AAC encode itself cannot run here (headless Chromium: no H.264, no AAC)
and the ffmpeg half of the fallback has only run against Playwright's
stripped build (VP8, silent). Treat both encodes as unproven until they have
run on a real machine.

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
