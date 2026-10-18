from app.captions import Segment, to_cues, to_srt, to_vtt


def test_vtt_basic():
    vtt = to_vtt([Segment(0.0, 2.5, "Hello world"), Segment(2.5, 3661.042, "Bye")])
    assert vtt.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello world\n")
    assert "00:00:02.500 --> 01:01:01.042\nBye" in vtt


def test_srt_numbering_and_comma():
    srt = to_srt([Segment(0, 1, "a"), Segment(1, 2, "b")])
    assert srt.splitlines()[:3] == ["1", "00:00:00,000 --> 00:00:01,000", "a"]
    assert "2\n00:00:01,000 --> 00:00:02,000\nb" in srt


def test_long_segments_split_into_two_line_cues():
    text = " ".join(["word"] * 60)  # ~300 chars
    cues = to_cues([Segment(10, 40, text)])
    assert len(cues) > 1
    assert all(len(c.text.split("\n")) <= 2 for c in cues)
    assert all(len(line) <= 42 for c in cues for line in c.text.split("\n"))
    assert cues[0].start == 10 and cues[-1].end == 40
    assert all(a.end <= b.start for a, b in zip(cues, cues[1:]))


def test_overlaps_and_empty_segments_are_cleaned():
    cues = to_cues([Segment(0, 3, "one"), Segment(2, 4, "two"), Segment(5, 5, "zero"), Segment(6, 7, "   ")])
    assert [(c.start, c.end, c.text) for c in cues] == [(0, 2, "one"), (2, 4, "two")]


def test_cue_text_cannot_inject_arrow():
    assert "a -> b" in to_vtt([Segment(0, 1, "a --> b")])
