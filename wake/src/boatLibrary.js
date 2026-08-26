// The boats you can choose between.
//
// Five uploaded GLBs, inlined as base64 (see tools/pack-boats.mjs) because the
// artifact is one self-contained file under a CSP that blocks external hosts.
// Nothing here fetches anything.
//
// The job this module actually does is not "load a mesh" — GLTFLoader does
// that — but reconcile five models authored at five arbitrary scales and
// orientations with a simulation that has opinions about both. Everything the
// wake, the spray and the attitude model do is measured in metres from the
// STEM, along the heading, so a model has to be normalised into that frame or
// none of it lines up. That is what fitToHull() below is for.

import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/GLTFLoader.js';
import { BOATS, glbBuffer } from './boatModels.js';
import { get } from './params.js';

export { BOATS };

const loader = new GLTFLoader();

/**
 * Normalise a loaded model into the simulation's frame.
 *
 * Three things have to be true afterwards, and none of them is true of an
 * arbitrary GLB:
 *
 *  · the ORIGIN sits at the stem, on the waterline. The wake field's arc runs
 *    from there, the spray cuts are measured from there, and the trim rotation
 *    pivots about it. A model centred on its own bounding box puts the boat
 *    half a length ahead of its own wake.
 *  · +Z is FORWARD. The heading, the chine normals and the prop lanes all
 *    assume it.
 *  · one unit is one metre, scaled so the hull is exactly boat.length long —
 *    because that number also drives the Froude number, the wetted length and
 *    the arm geometry. A model that is visually 12 m while the physics thinks
 *    it is 9.9 m produces a wake that is subtly wrong everywhere.
 */
function fitToHull( root ) {

	// Work on a fresh group so repeated calls cannot compound their own
	// corrections — the classic way this kind of normalisation drifts.
	const box = new THREE.Box3().setFromObject( root );
	const size = new THREE.Vector3();
	box.getSize( size );

	// The long horizontal axis is the hull's length, whichever way it was
	// authored. Guessing wrong here rotates the boat across its own wake.
	const alongZ = size.z >= size.x;
	if ( ! alongZ ) root.rotation.y = Math.PI / 2;

	const holder = new THREE.Group();
	holder.add( root );

	const fitted = new THREE.Box3().setFromObject( holder );
	const fSize = new THREE.Vector3();
	fitted.getSize( fSize );
	const L = get( 'boat.length' );
	const scale = L / Math.max( fSize.z, 1e-3 );
	holder.scale.setScalar( scale );

	// Re-measure after scaling rather than scaling the first measurement:
	// the rotation above changes which extent is which.
	const final = new THREE.Box3().setFromObject( holder );
	// Origin at the stem, on the waterline. maxZ is the bow once +Z is forward.
	holder.position.x -= ( final.min.x + final.max.x ) * 0.5;
	holder.position.z -= final.max.z;
	// Sit the hull ON the water, not floating above or sunk in it: the model's
	// own lowest point goes a little under, the rest stands proud.
	holder.position.y -= final.min.y + ( final.max.y - final.min.y ) * get( 'boat.draft' );

	return holder;

}

/**
 * Load one model by id. Returns a THREE.Group posed in the simulation's frame.
 * Cached: parsing a GLB is not free and the selector flips between them.
 */
const cache = new Map();

export async function loadBoat( id ) {

	if ( cache.has( id ) ) return cache.get( id );

	const entry = BOATS.find( ( b ) => b.id === id ) || BOATS[ 0 ];
	const gltf = await loader.parseAsync( glbBuffer( entry.glb ), '' );

	const fitted = fitToHull( gltf.scene );
	fitted.traverse( ( o ) => {
		if ( ! o.isMesh ) return;
		o.castShadow = true;
		// The models ship doubleSided, which on a closed hull costs fill for
		// nothing and lets the inside of the far side show through the near.
		if ( o.material ) o.material.side = THREE.FrontSide;
	} );

	// Rebuilding the fit when boat.length changes keeps the drawn hull and the
	// physics on the same number, which is the whole point of fitToHull.
	fitted.userData.scaleTo = () => {
		const L = get( 'boat.length' );
		const box = new THREE.Box3().setFromObject( fitted );
		const size = new THREE.Vector3();
		box.getSize( size );
		if ( Math.abs( size.z - L ) < 0.01 ) return;
		fitted.scale.multiplyScalar( L / Math.max( size.z, 1e-3 ) );
	};

	cache.set( id, fitted );
	return fitted;

}
