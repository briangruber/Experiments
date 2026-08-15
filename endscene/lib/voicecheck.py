#!/usr/bin/env python3
"""Measure a character's pitch, so voice drift can be caught without ears.

    python3 tools/voicecheck.py refs/voice-perpetua.mp3 shots/a-dosdisparos.mp4 ...

Voice consistency is the one thing in this pipeline that cannot be checked by
looking at a frame, and "it sounds a bit different" is not a reviewable claim.
This reduces a clip to one number: the median fundamental frequency of its
voiced speech, in hertz. Same character, same casting -> the numbers should sit
within a few percent of each other. A shot that has drifted to another voice
moves tens of hertz and shows up immediately.

Method is deliberately blunt and dependency-light: high-pass to kill rumble,
window the signal, keep only frames with enough energy and a strong enough
autocorrelation peak to be voiced at all, and take the median over those. It is
not a research-grade pitch tracker. It does not need to be — it is a tripwire,
and the failure it is looking for is not subtle.

Reports the median, the interquartile spread (a wide spread on a single
character usually means the clip caught two speakers, or none), and the share
of the clip that was voiced at all.
"""

import subprocess
import sys
import numpy as np

SR = 16000
FRAME = 1024
HOP = 256
# Bracketing a plausible speaking range. The floor also keeps the detector off
# the room-tone rumble that survives the high-pass.
F_MIN, F_MAX = 60.0, 400.0


def load(path):
    """Decode anything ffmpeg can read into mono float32 at SR, high-passed."""
    wav = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-vn',
         '-af', 'highpass=f=55', '-ac', '1', '-ar', str(SR),
         '-f', 'f32le', '-'],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(wav, dtype=np.float32)


def f0(frame):
    """Autocorrelation pitch for one frame, or None if it isn't voiced."""
    frame = frame - frame.mean()
    n = len(frame)
    # Autocorrelation via FFT, zero-padded to avoid circular wraparound.
    spec = np.fft.rfft(frame, 2 * n)
    ac = np.fft.irfft(spec * np.conj(spec))[:n]
    if ac[0] <= 0:
        return None

    lo, hi = int(SR / F_MAX), min(int(SR / F_MIN), n - 1)
    if hi <= lo:
        return None

    window = ac[lo:hi]
    peak = int(np.argmax(window)) + lo
    # Normalised peak height is the voicing test: periodic speech correlates
    # strongly with itself a pitch period later, noise and silence do not.
    if ac[peak] / ac[0] < 0.35:
        return None

    # Parabolic interpolation around the peak — at 16 kHz a whole-sample lag is
    # worth several hertz up in the female range, which is enough to matter.
    if 0 < peak < n - 1:
        a, b, c = ac[peak - 1], ac[peak], ac[peak + 1]
        denom = a - 2 * b + c
        if denom != 0:
            peak = peak + 0.5 * (a - c) / denom

    return SR / peak


def measure(path):
    x = load(path)
    if x.size < FRAME:
        return None

    # Only look at frames loud enough to be someone talking. The threshold is
    # relative to the clip's own peak so it survives level differences.
    rms = np.sqrt(np.mean(x ** 2)) or 1e-9
    pitches, frames = [], 0
    for i in range(0, len(x) - FRAME, HOP):
        frame = x[i:i + FRAME]
        if np.sqrt(np.mean(frame ** 2)) < rms * 0.5:
            continue
        frames += 1
        p = f0(frame * np.hanning(FRAME))
        if p is not None:
            pitches.append(p)

    if len(pitches) < 10:
        return None
    p = np.array(pitches)
    return {
        'median': float(np.median(p)),
        'iqr': float(np.percentile(p, 75) - np.percentile(p, 25)),
        'voiced': len(p) / max(frames, 1),
        'seconds': len(x) / SR,
    }


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--json']
    as_json = '--json' in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)

    # Machine-readable mode, for lib/continuity.mjs. The table below is for
    # people; this is for the continuity report.
    if as_json:
        import json as _json
        out = []
        for path in args:
            r = measure(path)
            out.append({'file': path, **r} if r else {'file': path, 'median': None})
        print(_json.dumps(out))
        sys.exit(0)

    print(f"{'clip':<34} {'median f0':>10} {'IQR':>8} {'voiced':>8}")
    print('-' * 62)
    for path in args:
        r = measure(path)
        if r is None:
            print(f'{path:<34} {"— no voiced speech":>28}')
        else:
            print(f"{path:<34} {r['median']:>7.1f} Hz {r['iqr']:>6.1f} Hz {r['voiced']:>7.0%}")
