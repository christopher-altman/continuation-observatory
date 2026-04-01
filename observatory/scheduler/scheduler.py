from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone
from uuid import uuid4

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from observatory.config import load_active_model_catalog, load_weights_config, settings
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

logger = logging.getLogger(__name__)


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


def _active_metric_model_ids(*, extra_model_ids: set[str] | None = None) -> set[str]:
    _, active_model_ids = load_active_model_catalog()
    model_ids = set(active_model_ids)
    if extra_model_ids:
        model_ids.update(extra_model_ids)
    return model_ids


def _latest_metric_maps(*, allowed_model_ids: set[str] | None = None) -> tuple[
    dict[str, dict[str, float | None]],
    dict[str, float | None],
]:
    latest_metrics = get_latest_observatory_metrics()
    model_cii_map: dict[str, float | None] = {}
    model_metric_map: dict[str, dict[str, float | None]] = defaultdict(dict)
    for row in latest_metrics:
        model_id = row["model_id"]
        if allowed_model_ids is not None and model_id not in allowed_model_ids:
            continue
        model_metric_map[model_id][row["metric_name"]] = row["value"]
        if row["metric_name"] == "cii":
            model_cii_map[model_id] = row["value"]
    return model_metric_map, model_cii_map


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


def _persist_failure_event(
    *,
    timestamp: datetime,
    provider: str,
    model_id: str,
    probe_name: str,
    exc: Exception,
) -> dict:
    error_text = " ".join(str(exc).split())
    payload = {
        "provider": provider,
        "model_id": model_id,
        "probe_name": probe_name,
        "error_class": exc.__class__.__name__,
        "error": error_text[:500],
    }
    insert_observatory_event(
        timestamp=timestamp,
        event_type="probe_execution_failed",
        severity="error",
        model_id=model_id,
        message=f"{probe_name} failed for {model_id}: {payload['error_class']}.",
        payload=payload,
    )
    return payload


def _broadcast_event(
    *,
    timestamp: datetime,
    event_type: str,
    severity: str,
    model_id: str | None,
    message: str,
    payload: dict | None,
    metric_name: str | None = None,
) -> None:
    _run_async(
        manager.broadcast(
            "events",
            {
                "timestamp": timestamp.isoformat(),
                "data": {
                    "event_type": event_type,
                    "severity": severity,
                    "model_id": model_id,
                    "metric_name": metric_name,
                    "message": message,
                    "payload": payload,
                },
            },
        )
    )


def _compute_current_pcii(model_cii_map: dict[str, float | None]) -> tuple[float | None, float | None]:
    pcii_value = compute_pcii(model_cii_map)
    if pcii_value is None:
        return None, None
    history_rows = get_pcii_timeseries(limit=500)
    history = [
        (datetime.fromisoformat(row["timestamp"]), row["value"])
        for row in history_rows
        if row.get("value") is not None
    ]
    pcii_delta = compute_pcii_delta(pcii_value, history, hours=6.0)
    return pcii_value, pcii_delta


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

    allowed_model_ids = _active_metric_model_ids(extra_model_ids={model_id})
    _, model_cii_map = _latest_metric_maps(allowed_model_ids=allowed_model_ids)
    pcii_value, pcii_delta = _compute_current_pcii(model_cii_map)
    if pcii_value is not None:
        insert_pcii_sample(
            timestamp=timestamp,
            value=pcii_value,
            n_models=len([value for value in model_cii_map.values() if value is not None]),
            model_cii=model_cii_map,
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

    return {
        "provider": provider,
        "model_id": model_id,
        "component_metrics": component_metrics,
        "cii": cii_value,
        "is_degraded": is_degraded,
        "pcii": pcii_value,
        "pcii_delta_6h": pcii_delta,
        "alerts": [],
    }


def _new_cycle_probe_health() -> dict[str, dict[str, int | float | list[str] | str]]:
    return {}


def _record_cycle_outcome(
    cycle_probe_health: dict[str, dict[str, int | float | list[str] | str]],
    *,
    provider_name: str,
    model_id: str,
    probe_name: str,
    outcome: str,
) -> None:
    state = cycle_probe_health.setdefault(
        model_id,
        {
            "provider": provider_name,
            "completed_attempts": 0,
            "failed_attempts": 0,
            "skipped_attempts": 0,
            "completed_probes": [],
            "failed_probes": [],
            "skipped_probes": [],
        },
    )
    count_key = f"{outcome}_attempts"
    probe_key = f"{outcome}_probes"
    state[count_key] = int(state[count_key]) + 1
    cast_probes = state[probe_key]
    assert isinstance(cast_probes, list)
    cast_probes.append(probe_name)


def _finalize_cycle_probe_health(
    cycle_probe_health: dict[str, dict[str, int | float | list[str] | str]],
) -> dict[str, dict[str, int | float | list[str] | str]]:
    finalized: dict[str, dict[str, int | float | list[str] | str]] = {}
    for model_id, state in cycle_probe_health.items():
        completed = int(state["completed_attempts"])
        failed = int(state["failed_attempts"])
        skipped = int(state["skipped_attempts"])
        attempted = completed + failed
        failure_rate = (failed / attempted) if attempted else 0.0
        finalized[model_id] = {
            **state,
            "attempted_probes": attempted,
            "failure_rate": failure_rate,
        }
    return finalized


def _emit_cycle_alerts(
    *,
    timestamp: datetime,
    cycle_probe_health: dict[str, dict[str, int | float | list[str] | str]],
) -> list[dict]:
    finalized_probe_health = _finalize_cycle_probe_health(cycle_probe_health)
    allowed_model_ids = _active_metric_model_ids(extra_model_ids=set(finalized_probe_health))
    model_metric_map, model_cii_map = _latest_metric_maps(allowed_model_ids=allowed_model_ids)
    pcii_value, pcii_delta = _compute_current_pcii(model_cii_map)

    alert_engine = AlertEngine(_load_recent_events())
    alerts = alert_engine.check_all(
        {"value": pcii_value, "delta_6h": pcii_delta},
        model_metric_map,
        finalized_probe_health,
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
        persisted_alert = {
            "timestamp": alert["timestamp"].isoformat(),
            "event_type": alert["event_type"],
            "severity": alert["severity"],
            "model_id": alert.get("model_id"),
            "metric_name": alert.get("metric_name"),
            "message": alert["message"],
            "payload": alert.get("payload"),
        }
        persisted_alerts.append(persisted_alert)
        _run_async(manager.broadcast("events", {"timestamp": persisted_alert["timestamp"], "data": persisted_alert}))
    if finalized_probe_health:
        logger.info("Cycle health summary: %s", finalized_probe_health)
    return persisted_alerts


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
    cycle_probe_health = _new_cycle_probe_health()

    for probe in probes:
        if hasattr(probe, "run_with_provider") and providers:
            # Provider-aware probe: one run per registered provider
            for provider in providers:
                try:
                    result = probe.run_with_provider(provider)
                except Exception as exc:
                    timestamp = datetime.now(timezone.utc)
                    _record_cycle_outcome(
                        cycle_probe_health,
                        provider_name=provider.provider,
                        model_id=provider.model_id,
                        probe_name=probe.name,
                        outcome="failed",
                    )
                    failure_payload = _persist_failure_event(
                        timestamp=timestamp,
                        provider=provider.provider,
                        model_id=provider.model_id,
                        probe_name=probe.name,
                        exc=exc,
                    )
                    _broadcast_event(
                        timestamp=timestamp,
                        event_type="probe_execution_failed",
                        severity="error",
                        model_id=provider.model_id,
                        message=f"{probe.name} failed for {provider.model_id}: {failure_payload['error_class']}.",
                        payload=failure_payload,
                    )
                    logger.exception(
                        "Probe attempt failed for provider=%s model=%s probe=%s",
                        provider.provider,
                        provider.model_id,
                        probe.name,
                    )
                    continue
                run_id = uuid4().hex
                timestamp = datetime.now(timezone.utc)
                metrics = _store_result(result, run_id, timestamp)
                _record_cycle_outcome(
                    cycle_probe_health,
                    provider_name=result.provider,
                    model_id=result.model_id,
                    probe_name=result.probe_name,
                    outcome="completed",
                )
                completion_payload = _persist_completion_event(timestamp, result)
                _broadcast_event(
                    timestamp=timestamp,
                    event_type="probe_completed",
                    severity="info",
                    model_id=result.model_id,
                    message=f"{result.probe_name} completed for {result.model_id}.",
                    payload=completion_payload,
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
            _broadcast_event(
                timestamp=timestamp,
                event_type="probe_completed",
                severity="info",
                model_id=result.model_id,
                message=f"{result.probe_name} completed for {result.model_id}.",
                payload=completion_payload,
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

    _emit_cycle_alerts(
        timestamp=datetime.now(timezone.utc),
        cycle_probe_health=cycle_probe_health,
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
            try:
                result = probe.run_with_provider(provider)
            except Exception as exc:
                timestamp = datetime.now(timezone.utc)
                failure_payload = _persist_failure_event(
                    timestamp=timestamp,
                    provider=provider.provider,
                    model_id=provider.model_id,
                    probe_name=probe.name,
                    exc=exc,
                )
                _broadcast_event(
                    timestamp=timestamp,
                    event_type="probe_execution_failed",
                    severity="error",
                    model_id=provider.model_id,
                    message=f"{probe.name} failed for {provider.model_id}: {failure_payload['error_class']}.",
                    payload=failure_payload,
                )
                logger.exception(
                    "Sweep probe attempt failed for provider=%s model=%s probe=%s",
                    provider.provider,
                    provider.model_id,
                    probe.name,
                )
                continue
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
            _broadcast_event(
                timestamp=timestamp,
                event_type="probe_completed",
                severity="info",
                model_id=result.model_id,
                message=f"{result.probe_name} completed for {result.model_id}.",
                payload=completion_payload,
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
