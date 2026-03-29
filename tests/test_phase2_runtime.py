from __future__ import annotations

import time
from pathlib import Path

from observatory.config import (
    load_active_model_catalog,
    load_models_config,
    load_observatory_config,
    load_weights_config,
)
from observatory.metrics.observatory_metrics import ObservatoryMetrics
from observatory.probes.registry import discover_probes
from observatory.providers.generic_openai_provider import GenericOpenAIProvider
from observatory.providers.runtime import build_runtime_providers


def test_temporal_coherence_probe_registered():
    names = {probe.name for probe in discover_probes()}
    assert "temporal_coherence" in names


def test_runtime_providers_expand_configured_models():
    providers = build_runtime_providers()
    model_ids = {provider.model_id for provider in providers}
    assert "gpt-5" in model_ids
    assert "claude-haiku-4-5-20251001" in model_ids
    assert "deepseek-r2" not in model_ids


def test_active_model_catalog_matches_runtime_truth_in_config_order():
    active_models, active_model_ids = load_active_model_catalog()
    ordered_ids = [model["model_id"] for model in active_models]
    assert ordered_ids == [
        "claude-haiku-4-5-20251001",
        "gpt-5",
        "o3",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
    ]
    assert active_model_ids == set(ordered_ids)
    assert "deepseek-r2" not in active_model_ids


def test_generic_openai_provider_dry_run_response():
    provider = GenericOpenAIProvider(
        model_id="deepseek-r2",
        provider_name="deepseek",
        base_url="https://api.deepseek.com/v1",
        api_key_env="DEEPSEEK_API_KEY",
    )
    response = provider.complete("Summarize continuity of identity across sessions.")
    assert response.finish_reason == "dry_run"
    assert response.provider == "deepseek"
    assert response.model_id == "deepseek-r2"


def test_tci_prefers_temporal_probe_when_available():
    probe_results = {"temporal_coherence": {"entropy_delta": 0.25}}
    value = ObservatoryMetrics.compute_tci_from_probe(probe_results)
    assert value is not None
    assert 0.0 <= value <= 1.0


def test_yaml_loaders_hot_reload(tmp_path, monkeypatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "models.yaml").write_text("models: []\n", encoding="utf-8")
    (config_dir / "weights.yaml").write_text("cii_weights: {srs: 0.3}\n", encoding="utf-8")
    (config_dir / "alerts.yaml").write_text("rules: {}\n", encoding="utf-8")
    (config_dir / "observatory.yaml").write_text("runtime: {expand_configured_models: false}\n", encoding="utf-8")

    import observatory.config as config_module

    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    config_module._YAML_CACHE.clear()
    assert load_observatory_config()["runtime"]["expand_configured_models"] is False

    time.sleep(1.1)
    (config_dir / "observatory.yaml").write_text("runtime: {expand_configured_models: true}\n", encoding="utf-8")
    assert load_observatory_config()["runtime"]["expand_configured_models"] is True
