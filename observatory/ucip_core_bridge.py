"""
ucip_core_bridge — sole import gateway for vendor/persistence_signal_detector.

Every observatory/ or api/ module that needs UCIP primitives MUST import
from here.  Direct imports from vendor/ are forbidden and enforced by
tests/test_vendor_import_discipline.py.

The bridge dynamically discovers and re-exports every public symbol from
the vendor's ``src/`` package, so it adapts automatically when the vendor
adds, renames, or removes modules.
"""
from __future__ import annotations

import importlib
import importlib.util
import pathlib
import sys
import types

# ---------------------------------------------------------------------------
# Locate vendor source tree
# ---------------------------------------------------------------------------
_VENDOR_SRC: pathlib.Path = (
    pathlib.Path(__file__).resolve().parent.parent
    / "vendor"
    / "persistence_signal_detector"
    / "src"
)

if not _VENDOR_SRC.is_dir():
    raise ImportError(
        f"Vendor source not found at {_VENDOR_SRC}. "
        "Ensure vendor/persistence_signal_detector is populated."
    )

# ---------------------------------------------------------------------------
# Bootstrap the vendor package under a private namespace so that the
# relative imports inside vendor modules (``from .foo import bar``) resolve
# correctly, without polluting sys.path.
# ---------------------------------------------------------------------------
_PKG = "_vendor_psd"

if _PKG not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        _PKG,
        str(_VENDOR_SRC / "__init__.py"),
        submodule_search_locations=[str(_VENDOR_SRC)],
    )
    _pkg_mod = importlib.util.module_from_spec(_spec)
    sys.modules[_PKG] = _pkg_mod
    _spec.loader.exec_module(_pkg_mod)

# ---------------------------------------------------------------------------
# Discover and import every public sub-module
# ---------------------------------------------------------------------------
_module_stems: list[str] = sorted(
    p.stem
    for p in _VENDOR_SRC.glob("*.py")
    if not p.stem.startswith("_")
)

_loaded: dict[str, types.ModuleType] = {}

for _stem in _module_stems:
    _fqn = f"{_PKG}.{_stem}"
    try:
        _loaded[_stem] = importlib.import_module(_fqn)
    except Exception:
        pass  # tolerate optional-dependency failures

# ---------------------------------------------------------------------------
# Re-export public symbols defined in vendor code
# ---------------------------------------------------------------------------
_public: dict[str, object] = {}

for _mod in _loaded.values():
    _mod_all = getattr(_mod, "__all__", None)
    for _name in _mod_all or dir(_mod):
        if _name.startswith("_"):
            continue
        _obj = getattr(_mod, _name)
        if isinstance(_obj, types.ModuleType):
            continue
        # Only re-export objects whose home module is inside the vendor
        _home = getattr(_obj, "__module__", None)
        if isinstance(_home, str) and _home.startswith(_PKG):
            _public[_name] = _obj

globals().update(_public)
__all__: list[str] = sorted(_public)

# Expose discovered module stems for introspection
vendor_modules: tuple[str, ...] = tuple(_loaded)
