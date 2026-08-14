// The Tripo-generated cast models (and the offline-recolored textures cut from
// them), produced by tools/retexture-cast.mjs from company/cast/models/src/.
// Same shape as the props' assets-manifest.js: paths in the module build, data
// URIs in the bundle, so the single file carries its own leading men.
//
// Only the twins ship as models — the bench verdict was 'hybrid'. Ricardo is
// NOT a separate generation: he reuses Esteban's skinned scene (identical twins
// are a plot point; a shared mesh strengthens it) with ricardo-body.jpg, an
// offline recolor of the same base-colour map, swapped in at load.

export const CAST_MODEL_FILES = [
  'esteban-idle.glb',   // skinned scene + 15.4s idle clip — the twins' body
  'esteban-walk.glb',   // walk clip (tracks only; scene ignored)
  'esteban-run.glb',    // run clip, blended in above walking speed
  'ricardo-body.jpg',   // Ricardo's blue/charcoal recolor of the base colour
];

export const CAST_MODELS = Object.fromEntries(
  CAST_MODEL_FILES.map((f) => [f, `./company/cast/models/${f}`]),
);
