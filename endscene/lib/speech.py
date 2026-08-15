#!/usr/bin/env python3
"""Find where speech actually is in a clip, rather than where it was asked to be.

    python3 tools/speech.py shots/c-respuesta.mp4 --from 0.4 --to 6.0

Prints JSON: the voiced spans inside that window, in seconds relative to the
window's start.

This exists because the model's timing cannot be trusted. The prompts give
beats ("3–4.5s: she asks…") and a rule that speech must finish a second before
the end, and both are honoured loosely at best — the first take of 1B ran a
line to the final frame, and the voice plates did the same despite being told
not to. Anything downstream that needs to know *when* a line happens therefore
has to measure it. Subtitles are the obvious case: place them off the written
beats and they drift off the mouth, which is exactly the kind of amateurish
detail this whole pipeline exists to avoid.

The detector is the same blunt autocorrelation voicing test as voicecheck.py,
which is the point — speech is periodic, rain and thunder and paper are not,
so requiring periodicity rejects the diegetic layer without needing to model
it. Frames are then merged into utterances across short gaps, because a comma
is not the end of a line.
"""

import argparse
import json
import subprocess
import sys
import numpy as np

SR = 16000
FRAME = 1024
HOP = 160  # 10 ms, fine enough to place a subtitle on
F_MIN, F_MAX = 60.0, 400.0
VOICING = 0.35

# A speaker pausing mid-sentence should not become two subtitles, and a real
# gap between two lines should not become one. 350 ms sits between a comma and
# a beat in every take here.
GAP = 0.35
# Below this a "span" is a click, a consonant burst, or a stray periodic
# artefact in the thunder — not an utterance.
MIN_SPAN = 0.25


def load(path, start, end):
    cmd = ['ffmpeg', '-v', 'error']
    if start:
        cmd += ['-ss', str(start)]
    if end:
        cmd += ['-to', str(end)]
    cmd += ['-i', path, '-vn', '-af', 'highpass=f=55', '-ac', '1',
            '-ar', str(SR), '-f', 'f32le', '-']
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def voiced_frames(x):
    """Boolean per hop: is this frame periodic enough to be speech?"""
    rms = np.sqrt(np.mean(x ** 2)) or 1e-9
    flags, times = [], []
    lo, hi = int(SR / F_MAX), int(SR / F_MIN)
    win = np.hanning(FRAME)

    for i in range(0, max(len(x) - FRAME, 0), HOP):
        times.append(i / SR)
        frame = x[i:i + FRAME]
        # Quiet frames are not speech regardless of how they correlate.
        if np.sqrt(np.mean(frame ** 2)) < rms * 0.45:
            flags.append(False)
            continue
        f = (frame - frame.mean()) * win
        spec = np.fft.rfft(f, 2 * FRAME)
        ac = np.fft.irfft(spec * np.conj(spec))[:FRAME]
        if ac[0] <= 0:
            flags.append(False)
            continue
        peak = int(np.argmax(ac[lo:hi])) + lo
        flags.append(ac[peak] / ac[0] >= VOICING)

    return np.array(flags), np.array(times)


def spans(flags, times):
    """Merge voiced frames into utterances."""
    out = []
    start = None
    for i, on in enumerate(flags):
        if on and start is None:
            start = times[i]
        elif not on and start is not None:
            out.append([start, times[i]])
            start = None
    if start is not None:
        out.append([start, times[-1] if len(times) else start])

    merged = []
    for s in out:
        if merged and s[0] - merged[-1][1] <= GAP:
            merged[-1][1] = s[1]
        else:
            merged.append(s)

    return [{'start': round(a, 3), 'end': round(b, 3)}
            for a, b in merged if b - a >= MIN_SPAN]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--from', dest='start', type=float, default=None)
    ap.add_argument('--to', dest='end', type=float, default=None)
    args = ap.parse_args()

    x = load(args.path, args.start, args.end)
    if x.size < FRAME:
        print('[]')
        sys.exit(0)
    print(json.dumps(spans(*voiced_frames(x))))
