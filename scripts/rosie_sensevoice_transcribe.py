#!/usr/bin/env python3

import argparse
import sys
import wave
from array import array
from pathlib import Path

import sherpa_onnx


def read_wav_mono_float32(path: Path) -> tuple[int, list[float]]:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        frames = wav_file.readframes(frame_count)

    if sample_width != 2:
        raise RuntimeError("SenseVoice expects 16-bit PCM WAV input")

    samples = array("h")
    samples.frombytes(frames)

    if sys.byteorder != "little":
        samples.byteswap()

    if channels > 1:
        mono: list[float] = []
        for index in range(0, len(samples), channels):
            frame = samples[index:index + channels]
            mono.append(sum(frame) / len(frame) / 32768.0)
        return sample_rate, mono

    return sample_rate, [sample / 32768.0 for sample in samples]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--tokens", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--provider", default="cpu")
    parser.add_argument("--language", default="en")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--use-itn", action="store_true")
    args = parser.parse_args()

    sample_rate, samples = read_wav_mono_float32(Path(args.input))

    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=args.model,
        tokens=args.tokens,
        num_threads=max(1, args.threads),
        sample_rate=sample_rate,
        feature_dim=80,
        provider=args.provider,
        language=args.language,
        use_itn=args.use_itn,
    )
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)

    text = (stream.result.text or "").strip()
    if not text:
        raise RuntimeError("SenseVoice did not detect any speech")
    print(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
