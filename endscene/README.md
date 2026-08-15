# endscene

Build a film or a television show out of AI-generated coverage — several shots
of the same moment, from different angles, that agree with each other well
enough to cut together without the joins showing.

The unit of work is not "a video". It is *coverage*.

---

## The problem

Video models will give you thirty seconds a pass, which sounds like plenty until
you try to cut with it. Television is made of three-second shots. A scene is six
or eight of them from different angles, and the entire craft is that nobody
notices they are looking at eight separate pieces of film.

So the shots have to agree about who these people are, what they are wearing,
where they are standing, which way they are facing, what colour the light is and
what the room sounds like. Get that wrong and per-shot quality cannot save you:
eight beautiful shots that disagree cut together into something that feels
cheap, and the viewer will tell you it looked "weird" without being able to say
why.

**The video endpoint has no seed.** You cannot ask for the same roll of the dice
twice. Consistency is therefore only ever the product of three things: identical
words, identical reference assets, and reference discipline. Every design
decision in here is downstream of that, including two that look strange at
first:

- **Nothing regenerates silently.** A build system rebuilds when its inputs
  change. Here a rebuild destroys an approved artefact you can never get back.
  Staleness is *reported*; regenerating is always a human act.
- **Everything is a take.** You roll several and choose, which is how film has
  always worked. Selection is a first-class operation, not a retry.

## Getting started

```bash
npm start                 # or: node bin/endscene.mjs serve
```

Then open http://localhost:4000.

Needs Node 18+, `ffmpeg` on the path, and `pip install numpy` for the audio
analysis. There are no npm dependencies.

```bash
export FAL_KEY=...                # video, image generation, image editing
export ELEVENLABS_API_KEY=...     # music beds
```

The repository ships with a worked example — *El Testamento*, a three-shot scene
of two hens arguing over a will — including its reference sheets, voice plates
and takes. You can cut it without an API key and without spending anything:

```bash
node bin/endscene.mjs cut e01 testamento
```

## How a show is put together

Four scopes with different lifetimes. Conflating them is what stops a scene
being reusable.

| scope | lives for | holds |
| --- | --- | --- |
| **Show** | everything | style, look and grade, aspect, resolution, the audio rules |
| **Company** | many episodes | characters: identity, wardrobe looks, voice |
| **Locations** | many scenes | sets, each in one or more lighting states |
| **Scene** | itself | cast and blocking, the line, shots, dialogue |

```
projects/<show>/
  show.json
  company/<character>/
    character.json
    voice/            plate.mp4, voice.mp3, takes/
    looks/<look>/     sheet.png, look.json, takes/
  locations/<location>/states/<state>/plate.png
  episodes/<ep>/scenes/<scene>/
    scene.json
    shots/<shot>/     selected.mp4, takes/
    dist/             the cut, the bed, the subtitles
```

Plain JSON and ordinary files. No database — a production is a thing people
argue about over months, and being able to read, diff, review and revert it in
git is worth more than any query you would run against it.

## Wardrobe

A character is not one sheet. It is identity × look.

There is one **default look**, drawn from scratch. Every other look is produced
by handing the editing model *the approved default sheet* plus an instruction
naming only the garment change, with an exhaustive keep-clause protecting the
face, colouring, proportions, the three views, the pose, the backdrop and the
lighting. That derived sheet is what gets passed to the video model for any shot
in that wardrobe.

**This is the most important rule in the asset model.** Generating a new look
from a new description re-rolls the face, and you get a different actor in a
different dress — precisely the failure reference sheets exist to prevent.

Looks form a tree rooted at the default, and `look.json` records what each was
derived from and by what instruction, so re-deriving after the default changes
is one click and never a re-cast.

The "describe a change" box is the same mechanism with a different instruction.

## Voices

A character sheet cannot hold a voice. The tempting workaround — chain the
previous shot as a video reference and let the voice come across with everything
else — works only if that character happened to be speaking in the previous
shot. That is true for exactly as long as your scene is two shots of two people.
It breaks the moment the camera cuts away from someone, and it never worked at
all for a character who enters later.

So voices are cast the way faces are: once, into a committed asset. Each
character is filmed alone saying a line that appears in no script, and the
stripped audio is passed as `@AudioN` in every shot they speak in, whatever the
shot before it contained.

The plate is shot at 480p, because only the audio survives it. It is filmed in a
deliberately dead room — no weather, no ambience, no music — because anything on
that track rides into every scene the sample is used in. *A voice reference
recorded over rain is a rain reference.*

## Sound

Left alone, the video model scores every shot for you, and it must not be
allowed to. A cue invented independently per shot restarts at every cut, so the
music lurches each time the picture changes and the scene sounds broken however
well the pictures match. It is the fastest way to make good coverage feel
amateur.

So:

1. Every shot prompt **forbids music outright**, at length.
2. `generate_audio` stays **on**, because the diegetic layer is worth having —
   voices, weather, the sound of objects. It cuts cleanly, being continuous room
   tone either side of the edit.
3. One unbroken bed is written across the whole scene and laid underneath.

In the mix the bed is **sidechained to the dialogue** rather than set to a fixed
low level, which is what makes it read as scoring instead of backing track. It
also masks the one real seam in the edit: room tone differs between two
independently generated shots, and that audio cut is genuine. It is not fixed by
fading — a dip at the cut is more audible than the seam — it is covered by the
one element running through the edit untouched.

## Subtitles

The video model will burn text into a shot and is forbidden from doing so, for
the same reason it is forbidden to score one: baked-in text cannot be corrected,
restyled, translated or switched off.

The timing is where the model's word is worth least. Prompts give beats and a
rule that speech must finish before the end, and both are honoured loosely —
observed: a take that ran its line into the final frame, and voice plates that
did the same after being told twice not to. So nothing trusts the script for
time. `lib/speech.py` measures where the voiced speech actually is and the
declared lines are aligned to what it found.

**The script says what is said. The audio says when.**

## Continuity

`endscene check` reports three things, all measured:

- **Voice drift** — median f0 per shot against the character's plate. The plate
  is the truth: it was recorded in a dead room, so it is the only measurement
  not contaminated by weather and props.
- **Grade drift** — mean luma between adjacent shots.
- **Timing** — a line running to the final frame, leaving no handle to cut on.

All of it **advisory**. A wide and a close-up legitimately differ in luma. The
report puts a number in front of a human; it does not have an opinion about
whether the take is good.

## The command line

The UI drives the same library, so anything you can click you can script.

```
endscene serve      [--project P] [--port 4000]
endscene cut        <episode> <scene> [--no-bed] [--no-subs] [--lang en]
endscene shoot      <episode> <scene> [shot…] [--res 480p] [--takes 2]
endscene estimate   <episode> <scene> [--res 480p]
endscene prompt     <episode> <scene> [shot]      print prompts, generate nothing
endscene check      <episode> <scene>             continuity report
endscene models     [--refresh]                   models and live pricing
```

`endscene prompt` is the cheapest tool here — it shows exactly what would be
sent without sending it.

## Models and money

Prices are **never hardcoded**. fal publishes a pricing string per model, and
that is what the UI shows; a price baked into source is wrong the first week it
changes, and wrong silently. `endscene models` prints the current list.

Editing defaults to Nano Banana 2 — best quality for the money, and what the
wardrobe rule was proven against. Seedream 5 Pro is offered prominently because
it comes from the same lab as the video model, so its output may sit more
naturally with it.

Roughly, at the time of writing: video is about $0.47/second at 720p, about
$0.28/second with a video reference, and about $0.22/second at 480p. A six-second
shot is a couple of dollars. Block a scene at 480p, promote what works.

## Gotchas, learned the hard way

- **No seed.** A take you like cannot be reproduced, only re-approximated. This
  is why takes are source, not output, and why they are committed.
- **Dialogue drifts to the end of the clip.** Write the timing rule anyway — it
  helps — but measure the result rather than assuming it.
- **Generate long, cut short.** Shots are generated at six seconds and play at
  four or five. The model spends the first second settling, and an edit with no
  handles has nowhere to trim to.
- **Pin every aspect ratio.** Left on `auto` an edit came back at a different
  aspect than its source. Harmless once, corrosive over a chain of edits.
- **`duration: auto` is not for editing.** You are cutting to a plan.
- **Say what must not happen.** "No handheld shake, no whip pan, no crash zoom"
  earns its place, and so does "no on-screen text".
- **The 180-degree line will not hold itself.** Two shots generated
  independently will cheerfully put a character on opposite sides of frame. Here
  the rule is derived from the scene's blocking so it cannot disagree with it.
- **Drop references a shot does not need.** Every reference competes for
  influence. Handing the model a full-body sheet of a character while telling it
  not to show her is the surest way to have her turn up in frame.

## Layout

```
bin/endscene.mjs      the command line
server.mjs            HTTP, job queue, SSE
web/                  the interface — vanilla, no build step
lib/
  store.mjs           the project on disk: paths, takes, selection, staleness
  prompt.mjs          every prompt the system sends, assembled in one place
  models.mjs          the model shortlist and live pricing
  fal.mjs             upload + queue client
  images.mjs          generate and edit stills
  voice.mjs           voice plates
  shoot.mjs           shots, and the reference stack they need
  subs.mjs            subtitles, timed off the audio
  speech.py           where the speech actually is
  voicecheck.py       median pitch of a clip
  cut.mjs             the ffmpeg assembly
  score.mjs           the music bed
  continuity.mjs      the advisory checks
projects/telenovela/  a worked example, with its takes
```

`lib/prompt.mjs` is the one to read first. It is why the whole thing works.
