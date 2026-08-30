# The Errant Kipper — an adventure-game slice

A one-room point-and-click adventure in the shape of *The Curse of Monkey
Island*, built to answer one question: **can a generated-asset pipeline
actually produce this genre, and where does it break?**

It is playable now. Serve this folder and open `index.html`.

```
node tools/check.mjs            # plays the room to the end, headless
node tools/check.mjs --bundle   # the same, against the single-file build
node tools/bundle.mjs           # -> dist/monkey.html, self-contained

node tools/scene.mjs still      # FLUX 2 PRO -> assets/scene.png + .jpg
node tools/scene.mjs loop       # that still -> a seamless looping video
node tools/annot.mjs            # screenshot the room with the walk area on it
node tools/check-scene.mjs      # verify the video asset as a file
node tools/voices.mjs --dry     # what recording would cost
node tools/voices.mjs           # record and measure the script
```

## What is here

One room, a four-step puzzle chain, and one conversation — deliberately the
smallest thing that still exercises every system a full game needs.

Take the boat hook from the nets → knock the tin cup off the tavern wall with
it → fill the cup at the grog barrel → give it to Harbourmaster Grout, who
falls asleep → walk the pier he was blocking and board the ship.

That chain is not decoration. It is an item you cannot reach, an item that
transforms, an NPC gate, a dialogue tree, and a world change that opens new
floor — the five things every later room is made of.

| system | file | note |
| --- | --- | --- |
| walk areas, A\*, string pull | `src/engine/pathfind.js` | polygons rasterised to a mask, so a floor can be traced loosely or extracted from an image |
| actors | `src/engine/actor.js` | stand, walk, say, face — four verbs, nothing else |
| room: scale, occlusion, parallax | `src/engine/room.js` | the three annotations that make a painting a place |
| interaction sequencer | `src/engine/script.js` | generators; a puzzle step reads like its own choreography |
| puzzle dependency graph + linter | `src/engine/puzzle.js` | unwinnable states are a graph property, so they are caught at load |
| verb coin, inventory, dialogue | `src/engine/ui.js` | CMI's three-verb coin, on the same canvas as the game |
| in-game annotation editor | `src/engine/editor.js` | press `` ` `` — drag the floor, export the polygons |
| placeholder art | `src/art/paint.js` | procedural, and also the conditioning signal for generation |
| moving layers | `src/art/animate.js` | drifting clouds, sea shimmer and moon glitter, candle flicker |
| walk-cycle contact sheet | `tools/pose.mjs` | the only way to judge animation — see below |
| rig geometry assertions | `tools/check-rig.mjs` | which way the joints bend, as a check |
| prop table and mattes | `src/art/props.js` | the box each clickable object lives in |
| the backdrop | `src/art/backdrop.js` | the looping video, with two fallbacks |
| the hand it generates in | `style.json` | the style LoRA the older generators share |
| single-file bundler | `tools/bundle.mjs` | module registry + inlined assets, publishes as an artifact |
| the room itself | `src/game/dock.js` | data plus generator functions; touches no engine internals |
| the voiced script | `src/game/lines.js` | words only, with stable ids |

## What the tools turned out to be worth

The question was whether Meshy, Tripo, ElevenLabs, fal and the Vercel AI
Gateway help. Having built it:

**fal — decisive, and now for two reasons.** The first is the one below, which
has since been superseded by simply using a better model and annotating
afterwards. The second is the video loop, which nothing else on the list can
do. The original argument, kept because the reasoning still holds wherever
alignment genuinely cannot move: `tools/plate.mjs` renders the room's own procedural art
at full size and sends that image to `fal-ai/flux/dev/image-to-image`, so the
composition, horizon, light direction and — critically — the floor line come
back where they started. A text-to-image backdrop is a beautiful picture whose
floor is in the wrong place, and every one of those costs an hour of
re-annotation, per room, forever. Image-to-image does not have that problem.
This also settles provider choice: fal preserves the input's exact dimensions,
so a 1920×720 room stays 1920×720.

**The Vercel AI Gateway — real, but not for this.** Its image endpoints emit
fixed aspect ratios (1024×1024, 1536×1024). A 1920×720 room comes back
reframed, which destroys the alignment the blockout exists to protect. It is
kept in `tools/plate.mjs` behind `--provider gateway` for square-ish plates,
and it is the right tool for the LLM side — an authoring copilot, puzzle-graph
proposals, localisation. It is not the asset plane.

**ElevenLabs — yes, and the measuring matters more than the voices.** 22 lines,
50 seconds, recorded and measured in one command. The durations are what pay:
"No." is 0.70s and the line after it is 4.37s, and neither matches what the
text-length estimate guessed. Comic timing is the entire genre and it is
unjudgeable against an estimated clock. This is worth doing months before any
human actor is booked.

**Meshy and Tripo — still not used, and that is the finding.** Nothing in this
prototype is 3D, including the characters. The 3D-proxy
route exists to give a generated backdrop correct perspective and occlusion.
But for a single 2D room, the blockout that provides those things is fifty
lines of canvas code that the game already runs. Mesh generation earns its
place when a room needs a camera move, when a prop must rotate on screen, or
for character turnarounds to keep a cast on-model — not for making a flat
backdrop stand still. `telenovela/` already uses Tripo well for exactly the
case where it does pay.

## The rule this prototype exists to have found

**A repaint holds large geometry and loses small objects.** It was established
three times, each time more expensively than the last, and it is now the shape
of the whole pipeline.

The first plate included the props. The dock line, the tavern mass, the pilings
and the moon all survived; the tin cup drifted off its own hotspot, the crates
became a woodpile, and the sign — "THE BILGE" — came back reading "Jeavern".
So the props came out of the plate.

The second plate ran at a strength high enough to actually look painted rather
than vector, and at that strength the tavern's door vanished and its sign
moved. The door, the window and the sign are three hotspots. So the tavern came
out of the plate too.

What is left in the plate is now exactly the set of things nobody clicks: sky,
sea, horizon, pilings, planks. Everything else is generated one object at a
time and placed in a box we chose (`src/art/props.js`), so **a prop can be
regenerated fifty times and never cost a single re-annotation.** That is the
property that makes the pipeline scale to forty rooms rather than one.

### Cutting the props out

The obvious way to get alpha on a generated prop is a background remover. It
was tried, and it cut the tavern down to its lit window — a segmentation model
finds the salient object, and a building's salient object is the bright bit.

There is no need for a model. The blockout draws each prop on transparent, so
its own alpha *is* the silhouette the hotspots were authored against; the
repaint is composited onto flat grey only so the model has something neutral to
paint against, and the same matte is re-applied afterwards. Exact, free, and
the same insight as the plate one level down: the geometry was never lost, only
painted over.

Two caveats, both learned from the same pile of rope. An exact matte is right
for a solid object and wrong for a wispy one — the blockout drew the net as a
few thin strokes, and cutting to that exactly returned scribbled strands, so
wispy props get their matte dilated first (`DILATE` in `tools/props.mjs`). But
dilation drags in a halo of the grey backing, and the better fix was to give
the object a real silhouette in the blockout so no dilation is needed.

The same pile taught the sharper lesson. Under a style LoRA it kept coming back
as white fluff, and no amount of "dark tarred rope, not white, not pale" moved
it — because the blockout really was pale, drawn in light grey strokes. **The
placeholder is the conditioning signal**, so its values are not a cosmetic
choice: prompt words lose to what the source image actually shows. Darkening
the procedural net fixed in one line what three prompt rewrites could not.

## How the backdrop is made now

**Generate freely, then annotate what came back.** `tools/scene.mjs still` asks
FLUX 2 PRO for the room, and `tools/scene.mjs loop` feeds that still to a
first-last-frame video model as *both* the first and last frame — so the video
has to arrive back where it started and loops without a seam. Water, cloud,
lantern flame, chimney smoke and the moored ship all move, and none of it is
procedural code that had to be written and tuned per element.

This replaced an earlier route that rendered a flat blockout and asked an
image-to-image model to repaint it. That route bought a real guarantee — the
floor line could not move, so the walk polygons never needed re-authoring — and
it paid for the guarantee by handing the model a vector image to constrain
itself to. A constrained good model loses to an unconstrained better one, and
it was not close. The dependency simply runs the other way now: the art comes
first, and the boxes are traced onto what is actually there with the in-game
editor. `tools/annot.mjs` screenshots the overlay so the trace is checkable.
That is one pass of a few minutes per room, not the hours the old note assumed.

Two consequences worth knowing:

- **Only things that change state need to be sprites.** The barrel, crates,
  rope, lantern and sign are painted into the backdrop and are simply
  rectangles you can click. The tin cup is the one exception, because it has to
  disappear when taken. The old rule — nothing clickable in the plate — existed
  because *regenerating* the plate moved things underneath annotations already
  written; annotating after generating removes the reason for it.
- **The walk area does the occluding.** A prop painted into the backdrop is
  always behind the actor, so the walkable region is traced to stop in front of
  the barrel and the crates. Walking "behind" a painted prop would put the
  character on top of it.

The room is a single 16:9 screen with no camera, because that is what the video
models generate natively — which also retires the camera, the parallax and the
scrolling seams as things that can be wrong.

### Verifying something you cannot play

Headless Chromium has no H.264 decoder, so the browser check cannot tell a good
`scene.mp4` from a truncated one: it falls back to the still and reports success
either way — the exact silent fallback this project keeps rediscovering. So
`tools/check-scene.mjs` checks the video as a *file*, walking the ISO-BMFF boxes
for dimensions, duration and whether the media data is complete. It does not
prove the picture is good. It proves the asset is real, the right shape and the
right length; the picture still needs a person to look at it.

## The style LoRA

`style.json` names a LoRA and its trigger word, and both generators read it, so
the backdrop and the props come out of one hand. It is the piece that makes
room two through room forty cheap: with it, "painterly" stops being a word in a
prompt the model reinterprets every run and becomes a fixed set of weights.
Without it every generation is an independent roll — this room's tavern sign
has come back reading "Jeavern", "TÉRA", "TAVERN" and "TVL9RN" across four runs
of the same prompt.

The one shipped here is
[Flux-Super-Paint-LoRA](https://huggingface.co/strangerzonehf/Flux-Super-Paint-LoRA)
(CreativeML OpenRAIL-M, base FLUX.1-dev), hosted on Hugging Face and therefore
fetchable by fal with no credentials.

**Licence is the constraint, not quality.** The obvious candidate for this
project is Civitai's *"LucasArts Style" (1990s PC Adventure Games)* LoRA, and it
cannot be used here for two independent reasons. It is trained on SDXL, and
this pipeline runs Flux — the architectures do not share LoRAs, so it would
mean moving the repaint to `fal-ai/fast-sdxl/image-to-image`. And its creator
set `allowCommercialUse: ["RentCivit"]`, which permits generation on Civitai's
own service and does not grant `Rent` (third-party services such as fal) or
`Image` (selling the output). Underneath that, it was trained on ~80 screenshots
of copyrighted LucasArts art, and a permission flag set by an uploader is not a
licence from the rights holder.

Two Flux-native alternatives do grant `Rent`, and `style.json` carries the
first as a commented alternative:

| model | permissions | note |
| --- | --- | --- |
| [Painted World](https://civitai.com/models/242763) | Image + Rent + RentCivit | credit required; needs `CIVITAI_TOKEN` |
| [Painted Comic](https://civitai.com/models/959766) | Image + Rent + RentCivit + Sell | no credit required |

Civitai answers `401` to anonymous downloads, so fal cannot fetch one of its
URLs directly. `tools/fal.mjs` appends a free `CIVITAI_TOKEN` from the
environment when the LoRA URL is a Civitai one, which keeps the token out of
`style.json` — that file is committed.

## Making the still image move

A flat image is what most gives away a 2D scene as a picture rather than a
place, and cutting the plate back into moving layers is free for the same
reason the repaint held its composition — `SCENE` in `src/art/paint.js` still
knows where the horizon and the dock line are.

- **Clouds** drift at two depths and pass *behind* the tavern, because the
  tavern is a sprite drawn above them rather than part of the backdrop.
- **Water** redraws the sea band from the plate in strips with a swell whose
  amplitude ramps to zero at the horizon — distant water barely moves, near
  water moves most, which keeps the horizon line crisp — plus moon glitter
  flickering out of phase, which is the single cue that reads as water.
- **Lamplight** flickers on two detuned sines with a rare dip, and spills onto
  the planks.

One bug here outlived its cause. The water layer sliced the sea band out of the
plate at *room* coordinates, which worked only because the plate happened to be
exactly 1920x720. The LoRA endpoint returns 1536x576 for the same 8:3 frame, and
rows 470–596 of a 576-tall image are planks — so the shimmer painted the dock
over the sea. Anything sampling the plate now converts into the plate's own
pixel space first.

Three other bugs in this pass were all the same bug: **a gradient clipped by a
rectangle is a rectangle.** The lamp spill, and then the character's rim light,
both drew a gradient into a `fillRect` under `lighter` compositing — and since
a linear gradient clamps to its end colour outside its own range, the rect edge
became a hard band of light. The fix each time was to make the fill contain the
whole falloff, or to fill the object's own path instead.

## Why the character is vector on purpose

The figure is 165px tall in a 720px frame, which makes the head about **35px
across**. That number settles the approach. The prop pipeline was about to be
pointed at generated painted body parts, and the arithmetic says don't: at 35px
a painted head is a coloured blob, while a drawn one still has a brow, eyes and
a jaw that flaps on a syllable. Cel characters over painted backgrounds is what
the era actually did, and this is the reason.

So everything spent on the character goes into readability and motion:

- **Two-bone IK legs.** A knee, and a foot that stays planted while it is on the
  ground. A sliding foot is the loudest tell of a bad walk cycle.
- **Weight.** The pelvis drops onto the supporting leg, the chest counter-rotates
  against the hips, and the body falls and catches twice per stride. Take those
  out and you have a pair of scissors walking.
- **Cloth on a damped spring**, so the coat hem and bandana tail overshoot when
  the character stops and settle after, rather than easing to rest like a UI
  transition.
- **A line the colour of the scene's shadows** rather than black. Ink reads as a
  sticker on a painted plate; a deep blue-brown reads as drawn.
- **Colour blocks over detail** — a belt with a buckle, cuffs at the wrists, a
  collar instead of a bib. At 35px an arm the same colour as the coat behind it
  is invisible, and a pale shirt down the middle is the only thing you see.

The knee direction has now been flipped in error **twice**, once in each
direction, and neither flip was caught by anything: the game ran, the
playthrough passed, and the only symptom was a 35px figure walking like an
ostrich. Which side of the hip-to-ankle line the knee falls on is a geometric
fact, so `tools/check-rig.mjs` now asserts it — knee forward, elbow back, bones
keeping their length, and overreach clamping rather than returning NaN. It fails
on the wrong sign, which is the only property of a check that matters.

`tools/pose.mjs` renders the whole stride as a contact sheet at 1.5x with a
ground line. Animation is the one thing here that cannot be checked by
asserting on a value and cannot be judged from a single screenshot of a room
either. Every fault above was found by looking at that sheet: the knees bent
backwards like a bird's hock, the legs were too short to ever straighten so the
character floated in a permanent half-squat, and the arms dissolved into the
coat.

## What is still missing

- **Character animation.** The actors are procedural vector puppets, and after
  a rig pass they are deliberately staying that way — see below.
- **A real rig.** The puppet is good enough at 35px, but its limbs are rigid
  segments. Mesh deformation — limbs that bend rather than hinge, cloth that
  stretches — needs Spine Pro, and its canvas runtime does not support meshes,
  so the actors would have to render through an offscreen WebGL canvas blitted
  into the 2D scene during the depth sort. Deliberately not done.
- **Text.** Diffusion cannot hold lettering. "THE BILGE" has come back as
  "Jeavern" and "TÉRA"; the sign currently says TAVERN by luck. Any text a
  player must read should be drawn by the engine over the art.
- **A second room, and room transitions.** The engine has no room graph yet.
- **Music.** Nothing on the list covers it, and iMUSE-style adaptive scoring
  was a signature of the series.
- **Writing and puzzle design.** Still the whole game.

## Checks

`tools/check.mjs` plays the room to completion in headless Chromium by
clicking real pixels — through the verb coin, the inventory and the dialogue
menu — and exits non-zero on any page error. It is the regression test: a
renamed flag or a broken verb fails it immediately.

It has already earned its place. It found the verb coin clearing its own
target before the verb ran (every verb silently did nothing), and the empty
inventory strip swallowing clicks on the lowest third of the screen.

## Provenance

`assets/provenance.json` records the model, prompt and source image behind
every generated asset, and `assets/voice/manifest.json` carries a hash of the
text and voice settings each clip was recorded from — so re-running a tool
only re-spends on what actually changed.
