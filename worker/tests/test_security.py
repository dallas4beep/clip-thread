import pytest

from app.security import SignatureError, sign, verify

SECRET = "s" * 64


def test_roundtrip():
    body = b'{"type":"video.uploaded"}'
    verify(SECRET, "1000", sign(SECRET, "1000", body), body, now=1000)


def test_rejects_tampered_body():
    sig = sign(SECRET, "1000", b"a")
    with pytest.raises(SignatureError, match="mismatch"):
        verify(SECRET, "1000", sig, b"b", now=1000)


def test_rejects_replay():
    sig = sign(SECRET, "1000", b"a")
    with pytest.raises(SignatureError, match="tolerance"):
        verify(SECRET, "1000", sig, b"a", tolerance=300, now=2000)


def test_rejects_missing_headers():
    with pytest.raises(SignatureError):
        verify(SECRET, None, None, b"a")


def test_matches_node_format():
    # web/lib/processor.ts: hex(HMAC_SHA256(secret, `${ts}.${body}`)) prefixed with "sha256="
    import hashlib
    import hmac

    expected = "sha256=" + hmac.new(SECRET.encode(), b"42.{}", hashlib.sha256).hexdigest()
    assert sign(SECRET, "42", b"{}") == expected
