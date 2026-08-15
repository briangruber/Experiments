// The interface.
//
// Vanilla, no build step, one file. The views are small enough that a framework
// would be more code than it saved, and a tool you might come back to in a year
// is better off with no dependency tree to rot.
//
// The shape worth noting: nothing here decides anything. Every generation is a
// take, every take is chosen explicitly, and the UI never regenerates something
// as a side effect of a change — because the video endpoint has no seed and an
// overwritten take is gone. Buttons that spend money say what they will cost.

const $ = (sel, el = document) => el.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) n.append(k?.nodeType ? k : document.createTextNode(String(k ?? '')));
  return n;
};

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json?.error) throw new Error(json.error);
  return json;
};

const state = { project: null, jobs: new Map(), models: null };

// ---------------------------------------------------------------------------
// Work panel
// ---------------------------------------------------------------------------

function renderJobs() {
  const list = [...state.jobs.values()].sort((a, b) => b.queuedAt - a.queuedAt);
  const live = list.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const count = $('#jobCount');
  count.textContent = live;
  count.classList.toggle('live', live > 0);

  $('#jobList').replaceChildren(
    ...(list.length ? list : []).map((j) =>
      el('div', { className: 'job' },
        el('div', { className: 'top' },
          el('span', { className: `dot ${j.status}` }),
          el('span', { className: 'label' }, j.label),
          el('span', { className: 'n mono' }, j.status),
        ),
        j.detail ? el('div', { className: 'detail' }, j.detail.slice(0, 110)) : '',
        j.logs?.length ? el('pre', {}, j.logs.slice(-8).join('\n')) : '',
        j.error ? el('div', { className: 'detail note-bad' }, j.error) : '',
      ),
    ),
    list.length ? '' : el('div', { className: 'empty' }, 'Nothing running.'),
  );
}

function watchJobs() {
  const src = new EventSource('/api/events');
  src.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'job') return;
    const before = state.jobs.get(msg.job.id)?.status;
    state.jobs.set(msg.job.id, msg.job);
    renderJobs();
    // A finished job usually means something on screen is out of date.
    if (before !== msg.job.status && ['done', 'failed'].includes(msg.job.status)) render();
  };
  src.onerror = () => {};
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function modal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').replaceChildren(...[body].flat());
  $('#modal').hidden = false;
}
const closeModal = () => { $('#modal').hidden = true; };

// ---------------------------------------------------------------------------
// Takes
// ---------------------------------------------------------------------------

// The core interaction of the whole app. Every generated thing is a numbered
// take and choosing between them is an explicit act — never automatic, never
// destructive.
function takeGrid(takes, { kind, onSelect }) {
  if (!takes.length) return el('div', { className: 'empty' }, 'No takes yet.');
  return el('div', { className: 'takes' },
    takes.map((t) =>
      el('div', { className: `take ${t.selected ? 'sel' : ''}` },
        kind === 'image'
          ? el('img', { src: t.url, loading: 'lazy' })
          : el('video', { src: t.url, controls: true, preload: 'metadata' }),
        el('div', { className: 'bottom' },
          el('span', { className: 'n' }, `Take ${t.take}`),
          el('span', { style: 'flex:1' }),
          t.selected
            ? el('span', { className: 'tag on' }, 'selected')
            : el('button', { className: 'small', onclick: () => onSelect(t.take) }, 'Use this'),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const views = {};

views.overview = async () => {
  const p = state.project;
  return el('div', {},
    el('h1', {}, p.show.title || 'Untitled show'),
    el('p', { className: 'sub' }, p.show.premise || ''),
    el('div', { className: 'panel' },
      el('div', { className: 'mono' }, p.root),
      el('div', { className: 'hint' },
        `${p.company.length} in the company · ${p.locations.length} location(s) · ${p.episodes.length} episode(s)`),
    ),
    el('h2', {}, 'Company'),
    el('div', { className: 'grid' },
      p.company.map((c) =>
        el('div', { className: 'card', onclick: () => go(`#/character/${c.id}`) },
          el('div', { className: 'thumb', style: c.sheet ? `background-image:url(${c.sheet})` : '' }, c.sheet ? '' : 'no sheet'),
          el('div', { className: 'meta' },
            el('div', { className: 'name' }, c.name),
            el('div', { className: 'note' },
              `${c.looks} look${c.looks === 1 ? '' : 's'} · ${c.hasVoice ? 'voice cast' : 'no voice'}`),
          ),
        ),
      ),
      el('div', { className: 'card', onclick: newCharacter },
        el('div', { className: 'thumb' }, '+ new character'),
        el('div', { className: 'meta' }, el('div', { className: 'note' }, 'Describe someone and draw them')),
      ),
    ),
    el('h2', {}, 'Scenes'),
    el('div', { className: 'grid' },
      p.episodes.flatMap((e) =>
        e.scenes.map((s) =>
          el('div', { className: 'card', onclick: () => go(`#/scene/${e.id}/${s}`) },
            el('div', { className: 'thumb' }, s),
            el('div', { className: 'meta' },
              el('div', { className: 'name' }, s),
              el('div', { className: 'note' }, e.title),
            ),
          ),
        ),
      ),
    ),
  );
};

views.character = async (id) => {
  const c = await api(`/character/${id}`);
  const defaultLook = c.defaultLook || 'default';

  const lookPanel = (look) => {
    const isDefault = look.id === defaultLook;
    return el('div', { className: 'panel' },
      el('div', { className: 'row', style: 'align-items:center;margin-bottom:12px' },
        el('div', {},
          el('strong', {}, look.label || look.id),
          isDefault ? el('span', { className: 'tag on', style: 'margin-left:8px' }, 'default')
                    : el('span', { className: 'tag', style: 'margin-left:8px' }, `derived from ${look.derivedFrom || defaultLook}`),
        ),
        el('div', { className: 'fit' },
          isDefault
            ? el('button', { onclick: () => drawLook(id, look.id) }, 'Draw a take')
            : el('button', { onclick: () => deriveLook(id, look) }, 'Re-derive from default'),
        ),
      ),
      look.wardrobe ? el('div', { className: 'hint', style: 'margin:-4px 0 12px' }, look.wardrobe) : '',
      takeGrid(look.takes, {
        kind: 'image',
        onSelect: async (take) => {
          await api(`/character/${id}/look/${look.id}/select`, 'POST', { take });
          render();
        },
      }),
      // The describe-a-change box. Always edits the APPROVED sheet, so the
      // character survives the change instead of being re-rolled.
      isDefault
        ? el('div', { style: 'margin-top:14px' },
            el('label', {}, 'Describe a change to this character'),
            el('div', { className: 'row' },
              el('input', { id: `note-${look.id}`, placeholder: 'Make her comb a little smaller and straighten her posture' }),
              el('button', {
                className: 'fit',
                onclick: async (ev) => {
                  const input = $(`#note-${look.id}`);
                  if (!input.value.trim()) return;
                  ev.target.disabled = true;
                  await api(`/character/${id}/look/${look.id}/edit`, 'POST', {
                    instruction: input.value.trim(), from: 'self',
                  });
                  input.value = '';
                  ev.target.disabled = false;
                  $('#jobs').hidden = false;
                },
              }, 'Edit'),
            ),
            el('div', { className: 'hint' },
              'Edits the selected sheet rather than drawing a new one, so the character stays the same person.'),
          )
        : '',
    );
  };

  return el('div', {},
    el('div', { className: 'row', style: 'align-items:flex-start' },
      el('div', {},
        el('h1', {}, c.name),
        el('p', { className: 'sub' }, c.note || c.sheet?.slice(0, 160) || ''),
      ),
      el('div', { className: 'fit' }, el('button', { className: 'ghost', onclick: () => go('#/') }, '← Company')),
    ),

    el('h2', {}, 'Wardrobe'),
    ...c.looks.sort((a, b) => (a.id === defaultLook ? -1 : b.id === defaultLook ? 1 : 0)).map(lookPanel),
    el('div', { className: 'panel' },
      el('strong', {}, 'Add a look'),
      el('div', { className: 'hint', style: 'margin:4px 0 12px' },
        'A new look is an edit of the approved default sheet, never a fresh drawing — that is what keeps it the same character in different clothes.'),
      el('div', { className: 'field' },
        el('label', {}, 'Name'),
        el('input', { id: 'lookName', placeholder: 'Mourning' })),
      el('div', { className: 'field' },
        el('label', {}, 'Wardrobe'),
        el('textarea', { id: 'lookWardrobe', placeholder: 'A high-collared black mourning gown of heavy matte silk, buttoned to the throat, with a long black lace veil.' })),
      el('div', { className: 'field' },
        el('label', {}, 'Remove (optional)'),
        el('input', { id: 'lookRemove', placeholder: 'the gold locket' })),
      el('button', {
        className: 'primary',
        onclick: async (ev) => {
          const label = $('#lookName').value.trim();
          const wardrobe = $('#lookWardrobe').value.trim();
          if (!label || !wardrobe) return;
          ev.target.disabled = true;
          const { id: lookId } = await api(`/character/${id}/look`, 'POST', {
            label, wardrobe, remove: $('#lookRemove').value.trim() || null,
          });
          await api(`/character/${id}/look/${lookId}/edit`, 'POST', {
            wardrobe, remove: $('#lookRemove').value.trim() || null,
          });
          $('#jobs').hidden = false;
          ev.target.disabled = false;
        },
      }, 'Create and draw'),
    ),

    el('h2', {}, 'Voice'),
    el('div', { className: 'panel' },
      el('div', { className: 'hint', style: 'margin-bottom:12px' },
        'Filmed alone in a dead room, saying a line that is in no script. The stripped audio becomes this character\'s voice in every shot they speak in — which is why it cannot be inherited from whatever the previous shot happened to contain.'),
      c.voice.audio ? el('audio', { src: c.voice.audio, controls: true, style: 'width:100%;margin-bottom:12px' }) : '',
      el('div', { className: 'field' },
        el('label', {}, 'Sample line'),
        el('input', { id: 'voiceLine', value: c.line || '' })),
      el('div', { className: 'field' },
        el('label', {}, 'Direction'),
        el('input', { id: 'voiceDirection', value: c.direction || '' })),
      el('button', {
        onclick: async (ev) => {
          ev.target.disabled = true;
          await api(`/character/${id}`, 'PATCH', {
            line: $('#voiceLine').value, direction: $('#voiceDirection').value,
          });
          await api(`/character/${id}/voice`, 'POST', {});
          $('#jobs').hidden = false;
          ev.target.disabled = false;
        },
      }, c.voice.audio ? 'Cast another take' : 'Cast the voice'),
      el('div', { style: 'margin-top:14px' },
        takeGrid(c.voice.takes.filter((t) => t.url?.endsWith('.mp4')), {
          kind: 'video',
          onSelect: async (take) => { await api(`/character/${id}/voice/select`, 'POST', { take }); render(); },
        })),
    ),
  );
};

views.scene = async (ep, sc) => {
  const s = await api(`/scene/${ep}/${sc}`);

  const shotPanel = (shot) =>
    el('div', { className: 'panel' },
      el('div', { className: 'row', style: 'align-items:center;margin-bottom:10px' },
        el('div', {},
          el('strong', {}, shot.slate || shot.id),
          el('span', { className: 'tag', style: 'margin-left:8px' }, `${shot.duration}s`),
          shot.chain ? el('span', { className: 'tag', style: 'margin-left:6px' }, `chains ${shot.chain}`) : '',
        ),
        el('div', { className: 'fit' },
          el('button', {
            className: 'small',
            onclick: async () => {
              const p = await api(`/scene/${ep}/${sc}/prompt/${shot.id}`);
              modal(shot.slate || shot.id, el('pre', { className: 'mono', style: 'white-space:pre-wrap' }, p.prompt));
            },
          }, 'Prompt'),
          ' ',
          el('button', {
            className: 'small',
            onclick: async () => { await api(`/scene/${ep}/${sc}/shoot`, 'POST', { shots: [shot.id] }); $('#jobs').hidden = false; },
          }, 'Roll another take'),
        ),
      ),
      (shot.lines || []).length
        ? el('div', { className: 'hint', style: 'margin:-4px 0 12px' },
            shot.lines.map((l) => `${l.speaker}: “${l.es || l.text}”`).join('   '))
        : '',
      takeGrid(shot.takes, {
        kind: 'video',
        onSelect: async (take) => {
          await api(`/scene/${ep}/${sc}/shot/${shot.id}/select`, 'POST', { take });
          render();
        },
      }),
    );

  return el('div', {},
    el('div', { className: 'row', style: 'align-items:flex-start' },
      el('div', {},
        el('h1', {}, s.title || sc),
        el('p', { className: 'sub' },
          `${s.shots.length} shots · ${s.location}/${s.state} · ${s.cast.map((c) => `${c.character} ${c.side}`).join(', ')}`),
      ),
      el('div', { className: 'fit' }, el('button', { className: 'ghost', onclick: () => go('#/') }, '← Overview')),
    ),

    s.cut
      ? el('div', { className: 'panel' },
          el('video', { src: s.cut + `?t=${Date.now()}`, controls: true, style: 'width:100%;border-radius:8px' }))
      : '',

    el('div', { className: 'panel' },
      el('div', { className: 'row', style: 'align-items:center' },
        el('div', {},
          el('strong', {}, `Estimated $${s.estimate.total.toFixed(2)} to shoot all ${s.shots.length}`),
          el('div', { className: 'hint' },
            `at ${s.estimate.resolution}. Approximate — fal bills on tokens, and a video reference is billed for its input seconds too.`),
        ),
        el('div', { className: 'fit' },
          el('button', {
            onclick: async () => { await api(`/scene/${ep}/${sc}/shoot`, 'POST', { resolution: '480p' }); $('#jobs').hidden = false; },
          }, 'Block at 480p'),
          ' ',
          el('button', {
            onclick: async () => { await api(`/scene/${ep}/${sc}/shoot`, 'POST', {}); $('#jobs').hidden = false; },
          }, 'Shoot all'),
        ),
      ),
    ),

    el('h2', {}, 'Coverage'),
    ...s.shots.map(shotPanel),

    el('h2', {}, 'The cut'),
    el('div', { className: 'panel' },
      el('div', { className: 'row', style: 'align-items:center' },
        el('div', {},
          el('div', {}, s.bed ? 'Bed composed.' : 'No music bed yet.'),
          el('div', { className: 'hint' },
            'One unbroken bed under the whole scene — never one per shot, or the music restarts at every cut.'),
        ),
        el('div', { className: 'fit' },
          el('button', { onclick: async () => { await api(`/scene/${ep}/${sc}/bed`, 'POST', {}); $('#jobs').hidden = false; } },
            s.bed ? 'Recompose bed' : 'Compose bed'),
          ' ',
          el('button', { className: 'primary', onclick: async () => { await api(`/scene/${ep}/${sc}/cut`, 'POST', {}); $('#jobs').hidden = false; } },
            'Cut the scene'),
        ),
      ),
      s.bed ? el('audio', { src: s.bed, controls: true, style: 'width:100%;margin-top:12px' }) : '',
    ),

    el('div', { className: 'panel' },
      el('div', { className: 'row', style: 'align-items:center' },
        el('div', {},
          el('strong', {}, 'Continuity'),
          el('div', { className: 'hint' }, 'Voice, grade and timing drift across the scene. Advisory — nothing here blocks a cut.'),
        ),
        el('div', { className: 'fit' },
          el('button', {
            onclick: async (ev) => {
              ev.target.disabled = true;
              try { modal('Continuity', continuityTable(await api(`/scene/${ep}/${sc}/check`))); }
              finally { ev.target.disabled = false; }
            },
          }, 'Run check'),
        ),
      ),
    ),
  );
};

function continuityTable(r) {
  const rows = [];
  rows.push(el('h2', { style: 'margin-top:0' }, 'Voice'));
  for (const v of r.voice) {
    rows.push(el('div', { className: 'hint' }, `${v.character} — plate ${v.plateHz?.toFixed(1) ?? '—'} Hz`));
    rows.push(el('table', {},
      el('tr', {}, el('th', {}, 'shot'), el('th', { className: 'num' }, 'median f0'), el('th', { className: 'num' }, 'drift')),
      ...(v.rows || []).map((row) =>
        el('tr', { className: row.flagged ? 'flag' : '' },
          el('td', {}, row.shot),
          el('td', { className: 'num' }, `${row.hz.toFixed(1)} Hz`),
          el('td', { className: 'num' }, `${row.driftPct >= 0 ? '+' : ''}${row.driftPct.toFixed(1)}%`))),
    ));
  }
  rows.push(el('h2', {}, 'Grade'));
  rows.push(el('table', {},
    el('tr', {}, el('th', {}, 'cut'), el('th', { className: 'num' }, 'Δ mean luma')),
    ...r.grade.pairs.map((p) =>
      el('tr', { className: p.flagged ? 'flag' : '' },
        el('td', {}, `${p.from} → ${p.to}`),
        el('td', { className: 'num' }, p.delta.toFixed(1)))),
  ));
  rows.push(el('h2', {}, 'Timing'));
  rows.push(el('table', {},
    el('tr', {}, el('th', {}, 'shot'), el('th', { className: 'num' }, 'silence after last line')),
    ...r.timing.rows.map((row) =>
      el('tr', { className: row.flagged ? 'flag' : '' },
        el('td', {}, row.shot),
        el('td', { className: 'num' }, row.tail == null ? '—' : `${row.tail.toFixed(2)}s`))),
  ));
  return rows;
}

views.models = async () => {
  const m = state.models || (state.models = await api('/models'));
  const section = (title, list, note) =>
    el('div', {},
      el('h2', {}, title),
      note ? el('p', { className: 'sub' }, note) : '',
      ...list.map((x) =>
        el('div', { className: 'panel' },
          el('div', {},
            el('strong', {}, x.label),
            x.recommended ? el('span', { className: 'tag on', style: 'margin-left:8px' }, 'default') : '',
            el('span', { className: 'tag', style: 'margin-left:6px' }, x.lab),
          ),
          el('div', { className: 'mono', style: 'margin:4px 0' }, x.id),
          x.note ? el('div', { className: 'hint' }, x.note) : '',
          el('div', { style: 'margin-top:8px' }, x.pricing || 'pricing unavailable'),
        ),
      ),
    );
  return el('div', {},
    el('h1', {}, 'Models'),
    el('p', { className: 'sub' },
      'Prices come live from fal and are never hardcoded here — a price baked into source is wrong the first week it changes, and wrong silently.'),
    section('Image editing', m.edit, 'Used for wardrobe and for every "describe a change" edit.'),
    section('Image generation', m.image, 'Used for the default sheet and for location plates.'),
    section('Video', m.video, 'Note: no seed input, which is why a take can never be reproduced.'),
  );
};

// ---------------------------------------------------------------------------
// Creating a character
// ---------------------------------------------------------------------------

function newCharacter() {
  modal('New character', [
    el('div', { className: 'field' }, el('label', {}, 'Name'), el('input', { id: 'ncName', placeholder: 'Rosalinda' })),
    el('div', { className: 'field' },
      el('label', {}, 'Who they are, and what they look like'),
      el('textarea', {
        id: 'ncSheet', style: 'min-height:120px',
        placeholder: 'A young hen, the ingenue of a telenovela. Creamy off-white plumage, large expressive amber eyes, a small neat scarlet comb. She wears a deep crimson silk dress with black lace at the shoulders and a gold locket at her throat.',
      })),
    el('div', { className: 'field' },
      el('label', {}, 'One-line note for the video model'),
      el('input', { id: 'ncNote', placeholder: 'Rosalinda — the young hen with creamy plumage, amber eyes and a crimson dress.' })),
    el('div', { className: 'row' },
      el('div', { className: 'field' },
        el('label', {}, 'Voice sample line'),
        el('input', { id: 'ncLine', placeholder: 'Something they would say, that is in no script' })),
      el('div', { className: 'field' },
        el('label', {}, 'Voice direction'),
        el('input', { id: 'ncDirection', placeholder: 'young, warm, soft-spoken, unhurried' })),
    ),
    el('button', {
      className: 'primary',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          const { id } = await api('/character', 'POST', {
            name: $('#ncName').value.trim(),
            sheet: $('#ncSheet').value.trim(),
            note: $('#ncNote').value.trim(),
            line: $('#ncLine').value.trim(),
            direction: $('#ncDirection').value.trim(),
          });
          await api(`/character/${id}/look/default/generate`, 'POST', {});
          closeModal();
          state.project = await api('/project');
          go(`#/character/${id}`);
          $('#jobs').hidden = false;
        } catch (err) {
          alert(err.message);
          ev.target.disabled = false;
        }
      },
    }, 'Create and draw the sheet'),
    el('div', { className: 'hint' }, 'Draws the default sheet. Every wardrobe look is later edited from whichever take you approve.'),
  ]);
}

async function drawLook(id, lookId) {
  await api(`/character/${id}/look/${lookId}/generate`, 'POST', {});
  $('#jobs').hidden = false;
}
async function deriveLook(id, look) {
  await api(`/character/${id}/look/${look.id}/edit`, 'POST', {
    wardrobe: look.wardrobe, remove: look.remove,
  });
  $('#jobs').hidden = false;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const go = (hash) => { location.hash = hash; };

async function render() {
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  const view = $('#view');
  try {
    if (!state.project) state.project = await api('/project');
    let node;
    if (parts[0] === 'character') node = await views.character(parts[1]);
    else if (parts[0] === 'scene') node = await views.scene(parts[1], parts[2]);
    else if (parts[0] === 'models') node = await views.models();
    else node = await views.overview();
    view.replaceChildren(node);
  } catch (err) {
    view.replaceChildren(el('div', { className: 'empty note-bad' }, err.message));
  }

  const here = parts[0] || '';
  $('#nav').replaceChildren(
    el('a', { href: '#/', className: here === '' ? 'on' : '' }, 'Overview'),
    el('a', { href: '#/models', className: here === 'models' ? 'on' : '' }, 'Models'),
  );
}

$('#jobsToggle').onclick = () => { $('#jobs').hidden = !$('#jobs').hidden; };
$('#jobsClose').onclick = () => { $('#jobs').hidden = true; };
$('#modalClose').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
addEventListener('hashchange', render);

api('/jobs').then((list) => { for (const j of list) state.jobs.set(j.id, j); renderJobs(); });
watchJobs();
render();
