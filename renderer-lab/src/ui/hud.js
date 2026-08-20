// Minimal HUD: mode switch, TRAA toggle, and the numbers that make the point.

const MODES = [
	{ id: 'meshes', label: 'Meshes', hint: 'one Mesh per object · CPU frustum culling · one draw call each' },
	{ id: 'instanced', label: 'Instanced', hint: 'one InstancedMesh · one draw call · no culling at all' },
	{ id: 'gpu', label: 'GPU indirect', hint: 'compute cull → drawIndexedIndirect · one draw call · GPU culling' },
];

export function createHUD( {
	initialMode, initialTRAA, instanceCount, onMode, onTRAA, onPause,
} ) {

	const root = document.getElementById( 'ui' );

	root.innerHTML = `
		<div class="panel">
			<div class="title">GPU-driven culling</div>
			<div class="row modes"></div>
			<div class="hint" id="mode-hint"></div>
			<label class="row toggle">
				<input type="checkbox" id="traa" ${ initialTRAA ? 'checked' : '' }>
				<span>TRAA <em>(three r185 built-in)</em></span>
			</label>
			<label class="row toggle">
				<input type="checkbox" id="pause">
				<span>Pause camera</span>
			</label>
			<dl class="stats">
				<dt>fps</dt><dd id="s-fps">—</dd>
				<dt>cpu frame</dt><dd id="s-cpu">—</dd>
				<dt>draw calls</dt><dd id="s-draws">—</dd>
				<dt>instances</dt><dd id="s-instances">${ instanceCount.toLocaleString() }</dd>
				<dt>drawn</dt><dd id="s-visible">—</dd>
			</dl>
		</div>
	`;

	const modeRow = root.querySelector( '.modes' );
	const modeHint = root.querySelector( '#mode-hint' );
	const buttons = new Map();

	for ( const mode of MODES ) {

		const button = document.createElement( 'button' );
		button.type = 'button';
		button.textContent = mode.label;
		button.addEventListener( 'click', () => select( mode.id ) );
		modeRow.append( button );
		buttons.set( mode.id, button );

	}

	function select( id ) {

		for ( const [ key, button ] of buttons ) button.classList.toggle( 'on', key === id );
		modeHint.textContent = MODES.find( ( m ) => m.id === id ).hint;
		onMode( id );

	}

	root.querySelector( '#traa' ).addEventListener( 'change', ( event ) => {

		onTRAA( event.target.checked );

	} );

	root.querySelector( '#pause' ).addEventListener( 'change', ( event ) => {

		onPause( event.target.checked );

	} );

	// Reflect the starting mode without firing a rebuild — main.js builds it.
	for ( const [ key, button ] of buttons ) button.classList.toggle( 'on', key === initialMode );
	modeHint.textContent = MODES.find( ( m ) => m.id === initialMode ).hint;

	const fpsEl = root.querySelector( '#s-fps' );
	const cpuEl = root.querySelector( '#s-cpu' );
	const drawEl = root.querySelector( '#s-draws' );
	const visibleEl = root.querySelector( '#s-visible' );

	return {
		update( report ) {

			fpsEl.textContent = report.fps ? report.fps.toFixed( 0 ) : '—';
			cpuEl.textContent = report.cpuMs ? `${ report.cpuMs.toFixed( 2 ) } ms` : '—';
			drawEl.textContent = report.drawCalls.toLocaleString();

			if ( report.visible >= 0 ) {

				const percent = ( report.visible / instanceCount * 100 ).toFixed( 0 );
				visibleEl.textContent = `${ report.visible.toLocaleString() } (${ percent }%)`;

			} else if ( report.mode === 'instanced' ) {

				visibleEl.textContent = `${ instanceCount.toLocaleString() } (100%)`;

			} else {

				// Mode 1 draws one call per surviving object, so the draw call
				// count *is* the visible count.
				visibleEl.textContent = report.drawCalls > 0
					? report.drawCalls.toLocaleString()
					: '—';

			}

		},
	};

}
