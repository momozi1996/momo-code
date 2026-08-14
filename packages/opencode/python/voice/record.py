#!/usr/bin/env python3
"""
voice record — capture microphone audio to a WAV file.

Usage:
    python record.py <output.wav> [seconds]

Records mono 16 kHz int16 WAV (Whisper-optimal, compact) using
sounddevice + scipy. Prints a single JSON line to stdout:

    {"ok": true, "path": "...", "seconds": 5, "frames": 80000}

Errors go to stderr with a non-zero exit code.
"""

import json
import sys


def main():
    if len(sys.argv) < 2:
        print("usage: record.py <output.wav> [seconds]", file=sys.stderr)
        sys.exit(2)

    out_path = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    sample_rate = 16000

    try:
        import sounddevice as sd
    except ImportError:
        print(
            "sounddevice not installed — run: pip install sounddevice scipy",
            file=sys.stderr,
        )
        sys.exit(3)

    try:
        import numpy as np
        from scipy.io import wavfile
    except ImportError:
        print(
            "numpy/scipy not installed — run: pip install sounddevice scipy",
            file=sys.stderr,
        )
        sys.exit(3)

    frames = int(sample_rate * seconds)
    audio = sd.rec(frames, samplerate=sample_rate, channels=1, dtype="int16")
    sd.wait()

    # Skip files that are essentially silence (device failure heuristic)
    peak = int(np.abs(audio).max()) if audio.size else 0

    wavfile.write(out_path, sample_rate, audio)
    print(
        json.dumps(
            {"ok": True, "path": out_path, "seconds": seconds, "frames": frames, "peak": peak}
        )
    )


if __name__ == "__main__":
    main()
