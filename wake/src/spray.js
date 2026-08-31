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
		// Velocity goes to the GPU too, because a droplet's SHAPE depends on it.
		this.aVel = new THREE.BufferAttribute( new Float32Array( max * 3 ), 3 );
		this.aPos.setUsage( THREE.DynamicDrawUsage );
		this.aAlpha.setUsage( THREE.DynamicDrawUsage );
		this.aSize.setUsage( THREE.DynamicDrawUsage );
		this.aVel.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'position', this.aPos );
		geo.setAttribute( 'aAlpha', this.aAlpha );
		geo.setAttribute( 'aSize', this.aSize );
		geo.setAttribute( 'aVel', this.aVel );
		geo.setDrawRange( 0, 0 );
		this.geometry = geo;

		this.material = new THREE.ShaderMaterial( {
			transparent: true,
			depthWrite: false,                 // droplets do not occlude each other
			blending: THREE.NormalBlending,
			uniforms: {
				uPixelScale: { value: 600 },
				// Lit by the scene, not by a constant. See setLight().
				uSunCol: { value: new THREE.Color( 1, 1, 1 ) },
				uSkyCol: { value: new THREE.Color( 0.62, 0.72, 0.86 ) },
				// Sun direction in VIEW space, the same one the bubbles use.
				uSunView: { value: new THREE.Vector3( - 0.4, 0.7, 0.5 ) },
				uGlow: { value: 2.2 },
				// Shutter, in seconds. Sets how far a droplet smears.
				uStreak: { value: 0.02 },
			},
			vertexShader: /* glsl */`
				attribute float aAlpha;
				attribute float aSize;
				attribute vec3 aVel;
				uniform float uPixelScale;
				uniform float uStreak;
				uniform vec3 uSunView;
				uniform vec3 uSunCol;
				uniform vec3 uSkyCol;
				uniform float uGlow;
				varying float vAlpha;
				varying vec2 vDir;      // streak axis in point-sprite coords
				varying float vRad;     // droplet radius as a fraction of the sprite
				varying vec3 vLit;
				void main(){
				  vAlpha = aAlpha;
				  vec4 mv = modelViewMatrix * vec4(position, 1.0);

				  // Perspective size: a droplet is a fixed size in METRES, so it has
				  // to shrink with distance like everything else. A constant pixel
				  // size is the classic tell of a bolted-on particle system.
				  // CLAMPED at both ends. 1/z has no upper bound, so a single
				  // droplet drifting within a metre of the eye becomes a disc
				  // tens of degrees wide -- which is the little circle that
				  // seemed to follow the boat in a top-down view, where the
				  // camera sits right in the spray. 48 px is far larger than a
				  // droplet ever legitimately needs.
				  float z = max(-mv.z, 0.1);
				  float dia = clamp(aSize * uPixelScale / z, 1.0, 48.0);

				  // MOTION STRETCH.
				  //
				  // A droplet leaving a chine at 8 m/s crosses about 16 cm in a
				  // sixtieth of a second -- several times its own diameter. Neither
				  // a camera nor an eye resolves that as a dot; it resolves as a
				  // short streak lying along the velocity. Drawing spray as round
				  // dots is what makes it read as falling snow, and it is the one
				  // shape error no amount of texture detail can cover, because the
				  // detail smears too.
				  //
				  // Velocity is projected into view space and then to screen, so
				  // the streak shortens correctly as a droplet flies toward the eye
				  // -- head-on, it is a dot again, which is right.
				  vec3 vv = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
				  // Screen displacement over one shutter, in pixels. The z term is
				  // the perspective divide's derivative and is what makes a droplet
				  // coming at the camera stay round.
				  vec2 smear = vv.xy * (uPixelScale / z) * uStreak;
				  float len = length(smear);
				  // Sprite spans the whole streak: half-length is half the sprite.
				  float side = max(dia, dia + len);
				  gl_PointSize = clamp(side, 1.0, 64.0);
				  vDir = len > 1e-4 ? smear / len : vec2(1.0, 0.0);
				  vRad = 0.5 * dia / max(side, 1e-3);

				  // ENERGY, NOT BRIGHTNESS. A droplet smeared over four times the
				  // area does not emit four times the light -- it is the same
				  // droplet, spread thinner. Without this the fast spray at the
				  // chines gets BRIGHTER the faster it moves, which is backwards.
				  vAlpha *= dia / max(side, 1e-3);

				  // ...and fade the last metre out entirely: a droplet that
				  // close is between the eye and the scene, not part of it.
				  vAlpha *= smoothstep(0.35, 1.6, z);

				  // FORWARD SCATTER, which is why spray blazes when the sun is
				  // behind it and goes flat blue-grey when it is not. A water
				  // droplet is a lens: most of what enters it carries on in
				  // roughly the direction it was already going, so the eye sees
				  // it brightest looking back down the sunbeam. This is the
				  // single strongest cue that a curtain of spray is water and
				  // not a sheet of white dots, and a constant tint cannot have it.
				  vec3 toEye = normalize(-mv.xyz);
				  vec3 L = normalize(uSunView);
				  float fwd = max(-dot(toEye, L), 0.0);
				  float hg = fwd * fwd * fwd * fwd;
				  vLit = uSkyCol * 0.75 + uSunCol * (0.5 + uGlow * hg);

				  gl_Position = projectionMatrix * mv;
				}
			`,
			fragmentShader: /* glsl */`
				precision highp float;
				varying float vAlpha;
				varying vec2 vDir;
				varying float vRad;
				varying vec3 vLit;
				void main(){
				  // Distance to the streak's AXIS, not to its centre: a capsule
				  // laid along the direction of travel. At rest vRad is 0.5 and
				  // the segment has zero length, so this is exactly the old round
				  // droplet -- the shape falls out of the motion rather than
				  // being switched between two modes.
				  vec2 d = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
				  float h = max(0.5 - vRad, 0.0);
				  float t = clamp(dot(d, vDir), -h, h);
				  float r = length(d - vDir * t);
				  if (r > vRad) discard;
				  // Soft, brightest along the axis: a droplet lit from every side
				  // by the sky reads as a little bead of scattered light rather
				  // than as a disc with an edge.
				  float core = 1.0 - smoothstep(0.0, vRad, r);
				  gl_FragColor = vec4(vLit, vAlpha * core * core);
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
		const vel = this.aVel.array;
		const opacity = get( 'spray.opacity' );
		const base = Math.max( get( 'spray.size' ), 1e-4 );
		this.material.uniforms.uStreak.value = get( 'spray.streak' );
		this.material.uniforms.uGlow.value = get( 'spray.glow' );
		for ( let i = 0; i < w; i ++ ) {
			pos[ i * 3 ] = p.x[ i ]; pos[ i * 3 + 1 ] = p.y[ i ]; pos[ i * 3 + 2 ] = p.z[ i ];
			vel[ i * 3 ] = p.vx[ i ]; vel[ i * 3 + 1 ] = p.vy[ i ]; vel[ i * 3 + 2 ] = p.vz[ i ];
			const t = p.age[ i ] / p.life[ i ];
			// SMALL MEANS FAINT. A droplet a third the diameter carries a
			// thirtieth of the water and scatters back a small fraction as much
			// light. Drawn at full opacity, the fine end of the spectrum reads as
			// a swarm of hard white specks -- which is exactly what a mist is
			// not. Square-root rather than the cube the volume would imply: a
			// mist you cannot see at all is no better than no mist.
			const rel = Math.min( p.size[ i ] / base, 1.6 );
			al[ i ] = opacity * ( 1 - t * t * t ) * ( 0.3 + 0.7 * Math.sqrt( rel ) );
			sz[ i ] = p.size[ i ];
		}
		this.aPos.addUpdateRange( 0, w * 3 );
		this.aAlpha.addUpdateRange( 0, w );
		this.aSize.addUpdateRange( 0, w );
		this.aVel.addUpdateRange( 0, w * 3 );
		this.aPos.needsUpdate = this.aAlpha.needsUpdate = this.aSize.needsUpdate = true;
		this.aVel.needsUpdate = true;
		this.geometry.setDrawRange( 0, w );
		return w;

	}

	setPixelScale( heightPx, fovDeg ) {

		// One metre at one metre, in pixels. Keeps droplet size honest across
		// resolutions and fields of view instead of drifting with the window.
		this.material.uniforms.uPixelScale.value =
			heightPx / ( 2 * Math.tan( fovDeg * Math.PI / 360 ) );

	}

	/**
	 * Sun direction in view space, so the forward-scatter term knows where the
	 * beam is. Same contract as Bubbles.setSun(): a null before the sea's first
	 * update, which we leave alone rather than writing a NaN into the uniform.
	 */
	setSun( sunWorld, camera ) {

		if ( ! sunWorld || sunWorld.length !== 3 ) return;
		this.material.uniforms.uSunView.value
			.set( sunWorld[ 0 ], sunWorld[ 1 ], sunWorld[ 2 ] )
			.transformDirection( camera.matrixWorldInverse )
			.normalize();

	}

	/**
	 * Drive the droplets off the light that is actually there.
	 *
	 * Spray was a constant near-white, which is defensible at noon and wrong
	 * everywhere else: at a three-degree sun the sea goes nearly black and a
	 * white curtain stays white, so the spray reads as the one object in the
	 * scene with its own power supply. Sun and sky are kept SEPARATE here
	 * rather than summed, because they do different jobs -- the sky term is the
	 * body of the droplet, the sun term is what the forward-scatter lobe
	 * multiplies, and collapsing them loses the blaze into the sun entirely.
	 */
	setLight( L ) {

		if ( ! L ) return;
		const u = this.material.uniforms;
		const c = L.colour;
		u.uSunCol.value.setRGB( c[ 0 ] * L.strength, c[ 1 ] * L.strength, c[ 2 ] * L.strength );
		// Tinted toward the blue the sky actually is, not toward the sun.
		u.uSkyCol.value.setRGB( 0.80 * L.sky, 0.88 * L.sky, 1.0 * L.sky );

	}

	dispose() {

		this.geometry.dispose();
		this.material.dispose();

	}

}
