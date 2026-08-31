# Character asset pack format

What to hand over so a character drops into the game without anyone touching
the engine. One PNG sprite sheet plus one JSON manifest, per character.

The engine already loads this shape (`src/art/sprite-actor.js`); a pack in this
format replaces the procedural sprite by adding one entry to `SPRITE_CAST` in
`src/game/dock.js`.

## The PNG

A uniform grid of cells, filled left to right, top to bottom.

| | |
|---|---|
| **Character height** | **48 pixels**, feet to top of the head, at native size |
| **Background** | fully transparent — real alpha, no matte, no checkerboard |
| **Edges** | hard. No anti-aliasing and no semi-transparent pixels anywhere |
| **Scale** | native. Do **not** upscale 2x/4x before sending |
| **Facing** | right. The engine mirrors for left |
| **Outline** | a 1px dark outline all the way round each figure |

Two rules matter more than the rest, because breaking either shows up as motion
rather than as art:

- **The feet sit on the same row in every cell.** A one-pixel difference reads
  as the character bobbing.
- **The figure is centred on the same column in every cell.** A one-pixel
  difference reads as sliding.

48 pixels is set by the room: the plate is 1280×720 and the character is drawn
at 3 screen pixels per art pixel, so 48 art pixels is a person about a third of
the way up the frame. That is the same relative size as the characters in *The
Dig* (~44px) and it is why a small head and long legs matter — roughly a
seventh of the height for the head, about half for the legs.

## The clips

| clip | frames | needed |
|---|---|---|
| `idle` | 1–4 | yes |
| `walk` | 8 | yes |
| `talk` | 2–4 | yes — mouth open/closed is enough |
| `idle_back`, `walk_back` | 1–4 / 8 | optional, and the biggest single upgrade |
| `idle_front` | 1–4 | optional |

The back-facing clips are worth calling out: right now turning upstage only
hides the face, because there is no back sprite. A character that can walk away
from camera is the difference between a room and a diorama.

The walk must be a **loop**: frame 8 leads back into frame 1. The engine drives
the phase from distance travelled, not from a timer, so the feet stay in step
with the ground at any speed — which only works if the cycle closes.

## The JSON

```json
{
  "cellW": 64,
  "cellH": 64,
  "cols": 8,
  "figureH": 48,
  "feetY": 60,
  "clips": {
    "idle": { "start": 0,  "count": 4, "fps": 6 },
    "walk": { "start": 8,  "count": 8, "fps": 12 },
    "talk": { "start": 16, "count": 4, "fps": 8 }
  }
}
```

- `cellW` / `cellH` — one cell, in pixels. Every cell the same size.
- `cols` — cells per row in the sheet.
- `figureH` — feet to top of head. The engine scales by this, so it can be off
  the nominal 48 and still land correctly.
- `feetY` — the row **within a cell** where the ground line is. This is what
  puts the character on the floor rather than floating over it.
- `clips[].start` — index of the clip's first cell, counting from 0 across the
  whole sheet.

## If that is awkward to produce

A folder of individual PNGs, one per frame, named `walk-01.png` … `walk-08.png`,
`idle-01.png`, `talk-01.png`, is also fine — the atlas and manifest can be built
from it, provided the two alignment rules above still hold within each clip.

## A warning about generating these

Frame-to-frame consistency is the hard part and image models are bad at it: ask
for eight walk frames and you get eight slightly different characters. What
works is generating **one** reference pose and producing the rest as edits of
that single image, or using a pack with genuinely hand-made frames. A pack whose
frames disagree about where the belt is will look worse than the procedural
sprite, however good any single frame is.

## PixelLab

`tools/pixellab.mjs` wraps [PixelLab](https://www.pixellab.ai/pixellab-api), which
is built for this and solves the failures above at the API level rather than by
prompting harder.

    export PIXELLAB_API_KEY=...
    node tools/pixellab.mjs balance
    node tools/pixellab.mjs character bonny --dry   # print the brief, spend nothing
    node tools/pixellab.mjs character bonny
    node tools/pixellab.mjs animate bonny walk
    node tools/pixellab.mjs sheet bonny

The reason it works is structural rather than a matter of quality. **A character
is a persistent entity**: you create it once and then ask for animations *of
it*, so the frames cannot drift into eight slightly different people the way
eight independent rolls do. Four more of the problems above are parameters
rather than hopes:

| the failure | the parameter |
|---|---|
| magenta backgrounds keyed by hand, gradients, a dark band under the feet | `no_background: true` — real transparency |
| a 1px outline asked for in prose and inconsistently drawn | `outline: "single color black outline"` |
| 8, 8, 8, 7, 6, 5 and 4 frames returned for one brief | `frame_count`, 4–16, even |
| no back-facing sprite, so turning upstage only hides the face | 8 directions, `directions: [...]` |

`view: "side"` matters and is set: this is a side-on room, and a character
generated top-down cannot be turned into one afterwards. Sizes run 32–256, so
the 48px figure this document asks for is native rather than something to
downscale into.

Rough cost: a Pro character is about $0.185 and animation frames $0.013–$0.042
per direction, so a character with a walk cycle in the directions the game
needs lands well under a dollar.

The output goes through the same cutter as everything else
(`tools/sheet-cut.mjs`), which still enforces the two alignment rules — the API
should make them true already, and the check is cheap.

## AutoSprite

[AutoSprite](https://autosprite.io) returns exactly the shape this document
asks for: a uniform grid — 5×5 cells of 256px in the sheets tested — with the
background already removed, per-animation (idle, walk, run, jump), plus an
atlas export.

`tools/autosprite.mjs` wraps it. Base URL `https://www.autosprite.io/api/v1`,
authenticated with `x-api-key: vspk_…`.

    node tools/autosprite.mjs account
    node tools/autosprite.mjs characters
    node tools/autosprite.mjs regen <characterId> --dry
    node tools/autosprite.mjs regen <characterId>
    node tools/autosprite.mjs pull <characterId>

Two things in the API matter more than the generation quality, and neither is
visible from the app.

**`frameSize` accepts 32–512.** Frames can be asked for at the size the game
draws them, which removes a resampling step rather than doing it better — but
only down to the resolution the art was actually drawn at. Below that it is
not asking for game-sized art, it is destroying art you already have. See
*Resolution: derive it, do not pick it* for how to find the floor; it is 256
for this cast, and 64 would be four times past it.

**`regenerate-spritesheets` is free.** It re-extracts from videos that were
already generated, at a different frame count, frame size, background removal
and sharpening. So sheets made in the app at its defaults — 25 frames, 256px —
do not need regenerating at cost. They need re-reading at game settings, which
is the same videos and no credits.

Frame COUNT is the free half of this. Behind the API each animation is a
generated video that gets sampled, which is why the app's idle sheet holds 25
near-identical poses; 32 covers about two gait cycles, and the cutter measures
the real one (`framesPerCycle`) so playback maps one stride of travel onto one
stride of animation whatever was sampled. `removeBg: "ultra"` is the AI
removal and costs nothing over the app's `"default"`.

That means the cutter needs none of its rescue machinery. `--grid` says the
sheet already is a grid, so the work reduces to measuring where the figure sits
inside each cell and re-packing at native resolution with the feet on one row:

    node tools/sheet-cut.mjs <sheet.png> --name bonny --grid 5x5 --down 4
    node tools/check-cut.mjs        # the alignment rules, on a fixture built to break them

`--down N` reduces by the block size to get back to native pixels, since a 256px
cell is pixel art drawn large. `tools/pixel-grid.mjs` measures what N should be.

The cutter now verifies the file it just wrote — feet spread and head spread
across every cell, printed, and a non-zero result fails the run. Enforcing a
rule and checking it are different things, and only the second survives a
refactor. `tools/check-cut.mjs` builds a sheet designed to break both rules
(heights varying 12px, placement varying 18px) and asserts the output has zero
spread; a real sheet that happens to be well aligned would prove nothing about
the code.

Sheets can live anywhere now — an uploads directory, /tmp, another checkout —
because the image is handed to the page as a data URI rather than served from
inside the repo.

### What the API actually allows

Read endpoints work on a free key; **write endpoints do not**. `GET /account`,
`GET /characters` and `GET /characters/:id/spritesheets` all answer, but
`POST …/regenerate-spritesheets` returns `403 PLAN_REQUIRED`. On a paid key
every write works, and the free re-extract becomes the most useful call in the
API — see *Resolution is the lever* below.

One endpoint is not in the docs and is worth knowing: `GET
/characters/:id/spritesheets` lists a character's sheets **with their download
URLs**, which is what `pull` uses. The character record itself carries no
spritesheet ids at all.

The atlas JSON is a plain uniform grid — 256×256 cells, five columns, one entry
per frame with no trim rectangles — so it adds nothing over `--grid 5x5` and is
kept only for provenance.

### Cutting what came back

    node tools/autosprite.mjs pull <characterId>
    node tools/sheet-cut.mjs --name bonny --grid 5x5 --down 3 \
      idle=assets/cast/autosprite/idle.png walk=assets/cast/autosprite/walk.png

`clip=path` packs several sheets into one atlas with named clips, because idle
and walk are separate exports but one character and the loader takes a single
sheet per body. Without it `idle` would be frame 0 of the walk — a contact
pose, so the character freezes mid-stride whenever she stands still.

`--down 3` was chosen by looking: `--down 4` lands the figure at 45px, closer
to the 48px this document asks for, but the character is dark-clothed against
dark planks and loses too much. 60px reads.

The numbers are what settle this against the general models. Across fifty
frames the figure height varies by **one pixel**; the general sheets varied
12–23%, which is a visible pulse. Feet spread and head spread are both zero,
verified against the written file rather than assumed.

### Creating a character from here

`POST /characters` takes `name`, `prompt`, `usePromptTemplate`, `isHumanoid`,
`characterDescription` and `quality` (`turbo` | `pro`). That is the whole of it.

**There is no vibe field.** The app's "Choose Vibe" picker — the one whose "HD
Pixel Art" setting is the right match for this game — is a prompt template
applied on the UI side, and `usePromptTemplate` is a separate flag that applies
AutoSprite's own generic one instead. So the style has to be written into the
prompt, and written *identically* for every character: a cast reads as one cast
only if the style sentence is literally the same across it. `STYLE` in
`tools/autosprite.mjs` is that sentence.

State it in pixels, not in eras. "Chunky readable pixels, visible pixel grid,
hard aliased edges, no blur, no gradients" is something a generator can aim at.
"1990s adventure game" on its own has produced a smooth digital painting of a
pirate every time this project has asked for it.

**The prompt cap is 600 characters and a longer one is cut silently**, mid
sentence, with no error. `cmdCharacter` throws before spending rather than
after. Names must be unique too: a duplicate is `409 DUPLICATE_CHARACTER`, and
there is no delete in the API, so a remade character needs a new name.

### Asking for an animation

`POST /characters/:id/spritesheets` takes a list of `{kind, loop}` for the
standard moves and `{kind: 'custom', name, prompt, loop}` for anything else.
The response names its jobs under `workflows` — not `jobIds`, not `jobs` — and
a wrapper that looks for the obvious key returns while the art is still being
made.

Two failures shaped how the custom prompts here are written, and both produced
sheets that were technically fine and unusable.

**A pose implies its furniture.** "Slumped with his back against a post" drew a
post — welded into all thirty-two frames, in a room that has its own posts
painted into the backdrop. A character animation must contain the character and
nothing else, and that has to be refused outright: *no post, no wall, no
barrel, no furniture, no props, no ground or shadow*.

**A before and an after draws both.** "He stands, then his knees give way and he
slides down to sit" produced two harbourmasters in the same frame, one standing
and one seated. A video model asked for a transition will show you the ends of
it side by side. So do not ask for one: ask for a single continuous state,
which is what a loop actually is. The falling-over is carried by the dialogue,
which already pauses on `zzzzzz`; what the room needs from the art is a
sleeping man who is still there.

The sleeping loop is also the reason not to generate a fourth clip. The tail of
a settle-and-sleep clip is already a slumped man breathing, so the atlas cuts
that stretch out as its own looping clip. Generation costs credits; slicing does
not.

### Resolution: derive it, do not pick it

This got it wrong in both directions before it got it right, and the wrong
answers were both confident.

**First: too fine.** The characters were drawn at roughly their sheet height,
so one character art-pixel covered about one screen pixel while the backdrop's
covered two. They looked smoother than the scene they stood in.

**Then: far too coarse.** Correcting it, the room's grid was taken from
`BLOCK = 3` in `pixelate.js` — a constant belonging to the retired procedural
puppet, not to the painting — and the sheets were re-extracted at 80px to suit
it. That is 3.2× below the character art's own grid, and the result was
visibly grainy: a beautiful 1024px base image thrown away and the remains
magnified. The same downsample-smooth-art mistake, for the third time in this
directory, reached by arithmetic rather than by carelessness.

Measure both grids. Neither is a matter of opinion:

    node tools/pixel-grid.mjs assets/scene.jpg                       # the room
    node tools/pixel-grid.mjs assets/cast/autosprite/grout/base.png  # the art

The plate quantises at **2px** — a logical room of 640×360. Grout's base image
quantises at **4px in 1024**, and at nothing else (grid 4 is the only candidate
with lift above 1), so **256 is the character art's native frame size** and
anything below it is discarded information rather than style.

Those two numbers give the frame size by division, with nothing left to judge:

    figure wanted on the sheet = drawn height / backdrop block   (÷ 2)
    frameSize                  = that / how much of its frame the figure fills

Grout is drawn 336 tall and fills ~95% of his frame: 336/2 = 168, /0.95 = 177,
so **176**. Bonny is drawn 318 and fills ~71%: 318/2 = 159, /0.71 = 224, so
**224**. Both are a mild reduction from native rather than a gutting, and both
land the cast on the backdrop's own grid — `figureH` in the cut manifest comes
back 168 and 159, exactly half the drawn heights.

`regenerate-spritesheets` performs the re-extraction for nothing:

    node tools/autosprite.mjs regen <characterId> --frames 32 --size 176

The check that stops this recurring is in `tools/check.mjs`: it reads each
actor's drawn height against its sheet's `figureH` at the depth it stands at
and requires 2, near the front of the room. The console line reports the same
ratio per character. Both read 2.00; at the sizes shipped before, they read
1.25 and 1.33 and the step fails.

Two hazards come with re-extraction. It **adds** sheets rather than replacing
them, so a character re-extracted twice lists every kind three times and the
newest wins by timestamp, not by listing order. And it leaves a soft-alpha
halo, which the cutter's binary mask hard-thresholds away — the packed atlas
measures 0% soft and the edges stay hard. `tools/pixelness.mjs` reports edge
density and soft-alpha share for any sheet.

### Two characters, one filename

`pull` writes sheets by `kind`, and every character has a `walk` and an `idle`.
Pulling a second character on top of a first therefore replaced the first one's
source art with art of somebody else — silently, and only visible later as the
wrong person walking. Every pull goes under the character's own folder now, and
the folder name comes from the character record rather than from the command
line so it cannot drift. Custom animations collide the same way, since they all
report `kind: "custom"`; they are named by their animation name instead.

### Which way is it facing?

Sheets come back under a `/right/` path and are not reliably right-facing, and a
character who turns round when he stops walking is obvious in motion and nearly
invisible in a contact sheet. `tools/facing.mjs` measures it:

    node tools/facing.mjs assets/cast/autosprite/grout/*.png

Silhouette mirror-matching is too weak on a long coat — a mirrored frame scores
almost as well as the original. The face is not symmetric: in a side view the
skin sits on the side the character looks towards, so where the skin falls
inside the head band is a direct reading. Pick the frame to read with care —
`--frame 30` for a clip whose first frame has a cup over the face, `--band 0.4`
for a seated pose whose head is not in the top fifth. Eyeballing these four
sheets gave the wrong answer for two of them; the measure gave the right one
for all four.

### Which end of the character to hold still

The cutter's two rules are "feet on one row" and "the figure on one column".
Both anchors were wrong, in different ways, and both were found by measuring
rather than looking.

**The column.** The head was the anchor everywhere, on the reasoning that a
swinging arm moves the bounding box without moving the character. True of a
walk; false of anything standing still. Grout's idle sways his head 8px and
does not move his feet at all, so pinning the head pushed his whole body back
and forth and gave a man standing still a shuffle.

The first rule tried was "anchor on whichever band varies least", which is not
it either: Bonny's idle has a steadier head than feet, so it chose the head and
left her feet drifting 4px on screen. The rule that holds is about what the
clip IS. A clip with a gait moves its feet on purpose and must be pinned by the
head; a clip without one has feet that are standing on the dock and must be
pinned by them. Whether a clip has a gait is read off its own frames — the
figure's width just above the ground swings through a walk and is flat through
an idle — and the cutter prints which it found:

    idle    no gait    (feet swing 0%)  -> anchor on the foot
    walk    has a gait (feet swing 70%) -> anchor on the head

**The row.** Each frame's LOWEST pixel was pinned. Background removal leaves
specks, so that is not the same as where the character stands. Printing the
opaque pixels per row of Grout's idle showed it exactly:

    row       144 145 146 147 148 149 150 151
    frame  0   16  15  14  13  11   7   6   1
    frame  6   42  31  24  15  15  14  13  11

A single stray pixel in frame 0 was pinned level with an eleven-pixel boot toe
in frame 6, so his boots sat three rows lower for twenty-six frames of the loop
and hopped up for the other six — once every two and a half seconds. The ground
row is now found by walking up from the bottom until ten opaque pixels have
been passed, which is far more than removal noise and far less than a boot. The
residual is one row on one frame of thirty-two.

`check.mjs` measures both axes on the canvas, stepping each clip by hand so the
answer is the same every run, and measures the WALK with the same call —
requiring it to move. A drift measure that read zero everywhere would pass the
still-clip assertions while proving nothing. Reverting either fix fails the
step.

### Stride, measured properly

One cycle of animation should cover one stride of ground. Getting that number
took three attempts, and the first two were wrong in instructive ways.

**Foot separation, doubled.** The widest the feet get is a step plus a foot;
the narrowest is a foot; so `(max - min) × 2` should be a stride. It is a
model, and it disagreed with itself by 28% between two cuts of the same art.

**Abandoning it.** Sweeping the assumed stride across a 3.6× range moved the
planted-foot drift only between 3.4 and 4.7 pixels a frame — a flat curve with
no minimum — which was read as proof that a video model animates a character
that merely LOOKS like it is walking, with no stance to lock to. That was
measured on the old atlas, where the packer was re-deriving each frame's
horizontal position and so moving frames relative to each other every frame.
It had scrambled the very thing being looked for.

**The measurement that holds.** While a foot is on the ground it does not move
on the dock, so in the sprite's own frame it slides BACKWARD at exactly the
rate the ground goes past. A run of consecutive backward steps in the rearmost
*contact* pixel is a stance; the mean of the longest such run is that rate; and
times the cycle length it is the stride.

Two details decide the answer. The band must be tight — two per cent of the
figure — because a wider one tracks the ankle swinging over the foot rather
than the sole resting on the dock, and reads a quarter too steep. And a stance
is a consecutive run, not a pooled set of backward frames: a running figure in
mid-air trails a leg that sweeps back far faster than the dock does, and
counting it read Bonny's stride as 2.7 body heights.

It cross-validates. Measured on the packed atlas at draw scale it gives 138px
for her walk; measured at cut time on the source it gives 144px; and the engine
had been using a hand-set 140px, which is why nobody ever complained about the
walk. Three routes to the same number.

    bonny walk   144px = 0.53 x her drawn height
    bonny run    766px = 2.84 x her drawn height
    grout walk   146px = 0.47 x his

The run is not a mistake. Her run cycle has long flight phases with both feet
off the dock, so it genuinely covers five times the ground her walk cycle does.
The engine had been giving it 320px, so the animation ran at more than twice
the rate the art depicts: the legs whirred and she arrived a third of the way
along what they were describing.

**What is asserted, and what is not.** The check compares the engine's stride
against the sheet's and requires them equal. It does NOT measure foot-lock on
the canvas, and that is a deliberate retreat: two versions of that metric were
built and neither could discriminate. The median slide over changed frames read
a flat 13px across a 4× sweep of stride, because two thirds of a cycle is the
rear foot handing over to the other leg — a jump, not a slide. A low percentile
read a flat 1–3px, because it picked up frames where rounding happened to hold
the foot still. A check that answers the same whatever it measures is worse
than no check.

### Running

A double-click on the floor runs. It is detected on pointerdown rather than
through the `dblclick` event, because every other click in this game is decided
on pointerdown and mixing the two would have the second click arrive after the
walk it is upgrading has already started.

Pace is four and a half times walking: 810px/s against 180. That is set by the
art rather than chosen. Her run stride is 766 room pixels, so this lands almost
exactly one stride a second — and because the strides are so long, the legs
cycle a little SLOWER than her walk while she covers four times the ground.
Long gliding strides, which is what the animation depicts.

The check for this had to change with it. It used to assert that running was
the faster leg cycle, which was true only while the engine paced from a chosen
cadence; it now asserts ground covered per second, which is what running is.

The check drives this through the real mouse. The first version called `walkTo`
directly and so proved only that the plumbing worked; it could not have caught
a double-click that never reached the actor, which is the failure that was
actually reported. It also has to pick a destination clear of Grout — he is an
actor with his own hit box rather than a declared hotspot, so the harness's
free-floor finder walks right into him, opens the verb coin and measures a pace
of zero.

### Do not re-align a sheet that is already aligned

The cutter's whole purpose is to put frames in register with each other. For a
sheet extracted from a single video, they already are — and re-deriving each
frame's position from its pixels can only add error to it.

It did. Wherever background removal left a soft grey smear under Grout's boots,
the detected ground row wandered up to three pixels, and frames that arrived in
perfect register came out of the packer bobbing. It showed as his feet hopping
once a loop, and the tell was that it does not happen on AutoSprite's own
preview — because AutoSprite's own preview draws each cell where it is and does
not do any of this.

So a registered sheet is COPIED. Inside a clip nothing moves at all; between
clips the ground rows and horizontal centres are brought together, because one
video is one coordinate frame and two videos are two — a seated sleeping man
and a standing one were never filmed against a common floor.

Which case a sheet is in is measured, not assumed, and two attempts at that test
were wrong before the third:

- Keying off `--grid` fails, because `tools/check-cut.mjs` builds a uniform grid
  deliberately misaligned by 18px to prove the aligner works. Copying that in
  place preserves a fault instead of fixing one.
- Measuring every clip's ground row fails, because a running character leaves
  the ground. Bonny's run varies 13px however perfect the sheet is, and reading
  that as misalignment sent a clean sheet through the aligner.

The test that holds looks only at clips WITHOUT a gait. A character standing
still has no excuse for its ground row moving inside its own cell; if it does,
the frames are not in one coordinate frame. Real sheets read 0–1px against a
tolerance of about 6; the fixture reads 9 against 2. Nothing delicate.

### Versions, and why the newest is not the best

Every `regenerate-spritesheets` call keeps a version. The background remover
does not do the same job at every frame size: the 152px pass left a soft grey
smear under Grout's boots that the 176px pass did not, and the difference is
visible in the numbers — the lowest opaque pixel wanders 3px inside its cell at
152, 1px at 160, and 0px at 176.

`pull --at 176` takes that version of every sheet instead of the newest. Taking
the cleaner art at a size that does not divide evenly is a trade: his figure
comes back 168px rather than 148, so drawn at 310 he sits at 1.85 art pixels
rather than a clean 2. The smear was worse.

### Props

`isHumanoid: false` generates objects, and the same LOOK line the cast uses
makes them match it — which is the reason to bother, since the other props here
are repainted vector blockouts and look like a different lineage.

The style brief is split for this. LOOK is how the pixels are made and is shared
by everything; FIGURE is anatomy and only people get it. The first version was
one blob including "small head, long legs", which is advice a cup cannot use.

Resolution is the same problem one size down, and the generator's floor bites.
The room draws the tin cup about 24 art pixels wide, so frameSize 32 is the
nearest available — and at 32 the extraction is mush, an unreadable blob with
no silhouette. 64 and 96 are both clean. So the cup is taken at 64, where it is
about 50 art pixels, and drawn into a box sized to its own cell so nothing is
resampled at all. It sits at one art pixel against the scene's two: finer than
its surroundings rather than mushier, which at this size is the better half of
a trade that cannot be avoided.

`autosprite.mjs prop <key>` writes one frame as `assets/props/<key>.png`. The
frame is the one nearest the middle of the motion, not the first — the cup's
animation is a sway, and its first frame is the cup at one end of its swing, a
still cup hanging permanently at a tilt.

### Do not paint anything the player can pick up

`src/art/props.js` has said from the first prototype that anything clickable is
generated as its own sprite and placed at a coordinate we control, never
painted into the backdrop and hoped for. The galley's prompt asked for a pepper
pot on the table anyway, because it made the composition better and the puzzle
obvious — and the bill came due the first time somebody picked it up and it
stayed on the table.

Two separate faults come out of one mistake:

- **It does not leave.** The hotspot hides; the paint does not.
- **The icon is a different drawing.** A hand-drawn canvas icon next to a
  painted object is two pictures of one thing, and the player can see both at
  once.

Regenerating the backdrop without it would move every hotspot in the room, so
the fix here is that the painting patches itself, and the icon is cut out of
the painting:

- A narrow strip immediately beside the object, stretched across where it
  stood. Copying a whole rectangle from further along the wall was the first
  attempt and it showed as a darker panel: the lamp throws a pool of light onto
  that wall, so pixels fetched eighty-six across come from a different
  brightness. A strip from the object's own elbow is the right brightness by
  construction, and stretching it sideways preserves what runs sideways — the
  edge of the table.
- The patch is copied from whatever the backdrop is showing at that instant —
  the live video frame when one is playing — so it keeps step with the
  firelight rather than sitting there as a still rectangle in a moving picture.
- The inventory icon is the same crop, taken once and cached in the shared icon
  table, because she can carry it up the ladder into a room whose backdrop has
  never loaded.

The check measures LOCAL CONTRAST inside the object's box rather than
difference against another patch of wall. That wall is lit by a gradient, so
two clean pieces of it differ by half their pixels and a difference metric
answers "these are different places" however well the patch worked. A pepper
pot is a hard-edged object with an outline and wall is smooth: contrast reads
20.6 with the pot there and 1.7 without, against 7.0 for clean wall.

This is a rescue, not a licence. The rule still stands: keep takeable objects
out of the backdrop prompt. The galley's bellows are the version that obeys it
— they are painted in, so they are never carried, and the puzzle loads and
works them where they stand.
