#!/usr/bin/env node
// Sea panel contract: SCHEMA spray masters exist, and the inspector builds.
//
//   node tools/check-params-inspector.mjs

import { SCHEMA } from '../demo/schema.js';
import { defaults } from '../src/presets.js';
import { installParamsInspector } from '../demo/params-inspector.js';

const results = [];
const need = ( name, ok, detail = '' ) => results.push( { name, ok, detail } );

const byGroup = Object.fromEntries( SCHEMA.map( ( s ) => [ s.group, s.items ] ) );
const spray = Object.fromEntries( ( byGroup.Spray ?? [] ).map( ( i ) => [ i.key, i ] ) );
const foam = Object.fromEntries( ( byGroup.Foam ?? [] ).map( ( i ) => [ i.key, i ] ) );
const wr = Object.fromEntries( ( byGroup[ 'Wave Runner' ] ?? [] ).map( ( i ) => [ i.key, i ] ) );

for ( const key of [ 'spraySize', 'spraySizeMin', 'spraySizeMax', 'sprayLifetime', 'sprayOpacity', 'sprayRate' ] ) {

	need( `${ key } is a Spray essential`, !!( spray[ key ] && spray[ key ].essential ),
		spray[ key ] ? `essential=${ spray[ key ].essential }` : 'missing' );
	need( `${ key } lives on defaults`, key in defaults, '' );

}

for ( const key of [ 'foamLaceStretch', 'foamLaceMorph', 'foamLaceMorphRate' ] ) {

	need( `${ key } is a Foam essential`, !!( foam[ key ] && foam[ key ].essential ),
		foam[ key ] ? `essential=${ foam[ key ].essential }` : 'missing' );
	need( `${ key } lives on defaults`, key in defaults, '' );

}

for ( const key of [ 'foamTextureCarry', 'foamTextureShear', 'foamTextureStrain', 'foamLaceStretchBlock' ] ) {

	need( `${ key } is a Foam slider`, !! foam[ key ], foam[ key ] ? foam[ key ].label : 'missing' );
	need( `${ key } lives on defaults`, key in defaults, '' );

}

for ( const key of [ 'craftSprayAmount', 'craftSprayPulse', 'craftSprayOpacity', 'craftSprayLife', 'craftSpraySpread', 'craftSprayUp' ] ) {

	need( `${ key } is a Wave Runner essential`, !!( wr[ key ] && wr[ key ].essential ),
		wr[ key ] ? `essential=${ wr[ key ].essential }` : 'missing' );
	need( `${ key } lives on defaults`, key in defaults, '' );

}

need( 'inspector is a function', typeof installParamsInspector === 'function' );

{
	const el = ( tag ) => {

		const node = {
			tagName: String( tag ).toUpperCase(),
			children: [],
			className: '',
			hidden: false,
			id: '',
			type: '',
			value: '',
			textContent: '',
			title: '',
			innerHTML: '',
			style: {},
			classList: {
				_s: new Set(),
				add( c ) { this._s.add( c ); node.className = [ ...this._s ].join( ' ' ); },
				toggle( c, on ) {

					if ( on === false ) this._s.delete( c );
					else if ( on || ! this._s.has( c ) ) this._s.add( c );
					else this._s.delete( c );
					node.className = [ ...this._s ].join( ' ' );

				},
			},
			appendChild( c ) { this.children.push( c ); return c; },
			append( ...cs ) { for ( const c of cs ) this.appendChild( c ); },
			addEventListener() {},
			setAttribute() {},
		};
		return node;

	};
	const root = el( 'div' );
	globalThis.document = { createElement: el };
	const params = { ...defaults };
	const ui = installParamsInspector( {
		params,
		sim: { dirty: false },
		setPreset() {},
		markSkyDirty() {},
	}, root, { preset: () => 'Golden Hour Swell' } );
	need( 'inspector returns sync', typeof ui.sync === 'function' );
	need( 'inspector exposes hide', !! ui.hideBtn );
	need( 'essentials class is on', root.classList._s.has( 'essentials' ) );
	const keys = [];
	const walk = ( n ) => {

		if ( n.classList?._s?.has( 'is-key' ) ) keys.push( n );
		for ( const c of n.children ?? [] ) walk( c );

	};
	walk( root );
	need( 'essentials include spray size', keys.length >= 8, `key controls ${ keys.length }` );
	const labels = [];
	const walkText = ( n ) => {
		if ( n.tagName === 'SUMMARY' || n.className === 'sec' ) labels.push( n.textContent );
		for ( const c of n.children ?? [] ) walkText( c );
	};
	walkText( root );
	need( 'Sea Dragon stays hidden unless asked', ! labels.includes( 'Sea Dragon' ),
		labels.filter( ( t ) => /Dragon|Seaplane|Boat/.test( t ) ).join( ',' ) );

}

{
	const el = ( tag ) => {
		const node = {
			tagName: String( tag ).toUpperCase(),
			children: [],
			className: '',
			hidden: false,
			id: '',
			type: '',
			value: '',
			textContent: '',
			title: '',
			innerHTML: '',
			style: {},
			classList: {
				_s: new Set(),
				add( c ) { this._s.add( c ); node.className = [ ...this._s ].join( ' ' ); },
				toggle( c, on ) {
					if ( on === false ) this._s.delete( c );
					else if ( on || ! this._s.has( c ) ) this._s.add( c );
					else this._s.delete( c );
					node.className = [ ...this._s ].join( ' ' );
				},
			},
			appendChild( c ) { this.children.push( c ); return c; },
			append( ...cs ) { for ( const c of cs ) this.appendChild( c ); },
			addEventListener() {},
			setAttribute() {},
		};
		return node;
	};
	const root = el( 'div' );
	globalThis.document = { createElement: el };
	installParamsInspector( {
		params: { ...defaults },
		sim: { dirty: false },
		setPreset() {},
		markSkyDirty() {},
	}, root, { keepGroups: [ 'Sea Dragon' ], essentials: false } );
	const labels = [];
	const walkText = ( n ) => {
		if ( n.tagName === 'SUMMARY' || n.className === 'sec' ) labels.push( n.textContent );
		for ( const c of n.children ?? [] ) walkText( c );
	};
	walkText( root );
	need( 'keepGroups can show Sea Dragon', labels.includes( 'Sea Dragon' ),
		labels.join( ',' ) );

}

const failed = results.filter( ( r ) => ! r.ok );
for ( const r of results ) {

	console.log( `${ r.ok ? 'ok' : 'FAIL' }  ${ r.name }${ r.detail ? ` — ${ r.detail }` : '' }` );

}
if ( failed.length ) {

	console.error( `\n${ failed.length } failed` );
	process.exit( 1 );

}
console.log( `\n${ results.length } ok` );
