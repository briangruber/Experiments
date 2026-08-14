// The episode manifest: which scenes play, in what order, how they get their
// dependencies, where the dialogue wiring comes from, and how the episode is
// cut for export. Everything that used to know a scene by its position knows
// it by id through this object instead — insert a scene into `order` and the
// dialogue, the tools and the trailer all keep pointing at the scenes they
// meant.

import { V, hideAll, baseLook, keyOn, stingCut } from '../../engine/director.js';
import { deg, lerp } from '../../engine/util.js';
import { MARKS } from './marks.js';
import { subtitleCues } from './subtitles.js';
import { LINES } from './dialogue.js';
import * as entrada from './scenes/entrada.js';
import * as preludio from './scenes/preludio.js';
import * as encuentro from './scenes/encuentro.js';
import * as revelacion from './scenes/revelacion.js';
import * as bofetada from './scenes/bofetada.js';
import * as gemelo from './scenes/gemelo.js';
import * as continuara from './scenes/continuara.js';
import * as creditos from './scenes/creditos.js';

// Play order. Each entry is a scene module: { meta, build }.
const PLAY = [entrada, preludio, encuentro, revelacion, bofetada, gemelo, continuara, creditos];

// Where the moon actually renders. The engine's MOON constant points at empty
// back-wall sky — the disc, halo and moon light all sit along +z — so every
// "gazing at the moon" eyeline aimed at nothing, and preludio's moon insert
// would frame black. This episode hands its scenes the corrected position;
// fixing the engine constant is the camera track's call.
const MOON = V(24, 37, 41);

export const episode = {
  id: 'e01-corazon',
  title: 'CORAZÓN DE GALLINA',

  // The metas in play order, and the modules by id. The Director walks
  // `order` and looks each build up in `scenes`.
  order: PLAY.map((s) => s.meta),
  scenes: Object.fromEntries(PLAY.map((s) => [s.meta.id, s])),

  // What every scene's build() closes over: the cast, the staging grammar and
  // the standing marks. The scene modules import nothing — they are handed
  // all of this — so a tool can read their meta without dragging the engine in.
  deps(ctx) {
    return { actors: ctx.actors, V, MOON, hideAll, baseLook, keyOn, stingCut, marks: MARKS, deg, lerp };
  },

  // The script, and the wiring that splices it into a scene's cues by id.
  dialogue: LINES,
  subtitleCues,

  // Cuts for the video export. The trailer is assembled from beats, which is
  // both the right length for social and exactly how the genre advertises
  // itself. Segments are [sceneId, from (scene-seconds), seconds].
  cuts: {
    trailer: {
      label: 'TRÁILER',
      note: '55 s · 720p',
      width: 1280, height: 720,
      segments: [
        ['entrada', 20.5, 6],       // the company, and the title
        ['encuentro', 3.0, 5],      // he walks in
        ['encuentro', 24.0, 5],     // the almost-kiss
        ['encuentro', 37.5, 4],     // the villainess, watching
        ['revelacion', 14.0, 6],    // the cloth comes off the egg
        ['revelacion', 26.0, 5],    // thunder, the patriarch
        ['bofetada', 11.5, 6],      // the slap
        ['gemelo', 12.5, 5],        // the twin
        ['continuara', 3.5, 5],     // the faint
        ['continuara', 28.0, 8],    // the egg hatches, and it looks at you
      ],
    },
    episode: {
      label: 'EPISODIO COMPLETO',
      note: '5:37 · 540p',
      width: 960, height: 540,
      segments: null,     // the whole thing, start to finish
    },
  },
};
