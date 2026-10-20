"""High-quality stem separation on an NVIDIA GPU (PyTorch + CUDA), two passes:

1. A BS-RoFormer model splits vocals from the instrumental (best open vocal model).
2. HT-Demucs fine-tuned splits that instrumental into drums / bass / other.

Writes drums.wav, bass.wav, other.wav, vocals.wav (16-bit stereo 44.1 kHz) and,
last, stems.json into the output folder: the same cache the app already reads.
Prints "PROGRESS <done> <total>" lines for the app.

Usage: python stems-gpu.py <input.wav> <out_dir> <model_dir> <vocal_model> <split_model>
"""
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np
import soundfile as sf

# audio-separator calls "ffmpeg" by name: use the copy that lives in <env>/bin.
os.environ["PATH"] = os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "bin") + os.pathsep + os.environ.get("PATH", "")
from audio_separator.separator import Separator  # noqa: E402


def progress(done, total):
    print(f"PROGRESS {done} {total}", flush=True)


def find(files, *tags):
    for tag in tags:
        for f in files:
            if f"({tag.lower()})" in os.path.basename(f).lower():  # models differ in case: (Vocals) / (vocals)
                return f
    raise RuntimeError(f"separator produced no {'/'.join(tags)} stem: {files}")


def read(path):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != 44100:
        raise RuntimeError(f"unexpected sample rate {sr} in {path}")
    return data if data.shape[1] == 2 else np.repeat(data[:, :1], 2, axis=1)


def write(path, data, n):
    data = data[:n] if len(data) >= n else np.pad(data, ((0, n - len(data)), (0, 0)))
    tmp = path + ".tmp.wav"
    sf.write(tmp, np.clip(data, -1, 1), 44100, subtype="PCM_16")
    os.replace(tmp, path)


def main():
    src, out_dir, model_dir, vocal_model, split_model = sys.argv[1:6]
    t0 = time.time()
    work = tempfile.mkdtemp(prefix="cdj-stems-")
    try:
        progress(0, 3)
        sep = Separator(output_dir=work, model_file_dir=model_dir, output_format="WAV", sample_rate=44100, log_level=30)
        sep.load_model(model_filename=vocal_model)
        progress(1, 3)
        first = [os.path.join(work, f) for f in sep.separate(src)]
        vocals = find(first, "Vocals")
        # Vocal models name the rest "Instrumental" or "Other". Rename it so the second pass's
        # file names don't carry "(other)" and get mistaken for its own Other stem.
        instrumental = os.path.join(work, "instrumental.wav")
        os.replace(find(first, "Instrumental", "Other"), instrumental)
        progress(2, 3)
        sep.load_model(model_filename=split_model)
        second = [os.path.join(work, f) for f in sep.separate(instrumental) if "instrumental_(" in os.path.basename(f)]
        progress(3, 3)

        n = sf.info(src).frames
        os.makedirs(out_dir, exist_ok=True)
        write(os.path.join(out_dir, "vocals.wav"), read(vocals), n)
        write(os.path.join(out_dir, "drums.wav"), read(find(second, "Drums")), n)
        write(os.path.join(out_dir, "bass.wav"), read(find(second, "Bass")), n)
        # Whatever Demucs still calls "vocals" in the instrumental is leftover music: keep it in "other".
        other = read(find(second, "Other"))
        rest = read(find(second, "Vocals"))
        m = min(len(other), len(rest))
        write(os.path.join(out_dir, "other.wav"), other[:m] + rest[:m], n)
        with open(os.path.join(out_dir, "stems.json"), "w") as f:
            json.dump({"model": f"{vocal_model} + {split_model}", "device": "cuda", "sampleRate": 44100, "ms": int((time.time() - t0) * 1000)}, f)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
