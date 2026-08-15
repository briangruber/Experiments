// The Tripo-generated cast models, produced by tools/bake-cast.mjs from the
// pristine downloads in company/cast/models/src/. Same shape as the props'
// assets-manifest.js: paths in the module build, data URIs in the bundle, so
// the single file carries its own company.
//
// Four sculpts and three clips serve five characters. The clips are nobody's
// in particular — every character Tripo rigs comes back on the same 41-joint
// skeleton, so one walk fits the cast, and bake-cast strips each retarget down
// to its curves (a Tripo retarget ships as a whole second copy of the
// character, 3.3 MB to carry 2.4 seconds of rotation).
//
// Ricardo is NOT a fifth generation: he reuses Esteban's skinned scene, with
// ricardo-body.jpg — an offline recolor of the same base-colour map — swapped
// in at load. Identical twins are a plot point, and a shared mesh makes it
// literal. Pollito stays procedural: his comedy is squash and puff, which a
// bone rig cannot do.

export const CAST_MODEL_FILES = [
  'esteban.glb',        // el galán
  'rosalinda.glb',      // la inocente
  'valentina.glb',      // la villana
  'don-gallo.glb',      // el patrón
  'anim-idle.glb',      // 15.4s idle — the cast's resting loop
  'anim-walk.glb',      // walk cycle, root drift stripped at load
  'anim-run.glb',       // run cycle, blended in above walking speed
  'ricardo.glb',        // el gemelo — his own sculpt, eyepatch and scar modelled
];

export const CAST_MODELS = Object.fromEntries(
  CAST_MODEL_FILES.map((f) => [f, `./company/cast/models/${f}`]),
);
