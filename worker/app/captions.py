"""Turn transcription segments into readable WebVTT / SRT cues (<= 2 lines x 42 chars)."""

import textwrap
from dataclasses import asdict, dataclass

MAX_LINE = 42
MAX_LINES = 2


@dataclass
class Segment:
    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def _ts(seconds: float, sep: str) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_cues(segments: list[Segment]) -> list[Segment]:
    """Split long segments into cues that fit on screen, distributing time by character count."""
    cues: list[Segment] = []
    for seg in segments:
        text = " ".join(seg.text.split())
        if not text or seg.end <= seg.start:
            continue
        lines = textwrap.wrap(text, MAX_LINE, break_long_words=True)
        chunks = ["\n".join(lines[i : i + MAX_LINES]) for i in range(0, len(lines), MAX_LINES)]
        total_chars = sum(len(c) for c in chunks)
        t = seg.start
        for i, chunk in enumerate(chunks):
            end = seg.end if i == len(chunks) - 1 else t + (seg.end - seg.start) * len(chunk) / total_chars
            cues.append(Segment(t, end, chunk))
            t = end
    # Guarantee monotonic, non-overlapping cues.
    for prev, cur in zip(cues, cues[1:]):
        if cur.start < prev.end:
            prev.end = cur.start
    return [c for c in cues if c.end > c.start]


def to_vtt(segments: list[Segment]) -> str:
    out = ["WEBVTT", ""]
    for c in to_cues(segments):
        out += [f"{_ts(c.start, '.')} --> {_ts(c.end, '.')}", c.text.replace("-->", "->"), ""]
    return "\n".join(out)


def to_srt(segments: list[Segment]) -> str:
    out: list[str] = []
    for i, c in enumerate(to_cues(segments), 1):
        out += [str(i), f"{_ts(c.start, ',')} --> {_ts(c.end, ',')}", c.text, ""]
    return "\n".join(out)
