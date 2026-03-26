"""
test_vendor_import_discipline
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Fails if any observatory/ or api/ module (other than the bridge)
directly imports or references vendor/persistence_signal_detector.
"""
import pathlib
import re

_ROOT = pathlib.Path(__file__).resolve().parent.parent

# The ONE file allowed to touch the vendor
_BRIDGE_NAME = "ucip_core_bridge.py"

# Catches any mention of the vendor package — imports, path literals,
# comments pointing at vendor source, or leaks of the internal alias.
_FORBIDDEN_RE = re.compile(
    r"vendor[\s./\\]*persistence_signal_detector"
    r"|\b_vendor_psd\b",
    re.IGNORECASE,
)


def _violations():
    for scan_dir in ("observatory", "api"):
        base = _ROOT / scan_dir
        if not base.is_dir():
            continue
        for py in sorted(base.rglob("*.py")):
            if py.name == _BRIDGE_NAME:
                continue
            try:
                text = py.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                if _FORBIDDEN_RE.search(line):
                    yield py.relative_to(_ROOT), lineno, line.strip()


def test_no_direct_vendor_imports():
    """observatory/ and api/ must not reference vendor/persistence_signal_detector
    directly — use observatory.ucip_core_bridge instead."""
    hits = list(_violations())
    assert not hits, (
        "Direct vendor references found (use observatory.ucip_core_bridge):\n"
        + "\n".join(f"  {p}:{n}: {l}" for p, n, l in hits)
    )
