// The one and only card renderer. Title cards and subtitles are drawn in 2D
// canvas — onto the live page's overlay canvas, onto the export mixing canvas,
// and onto the offline renderer's frames — by this same function. It used to
// have a twin: the page built DOM cards styled by ui.css while the export
// re-implemented that styling here, and three separate releases shipped with
// the two disagreeing (titles clipping at the frame edge, missing scrims,
// missing speaker plates). One renderer, no drift.

const GOLD = '#e8c98a';
const GOLD_DIM = '#a8895a';
// The small type — brighter and less tracked than the display gold, because at
// a third of the size it needs the help.
const KICKER = '#cfae7d';
const CARD_SUB = '#ecd9b6';
const SERIF = '"Hoefler Text", "Playfair Display", Georgia, "Times New Roman", serif';

// Type sizes and top offsets per card kind: a viewport-relative size clamped
// between a floor and a ceiling in pixels, against whatever frame width the
// caller is drawing into.
const CARD_STYLE = {
  main: { top: 0.34, min: 30, vw: 6.4, max: 86 },
  act: { top: 0.62, min: 17, vw: 2.5, max: 34 },
  end: { top: 0.40, min: 26, vw: 5.0, max: 68 },
  credit: { top: 0.58, min: 20, vw: 3.2, max: 44 },
  cast: { top: 0.63, min: 19, vw: 3.0, max: 40 },
  stinger: { top: 0.20, min: 18, vw: 3.0, max: 40 },
  subtitle: { top: 0.78, min: 15, vw: 2.05, max: 27 },
};

// Subtitles are the one card kind long enough to need wrapping. Two lines
// maximum — a third would run into the letterbox bar. `firstIndent` is the
// width the speaker's name plate takes out of the first line.
function wrap(ctx, text, maxWidth, maxLines = 2, firstIndent = 0) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    const room = maxWidth - (lines.length === 0 ? firstIndent : 0);
    if (line && ctx.measureText(next).width > room && lines.length < maxLines - 1) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A soft elliptical scrim behind every card. The small text — kickers, role
// lines, subtitles — is gold-on-courtyard and competes with lantern light and
// bougainvillea without it. Painted as a feathered radial rather than a box,
// so it reads as vignetting rather than as a caption background.
function scrim(ctx, cx, cy, rx, ry, strength) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(0.5, `rgba(0,0,0,${strength * 0.72})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = g;
  ctx.fillRect(cx - 1, cy - 1, 2, 2);
  ctx.restore();
}

export function drawCards(ctx, titles, w, h) {
  for (const c of titles.cards) {
    const a = c.alpha ?? 0;
    if (a <= 0.002) continue;
    const st = CARD_STYLE[c.kind] || CARD_STYLE.act;

    // Subtitles are set flush, in white, wrapped — everything the gold
    // display treatment below is not.
    if (c.kind === 'subtitle') {
      const base = Math.max(st.min, Math.min(st.max, (st.vw * w) / 100));
      // Narration is upright, warm and wider-tracked; dialogue is white italic
      // with the speaker's name beside it. The narrator is not in the
      // courtyard, so his lines are not dialogue — and the absence of a name
      // plate is half of what marks him out.
      const size = c.narration ? base * 0.94 : base;
      const lineFont = c.narration ? `400 ${size}px ${SERIF}` : `italic 400 ${size}px ${SERIF}`;
      const lineTrack = c.narration ? '0.1em' : '0.015em';
      const lineFill = c.narration ? '#f0d9a6' : '#f2ece2';

      // The name plate takes width out of the first line, so measure it first.
      const ns = size * 0.82;
      const nameFont = `400 ${ns}px ${SERIF}`;
      let plate = 0;
      if (c.speaker) {
        ctx.save();
        ctx.font = nameFont;
        ctx.letterSpacing = '0.14em';
        plate = ctx.measureText(c.speaker.toUpperCase()).width + size * 0.75;
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = a;
      ctx.textBaseline = 'top';
      ctx.letterSpacing = lineTrack;
      ctx.font = lineFont;
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = size * 0.5;

      const maxW = Math.min(w * 0.78, 780);
      const lines = wrap(ctx, c.text, maxW, 2, plate);
      // Anchor the block's last line where a single line would sit, so a
      // two-line subtitle grows upward instead of into the letterbox.
      let y = st.top * h - (lines.length - 1) * size * 1.32;
      const widths = lines.map((l, i) => ctx.measureText(l).width + (i === 0 ? plate : 0));
      const widest = Math.max(...widths);
      const blockH = lines.length * size * 1.32;

      ctx.save();
      ctx.globalAlpha = a;
      scrim(ctx, w / 2, y + blockH / 2 - size * 0.16,
        widest / 2 + size * 1.6, blockH / 2 + size * 0.9, 0.7);
      ctx.restore();

      ctx.textAlign = 'left';
      for (let i = 0; i < lines.length; i++) {
        let x = w / 2 - widths[i] / 2;
        if (i === 0 && c.speaker) {
          ctx.save();
          ctx.font = nameFont;
          ctx.letterSpacing = '0.14em';
          ctx.fillStyle = GOLD;
          ctx.fillText(c.speaker.toUpperCase(), x, y + (size - ns) * 0.55);
          ctx.restore();
          x += plate;
        }
        ctx.font = lineFont;
        ctx.letterSpacing = lineTrack;
        ctx.fillStyle = lineFill;
        ctx.fillText(lines[i], x, y);
        y += size * 1.32;
      }
      ctx.restore();
      continue;
    }

    const size = Math.max(st.min, Math.min(st.max, (st.vw * w) / 100));
    const cx = w / 2;
    let y = st.top * h + (c.drift ?? 1) * (0.5 - (c.progress ?? 0)) * 6;

    // The card box is `min(88vw, 900px)` and text wraps inside it. An earlier
    // renderer did not wrap at all, so CORAZÓN DE GALLINA — 1264px of text —
    // was drawn on one line into a 1280px frame and lost a letter off each end.
    const cardW = Math.min(w * 0.88, 900);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = size * 0.35;

    const ks = size * 0.33;
    let kickerLines = [];
    if (c.kicker) {
      ctx.font = `italic 400 ${ks}px ${SERIF}`;
      ctx.letterSpacing = '0.26em';
      kickerLines = wrap(ctx, c.kicker, cardW, 2);
    }
    ctx.font = `400 ${size}px ${SERIF}`;
    ctx.letterSpacing = '0.24em';
    const titleLines = wrap(ctx, c.text, cardW, 3);
    const titleW = Math.max(...titleLines.map((l) => ctx.measureText(l).width));

    // The scrim has to cover however many lines it turned out to be.
    {
      const rows = titleLines.length + kickerLines.length + (c.sub ? 1 : 0) + (c.rule ? 0.5 : 0);
      ctx.save();
      scrim(ctx, cx, y + size * (rows * 0.55 - 0.2),
        Math.max(titleW / 2 + size * 1.7, w * 0.16), size * (rows * 0.95 + 0.8), 0.62);
      ctx.restore();
    }

    if (kickerLines.length) {
      ctx.font = `italic 400 ${ks}px ${SERIF}`;
      ctx.letterSpacing = '0.26em';
      ctx.fillStyle = KICKER;
      for (const l of kickerLines) { ctx.fillText(l, cx + ks * 0.13, y); y += ks * 1.25; }
      y += ks * 1.0;
    }

    ctx.font = `400 ${size}px ${SERIF}`;
    ctx.letterSpacing = '0.24em';
    ctx.fillStyle = GOLD;
    // Letter-spacing pads the right edge, so nudge back by half a step to keep
    // the line optically centred.
    for (const l of titleLines) { ctx.fillText(l, cx + size * 0.12, y); y += size * 1.18; }
    y -= size * 0.03;

    if (c.rule) {
      ctx.shadowBlur = 0;
      const rw = w * 0.22;
      const g = ctx.createLinearGradient(cx - rw, 0, cx + rw, 0);
      g.addColorStop(0, 'rgba(168,137,90,0)');
      g.addColorStop(0.5, GOLD_DIM);
      g.addColorStop(1, 'rgba(168,137,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rw, y + size * 0.25, rw * 2, 1);
      y += size * 0.7;
      ctx.shadowBlur = size * 0.35;
    }

    if (c.sub) {
      const ss = size * (c.kind === 'credit' ? 0.42 : 0.4);
      ctx.font = `italic 400 ${ss}px ${SERIF}`;
      ctx.letterSpacing = '0.28em';
      ctx.fillStyle = CARD_SUB;
      ctx.fillText(c.sub, cx + ss * 0.14, y + ss * 0.5);
    }
    ctx.restore();
  }
  ctx.letterSpacing = '0px';
}
