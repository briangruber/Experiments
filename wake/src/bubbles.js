// Bubbles under the water, which is a different medium from anything else here.
//
// The wake field cannot do this and never could. It is a TOP-DOWN texture: one
// value per square metre of surface, no vertical extent at all. It can say "the
// water here is white" and it cannot say "there is a column of gas three metres
// down, rising". Cavitation was written into it and correctly did nothing you
// could see, because what makes cavitation legible is exactly the part a 2D
// field throws away -- the depth, and the rise.
//
// So: real particles, born under the surface, going up.
//
// They are added to the SCENE, and that is the whole trick. The scene is
// photographed each frame into the refraction pass, and the water shader
// composites whatever it finds behind the surface -- warped by the surface
// normal, tinted by Beer-Lambert over the depth it is seen through. So these
// get the distortion and the murk for free, from the same machinery that shows
// a submerged keel, and they can only be seen THROUGH water, which is correct:
// in the main pass they lose the depth test to the surface above them.
//
// depthWrite is ON, unlike the spray's. The refraction pass reads its DEPTH
// texture to work out how much water a fragment is being seen through; a
// bubble that writes no depth is composited at whatever is behind it, so a
// bubble a metre down gets the murk of the sea bed and disappears.

import * as THREE from 'three';
import { get } from './params.js';

export class Bubbles {

	constructor( max = 4000 ) {

		this.max = max;
		this.n = 0;
		const f = ( k = 1 ) => new Float32Array( max * k );
		// Live state. Plain arrays rather than objects: this is swept every
		// frame and allocation here shows up as stutter.
		this.px = f(); this.py = f(); this.pz = f();
		this.vx = f(); this.vy = f(); this.vz = f();
		this.r = f();          // radius, metres
		this.age = f(); this.life = f();
		this.seed = f();

		const geo = new THREE.BufferGeometry();
		this.aPos = new THREE.BufferAttribute( new Float32Array( max * 3 ), 3 );
		this.aSize = new THREE.BufferAttribute( f(), 1 );
		this.aAlpha = new THREE.BufferAttribute( f(), 1 );
		for ( const a of [ this.aPos, this.aSize, this.aAlpha ] ) a.setUsage( THREE.DynamicDrawUsage );
		geo.setAttribute( 'position', this.aPos );
		geo.setAttribute( 'aSize', this.aSize );
		geo.setAttribute( 'aAlpha', this.aAlpha );
		geo.setDrawRange( 0, 0 );
		this.geometry = geo;

		this.material = new THREE.ShaderMaterial( {
			transparent: true,
			depthWrite: true,
			depthTest: true,
			blending: THREE.NormalBlending,
			uniforms: {
				uPixelScale: { value: 600 },
				uTint: { value: new THREE.Color( 0.86, 0.94, 0.98 ) },
			},
			vertexShader: /* glsl */`
				attribute float aSize;
				attribute float aAlpha;
				uniform float uPixelScale;
				varying float vAlpha;
				varying vec2 vUvC;
				void main(){
					vAlpha = aAlpha;
					vec4 mv = modelViewMatrix * vec4( position, 1.0 );
					gl_Position = projectionMatrix * mv;
					gl_PointSize = uPixelScale * aSize / max( -mv.z, 0.1 );
					vUvC = vec2( 0.0 );
				}
			`,
			fragmentShader: /* glsl */`
				precision highp float;
				uniform vec3 uTint;
				varying float vAlpha;
				void main(){
					// A bubble is a tiny lens, not a ball of paint: bright rim
					// where the sphere turns away and the light refracts round
					// it, thin in the middle where you look straight through.
					// That is what stops a cloud of them reading as chalk.
					vec2 q = gl_PointCoord * 2.0 - 1.0;
					float d = dot( q, q );
					if ( d > 1.0 ) discard;
					float edge = smoothstep( 0.35, 1.0, d );
					float core = 1.0 - smoothstep( 0.0, 0.75, d );
					float a = vAlpha * ( 0.22 * core + 0.85 * edge ) * ( 1.0 - smoothstep( 0.86, 1.0, d ) );
					gl_FragColor = vec4( uTint, a );
				}
			`,
		} );

		this.points = new THREE.Points( geo, this.material );
		this.points.frustumCulled = false;

	}

	setPixelScale( heightPx, fovDeg ) {

		this.material.uniforms.uPixelScale.value =
			heightPx / ( 2 * Math.tan( fovDeg * Math.PI / 360 ) );

	}

	/**
	 * Release a bubble at a world point below the surface.
	 *
	 * `rand` is the caller's RNG so a headless check can drive it reproducibly.
	 */
	emit( x, y, z, rand = Math.random ) {

		const i = this.n < this.max ? this.n ++ : ( Math.random() * this.max ) | 0;
		this.px[ i ] = x; this.py[ i ] = y; this.pz[ i ] = z;
		// Born with the wash's own motion, mostly downward and aft -- a screw
		// drives water DOWN and back, which is why the plume sinks before it
		// climbs and why the column stands a couple of metres below the boat.
		const sp = get( 'bub.jet' );
		this.vx[ i ] = ( rand() - 0.5 ) * sp;
		this.vy[ i ] = - rand() * sp * 0.5;
		this.vz[ i ] = ( rand() - 0.5 ) * sp;
		// Size distribution: many small, a few big. Squaring a uniform is the
		// cheapest honest way to get that, and it matters -- a cloud of
		// identical discs is the giveaway that something is a particle system.
		const u = rand();
		this.r[ i ] = get( 'bub.size' ) * ( 0.25 + u * u * 1.75 );
		this.age[ i ] = 0;
		this.life[ i ] = get( 'bub.life' ) * ( 0.6 + rand() * 0.8 );
		this.seed[ i ] = rand() * 6.283;

	}

	/**
	 * Rise, wobble, and pop at the surface.
	 *
	 * `surfaceAt(x, z)` gives the sea height so a bubble dies where the water
	 * actually is rather than at y = 0 -- in a swell those differ by more than
	 * the whole depth this plume occupies.
	 */
	update( dt, surfaceAt = null, t = 0 ) {

		// Terminal velocity, not acceleration. A bubble reaches its rise speed
		// in a few centimetres -- buoyancy against drag balances almost at once
		// -- so integrating a constant upward force gives something that
		// accelerates out of the water like a cork, which is not what bubbles
		// do. Bigger bubbles rise faster, hence the radius term.
		const riseK = get( 'bub.rise' );
		const drag = Math.exp( - dt / 0.35 );
		const wob = get( 'bub.wobble' );
		let w = 0;
		for ( let i = 0; i < this.n; i ++ ) {
			this.age[ i ] += dt;
			const a = this.age[ i ] / Math.max( this.life[ i ], 0.01 );
			if ( a >= 1 ) continue;
			// Horizontal motion just decays; there is nothing to keep it going.
			this.vx[ i ] *= drag;
			this.vz[ i ] *= drag;
			const rise = riseK * Math.sqrt( Math.max( this.r[ i ], 0.005 ) / 0.05 );
			this.vy[ i ] += ( rise - this.vy[ i ] ) * ( 1 - drag );
			// A rising bubble does not go straight up: it spirals, because the
			// wake it sheds is unstable. This is the single cheapest thing that
			// makes a bubble read as a bubble.
			const ph = t * 2.4 + this.seed[ i ];
			this.px[ i ] += ( this.vx[ i ] + Math.cos( ph ) * wob ) * dt;
			this.pz[ i ] += ( this.vz[ i ] + Math.sin( ph ) * wob ) * dt;
			this.py[ i ] += this.vy[ i ] * dt;
			// Pop at the surface. Not "fade out at the top": a bubble that
			// reaches air is gone, and the ones that survive longest are the
			// ones that started deepest, which is what gives the column its
			// tapering shape.
			const sy = surfaceAt ? surfaceAt( this.px[ i ], this.pz[ i ] ) : 0;
			if ( this.py[ i ] >= sy - 0.02 ) { this.age[ i ] = this.life[ i ]; continue; }
			const j = w ++;
			this.aPos.array[ j * 3 ] = this.px[ i ];
			this.aPos.array[ j * 3 + 1 ] = this.py[ i ];
			this.aPos.array[ j * 3 + 2 ] = this.pz[ i ];
			this.aSize.array[ j ] = this.r[ i ] * 2;
			// Fade in fast, out slowly: a bubble is made in an instant and then
			// merely gets further away.
			this.aAlpha.array[ j ] = Math.min( 1, a * 12 ) * ( 1 - a * a );
		}
		this.geometry.setDrawRange( 0, w );
		this.aPos.needsUpdate = this.aSize.needsUpdate = this.aAlpha.needsUpdate = true;
		this.drawn = w;
		// Compact the pool occasionally so dead slots do not stall emission.
		if ( this.n >= this.max ) this.n = 0;

	}

}
