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
 * Decode the GLB's embedded textures ourselves, from bytes to ImageBitmap,
 * with no URL in sight.
 *
 * Why: GLTFLoader loads an embedded image by wrapping its bytes in a Blob,
 * minting a blob: URL, and FETCHING it. Locally that is invisible; inside the
 * published artifact it runs under a strict CSP, and a policy that does not
 * allow blob: for images silently kills the fetch -- the model arrives with
 * materials whose map never resolved, and every hull renders base-colour
 * grey. That is why the boats were textured in every local test and grey in
 * the published page: same code, different CSP.
 *
 * createImageBitmap(blob) is a direct decode -- no URL, no fetch, nothing for
 * a network policy to veto -- so the texture is rebuilt from the same bytes
 * and assigned over whatever the loader managed. Where the loader DID succeed
 * this is a no-op visually; where it was blocked, this is the texture.
 */
async function rebuildTextures( glbBytes, root ) {

	const dv = new DataView( glbBytes );
	if ( dv.getUint32( 0, true ) !== 0x46546c67 ) return;   // not a GLB
	const jsonLen = dv.getUint32( 12, true );
	const json = JSON.parse( new TextDecoder().decode(
		new Uint8Array( glbBytes, 20, jsonLen ) ) );
	const binOff = 20 + jsonLen + 8;
	const img = json.images?.[ 0 ];
	if ( ! img || img.bufferView === undefined ) return;
	const bv = json.bufferViews[ img.bufferView ];
	const bytes = new Uint8Array( glbBytes, binOff + ( bv.byteOffset ?? 0 ), bv.byteLength );
	const bitmap = await createImageBitmap(
		new Blob( [ bytes ], { type: img.mimeType || 'image/jpeg' } ),
		// glTF UVs have the origin at the top: no flip, and say so explicitly
		// so the browser cannot apply its own default orientation either way.
		{ imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'default' },
	);
	const tex = new THREE.Texture( bitmap );
	tex.flipY = false;
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.needsUpdate = true;
	root.traverse( ( o ) => {
		if ( o.isMesh && o.material ) {
			o.material.map = tex;
			o.material.needsUpdate = true;
		}
	} );

}

/**
 * True when the model's fine end points backwards along +Z.
 *
 * Bins every vertex by its position along the length and compares the mean
 * half-beam of the forward fifth against the after fifth. The narrower end is
 * the bow. Deliberately uses the extreme fifths rather than halves: amidships
 * is where a hull is fullest either way, so including it drowns the very
 * difference being measured.
 */
function sternIsForward( root ) {

	const v = new THREE.Vector3();
	let fwdW = 0, fwdN = 0, aftW = 0, aftN = 0;
	const box = new THREE.Box3().setFromObject( root );
	const zMin = box.min.z, zMax = box.max.z;
	const span = Math.max( zMax - zMin, 1e-6 );

	root.updateMatrixWorld( true );
	root.traverse( ( o ) => {
		const pos = o.isMesh && o.geometry?.attributes?.position;
		if ( ! pos ) return;
		// Stride: a few thousand samples is plenty to compare two averages, and
		// these meshes run to ~12k vertices each across five models.
		const step = Math.max( 1, Math.floor( pos.count / 2000 ) );
		for ( let i = 0; i < pos.count; i += step ) {
			v.fromBufferAttribute( pos, i ).applyMatrix4( o.matrixWorld );
			const t = ( v.z - zMin ) / span;
			if ( t > 0.8 ) { fwdW += Math.abs( v.x ); fwdN ++; }
			else if ( t < 0.2 ) { aftW += Math.abs( v.x ); aftN ++; }
		}
	} );

	if ( ! fwdN || ! aftN ) return false;
	// Forward end wider than the after end means the model is facing astern.
	return ( fwdW / fwdN ) > ( aftW / aftN ) * 1.05;

}

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
// Per model, because "draft" is not a property of a bounding box.
//
// One absolute depth for every hull is better than a fraction of model height
// (which sank the pirate and flooded the dinghy), but it is still wrong in the
// same direction: an inflatable's floor sits centimetres above its lowest
// point, while a masted ship's keel is a metre below its waterline. These are
// multipliers on the slider, so the slider still moves every boat together and
// the ratios between them stay right.
// Measured against the water, one boat at a time, rather than guessed from the
// bounding box: the first pass at these sat every hull too high -- a burrito
// with 0.53 m of draft showed its whole keel and read as floating ON the sea
// rather than in it, while the inflatable at 0.26 m was already right. A
// canoe's rocker means most of its depth is nowhere near its lowest point, so
// the ratio between "lowest point" and "looks afloat" is a property of the
// model's shape and cannot come from its extents.
const DRAFT = { inflatable: 0.30, burrito: 1.50, racingred: 1.00,
	yacht: 1.05, pirate: 1.15 };
const draftFor = ( id ) => get( 'boat.draft' ) * ( DRAFT[ id ] ?? 1 );

/** How long the drawn hull should be: the physics length times the look knob. */
const drawnLength = () => get( 'boat.length' ) * Math.max( get( 'boat.modelScale' ), 0.05 );

function fitToHull( root, boat = {} ) {

	// Work on a fresh group so repeated calls cannot compound their own
	// corrections — the classic way this kind of normalisation drifts.
	const box = new THREE.Box3().setFromObject( root );
	const size = new THREE.Vector3();
	box.getSize( size );

	// The long horizontal axis is the hull's length, whichever way it was
	// authored. Guessing wrong here rotates the boat across its own wake.
	const alongZ = size.z >= size.x;
	if ( ! alongZ ) root.rotation.y = Math.PI / 2;

	// ...and now WHICH WAY along it. Picking the axis is not enough: half the
	// models face the other way down it, which is how one of them ended up
	// sailing backwards with its wake streaming off the bow.
	//
	// A hull is narrow at the stem and full at the transom, so the answer is in
	// the geometry rather than in any convention: measure the beam at each end
	// and put the fine end forward. That works on a boat that has no metadata
	// saying which way it points, which is all of them.
	if ( sternIsForward( root ) ) root.rotation.y += Math.PI;

	const holder = new THREE.Group();
	holder.add( root );

	const fitted = new THREE.Box3().setFromObject( holder );
	const fSize = new THREE.Vector3();
	fitted.getSize( fSize );
	const L = drawnLength();
	const scale = L / Math.max( fSize.z, 1e-3 );
	holder.scale.setScalar( scale );

	// Re-measure after scaling rather than scaling the first measurement:
	// the rotation above changes which extent is which.
	const final = new THREE.Box3().setFromObject( holder );
	// Origin at the stem, on the waterline. maxZ is the bow once +Z is forward.
	holder.position.x -= ( final.min.x + final.max.x ) * 0.5;
	holder.position.z -= final.max.z;
	// Sit the hull ON the water: its lowest point goes a fixed depth under,
	// and the rest stands proud.
	//
	// This used to be a fraction of the model's own HEIGHT, which sinks a tall
	// model further than a short one for no reason -- and put the sea inside
	// the open boats, whose interior floor sits only a little above their
	// lowest point. A masted pirate boat is three times the height of an
	// inflatable and wants exactly the same draft.
	const draft = draftFor( boat.id );
	holder.position.y -= final.min.y + draft;
	// Remember it: the hull's own draft is the budget the planing lift has to
	// stay inside, and nothing downstream can work that out from a bounding box.
	holder.userData.draft = draft;

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
	const buf = glbBuffer( entry.glb );
	const gltf = await loader.parseAsync( buf, '' );
	// See rebuildTextures: under the artifact's CSP the loader's own texture
	// fetch can be silently blocked, and this is the path that cannot be.
	try { await rebuildTextures( buf, gltf.scene ); }
	catch ( e ) { console.warn( 'texture rebuild failed for', id, e.message ); }

	const fitted = fitToHull( gltf.scene, entry );
	fitted.traverse( ( o ) => {
		if ( ! o.isMesh ) return;
		o.castShadow = true;
		// DoubleSide, forced. This has now been wrong in both directions:
		// forcing FrontSide tore the pirate's sails off entirely (single-sided
		// planes, culled), and leaving the model's own setting alone kept
		// whatever the exporter chose -- and the pirate's sail material ships
		// single-sided, so the sails showed from the bow and vanished from the
		// stern. Cloth has two sides; a closed hull merely pays a little fill.
		if ( o.material ) { o.material.side = THREE.DoubleSide; o.material.needsUpdate = true; }
	} );

	// Re-fit when boat.length or the look knob changes.
	//
	// This is also why an outer scale on the holder did nothing: this runs on
	// every UI change and divides any such scale straight back out, measuring
	// the world box and normalising it to the target. The holder's internal
	// offsets kept the scale, so the boat MOVED without growing. The look knob
	// belongs in the target itself.
	fitted.userData.scaleTo = () => {
		const L = drawnLength();
		const box = new THREE.Box3().setFromObject( fitted );
		const size = new THREE.Vector3();
		box.getSize( size );
		if ( Math.abs( size.z - L ) > 0.01 ) {
			fitted.scale.multiplyScalar( L / Math.max( size.z, 1e-3 ) );
		}
		// Scaling moves the keel: the fit put the hull's lowest point one
		// draft under the water, and multiplying the scale moves that point
		// without moving the offset that placed it. Re-seat it.
		const after = new THREE.Box3().setFromObject( fitted );
		fitted.position.y -= after.min.y + draftFor( entry.id );
		fitted.userData.draft = draftFor( entry.id );
	};

	cache.set( id, fitted );
	return fitted;

}
