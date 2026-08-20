// The review artifact.
//
// A reviewer — human or model — should be able to open one file and see the
// same frame rendered two ways, plus every number that was measured, without
// checking anything out or running anything.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, d = 3) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

function gateRow(r) {
  const state = r.pass === false ? 'bad' : 'good';
  const detail = r.failures.flatMap((f) => f.detail).slice(0, 3);
  return `<tr class="${state}">
    <td>${esc(r.title)}</td>
    <td class="mono">${r.pass === false ? 'FAIL' : 'pass'}</td>
    <td class="mono">${num(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}</td>
    <td class="note">${esc(r.note)}${detail.length ? `<br><span class="bad">${detail.map(esc).join('<br>')}</span>` : ''}</td>
  </tr>`;
}

function measureRow(r) {
  let delta = '—', cls = '';
  if (r.id === 'cost' && r.ratio != null) {
    delta = `${r.ratio.toFixed(2)}×`;
    cls = r.ratio <= 1.02 ? 'good' : r.ratio > 1.5 ? 'bad' : 'warn';
  } else if (r.movedCloser === 'unchanged') {
    delta = 'unchanged'; cls = '';
  } else if (r.movedCloser != null) {
    delta = r.movedCloser ? 'closer' : 'further';
    cls = r.movedCloser ? 'good' : 'warn';
  }
  const ref = r.perFixture.find((f) => f.candidate.reference != null)?.candidate.reference;
  return `<tr>
    <td>${esc(r.title)}</td>
    <td class="mono">${num(r.baselineValue)}</td>
    <td class="mono">${num(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}</td>
    <td class="mono">${ref != null ? num(ref) : '—'}</td>
    <td class="mono ${cls}">${delta}</td>
    <td class="note">${esc(r.note)}</td>
  </tr>`;
}

export function sheetHtml({ meta, scorecard, pairs }) {
  const v = scorecard.verdict;
  const banner = v.blocked
    ? `<div class="banner bad"><b>Blocked.</b> Failed ${v.blockedBy.map(esc).join(', ')}. Nothing else here matters until that is fixed.</div>`
    : `<div class="banner good"><b>Gates pass.</b> Costs ${v.costRatio ? v.costRatio.toFixed(2) + '×' : '—'} the champion.
       ${v.physics.length ? 'Physics: ' + v.physics.map((p) => `${esc(p.id)} moved ${p.movedCloser ? 'closer to' : 'further from'} its reference`).join('; ') + '.' : ''}
       ${v.unchanged?.length ? `<br><span style="color:var(--dim)">Untouched by this slot: ${v.unchanged.map(esc).join(', ')}.</span>` : ''}
       <br>The measurements cannot tell you whether it looks better. That is what the frames below are for.</div>`;

  const gates = scorecard.rows.filter((r) => r.kind === 'gate');
  const measures = scorecard.rows.filter((r) => r.kind === 'measure');

  const comparisons = pairs.map((p, i) => `
    <figure class="cmp">
      <figcaption>${esc(p.scene)} &middot; t = ${p.time}s</figcaption>
      <div class="wipe" id="w${i}">
        <img class="after" src="${esc(p.after)}" alt="candidate">
        <img class="before" src="${esc(p.before)}" alt="champion" style="clip-path:inset(0 50% 0 0)">
        <span class="tagL">champion</span><span class="tagR">candidate</span>
      </div>
      <input type="range" min="0" max="100" value="50" oninput="
        document.querySelector('#w${i} .before').style.clipPath = 'inset(0 ' + (100 - this.value) + '% 0 0)'">
    </figure>`).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(meta.slot)}: ${esc(meta.candidate)} vs ${esc(meta.champion)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0f14; --panel:#121821; --line:#22303f; --text:#dfe6ee; --dim:#8c9aab;
          --good:#5fd08a; --bad:#ff6b6b; --warn:#f0c25f; }
  body { margin:0; padding:28px; background:var(--bg); color:var(--text);
         font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; }
  h1 { font-size:17px; margin:0 0 2px; } h2 { font-size:13px; margin:26px 0 8px; color:var(--dim);
       text-transform:uppercase; letter-spacing:.06em; }
  .sub { color:var(--dim); margin:0 0 18px; }
  .banner { padding:12px 14px; border-radius:8px; margin-bottom:20px; border:1px solid var(--line); background:var(--panel); }
  .banner.good { border-color:rgba(95,208,138,.45); } .banner.bad { border-color:rgba(255,107,107,.5); }
  table { border-collapse:collapse; width:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; } tr:last-child td { border-bottom:none; }
  .mono { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .note { color:var(--dim); font-size:11.5px; line-height:1.5; }
  .good { color:var(--good); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .cmp { margin:0 0 22px; } .cmp figcaption { color:var(--dim); margin-bottom:6px; }
  .wipe { position:relative; border:1px solid var(--line); border-radius:8px; overflow:hidden; line-height:0; }
  .wipe img { width:100%; display:block; } .wipe .before { position:absolute; inset:0; }
  .tagL,.tagR { position:absolute; top:8px; padding:2px 7px; border-radius:4px; background:rgba(0,0,0,.6);
                font-size:11px; line-height:1.6; }
  .tagL { left:8px; } .tagR { right:8px; }
  input[type=range] { width:100%; margin-top:6px; accent-color:#5fd0e0; }
  footer { color:var(--dim); margin-top:28px; font-size:11.5px; }
</style>
<h1>${esc(meta.slot)} &nbsp;·&nbsp; ${esc(meta.candidate)} <span style="color:var(--dim)">vs</span> ${esc(meta.champion)}</h1>
<p class="sub">${esc(meta.generated)} &middot; ${pairs.length} fixtures &middot; ${esc(meta.renderer)}</p>
${banner}

<h2>Gates — a variant either clears these or it is not a variant</h2>
<table><tr><th>Gate</th><th>Result</th><th>Worst fixture</th><th>What it is</th></tr>
${gates.map(gateRow).join('\n')}</table>

<h2>Measurements — objective, and deliberately not a score</h2>
<table><tr><th>Measure</th><th>Champion</th><th>Candidate</th><th>Reference</th><th>Δ</th><th>What it is</th></tr>
${measures.map(measureRow).join('\n')}</table>

<h2>Preference — the part no number settles</h2>
<p class="sub">Same scene, same sun, same wave phase, same camera. Drag to wipe.</p>
${comparisons}

<footer>Generated by <code>tools/evaluate.mjs</code>. Cost ratios come from a software rasteriser:
the ratio is meaningful, the absolute milliseconds are not a frame budget.</footer>`;
}
