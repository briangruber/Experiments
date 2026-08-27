#!/usr/bin/env node
// Shrink the uploaded boat GLBs so five of them fit in a self-contained page.
//
// Each model is about 10k vertices and ONE baseColor JPEG of 2.6-4.6 MB: the
// texture is ~90% of the file. 18 MB of GLB becomes ~24 MB once base64'd into
// an HTML page, against a 16 MB artifact ceiling. Downscaling the textures
// gets the whole set under a megabyte and costs nothing visible on a boat that
// is a few dozen pixels across most of the time.
//
// There is no image tooling on this box -- no PIL, no ImageMagick, no sharp --
// but there is a headless browser, which has a perfectly good JPEG codec and a
// canvas to resample with. So the resize runs in Chromium.
//
//   node tools/pack-boats.mjs --size 512 --quality 0.82
//
// Writes models/*.glb and src/boatModels.js (base64, for the bundle).

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const argv = process.argv.slice( 2 );
const opt = ( n, d ) => { const i = argv.indexOf( '--' + n ); return i >= 0 ? argv[ i + 1 ] : d; };

const SRC = opt( 'src', '/root/.claude/uploads/44093df4-c064-57e9-9fad-e80d38ec8e77' );
const SIZE = +opt( 'size', 512 );
const QUALITY = +opt( 'quality', 0.82 );

async function loadPlaywright() {
	for ( const c of [ 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs',
		'/usr/lib/node_modules/playwright/index.mjs', process.env.PLAYWRIGHT_PATH ].filter( Boolean ) ) {
		try { return await import( c ); } catch { /* next */ }
	}
	throw new Error( 'playwright not found; set PLAYWRIGHT_PATH' );
}

/** Parse a GLB into { json, bin }. */
function parseGLB( buf ) {

	if ( buf.readUInt32LE( 0 ) !== 0x46546c67 ) throw new Error( 'not a GLB' );
	const jsonLen = buf.readUInt32LE( 12 );
	const json = JSON.parse( buf.slice( 20, 20 + jsonLen ).toString( 'utf8' ) );
	const binOff = 20 + jsonLen + 8;
	const binLen = buf.readUInt32LE( 20 + jsonLen );
	return { json, bin: buf.slice( binOff, binOff + binLen ) };

}

/**
 * Rebuild a GLB with one bufferView's bytes replaced.
 *
 * Every view has to be re-laid-out and re-offset, not just the one that
 * changed: shortening the image moves everything after it. Views are copied in
 * their original order and padded to 4 bytes, which is what the spec requires
 * and what a loader will assume.
 */
function rebuildGLB( json, bin, replace ) {

	const views = json.bufferViews;
	const parts = [];
	let offset = 0;
	const pad4 = ( n ) => ( 4 - ( n % 4 ) ) % 4;

	for ( let i = 0; i < views.length; i ++ ) {
		const v = views[ i ];
		const bytes = replace.has( i ) ? replace.get( i )
			: bin.slice( v.byteOffset ?? 0, ( v.byteOffset ?? 0 ) + v.byteLength );
		v.byteOffset = offset;
		v.byteLength = bytes.length;
		parts.push( bytes );
		offset += bytes.length;
		const p = pad4( offset );
		if ( p ) { parts.push( Buffer.alloc( p ) ); offset += p; }
	}

	const newBin = Buffer.concat( parts );
	json.buffers = [ { byteLength: newBin.length } ];

	let jsonStr = JSON.stringify( json );
	jsonStr += ' '.repeat( pad4( Buffer.byteLength( jsonStr ) ) );   // spec: pad with spaces
	const jsonBuf = Buffer.from( jsonStr, 'utf8' );

	const out = Buffer.alloc( 12 + 8 + jsonBuf.length + 8 + newBin.length );
	out.writeUInt32LE( 0x46546c67, 0 );          // 'glTF'
	out.writeUInt32LE( 2, 4 );
	out.writeUInt32LE( out.length, 8 );
	out.writeUInt32LE( jsonBuf.length, 12 );
	out.writeUInt32LE( 0x4e4f534a, 16 );         // 'JSON'
	jsonBuf.copy( out, 20 );
	out.writeUInt32LE( newBin.length, 20 + jsonBuf.length );
	out.writeUInt32LE( 0x004e4942, 24 + jsonBuf.length );   // 'BIN'
	newBin.copy( out, 28 + jsonBuf.length );
	return out;

}

const files = ( await readdir( SRC ) ).filter( ( f ) => f.endsWith( '.glb' ) ).sort();
if ( ! files.length ) throw new Error( `no .glb files in ${ SRC }` );

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();

await mkdir( resolve( ROOT, 'models' ), { recursive: true } );
const packed = [];

for ( const f of files ) {

	const buf = await readFile( resolve( SRC, f ) );
	const { json, bin } = parseGLB( buf );
	const replace = new Map();

	for ( const img of json.images ?? [] ) {
		if ( img.bufferView === undefined ) continue;
		const v = json.bufferViews[ img.bufferView ];
		const bytes = bin.slice( v.byteOffset ?? 0, ( v.byteOffset ?? 0 ) + v.byteLength );
		const b64 = bytes.toString( 'base64' );
		const mime = img.mimeType || 'image/jpeg';

		const out = await page.evaluate( async ( [ src, size, quality ] ) => {
			const im = new Image();
			im.src = src;
			await im.decode();
			// Preserve aspect, cap the long edge. These are baked atlases, so
			// they scale down cleanly -- there is no text or fine linework in
			// them that a resample would destroy.
			const k = Math.min( 1, size / Math.max( im.width, im.height ) );
			const w = Math.max( 1, Math.round( im.width * k ) );
			const h = Math.max( 1, Math.round( im.height * k ) );
			const c = document.createElement( 'canvas' );
			c.width = w; c.height = h;
			const g = c.getContext( '2d' );
			g.imageSmoothingQuality = 'high';
			g.drawImage( im, 0, 0, w, h );
			return { data: c.toDataURL( 'image/jpeg', quality ), w, h,
				was: [ im.width, im.height ] };
		}, [ `data:${ mime };base64,${ b64 }`, SIZE, QUALITY ] );

		const shrunk = Buffer.from( out.data.split( ',' )[ 1 ], 'base64' );
		replace.set( img.bufferView, shrunk );
		img.mimeType = 'image/jpeg';
		console.log( `  ${ img.name || 'texture' }: ${ out.was.join( 'x' ) } -> ${ out.w }x${ out.h }, `
			+ `${ ( bytes.length / 1e6 ).toFixed( 2 ) } MB -> ${ ( shrunk.length / 1e3 ).toFixed( 0 ) } kB` );
	}

	const rebuilt = rebuildGLB( json, bin, replace );
	// Strip the upload's hash prefix: "e0f898b7-tinyboatyacht.glb" -> "yacht".
	const id = basename( f, '.glb' ).replace( /^[0-9a-f]+-/, '' ).replace( /^tinyboats?/, '' ) || 'boat';
	await writeFile( resolve( ROOT, 'models', `${ id }.glb` ), rebuilt );
	packed.push( { id, bytes: rebuilt } );
	console.log( `${ f } -> models/${ id }.glb  `
		+ `${ ( buf.length / 1e6 ).toFixed( 2 ) } MB -> ${ ( rebuilt.length / 1e3 ).toFixed( 0 ) } kB` );

}

await browser.close();

// One module of base64, so the bundler carries the models with no fetch. The
// artifact is a single file served under a CSP that blocks external hosts, so
// anything the page needs has to already be in it.
const label = ( id ) => id.replace( /(^|[^a-z])([a-z])/g, ( m, a, b ) => a + b.toUpperCase() ).trim();
const mod = `// Boat models, base64-encoded GLB.
//
// GENERATED by tools/pack-boats.mjs -- do not edit by hand.
//
// The originals are ~3.5 MB each, almost entirely one baseColor JPEG; the
// geometry is only about 10k vertices. Downscaled to ${ SIZE }px at quality
// ${ QUALITY }, the set fits in a self-contained page with room to spare. They
// are inlined rather than fetched because the artifact is one file under a CSP
// that blocks external hosts.

export const BOATS = [
${ packed.map( ( p ) => `\t{ id: '${ p.id }', label: '${ label( p.id ) }', glb: '${ p.bytes.toString( 'base64' ) }' },` ).join( '\n' ) }
];

/** Decode one model's GLB to an ArrayBuffer for GLTFLoader.parse(). */
export function glbBuffer( b64 ) {

	const bin = atob( b64 );
	const out = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) out[ i ] = bin.charCodeAt( i );
	return out.buffer;

}
`;
await writeFile( resolve( ROOT, 'src/boatModels.js' ), mod );

const total = packed.reduce( ( a, p ) => a + p.bytes.length, 0 );
console.log( `\n${ packed.length } models, ${ ( total / 1e6 ).toFixed( 2 ) } MB total `
	+ `(${ ( total * 4 / 3 / 1e6 ).toFixed( 2 ) } MB as base64)` );
