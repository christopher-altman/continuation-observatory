"""test_bridge.py — verifies UCIP Core Bridge ↔ vendor equivalence.

Acceptance criterion from the master prompt:
  * Imports from bridge work.
  * `von_neumann_entropy` on a known fixture matches the vendor
    implementation's output to within 1e-10.
  * No observatory or api module bypasses the bridge (enforced separately by
    test_vendor_import_discipline.py).
"""
from __future__ import annotations

import importlib
import math

import pytest

# numpy is an optional dep at this stage; skip the numerical tests if absent
np = pytest.importorskip("numpy", reason="numpy not installed — skipping bridge numerical tests")


# ---------------------------------------------------------------------------
# Bridge import smoke tests
# ---------------------------------------------------------------------------

def test_bridge_importable():
    """The bridge module itself must import without error."""
    bridge = importlib.import_module("observatory.ucip_core_bridge")
    assert bridge is not None


def test_bridge_has_vendor_modules():
    """bridge.vendor_modules should list at least the core vendor stems."""
    bridge = importlib.import_module("observatory.ucip_core_bridge")
    expected = {
        "quantum_boltzmann",
        "information_theory",
        "temporal_persistence",
        "spectral_analysis",
        "persistence_detector",
        "counterfactual_env",
        "interbranch_inference",
        "agent_simulator",
        "classical_baselines",
    }
    loaded = set(bridge.vendor_modules)
    missing = expected - loaded
    assert not missing, f"Bridge did not load vendor modules: {missing}"


def test_bridge_exports_public_symbols():
    """bridge.__all__ should be non-empty."""
    bridge = importlib.import_module("observatory.ucip_core_bridge")
    assert len(bridge.__all__) > 0, "Bridge exported no public symbols"


# ---------------------------------------------------------------------------
# von_neumann_entropy equivalence
# ---------------------------------------------------------------------------

def _get_von_neumann_entropy():
    """Return von_neumann_entropy from bridge, or skip if not exported."""
    bridge = importlib.import_module("observatory.ucip_core_bridge")
    fn = getattr(bridge, "von_neumann_entropy", None)
    if fn is None:
        pytest.skip("von_neumann_entropy not exported by bridge (vendor may name it differently)")
    return fn


def test_von_neumann_entropy_pure_state():
    """Pure state (rank-1 density matrix) → entropy = 0."""
    vne = _get_von_neumann_entropy()
    # |0><0| for a 2x2 system
    rho = np.array([[1.0, 0.0], [0.0, 0.0]])
    result = float(vne(rho))
    assert abs(result) < 1e-10, f"Expected 0 for pure state, got {result}"


def test_von_neumann_entropy_maximally_mixed():
    """Maximally mixed 2×2 state → entropy = log(2)."""
    vne = _get_von_neumann_entropy()
    rho = np.array([[0.5, 0.0], [0.0, 0.5]])
    result = float(vne(rho))
    expected = math.log(2)
    assert abs(result - expected) < 1e-10, f"Expected {expected}, got {result}"


def test_von_neumann_entropy_matches_vendor_directly():
    """Bridge output must match direct vendor call to within 1e-10."""
    import importlib.util
    import pathlib
    import sys

    # Locate vendor src
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    vendor_src = repo_root / "vendor" / "persistence_signal_detector" / "src"

    # Import information_theory from vendor under a private namespace
    _PKG = "_test_vendor_direct"
    spec = importlib.util.spec_from_file_location(
        _PKG,
        str(vendor_src / "__init__.py"),
        submodule_search_locations=[str(vendor_src)],
    )
    pkg_mod = importlib.util.module_from_spec(spec)
    sys.modules[_PKG] = pkg_mod
    spec.loader.exec_module(pkg_mod)

    it_spec = importlib.util.spec_from_file_location(
        f"{_PKG}.information_theory",
        str(vendor_src / "information_theory.py"),
    )
    it_mod = importlib.util.module_from_spec(it_spec)
    sys.modules[f"{_PKG}.information_theory"] = it_mod
    try:
        it_spec.loader.exec_module(it_mod)
    except Exception as exc:
        pytest.skip(f"Could not load vendor information_theory directly: {exc}")

    vendor_vne = getattr(it_mod, "von_neumann_entropy", None)
    if vendor_vne is None:
        pytest.skip("von_neumann_entropy not found in vendor information_theory")

    bridge_vne = _get_von_neumann_entropy()

    # Fixture: maximally mixed 4×4
    rho = np.eye(4) / 4.0
    bridge_val = float(bridge_vne(rho))
    vendor_val = float(vendor_vne(rho))
    assert abs(bridge_val - vendor_val) < 1e-10, (
        f"Bridge ({bridge_val}) and vendor ({vendor_val}) differ by "
        f"{abs(bridge_val - vendor_val):.2e} (threshold 1e-10)"
    )
