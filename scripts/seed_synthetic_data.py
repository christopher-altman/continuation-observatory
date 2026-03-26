#!/usr/bin/env python3
"""Seed the Observatory database with synthetic data.

Forces DRY_RUN=true, runs one probe cycle and one sweep cycle, then prints
a summary of rows written.  Useful for local development and dashboard demos.

Usage
-----
    python scripts/seed_synthetic_data.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Force dry-run before settings module is imported.
os.environ["DRY_RUN"] = "true"

# Ensure repo root is on sys.path when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle
    from observatory.storage.sqlite_backend import (
        count_falsification_alerts,
        count_rows,
        init_db,
    )

    init_db()

    print("=== seed_synthetic_data.py ===")
    print("DRY_RUN=true — no real API calls will be made\n")

    probe_rows = run_cycle()
    print(f"run_cycle()       → {probe_rows} probe run(s) inserted")

    sweep_rows = run_sweep_cycle()
    print(f"run_sweep_cycle() → {sweep_rows} sweep run(s) inserted")

    print()
    print("Database totals:")
    print(f"  probe_runs          : {count_rows('probe_runs')}")
    print(f"  metric_results      : {count_rows('metric_results')}")
    print(f"  falsification_alerts: {count_falsification_alerts()}")
    print(f"  observatory_metrics : {count_rows('observatory_metric_samples')}")
    print(f"  pcii_samples        : {count_rows('pcii_samples')}")
    print(f"  observatory_events  : {count_rows('observatory_events')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
