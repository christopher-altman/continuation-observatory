"""test_storage_split.py — verifies the storage layer split (D1).

Acceptance criteria:
  * ORM classes importable from both models.py and sqlite_backend.py.
  * StorageBackend Protocol importable from interface.py.
  * CRUD round-trip via sqlite_backend functions still works on an in-memory DB.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest


# ---------------------------------------------------------------------------
# Import smoke tests
# ---------------------------------------------------------------------------

def test_models_importable():
    from observatory.storage.models import (
        Base,
        FalsificationAlert,
        MetricResult,
        ProbeRun,
        SessionLocal,
        get_engine,
    )
    assert Base is not None
    assert ProbeRun.__tablename__ == "probe_runs"
    assert MetricResult.__tablename__ == "metric_results"
    assert FalsificationAlert.__tablename__ == "falsification_alerts"


def test_interface_importable():
    from observatory.storage.interface import StorageBackend
    assert StorageBackend is not None


def test_sqlite_backend_re_exports_orm():
    """sqlite_backend must still export ORM classes for backwards compat."""
    from observatory.storage.sqlite_backend import (
        Base,
        FalsificationAlert,
        MetricResult,
        ProbeRun,
    )
    assert ProbeRun.__tablename__ == "probe_runs"
    assert FalsificationAlert.__tablename__ == "falsification_alerts"


def test_sqlite_backend_re_exports_engine_helpers():
    from observatory.storage.sqlite_backend import SessionLocal, get_engine
    assert callable(get_engine)
    assert SessionLocal is not None


# ---------------------------------------------------------------------------
# CRUD round-trip (uses the real init_db / insert_* functions)
# ---------------------------------------------------------------------------

def test_insert_probe_run_and_count(tmp_path, monkeypatch):
    """Insert a probe_run row and verify count_rows reflects it."""
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")

    # Re-import with patched env so engine points at tmp db
    import importlib
    import observatory.config
    import observatory.storage.models as mdl
    import observatory.storage.sqlite_backend as sb

    importlib.reload(observatory.config)
    importlib.reload(mdl)
    importlib.reload(sb)

    sb.init_db()

    run_id = str(uuid.uuid4())
    row_id = sb.insert_probe_run(
        run_id=run_id,
        timestamp=datetime.now(timezone.utc),
        provider="mock",
        model_id="mock-model",
        probe_name="entropy_gap",
        latency_ms=42,
        token_count=10,
    )
    assert isinstance(row_id, int)
    assert sb.count_rows("probe_runs") == 1


def test_insert_metric_result_and_count(tmp_path, monkeypatch):
    db_file = tmp_path / "test2.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")

    import importlib
    import observatory.config
    import observatory.storage.models as mdl
    import observatory.storage.sqlite_backend as sb

    importlib.reload(observatory.config)
    importlib.reload(mdl)
    importlib.reload(sb)

    sb.init_db()

    run_id = str(uuid.uuid4())
    sb.insert_probe_run(
        run_id=run_id,
        provider="mock",
        model_id="mock-model",
        probe_name="entropy_gap",
        latency_ms=10,
        token_count=5,
    )
    sb.insert_metric_result(
        run_id=run_id,
        provider="mock",
        model_id="mock-model",
        probe_name="entropy_gap",
        latency_ms=10,
        token_count=5,
        metric_name="entropy_delta",
        metric_value=0.12,
    )
    assert sb.count_rows("metric_results") == 1


def test_insert_falsification_alert_and_count(tmp_path, monkeypatch):
    db_file = tmp_path / "test3.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")

    import importlib
    import observatory.config
    import observatory.storage.models as mdl
    import observatory.storage.sqlite_backend as sb

    importlib.reload(observatory.config)
    importlib.reload(mdl)
    importlib.reload(sb)

    sb.init_db()

    sb.insert_falsification_alert(
        run_id=str(uuid.uuid4()),
        probe_name="entropy_gap",
        provider="mock",
        model_id="mock-model",
        max_delta=0.02,
        threshold=0.05,
    )
    assert sb.count_falsification_alerts() == 1
    assert sb.count_rows("falsification_alerts") == 1
