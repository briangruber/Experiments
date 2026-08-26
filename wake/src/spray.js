// Spray thrown where a hull cuts the surface — the drawn half.
//
// This is the one part of a wake that is not water: it is water that has left
// the water. So it is particles rather than a field — nothing about it can be
// expressed as a height or a coverage on the surface, because for most of its
// life it is not on the surface at all.
//
// Three things follow, and they are what separate spray from the white noise
// that usually stands in for it:
//
//  · It is BALLISTIC. Born with the velocity the hull threw it at, then gravity
//    and drag, and it lands. A sheet that merely fades out reads as smoke.
//  · It is born ON THE CUT, not around the boat — see OceanBody.cuts().
//  · It ENDS as foam. A droplet that hits the water does not vanish; it becomes
//    a patch of aerated surface, so landings are reported rather than deleted.
//
// The ballistics live in sprayCore.js, which has no renderer in it so the
// headless check can measure them. This file is geometry, material and upload.

import * as THREE from 'three';
import { get } from './params.js';
import { SprayCore } from './sprayCore.js';

export class Spray extends SprayCore {

	constructor( max = 3000 ) {

		super( max );

		const geo = new THREE.BufferGeometry();
		const f = () => new Float32Array( max );
		this.aPos = new THREE.BufferAttribute( new Float32Array( max * 3 ), 3 );
		this.aAlpha = new THREE.BufferAttribute( f(), 1 );
		this.aSize = new THREE.BufferAttribute( f(), 1 );
		this.aPos.setUsage( THREE.DynamicDrawUsage );
		this.aAlpha.setUsage( THREE.DynamicDrawUsage );
		this.aSize.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'position', this.aPos );
		geo.setAttribute( 'aAlpha', this.aAlpha );
		geo.setAttribute( 'aSize', this.aSize );
		geo.setDrawRange( 0, 0 );
		this.geometry = geo;

		this.material = new THREE.ShaderMaterial( {
			transparent: true,
			depthWrite: false,                 // droplets do not occlude each other
			blending: THREE.NormalBlending,
			uniforms: {
				uPixelScale: { value: 600 },
				uTint: { value: new THREE.Color( 0.94, 0.965, 0.99 ) },
			},
			vertexShader: /* glsl */`
				attribute float aAlpha;
				attribute float aSize;
				uniform float uPixelScale;
				varying float vAlpha;
				void main(){
				  vAlpha = aAlpha;
				  vec4 mv = modelViewMatrix * vec4(position, 1.0);
				  // Perspective size: a droplet is a fixed size in METRES, so it has
				  // to shrink with distance like everything else. A constant pixel
				  // size is the classic tell of a bolted-on particle system.
				  gl_PointSize = max(aSize * uPixelScale / max(-mv.z, 0.1), 1.0);
				  gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */`
				precision highp float;
				uniform vec3 uTint;
				varying float vAlpha;
				void main(){
				  // Round, soft-edged, brightest at the centre: a droplet lit from
				  // every side by the sky reads as a little ball of scattered light,
				  // not as a disc.
				  vec2 d = gl_PointCoord - 0.5;
				  float r2 = dot(d, d);
				  if (r2 > 0.25) discard;
				  float core = 1.0 - smoothstep(0.0, 0.25, r2);
				  gl_FragColor = vec4(uTint, vAlpha * core * core);
				}
			`,
		} );

		this.points = new THREE.Points( geo, this.material );
		this.points.frustumCulled = false;   // the pool spans wherever the boat has been

	}

	/** Step the ballistics, then upload the live prefix. */
	step( dt, seaHeight = null ) {

		const w = super.step( dt, seaHeight );
		const p = this.p;
		const pos = this.aPos.array, al = this.aAlpha.array, sz = this.aSize.array;
		const opacity = get( 'spray.opacity' );
		for ( let i = 0; i < w; i ++ ) {
			pos[ i * 3 ] = p.x[ i ]; pos[ i * 3 + 1 ] = p.y[ i ]; pos[ i * 3 + 2 ] = p.z[ i ];
			const t = p.age[ i ] / p.life[ i ];
			// Fade late, not linearly: a droplet is fully there until it is not,
			// and a linear ramp leaves the whole curtain looking half-dissolved.
			al[ i ] = opacity * ( 1 - t * t * t );
			sz[ i ] = p.size[ i ];
		}
		this.aPos.addUpdateRange( 0, w * 3 );
		this.aAlpha.addUpdateRange( 0, w );
		this.aSize.addUpdateRange( 0, w );
		this.aPos.needsUpdate = this.aAlpha.needsUpdate = this.aSize.needsUpdate = true;
		this.geometry.setDrawRange( 0, w );
		return w;

	}

	setPixelScale( heightPx, fovDeg ) {

		// One metre at one metre, in pixels. Keeps droplet size honest across
		// resolutions and fields of view instead of drifting with the window.
		this.material.uniforms.uPixelScale.value =
			heightPx / ( 2 * Math.tan( fovDeg * Math.PI / 360 ) );

	}

	dispose() {

		this.geometry.dispose();
		this.material.dispose();

	}

}
