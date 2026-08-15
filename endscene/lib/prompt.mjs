// Every prompt the system sends, assembled in one place.
//
// This module is the reason the whole thing works, and it is worth being blunt
// about why. Seedance 2.5 has no seed. You cannot ask it for the same roll of
// the dice twice. The only things that make shot two look like shot one are
// that you handed it the same pictures and said the same words — so the words
// must be *provably* the same, not carefully-kept-the-same.
//
// Hand-writing two prompts and trusting yourself to keep them in sync is how
// scenes drift. So no prompt is ever written by a human twice: the spine lives
// once in show.json, the character description lives once in character.json,
// and this module composes them in a fixed clause order. If you find yourself
// describing a character inside a shot, the scene has already been lost.
//
// The second invariant is subtler and just as easy to break. The prompt refers
// to references positionally — @Image1, @Audio2, @Video1 — so the prompt text
// and the upload order have to agree. They cannot be produced by separate code
// paths. `buildShot` therefore returns the prompt *and* the reference lists
// together, built in the same loop, and the shooter uploads exactly what it is
// given in exactly that order.

// ---------------------------------------------------------------------------
// The 180-degree line
// ---------------------------------------------------------------------------
//
// Two shots generated independently will cheerfully put the same character on
// opposite sides of the frame, and the cut then reads as two different
// conversations. Stating the rule is what holds it — but it is derived from
// the scene's blocking rather than typed per shot, because a rule retyped is a
// rule that eventually disagrees with itself.

export function continuityClause(scene, cast) {
  const placed = scene.cast.filter((c) => c.side);
  if (!placed.length) return '';
  const rules = placed.map((c) => {
    const name = cast[c.character]?.name || c.character;
    const side = c.side.toUpperCase();
    const facing = c.side === 'left' ? 'RIGHT' : 'LEFT';
    return `${name} is always on the ${side} of frame and always faces ${facing}`;
  });
  return `CONTINUITY: The camera never crosses the line. ${rules.join('. ')}. No character swaps their side of the frame or the direction of their eyeline at any point in this scene.`;
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

// Which references a shot needs. Deliberately narrow: fal's own guidance is
// that every reference competes for influence, and handing the model a
// full-body sheet of a character while telling it not to show her is the
// surest way to have her turn up in frame. So subjects are only those visible,
// and voices only those who speak.
export function referencesFor(scene, shot) {
  const subjects = shot.subjects ?? scene.cast.map((c) => c.character);
  const spoken = [...new Set((shot.lines || []).map((l) => l.speaker))];
  const voices = shot.voices ?? spoken;
  return { subjects, voices, chain: shot.chain ?? null };
}

export function buildShot({ show, scene, shot, cast, location }) {
  const { subjects, voices, chain } = referencesFor(scene, shot);
  const lookOf = Object.fromEntries(scene.cast.map((c) => [c.character, c.look || 'default']));

  const images = [];
  const audios = [];
  const videos = [];
  const labels = [];

  for (const key of subjects) {
    const c = cast[key];
    if (!c) throw new Error(`${shot.id}: no such character "${key}"`);
    images.push({ kind: 'sheet', character: key, look: lookOf[key] || 'default' });
    labels.push(
      `@Image${images.length} is a character reference sheet for ${c.note} Match this character's face, colouring, costume and proportions exactly.`,
    );
  }

  // The set plate goes last among the images so that adding or removing a
  // character never renumbers it in a way the reader has to think about.
  images.push({ kind: 'plate', location: scene.location, state: scene.state });
  labels.push(
    `@Image${images.length} is the set: ${location.note}. Use it for the room's architecture, its layout, its lighting and its colour palette. It is photographed empty — do not put the characters where they are not.`,
  );

  for (const key of voices) {
    const c = cast[key];
    if (!c) throw new Error(`${shot.id}: no such character "${key}"`);
    audios.push({ kind: 'voice', character: key });
    // Labelled harder than anything else, because this is the reference whose
    // purpose a model is most likely to guess wrong: an audio file handed over
    // without explanation reads as "play this" as easily as "sound like this".
    labels.push(
      `@Audio${audios.length} is a voice sample of ${c.name}, recorded on its own. It is the reference for HOW ${c.name} SOUNDS — the pitch, age, weight, accent and pace of their speaking voice. ${c.name} must sound exactly like this sample whenever they speak in this shot. Do NOT play this recording in the scene, do NOT treat its words as dialogue for this shot, and do NOT copy any background from it: use it only to cast the voice.`,
    );
  }

  if (chain) {
    videos.push({ kind: 'shot', shot: chain });
    labels.push(
      `@Video${videos.length} is the previous shot of this same scene, already filmed. Use it ONLY as the reference for how the characters look, how the room looks, and how it is lit and graded — their faces, their costumes, the light and the colour. Do NOT continue its camera movement and do NOT repeat the action in it. This is a cut to a new angle later in the same conversation.`,
    );
  }

  const dialogue = (shot.lines || [])
    .map((l) => `${cast[l.speaker]?.name || l.speaker} says, in ${show.language || 'English'}: "${l.es || l.text}"`)
    .join('\n');

  const prompt = [
    show.premise || `A scene from ${show.title}.`,
    show.language ? `All dialogue is spoken in ${show.language}.` : '',
    '',
    'REFERENCES:',
    ...labels,
    '',
    shot.action,
    dialogue ? `\nDIALOGUE IN THIS SHOT:\n${dialogue}` : '',
    '',
    continuityClause(scene, cast),
    '',
    show.style,
    '',
    show.look,
    '',
    show.audio,
  ]
    .filter((s) => s !== '')
    .join('\n');

  return { prompt, images, audios, videos };
}

// ---------------------------------------------------------------------------
// Reference sheets
// ---------------------------------------------------------------------------
//
// Plain on purpose. It is tempting to build a lavish turnaround with expression
// rows and costume call-outs, but every reference competes for influence and a
// busy sheet spends it on the wrong things. Three views on grey is what
// transfers.

export const SHEET_FRAME =
  'Character reference sheet on a plain seamless neutral grey backdrop. Three views of ' +
  'the SAME character standing in a relaxed neutral pose, side by side, evenly spaced, ' +
  'all three the same height and all fully inside the frame: front view on the left, ' +
  'three-quarter view in the middle, side profile view on the right. Full body, head to ' +
  'feet, wearing the same costume in every view. Flat even studio lighting, no cast ' +
  'shadows, no rim light, no props, no text, no labels, no watermark, no border.';

export const PLATE_FRAME =
  'A single cinematic film still, no people in the frame at all. Shallow depth of field. ' +
  'No text, no watermark, no border.';

export function buildSheet({ show, character, look }) {
  const wardrobe = look?.wardrobe ? `\n\nWardrobe: ${look.wardrobe}` : '';
  return `${character.sheet}${wardrobe}\n\n${SHEET_FRAME}\n\n${show.style}`;
}

export function buildPlate({ show, location, state }) {
  const lighting = state?.lighting ? `\n\nLighting and time of day: ${state.lighting}` : '';
  return `${location.sheet}${lighting}\n\n${PLATE_FRAME}\n\n${show.style}\n\n${show.look}`;
}

// ---------------------------------------------------------------------------
// Wardrobe, and edits generally
// ---------------------------------------------------------------------------
//
// The single most important rule in the asset model: a new look is an EDIT of
// the approved default sheet, never a fresh generation. Generating from a new
// description re-rolls the face, and you get a different actor in a different
// dress — which is exactly the failure the reference sheet exists to prevent.
//
// The keep-clause is exhaustive on purpose. Anything not explicitly protected
// is treated as fair game by an editing model, and "same character" is not a
// specific enough instruction to protect a beak.

const KEEP =
  'Keep the character herself completely unchanged: identical face, identical head shape ' +
  'and features, identical eyes and expression, identical colouring and markings, identical ' +
  'body proportions and build. Keep the identical three views (front, three-quarter, side ' +
  'profile), the identical poses, the identical framing and scale, the identical plain ' +
  'neutral grey backdrop and the identical flat even studio lighting. Do not restyle, ' +
  'redraw or reinterpret the character. Do not change the number of views. ' +
  'No text, no labels, no watermark.';

export function buildWardrobeEdit({ wardrobe, remove }) {
  return [
    'Replace ONLY the wardrobe worn by the character in @Image1. This is a costume change and nothing else.',
    '',
    `Change the costume to: ${wardrobe}`,
    remove ? `Remove entirely: ${remove}` : '',
    '',
    KEEP,
  ]
    .filter(Boolean)
    .join('\n');
}

// The "describe a change" box. Same protective spine, but the instruction is
// whatever was typed — used for correcting a sheet rather than reclothing it.
export function buildNoteEdit({ instruction, protect = KEEP }) {
  return [
    'Edit the character in @Image1 according to the following instruction, and change nothing else.',
    '',
    `Instruction: ${instruction}`,
    '',
    'Everything not named in that instruction must be preserved exactly: ' + protect,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Voice plates
// ---------------------------------------------------------------------------
//
// Filmed in a deliberately dead room. Anything audible on this track rides into
// every scene the sample is ever used in — a voice reference recorded over rain
// is a rain reference.

export function buildVoicePlate({ show, character }) {
  return `A single continuous shot with no cuts. One character alone on screen, speaking directly to camera as if recording a screen test.

@Image1 is the character reference sheet for ${character.note} Match this character's face, colouring, costume and proportions exactly.

Medium close-up, head and shoulders, centred, facing the camera. Plain, quiet, softly lit neutral room with an out-of-focus dark background. The character looks into the lens and speaks calmly and clearly.

They speak the following line${show.language ? ` in ${show.language}` : ''}, delivered ${character.direction}: "${character.line}"

They begin speaking almost immediately and the line is completely finished before the last second of the clip, which is held in silence.

${show.style}

AUDIO: This is a voice recording session. The ONLY sound in the entire clip is this character's speaking voice, recorded clean and close as if on a studio microphone. Absolutely no background music, no score, no room ambience, no rain, no thunder, no wind, no footsteps, no props, no sound effects of any kind, and no other voices. Silence behind the voice. Nothing else may be audible at any point.`;
}
