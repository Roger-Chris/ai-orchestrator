# /// script
# requires-python = ">=3.10,<3.12"
# dependencies = [
#   "openwakeword>=0.6,<0.7",
#   "sounddevice>=0.4",
#   "numpy>=1.24,<2",
# ]
# ///
"""Listens for "Hey Jarvis" on this computer's microphone (openWakeWord, runs on the CPU, no key).

Started by `orc wake` (src/voice/wake.ts) as `uv run tools/wakeword.py`. It talks JSON lines:

stdout (events)
  {"event": "ready", "model": "hey_jarvis"}
  {"event": "wake", "score": 0.93}          heard the wake word; a short chime plays, then it records
  {"event": "utterance", "path": "...wav"}  what you said after it (16 kHz mono WAV in --out-dir, ends when you pause)
  {"event": "nothing"}                      woke (or was asked to listen) but heard no speech
  {"event": "played"}                       finished playing a file the node sent
  {"event": "error", "error": "..."}

stdin (commands)
  {"cmd": "play", "path": "...wav"}   play Jarvis's answer (the mic is ignored meanwhile, so it can't wake itself)
  {"cmd": "listen"}                   record a follow-up without the wake word
  {"cmd": "resume"}                   back to waiting for the wake word
  {"cmd": "quit"}

After an utterance it waits for one of those commands before listening for the wake word again.
`--selftest` checks the end-of-speech logic with synthetic audio (needs only numpy).
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import tempfile
import threading
import time
import wave

import numpy as np

RATE = 16_000
FRAME = 1280  # 80 ms, what openWakeWord expects


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({"event": event, **data}) + "\n")
    sys.stdout.flush()


def rms(frame: np.ndarray) -> float:
    return float(np.sqrt(np.mean(frame.astype(np.float64) ** 2))) if frame.size else 0.0


class Endpointer:
    """Decides when you have finished speaking, from loudness alone.

    The noise floor is learnt from the quiet frames; speech is anything well above it. "nothing"
    when no speech starts within `start_timeout`; "done" after `end_silence` of quiet following
    speech, or at `max_seconds`.
    """

    def __init__(self, frame_ms: float = 80, start_timeout: float = 5.0, end_silence: float = 0.9, max_seconds: float = 15.0, min_rms: float = 250.0):
        self.frame_s = frame_ms / 1000
        self.start_timeout = start_timeout
        self.end_silence = end_silence
        self.max_seconds = max_seconds
        self.min_rms = min_rms
        self.noise = None
        self.elapsed = 0.0
        self.quiet_for = 0.0
        self.spoke_for = 0.0
        self.started = False

    def threshold(self) -> float:
        return max(self.min_rms, (self.noise or 0.0) * 3.0)

    def feed(self, frame: np.ndarray) -> str:
        level = rms(frame)
        self.elapsed += self.frame_s
        loud = level > self.threshold()
        if not loud:
            # Slow-moving average of the room's noise, only from quiet frames.
            self.noise = level if self.noise is None else self.noise * 0.9 + level * 0.1
        if loud:
            self.spoke_for += self.frame_s
            self.quiet_for = 0.0
            # Two loud frames in a row (160 ms) count as speech, not a click.
            if self.spoke_for >= 2 * self.frame_s - 1e-9:
                self.started = True
        else:
            self.spoke_for = 0.0
            self.quiet_for += self.frame_s
        if self.elapsed >= self.max_seconds:
            return "done" if self.started else "nothing"
        if not self.started:
            return "nothing" if self.elapsed >= self.start_timeout else "continue"
        return "done" if self.quiet_for >= self.end_silence else "continue"


def write_wav(frames: list[np.ndarray], path: str) -> str:
    """Always the same file, overwritten each time: nothing piles up and nothing needs deleting."""
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(np.concatenate(frames).astype(np.int16).tobytes())
    return path


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        data = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError(f"only 16-bit WAV can be played (got {8 * width}-bit)")
    a = np.frombuffer(data, dtype=np.int16)
    return (a.reshape(-1, ch) if ch > 1 else a), rate


def chime() -> np.ndarray:
    t = np.arange(int(RATE * 0.12)) / RATE
    tone = np.sin(2 * np.pi * 880 * t) * np.hanning(t.size) * 0.25
    return (tone * 32767).astype(np.int16)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="hey_jarvis", help="an openWakeWord model name or a path to a .onnx/.tflite file")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--device", default=None, help="input device name or index (default: the system's)")
    ap.add_argument("--no-chime", action="store_true")
    ap.add_argument("--out-dir", default=os.path.join(tempfile.gettempdir(), "jarvis-wake"), help="where utterance.wav is written")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    import openwakeword  # type: ignore
    import sounddevice as sd  # type: ignore
    from openwakeword.model import Model  # type: ignore

    try:
        openwakeword.utils.download_models()  # first run only: the small shared feature models + pretrained words
    except (OSError, RuntimeError, ValueError) as e:  # offline after the first run is fine
        print(f"wakeword: model download skipped ({e})", file=sys.stderr)
    model = Model(wakeword_models=[args.model], inference_framework="onnx")
    os.makedirs(args.out_dir, exist_ok=True)
    utterance = os.path.join(args.out_dir, "utterance.wav")

    frames: queue.Queue[np.ndarray] = queue.Queue(maxsize=200)
    commands: queue.Queue[dict] = queue.Queue()
    state = {"mode": "wake"}  # wake | record | busy | playing

    def on_audio(indata, _frames, _time, status):
        if status:
            print(f"wakeword: {status}", file=sys.stderr)
        try:
            frames.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass  # we fell behind; dropping audio beats growing without limit

    def read_commands():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                commands.put(json.loads(line))
            except json.JSONDecodeError:
                emit("error", error=f"bad command: {line[:80]}")
        commands.put({"cmd": "quit"})

    threading.Thread(target=read_commands, daemon=True).start()
    device = int(args.device) if args.device and args.device.isdigit() else args.device

    def drain():
        while not frames.empty():
            frames.get_nowait()

    def play(samples: np.ndarray, rate: int):
        state["mode"] = "playing"
        sd.play(samples, rate)
        sd.wait()
        drain()
        model.reset()

    def record() -> None:
        ep = Endpointer()
        got: list[np.ndarray] = []
        drain()
        while True:
            f = frames.get()
            got.append(f)
            verdict = ep.feed(f)
            if verdict == "continue":
                continue
            if verdict == "done":
                emit("utterance", path=write_wav(got, utterance))
                state["mode"] = "busy"
            else:
                emit("nothing")
                state["mode"] = "wake"
                model.reset()
            return

    with sd.InputStream(samplerate=RATE, channels=1, dtype="int16", blocksize=FRAME, device=device, callback=on_audio):
        emit("ready", model=args.model)
        while True:
            try:
                cmd = commands.get_nowait()
            except queue.Empty:
                cmd = None
            if cmd:
                c = cmd.get("cmd")
                if c == "quit":
                    return 0
                if c == "play" and cmd.get("path"):
                    try:
                        samples, rate = read_wav(cmd["path"])
                        play(samples, rate)
                    except (OSError, ValueError, RuntimeError, wave.Error) as e:
                        emit("error", error=f"couldn't play: {e}")
                    emit("played")
                    state["mode"] = "busy"
                elif c == "listen":
                    state["mode"] = "record"
                    record()
                elif c == "resume":
                    drain()
                    model.reset()
                    state["mode"] = "wake"
                continue
            if state["mode"] != "wake":
                time.sleep(0.02)
                continue
            try:
                f = frames.get(timeout=0.1)
            except queue.Empty:
                continue
            scores = model.predict(f)
            score = max(scores.values()) if scores else 0.0
            if score >= args.threshold:
                emit("wake", score=round(float(score), 3))
                if not args.no_chime:
                    play(chime(), RATE)
                state["mode"] = "record"
                record()


def selftest() -> int:
    rng = np.random.default_rng(1)
    quiet = lambda: (rng.normal(0, 60, FRAME)).astype(np.int16)
    loud = lambda: (rng.normal(0, 3000, FRAME)).astype(np.int16)

    def run(seq):
        ep = Endpointer()
        for i, f in enumerate(seq):
            v = ep.feed(f)
            if v != "continue":
                return v, round((i + 1) * 0.08, 2)
        return "continue", None

    # 0.5 s quiet, 1.2 s speech, then quiet: done ~0.9 s after the speech ends
    v, at = run([quiet() for _ in range(6)] + [loud() for _ in range(15)] + [quiet() for _ in range(40)])
    assert v == "done" and 2.4 <= at <= 2.8, (v, at)
    # nobody speaks: nothing after 5 s
    v, at = run([quiet() for _ in range(100)])
    assert v == "nothing" and abs(at - 5.04) < 0.1, (v, at)
    # a single click is not speech
    v, at = run([quiet() for _ in range(5)] + [loud()] + [quiet() for _ in range(100)])
    assert v == "nothing", (v, at)
    # talking without pause stops at 15 s
    v, at = run([loud() for _ in range(300)])
    assert v == "done" and abs(at - 15.04) < 0.1, (v, at)
    # a short pause mid-sentence does not end it
    v, at = run([loud() for _ in range(10)] + [quiet() for _ in range(6)] + [loud() for _ in range(10)] + [quiet() for _ in range(20)])
    assert v == "done" and at > 2.5, (v, at)
    path = write_wav([loud() for _ in range(3)], os.path.join(tempfile.gettempdir(), "jarvis-selftest.wav"))
    a, rate = read_wav(path)
    assert rate == RATE and a.size == 3 * FRAME
    print("selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
