from __future__ import annotations

from types import SimpleNamespace

import pytest

from observatory import config as config_module
from observatory.config import (
    GEMINI_MAX_OUTPUT_TOKENS,
    PRODUCTION_GEMINI_MODEL_ALLOWLIST,
    format_production_startup_summary,
    get_probe_cycle_interval_hours,
    load_active_model_catalog,
    settings,
)
from observatory.probes._provider_probe import ProviderProbe
from observatory.probes.registry import discover_probes, discover_sweep_probes
from observatory.providers.gemini_provider import GeminiProvider
from observatory.providers.runtime import build_runtime_providers


def test_production_gemini_configuration_is_flash_only():
    configured = [
        spec
        for spec in config_module.load_models_config()["models"]
        if spec.get("provider") == "gemini"
    ]
    assert [spec["model_string"] for spec in configured] == ["gemini-2.5-flash"]
    assert configured[0]["display_name"] == "Gemini Flash"
    assert configured[0]["enabled"] is True

    active_models, _ = load_active_model_catalog()
    active_gemini_ids = {
        spec["model_id"]
        for spec in active_models
        if spec.get("provider_kind") == "gemini"
    }
    assert active_gemini_ids == PRODUCTION_GEMINI_MODEL_ALLOWLIST


def test_unknown_active_gemini_model_fails_positive_validation(monkeypatch):
    monkeypatch.setattr(
        config_module,
        "load_models_config",
        lambda: {
            "models": [
                {
                    "id": "unknown-gemini",
                    "provider": "gemini",
                    "model_string": "gemini-unknown",
                    "enabled": True,
                }
            ]
        },
    )
    with pytest.raises(ValueError, match="Unknown active Gemini model"):
        load_active_model_catalog()


def test_gemini_provider_rejects_nonallowlisted_models():
    with pytest.raises(ValueError, match="production allowlist"):
        GeminiProvider(model_id="gemini-2.5-pro")


def test_runtime_provider_discovery_selects_only_flash():
    runtime_gemini = [
        provider
        for provider in build_runtime_providers()
        if provider.provider == "gemini"
    ]
    assert [provider.model_id for provider in runtime_gemini] == ["gemini-2.5-flash"]


def test_live_gemini_retries_preserve_output_cap_and_request_options(monkeypatch):
    import google.generativeai as genai

    import observatory.providers._backoff as backoff_module

    calls: list[dict] = []

    class FakeModel:
        def __init__(self, model_id: str) -> None:
            assert model_id == "gemini-2.5-flash"

        def generate_content(self, prompt: str, **kwargs):
            calls.append({"prompt": prompt, **kwargs})
            if len(calls) == 1:
                raise RuntimeError("retryable test failure")
            return SimpleNamespace(
                text="bounded",
                usage_metadata=SimpleNamespace(total_token_count=7),
            )

    monkeypatch.setattr(settings, "dry_run", False)
    monkeypatch.setattr(genai, "GenerativeModel", FakeModel)
    monkeypatch.setattr(backoff_module.time, "sleep", lambda _seconds: None)

    provider = GeminiProvider()
    response = provider.complete(
        "probe",
        generation_config={"temperature": 0.2, "max_output_tokens": 4096},
        safety_settings={"harassment": "block_none"},
        request_options={"timeout": 30},
    )

    assert response.text == "bounded"
    assert len(calls) == 2
    for call in calls:
        assert call["generation_config"] == {
            "temperature": 0.2,
            "max_output_tokens": GEMINI_MAX_OUTPUT_TOKENS,
        }
        assert call["safety_settings"] == {"harassment": "block_none"}
        assert call["request_options"] == {"timeout": 30}


def test_scheduler_cadence_startup_summary_and_monthly_budget():
    assert get_probe_cycle_interval_hours() == 12

    summary = format_production_startup_summary()
    assert summary == (
        "Enabled Gemini models:\n"
        "    Gemini Flash\n"
        "Probe cadence:\n"
        "    12 hours\n"
        "Gemini max output tokens:\n"
        "    256"
    )
    assert "Gemini Pro" not in summary
    assert "gemini-2.5-pro" not in summary

    regular_provider_probes = [
        probe for probe in discover_probes() if isinstance(probe, ProviderProbe)
    ]
    sweep_provider_probes = [
        probe for probe in discover_sweep_probes() if isinstance(probe, ProviderProbe)
    ]
    requests_per_probe = 2
    routine_requests_per_day = (
        len(PRODUCTION_GEMINI_MODEL_ALLOWLIST)
        * len(regular_provider_probes)
        * requests_per_probe
        * (24 // get_probe_cycle_interval_hours())
    )
    weekly_requests = (
        len(PRODUCTION_GEMINI_MODEL_ALLOWLIST)
        * len(sweep_provider_probes)
        * requests_per_probe
    )
    monthly_output_token_budget = (
        routine_requests_per_day * 30 * GEMINI_MAX_OUTPUT_TOKENS
        + weekly_requests * (30 / 7) * GEMINI_MAX_OUTPUT_TOKENS
    )

    assert routine_requests_per_day == 16
    assert weekly_requests == 2
    assert round(monthly_output_token_budget) == 125_074
