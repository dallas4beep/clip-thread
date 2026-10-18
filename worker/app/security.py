"""HMAC verification for webhooks from Next.js and the Cloudflare R2 event forwarder."""

import hashlib
import hmac
import time


class SignatureError(Exception):
    pass


def sign(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + mac.hexdigest()


def verify(secret: str, timestamp: str | None, signature: str | None, body: bytes, tolerance: int = 300, now: float | None = None) -> None:
    if not timestamp or not signature:
        raise SignatureError("missing signature headers")
    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise SignatureError("bad timestamp") from exc
    current = time.time() if now is None else now
    if abs(current - ts) > tolerance:
        raise SignatureError("timestamp outside tolerance (possible replay)")
    expected = sign(secret, timestamp, body)
    if not hmac.compare_digest(expected, signature.strip()):
        raise SignatureError("signature mismatch")
