# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "faster-whisper>=1.1",
#   "nvidia-cublas-cu12; sys_platform != 'darwin'",
#   "nvidia-cudnn-cu12>=9,<10; sys_platform != 'darwin'",
# ]
# ///
"""Transcribes WhatsApp voice notes locally with Whisper (faster-whisper).

Called by `orc style learn` as `uv run tools/transcribe.py --model large-v3-turbo`.
Reads a JSON list of {"id", "path"} on stdin and prints one JSON line per note:
{"id", "text", "language"} or {"id", "error"}. Uses the GPU when CUDA works, else the CPU.
"""

import argparse
import json
import os
import sys
from pathlib import Path


def add_cuda_dlls() -> None:
    # The nvidia-* wheels ship cuBLAS / cuDNN; on Windows their DLL folders must be added by hand.
    try:
        import nvidia  # type: ignore
    except ImportError:
        return
    for base in nvidia.__path__:
        for bin_dir in Path(base).glob("*/bin"):
            os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
            if hasattr(os, "add_dll_directory"):
                os.add_dll_directory(str(bin_dir))


def decode(path: str):
    # Our own decode: faster-whisper's passes open(metadata_errors=...), which current PyAV removed.
    import av
    import numpy as np

    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    chunks = []
    with av.open(path) as f:
        for frame in f.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def load(model_name: str):
    from faster_whisper import WhisperModel
    import numpy as np

    try:
        model = WhisperModel(model_name, device="cuda", compute_type="float16")
        # CUDA problems often show only at the first inference, so try one on a second of silence.
        list(model.transcribe(np.zeros(16000, dtype=np.float32))[0])
        return model, "cuda"
    except Exception as e:  # no GPU, old driver, or a GPU this CTranslate2 build does not know
        print(f"whisper: GPU unavailable ({str(e)[:120]}), using the CPU", file=sys.stderr)
        return WhisperModel(model_name, device="cpu", compute_type="int8"), "cpu"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--language", default="", help="e.g. ta or en; empty detects per note")
    args = ap.parse_args()
    # Windows consoles default to a code page that cannot hold Tamil or emoji.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    notes = json.load(sys.stdin)
    if not notes:
        return
    add_cuda_dlls()
    model, device = load(args.model)
    print(f"whisper: {args.model} on {device}, {len(notes)} note(s)", file=sys.stderr)
    for note in notes:
        try:
            segments, info = model.transcribe(decode(note["path"]), language=args.language or None, vad_filter=True, beam_size=5)
            text = " ".join(s.text.strip() for s in segments).strip()
            out = {"id": note["id"], "text": text, "language": info.language}
        except Exception as e:
            out = {"id": note["id"], "error": str(e)[:300]}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
