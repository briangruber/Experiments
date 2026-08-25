// Fullscreen water-column pass. Same slot as the sky background: far-plane
// quad, depth-tested, no depth write. Call it INSTEAD of sky.drawBackground
// while the camera is under the sea.

import * as THREE from 'three/webgpu';
import { vec4, positionGeometry } from 'three/tsl';

import { underwaterFragment, setUnderwaterUniforms, uUwOn } from './underwater.js';

export class TslUnderwater {

	constructor( renderer ) {

		this.renderer = renderer;
		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.underwater';
		this.material.fragmentNode = vec4( underwaterFragment(), 1.0 );
		this.material.depthTest = true;
		this.material.depthWrite = false;
		this.material.transparent = false;
		// Same far-plane pin as TslSky — see sky-driver.js. z = 0.999999,
		// not 1.0: Safari's WebGPU clips z == w.
		this.material.vertexNode = vec4( positionGeometry.x, positionGeometry.y, 0.999999, 1.0 );
		this.quad = new THREE.QuadMesh( this.material );

	}

	/**
	 * @returns {boolean} whether the pass ran (camera is wet and the look is on).
	 */
	render( p, ctx ) {

		const on = setUnderwaterUniforms( p, ctx );
		if ( ! on ) return false;
		this.quad.render( this.renderer );
		return true;

	}

	get active() {

		return uUwOn.value > 0.5;

	}

	dispose() {

		this.material.dispose?.();

	}

}
