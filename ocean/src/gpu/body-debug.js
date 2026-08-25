// Live markers for OceanBody.debug — magenta spray contacts, cyan
// buoyancy probes, amber pole-cut rod, lime leftover occupancy. A
// private scene drawn after the sea so the markers sit on the waterline
// without being water-clipped in half or photographed into the
// refraction target.
//
// Positions come from the CPU (`debugContacts` in ocean-body.js). This
// file only poses meshes. The pole rod draws only when pierce.marker
// is on.

import * as THREE from 'three/webgpu';

import { debugContacts } from '../ocean-body.js';
import { MAX_BREACH_EMITTERS } from '../breach-emitters.js';

const MAX_SPRAY = MAX_BREACH_EMITTERS;
const MAX_BUOY = 16;
const MAX_PIERCE = 8;
const MAX_EMIT = 24;

function makeBalls( scene, mat, n ) {

	const geo = new THREE.SphereGeometry( 1, 10, 8 );
	const out = [];
	for ( let i = 0; i < n; i ++ ) {

		const m = new THREE.Mesh( geo, mat );
		m.visible = false;
		m.frustumCulled = false;
		m.matrixAutoUpdate = true;
		scene.add( m );
		out.push( m );

	}

	return { meshes: out, geo };

}

function makeRods( scene, mat, n ) {

	const geo = new THREE.CylinderGeometry( 1, 1, 1, 12 );
	const out = [];
	for ( let i = 0; i < n; i ++ ) {

		const m = new THREE.Mesh( geo, mat );
		m.visible = false;
		m.frustumCulled = false;
		m.matrixAutoUpdate = true;
		scene.add( m );
		out.push( m );

	}

	return { meshes: out, geo };

}

export function createBodyDebug() {

	const scene = new THREE.Scene();
	scene.name = 'abyssal.body-debug';

	const sprayMat = new THREE.MeshBasicMaterial( {
		color: 0xff4ec8,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const buoyMat = new THREE.MeshBasicMaterial( {
		color: 0x2ee4ff,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const pierceMat = new THREE.MeshBasicMaterial( {
		color: 0xffc14a,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
		transparent: true,
		opacity: 0.85,
	} );
	const emitParkedMat = new THREE.MeshBasicMaterial( {
		color: 0x2a3a22,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const emitWeakMat = new THREE.MeshBasicMaterial( {
		color: 0x5a7a30,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const emitMidMat = new THREE.MeshBasicMaterial( {
		color: 0x8dff3a,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const emitHardMat = new THREE.MeshBasicMaterial( {
		color: 0xffb020,
		depthTest: true,
		depthWrite: false,
		toneMapped: false,
	} );
	const spray = makeBalls( scene, sprayMat, MAX_SPRAY );
	const buoy = makeBalls( scene, buoyMat, MAX_BUOY );
	const pierce = makeRods( scene, pierceMat, MAX_PIERCE );
	const emit = makeBalls( scene, emitMidMat, MAX_EMIT );

	const hide = ( meshes ) => {

		for ( const m of meshes ) m.visible = false;

	};

	const pose = ( meshes, pts, baseR, roleScale ) => {

		for ( let i = 0; i < meshes.length; i ++ ) {

			const m = meshes[ i ];
			const p = pts[ i ];
			if ( ! p ) {

				m.visible = false;
				continue;

			}

			const scale = Math.max( p._s ?? 1, 0.4 );
			const r = p._r > 0
				? p._r
				: Math.max( 0.05, Math.min( scale, 10 ) * baseR ) * ( roleScale( p.role ) ?? 1 );
			m.visible = true;
			m.scale.setScalar( r );
			m.position.set( p.x, p.y + r * 0.35, p.z );

		}

	};

	const poseRods = ( meshes, pts ) => {

		for ( let i = 0; i < meshes.length; i ++ ) {

			const m = meshes[ i ];
			const p = pts[ i ];
			if ( ! p ) {

				m.visible = false;
				continue;

			}

			const r = Math.max( p.r ?? 0.15, 0.05 );
			const h = Math.max( p.height ?? 0, 0.12 );
			m.visible = true;
			m.scale.set( r, h, r );
			m.position.set( p.x, p.y + h * 0.5, p.z );

		}

	};

	return {
		scene,
		sync( bodies, opts = {} ) {

			const items = bodies?.items || bodies || [];
			const sprayPts = [];
			const buoyPts = [];
			const piercePts = [];
			const emitPts = [];
			for ( const b of items ) {

				const pack = debugContacts( b, opts );
				if ( ! pack ) continue;
				const s = Math.max( b.size?.x ?? 1, b.size?.y ?? 1, b.size?.z ?? 1 );
				for ( const p of pack.spray || [] ) sprayPts.push( { ...p, _s: s } );
				for ( const p of pack.buoyancy || [] ) buoyPts.push( { ...p, _s: s } );
				for ( const p of pack.pierce || [] ) piercePts.push( p );
				for ( const p of pack.emit || [] ) {

					const str = p.strength ?? ( p.live ? 0.55 : 0 );
					const roleK = p.role === 'bow' ? 1.3 : p.role === 'stern' ? 1.12 : 1;
					emitPts.push( {
						...p,
						_r: 0.09 * ( 0.38 + 0.95 * str ) * roleK,
					} );

				}

			}

			if ( ! sprayPts.length && ! buoyPts.length && ! piercePts.length && ! emitPts.length ) {

				hide( spray.meshes );
				hide( buoy.meshes );
				hide( pierce.meshes );
				hide( emit.meshes );
				return false;

			}

			pose( spray.meshes, sprayPts, 0.042, ( role ) => role === 'hull' ? 1.2 : 0.88 );
			pose( buoy.meshes, buoyPts, 0.055, ( role ) => (
				role === 'bow' || role === 'bow-port' || role === 'bow-starboard' ? 1.25 : 1
			) );
			poseRods( pierce.meshes, piercePts );
			pose( emit.meshes, emitPts, 0.048, () => 1 );
			for ( let i = 0; i < emit.meshes.length; i ++ ) {

				const p = emitPts[ i ];
				if ( ! p ) continue;
				const str = p.strength ?? ( p.live ? 0.55 : 0 );
				emit.meshes[ i ].material = str < 0.04 ? emitParkedMat
					: str < 0.22 ? emitWeakMat
						: str < 0.58 ? emitMidMat
							: emitHardMat;

			}
			return true;

		},
		dispose() {

			spray.geo.dispose();
			buoy.geo.dispose();
			pierce.geo.dispose();
			emit.geo.dispose();
			sprayMat.dispose();
			buoyMat.dispose();
			pierceMat.dispose();
			emitParkedMat.dispose();
			emitWeakMat.dispose();
			emitMidMat.dispose();
			emitHardMat.dispose();

		},
	};

}
