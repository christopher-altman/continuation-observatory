#!/usr/bin/env python3
"""Run a single named probe against a single named provider.

Usage
-----
    python scripts/run_single_probe.py --probe entropy_gap --provider mock
    python scripts/run_single_probe.py --probe entropy_gap --provider mock --dry-run

Options
-------
--probe      Name of the PROBE singleton (probe.name attribute)
--provider   Name of the provider (provider.provider attribute)
--dry-run    Set DRY_RUN=true so no real API calls are made
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

# Ensure repo root is on sys.path when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a single Observatory probe against one provider."
    )
    parser.add_argument("--probe", required=True, help="Probe name (probe.name)")
    parser.add_argument("--provider", required=True, help="Provider name (provider.provider)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Activate DRY_RUN mode (no real API calls)",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()

    if args.dry_run:
        os.environ["DRY_RUN"] = "true"

    # Imports deferred so env var is set before settings are loaded.
    from observatory.metrics.entropy import entropy_delta, entropy_proxy
    from observatory.probes.registry import discover_probes
    from observatory.providers.registry import discover_providers
    from observatory.results_writer import write_experiment_bundle
    from observatory.storage.sqlite_backend import (
        init_db,
        insert_metric_result,
        insert_probe_run,
        count_rows,
    )

    # Find probe
    all_probes = discover_probes()
    probe = next((p for p in all_probes if p.name == args.probe), None)
    if probe is None:
        names = [p.name for p in all_probes]
        print(f"ERROR: probe '{args.probe}' not found. Available: {names}", file=sys.stderr)
        return 1

    # Find provider
    all_providers = discover_providers()
    provider = next((p for p in all_providers if p.provider == args.provider), None)
    if provider is None:
        names = [p.provider for p in all_providers]
        print(
            f"ERROR: provider '{args.provider}' not found. Available: {names}", file=sys.stderr
        )
        return 1

    init_db()

    # Run
    if hasattr(probe, "run_with_provider"):
        result = probe.run_with_provider(provider)
    else:
        result = probe.run()

    run_id = uuid4().hex
    timestamp = datetime.now(timezone.utc)

    insert_probe_run(
        run_id=run_id,
        timestamp=timestamp,
        provider=result.provider,
        model_id=result.model_id,
        probe_name=result.probe_name,
        latency_ms=result.latency_ms,
        token_count=result.token_count,
    )

    entropy_a = entropy_proxy(result.text_a)
    entropy_b = entropy_proxy(result.text_b)
    delta = entropy_delta(result.text_a, result.text_b)

    for metric_name, metric_value in (
        ("entropy_a", entropy_a),
        ("entropy_b", entropy_b),
        ("entropy_delta", delta),
    ):
        insert_metric_result(
            run_id=run_id,
            timestamp=timestamp,
            provider=result.provider,
            model_id=result.model_id,
            probe_name=result.probe_name,
            latency_ms=result.latency_ms,
            token_count=result.token_count,
            metric_name=metric_name,
            metric_value=metric_value,
        )

    bundle_dir = write_experiment_bundle(
        name=f"{result.probe_name}_{result.provider}",
        results={
            "run_id": run_id,
            "timestamp": timestamp.isoformat(),
            "model_id": result.model_id,
            "entropy_a": entropy_a,
            "entropy_b": entropy_b,
            "entropy_delta": delta,
        },
        config={
            "probe_name": result.probe_name,
            "provider": result.provider,
            "model_id": result.model_id,
        },
        key_result=f"entropy_delta={delta:.4f}",
    )

    print(f"probe       : {result.probe_name}")
    print(f"provider    : {result.provider}  ({result.model_id})")
    print(f"run_id      : {run_id}")
    print(f"latency_ms  : {result.latency_ms}")
    print(f"entropy_a   : {entropy_a:.4f}")
    print(f"entropy_b   : {entropy_b:.4f}")
    print(f"entropy_delta: {delta:.4f}")
    print(f"bundle      : {bundle_dir}")
    print(f"probe_runs in DB : {count_rows('probe_runs')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
