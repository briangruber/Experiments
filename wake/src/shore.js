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
import { TEX } from './textures.js';

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

/** Clamp to the unit range; this file leans on it constantly. */
function clamp01( x ) {

	return x < 0 ? 0 : x > 1 ? 1 : x;

}

/** GLSL's smoothstep, which JS does not have and this file now needs twice. */
function smoothstep01( a, b, x ) {

	const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

}

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

/**
 * Triplanar sampling, shared by the land and the boulders.
 *
 * Extracted because the boulders were sampling with the IcosahedronGeometry's
 * OWN uvs -- which are badly distorted on a sphere before you start, and worse
 * once every vertex has been carved inward by a dozen random planes. That is
 * what read as blurry and stretched: on a stretched uv the same texels are
 * smeared over more surface, so the rock loses its grain exactly where it is
 * largest and closest. World-space triplanar has no uvs to distort, and it has
 * the side benefit that a boulder and the ledge it sits on line up, because
 * they are being sampled from the same field.
 */
const TRIPLANAR_GLSL = /* glsl */`
vec3 triW( vec3 n ){
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}
vec4 noTile( sampler2D samp, vec2 uv ){
  float k = fract( sin( dot( floor( uv * 0.25 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
  float l = k * 8.0;
  float f = fract( l );
  float ia = floor( l ), ib = ia + 1.0;
  vec2 offa = sin( vec2( 3.0, 7.0 ) * ia );
  vec2 offb = sin( vec2( 3.0, 7.0 ) * ib );
  vec2 dx = dFdx( uv ), dy = dFdy( uv );
  vec4 ca = textureGrad( samp, uv + 0.4 * offa, dx, dy );
  vec4 cb = textureGrad( samp, uv + 0.4 * offb, dx, dy );
  return mix( ca, cb, smoothstep( 0.2, 0.8, f - 0.1 * dot( ca.rgb - cb.rgb, vec3( 1.0 ) ) ) );
}
vec4 triSample( sampler2D t, vec3 p, vec3 w ){
  return noTile( t, p.zy ) * w.x
       + noTile( t, p.xz ) * w.y
       + noTile( t, p.xy ) * w.z;
}

float lhash( vec2 p ){
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float lnoise( vec2 p ){
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( lhash( i ), lhash( i + vec2( 1, 0 ) ), f.x ),
              mix( lhash( i + vec2( 0, 1 ) ), lhash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float lfbm( vec2 p ){
  return lnoise( p ) * 0.6 + lnoise( p * 2.7 ) * 0.3 + lnoise( p * 6.1 ) * 0.1;
}

// HEIGHT BLEND, from Nathan Pointer's terrain material -- the single biggest
// difference between two textures fading into each other and two MATERIALS
// meeting. A linear mix makes sand a translucent wash lying over rock; a height
// blend lets whichever surface stands PROUD win the pixel, so sand settles into
// the rock's crevices and the rock's high points stay bare, with an interlocking
// edge instead of a soft gradient. Each texture's own luminance stands in for
// its height, which is what the reference does with a per-surface displacement
// map -- this has none to hand, and luminance is a decent proxy in stone.
vec3 heightBlend( vec3 a, vec3 b, float w, float sharp ){
  float ha = dot( a, vec3( 0.299, 0.587, 0.114 ) ) + ( 1.0 - w );
  float hb = dot( b, vec3( 0.299, 0.587, 0.114 ) ) + w;
  float m = max( ha, hb ) - max( sharp, 0.01 );
  float wa = max( ha - m, 0.0 ), wb = max( hb - m, 0.0 );
  return ( a * wa + b * wb ) / max( wa + wb, 1e-4 );
}

// MACRO VARIATION, also from that write-up. Tiling does not only show as a
// repeat -- it shows as a FLATNESS, every square metre carrying the same mean
// brightness. Two scales an order apart, one lifting broadly and one darkening
// finely, put slow patches of light and shade across the whole landscape, which
// is what a real hillside has and what the eye reads as size.
float macroVar( vec2 world, float scale ){
  return lfbm( world * scale * 0.25 ) / 3.0 + 1.4 - lfbm( world * scale * 4.0 );
}
`;

export class Shore {

	/**
	 * @param {object} o
	 * @param {number} o.bay      mean radius of open water, metres
	 * @param {number} o.rugged   how far the coastline wanders from that mean
	 * @param {number} o.relief   height of the rock above the waterline
	 * @param {number} o.seed
	 *
	 * `trees` and `relief` are gone with the land they belonged to.
	 */
	constructor( { bay = 300, rugged = 1, boulders = 1200, seed = 12 } = {} ) {

		this.bay = bay;
		this.rugged = rugged;
		this.seed = seed;
		this.group = new THREE.Group();

		// NO LAND, and no pines on it. What was here was a full terrain system --
		// a triplanar-textured land mesh climbing out of the water with instanced
		// trees on it -- and it was the worst-looking thing in the scene: blurred,
		// stretched and blotchy at every range. The bathymetry it was built on is
		// the good part and it stays, because depth IS the colour of a lagoon.
		// So: a seafloor, and the rocks standing in it. Nothing above the water.
		this._buildBoulders( boulders );

	}

	// ------------------------------------------------------------ the coast --
	//
	// The waterline is a radius that wanders with angle. Two octaves: a slow one
	// that carves the bay's headlands and points, and a faster one that makes
	// the rock jagged at the scale you actually stand next to. Sampling it by
	// ANGLE rather than by position is what keeps the bay a bay -- a coastline
	// from raw 2D noise closes into islands and lakes, which is a different
	// place entirely.
	/**
	 * Mean coast radius. Cached: it is a fixed property of the coastline, and
	 * the bathymetry asks for it at every vertex and every texel.
	 */
	_coastMean() {

		if ( this._cmean === undefined ) {
			let sum = 0;
			const N = 256;
			for ( let i = 0; i < N; i ++ ) sum += this.coastAt( i / N * Math.PI * 2 );
			this._cmean = Math.max( sum / N, 1 );
		}
		return this._cmean;

	}

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

		// Nothing emerges. The shape below can still throw a reef head or a
		// rough patch above zero, and with no land mesh to stand on those would
		// read as bare bright specks where the bed shader clamps them to five
		// centimetres of water. Deeper than the hull's draft, too, so the
		// grounding check in confine() is dead rather than dragging everywhere.
		return Math.min( this._bedAt( x, z ), - 0.9 );

	}

	/** The raw bathymetry, unclamped. */
	_bedAt( x, z ) {

		const s = this.seed;
		const d = Math.hypot( x, z ) || 1e-4;
		const coast = this.coastAt( Math.atan2( x, z ) );
		// Metres inland (positive) or seaward (negative) of the waterline.
		const t = d - coast;

		// Rock, roughened at two scales. The finer one is what makes the edge
		// read as broken volcanic rock rather than as a smooth ramp.
		const rough = ( fbm( x * 0.018 + 40, z * 0.018 - 20, 4, s + 13 ) - 0.5 ) * 2;
		const fine = ( fbm( x * 0.085 - 9, z * 0.085 + 31, 3, s + 91 ) - 0.5 ) * 2;
		// A third octave at half-metre scale, RIDGED (folded about zero and
		// inverted) rather than smooth. Smooth noise of any amplitude reads as
		// dough; the sharp creases between folds are what make rock look broken
		// instead of moulded, and they are the whole difference between this
		// and a beanbag.
		const grain = 1 - Math.abs( fbm( x * 0.42 + 5, z * 0.42 - 13, 3, s + 303 ) * 2 - 1 );

		if ( t <= 0 ) {
			// SEAWARD -- a FRINGING LAGOON, not a quarry edge.
			//
			// The old profile hit -10 m twenty-six metres off the rocks and
			// bottomed out at -26 m by fifty. That is a cliff, and it is why the
			// water read as a swimming pool with a deep end: the shallow zone was
			// a fifteen-metre fringe, so the eye never got the long pale-to-deep
			// ramp that IS the look of a tropical lagoon. Depth is the colour.
			//
			// Three terms, in fractions of the bay's own radius so the shape holds
			// whatever size the bay is set to: a quick drop off the rocks to knee
			// depth, a long almost-flat lagoon floor, and then the reef edge
			// falling away into blue.
			const u = - t;                       // metres in from the waterline
			const f = u / Math.max( coast, 1 );  // 0 at the rocks, 1 at the centre
			// The shelf itself is COAST-RELATIVE, which is right: it should
			// follow every headland and cove, and near the rocks it does.
			const prof = 1.0 * ( 1 - Math.exp( - u / 12 ) )
				+ 3.6 * smoothstep01( 0, 0.55, f );

			// THE BASIN IS NOT, and this is what put a starburst in the middle
			// of the bay. coastAt() is a function of ANGLE ALONE -- that is what
			// keeps a bay a bay rather than letting it close into islands -- but
			// world-space angular gradient blows up as you approach the origin,
			// so any depth carrying coast(ang) paints its noise across the
			// centre as radial spokes. The old profile hid this by clamping at
			// -26 m, which saturated the middle flat; taking the clamp off is
			// what let the angle through.
			//
			// So the deep end drops on ABSOLUTE distance against the bay's mean
			// radius instead. A smooth circular ramp with no noise in it is
			// invisible, where the same ramp built from coast(ang) is a wheel.
			const basin = 21;
			// Warped by POSITION, never by angle. A ramp on distance alone is
			// still a circle -- softer than the mesh seam was, but a circle --
			// and the eye finds one in open water instantly. Two-dimensional
			// noise wanders the reef edge by a couple of dozen metres so it
			// reads as a drop-off rather than a rim, and because it is sampled
			// at (x, z) rather than at an angle it cannot come to a point at
			// the origin the way coast(ang) does.
			const warp = ( fbm( x * 0.0042 + 210, z * 0.0042 - 90, 3, s + 401 ) - 0.5 ) * 2;
			const rel = d / this._coastMean() * ( 1 + warp * 0.17 );
			const toBasin = smoothstep01( 0.50, 0.15, rel );
			const shelf = - ( prof + ( basin - prof ) * toBasin );
			// Coral heads and rubble stand proud of the shelf. These reach much
			// further out than they did (42 m -> 110 m): the dark patches scattered
			// across a bright bottom are half of what sells clear water, and they
			// were dying out before the shelf even levelled off.
			const boulders = Math.max( 0, fine ) * 2.6 * Math.exp( t / 110 );
			return shelf + rough * 1.1 * Math.exp( t / 150 ) + boulders
				+ grain * 0.55 * Math.exp( t / 70 );
		}

		// BEYOND THE OLD WATERLINE. There is no land here any more, so the bed
		// does the only sensible thing: it keeps going.
		//
		// Every coefficient below is the seaward branch's own, mirrored in t, so
		// the two halves meet exactly at t = 0 -- at the waterline the outer
		// slope is zero and the three noise terms are at full strength, which is
		// precisely what the shelf returns there. Getting this wrong puts a
		// circular step right where the eye is already looking for a coastline.
		//
		// Outward it settles onto a bank about nine metres down rather than
		// climbing, so what used to be beach and headland is now the pale
		// shallow ring around the lagoon, with the reef heads thinning out
		// across it.
		const outer = 9.0 * ( 1 - Math.exp( - t / 140 ) );
		const heads = Math.max( 0, fine ) * 2.6 * Math.exp( - t / 110 );
		return - outer + rough * 1.1 * Math.exp( - t / 150 ) + heads
			+ grain * 0.55 * Math.exp( - t / 70 );

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

		const mottle = fbm( x * 0.13, z * 0.13, 3, s + 7 )
			* 0.62 + fbm( x * 0.9 + 17, z * 0.9 - 4, 2, s + 71 ) * 0.38;
		// Dark basalt through paler weathered limestone.
		const rockMix = Math.min( 1, Math.max( 0, mottle * 1.35 - 0.12 ) );
		let r = 0.115 + rockMix * 0.40, g = 0.112 + rockMix * 0.38, b = 0.105 + rockMix * 0.34;
		// Wet rock is dark rock -- but only in the SPLASH ZONE.
		//
		// This used to be `1 - clamp((h + 0.2)/1.4)`, which is 1 for every
		// height below the waterline, so the entire submerged shelf was carried
		// at 45% brightness. That is what put a broad dark collar right where
		// the reference photo is at its palest, and it is the wrong physics
		// twice over: the darkening of wet rock is a thin-film effect at the
		// waterline, and what is actually down there is not rock anyway.
		// A band that peaks AT the line and falls away both ways.
		const wet = clamp01( 1 - Math.abs( h + 0.1 ) / 0.9 );
		const k = 1 - wet * 0.45;
		r *= k; g *= k; b *= k;

		// Sand on the flats, above the wet band and below the crags.
		const flat = 1 - Math.min( 1, slope / 0.55 );
		const sandBand = Math.min( 1, Math.max( 0, ( h + 2.5 ) / 3 ) )
			* ( 1 - Math.min( 1, Math.max( 0, ( h - 3.5 ) / 5 ) ) );
		const sand = flat * sandBand * ( 0.55 + mottle * 0.45 );
		r += ( 0.80 - r ) * sand; g += ( 0.73 - g ) * sand; b += ( 0.58 - b ) * sand;

		// THE SUBMERGED SHELF is carbonate sand and coral rubble, and it is
		// BRIGHTER than the dry rock above it, not darker. This is the other
		// half of the lagoon's colour: the water only looks that luminous
		// because there is a near-white bottom throwing light back up through
		// it. Steep faces keep their rock -- an outcrop standing off the shelf
		// is dark in the photograph too, and those dark shapes on pale sand are
		// what give the shallows their scale.
		const sub = clamp01( - h / 2.5 );
		const subFlat = 1 - Math.min( 1, slope / 0.75 );
		const bedMix = sub * ( 0.32 + 0.68 * subFlat );
		r += ( 0.78 - r ) * bedMix; g += ( 0.74 - g ) * bedMix; b += ( 0.62 - b ) * bedMix;

		// Vegetation takes the high ground, and only where it could hold on.
		const high = Math.min( 1, Math.max( 0, ( h - 7 ) / 10 ) );
		const green = high * ( 1 - Math.min( 1, slope / 1.15 ) ) * ( 0.6 + mottle * 0.6 );
		// Scrub, not a void. The first values here were a real plant's albedo,
		// which is very dark -- and stacking cavity shading on top of it turned
		// the headland into a silhouette. Foliage in sun reads far lighter than
		// its albedo suggests because most of what you see is light scattered
		// between leaves, not reflected off one.
		r += ( 0.26 - r ) * green; g += ( 0.44 - g ) * green; b += ( 0.17 - b ) * green;

		// Cavity shading. A hollow sees less sky than a crest does, and without
		// it every facet takes the same ambient and the rock flattens out under
		// a high sun -- which is most of why low-poly terrain reads as plastic.
		// Comparing the point against a blur of itself is a cheap standin for
		// how open the sky is above it.
		const wide = ( this.heightAt( x + 7, z ) + this.heightAt( x - 7, z )
			+ this.heightAt( x, z + 7 ) + this.heightAt( x, z - 7 ) ) * 0.25;
		const cavity = Math.min( 1, Math.max( 0, ( h - wide ) * 0.22 + 0.5 ) );
		// Floor raised: this is ambient occlusion, not a shadow, and 0.55 was
		// removing nearly half the light from every hollow before the real
		// shadow map had its say.
		const ao = 0.76 + cavity * 0.34;
		r *= ao; g *= ao; b *= ao;

		out.setRGB( r, g, b );
		return out;

	}

	// ------------------------------------------------------------- boulders --
	//
	// The heightfield cannot make a rock. It has one height per point, so no
	// overhang, no undercut, no boulder sitting ON another -- and at the
	// waterline, where the camera actually gets close, that is the whole
	// character of the reference photograph.
	//
	// The shape method is the one from red-reddington's "100k procedural rocks"
	// (threejs discourse 89578): a SPHERE CARVED BY RANDOM PLANES. That thread
	// polygonises the SDF with marching cubes; carving an icosphere radially
	// gets the same silhouette for a fraction of the code, because a sphere
	// minus a set of half-spaces is star-shaped about its centre -- every ray
	// from the middle crosses the surface exactly once, so the radius along a
	// vertex's own direction IS the SDF. What matters is that the cuts are
	// FLAT: real broken basalt is a set of cleavage planes meeting at sharp
	// arrises, and no amount of smooth noise ever produces that.
	//
	// A soft minimum rounds the arrises slightly, the way weather does.
	_buildBoulders( count ) {

		const rand = rng( this.seed * 31 + 5 );
		const SHAPES = 8;                 // 8 draw calls, as in the thread
		const shapes = [];

		for ( let i = 0; i < SHAPES; i ++ ) {
			const geo = new THREE.IcosahedronGeometry( 1, 3 );
			const cuts = [];
			const nCuts = 14 + Math.floor( rand() * 9 );
			for ( let c = 0; c < nCuts; c ++ ) {
				// Directions from a normalised gaussian-ish triple, so the cuts
				// are evenly spread over the sphere rather than clustered at the
				// poles the way naive spherical angles are.
				let nx = rand() * 2 - 1, ny = rand() * 2 - 1, nz = rand() * 2 - 1;
				const l = Math.hypot( nx, ny, nz ) || 1;
				nx /= l; ny /= l; nz /= l;
				cuts.push( { nx, ny, nz, off: 0.52 + rand() * 0.42 } );
			}
			const pos = geo.attributes.position;
			const v = new THREE.Vector3();
			// Soft min: k is the arris radius, in units of the unit sphere.
			const smin = ( a, b, k ) => {
				const h = Math.max( 0, Math.min( 1, 0.5 + 0.5 * ( b - a ) / k ) );
				return b * ( 1 - h ) + a * h - k * h * ( 1 - h );
			};
			for ( let j = 0; j < pos.count; j ++ ) {
				v.fromBufferAttribute( pos, j ).normalize();
				let r = 1;
				for ( const c of cuts ) {
					const dp = v.x * c.nx + v.y * c.ny + v.z * c.nz;
					if ( dp > 0.02 ) r = smin( r, c.off / dp, 0.07 );
				}
				// A little noise on top so two instances of the same shape do
				// not read as the same rock seen twice.
				r *= 0.94 + 0.12 * fbm( v.x * 3.1 + i * 7, v.z * 3.1 - i * 5, 3, this.seed + i );
				pos.setXYZ( j, v.x * r, v.y * r, v.z * r );
			}
			pos.needsUpdate = true;
			geo.computeVertexNormals();
			shapes.push( geo );
		}

		// One material for all of them, sharing the shore's own rock plates so
		// a boulder and the ledge it sits on are made of the same stone.
		const load = ( uri, srgb ) => {
			const t = new THREE.TextureLoader().load( uri );
			t.wrapS = t.wrapT = THREE.RepeatWrapping;
			t.anisotropy = 8;
			if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
			return t;
		};
		const mat = new THREE.MeshStandardMaterial( {
			normalMap: load( TEX.rock.normal, false ),
			roughness: 0.95, metalness: 0, vertexColors: true, flatShading: true,
		} );
		mat.normalScale.set( 0.9, 0.9 );
		// TRIPLANAR, like the ledge they sit on. The albedo is sampled from
		// world space rather than through the icosphere's own uvs, which are
		// distorted before the SDF carving and mangled after it -- and a
		// stretched uv smears the same texels over more rock, which is exactly
		// the blur that showed up on the biggest, nearest boulders.
		const bRock = load( TEX.rock.albedo, true );
		mat.userData.tex = bRock;
		mat.onBeforeCompile = ( sh ) => {
			sh.uniforms.uRockMap = { value: bRock };
			sh.uniforms.uRockMean = { value: TEX.rock.mean };
			sh.uniforms.uTexScale = { value: 0.34 };
			sh.vertexShader = sh.vertexShader
				.replace( '#include <common>',
					'#include <common>\nvarying vec3 vBPos;\nvarying vec3 vBNrm;' )
				.replace( '#include <worldpos_vertex>', `
					#include <worldpos_vertex>
					// The instance matrix carries each boulder's own placement, and
					// three applies it in project_vertex -- so world space here has
					// to include it explicitly or every rock samples as though it
					// were sitting at the origin.
					mat4 bM = modelMatrix * instanceMatrix;
					vBPos = ( bM * vec4( transformed, 1.0 ) ).xyz;
					vBNrm = normalize( mat3( bM ) * objectNormal );
				` );
			sh.fragmentShader = sh.fragmentShader
				.replace( '#include <common>', `
					#include <common>
					varying vec3 vBPos;
					varying vec3 vBNrm;
					uniform sampler2D uRockMap;
					uniform float uRockMean, uTexScale;
					${ TRIPLANAR_GLSL }
				` )
				.replace( '#include <map_fragment>', `
					vec3 bw = triW( normalize( vBNrm ) );
					vec3 bc = triSample( uRockMap, vBPos * uTexScale, bw ).rgb
					        / max( uRockMean, 0.02 );
					// Modulates the per-instance tint rather than replacing it, so
					// the wetness variation set at placement survives.
					diffuseColor.rgb *= mix( vec3( 1.0 ), bc, 0.85 );
				` );
		};

		// Per shape, an instanced mesh. Placement is a band about the
		// waterline: boulders belong where the sea has been breaking rock, not
		// scattered evenly over a headland.
		const per = Math.ceil( count / SHAPES );
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const e = new THREE.Euler();
		const v3 = new THREE.Vector3();
		const col = new THREE.Color();
		let placed = 0;
		// How far out to sow them, in metres. Wide enough that the field runs
		// past anything you can see from a chase camera, so it never reads as a
		// patch with an edge.
		const FIELD = 2600;
		// The rocks the sea actually breaks on. A boulder drowned in four metres
		// of water never sees a crest, and one sitting well up the beach is only
		// wetted by spray rather than making it, so the sites are the band in
		// between -- and they are collected here, at placement, because this is
		// the only place their world positions and sizes exist together.
		this.splashSites = [];

		for ( const geo of shapes ) {
			const mesh = new THREE.InstancedMesh( geo, mat, per );
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			let n = 0, tries = 0;
			while ( n < per && tries < per * 30 ) {
				tries ++;
				// SCATTERED OVER THE WHOLE BED, not strung along a coastline.
				//
				// They used to be placed on a ring at coastAt(angle) -- correct
				// when there was a shore for them to lie against, and absurd
				// once it was deleted: a perfect circle of cobbles a couple of
				// kilometres across, standing in open water for no reason.
				//
				// Now they are thrown at the sea floor and KEPT WHERE IT IS
				// SHALLOW, which puts them on the banks and leaves the basins
				// clear -- exactly where rock actually outcrops. sqrt on the
				// radius spreads them by area rather than crowding the middle.
				const a = rand() * Math.PI * 2;
				const r = FIELD * Math.sqrt( rand() );
				const x = Math.sin( a ) * r, z = Math.cos( a ) * r;
				const h = this.heightAt( x, z );
				// Only the banks. Anything deeper than this is invisible under
				// the water's own absorption and is pure cost.
				if ( h < - 7.5 ) continue;
				// Squared random again: mostly cobbles, occasionally something
				// you would have to climb over.
				const u = rand();
				const size = 0.35 + u * u * 3.4;
				e.set( rand() * 6.28, rand() * 6.28, rand() * 6.28 );
				q.setFromEuler( e );
				// Squashed: a boulder that has settled is wider than it is tall.
				v3.set( size * ( 0.9 + rand() * 0.5 ), size * ( 0.6 + rand() * 0.4 ),
					size * ( 0.9 + rand() * 0.5 ) );
				// Sunk by a third, so they sit IN the ground rather than on it.
				m.compose( new THREE.Vector3( x, h - size * 0.30, z ), q, v3 );
				mesh.setMatrixAt( n, m );
				// Wet rock is dark rock. Anything near or below the waterline
				// takes the tone the sea gives it -- the thread varies wetness
				// per instance for the same reason, and it is most of what
				// makes a shoreline read as a shoreline.
				const wet = 1 - Math.min( 1, Math.max( 0, ( h + 0.4 ) / 2.2 ) );
				const g = ( 0.62 + rand() * 0.5 ) * ( 1 - wet * 0.45 );
				col.setRGB( g * ( 0.95 + rand() * 0.1 ), g, g * ( 0.94 + rand() * 0.12 ) );
				mesh.setColorAt( n, col );
				// A splash site, if the sea can actually reach this one. Drowned
				// in three metres it never sees a crest; a metre and a bit clear
				// of the water it is wetted by spray rather than making it.
				if ( h > - 3.0 && h < 1.2 && size > 0.55 ) {
					this.splashSites.push( {
						x, z,
						y: Math.max( h + size * 0.55, 0.05 ),
						r: size,
						// The water column over its base, which is the unit the
						// surf's travelling-set phase is measured in -- so a rock
						// can be asked "has the set reached me" in exactly the
						// terms the shader draws the foam line with.
						column: Math.max( - h, 0.05 ),
						armed: false,
					} );
				}
				n ++;
			}
			mesh.count = n;
			mesh.instanceMatrix.needsUpdate = true;
			if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
			this.group.add( mesh );
			placed += n;
		}
		this.boulderCount = placed;

	}

	/**
	 * The bay's floor, baked into a texture for the WATER to read.
	 *
	 * The sea and the shore have been strangers this whole time: the sea draws
	 * its own procedural bed and the land is a mesh laid over it, and nothing
	 * connects them. That is why there is no surf -- the water shader has a
	 * perfectly good shore-break term, and it has been asking the wrong bed how
	 * deep the water is.
	 *
	 * Sampling this height field is the introduction. One 512 map over the bay
	 * is about a metre per texel, which is finer than the break line needs, and
	 * it is computed once: the coast does not move.
	 *
	 * R16F rather than R32F because half floats are linear-filterable in core
	 * WebGL2 -- a NEAREST depth map would step the break line into a staircase
	 * of squares along the whole coast.
	 */
	depthTexture( size = 512 ) {

		const extent = this.bay * 3.4;
		const data = new Uint16Array( size * size );
		// Minimal float32 -> float16, enough for the range this holds.
		const half = ( v ) => {
			const f = new Float32Array( 1 ); const i = new Uint32Array( f.buffer );
			f[ 0 ] = v;
			const x = i[ 0 ];
			const sign = ( x >>> 16 ) & 0x8000;
			let exp = ( ( x >>> 23 ) & 0xff ) - 127 + 15;
			const man = ( x >>> 13 ) & 0x3ff;
			if ( exp <= 0 ) return sign;
			if ( exp >= 31 ) return sign | 0x7c00;
			return sign | ( exp << 10 ) | man;
		};
		for ( let j = 0; j < size; j ++ ) {
			const z = ( j / ( size - 1 ) - 0.5 ) * extent;
			for ( let i = 0; i < size; i ++ ) {
				const x = ( i / ( size - 1 ) - 0.5 ) * extent;
				data[ j * size + i ] = half( this.heightAt( x, z ) );
			}
		}
		const tex = new THREE.DataTexture( data, size, size,
			THREE.RedFormat, THREE.HalfFloatType );
		tex.magFilter = THREE.LinearFilter;
		tex.minFilter = THREE.LinearFilter;
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		tex.needsUpdate = true;
		this.depthTex = tex;
		this.depthExtent = extent;
		return tex;

	}

	/**
	 * Run her aground if she deserves it, and otherwise leave the helm alone.
	 *
	 * Returns 0 always -- the signature is kept so the caller reads the same as
	 * the pond's, which really does have a wall around it.
	 */
	confine( state, dt ) {

		// NOTHING is off limits that the boat can actually float on.
		//
		// This used to steer -- an assist that leaned on the helm from 90 m out
		// and a soft radial clamp behind it. Both are gone. A helm you did not
		// ask for is a helm fighting you, and the radial limit was a circle
		// drawn around a coast that is not a circle: it kept the hull out of
		// bays that are metres deep and let her at headlands that are not.
		//
		// What is left is the one thing that is not a rule but a fact: a hull
		// with water under her goes anywhere, and a hull without stops. Read
		// the bed she is actually over and take the way off her only when the
		// keel is in it. Astern still works from there, so grounding is a thing
		// you back off, not a thing you are trapped by.
		const bed = this.heightAt( state.x, state.z );
		const draft = 0.55;
		if ( bed > - draft ) {
			// Proportional, not a switch: touching bottom drags, burying the
			// keel stops her. Scaled by dt so the rate is frame-independent.
			const dig = Math.min( 1, ( bed + draft ) / 0.9 );
			state.speed *= 1 - Math.min( 0.9, dig * dt / 0.35 );
		}

		return 0;

	}
}
