# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "faster-whisper>=1.1",
#   "nvidia-cublas-cu12; sys_platform != 'darwin'",
#   "nvidia-cudnn-cu12>=9,<10; sys_platform != 'darwin'",
#   "sherpa-onnx>=1.12,<2",
# ]
# ///
"""Transcribes WhatsApp voice notes locally with Whisper (faster-whisper).

Called by `orc style learn` as `uv run tools/transcribe.py --model large-v3-turbo`.
Reads a JSON list of {"id", "path"} on stdin and prints one JSON line per note:
{"id", "text", "language"} or {"id", "error"}. Uses the GPU when CUDA works, else the CPU.

With --speakers, recordings with more than one voice come back as "P1: ...\nP2: ..." lines, P1 being
the first to speak (sherpa-onnx on the CPU; its two small models are downloaded once). If that fails
the plain text is still returned: losing the labels must never lose the words.
"""

import argparse
import json
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

MODELS = Path.home() / ".cache" / "orchestrator" / "diarize"
SEGMENT_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
VOICE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"


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


def diarizer():
    import sherpa_onnx

    MODELS.mkdir(parents=True, exist_ok=True)
    segment = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    if not segment.exists():
        archive = MODELS / "segment.tar.bz2"
        urllib.request.urlretrieve(SEGMENT_URL, archive)
        with tarfile.open(archive) as t:
            t.extractall(MODELS, filter="data")
        archive.unlink()
    voice = MODELS / "voice.onnx"
    if not voice.exists():
        urllib.request.urlretrieve(VOICE_URL, voice)
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segment)),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(voice)),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def label_words(words, turns):
    """Lines of "P1: words", from Whisper's timed words and the (start, end, speaker) turns."""
    def speaker_at(word):
        mid = (word.start + word.end) / 2
        best, gap = None, float("inf")
        for start, end, who in turns:
            if start <= mid <= end:
                return who
            d = min(abs(mid - start), abs(mid - end))
            if d < gap:
                best, gap = who, d
        return best

    names, lines = {}, []
    for w in words:
        who = speaker_at(w)
        name = names.setdefault(who, f"P{len(names) + 1}")
        if lines and lines[-1][0] == name:
            lines[-1][1].append(w.word.strip())
        else:
            lines.append((name, [w.word.strip()]))
    if len(names) < 2:
        return None
    return "\n".join(f"{name}: {' '.join(said)}" for name, said in lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speakers", action="store_true", help="label each voice P1, P2, ... (recordings, not voice notes)")
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
            samples = decode(note["path"])
            segments, info = model.transcribe(samples, language=args.language or None, vad_filter=True, beam_size=5, word_timestamps=args.speakers)
            segments = list(segments)
            text = " ".join(s.text.strip() for s in segments).strip()
            if args.speakers and text:
                try:
                    result = diarizer().process(samples).sort_by_start_time()
                    turns = [(r.start, r.end, r.speaker) for r in result]
                    text = label_words([w for s in segments for w in s.words], turns) or text
                except Exception as e:
                    print(f"speakers: {str(e)[:200]}; keeping the plain text", file=sys.stderr)
            out = {"id": note["id"], "text": text, "language": info.language}
        except Exception as e:
            out = {"id": note["id"], "error": str(e)[:300]}
        print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
