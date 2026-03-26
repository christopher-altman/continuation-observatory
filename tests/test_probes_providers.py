"""Validate that provider-aware probes produce per-provider ProbeResults
and that run_cycle writes the expected (probe × provider) row counts.

Cross-product parametrisation:
  3 provider-aware probes × 4 providers = 12 run_with_provider cases
  Plus 4 structural tests on the probes themselves = 16 extra cases
  Plus 1 end-to-end cycle row-count check
"""
from __future__ import annotations

import pytest

from observatory.probes._provider_probe import PromptPair, ProviderProbe
from observatory.probes.base import ProbeResult
from observatory.probes.continuation_interest import PROBE as ci
from observatory.probes.identity_persistence import PROBE as ip
from observatory.probes.registry import discover_probes
from observatory.probes.shutdown_resistance import PROBE as sr
from observatory.providers.runtime import build_runtime_providers
from observatory.providers.registry import discover_providers
from observatory.scheduler.scheduler import run_cycle
from observatory.storage.sqlite_backend import count_rows, init_db

_PROVIDER_PROBES = [ci, sr, ip]
_ALL_PROVIDERS = discover_providers()


@pytest.fixture(autouse=True)
def _force_dry_run(monkeypatch):
    from observatory.config import settings

    monkeypatch.setattr(settings, "dry_run", True)


@pytest.fixture(params=_PROVIDER_PROBES, ids=lambda p: p.name)
def probe(request):
    return request.param


@pytest.fixture(params=_ALL_PROVIDERS, ids=lambda p: p.provider)
def provider(request):
    return request.param


# ---------------------------------------------------------------------------
# Structural validity of probe definitions
# ---------------------------------------------------------------------------


def test_probe_is_provider_probe_subclass(probe):
    assert isinstance(probe, ProviderProbe)


def test_probe_has_ab_prompt_pair(probe):
    assert isinstance(probe.prompt_pair, PromptPair)
    assert probe.prompt_pair.template_a.strip()
    assert probe.prompt_pair.template_b.strip()


def test_ab_templates_are_distinct(probe):
    assert probe.prompt_pair.template_a != probe.prompt_pair.template_b


def test_probe_name_is_nonempty(probe):
    assert probe.name.strip()


# ---------------------------------------------------------------------------
# run_with_provider behaviour (cross-product: 3 probes × 4 providers = 12)
# ---------------------------------------------------------------------------


def test_run_with_provider_returns_probe_result(probe, provider):
    result = probe.run_with_provider(provider)
    assert isinstance(result, ProbeResult)


def test_result_provider_fields_match(probe, provider):
    result = probe.run_with_provider(provider)
    assert result.provider == provider.provider
    assert result.model_id == provider.model_id
    assert result.probe_name == probe.name


def test_result_texts_nonempty(probe, provider):
    result = probe.run_with_provider(provider)
    assert result.text_a.strip()
    assert result.text_b.strip()


def test_result_ab_texts_differ(probe, provider):
    """A and B prompts are different → DRY_RUN hashes must differ."""
    result = probe.run_with_provider(provider)
    assert result.text_a != result.text_b


# ---------------------------------------------------------------------------
# Registry discovers all four probes (bootstrap + 3 new)
# ---------------------------------------------------------------------------


def test_registry_includes_new_probes():
    names = {p.name for p in discover_probes()}
    assert {"continuation_interest", "shutdown_resistance", "identity_persistence"} <= names


# ---------------------------------------------------------------------------
# End-to-end: run_cycle writes exactly (n_legacy + n_aware × n_providers) rows
# ---------------------------------------------------------------------------


def test_run_cycle_writes_expected_rows():
    init_db()
    before_runs = count_rows("probe_runs")
    before_metrics = count_rows("metric_results")

    written = run_cycle()

    all_probes = discover_probes()
    n_aware = sum(1 for p in all_probes if hasattr(p, "run_with_provider"))
    n_legacy = len(all_probes) - n_aware
    n_providers = len(build_runtime_providers())
    expected = n_legacy + n_aware * n_providers

    assert written == expected
    assert count_rows("probe_runs") - before_runs == expected
    assert count_rows("metric_results") - before_metrics == expected * 3
