// Smooth walls for a pole cut. Not drawn in the beauty pass: an opaque
// floor on the sea read as a painted gray ribbon. The cut itself is a
// look-through in the water fragment (pierceCutAt). This overlay is
// kept if a later side view needs a tessellated tube.
//
// Poses come from pierceWellStamps() in src/pierce-carve.js.

import * as THREE from 'three/webgpu';

import { PIERCE_CARVE_STAMPS, pierceWellStamps } from '../pierce-carve.js';

const SEG = 64;

function makeStamp( scene, wallMat, floorMat, wallGeo, floorGeo, slabGeo ) {

	const cylA = new THREE.Mesh( wallGeo, wallMat );
	const cylB = new THREE.Mesh( wallGeo, wallMat );
	const sideL = new THREE.Mesh( slabGeo, wallMat );
	const sideR = new THREE.Mesh( slabGeo, wallMat );
	const floorA = new THREE.Mesh( floorGeo, floorMat );
	const floorB = new THREE.Mesh( floorGeo, floorMat );
	const floorSlab = new THREE.Mesh( slabGeo, floorMat );
	floorA.rotation.x = - Math.PI * 0.5;
	floorB.rotation.x = - Math.PI * 0.5;
	const meshes = [ cylA, cylB, sideL, sideR, floorA, floorB, floorSlab ];
	for ( const m of meshes ) {

		m.visible = false;
		m.frustumCulled = false;
		m.matrixAutoUpdate = true;
		scene.add( m );

	}
	return { cylA, cylB, sideL, sideR, floorA, floorB, floorSlab };

}

function hideStamp( s ) {

	s.cylA.visible = false;
	s.cylB.visible = false;
	s.sideL.visible = false;
	s.sideR.visible = false;
	s.floorA.visible = false;
	s.floorB.visible = false;
	s.floorSlab.visible = false;

}

function poseStamp( s, stamp ) {

	if ( ! stamp ) {

		hideStamp( s );
		return;

	}

	const r = Math.max( stamp.r ?? 0.15, 0.02 );
	const yTop = stamp.yTop;
	const yBot = stamp.yBot;
	const h = Math.max( yTop - yBot, 0.05 );
	const yMid = ( yTop + yBot ) * 0.5;
	const ax = stamp.ax;
	const az = stamp.az;
	const bx = stamp.bx;
	const bz = stamp.bz;
	const dx = bx - ax;
	const dz = bz - az;
	const len = Math.hypot( dx, dz );

	s.cylA.visible = true;
	s.cylA.scale.set( r, h, r );
	s.cylA.position.set( ax, yMid, az );

	s.floorA.visible = true;
	s.floorA.scale.set( r, r, 1 );
	s.floorA.position.set( ax, yBot, az );

	if ( len < 0.04 ) {

		s.cylB.visible = false;
		s.sideL.visible = false;
		s.sideR.visible = false;
		s.floorB.visible = false;
		s.floorSlab.visible = false;
		return;

	}

	const yaw = Math.atan2( dx, dz );
	const al = len || 1;
	const px = dz / al;
	const pz = - dx / al;

	s.cylB.visible = true;
	s.cylB.scale.set( r, h, r );
	s.cylB.position.set( bx, yMid, bz );

	s.floorB.visible = true;
	s.floorB.scale.set( r, r, 1 );
	s.floorB.position.set( bx, yBot, bz );

	s.sideL.visible = true;
	s.sideL.scale.set( 0.04, h, len );
	s.sideL.position.set( ( ax + bx ) * 0.5 + px * r, yMid, ( az + bz ) * 0.5 + pz * r );
	s.sideL.rotation.set( 0, yaw, 0 );

	s.sideR.visible = true;
	s.sideR.scale.set( 0.04, h, len );
	s.sideR.position.set( ( ax + bx ) * 0.5 - px * r, yMid, ( az + bz ) * 0.5 - pz * r );
	s.sideR.rotation.set( 0, yaw, 0 );

	s.floorSlab.visible = true;
	s.floorSlab.scale.set( r * 2, 0.03, len );
	s.floorSlab.position.set( ( ax + bx ) * 0.5, yBot, ( az + bz ) * 0.5 );
	s.floorSlab.rotation.set( 0, yaw, 0 );

}

export function createPierceWell() {

	const scene = new THREE.Scene();
	scene.name = 'abyssal.pierce-well';

	const wallMat = new THREE.MeshBasicMaterial( {
		color: 0x0c3a48,
		side: THREE.DoubleSide,
		depthTest: true,
		depthWrite: true,
	} );
	const floorMat = new THREE.MeshBasicMaterial( {
		color: 0x082830,
		side: THREE.DoubleSide,
		depthTest: true,
		depthWrite: true,
	} );
	const wallGeo = new THREE.CylinderGeometry( 1, 1, 1, SEG, 1, true );
	const floorGeo = new THREE.CircleGeometry( 1, SEG );
	const slabGeo = new THREE.BoxGeometry( 1, 1, 1 );

	const pool = [];
	for ( let i = 0; i < PIERCE_CARVE_STAMPS; i ++ ) {

		pool.push( makeStamp( scene, wallMat, floorMat, wallGeo, floorGeo, slabGeo ) );

	}

	return {
		scene,
		sync( opts = {} ) {

			const stamps = pierceWellStamps( opts.site, opts.field, opts.seaLevel ?? 0 );
			for ( let i = 0; i < pool.length; i ++ ) poseStamp( pool[ i ], stamps[ i ] );
			return stamps.length > 0;

		},
		dispose() {

			wallGeo.dispose();
			floorGeo.dispose();
			slabGeo.dispose();
			wallMat.dispose();
			floorMat.dispose();

		},
	};

}
