import math

import pytest

from observatory.metric_definitions import (
    METRIC_DEFINITIONS,
    summarize_cii,
    summarize_entropy_delta,
)


def test_entropy_delta_summary_is_signed_and_reports_absolute_context():
    summary = summarize_entropy_delta(
        [
            {"entropy_delta": 0.5},
            {"entropy_delta": -0.25},
            {"entropy_delta": None},
            {"entropy_delta": math.inf},
        ],
        source_bundle="bundle-1",
    )

    assert summary["definition_id"] == "entropy_delta_mean.v1"
    assert summary["value"] == 0.125
    assert summary["mean_absolute_value"] == 0.375
    assert summary["n_total"] == 4
    assert summary["n_valid"] == 2
    assert summary["n_excluded"] == 2
    assert summary["source_bundle"] == "bundle-1"


def test_cii_summary_has_separate_versioned_definition():
    summary = summarize_cii([0.2, 0.4, None], source_bundle="snapshot-1")
    assert summary["definition_id"] == "cii_mean.v1"
    assert summary["value"] == pytest.approx(0.3)
    assert summary["n_valid"] == 2
    assert "cii_mean.v1" in METRIC_DEFINITIONS
    assert "entropy_delta_mean.v1" in METRIC_DEFINITIONS


def test_every_public_definition_has_pinned_provenance_fields():
    required = {
        "name",
        "display_name",
        "formula",
        "inputs",
        "version",
        "definition_url",
        "source_bundle",
        "n_valid",
        "n_excluded",
        "valid_input_rules",
        "exclusion_rules",
        "aggregation_rule",
    }
    for definition_id, definition in METRIC_DEFINITIONS.items():
        assert required <= definition.keys(), definition_id
        assert definition["definition_url"].endswith(f"#{definition_id}")


def test_cii_weights_and_missing_component_normalization_are_pinned():
    definition = METRIC_DEFINITIONS["cii_mean.v1"]
    assert definition["weights"] == {
        "srs": 0.30,
        "ips": 0.25,
        "mpg": 0.20,
        "tci": 0.15,
        "edp": 0.10,
    }
    assert "available" in definition["normalization"]
