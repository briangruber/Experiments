// Draw leftover whitewater as camera-facing specks after the sea.
// One instanced cloud, one camera quaternion — no per-speck lookAt.

import * as THREE from 'three/webgpu';

import { leftoverBubbleAlpha, LEFTOVER_BUBBLE_POOL, LEFTOVER_BUBBLE_SIZE } from '../leftover-bubbles.js';

function softDisc() {

	const n = 32;
	const data = new Uint8Array( n * n * 4 );
	const mid = ( n - 1 ) * 0.5;
	for ( let y = 0; y < n; y ++ ) {

		for ( let x = 0; x < n; x ++ ) {

			const r = Math.hypot( x - mid, y - mid ) / mid;
			const a = Math.max( 0, 1 - r );
			const s = a * a * ( 3 - 2 * a );
			const i = ( y * n + x ) * 4;
			data[ i ] = 255;
			data[ i + 1 ] = 255;
			data[ i + 2 ] = 255;
			data[ i + 3 ] = Math.round( s * 255 );

		}

	}
	const tex = new THREE.DataTexture( data, n, n );
	tex.format = THREE.RGBAFormat;
	tex.colorSpace = THREE.NoColorSpace;
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;

}

export function createLeftoverBubbles( { max = LEFTOVER_BUBBLE_POOL } = {} ) {

	const scene = new THREE.Scene();
	scene.name = 'abyssal.leftover-whitewater';
	const map = softDisc();
	const geo = new THREE.CircleGeometry( 1, 8 );
	const mat = new THREE.MeshBasicMaterial( {
		color: 0xeef3f8,
		map,
		transparent: true,
		depthWrite: false,
		depthTest: true,
		toneMapped: false,
	} );
	const mesh = new THREE.InstancedMesh( geo, mat, max );
	mesh.frustumCulled = false;
	mesh.instanceMatrix.setUsage( THREE.DynamicDrawUsage );
	const color = new THREE.Color( 1, 1, 1 );
	mesh.setColorAt( 0, color );
	mesh.instanceColor.setUsage( THREE.DynamicDrawUsage );
	scene.add( mesh );

	const pos = new THREE.Vector3();
	const scl = new THREE.Vector3( 1, 1, 1 );
	const mat4 = new THREE.Matrix4();
	const identity = new THREE.Quaternion();

	return {
		scene,
		sync( field, camera ) {

			const list = field?.live?.() ?? [];
			const cap = Math.min( max, field?.max ?? max );
			const quat = camera?.quaternion ?? identity;
			let n = 0;
			for ( let i = 0; i < list.length && n < cap; i ++ ) {

				const p = list[ i ];
				const a = leftoverBubbleAlpha( p );
				if ( a < 0.03 ) continue;
				const y = p.kind === 'foam' ? p.y + 0.018 : p.y;
				const s = Math.min( 0.10, Math.max( 0.016,
					( p.size ?? LEFTOVER_BUBBLE_SIZE ) * ( p.kind === 'splash' ? 0.82 : 1 ) ) );
				pos.set( p.x, y, p.z );
				scl.setScalar( s );
				mat4.compose( pos, quat, scl );
				mesh.setMatrixAt( n, mat4 );
				color.setRGB( a, a, a );
				mesh.setColorAt( n, color );
				n ++;

			}
			mesh.count = n;
			mesh.instanceMatrix.needsUpdate = n > 0;
			if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = n > 0;
			mesh.visible = n > 0;
			return n > 0;

		},
		dispose() {

			geo.dispose();
			mat.dispose();
			map.dispose();

		},
	};

}
