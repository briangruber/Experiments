// A volcanic lagoon shore, at the scale of the real thing.
//
// The reference is a bay a few hundred metres across: dark jagged rock at the
// waterline, flat sandy-rock shelves dipping under, a green headland curving
// away behind it topped with slender pines. At that scale a ten-metre boat is
// a small craft in a big place, which is the point of building it to scale
// rather than to the boat.
//
// PROCEDURAL, and deliberately so. Every rock here is a displaced grid shaded
// by its own height and slope, which costs a few hundred lines and no memory.
// The alternative -- photographed rock and sand textures -- would have to be
// base64'd into the bundle (a strict CSP blocks fetching anything external),
// and the artifact already carries several megabytes of boat.
//
// The land is ordinary three geometry lit by the same sun, ambient and water
// bounce the boats use, so it sits in the same afternoon as the sea. The sea
// itself knows nothing about the bay: it renders first and writes depth, the
// land renders after and covers it wherever rock stands above the water. What
// stands BELOW the water is the good part -- submerged shelves and boulders
// seen through turquoise, which is most of what makes the reference photo read
// as a lagoon rather than as a coastline.

import * as THREE from 'three';

/** Deterministic everything: a coast that rearranges itself on reload is a tell. */
function rng( seed ) {

	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};

}

// ---------------------------------------------------------------- noise ----
// Value noise with smooth interpolation, and an fbm over it. Cheap, seeded,
// and identical on every machine -- which matters because the trees are placed
// by sampling this on the CPU while the rock is displaced by it, and the two
// have to agree about where the ground is.

function hash2( x, y, seed ) {

	let h = x * 374761393 + y * 668265263 + seed * 2246822519;
	h = ( h ^ ( h >>> 13 ) ) >>> 0;
	h = Math.imul( h, 1274126177 ) >>> 0;
	return ( h ^ ( h >>> 16 ) ) / 4294967296;

}

const smooth = ( t ) => t * t * ( 3 - 2 * t );

function vnoise( x, y, seed ) {

	const xi = Math.floor( x ), yi = Math.floor( y );
	const xf = x - xi, yf = y - yi;
	const u = smooth( xf ), v = smooth( yf );
	const a = hash2( xi, yi, seed ), b = hash2( xi + 1, yi, seed );
	const c = hash2( xi, yi + 1, seed ), d = hash2( xi + 1, yi + 1, seed );
	return ( a * ( 1 - u ) + b * u ) * ( 1 - v ) + ( c * ( 1 - u ) + d * u ) * v;

}

function fbm( x, y, oct, seed ) {

	let f = 0, amp = 0.5, norm = 0;
	for ( let i = 0; i < oct; i ++ ) {
		f += vnoise( x, y, seed + i * 101 ) * amp;
		norm += amp;
		amp *= 0.5;
		x *= 2.03; y *= 1.97;          // irrational-ish, so octaves never line up
	}
	return f / norm;

}

export class Shore {

	/**
	 * @param {object} o
	 * @param {number} o.bay      mean radius of open water, metres
	 * @param {number} o.rugged   how far the coastline wanders from that mean
	 * @param {number} o.relief   height of the rock above the waterline
	 * @param {number} o.trees    pines on the headland
	 * @param {number} o.seed
	 */
	constructor( { bay = 300, rugged = 1, relief = 1, trees = 900, seed = 12 } = {} ) {

		this.bay = bay;
		this.rugged = rugged;
		this.relief = relief;
		this.seed = seed;
		this.group = new THREE.Group();

		this._buildLand();
		this._buildTrees( trees );

	}

	// ------------------------------------------------------------ the coast --
	//
	// The waterline is a radius that wanders with angle. Two octaves: a slow one
	// that carves the bay's headlands and points, and a faster one that makes
	// the rock jagged at the scale you actually stand next to. Sampling it by
	// ANGLE rather than by position is what keeps the bay a bay -- a coastline
	// from raw 2D noise closes into islands and lakes, which is a different
	// place entirely.
	coastAt( ang ) {

		const s = this.seed;
		// Angle wrapped into a circle so the noise meets itself at 2pi rather
		// than seaming there.
		const cx = Math.cos( ang ) * 2.2, cy = Math.sin( ang ) * 2.2;
		const head = ( fbm( cx + 11, cy + 7, 3, s ) - 0.5 ) * 2;      // headlands
		const jag = ( fbm( cx * 5.5 + 3, cy * 5.5 + 19, 3, s + 57 ) - 0.5 ) * 2;
		return this.bay * ( 1 + ( head * 0.26 + jag * 0.07 ) * this.rugged );

	}

	/**
	 * Ground height at a world point, in metres relative to the waterline.
	 *
	 * Negative is submerged. The shape is: a shelf that slopes gently down
	 * under the water for a way out, then falls off; and inland, rock that
	 * climbs fast and roughens as it goes. The flat sandy shelves come from
	 * TERRACING the near-shore band -- quantising the height into steps and
	 * softening them -- which is what limestone and old lava actually do at a
	 * waterline, and what the reference photo shows dipping under the water.
	 */
	heightAt( x, z ) {

		const s = this.seed;
		const d = Math.hypot( x, z ) || 1e-4;
		const coast = this.coastAt( Math.atan2( x, z ) );
		// Metres inland (positive) or seaward (negative) of the waterline.
		const t = d - coast;

		// Rock, roughened at two scales. The finer one is what makes the edge
		// read as broken volcanic rock rather than as a smooth ramp.
		const rough = ( fbm( x * 0.018 + 40, z * 0.018 - 20, 4, s + 13 ) - 0.5 ) * 2;
		const fine = ( fbm( x * 0.085 - 9, z * 0.085 + 31, 3, s + 91 ) - 0.5 ) * 2;

		if ( t <= 0 ) {
			// SEAWARD. A shelf just under the surface, then away. Boulders on
			// the shelf are the submerged rocks the photo is full of.
			const shelf = Math.max( - 1.2 - Math.pow( - t / 26, 1.7 ) * 9, - 26 );
			const boulders = Math.max( 0, fine ) * 2.6 * Math.exp( t / 42 );
			return shelf + rough * 1.1 * Math.exp( t / 60 ) + boulders;
		}

		// LANDWARD. Climbs, with terraced shelves in the first few metres.
		//
		// The climb is modulated by a MASSIF term that varies slowly around the
		// bay: without it every bearing rises to the same height and the land
		// reads as a plateau with a hedge on top rather than as headlands with
		// saddles between them. This is the difference between a wall and a
		// place -- one number, sampled by angle so a headland stays a headland
		// all the way round its point.
		const ang2 = Math.atan2( x, z );
		const massif = 0.35 + 1.5 * fbm( Math.cos( ang2 ) * 1.4 + 60,
			Math.sin( ang2 ) * 1.4 - 30, 3, s + 211 );
		const climb = Math.pow( Math.min( t / 46, 1 ), 0.78 ) * 26 * this.relief * massif;
		const raw = climb + rough * 5.2 * this.relief + fine * 1.5;
		// Terracing, strongest right at the water and gone by the time the rock
		// is properly up: flat shelves dipping in, jagged crags above them.
		const nearShore = Math.exp( - t / 30 );
		const step = 1.9;
		const terraced = Math.round( raw / step ) * step;
		return raw + ( terraced - raw ) * 0.62 * nearShore;

	}

	/** Rock, sand or green, by height and steepness. Twin of the shading a
	 *  photograph does for free. */
	_colourAt( x, z, h, out ) {

		const s = this.seed;
		// Steepness from a small finite difference: flats take sand, faces stay
		// rock. This is the whole reason the shelves read as shelves.
		const e = 2.2;
		const slope = Math.max(
			Math.abs( this.heightAt( x + e, z ) - h ),
			Math.abs( this.heightAt( x, z + e ) - h ) ) / e;

		const mottle = fbm( x * 0.13, z * 0.13, 3, s + 7 );
		// Dark basalt through paler weathered limestone.
		const rockMix = Math.min( 1, Math.max( 0, mottle * 1.35 - 0.12 ) );
		let r = 0.115 + rockMix * 0.40, g = 0.112 + rockMix * 0.38, b = 0.105 + rockMix * 0.34;
		// Wet rock is dark rock: everything within a metre of the water reads
		// several stops down, which is what draws the waterline.
		const wet = 1 - Math.min( 1, Math.max( 0, ( h + 0.2 ) / 1.4 ) );
		const k = 1 - wet * 0.55;
		r *= k; g *= k; b *= k;

		// Sand on the flats, above the wet band and below the crags.
		const flat = 1 - Math.min( 1, slope / 0.55 );
		const sandBand = Math.min( 1, Math.max( 0, ( h + 2.5 ) / 3 ) )
			* ( 1 - Math.min( 1, Math.max( 0, ( h - 3.5 ) / 5 ) ) );
		const sand = flat * sandBand * ( 0.55 + mottle * 0.45 );
		r += ( 0.80 - r ) * sand; g += ( 0.73 - g ) * sand; b += ( 0.58 - b ) * sand;

		// Vegetation takes the high ground, and only where it could hold on.
		const high = Math.min( 1, Math.max( 0, ( h - 7 ) / 10 ) );
		const green = high * ( 1 - Math.min( 1, slope / 1.15 ) ) * ( 0.6 + mottle * 0.6 );
		r += ( 0.16 - r ) * green; g += ( 0.34 - g ) * green; b += ( 0.11 - b ) * green;

		out.setRGB( r, g, b );
		return out;

	}

	// -------------------------------------------------------------- geometry --
	//
	// One grid over the whole bay, displaced. Resolution is set by what the eye
	// resolves at the waterline (a couple of metres per quad) rather than by
	// the extent, and the grid is CENTRED ON THE BAY, not on the camera -- the
	// coast does not move, so neither should its mesh.
	_buildLand() {

		const EXTENT = this.bay * 3.4;    // out past the headlands
		const N = 320;                    // ~3 m quads at a 300 m bay
		const geo = new THREE.PlaneGeometry( EXTENT, EXTENT, N, N );
		geo.rotateX( - Math.PI / 2 );

		const pos = geo.attributes.position;
		const colours = new Float32Array( pos.count * 3 );
		const c = new THREE.Color();

		for ( let i = 0; i < pos.count; i ++ ) {
			const x = pos.getX( i ), z = pos.getZ( i );
			const h = this.heightAt( x, z );
			pos.setY( i, h );
			this._colourAt( x, z, h, c );
			colours[ i * 3 ] = c.r; colours[ i * 3 + 1 ] = c.g; colours[ i * 3 + 2 ] = c.b;
		}
		pos.needsUpdate = true;
		geo.setAttribute( 'color', new THREE.BufferAttribute( colours, 3 ) );
		geo.computeVertexNormals();

		// FLAT shading. Rock is faceted; smoothing the normals across a 3 m quad
		// turns broken lava into a beanbag.
		const mat = new THREE.MeshStandardMaterial( {
			vertexColors: true, roughness: 0.94, metalness: 0, flatShading: true,
		} );
		const mesh = new THREE.Mesh( geo, mat );
		mesh.receiveShadow = true;
		this.group.add( mesh );
		this.land = mesh;

	}

	// ---------------------------------------------------------------- pines --
	//
	// The headland's cover: tall, narrow, and massed. Two instanced meshes --
	// trunks and canopies -- because at this scale there are hundreds of them
	// and they are the difference between a rock and a place.
	_buildTrees( count ) {

		const rand = rng( this.seed * 7 + 3 );
		const trunkGeo = new THREE.CylinderGeometry( 0.16, 0.34, 4.2, 5 );
		const trunkMat = new THREE.MeshStandardMaterial( { color: 0x4a3b2a, roughness: 1 } );
		// Narrow cone: these are the slender pines on the headland, not the
		// round park trees.
		const pineGeo = new THREE.ConeGeometry( 1.55, 9.5, 7 );
		const pineMat = new THREE.MeshStandardMaterial( {
			color: 0xffffff, roughness: 1, flatShading: true,
		} );

		const trunks = new THREE.InstancedMesh( trunkGeo, trunkMat, count );
		const pines = new THREE.InstancedMesh( pineGeo, pineMat, count );
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const v = new THREE.Vector3();
		const col = new THREE.Color();

		let placed = 0, tries = 0;
		const reach = this.bay * 1.7;
		while ( placed < count && tries < count * 40 ) {
			tries ++;
			// Rejection sampling against the ground: trees go where there IS
			// ground high and level enough to hold them, which puts them on the
			// headland and the ridge without anyone placing them there.
			const a = rand() * Math.PI * 2;
			const r = this.bay * 0.9 + rand() * reach;
			const x = Math.sin( a ) * r, z = Math.cos( a ) * r;
			const h = this.heightAt( x, z );
			if ( h < 5.5 ) continue;
			// Cover thins toward the waterline instead of ending on a contour,
			// which is what made the treeline read as a drawn edge.
			if ( rand() > Math.min( 1, ( h - 5.5 ) / 9 ) ) continue;
			const e = 2.5;
			const slope = Math.max(
				Math.abs( this.heightAt( x + e, z ) - h ),
				Math.abs( this.heightAt( x, z + e ) - h ) ) / e;
			if ( slope > 0.85 ) continue;

			// Pines vary a lot in a real stand, and clump: a uniform scatter of
			// identical cones is the tell that reads as a hedge. Squaring the
			// random makes small trees common and tall ones occasional.
			const u = rand();
			const s = 0.55 + u * u * 1.5;
			m.compose( v.set( x, h + 2.1 * s, z ), q, v.clone().set( s, s, s ) );
			trunks.setMatrixAt( placed, m );
			m.compose( v.set( x, h + ( 4.2 + 4.2 ) * s, z ), q,
				v.clone().set( s * ( 0.8 + rand() * 0.4 ), s * ( 0.85 + rand() * 0.5 ), s * ( 0.8 + rand() * 0.4 ) ) );
			pines.setMatrixAt( placed, m );
			// Each its own green, darker with height: the ridge line reads as
			// depth rather than as a stencil.
			col.setHSL( 0.28 + rand() * 0.05, 0.45 + rand() * 0.18,
				0.16 + rand() * 0.10 - Math.min( h, 40 ) * 0.0012 );
			pines.setColorAt( placed, col );
			placed ++;
		}

		trunks.count = placed;
		pines.count = placed;
		trunks.instanceMatrix.needsUpdate = true;
		pines.instanceMatrix.needsUpdate = true;
		if ( pines.instanceColor ) pines.instanceColor.needsUpdate = true;
		this.group.add( trunks, pines );
		this.treeCount = placed;

	}

	/**
	 * Keep a hull in the bay.
	 *
	 * Same two layers the pond used, for the same reason: the assist steers
	 * along the shore before you reach it, and the clamp is the honest backstop
	 * when you drive at a rock anyway. The margin is generous because the coast
	 * is jagged -- the waterline at one bearing is not the waterline at the
	 * next, and clipping a headland at speed is worse than being turned early.
	 */
	confine( state, dt, steerRate ) {

		const d = Math.hypot( state.x, state.z );
		const ang = Math.atan2( state.x, state.z );
		const limit = this.coastAt( ang ) - 22;
		let assist = 0;

		if ( d > limit - 40 && state.speed > 0.2 ) {
			let rel = state.heading - ang;
			rel = ( ( rel + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) - Math.PI;
			const closeness = Math.min( 1, Math.max( 0, ( d - ( limit - 40 ) ) / 40 ) );
			if ( Math.abs( rel ) < Math.PI / 2 ) assist = ( rel >= 0 ? 1 : - 1 ) * steerRate * closeness;
		}

		if ( d > limit ) {
			const k = limit / d;
			state.x *= k;
			state.z *= k;
		}

		return assist;

	}

}
