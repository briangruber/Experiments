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
	constructor( { bay = 300, rugged = 1, relief = 1, trees = 900, boulders = 1200, seed = 12 } = {} ) {

		this.bay = bay;
		this.rugged = rugged;
		this.relief = relief;
		this.seed = seed;
		this.group = new THREE.Group();

		this._buildLand();
		this._buildTrees( trees );
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
		// A third octave at half-metre scale, RIDGED (folded about zero and
		// inverted) rather than smooth. Smooth noise of any amplitude reads as
		// dough; the sharp creases between folds are what make rock look broken
		// instead of moulded, and they are the whole difference between this
		// and a beanbag.
		const grain = 1 - Math.abs( fbm( x * 0.42 + 5, z * 0.42 - 13, 3, s + 303 ) * 2 - 1 );

		if ( t <= 0 ) {
			// SEAWARD. A shelf just under the surface, then away. Boulders on
			// the shelf are the submerged rocks the photo is full of.
			const shelf = Math.max( - 1.2 - Math.pow( - t / 26, 1.7 ) * 9, - 26 );
			const boulders = Math.max( 0, fine ) * 2.6 * Math.exp( t / 42 );
			return shelf + rough * 1.1 * Math.exp( t / 60 ) + boulders
				+ grain * 0.55 * Math.exp( t / 30 );
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
		const raw = climb + rough * 5.2 * this.relief + fine * 1.5
			+ grain * 1.35 * Math.min( 1, t / 6 );
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

		const mottle = fbm( x * 0.13, z * 0.13, 3, s + 7 )
			* 0.62 + fbm( x * 0.9 + 17, z * 0.9 - 4, 2, s + 71 ) * 0.38;
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

	// -------------------------------------------------------------- geometry --
	//
	// One grid over the whole bay, displaced. Resolution is set by what the eye
	// resolves at the waterline (a couple of metres per quad) rather than by
	// the extent, and the grid is CENTRED ON THE BAY, not on the camera -- the
	// coast does not move, so neither should its mesh.
	_buildLand() {

		// A RADIAL grid, not a square one.
		//
		// The interesting metre of this whole place is the waterline, and a
		// uniform grid spends its vertices evenly over a square kilometre --
		// most of them on flat water-facing nothing, and about three metres of
		// resolution where the rock actually breaks. Rings spaced by a power
		// law put quads a few tens of centimetres apart at the coast and tens
		// of metres out at the horizon, for the same vertex count. That is the
		// difference between broken lava and a smooth ramp.
		const RINGS = 260, SPOKES = 420;
		const INNER = this.bay * 0.55, OUTER = this.bay * 3.4;
		const verts = [], idx = [];
		for ( let i = 0; i <= RINGS; i ++ ) {
			// u^2.6 crowds the rings toward the coast, which sits near u = 0.2.
			const u = i / RINGS;
			const r = INNER + ( OUTER - INNER ) * Math.pow( u, 2.6 );
			for ( let j = 0; j < SPOKES; j ++ ) {
				const a = j / SPOKES * Math.PI * 2;
				verts.push( Math.sin( a ) * r, 0, Math.cos( a ) * r );
			}
		}
		for ( let i = 0; i < RINGS; i ++ ) {
			for ( let j = 0; j < SPOKES; j ++ ) {
				const j1 = ( j + 1 ) % SPOKES;
				const a = i * SPOKES + j, b = i * SPOKES + j1;
				const c = ( i + 1 ) * SPOKES + j, d = ( i + 1 ) * SPOKES + j1;
				idx.push( a, c, b, b, c, d );
			}
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.Float32BufferAttribute( verts, 3 ) );
		geo.setIndex( idx );

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

		// Photographic rock and sand, projected TRIPLANAR.
		//
		// Flat shading and vertex colours got the silhouette right and stopped
		// there: a facet with one colour cannot look like stone at any polygon
		// count, because what the eye reads as rock is surface relief far below
		// the geometry. A normal map supplies exactly that, for free.
		//
		// Triplanar rather than UV, because this mesh has no sensible UVs -- it
		// is a radial grid of a heightfield, so a planar projection stretches
		// into streaks down every cliff, which is the classic terrain-texturing
		// tell. Projecting from all three axes and blending by the normal costs
		// three samples and never stretches.
		//
		// The vertex colour survives as a TINT over the photograph, so the
		// wet-rock band, the sand on the flats and the green on the tops all
		// still come from the height-and-slope logic above.
		const load = ( uri, srgb ) => {
			const t = new THREE.TextureLoader().load( uri );
			t.wrapS = t.wrapT = THREE.RepeatWrapping;
			t.anisotropy = 8;
			if ( srgb ) t.colorSpace = THREE.SRGBColorSpace;
			return t;
		};
		const uni = {
			uRockMap: { value: load( TEX.rock.albedo, true ) },
			uRockNrm: { value: load( TEX.rock.normal, false ) },
			uSandMap: { value: load( TEX.sand.albedo, true ) },
			uSandNrm: { value: load( TEX.sand.normal, false ) },
			uTexScale: { value: 0.34 },       // repeats per metre
			uNormalAmt: { value: 1.15 },
			// Each photograph divided by its own mean luminance, so it
			// modulates around 1 instead of dragging everything toward its own
			// brightness. Basalt averages 0.23 -- multiplying by that directly
			// turned the whole headland into a silhouette.
			uRockMean: { value: TEX.rock.mean },
			uSandMean: { value: TEX.sand.mean },
		};
		const mat = new THREE.MeshStandardMaterial( {
			vertexColors: true, roughness: 0.93, metalness: 0, flatShading: false,
		} );
		mat.onBeforeCompile = ( sh ) => {
			Object.assign( sh.uniforms, uni );
			sh.vertexShader = sh.vertexShader
				.replace( '#include <common>',
					'#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;' )
				.replace( '#include <worldpos_vertex>',
					'#include <worldpos_vertex>\n\tvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvWNrm = normalize( mat3( modelMatrix ) * objectNormal );' );
			sh.fragmentShader = sh.fragmentShader
				.replace( '#include <common>', `#include <common>
					varying vec3 vWPos;
					varying vec3 vWNrm;
					uniform sampler2D uRockMap, uRockNrm, uSandMap, uSandNrm;
					uniform float uTexScale, uNormalAmt, uRockMean, uSandMean;
					// Blend the three axis projections by how much the surface
					// faces each one. The power sharpens the transition so the
					// seams between projections stay narrow.
					vec3 triW( vec3 n ){
					  vec3 w = pow( abs( n ), vec3( 4.0 ) );
					  return w / max( w.x + w.y + w.z, 1e-4 );
					}
					vec4 triSample( sampler2D t, vec3 p, vec3 w ){
					  return texture2D( t, p.zy ) * w.x
					       + texture2D( t, p.xz ) * w.y
					       + texture2D( t, p.xy ) * w.z;
					}` )
				.replace( '#include <map_fragment>', `
					vec3 tw = triW( normalize( vWNrm ) );
					vec3 tp = vWPos * uTexScale;
					// Flat and low takes sand; anything steeper or higher is
					// rock. The same rule the vertex colours use, so the
					// photograph and the tint agree about where the sand is.
					float sandK = smoothstep( 0.55, 0.9, normalize( vWNrm ).y )
					            * ( 1.0 - smoothstep( 1.5, 7.0, vWPos.y ) );
					// TWO SCALES, not one.
					//
					// A single 512 plate at one repeat is the classic texture
					// tell: the eye finds the period within a second or two and
					// the cliff turns into wallpaper. Sampling the same plate
					// again eight times larger and multiplying gives macro
					// blotching that never lines up with the fine detail, so the
					// repeat has nothing to lock onto. Costs one extra fetch.
					vec3 rockFine = triSample( uRockMap, tp, tw ).rgb / max( uRockMean, 0.02 );
					vec3 rockMacro = triSample( uRockMap, tp * 0.125, tw ).rgb / max( uRockMean, 0.02 );
					vec3 rockC = rockFine * mix( vec3( 1.0 ), rockMacro, 0.55 );
					vec3 sandC = triSample( uSandMap, tp * 0.7, tw ).rgb / max( uSandMean, 0.02 );
					vec3 texC = mix( rockC, sandC, sandK );
					// The photograph MODULATES the computed colour rather than
					// replacing it, and it is normalised to average 1, so it
					// darkens creases and lifts crests without shifting the
					// overall tone the height-and-slope logic chose.
					diffuseColor.rgb *= mix( vec3( 1.0 ), texC, 0.82 );
					// Wet rock is GLOSSY. Everything within the splash zone
					// takes a specular sheen the dry crags above it do not,
					// and that difference is most of what reads as "the sea
					// reaches this far" in a photograph.
					float wetZone = 1.0 - smoothstep( -0.3, 1.6, vWPos.y );` )
				.replace( '#include <roughnessmap_fragment>',
					'float roughnessFactor = roughness * mix( 1.0, 0.32, wetZone );' )
				.replace( '#include <normal_fragment_maps>', `
					vec3 nrT = mix( triSample( uRockNrm, tp, tw ).rgb,
					                triSample( uSandNrm, tp * 0.7, tw ).rgb, sandK ) * 2.0 - 1.0;
					// Whiteout blend: perturb the geometric normal by the map's
					// horizontal part. Cheaper than a full TBN and, on a
					// heightfield with no UVs, better behaved.
					normal = normalize( normal + vec3( nrT.x, 0.0, nrT.y ) * uNormalAmt );` );
		};
		const mesh = new THREE.Mesh( geo, mat );
		mesh.receiveShadow = true;
		mesh.castShadow = true;
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

		// BILLBOARD IMPOSTERS, not cones.
		//
		// A cone is the single loudest thing in the frame that says "not real":
		// no silhouette, no gaps, no needles. A photographed pine on a quad has
		// all three for two triangles, which is why every game has drawn distant
		// vegetation this way for thirty years.
		//
		// CYLINDRICAL billboarding -- the quad spins about its own trunk to face
		// the camera, and never tips. Spherical billboarding (facing the camera
		// outright) makes a forest lie down when you look at it from above, and
		// a tree that leans toward the viewer as you climb is worse than a cone.
		//
		// alphaTest rather than blending: alpha-blended foliage needs sorting,
		// and hundreds of unsorted transparent quads draw each other's holes.
		// A cutout writes depth like any solid, sorts for free, and takes part
		// in the shadow map -- which is where half the realism actually comes
		// from.
		const plates = [ TEX.pine1, TEX.pine2 ].filter( Boolean );
		if ( ! plates.length || count < 1 ) { this.treeCount = 0; return; }

		const perPlate = Math.ceil( count / plates.length );
		let placed = 0;
		this.trees = [];

		for ( const [ pi, plate ] of plates.entries() ) {

			const tex = new THREE.TextureLoader().load( plate.png );
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.anisotropy = 8;
			// A pine is ~14 m tall and the plate keeps its own proportions, so
			// the quad is as wide as the photograph says it should be.
			const H = 1, W = plate.w / plate.h;
			const geo = new THREE.PlaneGeometry( W, H );
			// Origin at the FOOT of the quad, so an instance sits on the ground
			// rather than half-buried in it.
			geo.translate( 0, H * 0.5, 0 );

			const mat = new THREE.MeshStandardMaterial( {
				map: tex, transparent: false, alphaTest: 0.45,
				roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
			} );
			mat.onBeforeCompile = ( sh ) => {
				sh.vertexShader = sh.vertexShader
					.replace( '#include <begin_vertex>', `
					#include <begin_vertex>
					// Rebuild the vertex IN WORLD SPACE so the quad faces the
					// camera about the Y axis. The instance matrix carries the
					// trunk's position and its scale; take those apart rather
					// than letting the matrix rotate the plate.
					vec3 bbCentre = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
					float bbSX = length( instanceMatrix[0].xyz );
					float bbSY = length( instanceMatrix[1].xyz );
					vec3 bbToCam = cameraPosition - bbCentre;
					// Y flattened: the quad turns, it never tips. Facing the
					// camera outright would lay the whole forest down when seen
					// from above, which is worse than a cone.
					vec3 bbRight = normalize( vec3( bbToCam.z, 0.0, - bbToCam.x ) );
					transformed = bbCentre + bbRight * ( position.x * bbSX )
					            + vec3( 0.0, position.y * bbSY, 0.0 );
					` )
					// The vertex above is ALREADY in world space. three's own
					// projection would then apply the instance matrix a second
					// time -- which is exactly what put the first attempt's
					// trees in the sky, each one translated by its own position
					// twice over. Project it directly instead.
					.replace( '#include <project_vertex>', `
					vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
					gl_Position = projectionMatrix * mvPosition;
					` )
					.replace( '#include <worldpos_vertex>', `
					#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined( USE_SHADOWMAP ) || defined( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
						vec4 worldPosition = vec4( transformed, 1.0 );
					#endif
					` );
			};

			const mesh = new THREE.InstancedMesh( geo, mat, perPlate );
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			mesh.frustumCulled = false;    // the vertex shader moves them
			const m = new THREE.Matrix4();
			const q = new THREE.Quaternion();
			const v = new THREE.Vector3();
			const col = new THREE.Color();

			let n = 0, tries = 0;
			const reach = this.bay * 1.7;
			while ( n < perPlate && tries < perPlate * 40 ) {
				tries ++;
				// Rejection sampling against the ground itself: trees go where
				// there IS ground high and level enough to hold them, which puts
				// them on the headland without anyone placing them there.
				const a = rand() * Math.PI * 2;
				const r = this.bay * 0.9 + rand() * reach;
				const x = Math.sin( a ) * r, z = Math.cos( a ) * r;
				const h = this.heightAt( x, z );
				if ( h < 5.5 ) continue;
				if ( rand() > Math.min( 1, ( h - 5.5 ) / 9 ) ) continue;
				const e = 2.5;
				const slope = Math.max(
					Math.abs( this.heightAt( x + e, z ) - h ),
					Math.abs( this.heightAt( x, z + e ) - h ) ) / e;
				if ( slope > 0.85 ) continue;

				// Squared random: small trees common, tall ones occasional.
				const u = rand();
				const tall = 7 + u * u * 16;
				// Sunk slightly so the trunk foot never floats over a facet.
				m.compose( v.set( x, h - 0.4, z ), q, v.clone().set( tall, tall, tall ) );
				mesh.setMatrixAt( n, m );
				// Per-tree tint: a stand is never one green, and without this
				// the repeat of two plates is obvious.
				col.setHSL( 0.25 + rand() * 0.06, 0.30 + rand() * 0.25,
					0.42 + rand() * 0.22 );
				mesh.setColorAt( n, col );
				n ++;
			}
			mesh.count = n;
			mesh.instanceMatrix.needsUpdate = true;
			if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
			this.group.add( mesh );
			this.trees.push( mesh );
			placed += n;

		}

		this.treeCount = placed;

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
			map: load( TEX.rock.albedo, true ),
			normalMap: load( TEX.rock.normal, false ),
			roughness: 0.95, metalness: 0, vertexColors: true, flatShading: true,
		} );
		mat.normalScale.set( 0.9, 0.9 );

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

		for ( const geo of shapes ) {
			const mesh = new THREE.InstancedMesh( geo, mat, per );
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			let n = 0, tries = 0;
			while ( n < per && tries < per * 30 ) {
				tries ++;
				const a = rand() * Math.PI * 2;
				const coast = this.coastAt( a );
				// From a little offshore to a little inland: the splash zone.
				const t = - 14 + rand() * 26;
				const x = Math.sin( a ) * ( coast + t ), z = Math.cos( a ) * ( coast + t );
				const h = this.heightAt( x, z );
				if ( h < - 6 || h > 12 ) continue;
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
