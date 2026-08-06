from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_corrections_registry_has_release_audit_fields():
    registry = json.loads((REPO_ROOT / "CORRECTIONS.json").read_text(encoding="utf-8"))
    required = {
        "correction_id",
        "field",
        "prior_value",
        "new_value",
        "prior_definition",
        "new_definition",
        "reason",
        "affected_bundle",
        "superseded",
        "date",
        "commit",
        "audit_url",
    }
    assert registry["corrections"]
    assert all(required <= set(correction) for correction in registry["corrections"])
