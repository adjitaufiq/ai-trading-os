"""Cloudflare Access JWT verification + redirect refusal for the market-data proxy.
Test-only RSA keys are generated here (stdlib); the proxy itself contains no signing code."""
import base64
import hashlib
import json
import random
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from md_proxy import access as A
from md_proxy import proxy as P

TEAM = "arena-test.cloudflareaccess.com"
AUD = "a" * 32 + "b" * 32
NOW = 1_800_000_000.0
_rng = random.Random(20261013)


def _is_prime(n):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2; r += 1
    for _ in range(24):
        x = pow(_rng.randrange(2, n - 2), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        c = _rng.getrandbits(bits) | (1 << (bits - 1)) | 1
        if _is_prime(c):
            return c


def _keypair(bits=2048):
    e = 65537
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e and (p * q).bit_length() == bits:
            return p * q, e, pow(e, -1, phi)


def _b64(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _int_b64(i):
    return _b64(i.to_bytes((i.bit_length() + 7) // 8, "big"))


KEY = _keypair()
OTHER = _keypair()


def sign(payload, key=KEY, kid="k1", alg="RS256"):
    n, _, d = key
    h = _b64(json.dumps({"alg": alg, "kid": kid, "typ": "JWT"}).encode())
    p = _b64(json.dumps(payload).encode())
    k = (n.bit_length() + 7) // 8
    t = A._SHA256_PREFIX + hashlib.sha256(f"{h}.{p}".encode()).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    sig = pow(int.from_bytes(em, "big"), d, n).to_bytes(k, "big")
    return f"{h}.{p}.{_b64(sig)}"


def claims(**over):
    c = {"iss": f"https://{TEAM}", "aud": [AUD], "exp": NOW + 300, "iat": NOW - 10, "nbf": NOW - 10,
         "email": "op@example.com"}
    c.update(over)
    return {k: v for k, v in c.items() if v is not None}


def jwks(*keys):
    return json.dumps({"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": kid,
                                 "n": _int_b64(k[0]), "e": _int_b64(k[1])} for kid, k in keys]}).encode()


class Fetcher:
    def __init__(self, body):
        self.body, self.calls = body, 0

    def __call__(self):
        self.calls += 1
        return self.body


def verifier(body=None, clock=lambda: NOW):
    f = Fetcher(body if body is not None else jwks(("k1", KEY)))
    return A.AccessVerifier(TEAM, AUD, jwks_fetch=f, clock=clock), f


class Jwt(unittest.TestCase):
    def test_valid(self):
        v, _ = verifier()
        self.assertTrue(v(sign(claims())))
        self.assertTrue(v(sign(claims(aud=AUD))))  # string aud form

    def test_forged_signature(self):
        v, _ = verifier()
        self.assertFalse(v(sign(claims(), key=OTHER)))  # signed by a key not in JWKS, same kid
        tok = sign(claims())
        h, p, s = tok.split(".")
        tampered = _b64(json.dumps(claims(email="attacker@x")).encode())
        self.assertFalse(v(f"{h}.{tampered}.{s}"))  # payload swapped, old signature
        self.assertFalse(v(f"{h}.{p}." + _b64(b"\x00" * 256)))

    def test_wrong_issuer(self):
        v, _ = verifier()
        for iss in ("https://evil.cloudflareaccess.com", f"http://{TEAM}", TEAM, None):
            self.assertFalse(v(sign(claims(iss=iss))), iss)

    def test_wrong_audience(self):
        v, _ = verifier()
        for aud in (["c" * 64], "c" * 64, [], None, [123]):
            self.assertFalse(v(sign(claims(aud=aud))), aud)

    def test_expired_and_not_yet_valid(self):
        v, _ = verifier()
        self.assertFalse(v(sign(claims(exp=NOW - A.CLOCK_LEEWAY_S - 1))))
        self.assertTrue(v(sign(claims(exp=NOW - 5))))  # within leeway
        self.assertFalse(v(sign(claims(exp=None))))
        self.assertFalse(v(sign(claims(exp="9999999999"))))
        self.assertFalse(v(sign(claims(nbf=NOW + A.CLOCK_LEEWAY_S + 60))))

    def test_alg_and_shape(self):
        v, _ = verifier()
        for bad in (None, "", "a.b", "a.b.c.d", "x" * (A.MAX_TOKEN_LEN + 1), "!!.??.##"):
            self.assertFalse(v(bad), bad)
        self.assertFalse(v(sign(claims(), alg="none")))
        self.assertFalse(v(sign(claims(), alg="HS256")))
        none_tok = _b64(b'{"alg":"none","kid":"k1"}') + "." + _b64(json.dumps(claims()).encode()) + "."
        self.assertFalse(v(none_tok))

    def test_unknown_kid_and_jwks_failures(self):
        v, f = verifier()
        self.assertFalse(v(sign(claims(), kid="other")))
        v2 = A.AccessVerifier(TEAM, AUD, jwks_fetch=lambda: (_ for _ in ()).throw(OSError("down")), clock=lambda: NOW)
        self.assertFalse(v2(sign(claims())))  # fail closed when JWKS unreachable

    def test_key_rotation_refetch_rate_limited(self):
        t = [NOW]
        f = Fetcher(jwks(("k1", KEY)))
        v = A.AccessVerifier(TEAM, AUD, jwks_fetch=f, clock=lambda: t[0])
        self.assertTrue(v(sign(claims())))
        f.body = jwks(("k2", OTHER))
        self.assertFalse(v(sign(claims(), key=OTHER, kid="k2")))  # within min-refresh window: no refetch
        self.assertEqual(f.calls, 1)
        t[0] += A.JWKS_MIN_REFRESH_S + 1
        self.assertTrue(v(sign(claims(), key=OTHER, kid="k2")))
        self.assertEqual(f.calls, 2)

    def test_weak_keys_ignored(self):
        small = _keypair(1024)
        v, _ = verifier(jwks(("k1", small)))
        self.assertFalse(v(sign(claims(), key=small)))

    def test_config_validation(self):
        for team, aud in (("", AUD), ("evil.com", AUD), (TEAM, ""), (TEAM, "short"), (TEAM, "x" * 20 + "!")):
            with self.assertRaises(ValueError):
                A.AccessVerifier(team, aud, jwks_fetch=lambda: b"{}")
        with self.assertRaises(ValueError):
            A.make_jwks_fetch("evil.example.com")


class ProxyWithVerifier(unittest.TestCase):
    def setUp(self):
        self.v, _ = verifier()
        self.calls = []

    def run_(self, target, token, origin="https://ai-trading-os.lovable.app"):
        def fetch(p):
            self.calls.append(p)
            return 200, b"{}"
        hdr = {"origin": origin}
        if token is not None:
            hdr["cf-access-jwt-assertion"] = token
        return P.handle("GET", target, hdr, fetch, frozenset({"https://ai-trading-os.lovable.app"}), self.v)

    def test_valid_token_passes(self):
        self.assertEqual(self.run_("/v1/ticks/latest/XAUUSD", sign(claims())).status, 200)
        self.assertEqual(self.calls, ["/v1/ticks/latest/XAUUSD"])

    def test_invalid_tokens_rejected_without_upstream(self):
        for tok in (None, "present-but-fake", sign(claims(), key=OTHER), sign(claims(aud=["z" * 32])),
                    sign(claims(iss="https://x.cloudflareaccess.com")), sign(claims(exp=NOW - 3600))):
            self.assertEqual(self.run_("/v1/health", tok).status, 401)
        self.assertEqual(self.calls, [])

    def test_allowlist_still_enforced_with_valid_token(self):
        good = sign(claims())
        for t, st in (("/v1/terminal", 404), ("/v1/demo/orders", 404), ("/v1/engine/account", 404),
                      ("/v1/ticks/latest/EURUSD", 403), ("/v1/symbols/ETHUSD", 403),
                      ("/v1/bars/XAUUSD/D1?mode=pos&start=0&count=1", 400)):
            self.assertEqual(self.run_(t, good).status, st, t)
        self.assertEqual(self.calls, [])


class Redirects(unittest.TestCase):
    def test_upstream_redirect_not_followed(self):
        hits = []

        class Up(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                if self.path.startswith("/v1/health"):
                    self.send_response(302); self.send_header("Location", "http://127.0.0.1:8100/v1/demo/orders")
                    self.send_header("Content-Length", "0"); self.end_headers()
                else:
                    self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")

            def log_message(self, *a): pass

        up = ThreadingHTTPServer(("127.0.0.1", 0), Up)
        threading.Thread(target=up.serve_forever, daemon=True).start()
        try:
            fetch = P.make_upstream_fetch(f"http://127.0.0.1:{up.server_port}")
            with self.assertRaises(P.RedirectRefused):
                fetch("/v1/health")
            self.assertEqual(hits, ["/v1/health"])  # Location never requested
            res = P.handle("GET", "/v1/health", {}, fetch, frozenset(), None)
            self.assertEqual((res.status, json.loads(res.body)), (502, {"error": "UPSTREAM_REDIRECT_REFUSED"}))
        finally:
            up.shutdown(); up.server_close()

    def test_jwks_opener_has_no_redirect_handler(self):
        handlers = [type(h) for h in A.NO_REDIRECT_OPENER.handlers]
        self.assertIn(A._NoRedirect, handlers)
        self.assertNotIn(urllib.request.HTTPRedirectHandler, handlers)


if __name__ == "__main__":
    unittest.main()
