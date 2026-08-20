// A wireframe of the volume the culler is actually testing against.
//
// Built analytically from the camera's own fov/aspect/near/far, in camera-local
// space, and parented to the camera so it tracks automatically. That is
// deliberate: the alternative — unprojecting NDC corners — depends on whether
// clip space runs z from -1 or from 0, which is exactly the convention trap
// that produced a real bug in GPUCuller. Local-space corners have no such
// dependency, so the outline cannot silently disagree with the planes.

import { BufferGeometry, BufferAttribute, LineBasicMaterial, LineSegments } from 'three/webgpu';

// The twelve edges of a frustum, as index pairs into the corner array below.
const EDGES = [
	// near quad
	0, 1, 1, 2, 2, 3, 3, 0,
	// far quad
	4, 5, 5, 6, 6, 7, 7, 4,
	// the four rays joining them
	0, 4, 1, 5, 2, 6, 3, 7,
];

export function createFrustumOutline( camera, color = 0x2fd4c4 ) {

	const positions = new Float32Array( EDGES.length * 3 );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );

	const material = new LineBasicMaterial( { color, transparent: true, opacity: 0.9 } );

	const outline = new LineSegments( geometry, material );

	// The corners are already in the camera's local frame, so the outline must
	// not be culled or transformed by anything else.
	outline.frustumCulled = false;

	const corners = Array.from( { length: 8 }, () => [ 0, 0, 0 ] );

	outline.update = () => {

		const halfFov = ( camera.fov * Math.PI / 180 ) / 2;

		const nearHeight = Math.tan( halfFov ) * camera.near;
		const nearWidth = nearHeight * camera.aspect;
		const farHeight = Math.tan( halfFov ) * camera.far;
		const farWidth = farHeight * camera.aspect;

		// three's cameras look down local -Z, so both planes sit at negative z.
		const plane = ( width, height, z, offset ) => {

			corners[ offset + 0 ] = [ - width, - height, z ];
			corners[ offset + 1 ] = [ width, - height, z ];
			corners[ offset + 2 ] = [ width, height, z ];
			corners[ offset + 3 ] = [ - width, height, z ];

		};

		plane( nearWidth, nearHeight, - camera.near, 0 );
		plane( farWidth, farHeight, - camera.far, 4 );

		for ( let i = 0; i < EDGES.length; i ++ ) {

			const corner = corners[ EDGES[ i ] ];
			positions[ i * 3 + 0 ] = corner[ 0 ];
			positions[ i * 3 + 1 ] = corner[ 1 ];
			positions[ i * 3 + 2 ] = corner[ 2 ];

		}

		geometry.attributes.position.needsUpdate = true;

	};

	/**
	 * The eight corners in world space. Used by the verification harness to
	 * confirm the drawn outline and the culled volume are the same thing.
	 */
	outline.getWorldCorners = () => {

		outline.update();
		camera.updateMatrixWorld();

		const world = [];

		for ( let i = 0; i < 8; i ++ ) {

			const [ x, y, z ] = corners[ i ];
			const point = { x, y, z };
			const e = camera.matrixWorld.elements;

			world.push( {
				x: e[ 0 ] * point.x + e[ 4 ] * point.y + e[ 8 ] * point.z + e[ 12 ],
				y: e[ 1 ] * point.x + e[ 5 ] * point.y + e[ 9 ] * point.z + e[ 13 ],
				z: e[ 2 ] * point.x + e[ 6 ] * point.y + e[ 10 ] * point.z + e[ 14 ],
			} );

		}

		return world;

	};

	outline.update();
	camera.add( outline );

	return outline;

}
