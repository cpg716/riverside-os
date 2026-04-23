#!/usr/bin/env python3

import argparse
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


VOICE_ALIASES = {
    "adam": 5,
    "michael": 6,
    "emma": 7,
    "isabella": 8,
}

DEFAULT_VOICE_ID = 5


def resolve_speaker_id(raw_voice: str) -> int:
    normalized = raw_voice.strip().lower()
    if normalized.isdigit():
        return max(0, min(52, int(normalized)))
    return VOICE_ALIASES.get(normalized, DEFAULT_VOICE_ID)


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


def build_tts(model_dir: Path, provider: str) -> sherpa_onnx.OfflineTts:
    config = sherpa_onnx.OfflineTtsConfig()
    config.model.provider = provider
    config.model.num_threads = 2
    config.model.kokoro.model = str(model_dir / "model.onnx")
    config.model.kokoro.voices = str(model_dir / "voices.bin")
    config.model.kokoro.tokens = str(model_dir / "tokens.txt")
    config.model.kokoro.data_dir = str(model_dir / "espeak-ng-data")
    config.model.kokoro.lang = "en-us"
    return sherpa_onnx.OfflineTts(config)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--voice", default="adam")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--provider", default="cpu")
    parser.add_argument("--text", required=True)
    parser.add_argument("--player", default="/usr/bin/afplay")
    parser.add_argument("--output")
    parser.add_argument("--no-play", action="store_true")
    args = parser.parse_args()

    model_dir = Path(args.model_dir)
    tts = build_tts(model_dir, args.provider)
    speaker_id = resolve_speaker_id(args.voice)
    generated = tts.generate(args.text, sid=speaker_id, speed=max(0.8, min(1.2, args.speed)))
    samples = np.asarray(generated.samples, dtype=np.float32)
    sample_rate = int(generated.sample_rate)

    if args.output:
        wav_path = Path(args.output)
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        should_delete = False
    else:
        with tempfile.NamedTemporaryFile(prefix="rosie-kokoro-", suffix=".wav", delete=False) as handle:
            wav_path = Path(handle.name)
        should_delete = True

    try:
        write_wav(wav_path, samples, sample_rate)
        if not args.no_play:
            subprocess.run([args.player, str(wav_path)], check=True)
    finally:
        if should_delete:
            wav_path.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
