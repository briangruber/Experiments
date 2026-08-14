// English subtitles. The episode is still wordless — nobody speaks, nothing is
// lip-synced — but a first-time viewer was being asked to infer a year-long
// engagement, a paternity dispute and an evil twin from wing gestures alone.
// These are the surtitles you would get at an opera: who this is, what they
// just decided, why it costs them.
//
// `at` is scene-seconds, matching the cue clock. `dur` is real seconds — the
// title layer runs on the wall clock, so this is literal reading time.
// `narrate: true` marks the six lines the announcer also reads aloud, which are
// the ones that carry information rather than dialogue.

export const SUBTITLES = [
  // PRELUDIO — who she is, what she is waiting for, and that it was forbidden.
  { scene: 0, at: 14.5, dur: 3.5, text: 'Every night Rosalinda waits. He never comes.', vo: 'vo-nar-rosalinda' },
  { scene: 0, at: 23.5, dur: 3.0, text: 'Don Gallo forbade them. She loves him still.' },
  { scene: 0, at: 26.0, dur: 2.5, text: '…someone is at the gate.' },

  // EL ENCUENTRO — he returns; the villainess is watching and has a motive.
  { scene: 1, at: 4.8, dur: 3.0, text: 'Esteban. Gone a year without a word.' },
  { scene: 1, at: 10.4, dur: 2.4, text: 'You came back.' },
  { scene: 1, at: 26.0, dur: 3.0, text: "Tomorrow I will ask my father's blessing." },
  { scene: 1, at: 34.5, dur: 3.5, text: 'Valentina. He was promised to her first.', vo: 'vo-nar-valentina' },
  { scene: 1, at: 38.1, dur: 2.6, text: 'If she cannot have him, no one will.' },
  { scene: 1, at: 43.0, dur: 3.2, text: 'But I know what she hides here.' },

  // LA REVELACIÓN — the egg, and the patriarch who gets to judge it.
  { scene: 2, at: 9.5, dur: 3.0, text: 'Ask her what she keeps under that cloth!' },
  { scene: 2, at: 15.9, dur: 3.0, text: 'An egg. Hidden in her own courtyard.', vo: 'vo-nar-egg' },
  { scene: 2, at: 19.5, dur: 2.0, text: 'It was to be my secret.' },
  { scene: 2, at: 21.5, dur: 2.0, text: 'Rosalinda. Whose is it?' },
  { scene: 2, at: 26.5, dur: 3.0, text: "Don Gallo. Esteban's father. The law here." },
  { scene: 2, at: 33.2, dur: 2.8, text: 'Esteban. Answer your father.' },
  { scene: 2, at: 36.0, dur: 3.0, text: 'I swear it, father. It is not mine.' },
  { scene: 2, at: 38.5, dur: 3.2, text: 'Not yours? Then what was I to you?' },

  // LA BOFETADA — the misunderstanding, the slap, and the plant for the twist.
  { scene: 3, at: 0.0, dur: 3.0, text: 'That same night. The rain has not stopped.' },
  { scene: 3, at: 4.5, dur: 2.4, text: 'Say it again. To my face.' },
  { scene: 3, at: 8.5, dur: 3.0, text: 'It was not me. Ask Valentina.' },
  { scene: 3, at: 10.5, dur: 2.0, text: 'There is no one else. Only you.' },
  { scene: 3, at: 17.2, dur: 3.0, text: 'That was for every night I waited.' },
  { scene: 3, at: 23.5, dur: 2.8, text: 'Ask her about my brother.' },
  { scene: 3, at: 26.0, dur: 2.8, text: 'One slap, and I lifted not a feather.' },

  // EL GEMELO MALVADO — the twin, the deduction, the alliance.
  { scene: 4, at: 7.0, dur: 1.8, text: 'No. It cannot be.' },
  { scene: 4, at: 9.0, dur: 1.9, text: 'But Esteban is right there.' },
  { scene: 4, at: 11.0, dur: 1.8, text: 'Ricardo. I buried you.' },
  { scene: 4, at: 13.0, dur: 2.8, text: 'Did you miss me, brother?' },
  { scene: 4, at: 17.5, dur: 3.2, text: 'That night at the gate… it was him.', vo: 'vo-nar-gate' },
  { scene: 4, at: 23.5, dur: 3.0, text: 'It was never you. Forgive me.' },
  { scene: 4, at: 30.5, dur: 2.8, text: 'You let her believe you were me.' },
  { scene: 4, at: 39.5, dur: 3.0, text: 'Everything exactly as we planned, mi amor.' },
  { scene: 4, at: 42.0, dur: 3.0, text: 'You knew. From the very first night.' },

  // EL DESMAYO — the faint, the disinheriting, and the cliffhanger.
  { scene: 5, at: 1.0, dur: 2.4, text: 'The courtyard… it is turning…' },
  { scene: 5, at: 5.6, dur: 2.6, text: 'And still it is Esteban who catches her.' },
  { scene: 5, at: 12.0, dur: 3.0, text: 'Sleep, little dove. Nothing can touch us now.' },
  { scene: 5, at: 16.0, dur: 3.2, text: 'My son. My true son has come home.' },
  { scene: 5, at: 20.0, dur: 2.5, text: 'And no one is watching the egg.' },
  { scene: 5, at: 33.0, dur: 3.0, text: 'And whose child are you, little one?', vo: 'vo-nar-chick' },
];

// Turn the script into cues the director can splice into its scenes. A
// subtitle is a single slot: showing one dismisses whatever was on screen, so
// a fast volley of reactions reads as a volley rather than a stack.
export function subtitleCues(sceneIndex) {
  return SUBTITLES.filter((s) => s.scene === sceneIndex).map((s) => [
    s.at,
    (c) => {
      c.titles.subtitle(s.text, s.dur);
      if (s.vo) c.score.say(s.vo);
    },
  ]);
}
