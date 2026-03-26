"""Provider auto-discovery — mirrors the probe registry pattern.

Any module in ``observatory/providers/`` that exports a ``PROVIDER`` singleton
with ``complete``, ``provider``, and ``model_id`` attributes is picked up
automatically.  Internal modules (``base``, ``registry``, ``_*``) are skipped.
"""
from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

from observatory.providers.base import BaseProvider


def discover_providers() -> list[BaseProvider]:
    """Return all ``PROVIDER`` singletons found in ``observatory/providers/``."""
    providers: list[BaseProvider] = []
    package_name = "observatory.providers"
    package_path = Path(__file__).resolve().parent

    for module_info in pkgutil.iter_modules([str(package_path)]):
        name = module_info.name
        if name in {"base", "registry"} or name.startswith("_"):
            continue
        module = importlib.import_module(f"{package_name}.{name}")
        candidate = getattr(module, "PROVIDER", None)
        if (
            candidate is not None
            and hasattr(candidate, "complete")
            and hasattr(candidate, "provider")
            and hasattr(candidate, "model_id")
        ):
            providers.append(candidate)

    return providers
