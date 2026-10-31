# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["sounddevice>=0.5", "numpy"]
# ///
"""Records this computer's microphone to a 16 kHz mono WAV until you press Enter.

Called by `orc record` as `uv run tools/record.py <out.wav> [--seconds N]`. Writes straight to the
file as it goes, so a crash keeps what was already said. Prints the length in seconds at the end.
"""

import argparse
import queue
import sys
import threading
import time
import wave

import sounddevice as sd

RATE = 16000


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seconds", type=float, default=0, help="stop by itself after this long (for testing)")
    args = ap.parse_args()

    chunks: "queue.Queue[bytes]" = queue.Queue()
    stop = threading.Event()
    if not args.seconds:
        threading.Thread(target=lambda: (sys.stdin.readline(), stop.set()), daemon=True).start()

    started = time.time()
    with wave.open(args.out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        with sd.RawInputStream(samplerate=RATE, channels=1, dtype="int16", callback=lambda data, *_: chunks.put(bytes(data))):
            while not stop.is_set() and not (args.seconds and time.time() - started >= args.seconds):
                try:
                    w.writeframes(chunks.get(timeout=0.2))
                except queue.Empty:
                    pass
                print(f"\rRecording {int(time.time() - started)} s. Press Enter to stop.", end="", file=sys.stderr, flush=True)
        while not chunks.empty():
            w.writeframes(chunks.get())
    print(file=sys.stderr)
    print(round(time.time() - started, 1))


if __name__ == "__main__":
    main()
