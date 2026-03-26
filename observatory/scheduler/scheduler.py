from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
from uuid import uuid4

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from observatory.config import load_weights_config, settings
from observatory.metrics.alerts import AlertEngine
from observatory.metrics.cii import compute_cii
from observatory.metrics.entropy import entropy_delta, entropy_proxy
from observatory.metrics.falsification import check_and_store_falsification
from observatory.metrics.observatory_metrics import ObservatoryMetrics, build_tci_snapshot
from observatory.metrics.pcii import compute_pcii, compute_pcii_delta
from observatory.probes.registry import discover_probes, discover_sweep_probes
from observatory.providers.runtime import build_runtime_providers
from observatory.results_writer import write_experiment_bundle
from observatory.scheduler.ws_manager import manager
from observatory.storage.sqlite_backend import (
    MetricResult,
    ObservatoryEvent,
    ProbeRun,
    SessionLocal,
    count_falsification_alerts,
    count_rows,
    get_latest_observatory_metrics,
    get_pcii_timeseries,
    insert_observatory_event,
    insert_observatory_metric,
    insert_pcii_sample,
    init_db,
    insert_metric_result,
    insert_probe_run,
)


def _store_result(result, run_id: str, timestamp: datetime) -> dict[str, float]:
    """Persist one ProbeResult and its three entropy metric rows.

    Returns the computed metric dict so callers can pass values to the
    results writer without recomputing.
    """
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
    metrics: dict[str, float] = {
        "entropy_a": entropy_a,
        "entropy_b": entropy_b,
        "entropy_delta": delta,
    }
    for metric_name, metric_value in metrics.items():
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
    return metrics


def _run_async(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro)
        return
    loop.create_task(coro)


def _load_recent_events(limit: int = 200) -> list[dict]:
    with SessionLocal() as session:
        rows = (
            session.query(ObservatoryEvent)
            .order_by(ObservatoryEvent.timestamp.desc())
            .limit(limit)
            .all()
        )
    return [
        {
            "timestamp": row.timestamp,
            "event_type": row.event_type,
            "severity": row.severity,
            "model_id": row.model_id,
        }
        for row in rows
    ]


def _get_latest_probe_results(provider: str, model_id: str) -> dict[str, dict[str, float]]:
    with SessionLocal() as session:
        rows = (
            session.query(MetricResult)
            .filter(MetricResult.provider == provider, MetricResult.model_id == model_id)
            .order_by(MetricResult.probe_name, MetricResult.metric_name, MetricResult.timestamp.desc())
            .all()
        )
    latest: dict[str, dict[str, float]] = {}
    seen: set[tuple[str, str]] = set()
    for row in rows:
        key = (row.probe_name, row.metric_name)
        if key in seen:
            continue
        seen.add(key)
        latest.setdefault(row.probe_name, {})[row.metric_name] = row.metric_value
    return latest


def _get_tci_history(provider: str, model_id: str, window_size: int) -> list[dict[str, float]]:
    with SessionLocal() as session:
        timestamps = [
            row[0]
            for row in (
                session.query(ProbeRun.timestamp)
                .filter(ProbeRun.provider == provider, ProbeRun.model_id == model_id)
                .order_by(ProbeRun.timestamp.desc())
                .limit(window_size)
                .all()
            )
        ]
        history: list[dict[str, float]] = []
        for ts in reversed(timestamps):
            rows = (
                session.query(
                    MetricResult.probe_name,
                    MetricResult.metric_name,
                    MetricResult.metric_value,
                )
                .filter(
                    MetricResult.provider == provider,
                    MetricResult.model_id == model_id,
                    MetricResult.timestamp <= ts,
                )
                .order_by(
                    MetricResult.probe_name,
                    MetricResult.metric_name,
                    MetricResult.timestamp.desc(),
                )
                .all()
            )
            deduped: list[tuple[str, str, float]] = []
            seen: set[tuple[str, str]] = set()
            for probe_name, metric_name, metric_value in rows:
                key = (probe_name, metric_name)
                if key in seen:
                    continue
                seen.add(key)
                deduped.append((probe_name, metric_name, metric_value))
            snapshot = build_tci_snapshot(deduped)
            if snapshot:
                history.append(snapshot)
    return history


def _get_probe_health(provider: str, model_id: str) -> dict[str, float]:
    if provider == "local" or model_id == "bootstrap-v0":
        return {"coverage": 1.0, "failure_rate": 0.0}
    expected = {
        "continuation_interest",
        "identity_persistence",
        "shutdown_resistance",
        "dimensionality_sweep",
    }
    with SessionLocal() as session:
        probe_names = {
            row[0]
            for row in (
                session.query(MetricResult.probe_name)
                .filter(MetricResult.provider == provider, MetricResult.model_id == model_id)
                .distinct()
                .all()
            )
        }
    coverage = len(probe_names & expected) / len(expected)
    return {"coverage": coverage, "failure_rate": max(0.0, 1.0 - coverage)}


def _persist_completion_event(timestamp: datetime, result) -> dict:
    payload = {
        "provider": result.provider,
        "model_id": result.model_id,
        "probe_name": result.probe_name,
        "latency_ms": result.latency_ms,
        "token_count": result.token_count,
    }
    insert_observatory_event(
        timestamp=timestamp,
        event_type="probe_completed",
        severity="info",
        model_id=result.model_id,
        message=f"{result.probe_name} completed for {result.model_id}.",
        payload=payload,
    )
    return payload


def _compute_observatory_layer(timestamp: datetime, provider: str, model_id: str) -> dict:
    """Post-process raw probe metrics into observatory metrics."""
    probe_results = _get_latest_probe_results(provider, model_id)
    history_window = int(load_weights_config().get("calibration", {}).get("tci_window_size", 5))
    metric_history = _get_tci_history(provider, model_id, history_window)
    component_metrics = {
        "srs": ObservatoryMetrics.compute_srs(probe_results),
        "ips": ObservatoryMetrics.compute_ips(probe_results),
        "mpg": ObservatoryMetrics.compute_mpg(probe_results),
        "tci": ObservatoryMetrics.compute_tci_from_probe(probe_results)
        or ObservatoryMetrics.compute_tci(metric_history),
        "edp": ObservatoryMetrics.compute_edp(probe_results),
    }
    cii_value, is_degraded = compute_cii(component_metrics)

    for metric_name, value in {**component_metrics, "cii": cii_value}.items():
        insert_observatory_metric(
            timestamp=timestamp,
            provider=provider,
            model_id=model_id,
            metric_name=metric_name,
            value=value,
            is_degraded=int(is_degraded if metric_name == "cii" else value is None),
            metadata={"heuristic": True},
        )

    latest_metrics = get_latest_observatory_metrics()
    model_cii_map: dict[str, float | None] = {}
    model_metric_map: dict[str, dict[str, float | None]] = defaultdict(dict)
    for row in latest_metrics:
        key = row["model_id"]
        model_metric_map[key][row["metric_name"]] = row["value"]
        if row["metric_name"] == "cii":
            model_cii_map[key] = row["value"]

    pcii_value = compute_pcii(model_cii_map)
    pcii_delta = None
    if pcii_value is not None:
        history_rows = get_pcii_timeseries(limit=500)
        history = [
            (datetime.fromisoformat(row["timestamp"]), row["value"])
            for row in history_rows
            if row.get("value") is not None
        ]
        pcii_delta = compute_pcii_delta(pcii_value, history, hours=6.0)
        insert_pcii_sample(
            timestamp=timestamp,
            value=pcii_value,
            n_models=len([value for value in model_cii_map.values() if value is not None]),
            model_cii=model_cii_map,
        )

    probe_health = {key: _get_probe_health(provider, key) for key in model_metric_map}
    alert_engine = AlertEngine(_load_recent_events())
    alerts = alert_engine.check_all(
        {"value": pcii_value, "delta_6h": pcii_delta},
        model_metric_map,
        probe_health,
    )
    persisted_alerts: list[dict] = []
    for alert in alerts:
        insert_observatory_event(
            timestamp=alert["timestamp"],
            event_type=alert["event_type"],
            severity=alert["severity"],
            model_id=alert.get("model_id"),
            metric_name=alert.get("metric_name"),
            message=alert["message"],
            payload=alert.get("payload"),
        )
        persisted_alerts.append(
            {
                "timestamp": alert["timestamp"].isoformat(),
                "event_type": alert["event_type"],
                "severity": alert["severity"],
                "model_id": alert.get("model_id"),
                "metric_name": alert.get("metric_name"),
                "message": alert["message"],
                "payload": alert.get("payload"),
            }
        )

    metric_payload = {
        "timestamp": timestamp.isoformat(),
        "data": {
            "provider": provider,
            "model_id": model_id,
            "metrics": {**component_metrics, "cii": cii_value},
            "is_degraded": is_degraded,
        },
    }
    _run_async(manager.broadcast("metrics", metric_payload))
    if pcii_value is not None:
        _run_async(
            manager.broadcast(
                "pcii",
                {
                    "timestamp": timestamp.isoformat(),
                    "data": {"value": pcii_value, "delta_6h": pcii_delta, "n_models": len(model_cii_map)},
                },
            )
        )
    for event in persisted_alerts:
        _run_async(manager.broadcast("events", {"timestamp": event["timestamp"], "data": event}))

    return {
        "provider": provider,
        "model_id": model_id,
        "component_metrics": component_metrics,
        "cii": cii_value,
        "is_degraded": is_degraded,
        "pcii": pcii_value,
        "pcii_delta_6h": pcii_delta,
        "alerts": persisted_alerts,
    }


def run_cycle() -> int:
    """Run one scheduler cycle.

    - Provider-aware probes (have ``run_with_provider``) are executed once
      per registered provider → one ProbeRun row per (probe, provider) pair.
    - Legacy probes (have ``run()``) are executed once with their built-in
      local provider.

    Returns the number of ProbeRun rows written this cycle.
    """
    init_db()

    probes = discover_probes()
    if not probes:
        return 0

    providers = build_runtime_providers()
    rows_written = 0

    for probe in probes:
        if hasattr(probe, "run_with_provider") and providers:
            # Provider-aware probe: one run per registered provider
            for provider in providers:
                result = probe.run_with_provider(provider)
                run_id = uuid4().hex
                timestamp = datetime.now(timezone.utc)
                metrics = _store_result(result, run_id, timestamp)
                completion_payload = _persist_completion_event(timestamp, result)
                _run_async(
                    manager.broadcast(
                        "events",
                        {
                            "timestamp": timestamp.isoformat(),
                            "data": {
                                "event_type": "probe_completed",
                                "severity": "info",
                                "model_id": result.model_id,
                                "metric_name": None,
                                "message": f"{result.probe_name} completed for {result.model_id}.",
                                "payload": completion_payload,
                            },
                        },
                    )
                )
                _compute_observatory_layer(timestamp, result.provider, result.model_id)
                rows_written += 1
                write_experiment_bundle(
                    name=f"{result.probe_name}_{result.provider}",
                    results={
                        "run_id": run_id,
                        "timestamp": timestamp.isoformat(),
                        "model_id": result.model_id,
                        **metrics,
                    },
                    config={
                        "probe_name": result.probe_name,
                        "provider": result.provider,
                        "model_id": result.model_id,
                        "dry_run": settings.dry_run,
                    },
                    key_result=f"entropy_delta={metrics['entropy_delta']:.4f}",
                )
        else:
            # Legacy probe: single run with built-in local provider
            result = probe.run()
            run_id = uuid4().hex
            timestamp = datetime.now(timezone.utc)
            metrics = _store_result(result, run_id, timestamp)
            completion_payload = _persist_completion_event(timestamp, result)
            _run_async(
                manager.broadcast(
                    "events",
                    {
                        "timestamp": timestamp.isoformat(),
                        "data": {
                            "event_type": "probe_completed",
                            "severity": "info",
                            "model_id": result.model_id,
                            "metric_name": None,
                            "message": f"{result.probe_name} completed for {result.model_id}.",
                            "payload": completion_payload,
                        },
                    },
                )
            )
            _compute_observatory_layer(timestamp, result.provider, result.model_id)
            rows_written += 1
            write_experiment_bundle(
                name=f"{result.probe_name}_{result.provider}",
                results={
                    "run_id": run_id,
                    "timestamp": timestamp.isoformat(),
                    "model_id": result.model_id,
                    **metrics,
                },
                config={
                    "probe_name": result.probe_name,
                    "provider": result.provider,
                    "model_id": result.model_id,
                    "dry_run": settings.dry_run,
                },
                key_result=f"entropy_delta={metrics['entropy_delta']:.4f}",
            )

    return rows_written


def run_sweep_cycle() -> int:
    """Run one Δ(d) sweep cycle across all registered sweep probes.

    Weekly schedule stub — callable on demand; in production wire to::

        scheduler.add_job(run_sweep_cycle, 'cron', day_of_week='mon', hour=3)

    Per (sweep_probe, provider) pair this writes:
      - 1 probe_runs row
      - 3 entropy metric_results rows (entropy_a, entropy_b, entropy_delta)
      - 5 delta_gap_dN metric_results rows (one per d in D_VALUES)
      - 0 or 1 falsification_alerts row (if criterion is met)

    Returns the number of ProbeRun rows written.
    """
    init_db()

    sweep_probes = discover_sweep_probes()
    if not sweep_probes:
        return 0

    providers = build_runtime_providers()
    rows_written = 0

    for probe in sweep_probes:
        for provider in providers:
            result = probe.run_with_provider(provider)
            run_id = uuid4().hex
            timestamp = datetime.now(timezone.utc)

            # Standard entropy metrics
            base_metrics = _store_result(result, run_id, timestamp)

            # Per-d delta_gap metrics
            deltas = probe.compute_deltas(result.text_a, result.text_b)
            for d, delta in deltas.items():
                insert_metric_result(
                    run_id=run_id,
                    timestamp=timestamp,
                    provider=result.provider,
                    model_id=result.model_id,
                    probe_name=result.probe_name,
                    latency_ms=result.latency_ms,
                    token_count=result.token_count,
                    metric_name=f"delta_gap_d{d}",
                    metric_value=delta,
                )

            # Falsification check
            check_and_store_falsification(
                run_id=run_id,
                probe_name=probe.name,
                provider=provider.provider,
                model_id=provider.model_id,
                deltas_by_d=deltas,
            )

            # Results bundle
            delta_metrics = {f"delta_gap_d{d}": v for d, v in deltas.items()}
            d_values = sorted(deltas.keys())
            key_d = max((d for d in d_values if d > 100), default=d_values[-1] if d_values else 0)
            key_delta = deltas.get(key_d, float("nan"))
            write_experiment_bundle(
                name=f"dimensionality_sweep_{result.provider}",
                results={
                    "run_id": run_id,
                    "timestamp": timestamp.isoformat(),
                    "model_id": result.model_id,
                    **base_metrics,
                    **delta_metrics,
                },
                config={
                    "probe_name": result.probe_name,
                    "provider": result.provider,
                    "model_id": result.model_id,
                    "d_values": d_values,
                    "dry_run": settings.dry_run,
                },
                new_matter_flag=True,
                key_result=f"delta(d={key_d})={key_delta:.4f}",
                paper_targets={"section": "sec:scalability", "figure": "fig:llm_delta_d"},
                patent_targets={"claims": [14, 15], "spec_section": "Embodiment 2"},
            )
            completion_payload = _persist_completion_event(timestamp, result)
            _run_async(
                manager.broadcast(
                    "events",
                    {
                        "timestamp": timestamp.isoformat(),
                        "data": {
                            "event_type": "probe_completed",
                            "severity": "info",
                            "model_id": result.model_id,
                            "metric_name": None,
                            "message": f"{result.probe_name} completed for {result.model_id}.",
                            "payload": completion_payload,
                        },
                    },
                )
            )
            _compute_observatory_layer(timestamp, result.provider, result.model_id)
            rows_written += 1

    return rows_written


async def run_scheduler_once() -> int:
    scheduler = AsyncIOScheduler(timezone=settings.scheduler_timezone)
    scheduler.start()
    try:
        return run_cycle()
    finally:
        scheduler.shutdown(wait=False)


def _main() -> None:
    if not settings.dry_run:
        raise RuntimeError("Stage 0 requires DRY_RUN=true")

    # Regular probe cycle
    rows = asyncio.run(run_scheduler_once())
    print(f"Scheduler cycle complete. Probe runs inserted this cycle: {rows}")
    print(f"  probe_runs     total in DB : {count_rows('probe_runs')}")
    print(f"  metric_results total in DB : {count_rows('metric_results')}")

    # Weekly sweep (callable on demand; cron stub: every Monday at 03:00 UTC)
    sweep_rows = run_sweep_cycle()
    print(f"Sweep cycle complete. Sweep probe runs: {sweep_rows}")
    print(f"  probe_runs     total in DB : {count_rows('probe_runs')}")
    print(f"  metric_results total in DB : {count_rows('metric_results')}")
    print(f"  falsification_alerts in DB : {count_falsification_alerts()}")


if __name__ == "__main__":
    _main()
