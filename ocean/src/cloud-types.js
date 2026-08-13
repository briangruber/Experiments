// Real cloud genera as parameter recipes for the Abyssal sky.
//
// The volumetric engine already spans the classification: the weather field
// carries a cloud-TYPE axis (0 = flat stratiform, 1 = towering cumuliform), the
// height profile has an anvil control (which IS the cumulonimbus silhouette),
// and the cirrus veil is its own high-altitude layer. What was missing were the
// NAMES - the recipes that make "cumulus" mean the puffy fair-weather cloud a
// person recognises, rather than a point in a twelve-dimensional knob space.
//
// The five here are the five on any field guide: cirrus, cumulus, stratus,
// nimbus (as nimbostratus - the featureless rain layer), and cumulonimbus.
// Each recipe is verified by measurement in prototypes/cloud-types.html: sky
// coverage, brightness, uniformity, and vertical development are asserted per
// type, comparatively (a cumulonimbus must reach higher than a cumulus, a
// nimbus must sit darker than a stratus), so a recipe cannot silently drift
// into looking like its neighbour.
//
// Honesty notes, so nobody oversells this:
//   - "Nimbus" here is the look of the rain cloud, not the rain. Nothing
//     precipitates.
//   - These set the CLOUD parameters only. Sun, sea state and everything else
//     stay whatever the active preset says, so cloud types compose with any
//     time of day - a cumulonimbus at golden hour keeps the golden hour.

// Every key a recipe may touch, with the engine default. applyCloudType resets
// these before applying a recipe, so switching cirrus -> stratus does not
// inherit cirrus's emptied deck.
export const CLOUD_DEFAULTS = {
	cloudCoverage: 0.46,
	cloudDensity: 1.0,
	cloudAltitude: 1500.0,
	cloudThickness: 2200.0,
	cloudDetail: 0.6,
	cloudScale: 16000.0,
	cloudShape: 1300.0,
	cloudAnvil: 0.0,
	cirrus: 0.28,
	cirrusAltitude: 8200.0,
	cirrusCurl: 1.0,
	cirrusMask: 3.2,
};

export const CLOUD_TYPES = {

	// High-altitude clouds in cold, thin air, composed mostly of ice crystals.
	// The engine's cirrus IS a dedicated ice-veil layer, so this recipe simply
	// empties the cumulus deck and lets the veil carry the sky: fibrous, hooked
	// by wind shear, patchy on the cluster scale.
	cirrus: {
		cloudCoverage: 0.0,
		cirrus: 0.85,
		cirrusAltitude: 10500,
		cirrusCurl: 1.15,
		cirrusMask: 2.2,
	},

	// Puffy clouds that form in rising air currents. Fair-weather cumulus:
	// broken coverage so blue sky shows between clouds, a crisp condensation
	// base, rounded billowed tops, and enough detail erosion for frayed edges.
	cumulus: {
		cloudCoverage: 0.5,
		cloudAltitude: 1400,
		cloudThickness: 2400,
		cloudShape: 1300,
		cloudDetail: 0.65,
		cloudAnvil: 0.0,
		cirrus: 0.08,
	},

	// Clouds that form in horizontal layers, often blanketing the sky. A thin,
	// low sheet: a SHALLOW slab so it stays a layer rather than a storm, large
	// soft billows and low detail so the underside reads smooth.
	//
	// Coverage runs past 1.0 on purpose. The knob is a threshold slid across the
	// weather noise (thr = 1.04 - coverage * 1.12, cloud-field.js), and at 1.0
	// the threshold still sits inside the noise range, so a "solid overcast" keeps
	// holes wherever the field dips - measured at the probe's rig, 0.96 covered
	// only a quarter of the sky. 1.2 pushes the threshold below the noise floor:
	// the blanket actually closes, which is the one thing a stratus must do.
	stratus: {
		cloudCoverage: 1.2,
		cloudAltitude: 700,
		cloudThickness: 900,
		cloudShape: 2800,
		cloudDetail: 0.25,
		cloudDensity: 1.0,
		cirrus: 0.0,
	},

	// Clouds producing rain or snow - nimbostratus, the featureless dark rain
	// sheet. Same closed blanket as stratus (coverage past 1.0, see above) but
	// THICK and DENSE: the sun's path through the slab is long, so the base sits
	// in its own shadow and the sheet goes heavy and dark. (The look of the rain
	// cloud; nothing precipitates.)
	nimbus: {
		cloudCoverage: 1.4,
		cloudAltitude: 500,
		cloudThickness: 3400,
		cloudShape: 2400,
		cloudDetail: 0.3,
		cloudDensity: 2.2,
		cirrus: 0.0,
	},

	// Dense, tall clouds charged with electricity. The thunderhead: a deep slab
	// for vertical development, the anvil control flattening and spreading the
	// top, dense enough for a dark base under brilliant sunlit tops, and a
	// touch of cirrus for the ice the anvil sheds downwind. Clusters are pulled
	// tighter (cloudScale down from 16 km) so a tower is actually in frame
	// rather than one county over. (No lightning - the charge is the sign's
	// poetry, not a rendered feature.)
	cumulonimbus: {
		cloudCoverage: 0.62,
		cloudScale: 12000,
		cloudAltitude: 800,
		cloudThickness: 6500,
		cloudShape: 1700,
		cloudDetail: 0.6,
		cloudDensity: 1.5,
		cloudAnvil: 0.8,
		cirrus: 0.22,
	},

};

export const CLOUD_TYPE_NAMES = Object.keys( CLOUD_TYPES );

/**
 * Apply a named cloud type onto a params object, resetting every cloud key to
 * its default first so recipes never inherit each other's leftovers.
 *
 * @param {object} params - the live params object (from newParams / applyPreset).
 * @param {string} name - one of CLOUD_TYPE_NAMES, or 'preset' to restore
 *   whatever the active preset had (i.e. undo the override).
 * @returns {object} the same params object.
 */
export function applyCloudType( params, name ) {

	if ( name === 'preset' ) return params;   // caller re-applies their preset

	const recipe = CLOUD_TYPES[ name ];
	if ( ! recipe ) {

		throw new Error( `applyCloudType: unknown cloud type ${ JSON.stringify( name ) }. ` +
			`Known: ${ CLOUD_TYPE_NAMES.join( ', ' ) }` );

	}

	Object.assign( params, CLOUD_DEFAULTS, recipe );
	return params;

}
