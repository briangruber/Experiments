// The edit.
//
// Trim each shot to its marks, hard cut between them, lay one continuous music
// bed underneath, burn the titles. No dissolves and no per-shot audio
// treatment: a shot/reverse exchange is cut hard, and dissolving it would read
// as a time jump.
//
// Three decisions in here carry the whole result:
//
// 1. The picture cuts hard and so does the diegetic audio. Room tone differs
//    between two independently generated shots, so that audio cut is a real
//    seam. It is not fixed by fading — a dip at the cut is more audible than
//    the seam itself — it is *masked*, by the one element that runs straight
//    through the edit untouched.
//
// 2. That element is the bed, and it is sidechained to the dialogue rather than
//    set to a fixed low level. A fixed level either buries the voices in the
//    loud moments or vanishes in the quiet ones. Ducking keeps it present under
//    the silences and out of the way under the lines, which is what makes it
//    read as scoring rather than as backing track.
//
// 3. The bed is written once across the whole scene and never per shot. Left to
//    itself the video model scores every shot independently, so the music
//    restarts at every cut and the scene sounds broken however well the
//    pictures match. That is why the shot prompts forbid music outright.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { exists } from './store.mjs';

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Styled like a film subtitle rather than a player default: a heavy outline and
// a soft shadow, so white type survives both blown-out practicals and near
// black corners — the whole difficulty of titling a night interior.
const SUB_STYLE = [
  'FontName=DejaVu Sans', 'FontSize=21', 'Bold=1',
  'PrimaryColour=&H00FFFFFF', 'OutlineColour=&HC0000000', 'BackColour=&H80000000',
  'BorderStyle=1', 'Outline=1.6', 'Shadow=0.7',
  'Alignment=2', 'MarginV=34',
].join(',');

// `shots` is [{ id, file, in, out }] in cut order.
export async function cut({
  shots, out, bed = null, subtitles = null, cwd,
  width = 1280, height = 720, fps = 24, crf = 18,
}) {
  if (!shots.length) throw new Error('nothing to cut');

  const total = shots.reduce((n, s) => n + (s.out - s.in), 0);
  const useBed = bed && (await exists(bed));
  const parts = [];

  shots.forEach((s, i) => {
    // setpts/asetpts rebase each trimmed segment to zero. Without them concat
    // honours the original timestamps and the second shot lands several seconds
    // into a black frame.
    parts.push(`[${i}:v]trim=${s.in}:${s.out},setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height},setsar=1[v${i}]`);
    parts.push(`[${i}:a]atrim=${s.in}:${s.out},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
  });

  parts.push(`${shots.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${shots.length}:v=1:a=1[vcat][acat]`);

  const fade = `fade=t=in:st=0:d=0.35,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5`;
  // Burned after the fades, so the type stays at full strength over the opening
  // frames instead of dimming with the picture.
  parts.push(
    subtitles
      ? `[vcat]${fade},subtitles=f=${relative(cwd, subtitles)}:force_style='${SUB_STYLE}'[vout]`
      : `[vcat]${fade}[vout]`,
  );

  let aout = '[acat]';
  if (useBed) {
    // Split so the dialogue can key the compressor that ducks its own bed.
    parts.push('[acat]asplit=2[adry][akey]');
    parts.push(
      `[${shots.length}:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,` +
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,' +
      // Shelved out of the way of the voices before it is even ducked.
      'highpass=f=60,volume=0.30,' +
      `afade=t=in:st=0:d=1.2,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6[bedraw]`,
    );
    parts.push('[bedraw][akey]sidechaincompress=threshold=0.03:ratio=8:attack=25:release=450:makeup=1[bedduck]');
    parts.push('[adry][bedduck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]');
    aout = '[aout]';
  }

  await mkdir(join(out, '..'), { recursive: true }).catch(() => {});

  const cmd = [
    '-y',
    ...shots.flatMap((s) => ['-i', s.file]),
    ...(useBed ? ['-i', bed] : []),
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', aout,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    out,
  ];

  // cwd is the project root so the subtitles filter can name its file with a
  // bare relative path. An absolute one needs its colons escaped inside the
  // filter graph, which is a class of bug not worth inviting.
  await run(FFMPEG, cmd, { maxBuffer: 1 << 26, cwd });
  return { out, seconds: total, bytes: (await stat(out)).size };
}

// Attaching both languages as selectable tracks costs nothing and means the
// file can be watched either way without a re-encode. Done as a stream copy
// after the fact so the expensive video encode happens exactly once.
export async function attachSubtitles({ video, srt, out, cwd }) {
  const langs = Object.entries(srt);
  if (!langs.length) return video;
  const cmd = [
    '-y', '-i', video,
    ...langs.flatMap(([, path]) => ['-i', path]),
    '-map', '0:v', '-map', '0:a',
    ...langs.flatMap((_, i) => ['-map', `${i + 1}:s:0`]),
    '-c', 'copy', '-c:s', 'mov_text',
    ...langs.flatMap(([lang], i) => [`-metadata:s:s:${i}`, `language=${{ en: 'eng', es: 'spa' }[lang] || lang}`]),
    '-movflags', '+faststart',
    out,
  ];
  await run(FFMPEG, cmd, { maxBuffer: 1 << 26, cwd });
  return out;
}
