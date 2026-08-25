// TslFoamEnergy — leftover aerated film, driven like TslWake.
//
// Same window as the stamp field when `opts.follow` is set, so foamEnergyAt()
// and wakeAt() agree on origin/extent. Leftover is the hull sweep only —
// expanding rings stay as water waves.

import * as THREE from 'three/webgpu';

import {
	foamEnergyUpdateFragment, foamEnergyPrevTexture,
	uFeOrigin, uFePrevOrigin, uFeExtent, uFePrevExtent,
	uFeAgeDt, uFeInjectDt, uFeDecay, uFeA, uFeB, uFeFwd, uFeRight,
	uFeStir, uFeBeam, uFeGain, uFeActive, uFeSize,
	uFeRippleCell, uFeWaveCarry, uFeWaveMax, uFeWaveSpread,
	uFeOpenSpeed, uFeDiverge, uFeWaveSpeed, uFeMotor, uFeMotorW, uFeMotorReach,
	uFeHullLen, uFeYawRate, uFeStern, uFePlanform,
} from './foam-energy.js';
import { planWakeFrame } from '../../wake-interact.js';
import {
	FOAM_ENERGY_DECAY, FOAM_ENERGY_WAVE_CARRY, FOAM_ENERGY_WAVE_MAX,
	FOAM_ENERGY_WAVE_SPREAD, FOAM_ENERGY_DIVERGE, FOAM_ENERGY_PLANFORM_N,
	FOAM_ENERGY_MOTOR_W, FOAM_ENERGY_MOTOR_REACH,
	wakeFoamDecayOf, foamEnergyFillPlanform,
} from '../../foam-energy.js';
import { setRippleUniforms } from './ripple-field.js';

export class TslFoamEnergy {

	constructor( renderer, { size = 512 } = {} ) {

		this.renderer = renderer;
		this.size = size;

		const mk = () => {

			const t = new THREE.RenderTarget( size, size, {
				type: THREE.FloatType,
				format: THREE.RGBAFormat,
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				wrapS: THREE.ClampToEdgeWrapping,
				wrapT: THREE.ClampToEdgeWrapping,
				depthBuffer: false,
				generateMipmaps: false,
			} );
			t.texture.name = 'abyssal.foamEnergy';
			return t;

		};

		this.rt = [ mk(), mk() ];
		this.src = 0;
		this.material = new THREE.NodeMaterial();
		this.material.name = 'abyssal.foamEnergy.update';
		this.material.fragmentNode = foamEnergyUpdateFragment();
		this.material.depthTest = false;
		this.material.depthWrite = false;
		this.material.transparent = false;
		this.quad = new THREE.QuadMesh( this.material );
		this.origin = new Float32Array( [ 0, 0 ] );
		this.prevOrigin = new Float32Array( [ 0, 0 ] );
		this.extent = 320;
		this.prevExtent = 320;
		this.clear();
		this._planform = new Float32Array( FOAM_ENERGY_PLANFORM_N );

	}

	get field() { return this.rt[ this.src ].texture; }

	clear() {

		const r = this.renderer;
		const prev = r.getRenderTarget();
		const prevColor = new THREE.Color();
		r.getClearColor( prevColor );
		const prevAlpha = r.getClearAlpha();
		r.setClearColor( 0x000000, 0 );
		for ( const t of this.rt ) {

			r.setRenderTarget( t );
			r.clear( true, false, false );

		}
		r.setRenderTarget( prev );
		r.setClearColor( prevColor, prevAlpha );

	}

	/**
	 * @param {number} dt
	 * @param {object} p
	 * @param {object|object[]} wr
	 * @param {{ camera?:number[], follow?:object, rings?:object }} [opts]
	 */
	update( dt, p, wr, opts = {} ) {

		if ( dt <= 0 ) return;
		setRippleUniforms( opts.ripples, 1 );
		this._rippleCell = opts.ripples?.cell ?? 1;
		this._rippleSpeed = opts.ripples?.speed ?? 4;
		this._waveCarry = p.wakeFoamWaveCarry ?? FOAM_ENERGY_WAVE_CARRY;
		this._waveMax = p.wakeFoamWaveMax ?? FOAM_ENERGY_WAVE_MAX;
		this._waveSpread = p.wakeFoamWaveSpread ?? FOAM_ENERGY_WAVE_SPREAD;
		this._diverge = p.wakeFoamDiverge ?? FOAM_ENERGY_DIVERGE;
		const follow = opts.follow;
		this.prevOrigin[ 0 ] = this.origin[ 0 ];
		this.prevOrigin[ 1 ] = this.origin[ 1 ];
		this.prevExtent = this.extent;
		if ( follow ) {

			this.origin[ 0 ] = follow.origin[ 0 ];
			this.origin[ 1 ] = follow.origin[ 1 ];
			this.extent = follow.extent;
			const plan = follow.lastPlan || { stamps: [], stepDt: Math.min( dt, 1 / 15 ) };
			const sources = Array.isArray( wr ) ? wr : ( wr ? [ wr ] : [] );
			this._run(
				sources.length ? plan : { stamps: [], stepDt: plan.stepDt },
				wakeFoamDecayOf( sources.length ? plan : null, p ),
			);
			return;

		}

		this.extent = Math.max( p.wakeExtent ?? 320, 40 );
		const sources = Array.isArray( wr ) ? wr : ( wr ? [ wr ] : [] );
		const planned = planWakeFrame( dt, p, sources, {
			origin: [ this.origin[ 0 ], this.origin[ 1 ] ],
			hadWet: sources.length > 0,
			extent: this.extent,
			size: this.size,
		}, { camera: opts.camera } );
		this.origin[ 0 ] = planned.origin[ 0 ];
		this.origin[ 1 ] = planned.origin[ 1 ];
		this._run( planned, wakeFoamDecayOf( planned, p ) );

	}

	_run( plan, decay ) {

		this._decay = decay ?? FOAM_ENERGY_DECAY;
		const stamps = plan.stamps || [];
		const stepDt = plan.stepDt ?? 1 / 60;
		if ( ! stamps.length ) {

			this._flush( {
				a: [ this.origin[ 0 ], this.origin[ 1 ] ],
				b: [ this.origin[ 0 ], this.origin[ 1 ] ],
				fwd: [ 0, 1 ], stir: 0, beam: 1.2, gain: 0,
				ageDt: stepDt, injectDt: 0, active: false,
			} );
			return;

		}

		for ( let i = 0; i < stamps.length; i ++ ) {

			if ( i > 0 ) {

				this.prevOrigin[ 0 ] = this.origin[ 0 ];
				this.prevOrigin[ 1 ] = this.origin[ 1 ];
				this.prevExtent = this.extent;

			}
			this._flush( {
				...stamps[ i ],
				ageDt: i === 0 ? stepDt : 0,
				injectDt: stepDt,
			} );

		}

	}

	_flush( { a, b, fwd, stir, beam, gain, ageDt, injectDt, active, motor, jetWidth, jetReach, hullLen, stern, planform, yawRate } ) {

		const r = this.renderer;
		uFeOrigin.value.set( this.origin[ 0 ], this.origin[ 1 ] );
		uFePrevOrigin.value.set( this.prevOrigin[ 0 ], this.prevOrigin[ 1 ] );
		uFeExtent.value = this.extent;
		uFePrevExtent.value = this.prevExtent;
		uFeAgeDt.value = ageDt ?? 0;
		uFeInjectDt.value = injectDt ?? 0;
		uFeDecay.value = this._decay ?? FOAM_ENERGY_DECAY;
		uFeA.value.set( a[ 0 ], a[ 1 ] );
		uFeB.value.set( b[ 0 ], b[ 1 ] );
		uFeFwd.value.set( fwd[ 0 ], fwd[ 1 ] );
		uFeRight.value.set( - fwd[ 1 ], fwd[ 0 ] );
		uFeStir.value = stir ?? 0;
		uFeBeam.value = beam ?? 1.2;
		uFeGain.value = gain ?? 1;
		uFeActive.value = active ? 1 : 0;
		uFeMotor.value = motor ?? 0;
		uFeMotorW.value = jetWidth ?? FOAM_ENERGY_MOTOR_W;
		uFeMotorReach.value = jetReach ?? FOAM_ENERGY_MOTOR_REACH;
		uFeHullLen.value = Math.max( hullLen ?? 0, 0 );
		uFeYawRate.value = yawRate ?? 0;
		foamEnergyFillPlanform(
			this._planform, beam, hullLen ?? 0, planform,
		);
		for ( let i = 0; i < FOAM_ENERGY_PLANFORM_N; i ++ ) {

			uFePlanform.array[ i ] = this._planform[ i ];

		}
		const L = Math.max( hullLen ?? 0, 0 );
		if ( stern && Number.isFinite( stern[ 0 ] ) && Number.isFinite( stern[ 1 ] ) ) {

			uFeStern.value.set( stern[ 0 ], stern[ 1 ] );

		} else {

			// Fallback: bow stamp minus heading × ~waterline length.
			uFeStern.value.set(
				( b?.[ 0 ] ?? 0 ) - ( fwd?.[ 0 ] ?? 0 ) * L * 0.96,
				( b?.[ 1 ] ?? 0 ) - ( fwd?.[ 1 ] ?? 0 ) * L * 0.96,
			);

		}
		uFeSize.value = this.size;
		uFeRippleCell.value = this._rippleCell ?? 1;
		uFeWaveCarry.value = this._waveCarry ?? FOAM_ENERGY_WAVE_CARRY;
		uFeWaveMax.value = this._waveMax ?? FOAM_ENERGY_WAVE_MAX;
		uFeWaveSpread.value = this._waveSpread ?? FOAM_ENERGY_WAVE_SPREAD;
		uFeDiverge.value = this._diverge ?? FOAM_ENERGY_DIVERGE;
		uFeWaveSpeed.value = this._rippleSpeed ?? this._rippleCell ?? 4;
		const jump = Math.hypot( ( b?.[ 0 ] ?? 0 ) - ( a?.[ 0 ] ?? 0 ), ( b?.[ 1 ] ?? 0 ) - ( a?.[ 1 ] ?? 0 ) );
		const dtOpen = Math.max( injectDt ?? 0, ageDt ?? 0, 1e-4 );
		const open = jump / dtOpen;
		if ( open > 0.25 ) this._lastOpenSpeed = open;
		uFeOpenSpeed.value = open > 0.25 ? open : ( this._lastOpenSpeed ?? 0 );

		const dst = 1 - this.src;
		foamEnergyPrevTexture.value = this.rt[ this.src ].texture;
		const prev = r.getRenderTarget();
		const prevAuto = r.autoClear;
		r.autoClear = false;
		r.setRenderTarget( this.rt[ dst ] );
		this.quad.render( r );
		r.setRenderTarget( prev );
		r.autoClear = prevAuto;
		this.src = dst;

	}

	dispose() {

		this.rt.forEach( ( t ) => t.dispose() );
		this.material.dispose?.();

	}

}
