import shutil
import subprocess
from pathlib import Path

import pytest

from app.media import FFmpeg, Probe

ffmpeg_missing = shutil.which("ffmpeg") is None


def test_output_size_orientation():
    assert FFmpeg.output_size(Probe(None, 1920, 1080, 0, True)) == (1280, 720)
    assert FFmpeg.output_size(Probe(None, 1080, 1920, 0, True)) == (720, 1280)
    assert FFmpeg.output_size(Probe(None, 1920, 1080, -90, True)) == (720, 1280)


@pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg not installed")
def test_normalize_and_concat_mixed_inputs(tmp_path: Path):
    a = tmp_path / "a.webm"
    b = tmp_path / "b.mp4"
    # 2s VP8/Opus webm 640x480 with tone; 1s H.264 mp4 1280x720 without audio
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x480:rate=25:duration=2",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libvpx", "-c:a", "libopus", str(a)], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=1",
                    "-c:v", "libx264", str(b)], check=True)
    f = FFmpeg()
    pa, pb = f.probe(a), f.probe(b)
    assert pa.has_audio and not pb.has_audio
    size = f.output_size(pa)
    parts = [f.normalize(a, tmp_path / "n0.mp4", size, pa.has_audio), f.normalize(b, tmp_path / "n1.mp4", size, pb.has_audio)]
    final = f.concat(parts, tmp_path / "final.mp4")
    probe = f.probe(final)
    assert probe.has_audio and (probe.width, probe.height) == (1280, 720)
    assert probe.duration is not None and 2.8 < probe.duration < 3.3
    audio = f.extract_audio(final, tmp_path / "audio.mp3")
    assert audio.stat().st_size > 0
    assert f.poster(final, tmp_path / "p.jpg", 1.0).stat().st_size > 0
