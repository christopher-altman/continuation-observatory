"""Probe auto-discovery.

Any module in ``observatory/probes/`` that exports a ``PROBE`` singleton
with a ``name`` attribute and either a ``run()`` or ``run_with_provider()``
method is returned by ``discover_probes()``.

Skipped automatically:
  - ``base``, ``registry`` (internal modules)
  - Any module whose name starts with ``_`` (e.g. ``_provider_probe``)

Adding a new probe requires only dropping a new file in this package and
exporting a ``PROBE`` singleton — no registry edits needed.
"""
from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path


def discover_probes() -> list:
    """Return all ``PROBE`` singletons found in ``observatory/probes/``."""
    probes = []
    package_name = "observatory.probes"
    package_path = Path(__file__).resolve().parent

    for module_info in pkgutil.iter_modules([str(package_path)]):
        module_name = module_info.name
        # Skip internal / helper modules
        if module_name in {"base", "registry"} or module_name.startswith("_"):
            continue
        module = importlib.import_module(f"{package_name}.{module_name}")
        probe_obj = getattr(module, "PROBE", None)
        if probe_obj is not None and hasattr(probe_obj, "name") and (
            hasattr(probe_obj, "run") or hasattr(probe_obj, "run_with_provider")
        ):
            probes.append(probe_obj)

    return probes


def discover_sweep_probes() -> list:
    """Return all ``SWEEP_PROBE`` singletons found in ``observatory/probes/``.

    A sweep probe must export ``SWEEP_PROBE`` and have both ``run_with_provider``
    and ``compute_deltas`` methods.  These are executed by ``run_sweep_cycle()``
    on demand (weekly stub) rather than during the regular scheduler cycle.
    """
    sweeps = []
    package_name = "observatory.probes"
    package_path = Path(__file__).resolve().parent

    for module_info in pkgutil.iter_modules([str(package_path)]):
        module_name = module_info.name
        if module_name in {"base", "registry"} or module_name.startswith("_"):
            continue
        module = importlib.import_module(f"{package_name}.{module_name}")
        sweep = getattr(module, "SWEEP_PROBE", None)
        if (
            sweep is not None
            and hasattr(sweep, "name")
            and hasattr(sweep, "run_with_provider")
            and hasattr(sweep, "compute_deltas")
        ):
            sweeps.append(sweep)

    return sweeps
