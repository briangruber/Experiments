#!/usr/bin/env node
// Builds the single-file artifact: bundles tools/artifact/app.js together with
// three.js and the lab's own modules, then injects the result into
// tools/artifact/page.html.
//
//   node tools/build-artifact.mjs [--out dist/gpu-driven-culling.html]
//
// The output is self-contained — no imports, no network — because artifacts are
// served under a CSP that blocks external hosts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

async function loadEsbuild() {

	const candidates = [
		'esbuild',
		process.env.ESBUILD_PATH,
		'/tmp/claude-0/-home-user-Experiments/15183aac-51eb-5780-aa6d-84c4fc8a63bb/scratchpad/node_modules/esbuild/lib/main.js',
	].filter( Boolean );

	for ( const candidate of candidates ) {

		try {

			return await import( candidate );

		} catch { /* try next */ }

	}

	throw new Error( 'esbuild not found; npm i esbuild, or set ESBUILD_PATH' );

}

const args = process.argv.slice( 2 );
const outIndex = args.indexOf( '--out' );
const OUT = resolve( ROOT, outIndex >= 0 ? args[ outIndex + 1 ] : 'dist/gpu-driven-culling.html' );

const esbuild = await loadEsbuild();

const result = await esbuild.build( {
	entryPoints: [ resolve( ROOT, 'tools/artifact/app.js' ) ],
	bundle: true,
	format: 'esm',
	// Top-level await in the entry needs a module target that permits it.
	target: 'es2022',
	// three's builds are already minified; minifying again mostly costs time,
	// but it does meaningfully shrink the lab's own sources and the page.
	minify: true,
	write: false,
	legalComments: 'none',
	alias: {
		'three/webgpu': resolve( ROOT, 'vendor/three/three.webgpu.min.js' ),
		'three/tsl': resolve( ROOT, 'vendor/three/three.tsl.min.js' ),
	},
} );

const bundle = result.outputFiles[ 0 ].text;

// A stray `</script>` inside the bundle would end the inline script element
// early and silently truncate everything after it.
if ( bundle.includes( '</script' ) ) {

	throw new Error( 'bundle contains a literal </script; escape it before inlining' );

}

const template = await readFile( resolve( ROOT, 'tools/artifact/page.html' ), 'utf8' );

if ( template.includes( '/*BUNDLE*/' ) === false ) {

	throw new Error( 'page.html is missing the /*BUNDLE*/ marker' );

}

// Escape every non-ASCII character in the page markup to a numeric entity.
// The artifact wrapper owns <head>, so we cannot guarantee a charset meta tag
// precedes our content; if the document is decoded as anything but UTF-8, every
// em dash becomes mojibake. Pure-ASCII markup is immune either way. esbuild
// already emits ASCII-only JS, so the bundle needs no such treatment.
const asciiTemplate = template.replace(
	/[\u0080-\uFFFF]/g,
	( character ) => `&#${ character.codePointAt( 0 ) };`
);

const html = asciiTemplate.replace( '/*BUNDLE*/', () => bundle );

await mkdir( dirname( OUT ), { recursive: true } );
await writeFile( OUT, html );

const mb = ( Buffer.byteLength( html ) / 1024 / 1024 ).toFixed( 2 );
console.log( `wrote ${ OUT } (${ mb } MB)` );

if ( Buffer.byteLength( html ) > 16 * 1024 * 1024 ) {

	console.log( 'WARNING: over the 16 MB artifact limit' );
	process.exit( 1 );

}
