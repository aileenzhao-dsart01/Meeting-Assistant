#!/usr/bin/env python3
"""
Transcribe an audio file using faster-whisper with optimizations for:
- Long meetings (45-60 min)
- Far-field / distant microphone recording
- Multiple speakers / overlapping speech

Usage:
    python3 transcribe.py <audio_path> [model_size] [language]

model_size defaults to "base". Options: tiny, base, small, medium, large-v3
language defaults to "en". Use "auto" for auto-detect.
"""
import sys
import os
from faster_whisper import WhisperModel


def transcribe(audio_path: str, model_size: str = "base", language: str = "en") -> str:
    """
    Run faster-whisper transcription on the given audio file with VAD filtering.

    VAD (Voice Activity Detection) filters out non-speech segments before
    transcription, which:
    - Improves far-field accuracy (distant mics pick up noise, VAD removes it)
    - Speeds up long meetings (skips silence between speakers)
    - Helps multi-talker scenarios (focuses on speech segments only)

    Returns the full transcript as a single string.
    """
    if not os.path.isfile(audio_path):
        print(f"Error: File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    # Run on CPU by default. Switch to "cuda" if GPU available.
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    # Language: None = auto-detect, "en" = force English (better for accented English),
    # or pass any ISO 639-1 code (e.g. "zh", "ja", "fr", "de", "es")
    lang_param = language if language and language.lower() != "auto" else None

    # VAD (Voice Activity Detection) parameters tuned for far-field recording:
    # - threshold: 0.5 is default; lower (e.g. 0.3) catches quieter speech from distance
    # - min_speech_duration_ms: ignores brief noises (door clicks, coughs)
    # - min_silence_duration_ms: keeps speaker turns together
    # - speech_pad_ms: adds margin around speech to avoid cutting off words
    # - max_speech_duration_s: resets context periodically for long meetings
    vad_params = {
        "threshold": 0.4,
        "min_speech_duration_ms": 200,
        "min_silence_duration_ms": 500,
        "speech_pad_ms": 300,
        "max_speech_duration_s": 30,
    }

    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        language=lang_param,
        condition_on_previous_text=True,
        vad_filter=True,
        vad_parameters=vad_params,
    )

    transcript_parts = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            transcript_parts.append(text)

    return " ".join(transcript_parts)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe.py <audio_path> [model_size]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    language = sys.argv[3] if len(sys.argv) > 3 else "en"

    try:
        result = transcribe(audio_path, model_size, language)
        print(result)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
