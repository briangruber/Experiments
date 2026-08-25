// A second property inspector for `abyssal.params` — the shared GPU
// knobs (spray size / life, craft jet, sea state, grade). The Box panel
// owns per-mesh recipes; this one owns the ocean.
//
// Same SCHEMA as the ride demo. No Ride / Photo / Quiet chrome.

import { SCHEMA } from './schema.js';

const SKIP_GROUPS = new Set( [ 'Sea Dragon', 'Seaplane', 'Fishing Boat', 'Camera' ] );

const HULL_SPRAY = ( k ) =>
	k.startsWith( 'craftSpray' )
	|| k.startsWith( 'craftJet' )
	|| k.startsWith( 'craftSheet' )
	|| k.startsWith( 'craftCurtain' )
	|| k.startsWith( 'craftBurst' )
	|| k.startsWith( 'craftPlane' )
	|| k.startsWith( 'craftLoad' )
	|| k.startsWith( 'wake' );

const toHex = ( c ) => '#' + c.map( ( v ) =>
	Math.round( Math.min( Math.max( v, 0 ), 1 ) ** ( 1 / 2.2 ) * 255 )
		.toString( 16 ).padStart( 2, '0' ) ).join( '' );
const fromHex = ( h ) => [ 1, 3, 5 ].map( ( i ) => ( parseInt( h.slice( i, i + 2 ), 16 ) / 255 ) ** 2.2 );

function fmt( v, item ) {

	if ( v == null || Number.isNaN( v ) ) return '—';
	if ( item.integer ) return String( Math.round( v ) );
	const span = ( item.max ?? 1 ) - ( item.min ?? 0 );
	if ( span >= 1000 ) return Number( v ).toFixed( 0 );
	if ( span >= 20 ) return Number( v ).toFixed( 1 );
	if ( span >= 2 ) return Number( v ).toFixed( 2 );
	return Number( v ).toFixed( 3 );

}

function keepItem( group, item, skip ) {

	if ( skip.has( group ) ) return false;
	if ( group !== 'Wave Runner' ) return true;
	return HULL_SPRAY( item.key );

}

/**
 * @param {object} abyssal  createAbyssal() instance
 * @param {HTMLElement} root
 * @param {object} [opts]
 * @param {string[]} [opts.open]  group names to expand
 * @param {string[]} [opts.keepGroups]  groups to show even if SKIP_GROUPS hides them
 * @param {boolean} [opts.essentials=true]
 * @param {() => string} [opts.preset]  name `setPreset` should restore
 */
export function installParamsInspector( abyssal, root, opts = {} ) {

	const params = abyssal.params;
	const openWant = new Set( opts.open ?? [ 'Spray', 'Wave Runner' ] );
	const skip = new Set( SKIP_GROUPS );
	for ( const g of opts.keepGroups ?? [] ) skip.delete( g );
	const widgets = new Map();
	let essentials = opts.essentials !== false;

	root.innerHTML = '';
	const head = document.createElement( 'div' );
	head.className = 'insp-head';
	head.innerHTML = '<h2>Sea</h2>';
	const hide = document.createElement( 'button' );
	hide.type = 'button';
	hide.id = 'btn-params';
	hide.title = 'Hide this panel (K)';
	hide.textContent = 'Hide';
	head.appendChild( hide );
	root.appendChild( head );

	const tools = document.createElement( 'div' );
	tools.className = 'insp-tools';
	const essBtn = document.createElement( 'button' );
	essBtn.type = 'button';
	essBtn.className = 'insp-tool';
	const resetBtn = document.createElement( 'button' );
	resetBtn.type = 'button';
	resetBtn.className = 'insp-tool';
	resetBtn.textContent = 'Reset preset';
	tools.append( essBtn, resetBtn );
	root.appendChild( tools );

	const hint = document.createElement( 'p' );
	hint.className = 'hint';
	hint.textContent = 'Shared GPU look — spray size, hang time, hull jet, sea state. The Box panel is the mesh recipe.';
	root.appendChild( hint );

	const note = document.createElement( 'p' );
	note.className = 'hint note';
	note.hidden = true;
	root.appendChild( note );

	const applyEssentials = () => {

		root.classList.toggle( 'essentials', essentials );
		essBtn.textContent = essentials ? 'Show all' : 'Essentials';

	};

	const applyItem = ( item ) => {

		if ( item.rebuild && abyssal.sim ) abyssal.sim.dirty = true;
		if ( item.rebuildSim || item.rebuildGrid || item.rebuildSpray || item.rebuildWake ) {

			note.hidden = false;
			note.textContent = 'FFT / spray buffer size takes effect after reload.';

		}
		abyssal.markSkyDirty?.();

	};

	const sync = () => {

		for ( const [ key, w ] of widgets ) w.set( params[ key ] );

	};

	essBtn.addEventListener( 'click', () => {

		essentials = ! essentials;
		applyEssentials();

	} );

	resetBtn.addEventListener( 'click', () => {

		const name = opts.preset?.() || 'Golden Hour Swell';
		abyssal.setPreset( name );
		note.hidden = true;
		sync();

	} );

	for ( const section of SCHEMA ) {

		const items = section.items.filter( ( it ) => keepItem( section.group, it, skip ) );
		if ( ! items.length ) continue;
		const d = document.createElement( 'details' );
		if ( openWant.has( section.group ) ) d.open = true;
		const sum = document.createElement( 'summary' );
		sum.className = 'sec';
		sum.textContent = section.group === 'Wave Runner' ? 'Hull spray' : section.group;
		d.appendChild( sum );
		for ( const item of items ) d.appendChild( control( item ) );
		root.appendChild( d );

	}

	function control( item ) {

		const wrap = document.createElement( 'label' );
		wrap.className = 'prop';
		if ( item.essential ) wrap.classList.add( 'is-key' );
		if ( item.hint ) wrap.title = item.hint;
		const name = document.createElement( 'span' );
		name.textContent = item.label;
		wrap.appendChild( name );

		if ( item.type === 'color' ) {

			const inp = document.createElement( 'input' );
			inp.type = 'color';
			inp.value = Array.isArray( params[ item.key ] ) ? toHex( params[ item.key ] ) : '#ffffff';
			inp.addEventListener( 'input', () => {

				params[ item.key ] = fromHex( inp.value );
				applyItem( item );

			} );
			wrap.append( inp, document.createElement( 'span' ) );
			widgets.set( item.key, { set: ( v ) => { inp.value = Array.isArray( v ) ? toHex( v ) : inp.value; } } );
			return wrap;

		}

		if ( item.type === 'enum' ) {

			const sel = document.createElement( 'select' );
			item.options.forEach( ( o, i ) => {

				const opt = document.createElement( 'option' );
				opt.value = String( i );
				opt.textContent = String( o );
				sel.appendChild( opt );

			} );
			const cur = item.options.indexOf( params[ item.key ] );
			sel.value = String( Math.max( cur, 0 ) );
			sel.addEventListener( 'change', () => {

				params[ item.key ] = item.options[ + sel.value ];
				applyItem( item );

			} );
			wrap.append( sel, document.createElement( 'span' ) );
			widgets.set( item.key, {
				set: ( v ) => {

					const i = item.options.indexOf( v );
					sel.value = String( i >= 0 ? i : 0 );

				},
			} );
			return wrap;

		}

		if ( item.type === 'bool' ) {

			const inp = document.createElement( 'input' );
			inp.type = 'range';
			inp.min = 0; inp.max = 1; inp.step = 1;
			inp.value = params[ item.key ] ? 1 : 0;
			const val = document.createElement( 'span' );
			val.className = 'v';
			val.textContent = inp.value;
			inp.addEventListener( 'input', () => {

				params[ item.key ] = + inp.value >= 0.5 ? 1 : 0;
				val.textContent = inp.value;
				applyItem( item );

			} );
			wrap.append( inp, val );
			widgets.set( item.key, { set: ( v ) => { inp.value = v ? 1 : 0; val.textContent = inp.value; } } );
			return wrap;

		}

		const inp = document.createElement( 'input' );
		inp.type = 'range';
		inp.min = item.min; inp.max = item.max; inp.step = item.step;
		const start = params[ item.key ] ?? item.min ?? 0;
		inp.value = start;
		const val = document.createElement( 'span' );
		val.className = 'v';
		val.textContent = fmt( start, item );
		inp.addEventListener( 'input', () => {

			params[ item.key ] = item.integer ? Math.round( + inp.value ) : + inp.value;
			val.textContent = fmt( params[ item.key ], item );
			applyItem( item );

		} );
		wrap.append( inp, val );
		widgets.set( item.key, {
			set: ( v ) => { inp.value = v; val.textContent = fmt( v, item ); },
		} );
		return wrap;

	}

	applyEssentials();

	return {
		root,
		sync,
		hideBtn: hide,
		setEssentials( on ) {

			essentials = !! on;
			applyEssentials();

		},
	};

}
