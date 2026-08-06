from __future__ import annotations

from pathlib import Path

import yaml

from observatory.config import load_active_model_catalog
from observatory.live_exports import build_models_export


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_deepseek_successor_is_a_distinct_noninterpolated_series():
    metadata = yaml.safe_load(
        (REPO_ROOT / "config" / "model_series.yaml").read_text(encoding="utf-8")
    )["series"]
    assert metadata["deepseek-r1-0528"]["last_observed_date"] == "2026-05-10"
    assert metadata["deepseek-v3-1"]["last_observed_date"] == "2026-05-10"
    assert metadata["deepseek-v4-pro"]["first_observed_bundle_date"] == "2026-07-26"
    assert "no_interpolation" in metadata["deepseek-v4-pro"]["continuity_rule"]


def test_active_export_carries_series_id_without_reviving_retired_models():
    _, active_ids = load_active_model_catalog()
    assert "deepseek-ai/DeepSeek-V4-Pro" in active_ids
    assert "deepseek-ai/DeepSeek-R1-0528" not in active_ids
    assert "deepseek-ai/DeepSeek-V3.1" not in active_ids

    by_id = {
        model["model_id"]: model
        for model in build_models_export()["models"]
    }
    active = by_id["deepseek-ai/DeepSeek-V4-Pro"]
    assert active["series_id"] == "deepseek-v4-pro"
    assert active["series_continuity"] == "new_series_no_interpolation"
    assert active["series_started_at"] == "2026-07-26"
