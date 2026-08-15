// EL TESTAMENTO — scene one of the filmed telenovela.
//
// This file is the scene bible. It is the only place the show is described,
// and every tool reads from it, because the whole consistency problem comes
// down to one rule: the model has no seed, so the *only* thing that makes
// shot two look like shot one is that we said the same words and handed it
// the same pictures. Every string that recurs between shots lives here once
// and is interpolated, never retyped. If you find yourself describing a
// character inside a shot prompt, you have already lost the scene.

// ---------------------------------------------------------------------------
// The spine. Identical, verbatim, in every shot prompt.
// ---------------------------------------------------------------------------

// Medium and rendering. Named once so the two shots cannot drift apart in
// style, which is the first thing that goes when you write prompts by hand.
export const STYLE = `STYLE: Stylized 3D animated feature film, in the manner of a high-end animated feature — appealing cartoon-realist design, soft subsurface shading on skin and feathers, physically lit, shot as live action rather than as cartoon. The characters are anthropomorphic chickens who stand upright, wear real clothing and act as human characters. They are played completely straight: this is a melodrama, not a comedy, and nobody mugs at the camera.`;

// Lens, light and grade. The light is motivated by a practical that is
// actually in the frame (the candelabra), which is what keeps two separately
// generated shots feeling like they were lit by the same crew on the same day.
export const LOOK = `LOOK: Cinematic 16:9 framing. 40mm lens, shallow depth of field — the subject crisp, the background softly defocused. The room is lit only by the candelabra standing on the table: a warm amber key that falls off fast into the corners, and a cold deep teal-blue fill spilling in from the rain-streaked window. Rich saturated colour, crushed inky blacks, gentle 35mm film grain. No lens flare, no light leaks, no on-screen text, no subtitles, no watermark.`;

// The audio rule. This one exists because the model will happily score every
// shot for you, and a score invented independently per shot is the single
// fastest way to make a cut sound broken — the bed lurches at every edit. So
// we forbid music outright and take only the diegetic layer, which cuts
// cleanly, and lay one continuous bed underneath ourselves in the edit.
export const AUDIO = `AUDIO: Absolutely no background music. No musical score, no underscore, no soundtrack, no strings, no piano, no ambient musical drone of any kind — music is added later in the edit and anything musical here has to be thrown away. Generate ONLY diegetic sound that physically exists in this room: the characters' speaking voices, steady rain against the window glass, a low roll of distant thunder, the small dry sounds of paper and of wood. Voices are recorded close and intimate, as if by a boom just out of frame.

TIMING: Every spoken line must BEGIN and FULLY FINISH inside the beat it is written on, and all speech must be complete at least one full second before the end of the clip. The final second of the shot is held in silence on the actor's face. Do not let a line still be running at the last frame and do not push dialogue towards the end of the shot.`;

// The 180-degree line, stated as a rule rather than left to chance. Two shots
// generated independently will happily put the same character on opposite
// sides of the frame, and the cut then reads as two different conversations.
export const CONTINUITY = `CONTINUITY: The camera never crosses to the other side of the table. Doña Perpetua is always on the RIGHT of frame and always faces LEFT. Rosalinda is always on the LEFT of frame and always faces RIGHT. Neither character swaps their side of the frame or the direction of their eyeline at any point.`;

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------
//
// Each character carries two strings that do different jobs and must agree:
//
//   sheet  — what the image model draws to make the reference sheet.
//   note   — the one-line label the video model gets, pinned to @ImageN.
//   line   — a sample speech, used once to cast the voice (tools/voices.mjs).
//
// `note` is deliberately short. The picture is doing the describing; the note
// only has to say who this is and lock the handful of attributes that a video
// model reliably loses anyway — hair/plumage colour, the one costume detail
// that reads at distance, and the voice, which no image can carry.
//
// The voice is the reason `line` exists. A character sheet cannot hold a
// voice, and chaining the previous shot only carries one if that character
// happened to be speaking in it — which fails the moment a shot cuts away
// from them, and fails permanently for anyone introduced later in a scene. So
// each character is cast once, on their own, into a short plate, and the
// audio stripped off that plate is what gets passed as @AudioN forever after.
// These are company assets, not scene assets: the plate outlives this scene.

export const CAST = {
  rosalinda: {
    name: 'Rosalinda',
    sheet:
      'A young hen, the ingenue of a telenovela. Creamy off-white plumage with soft ' +
      'golden warmth through the neck feathers, large expressive amber eyes with long ' +
      'lashes, a small neat scarlet comb, a slender elegant neck. Her face is delicate ' +
      'and open. She wears a deep crimson silk dress with a fitted bodice and black lace ' +
      'at the shoulders, and a small oval gold locket on a fine chain at her throat.',
    note:
      'Rosalinda — the young hen with creamy off-white plumage, large amber eyes, a small ' +
      'scarlet comb, a deep crimson silk dress with black lace at the shoulders, and a gold ' +
      'locket at her throat. Her voice is young, warm and quiet, and it does not shout.',
    // Deliberately not a line from the scene, so a voice plate can never be
    // mistaken for coverage and re-used as picture. Long enough to hear the
    // whole instrument — pitch, weight, pace and how she lands a consonant.
    line: 'Me llamo Rosalinda. Crecí en esta casa, entre los naranjos y el silencio de mi madre.',
    direction: 'young, warm, soft-spoken and a little guarded; an even middle register, unhurried, never shrill',
  },
  perpetua: {
    name: 'Doña Perpetua',
    sheet:
      'An old, imperious hen, the matriarch of a telenovela. Slate-grey and charcoal ' +
      'plumage streaked through with white age, a heavy dark red comb that falls to one ' +
      'side, sharp pale yellow eyes with heavy lids, a severe hard-set face. She wears a ' +
      'high-collared black lace mourning gown buttoned to the throat, a black jet brooch ' +
      'at the collar, and a black lace mantilla over her head.',
    note:
      'Doña Perpetua — the old hen with slate-grey and charcoal plumage streaked with white, ' +
      'sharp yellow eyes, a heavy dark red comb falling to one side, a high-collared black ' +
      'lace mourning gown and a black lace mantilla. Her voice is low, dry, aristocratic and ' +
      'perfectly calm; she never raises it.',
    line: 'Me llamo Perpetua Alcántara. He enterrado a dos maridos y a un hijo, y no me interesa tu compasión.',
    direction: 'old, low, dry and aristocratic; slow and perfectly level, weight on every word, never raised',
  },
};

// ---------------------------------------------------------------------------
// The set
// ---------------------------------------------------------------------------
//
// The plate is shot empty and from the scene's own side of the line, in the
// scene's own light. It is the geography and the grade in one image, and it
// is cheaper and far more reliable than describing a room twice.

export const LOCATION = {
  key: 'comedor',
  sheet:
    'The formal dining room of an old Mexican hacienda at night, photographed empty with ' +
    'no people in it. A long dark polished mahogany table running away from the camera, a ' +
    'tall wrought-iron candelabra standing on the table with five lit candles, heavy carved ' +
    'high-backed chairs. Whitewashed stucco walls with a dark oil portrait in a heavy gilt ' +
    'frame hanging on the back wall. A tall arched window on the left with rain running down ' +
    'the glass and cold blue night beyond it.',
  note:
    'the hacienda dining room at night — long dark polished table, a five-candle wrought-iron ' +
    'candelabra burning on it, whitewashed stucco walls, a dark oil portrait in a gilt frame ' +
    'behind, a tall arched window with rain on the glass',
};

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------
//
// Two shots, covered the way this exchange would actually be covered: a
// two-shot that establishes who is sitting where and carries the accusation,
// then a reverse single that lets the reaction land. They are written to be
// cut, so each one runs longer than it needs to and holds still at its head
// and tail — those are the editor's handles, and a shot generated at exactly
// its cut length gives you nothing to trim into.
//
// `refs` names the reference stack in the order it is uploaded, so @Image1
// here is @Image1 in the prompt. Shot two additionally chains the finished
// first shot as @Video1, which is the cheapest continuity we have: it carries
// faces, wardrobe, room, lighting, palette AND the voices in one artefact,
// and passing a video reference also drops the model's per-second price.

export const SHOTS = [
  {
    id: 'a-dosdisparos',
    slate: '1A — the two-shot',
    duration: '6',
    // Marks into the generated clip. The model reliably spends the first
    // second settling — a small drift before the performance starts — so the
    // head handle is where that goes.
    cut: { in: 0.9, out: 5.6 },
    images: ['rosalinda', 'perpetua', 'comedor'],
    // Both are cast by voice even though only Perpetua speaks here: it costs
    // nothing to keep a character's voice pinned in a shot they are silent in,
    // and it means the next shot inherits a consistent read either way.
    audios: ['rosalinda', 'perpetua'],
    videos: [],
    lines: [
      { speaker: 'perpetua', es: 'Esta hacienda nunca fue de tu madre.', en: 'This hacienda was never your mother\u2019s.' },
    ],
    action: `SHOT: A single continuous shot with no cuts, no scene changes and no camera cuts of any kind.

Medium two-shot across the corner of the table, camera at seated eye height. Doña Perpetua sits at the head of the table on the RIGHT of frame, turned to face LEFT. Rosalinda sits along the near side of the table on the LEFT of frame, turned to face RIGHT. The lit candelabra stands between them, a little behind the line between their faces. Both are fully inside the frame from the waist up.

0–2s: They hold a long silence. Doña Perpetua looks steadily at Rosalinda. Rosalinda waits, her hands folded in front of her. The candle flames lean and recover. Rain runs down the window behind them.
2–4s: Doña Perpetua lays two fingers on a folded, yellowed document and slides it slowly across the polished tabletop towards Rosalinda. Without raising her voice, level and cold, she says in Spanish: "Esta hacienda nunca fue de tu madre."
4–6s: Rosalinda's hand comes down flat on the document and stops it dead. She does not look down at it and she does not look away from Doña Perpetua. Distant thunder rolls. Hold.

CAMERA: Locked off on sticks with an almost imperceptible slow push in. No handheld shake, no whip pan, no orbit, no crash zoom, no rack focus.`,
  },
  {
    id: 'b-reverso',
    slate: '1B — the reverse single',
    duration: '6',
    // Out shortly after her question lands. The beat before the answer is
    // played at the head of 1C, where Perpetua lets it sit — holding it at
    // both ends would double the pause.
    cut: { in: 0.2, out: 5.7 },
    // Perpetua is deliberately NOT referenced here. She is off-camera in this
    // shot, and every reference competes for influence — handing the model a
    // full-body sheet of a character it is being told not to show is the
    // surest way to have her turn up in frame anyway. Her voice continuity
    // rides on @Video1 instead, which is where it belongs.
    images: ['rosalinda', 'comedor'],
    // Rosalinda's voice now comes from her own plate rather than from whatever
    // the previous shot happened to contain. @Video1 stays, but only for the
    // picture — light, grade, wardrobe, room.
    audios: ['rosalinda'],
    videos: ['a-dosdisparos'],
    // Split where she actually breaks, not where the sentence does. The
    // detector finds a 0.76s pause on the ellipsis, and a subtitle that sat
    // across it would put the question on screen before she has asked it.
    lines: [
      { speaker: 'rosalinda', es: 'Entonces\u2026', en: 'Then\u2026' },
      { speaker: 'rosalinda', es: '\u00bfde qui\u00e9n es?', en: 'whose is it?' },
    ],
    action: `SHOT: A single continuous shot with no cuts, no scene changes and no camera cuts of any kind. This is the reverse angle of the same conversation, a new camera setup — a straight cut to a tighter lens on Rosalinda, not a continuation of the previous camera move.

Medium close-up of Rosalinda alone, from the chest up, framed a little LEFT of centre with empty lookroom to the RIGHT, facing RIGHT out of frame towards Doña Perpetua, who is not visible. Behind her, thrown well out of focus, the candle flames and the dark portrait on the stucco wall.

0–1.5s: She is still holding the document flat under her hand, still looking off right. Her jaw sets. She draws one slow breath.
1.5–3s: She looks down and lifts the document into the light of the candles, unfolding it. Her eyes move as she reads. The amber light climbs her face. Her expression goes from control to disbelief.
3–4.5s: She lifts her eyes back off the page and looks off RIGHT again, and asks in Spanish, quietly, barely steady: "Entonces… ¿de quién es?" This line must be completely finished by 4.5s.
4.5–6s: She says nothing further. She holds the look off right, waiting for an answer that does not come. Distant thunder. The candle flames shudder. Hold on her face in silence to the last frame.

CAMERA: Slow steady push in on sticks, tightening a little through the shot. No handheld shake, no whip pan, no orbit, no crash zoom.`,
  },
  {
    id: 'c-respuesta',
    slate: '1C — the answer',
    duration: '6',
    cut: { in: 0.4, out: 6.0 },
    images: ['perpetua', 'comedor'],
    // The whole argument for voice plates, run as an experiment. Perpetua last
    // spoke two shots ago; the shot immediately before this one does not
    // contain her at all, so there is nothing in @Video1 for her voice to be
    // inherited from. If she still sounds like herself here, the plate is
    // doing the work and voice continuity has stopped depending on coverage.
    audios: ['perpetua'],
    videos: ['b-reverso'],
    lines: [
      { speaker: 'perpetua', es: 'Es m\u00eda, Rosalinda.', en: 'It is mine, Rosalinda.' },
      { speaker: 'perpetua', es: 'Siempre lo fue.', en: 'It always was.' },
    ],
    action: `SHOT: A single continuous shot with no cuts, no scene changes and no camera cuts of any kind. This is the answering reverse — a straight cut back across the table to Doña Perpetua, a new camera setup.

Medium close-up of Doña Perpetua alone, from the chest up, framed a little RIGHT of centre with empty lookroom to the LEFT, facing LEFT out of frame towards Rosalinda. Rosalinda is NOT visible anywhere in this shot. Behind Doña Perpetua, thrown well out of focus, the dark oil portrait in its gilt frame on the stucco wall.

0–1.5s: She lets the question sit unanswered. She does not blink. The candlelight moves on the black lace at her throat.
1.5–3.5s: Without any change of expression, quietly and with complete certainty, she says in Spanish: "Es mía, Rosalinda. Siempre lo fue." This line must be completely finished by 3.5s.
3.5–6s: She says nothing more. The faintest tightening at the corner of her beak — not quite satisfaction. She holds the look off left. Distant thunder. Hold on her face in silence to the last frame.

CAMERA: Locked off on sticks with a very slow push in. No handheld shake, no whip pan, no orbit, no crash zoom.`,
  },
];

// ---------------------------------------------------------------------------
// The prompt builder
// ---------------------------------------------------------------------------
//
// One function, so the spine is provably identical between shots and the
// reference labels are provably in sync with what was actually uploaded.
// fal's own advice is to say what each reference is *for* rather than trust
// the model to infer it, so every @ token gets an explicit role sentence.

export function buildPrompt(shot) {
  const lines = [];

  shot.images.forEach((key, i) => {
    const tag = `@Image${i + 1}`;
    if (key === LOCATION.key) {
      lines.push(`${tag} is the set: ${LOCATION.note}. Use it for the room's architecture, its layout, its lighting and its colour palette. It is photographed empty — do not put the characters where they are not.`);
    } else {
      const c = CAST[key];
      lines.push(`${tag} is a character reference sheet for ${c.note} Match this character's face, plumage colour, costume and proportions exactly.`);
    }
  });

  // Voice references. Labelled hard, because this is the one reference whose
  // purpose the model is most likely to guess wrong: an audio file handed over
  // without explanation is as easily read as "put this sound in the scene" as
  // "make the character sound like this".
  shot.audios.forEach((key, i) => {
    const c = CAST[key];
    lines.push(`@Audio${i + 1} is a voice sample of ${c.name}, recorded on its own. It is the reference for HOW ${c.name} SOUNDS — the pitch, age, weight, accent and pace of their speaking voice. ${c.name} must sound exactly like this sample whenever they speak in this shot. Do NOT play this recording in the scene, do NOT treat its words as dialogue for this shot, and do NOT copy any background from it: use it only to cast the voice.`);
  });

  shot.videos.forEach((_, i) => {
    lines.push(`@Video${i + 1} is the previous shot of this same scene, already filmed. Use it ONLY as the reference for how the characters look and sound, how the room looks, and how it is lit and graded — their faces, their costumes, their speaking voices, the candlelight and the colour. Do NOT continue its camera movement and do NOT repeat the action in it. This is a cut to a new angle later in the same conversation.`);
  });

  return [
    `A scene from a Spanish-language telenovela. All dialogue is spoken in Spanish.`,
    '',
    'REFERENCES:',
    ...lines,
    '',
    shot.action,
    '',
    CONTINUITY,
    '',
    STYLE,
    '',
    LOOK,
    '',
    AUDIO,
  ].join('\n');
}

export const SCENE = {
  id: 's01-testamento',
  title: 'El Testamento',
  aspect_ratio: '16:9',
  resolution: '720p',
  style: STYLE,
  cast: CAST,
  location: LOCATION,
  shots: SHOTS,
  buildPrompt,
};

export default SCENE;
