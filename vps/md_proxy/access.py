"""Cloudflare Access JWT verification (stdlib only).

Verifies the `Cf-Access-Jwt-Assertion` token cryptographically: RS256 signature against the team's
JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), exact issuer, audience (AUD tag of
the Access application), expiry and not-before. RSA PKCS#1 v1.5 verification is done with pow();
there is no signing code and no private key anywhere. Fail-closed: any parse/fetch/check failure
returns False. Works for both interactive-login and service-token Access JWTs (same claims).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

MAX_TOKEN_LEN = 8192
MAX_JWKS_BYTES = 64 * 1024
MIN_RSA_BITS = 2048
CLOCK_LEEWAY_S = 30
JWKS_TTL_S = 3600
JWKS_MIN_REFRESH_S = 60
JWKS_TIMEOUT_S = 5.0
TEAM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$")
AUD_RE = re.compile(r"^[A-Za-z0-9]{16,128}$")
# DER prefix of DigestInfo for SHA-256 (RFC 8017 §9.2 note 1).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")

JwksFetch = Callable[[], bytes]
Clock = Callable[[], float]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None  # urllib then raises HTTPError for the 3xx — redirects are never followed


NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect())


def b64url(data: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]*", data):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def rsa_pkcs1_sha256_verify(n: int, e: int, msg: bytes, sig: bytes) -> bool:
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    s = int.from_bytes(sig, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes(k, "big")
    t = _SHA256_PREFIX + hashlib.sha256(msg).digest()
    if k < len(t) + 11:
        return False
    expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return hmac.compare_digest(em, expected)


def parse_jwks(raw: bytes) -> dict[str, tuple[int, int]]:
    doc = json.loads(raw)
    keys: dict[str, tuple[int, int]] = {}
    for k in doc.get("keys", []) if isinstance(doc, dict) else []:
        if not isinstance(k, dict) or k.get("kty") != "RSA" or k.get("alg", "RS256") != "RS256":
            continue
        if k.get("use", "sig") != "sig" or not isinstance(k.get("kid"), str):
            continue
        n = int.from_bytes(b64url(k["n"]), "big")
        e = int.from_bytes(b64url(k["e"]), "big")
        if n.bit_length() < MIN_RSA_BITS or e < 3 or e % 2 == 0:
            continue
        keys[k["kid"]] = (n, e)
    return keys


def make_jwks_fetch(team_domain: str, timeout: float = JWKS_TIMEOUT_S) -> JwksFetch:
    if not TEAM_RE.fullmatch(team_domain):
        raise ValueError("team domain must be <team>.cloudflareaccess.com")
    url = f"https://{team_domain}/cdn-cgi/access/certs"

    def fetch() -> bytes:
        req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
        with NO_REDIRECT_OPENER.open(req, timeout=timeout) as r:  # noqa: S310 (fixed https URL)
            if r.status != 200:
                raise urllib.error.URLError("jwks status")
            body = r.read(MAX_JWKS_BYTES + 1)
        if len(body) > MAX_JWKS_BYTES:
            raise ValueError("jwks too large")
        return body
    return fetch


class AccessVerifier:
    """Callable(token) -> bool. Thread-safe JWKS cache; refetches on unknown kid (rate-limited)."""

    def __init__(self, team_domain: str, audience: str, jwks_fetch: Optional[JwksFetch] = None,
                 clock: Clock = time.time) -> None:
        if not TEAM_RE.fullmatch(team_domain):
            raise ValueError("team domain must be <team>.cloudflareaccess.com")
        if not AUD_RE.fullmatch(audience):
            raise ValueError("invalid Access application audience tag")
        self.issuer = f"https://{team_domain}"
        self.audience = audience
        self._fetch = jwks_fetch or make_jwks_fetch(team_domain)
        self._clock = clock
        self._keys: dict[str, tuple[int, int]] = {}
        self._fetched_at = float("-inf")
        self._lock = threading.Lock()

    def _key(self, kid: str) -> Optional[tuple[int, int]]:
        now = self._clock()
        with self._lock:
            stale = now - self._fetched_at > JWKS_TTL_S
            missing = kid not in self._keys and now - self._fetched_at > JWKS_MIN_REFRESH_S
            if stale or missing:
                try:
                    self._keys = parse_jwks(self._fetch())
                    self._fetched_at = now
                except Exception:
                    if stale:
                        self._keys = {}
            return self._keys.get(kid)

    def __call__(self, token: Optional[str]) -> bool:
        try:
            return self._verify(token)
        except Exception:
            return False

    def _verify(self, token: Optional[str]) -> bool:
        if not token or len(token) > MAX_TOKEN_LEN:
            return False
        parts = token.split(".")
        if len(parts) != 3:
            return False
        header, payload = json.loads(b64url(parts[0])), json.loads(b64url(parts[1]))
        if not isinstance(header, dict) or not isinstance(payload, dict):
            return False
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            return False
        key = self._key(header["kid"])
        if key is None:
            return False
        if not rsa_pkcs1_sha256_verify(key[0], key[1], f"{parts[0]}.{parts[1]}".encode("ascii"), b64url(parts[2])):
            return False
        if payload.get("iss") != self.issuer:
            return False
        aud = payload.get("aud")
        auds = aud if isinstance(aud, list) else [aud]
        if self.audience not in [a for a in auds if isinstance(a, str)]:
            return False
        now = self._clock()
        exp, nbf = payload.get("exp"), payload.get("nbf")
        if not isinstance(exp, (int, float)) or isinstance(exp, bool) or now > exp + CLOCK_LEEWAY_S:
            return False
        if nbf is not None and (not isinstance(nbf, (int, float)) or now + CLOCK_LEEWAY_S < nbf):
            return False
        return True
