# The film unit

The rest of `telenovela/` is a real-time engine: it stages an episode out of
three.js primitives, and everything you see is drawn from scratch sixty times a
second. This directory is the other production method. Nothing here is
rendered — the pictures come out of a video model, and the work is entirely in
the part film crews call preproduction and post: deciding what the shot is,
making sure the next one matches, and cutting them together so nobody notices
the joins.

`El Testamento` is the first scene shot this way. Two shots, ten and a half
seconds, one exchange across a table.

```
node tools/refs.mjs       # draw the character sheets and the location plate
node tools/voices.mjs     # cast each character's voice into a plate
node tools/score.mjs      # compose the music bed
node tools/shoot.mjs      # shoot the scene, one shot at a time
node tools/cut.mjs        # cut it together  ->  dist/s01-testamento.mp4
```

The first two steps make the company's assets and only need running once; the
last two are per scene.

Needs `FAL_KEY` (the video), `AI_GATEWAY_API_KEY` (the reference art),
`ELEVENLABS_API_KEY` (the bed) and `ffmpeg` on the path.

## The problem this is solving

Seedance 2.5 will give you thirty seconds a pass, which sounds like plenty
until you try to cut with it. Television is made of three-second shots. A scene
is six or eight of them from different angles, and the whole craft is that the
audience never notices they are looking at eight separate pieces of film.

So the unit of work is not "a video". It is *coverage*: several shots of the
same fictional moment that have to agree with each other about who these people
are, what they are wearing, where they are standing, which way they are facing
and what colour the light is. Get that wrong and no amount of per-shot quality
saves you — eight beautiful shots that disagree cut together into something
that feels cheap, and the viewer will tell you it looked "weird" without being
able to say why.

**There is no seed input on this endpoint.** You cannot ask for the same roll of
the dice twice. That single fact determines the whole design here: the only
things carrying continuity from one shot to the next are the reference images
you hand over and the words you repeat verbatim. Everything below follows from
it.

## How the scene is described

`scenes/s01-testamento/scene.js` is the scene bible and the only place the show
is written down. Every tool reads from it. The rule it enforces is that
anything appearing in more than one shot is **named once and interpolated**,
never retyped:

| in the bible | what it pins down |
| --- | --- |
| `STYLE` | the medium and the register — animated feature, played straight |
| `LOOK` | lens, depth of field, the light, the grade |
| `AUDIO` | the no-music rule, and when lines have to finish |
| `CONTINUITY` | the 180-degree line, stated as a rule |
| `CAST[x].note` | one stable sentence per character, including their voice |
| `LOCATION.note` | one stable sentence for the room |

`buildPrompt(shot)` assembles those with the shot's own action, so the spine is
provably identical between shots rather than identical-looking. Hand-writing
two prompts and trusting yourself to keep them in sync is how scenes drift.

## References

Three images, drawn once and committed, because regenerating them is recasting
the part.

- **Character sheets** — one per character: front, three-quarter and profile of
  the same figure, in the costume they wear in this scene, on a plain grey
  backdrop under flat even light. Nothing atmospheric. The temptation is to
  build a lavish turnaround with expression rows and costume call-outs, but
  every reference competes with every other for influence, and a busy sheet
  spends that influence on the wrong things. Three views on grey is what
  transfers.
- **A location plate** — the set photographed *empty*, from the scene's own
  side of the line, in the scene's own light. It is the geography and the
  colour grade in one image, and it is far more reliable than describing a room
  twice in words.

- **A voice plate per character** — a few seconds of them alone, saying
  something that is in no script, filmed for the sole purpose of having their
  voice on file. See below.

Every reference gets an explicit role sentence in the prompt (`@Image1 is a
character reference sheet for…`, `@Image3 is the set…`, `@Audio1 is a voice
sample of…`) rather than being left for the model to infer.

## Voices, and why coverage cannot carry them

A character sheet cannot hold a voice. The obvious workaround is to chain the
previous shot as a video reference and let the voice come across with
everything else — and it does, but only if that character happened to be
speaking in the previous shot. That is true for exactly as long as your scene
is two shots of two people. It breaks the moment the camera cuts away from
someone, and it never worked at all for a character who enters later. Voice
continuity cannot ride on coverage.

So voices are cast the way the faces are: once, deliberately, into a committed
asset. `tools/voices.mjs` films each character alone, strips the audio to a
mono mp3, and that file is passed as `@AudioN` into every shot they speak in
from then on, whatever the shot before it contained.

Two things about how the plate is filmed:

- **480p**, because only the audio survives it. Resolution does not change how
  a voice comes out and it is less than half the price.
- **A dead room** — no rain, no thunder, no ambience, no music, explicitly and
  at length. Anything on that track rides into every scene the sample is used
  in. A voice reference recorded over rain is a rain reference.

`@AudioN` is labelled harder than any other reference, because it is the one
whose purpose the model is most likely to guess wrong: an audio file handed
over without explanation reads as *"play this"* as easily as *"sound like
this"*. The label says which, twice, and forbids treating its words as
dialogue for the shot.

Shot 1C is the experiment that justifies all of it. Doña Perpetua last spoke
two shots earlier, and the shot immediately before it — which it chains as
`@Video1` — does not contain her at all. There is nothing there for her voice
to be inherited from. If she still sounds like herself, the plate is carrying
her and voice has stopped depending on who happened to be in the last frame.

## The two levers that actually did the work

**Reference discipline.** Shot 1B does *not* include Doña Perpetua's sheet, even
though she is in the scene, because she is off-camera in that shot. Handing a
model a full-body sheet of a character while telling it not to show her is the
surest way to have her turn up in frame. Drop references that the shot does not
need.

**Chaining.** Shot 1B passes the finished 1A as `@Video1`, labelled explicitly
as *reference only* — "do not continue its camera movement, this is a cut to a
new angle". One artefact carries faces, costume, room, lighting, palette and
the characters' speaking voices at once, which is more continuity than any
still can hold. It is also cheaper: a video reference drops the model's
per-second price by roughly 40%.

## Sound, which is where scenes really fall apart

The model will happily score every shot for you, and you must not let it. A cue
invented independently per shot restarts at every cut, so the music lurches
each time the picture changes and the scene sounds broken however well the
pictures match. It is the single fastest way to make good coverage feel amateur.

So the arrangement is:

1. Every shot prompt **forbids music outright**, at length and without
   ambiguity — no score, no underscore, no ambient musical drone.
2. `generate_audio` stays **on**, because the diegetic layer is worth having:
   voices, rain on the glass, thunder, the dry sound of paper. That layer cuts
   cleanly, being continuous room tone either side of the edit.
3. One unbroken bed is written across the whole scene by `tools/score.mjs` and
   laid underneath in the edit.

It works. You can see it: run a spectrogram on a raw shot and there are no
sustained horizontal harmonic bands, only broadband room tone and blocks of
voiced speech. Run one on `dist/s01-testamento.mp4` and the bed's harmonics run
straight through the cut while the diegetic layer hard-cuts underneath.

In the mix the bed is **sidechained to the dialogue** rather than set to a fixed
low level. A fixed level either buries the voices in the loud moments or
disappears in the quiet ones; ducking keeps it present under the silences and
out of the way under the lines, which is what makes it read as scoring instead
of backing track. It is also what masks the one genuine seam in the edit — room
tone differs slightly between two independently generated shots, and the audio
cut is real. It is not fixed by fading, since a dip at the cut is more audible
than the seam. It is covered by the one element that runs through the edit
untouched.

## Gotchas found the hard way

- **No seed.** Say it again because it changes everything. A take you like
  cannot be reproduced, only re-approximated. The prompt and the sidecar in
  `shots/*.json` are the only record of how you got it.
- **Dialogue drifts to the end of the clip.** The first take of 1B put
  Rosalinda's line at 5.3–6.0s of a six-second shot and ran it into the last
  frame, which leaves nothing to cut on and risks clipping the line. Timestamped
  beats help but are not enough on their own; the spine now carries an explicit
  `TIMING` rule that all speech must finish a full second before the end, and
  the last beat is written as an instruction to hold in silence.
- **Generate long, cut short.** Shots are generated at six seconds and play at
  four or five. The model spends the first second settling, and an edit with no
  handles has nowhere to trim to.
- **`duration: auto` is not for editing.** Pin it. You are cutting to a plan.
- **Say what must *not* happen.** "No handheld shake, no whip pan, no crash
  zoom" earns its place — so does "no on-screen text, no subtitles", which
  video models otherwise like to add to anything that looks like a film.
- **The 180-degree line will not hold itself.** Two shots generated
  independently will cheerfully put the same character on opposite sides of
  frame, and the cut then reads as two different conversations. State the line
  as a rule, in every prompt, naming each character's side and eyeline.
- **Voice cannot be inherited from coverage.** See above; it is the single
  structural mistake that looks like it works on a two-shot scene.
- **The `TIMING` rule is a nudge, not a guarantee.** The voice plates ran
  speech to the final frame despite being told to finish a second early.
  Harmless for a sample that is never cut on, but do not lean on it in a shot
  whose out-point matters — check, and reshoot if it runs long.
- **The reference sheets set the style, and they can disagree.** The two sheets
  here came back at slightly different levels of realism — the ingenue cartoon,
  the matriarch nearly photoreal. It happens to suit this pairing, but it is
  luck, not control. Draw a scene's sheets in one batch and check them against
  each other before shooting anything.

## What is on disk

```
scenes/s01-testamento/scene.js   the bible: spine, cast, location, shots, prompt builder
tools/fal.mjs                    upload + queue client, no SDK
tools/refs.mjs                   draws the character sheets and the location plate
tools/voices.mjs                 casts each character's voice into a reusable plate
tools/score.mjs                  composes the one music bed
tools/shoot.mjs                  assembles the reference stack and shoots each shot
tools/cut.mjs                    trims to marks, hard cuts, lays and ducks the bed
refs/                            the committed references — sheets, plate, voices
shots/                           the takes, each with a .json sidecar of its provenance
dist/                            the bed, and the cut scene
```

`tools/shoot.mjs --dry` prints the assembled prompts and calls nothing, which is
the cheapest way to review a scene before paying for it. `--res 480p` blocks it
at roughly half price; fal's own advice is to test composition there and finish
at 720p, which is the ceiling.

## Cost

At the time of writing: 720p is about $0.47/second without video references and
about $0.28/second with them, and 480p about $0.22/second. A six-second shot is
therefore a couple of dollars, and this two-shot scene cost around $6 to shoot.
The real cost is retries, and retries are why the prompt discipline above is
worth the trouble — with no seed, every reshoot is a fresh roll, and the only
thing you control is how narrowly you have described what you want.
