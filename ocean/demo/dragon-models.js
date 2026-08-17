// Which sea-monster mesh the demo draws. Physics stays the SeaDragon capsule
// (sdLength / sdSwellRadius); this file is the visual only.
//
// Current: demo/dragonModel.js, baked from 0f2d4c94-Sea_Dragon_Rigged.glb
//   (tools/glb.mjs --forward +z). Nose already on -Z.
// Serpent: models/sea-serpent-rigged.glb, baked to demo/serpentModel.js
//   (--forward -x). Measured on the source: longest axis X (1.81 m), Y-up,
//   head bones + vertex mass at the -X / high-Y end, tail at +X / low-Y.
//   No animation channels (54 bones, bind pose only) — same situation as
//   the current dragon, so the swim stays creature.js's travelling wave.
//
// Both records are unit-length on Z after the bake. buildCraftGeometry
// scales that to sdLength. yaw/lift are metres/radians at that built size;
// both are 0 because the baker already centred the box and put the nose
// on -Z. The serpent's authored pose is a reared head (at 60 m it stands
// ~56 m tall vs the current dragon's ~14 m) — visual swap only, sd* body
// knobs are not retuned per mesh.

import { DRAGON_MESH } from './dragonModel.js';
import { SERPENT_MESH } from './serpentModel.js';

export const SD_MODEL_CURRENT = 'Current';
export const SD_MODEL_SERPENT = 'Sea serpent';
export const SD_MODEL_OPTIONS = [ SD_MODEL_CURRENT, SD_MODEL_SERPENT ];

export const DRAGON_MODELS = {
	[ SD_MODEL_CURRENT ]: {
		id: 'current',
		label: SD_MODEL_CURRENT,
		record: DRAGON_MESH,
		// Source nose was +Z; baker rotated it onto -Z.
		yaw: 0,
		lift: 0,
		// Mouth-corner hinge, as a fraction of sdLength. Measured on the
		// baked mesh at 60 m: corner at y=0.85, z=-22.4. The mandible
		// ends there; creature.js rotates verts below and forward of it.
		jawHY: 0.0142,
		jawHZ: - 0.373,
		// Repo-relative paths, not import.meta.url: the three-demo bundler
		// emits a classic script, and import.meta is a parse error there
		// (check:dragon then never sees window.abyssal).
		source: 'demo/dragonModel.js',
	},
	[ SD_MODEL_SERPENT ]: {
		id: 'serpent',
		label: SD_MODEL_SERPENT,
		record: SERPENT_MESH,
		// Source nose was -X (see file header). Baker rotated it onto -Z.
		yaw: 0,
		lift: 0,
		// Reared-head mouth corner, same units as Current. Measured at
		// 60 m: corner at y=15.6, z=-24.0. A Current hinge would catch
		// the hanging coils, so this is not optional.
		jawHY: 0.260,
		jawHZ: - 0.400,
		source: 'models/sea-serpent-rigged.glb',
	},
};

/** Resolve a settings/preset value (label, id, or leftover 0/1) to a spec. */
export function resolveDragonModel( name ) {

	if ( name === SD_MODEL_SERPENT || name === 'serpent' || name === 1 ) {

		return DRAGON_MODELS[ SD_MODEL_SERPENT ];

	}
	return DRAGON_MODELS[ SD_MODEL_CURRENT ];

}
