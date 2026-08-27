// A park around a pond, in the manner of Conservatory Water in Central Park:
// a stone coping ring, lawn to the distance, trees scattered beyond the rim
// and massing into a treeline at the edge of sight.
//
// The pond is a HOLE IN THE LAWN, not an edge of the water. Abyssal's sea runs
// to the horizon as it always did; the lawn sits 0.3 m above the waterline and
// simply covers it from the rim outward. The sea renders first and writes
// depth, the park renders after and occludes it — no water shader knows the
// pond exists, which is what makes this whole scene a few hundred lines
// instead of a port.
//
// Everything here is a three material lit by the same sun and ambient the
// boats use (see sunLight() in abyssalSea.js), so the park sits in the same
// afternoon as the water. Scene fog gives the far lawn and treeline the haze
// that reads as air; the sea ignores it (it hazes itself, in its own shader),
// which is fine — water and land genuinely do haze differently.

import * as THREE from 'three';

/** Deterministic scatter. A park that rearranges itself on reload is a tell. */
function rng( seed ) {

	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};

}

export class Park {

	/**
	 * @param {number} radius  pond radius in metres — the water the boats keep to
	 */
	constructor( radius = 300 ) {

		this.radius = radius;
		this.group = new THREE.Group();
		const rand = rng( 41 );

		const RIM_W = 2.2;            // stone coping width
		const LAWN_Y = 0.30;          // lawn height above the waterline
		const R = radius;

		// ---- stone coping -------------------------------------------------
		// A ring on top and a wall dropping past the waterline, so there is no
		// gap to see water through at a grazing angle. Granite grey, slightly
		// warm, roughness high — polished stone at a pond is wet stone, and
		// wet stone is dark.
		const stone = new THREE.MeshStandardMaterial( { color: 0x8d8a82, roughness: 0.85 } );
		const coping = new THREE.Mesh(
			new THREE.RingGeometry( R, R + RIM_W, 128 ), stone );
		coping.rotation.x = - Math.PI / 2;
		coping.position.y = LAWN_Y + 0.06;
		const wall = new THREE.Mesh(
			new THREE.CylinderGeometry( R, R, 1.6, 128, 1, true ), stone );
		wall.position.y = LAWN_Y + 0.06 - 0.8;
		wall.material = stone.clone();
		wall.material.side = THREE.DoubleSide;
		this.group.add( coping, wall );

		// ---- lawn ---------------------------------------------------------
		// Out to 3 km, so the sea's horizon cannot peek over its outer edge
		// from any sensible camera. Fog takes it before the edge matters.
		const lawn = new THREE.Mesh(
			new THREE.RingGeometry( R + RIM_W, 3000, 128, 4 ),
			new THREE.MeshStandardMaterial( { color: 0x55793c, roughness: 1.0 } ) );
		lawn.rotation.x = - Math.PI / 2;
		lawn.position.y = LAWN_Y;
		this.group.add( lawn );

		// ---- a path around the pond --------------------------------------
		// The strip everyone walks: a pale gravel ring just beyond the coping.
		const path = new THREE.Mesh(
			new THREE.RingGeometry( R + RIM_W, R + RIM_W + 3.5, 128 ),
			new THREE.MeshStandardMaterial( { color: 0xb9ac91, roughness: 1.0 } ) );
		path.rotation.x = - Math.PI / 2;
		path.position.y = LAWN_Y + 0.02;
		this.group.add( path );

		// ---- trees --------------------------------------------------------
		// Instanced: one trunk mesh, one canopy mesh, many transforms. Near
		// trees are individuals; past a few hundred metres they mass into a
		// treeline, which is just more of the same instances, denser and
		// bigger, until fog finishes the job.
		const NEAR = 90, FAR = 160;
		const trunkGeo = new THREE.CylinderGeometry( 0.28, 0.42, 3.4, 6 );
		const trunkMat = new THREE.MeshStandardMaterial( { color: 0x5d4a33, roughness: 1 } );
		const canopyGeo = new THREE.IcosahedronGeometry( 2.6, 1 );
		const canopyMat = new THREE.MeshStandardMaterial( { color: 0x3f6b2f, roughness: 1, flatShading: true } );
		const trunks = new THREE.InstancedMesh( trunkGeo, trunkMat, NEAR + FAR );
		const canopies = new THREE.InstancedMesh( canopyGeo, canopyMat, NEAR + FAR );
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const colour = new THREE.Color();
		let i = 0;

		const place = ( dist, scale ) => {
			const a = rand() * Math.PI * 2;
			const x = Math.cos( a ) * dist, z = Math.sin( a ) * dist;
			const s = scale * ( 0.7 + rand() * 0.8 );
			// Trunk: base on the lawn.
			m.compose( new THREE.Vector3( x, LAWN_Y + 1.7 * s, z ), q,
				new THREE.Vector3( s, s, s ) );
			trunks.setMatrixAt( i, m );
			// Canopy: a squashed blob atop the trunk, each its own green.
			m.compose( new THREE.Vector3( x, LAWN_Y + ( 3.4 + 1.6 ) * s, z ), q,
				new THREE.Vector3( s * ( 0.9 + rand() * 0.5 ), s * ( 0.8 + rand() * 0.4 ), s * ( 0.9 + rand() * 0.5 ) ) );
			canopies.setMatrixAt( i, m );
			colour.setHSL( 0.26 + rand() * 0.06, 0.42 + rand() * 0.2, 0.28 + rand() * 0.12 );
			canopies.setColorAt( i, colour );
			i ++;
		};

		// Individuals on the lawn, sparse near the path so the water stays open.
		for ( let n = 0; n < NEAR; n ++ ) place( R + 14 + rand() * 220, 1.0 + rand() * 0.8 );
		// The treeline: bigger, denser, further out — reads as woods.
		for ( let n = 0; n < FAR; n ++ ) place( R + 260 + rand() * 420, 2.2 + rand() * 1.6 );

		trunks.instanceMatrix.needsUpdate = true;
		canopies.instanceMatrix.needsUpdate = true;
		if ( canopies.instanceColor ) canopies.instanceColor.needsUpdate = true;
		this.group.add( trunks, canopies );

		// Everything in the park is static; skip per-frame culling maths.
		this.group.traverse( ( o ) => { o.frustumCulled = true; } );

	}

	/**
	 * Keep a hull inside the pond, gently.
	 *
	 * Two layers, because each fails alone. The ASSIST steers: near the rim it
	 * turns the commanded helm along the wall, the way you would drive an RC
	 * boat yourself, so most approaches never touch. The WALL is the honest
	 * backstop: position clamps to the rim and the outward velocity component
	 * dies, which reads as a soft bump — an RC boat nosing the coping — rather
	 * than a bounce or a pass-through.
	 *
	 * Returns extra turn (rad/s) for the assist; mutates state for the clamp.
	 */
	confine( state, dt, steerRate ) {

		const margin = 6;
		const d = Math.hypot( state.x, state.z );
		let assist = 0;

		if ( d > this.radius - margin - 26 && state.speed > 0.2 ) {
			// Heading relative to the outward radial: if we are pointing out,
			// steer toward whichever tangent is closer.
			const out = Math.atan2( state.x, state.z );
			let rel = state.heading - out;
			rel = ( ( rel + Math.PI ) % ( Math.PI * 2 ) + Math.PI * 2 ) % ( Math.PI * 2 ) - Math.PI;
			const closeness = Math.min( 1, Math.max( 0, ( d - ( this.radius - margin - 26 ) ) / 26 ) );
			if ( Math.abs( rel ) < Math.PI / 2 ) {
				assist = ( rel >= 0 ? 1 : - 1 ) * steerRate * closeness;
			}
		}

		if ( d > this.radius - margin ) {
			const k = ( this.radius - margin ) / d;
			state.x *= k;
			state.z *= k;
		}

		return assist;

	}

}
