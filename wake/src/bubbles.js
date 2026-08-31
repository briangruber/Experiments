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
		this._ring = 0;

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
			// ADDITIVE, AND depth-writing. Both matter, and turning the second
			// off to fix the first is what made these invisible.
			//
			// The water composites what is behind it by reading the refraction
			// pass's DEPTH texture, and the branch is gated on there being
			// something there at all (dsceneW < 1.0). Over open water the sea
			// bed is procedural -- computed inside the water shader, not scene
			// geometry -- so a bubble that writes no depth leaves that texel at
			// the far plane, the branch is skipped, and the bubble is never
			// composited. It is drawn into the colour buffer and then never
			// looked at. No emission rate can fix that.
			//
			// The stacked-coins look really was caused by depth write, but not
			// by depth write alone: it was depth write plus ALPHA blending plus
			// five-centimetre discs. Each disc composited over the last and cut
			// a hard rim into it. Additive blending is order-independent, so
			// with it the only thing depth write does is let a near bubble
			// occlude one directly behind it -- which is what a bubble does.
			//
			// A bubble is not paint. It is a gas-water interface that TOTALLY
			// internally reflects at any glancing angle -- which is why a bubble
			// under water looks like a bead of mercury, all silvery highlight,
			// and why a cloud of them is brighter than the water rather than a
			// different colour from it. Alpha-blending a light grey over blue
			// can only ever produce grey; adding light produces silver.
			//
			depthWrite: true,
			depthTest: true,
			blending: THREE.AdditiveBlending,
			uniforms: {
				uPixelScale: { value: 600 },
				// LIT BY THE SCENE, not by a constant.
				//
				// These were a fixed silver-blue, so a bubble at dusk was
				// exactly as bright and exactly as cold as a bubble at noon --
				// which is why a night sea came out with glowing specks in it.
				// Nothing else in the frame behaves that way: the hull, the
				// foam and the water all take their light from the sun's own
				// colour and strength, which the atmosphere reddens and dims as
				// it sets.
				//
				// Two terms, because a bubble is lit two ways: the SKY fills
				// its body and rim (most of the light at dusk, and blue), and
				// the SUN makes the one hard glint (dim and orange when low).
				uSunCol: { value: new THREE.Color( 1, 1, 1 ) },
				uSkyCol: { value: new THREE.Color( 0.72, 0.86, 0.95 ) },
				// The scene's real sun, in VIEW space. A glint pinned to a
				// fixed corner of the sprite is the thing that gives a
				// billboard away: every bubble catches the light from the same
				// screen direction no matter where the sun is, and they read as
				// a decal sheet. Fed from the sun the water is lit by.
				uSunView: { value: new THREE.Vector3( -0.4, 0.7, 0.5 ) },
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
				uniform vec3 uSunCol, uSkyCol;
				// Declared HERE as well as in the uniforms object. Adding a
				// uniform to the JS map does not declare it to GLSL: the
				// fragment shader referenced it and failed to compile, which
				// three reports and then carries on drawing nothing.
				uniform vec3 uSunView;
				varying float vAlpha;
				void main(){
					// A SPHERE, shaded per pixel -- not a picture of one.
					//
					// The sprite is a circle, and for a bubble that is not an
					// approximation: a sphere's silhouette is a circle from
					// every direction, so the outline is exact and always will
					// be. What a flat sprite normally fakes is the SHADING, and
					// that is what is reconstructed here: the z of the surface
					// normal comes straight out of the sprite coordinate, so
					// every pixel knows which way the bubble's skin faces, and
					// the light lands where the sun actually is.
					//
					// Light entering a gas bubble from water hits the far wall
					// past the critical angle almost everywhere, so it comes
					// back out at the RIM: a bubble reads as an annulus with a
					// dim middle, not as a filled ball. The glint is the direct
					// reflection off the top of the sphere, offset up-left, and
					// it is the single detail that makes the shape read as
					// round rather than as a printed ring.
					vec2 q = gl_PointCoord * 2.0 - 1.0;
					float d2 = dot( q, q );
					if ( d2 > 1.0 ) discard;
					float d = sqrt( d2 );
					// Annulus: peaks just inside the silhouette, falls away in
					// both directions, and dies before the edge so there is no
					// hard cut against the water.
					float ring = smoothstep( 0.42, 0.93, d ) * ( 1.0 - smoothstep( 0.93, 1.0, d ) );
					// A little light through the middle -- a bubble is not a
					// hole, and a pure ring reads as a smoke puff.
					float core = ( 1.0 - smoothstep( 0.0, 0.85, d ) ) * 0.16;
					// The normal of the sphere at this pixel, in view space.
					vec3 n = vec3( q, sqrt( max( 0.0, 1.0 - d2 ) ) );
					vec3 L = normalize( uSunView );
					// Specular off the near face: a real bead of gas throws one
					// small hard highlight, and it moves round the bubble as the
					// sun moves, which a fixed offset never could.
					vec3 H = normalize( L + vec3( 0.0, 0.0, 1.0 ) );
					float glint = pow( max( dot( n, H ), 0.0 ), 48.0 );
					// The rim brightens where the sphere turns edge-on to the
					// eye -- the same Fresnel that makes the annulus, now
					// coming out of the geometry rather than being drawn on.
					float fres = pow( 1.0 - max( n.z, 0.0 ), 3.0 );
					// Split by WHICH light makes it, so each is tinted by the
					// right source: the body and rim are sky, the glint is sun.
					float body = vAlpha * ( ring * 0.55 + fres * 0.5 + core );
					float spec = vAlpha * glint * 1.1;
					// Additive: the colour IS the light it sends back, so there
					// is no alpha channel doing the work and nothing to sort.
					gl_FragColor = vec4( uSkyCol * body + uSunCol * spec,
					                     body + spec );
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
	 * Point the glint at the real sun.
	 *
	 * Takes the world-space sun direction and the camera, and stores it in VIEW
	 * space, which is the frame a point sprite's coordinates live in.
	 */
	/**
	 * Take the scene's own light. `L` is abyssalSea.sunLight(): the sun's
	 * atmosphere-reddened colour, its strength, and how much the sky is putting
	 * in. Null before the first update, which leaves the previous values.
	 */
	setLight( L ) {

		if ( ! L ) return;
		const u = this.material.uniforms;
		const c = L.colour;
		u.uSunCol.value.setRGB( c[ 0 ] * L.strength, c[ 1 ] * L.strength, c[ 2 ] * L.strength );
		// The sky's contribution, tinted toward the blue it actually is. It is
		// floored inside sunLight(), because at dusk the sky IS the light.
		u.uSkyCol.value.setRGB( 0.62 * L.sky, 0.78 * L.sky, 0.95 * L.sky );

	}

	setSun( sunWorld, camera ) {

		// A plain [x, y, z], which is what abyssalSea.sunDirection() hands back
		// -- it forwards the raw array the water is lit by, and it returns null
		// before the first frame. Reading .x off that would give undefined and
		// put a NaN into the uniform, which in GLSL is a black sprite rather
		// than an error anyone would see.
		if ( ! sunWorld || sunWorld.length !== 3 ) return;
		this.material.uniforms.uSunView.value
			.set( sunWorld[ 0 ], sunWorld[ 1 ], sunWorld[ 2 ] )
			.transformDirection( camera.matrixWorldInverse )
			.normalize();

	}

	/**
	 * Release a bubble at a world point below the surface.
	 *
	 * `rand` is the caller's RNG so a headless check can drive it reproducibly.
	 */
	emit( x, y, z, rand = Math.random ) {

		// Recycle the OLDEST, never a random one.
		//
		// When the pool is full this used to overwrite a bubble picked at
		// random, which means bubbles vanish mid-rise -- and the pool fills
		// easily: 2000 a second with a two-and-a-half second climb wants five
		// thousand slots. What you get is a plume with holes punched through it
		// at random, thinning worst exactly where it is densest. A ring buffer
		// takes the one nearest the end of its life instead, which is the one
		// that was about to go anyway.
		let i;
		if ( this.n < this.max ) {
			i = this.n ++;
		} else {
			i = this._ring;
			this._ring = ( this._ring + 1 ) % this.max;
		}
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
		// NO COMPACTION. This used to reset n to 0 once the pool filled, which
		// silently orphaned every live bubble in it -- the whole plume dropped
		// at once and started again. The ring buffer above is what keeps
		// emission going when the pool is full; nothing else needs to.

	}

}
