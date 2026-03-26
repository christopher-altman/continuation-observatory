from observatory.storage.sqlite_backend import get_engine, init_db


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
