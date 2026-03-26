from observatory.scheduler.scheduler import run_cycle
from observatory.storage.sqlite_backend import count_rows, init_db


def test_run_cycle_writes_rows():
    init_db()
    before_runs = count_rows("probe_runs")
    before_metrics = count_rows("metric_results")

    written = run_cycle()

    after_runs = count_rows("probe_runs")
    after_metrics = count_rows("metric_results")

    assert written >= 1
    assert after_runs > before_runs
    assert after_metrics > before_metrics
