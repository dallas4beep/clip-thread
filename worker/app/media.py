"""FFmpeg helpers: normalize per-prompt segments, stitch, extract audio, poster frame."""

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


class MediaError(RuntimeError):
    pass


@dataclass
class Probe:
    duration: float | None
    width: int | None
    height: int | None
    rotation: int
    has_audio: bool


class FFmpeg:
    def __init__(self, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe", timeout: int = 1800):
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.timeout = timeout

    def _run(self, args: list[str]) -> str:
        log.debug("exec %s", " ".join(args))
        try:
            p = subprocess.run(args, capture_output=True, text=True, timeout=self.timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            raise MediaError(f"{args[0]} timed out") from exc
        if p.returncode != 0:
            raise MediaError(f"{Path(args[0]).name} failed ({p.returncode}): {p.stderr[-2000:]}")
        return p.stdout

    def probe(self, path: Path) -> Probe:
        out = self._run([self.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
        data = json.loads(out)
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video is None:
            raise MediaError(f"{path.name} has no video stream")
        rotation = 0
        for sd in video.get("side_data_list", []) or []:
            if "rotation" in sd:
                rotation = int(sd["rotation"])
        rotation = int(video.get("tags", {}).get("rotate", rotation))
        dur = data.get("format", {}).get("duration")
        return Probe(
            duration=float(dur) if dur not in (None, "N/A") else None,
            width=video.get("width"),
            height=video.get("height"),
            rotation=rotation,
            has_audio=any(s.get("codec_type") == "audio" for s in streams),
        )

    @staticmethod
    def output_size(p: Probe, long_edge: int = 1280) -> tuple[int, int]:
        w, h = p.width or 16, p.height or 9
        if abs(p.rotation) % 180 == 90:
            w, h = h, w
        short = round(long_edge * 9 / 16 / 2) * 2
        return (short, long_edge) if h > w else (long_edge, short)

    def normalize(self, src: Path, dst: Path, size: tuple[int, int], has_audio: bool, fps: int = 30) -> Path:
        """Re-encode one segment to a uniform H.264/AAC MP4 so segments can be concatenated losslessly."""
        w, h = size
        vf = (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps},format=yuv420p"
        )
        args = [self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", str(src)]
        if not has_audio:
            args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        args += ["-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0", "-vf", vf]
        if has_audio:
            # Normalize loudness per take so answers recorded at different volumes match.
            args += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000"]
        args += [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-profile:v", "high", "-g", str(fps * 2),
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
            "-video_track_timescale", "90000",
        ]
        if not has_audio:
            args += ["-shortest"]
        args += ["-movflags", "+faststart", str(dst)]
        self._run(args)
        return dst

    def concat(self, parts: list[Path], dst: Path) -> Path:
        if len(parts) == 1:
            parts[0].replace(dst)
            return dst
        listing = dst.with_suffix(".txt")
        listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
        self._run([
            self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(listing),
            "-c", "copy", "-movflags", "+faststart", str(dst),
        ])
        return dst

    def extract_audio(self, src: Path, dst: Path) -> Path:
        """16 kHz mono 32 kbps MP3: ~14 MB/hour, well under the Whisper API's 25 MB limit for typical clips."""
        self._run([
            self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", str(dst),
        ])
        return dst

    def cut_audio(self, src: Path, dst: Path, start: float, length: float) -> Path:
        self._run([
            self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(src), "-c", "copy", str(dst),
        ])
        return dst

    def poster(self, src: Path, dst: Path, at: float) -> Path:
        self._run([
            self.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{at:.2f}", "-i", str(src), "-frames:v", "1", "-q:v", "3", str(dst),
        ])
        return dst
