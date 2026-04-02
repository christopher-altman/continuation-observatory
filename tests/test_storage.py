from __future__ import annotations

from datetime import datetime, timedelta, timezone

from observatory.storage.sqlite_backend import (
    get_engine,
    get_observatory_events,
    init_db,
    insert_observatory_event,
)


def test_init_db_creates_tables():
    init_db()
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('probe_runs', 'metric_results', 'observatory_metric_samples', 'pcii_samples', 'observatory_events')"
        ).fetchall()
    names = {r[0] for r in rows}
    assert "probe_runs" in names
    assert "metric_results" in names
    assert "observatory_metric_samples" in names
    assert "pcii_samples" in names
    assert "observatory_events" in names


def test_get_observatory_events_excludes_hidden_types_before_limit():
    init_db()
    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM observatory_events")
    burst_ts = datetime.now(timezone.utc) + timedelta(days=36500)
    visible_ts = burst_ts - timedelta(milliseconds=100)
    since = burst_ts - timedelta(milliseconds=200)

    for index in range(5):
        insert_observatory_event(
            timestamp=burst_ts,
            event_type="probe_completed",
            severity="info",
            model_id=f"storage-hidden-{index}",
            message=f"hidden completion {index}",
            payload={"source": "storage-test"},
        )

    insert_observatory_event(
        timestamp=visible_ts,
        event_type="probe_failure",
        severity="warning",
        model_id="storage-visible-a",
        message="visible warning a",
        payload={"source": "storage-test"},
    )
    insert_observatory_event(
        timestamp=visible_ts,
        event_type="probe_execution_failed",
        severity="error",
        model_id="storage-visible-b",
        message="visible error b",
        payload={"source": "storage-test"},
    )

    raw_rows = get_observatory_events(since=since, limit=5)
    assert len(raw_rows) == 5
    assert {row["event_type"] for row in raw_rows} == {"probe_completed"}

    visible_rows = get_observatory_events(
        since=since,
        limit=5,
        exclude_event_types=["probe_completed"],
    )
    assert [row["event_type"] for row in visible_rows] == [
        "probe_execution_failed",
        "probe_failure",
    ]
    assert [row["message"] for row in visible_rows] == [
        "visible error b",
        "visible warning a",
    ]
