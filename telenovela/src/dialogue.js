// The dialogue. Everyone speaks Spanish; the subtitles are the translation.
//
// `who` is an actor key, or 'narrator' for the announcer. `at` is scene-seconds
// and lands on the acting beat the line belongs to — the gesture and the voice
// are the same cue. `id` names the generated clip in audio/ and is stable, so
// tools/voices.mjs only ever regenerates what changed.
//
// Durations are NOT here: they are measured off the rendered audio by
// tools/voices.mjs and written to dialogue-timing.js, because a subtitle that
// outlasts its own voice line looks like a mistake and one that undercuts it is
// unreadable.

// Casting. Esteban and Ricardo deliberately share a voice — she was fooled in
// the dark by a bird who sounded exactly like the one she was waiting for, and
// the audience should be fooled at 4 @13.0 for the same reason. Ricardo's
// settings are pushed harder, which is the only tell.
export const VOICES = {
  // See tools/audio.mjs for why this voice: it is the deepest in the library
  // and the furthest from Don Gallo, who is the other low male in the cast.
  narrator: { voice: 'CE9m1PQE2E76CKUkNL7C', stability: 0.45, style: 0.6, speed: 1.15 },
  rosalinda: { voice: 'gXNPKp01Qauo3Uoh4uUG', stability: 0.4, style: 0.65, speed: 1.0 },
  esteban: { voice: 'PXKsW7gipTrp5MYwyJVZ', stability: 0.45, style: 0.5, speed: 1.0 },
  ricardo: { voice: 'PXKsW7gipTrp5MYwyJVZ', stability: 0.3, style: 0.8, speed: 0.96 },
  valentina: { voice: 'TNI5EQSCUrYwvhb2wpzt', stability: 0.4, style: 0.7, speed: 0.98 },
  donGallo: { voice: '0mAmJOs5QSoLsncK0QRu', stability: 0.5, style: 0.6, speed: 0.92 },
};

export const LINES = [
  // --- PRELUDIO: who she is, what she waits for, and that it was forbidden.
  { id: 'dlg-0a', scene: 1, at: 14.5, who: 'narrator', es: 'Cada noche, Rosalinda espera. Él nunca llega.', en: 'Every night Rosalinda waits. He never comes.' },
  { id: 'dlg-0b', scene: 1, at: 23.5, who: 'narrator', es: 'Don Gallo se lo prohibió. Ella lo sigue amando.', en: 'Don Gallo forbade them. She loves him still.' },
  { id: 'dlg-0c', scene: 1, at: 29.4, who: 'narrator', es: 'Alguien está en el portón…', en: 'Someone is at the gate…' },

  // --- EL ENCUENTRO: he returns; the villainess watches, and has a motive.
  { id: 'dlg-1a', scene: 2, at: 4.8, who: 'narrator', es: 'Esteban. Un año entero sin una palabra.', en: 'Esteban. A whole year without a word.' },
  { id: 'dlg-1b', scene: 2, at: 10.4, who: 'rosalinda', es: '¡Volviste!', en: 'You came back!' },
  { id: 'dlg-1c', scene: 2, at: 26.0, who: 'esteban', es: 'Mañana le pediré su bendición a mi padre.', en: "Tomorrow I will ask my father's blessing." },
  { id: 'dlg-1d', scene: 2, at: 33.8, who: 'narrator', es: 'Valentina. A ella se la prometieron primero.', en: 'Valentina. He was promised to her first.' },
  { id: 'dlg-1e', scene: 2, at: 38.9, who: 'valentina', es: 'Si no puede ser mío, no será de nadie.', en: 'If he cannot be mine, he will be no one’s.' },
  { id: 'dlg-1f', scene: 2, at: 45.5, who: 'valentina', es: 'Pero yo sé lo que ella esconde aquí.', en: 'But I know what she hides here.' },

  // --- LA REVELACIÓN: the egg, and the patriarch who gets to judge it.
  { id: 'dlg-2a', scene: 3, at: 9.5, who: 'valentina', es: '¡Pregúntenle qué guarda bajo ese paño!', en: 'Ask her what she keeps under that cloth!' },
  { id: 'dlg-2b', scene: 3, at: 15.9, who: 'narrator', es: 'Un huevo. Escondido en su propio patio.', en: 'An egg. Hidden in her own courtyard.' },
  { id: 'dlg-2c', scene: 3, at: 19.6, who: 'rosalinda', es: 'Era mi secreto.', en: 'It was to be my secret.' },
  { id: 'dlg-2d', scene: 3, at: 21.8, who: 'esteban', es: 'Rosalinda. ¿De quién es?', en: 'Rosalinda. Whose is it?' },
  { id: 'dlg-2e', scene: 3, at: 29.0, who: 'narrator', es: 'Don Gallo. El padre de Esteban.', en: "Don Gallo. Esteban's father." },
  { id: 'dlg-2f', scene: 3, at: 33.2, who: 'donGallo', es: 'Esteban. Respóndele a tu padre.', en: 'Esteban. Answer your father.' },
  { id: 'dlg-2g', scene: 3, at: 36.4, who: 'esteban', es: 'Se lo juro, padre. No es mío.', en: 'I swear it, father. It is not mine.' },
  { id: 'dlg-2h', scene: 3, at: 39.4, who: 'rosalinda', es: '¿No es tuyo? ¿Entonces qué fui yo para ti?', en: 'Not yours? Then what was I to you?' },

  // --- LA BOFETADA: the misunderstanding, the slap, the plant for the twist.
  { id: 'dlg-3a', scene: 4, at: 0.4, who: 'narrator', es: 'Esa misma noche. La lluvia no ha parado.', en: 'That same night. The rain has not stopped.' },
  { id: 'dlg-3b', scene: 4, at: 5.1, who: 'rosalinda', es: 'Dilo otra vez. En mi cara.', en: 'Say it again. To my face.' },
  { id: 'dlg-3c', scene: 4, at: 8.5, who: 'esteban', es: 'No fui yo. Pregúntale a Valentina.', en: 'It was not me. Ask Valentina.' },
  { id: 'dlg-3d', scene: 4, at: 11.6, who: 'rosalinda', es: 'No hay nadie más. Solo tú.', en: 'There is no one else. Only you.' },
  // The slap itself plays silent. Nothing between here and 17.2.
  { id: 'dlg-3e', scene: 4, at: 17.2, who: 'rosalinda', es: 'Eso fue por cada noche que esperé.', en: 'That was for every night I waited.' },
  { id: 'dlg-3f', scene: 4, at: 23.5, who: 'esteban', es: 'Pregúntale por mi hermano.', en: 'Ask her about my brother.' },
  { id: 'dlg-3g', scene: 4, at: 26.4, who: 'valentina', es: 'Una bofetada, y no moví ni una pluma.', en: 'One slap, and I lifted not a feather.' },

  // --- EL GEMELO MALVADO: the twin, the deduction, the alliance.
  { id: 'dlg-4a', scene: 5, at: 7.0, who: 'esteban', es: 'No. No puede ser.', en: 'No. It cannot be.' },
  { id: 'dlg-4b', scene: 5, at: 9.0, who: 'rosalinda', es: '¡Pero Esteban está ahí!', en: 'But Esteban is right there!' },
  { id: 'dlg-4c', scene: 5, at: 11.0, who: 'donGallo', es: 'Ricardo. Yo te enterré.', en: 'Ricardo. I buried you.' },
  { id: 'dlg-4d', scene: 5, at: 13.4, who: 'ricardo', es: '¿Me extrañaste, hermano?', en: 'Did you miss me, brother?' },
  { id: 'dlg-4e', scene: 5, at: 17.5, who: 'rosalinda', es: 'Esa noche en el portón… era él.', en: 'That night at the gate… it was him.' },
  { id: 'dlg-4f', scene: 5, at: 23.5, who: 'rosalinda', es: 'Nunca fuiste tú. Perdóname.', en: 'It was never you. Forgive me.' },
  { id: 'dlg-4g', scene: 5, at: 30.5, who: 'esteban', es: 'Dejaste que ella creyera que eras yo.', en: 'You let her believe you were me.' },
  { id: 'dlg-4h', scene: 5, at: 39.5, who: 'ricardo', es: 'Todo tal como lo planeamos, mi amor.', en: 'Everything exactly as we planned, my love.' },
  { id: 'dlg-4i', scene: 5, at: 42.6, who: 'rosalinda', es: 'Tú lo sabías. Desde la primera noche.', en: 'You knew. From the very first night.' },

  // --- CONTINUARÁ: the faint, the disinheriting, the cliffhanger.
  { id: 'dlg-5a', scene: 6, at: 1.0, who: 'rosalinda', es: 'El patio… está dando vueltas…', en: 'The courtyard… it is turning…' },
  { id: 'dlg-5b', scene: 6, at: 6.2, who: 'narrator', es: 'Y aun así, es Esteban quien la sostiene.', en: 'And still it is Esteban who catches her.' },
  { id: 'dlg-5c', scene: 6, at: 11.1, who: 'esteban', es: 'Duerme, palomita. Ya nada puede tocarnos.', en: 'Sleep, little dove. Nothing can touch us now.' },
  { id: 'dlg-5d', scene: 6, at: 19.0, who: 'donGallo', es: 'Mi hijo. Mi verdadero hijo ha vuelto.', en: 'My son. My true son has come home.' },
  { id: 'dlg-5e', scene: 6, at: 25.0, who: 'narrator', es: 'Y nadie está mirando el huevo.', en: 'And no one is watching the egg.' },
  { id: 'dlg-5f', scene: 6, at: 33.0, who: 'narrator', es: '¿Y tú de quién eres, pequeño?', en: 'And whose child are you, little one?' },
];
