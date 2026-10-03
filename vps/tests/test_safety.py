"""Source safety scan for the native adapter package. The MetaTrader5 import exception
is scoped to exactly one file: mt5_bridge/native.py."""
import io
import re
import tokenize
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "mt5_bridge"
NATIVE_IMPORT_FILE = PKG / "native.py"

FORBIDDEN_MEMBERS = re.compile(
    r"\b(login|account_info|orders_\w+|positions_\w+|history_orders_\w+|history_deals_\w+|"
    r"order_check|order_send|order_calc_margin|order_calc_profit|TRADE_ACTION_\w*|ORDER_TYPE_\w*|"
    r"MqlTradeRequest|ExecutionIntent)\b")
SECRET_INPUTS = re.compile(r"\b(password|passwd|credential\w*|secret\w*|api_key|account_number)\b", re.I)
LIVE_MODE = re.compile(r"\b(DEMO|LIVE)\b")


def code_tokens(path: Path) -> str:
    """Executable code only: names/strings/ops, comments and docstrings excluded."""
    src = path.read_text(encoding="utf8")
    out, prev = [], None
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            continue
        if tok.type == tokenize.STRING and prev in (None, tokenize.INDENT, tokenize.NEWLINE, tokenize.DEDENT):
            prev = tok.type
            continue  # docstring
        if tok.type not in (tokenize.NL, tokenize.ENCODING):
            prev = tok.type
        out.append(tok.string)
    return " ".join(out)


class SafetyScan(unittest.TestCase):
    files = sorted(PKG.rglob("*.py"))

    def test_package_files_found(self):
        self.assertIn(NATIVE_IMPORT_FILE, self.files)
        self.assertGreaterEqual(len(self.files), 5)

    def test_no_forbidden_mt5_members_in_code(self):
        for f in self.files:
            self.assertIsNone(FORBIDDEN_MEMBERS.search(code_tokens(f)), f)

    def test_no_forbidden_names_anywhere_in_source(self):
        for f in self.files:  # stricter: comments/docstrings too
            self.assertIsNone(FORBIDDEN_MEMBERS.search(f.read_text(encoding="utf8")), f)

    def test_no_secret_inputs(self):
        for f in self.files:
            self.assertIsNone(SECRET_INPUTS.search(code_tokens(f)), f)

    def test_metatrader5_import_only_in_native(self):
        for f in self.files:
            has = re.search(r"^\s*(import|from)\s+MetaTrader5\b", f.read_text(encoding="utf8"), re.M)
            self.assertEqual(bool(has), f == NATIVE_IMPORT_FILE, f)

    def test_no_network_or_env(self):
        for f in self.files:
            self.assertIsNone(re.search(r"\b(socket|requests|urllib|http\.|websocket|os\.environ|getenv|argparse)\b",
                                        code_tokens(f)), f)

    def test_no_mode_transition(self):
        for f in self.files:
            self.assertIsNone(LIVE_MODE.search(code_tokens(f)), f)


if __name__ == "__main__":
    unittest.main()
