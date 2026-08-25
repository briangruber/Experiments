// Instance the authored rock / coral GLBs onto the virtual bed.
//
// Placement is CPU (`placeFloorProps` in src/seafloor-props.js). This
// file loads each GLB once and builds InstancedMeshes — one batch per
// (kind, tint). createOceanLitMaterial, not MeshStandardMaterial: the
// sea's sun / sky LUT / haze have to light them or they read as studio
// props pasted under the water. They are scene decoration; they are
// not OceanBodies.

import * as THREE from 'three/webgpu';

import { createOceanLitMaterial } from './tsl/ocean-lit.js';
import {
	FLOOR_PROP_DEFAULTS, FLOOR_PROP_KINDS, placeFloorProps,
} from '../seafloor-props.js';

export { FLOOR_PROP_KINDS, placeFloorProps };

export const FLOOR_PROP_URLS = Object.fromEntries(
	FLOOR_PROP_KINDS.map( ( k ) => [
		k.id,
		new URL( `../../models/${ k.file }`, import.meta.url ).href,
	] ),
);

/**
 * Load each kind once. `loader` is a GLTFLoader; `urls` defaults to
 * the models/ files next to this package.
 */
export async function loadFloorPropAssets( loader, urls = FLOOR_PROP_URLS ) {

	const assets = {};
	await Promise.all( FLOOR_PROP_KINDS.map( async ( kind ) => {

		const href = urls[ kind.id ];
		if ( ! href ) return;
		const gltf = await loader.loadAsync( href );
		gltf.scene.updateMatrixWorld( true );
		let mesh = null;
		gltf.scene.traverse( ( o ) => {

			if ( o.isMesh && ! mesh ) mesh = o;

		} );
		if ( ! mesh ) return;
		const map = mesh.material?.map ?? null;
		if ( map ) {

			map.colorSpace = THREE.SRGBColorSpace;
			map.flipY = false;

		}
		assets[ kind.id ] = { geometry: mesh.geometry, map, kind };

	} ) );
	return assets;

}

function tintKey( p ) {

	return `${ p.kind }:${ p.tintI }`;

}

function paintBatch( im, rows ) {

	const dummy = new THREE.Object3D();
	for ( let i = 0; i < rows.length; i ++ ) {

		const p = rows[ i ];
		dummy.position.set( p.x, p.y, p.z );
		dummy.rotation.set( p.tiltX, p.yaw, p.tiltZ );
		dummy.scale.setScalar( p.scale );
		dummy.updateMatrix();
		im.setMatrixAt( i, dummy.matrix );

	}
	im.instanceMatrix.needsUpdate = true;
	im.computeBoundingSphere();

}

/**
 * Build (or rebuild) the instanced field and add it to `scene`.
 *
 * @returns {{ group: THREE.Group, placements: object[], sync: Function, dispose: Function }}
 */
export function plantSeafloorProps( scene, opts = {} ) {

	const assets = opts.assets;
	if ( ! assets ) throw new Error( 'plantSeafloorProps: pass loadFloorPropAssets() as assets' );

	const group = new THREE.Group();
	group.name = 'seafloor-props';
	scene.add( group );

	const makeMat = opts.createMaterial ?? ( ( map, role ) => createOceanLitMaterial( {
		color: 0xffffff,
		gloss: role === 'coral' ? 0.48 : 0.22,
		map,
	} ) );

	let placements = [];

	function clear() {

		const doomed = group.children.slice();
		for ( const o of doomed ) {

			group.remove( o );
			if ( o.material && o.material.userData?.floorPropMat ) o.material.dispose();

		}

	}

	function rebuild( params = opts.params ?? {} ) {

		clear();
		placements = placeFloorProps( {
			...FLOOR_PROP_DEFAULTS,
			seed: opts.seed ?? FLOOR_PROP_DEFAULTS.seed,
			count: opts.count ?? FLOOR_PROP_DEFAULTS.count,
			radius: opts.radius ?? FLOOR_PROP_DEFAULTS.radius,
			clear: opts.clear ?? FLOOR_PROP_DEFAULTS.clear,
			...params,
		} );
		group.visible = placements.length > 0;
		if ( ! placements.length ) return placements;

		const buckets = new Map();
		for ( const p of placements ) {

			const key = tintKey( p );
			let list = buckets.get( key );
			if ( ! list ) {

				list = [];
				buckets.set( key, list );

			}
			list.push( p );

		}

		const color = new THREE.Color();
		for ( const rows of buckets.values() ) {

			const proto = assets[ rows[ 0 ].kind ];
			if ( ! proto ) continue;
			const mat = makeMat( proto.map, rows[ 0 ].role );
			mat.userData.floorPropMat = true;
			color.setRGB( rows[ 0 ].tint[ 0 ], rows[ 0 ].tint[ 1 ], rows[ 0 ].tint[ 2 ] );
			if ( mat.userData.color ) mat.userData.color.value.copy( color );
			const im = new THREE.InstancedMesh( proto.geometry, mat, rows.length );
			im.name = `seafloor-${ rows[ 0 ].kind }-${ rows[ 0 ].tintI }`;
			im.castShadow = true;
			im.receiveShadow = true;
			im.frustumCulled = true;
			paintBatch( im, rows );
			group.add( im );

		}
		return placements;

	}

	rebuild( opts.params ?? {} );

	return {
		group,
		get placements() { return placements; },
		sync( params ) { return rebuild( params ); },
		dispose() {

			clear();
			group.removeFromParent();

		},
	};

}
