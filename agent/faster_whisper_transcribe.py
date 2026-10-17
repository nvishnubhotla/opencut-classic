"""Word-level transcription with faster-whisper, printed as JSON on stdout.

Audio is decoded with ffmpeg (16 kHz mono) and passed in as samples, which
avoids faster-whisper's PyAV decoder (version mismatches break it).

usage: python faster_whisper_transcribe.py <input> <model> <language|auto>
       <model_dir> [--keep-fillers]
"""

import json
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

FILLER_PROMPT = "Umm, so, uh, I was like, you know, thinking... hmm, I mean, okay."


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0


def main():
    path, model_name, language, model_dir = sys.argv[1:5]
    keep_fillers = "--keep-fillers" in sys.argv[5:]

    model = WhisperModel(
        model_name, device="auto", compute_type="int8", download_root=model_dir
    )
    segments, info = model.transcribe(
        decode(path),
        language=None if language == "auto" else language,
        word_timestamps=True,
        vad_filter=True,
        initial_prompt=FILLER_PROMPT if keep_fillers else None,
    )
    words = [
        {
            "start": round(w.start, 3),
            "end": round(w.end, 3),
            "word": w.word.strip(),
            "prob": round(w.probability, 3),
        }
        for segment in segments  # lazy: transcription runs here
        for w in segment.words or []
    ]
    json.dump({"language": info.language, "words": words}, sys.stdout)


if __name__ == "__main__":
    main()
