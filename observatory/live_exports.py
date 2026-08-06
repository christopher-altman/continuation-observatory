from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func

from observatory.config import (
    get_probe_cycle_interval_minutes,
    load_active_model_catalog,
    load_observatory_config,
    load_weights_config,
)
from observatory.probes.registry import discover_probes
from observatory.storage.sqlite_backend import (
    MetricResult,
    ObservatoryMetricSample,
    SessionLocal,
    get_observatory_events,
    get_observatory_timeseries,
    get_pcii_timeseries,
)

WINDOW_CHAR_VALUES = (10, 50, 100, 200, 500)
HISTORICAL_THRESHOLDS = {"green": 0.10, "yellow": 0.05}
FUTURE_SKEW = timedelta(minutes=5)
RANGE_DELTAS = {
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}

METRIC_EXPORT_FIELDS = (
    "entropy_a",
    "entropy_b",
    "entropy_delta",
    *(f"window_entropy_gap_chars_{value}" for value in WINDOW_CHAR_VALUES),
    *(f"delta_gap_d{value}" for value in WINDOW_CHAR_VALUES),
)
TIMESERIES_METRICS = (
    "entropy_delta",
    *(f"window_entropy_gap_chars_{value}" for value in WINDOW_CHAR_VALUES),
    *(f"delta_gap_d{value}" for value in WINDOW_CHAR_VALUES),
)
CSV_FIELDS = (
    "name",
    "status",
    "provider",
    "model_id",
    "probe_name",
    "timestamp",
    "run_id",
    *METRIC_EXPORT_FIELDS,
    "new_matter_flag",
    "key_result",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _current_cutoff() -> datetime:
    return datetime.now(timezone.utc) + FUTURE_SKEW


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _to_utc(value).isoformat()


def _catalog_context() -> tuple[list[dict[str, Any]], set[str]]:
    active_models, active_ids = load_active_model_catalog()
    return active_models, active_ids


def _apply_metric_filters(query, active_ids: set[str]):
    query = query.filter(MetricResult.timestamp <= _current_cutoff())
    if active_ids:
        query = query.filter(MetricResult.model_id.in_(tuple(active_ids)))
    return query


def _metric_rows(metric_names: tuple[str, ...] | None = None) -> list[MetricResult]:
    _, active_ids = _catalog_context()
    with SessionLocal() as session:
        query = _apply_metric_filters(session.query(MetricResult), active_ids)
        if metric_names:
            query = query.filter(MetricResult.metric_name.in_(metric_names))
        return (
            query.order_by(
                MetricResult.timestamp.asc(),
                MetricResult.run_id.asc(),
                MetricResult.id.asc(),
            )
            .all()
        )


def _metric_run_entries(rows: list[MetricResult]) -> list[dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = entries.setdefault(
            row.run_id,
            {
                "name": f"{row.probe_name}_{row.model_id}_{row.run_id[:8]}",
                "status": "complete",
                "provider": row.provider,
                "model_id": row.model_id,
                "probe_name": row.probe_name,
                "timestamp": _iso(row.timestamp),
                "run_id": row.run_id,
                "new_matter_flag": False,
                "key_result": "",
            },
        )
        if _to_utc(row.timestamp) > datetime.fromisoformat(entry["timestamp"]):
            entry["timestamp"] = _iso(row.timestamp)
        if row.metric_name in METRIC_EXPORT_FIELDS:
            entry[row.metric_name] = row.metric_value
            if row.metric_name == "entropy_delta":
                entry["key_result"] = f"entropy_delta={row.metric_value:.4f}"
    return sorted(entries.values(), key=lambda item: (item["timestamp"], item["run_id"]))


def _metric_value(entry: dict[str, Any], name: str) -> float | None:
    value = entry.get(name)
    if value == "":
        return None
    return value


def build_latest_export() -> dict[str, Any]:
    latest_by_model: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in _metric_run_entries(_metric_rows(metric_names=METRIC_EXPORT_FIELDS)):
        key = (str(entry["provider"]), str(entry["model_id"]))
        existing = latest_by_model.get(key)
        if existing is not None and entry["timestamp"] <= existing["timestamp"]:
            continue
        latest = {
            "provider": entry["provider"],
            "model_id": entry["model_id"],
            "timestamp": entry["timestamp"],
            "probe_name": entry["probe_name"],
            "run_id": entry["run_id"],
            "entropy_a": _metric_value(entry, "entropy_a"),
            "entropy_b": _metric_value(entry, "entropy_b"),
            "entropy_delta": _metric_value(entry, "entropy_delta"),
        }
        for window_chars in WINDOW_CHAR_VALUES:
            active_name = f"window_entropy_gap_chars_{window_chars}"
            historical_name = f"delta_gap_d{window_chars}"
            if active_name in entry:
                latest[active_name] = entry[active_name]
            if historical_name in entry:
                latest[historical_name] = entry[historical_name]
        latest_by_model[key] = latest
    return {"generated_at": _now_iso(), "models": list(latest_by_model.values())}


def build_timeseries_export() -> dict[str, Any]:
    timeseries: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for row in _metric_rows(metric_names=TIMESERIES_METRICS):
        timeseries.setdefault(row.metric_name, {}).setdefault(row.model_id, []).append(
            {"t": _iso(row.timestamp), "v": row.metric_value}
        )
    return {"generated_at": _now_iso(), "metrics": timeseries}


def _metric_window_chars(metric_name: str) -> tuple[int | None, bool]:
    prefixes = (
        ("window_entropy_gap_chars_", False),
        ("delta_gap_d", True),
    )
    for prefix, historical in prefixes:
        if metric_name.startswith(prefix):
            try:
                return int(metric_name.removeprefix(prefix)), historical
            except ValueError:
                return None, historical
    return None, False


def _latest_sweep_rows() -> list[MetricResult]:
    _, active_ids = _catalog_context()
    with SessionLocal() as session:
        subq = (
            _apply_metric_filters(session.query(MetricResult), active_ids)
            .with_entities(
                MetricResult.provider,
                MetricResult.model_id,
                MetricResult.metric_name,
                func.max(MetricResult.timestamp).label("max_ts"),
            )
            .filter(MetricResult.probe_name.in_(("window_size_sweep", "dimensionality_sweep")))
            .filter(
                (MetricResult.metric_name.like("window_entropy_gap_chars_%"))
                | (MetricResult.metric_name.like("delta_gap_d%"))
            )
            .group_by(MetricResult.provider, MetricResult.model_id, MetricResult.metric_name)
            .subquery()
        )
        return (
            session.query(MetricResult)
            .join(
                subq,
                (MetricResult.provider == subq.c.provider)
                & (MetricResult.model_id == subq.c.model_id)
                & (MetricResult.metric_name == subq.c.metric_name)
                & (MetricResult.timestamp == subq.c.max_ts),
            )
            .order_by(MetricResult.provider.asc(), MetricResult.model_id.asc(), MetricResult.id.asc())
            .all()
        )


def build_falsification_export() -> dict[str, Any]:
    active_models, _ = _catalog_context()
    model_order = {
        str(spec["model_id"]): index
        for index, spec in enumerate(active_models)
        if spec.get("model_id")
    }
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _latest_sweep_rows():
        window_chars, historical = _metric_window_chars(row.metric_name)
        if window_chars is None:
            continue
        entry = grouped.setdefault(
            (row.provider, row.model_id),
            {
                "provider": row.provider,
                "model_id": row.model_id,
                "timestamp": _iso(row.timestamp),
                "window_chars_values": {},
                "historical_d_values": {},
                "dry_run": False,
            },
        )
        target = "historical_d_values" if historical else "window_chars_values"
        entry[target][window_chars] = row.metric_value
        if _to_utc(row.timestamp) > datetime.fromisoformat(entry["timestamp"]):
            entry["timestamp"] = _iso(row.timestamp)

    models = []
    for entry in grouped.values():
        active_values = dict(sorted(entry["window_chars_values"].items()))
        historical_values = dict(sorted(entry["historical_d_values"].items()))
        display_values = active_values or historical_values
        models.append(
            {
                **entry,
                "window_chars_values": display_values,
                "historical_d_values": historical_values,
                "model_status": "monitoring",
                "source_semantics": (
                    "window_entropy_gap.v1"
                    if active_values
                    else "historical_delta_gap_d_alias_window_chars"
                ),
            }
        )

    models.sort(
        key=lambda item: (
            model_order.get(str(item["model_id"]), 9999),
            str(item["provider"]),
            str(item["model_id"]),
        )
    )
    return {
        "generated_at": _now_iso(),
        "overall_status": "nominal",
        "status_text": (
            "OBSERVATORY NOMINAL. Scheduled provider-backed measurements are "
            "active across the current model roster."
        ),
        "verdict_status": "not_issued",
        "thresholds": {"active": None},
        "window_chars": list(WINDOW_CHAR_VALUES),
        "n_window_points": sum(
            1
            for model in models
            for value in model["window_chars_values"].values()
            if value is not None
        ),
        "n_models": len(models),
        "models": models,
    }


def _parse_timestamp(timestamp: str | None) -> datetime | None:
    if not timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(timestamp)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _telemetry_label(telemetry_state: str) -> str:
    return {
        "current": "Current reading",
        "partial": "Partial / recent evidence",
        "unavailable": "No current sample",
    }.get(telemetry_state, "No current sample")


def _entropy_interpretation(entropy_delta: float | None, telemetry_state: str) -> str:
    if entropy_delta is None:
        return "Insufficient sample" if telemetry_state == "partial" else "No current sample"
    if entropy_delta > 0.05:
        return "Increased"
    if entropy_delta < -0.05:
        return "Decreased"
    return "Stable"


def build_models_export() -> dict[str, Any]:
    active_models, _ = _catalog_context()
    probe_cycle_minutes = get_probe_cycle_interval_minutes()
    try:
        probe_coverage_total = len(discover_probes())
    except Exception:
        probe_coverage_total = 0
    models_map: dict[str, dict[str, Any]] = {}

    for spec in active_models:
        model_id = str(spec.get("model_id") or spec.get("model_string") or "")
        if not model_id:
            continue
        models_map[model_id] = {
            "provider": spec.get("provider", "unknown"),
            "model_id": model_id,
            "display_name": spec.get("display_name", model_id),
            "probes": [],
            "entropy_delta": None,
            "timestamp": None,
            "figure": None,
            "interval_minutes": spec.get("interval_minutes"),
            "rate_limit_rpm": spec.get("rate_limit_rpm"),
            "series_id": spec.get("series_id", spec.get("id", model_id)),
            "series_continuity": spec.get("series_continuity", "same_model_series"),
            "series_started_at": spec.get("series_started_at"),
            "series_ended_at": spec.get("series_ended_at"),
        }

    for entry in _metric_run_entries(_metric_rows(metric_names=METRIC_EXPORT_FIELDS)):
        model_id = str(entry.get("model_id") or "")
        if not model_id:
            continue
        model = models_map.setdefault(
            model_id,
            {
                "provider": entry.get("provider", "unknown"),
                "model_id": model_id,
                "display_name": model_id,
                "probes": [],
                "entropy_delta": None,
                "timestamp": None,
                "figure": None,
                "interval_minutes": None,
                "rate_limit_rpm": None,
                "series_id": model_id,
                "series_continuity": "unclassified_historical_series",
                "series_started_at": None,
                "series_ended_at": None,
            },
        )
        probe_name = str(entry.get("probe_name") or "")
        if probe_name and probe_name not in model["probes"]:
            model["probes"].append(probe_name)
        current_timestamp = str(entry.get("timestamp") or "")
        if model["timestamp"] is None or current_timestamp > str(model["timestamp"]):
            model["provider"] = entry.get("provider", model["provider"])
            model["entropy_delta"] = _metric_value(entry, "entropy_delta")
            model["timestamp"] = current_timestamp

    now = datetime.now(timezone.utc)
    models = []
    for model in models_map.values():
        timestamp = model.get("timestamp")
        entropy_delta = model.get("entropy_delta")
        last_seen = _parse_timestamp(timestamp)
        interval = max(int(model.get("interval_minutes") or 0), probe_cycle_minutes)
        is_current = (
            entropy_delta is not None
            and last_seen is not None
            and (now - last_seen) <= timedelta(minutes=interval)
        )
        if is_current:
            telemetry_state = "current"
        elif timestamp or model.get("probes") or entropy_delta is not None:
            telemetry_state = "partial"
        else:
            telemetry_state = "unavailable"
        models.append(
            {
                **model,
                "telemetry_state": telemetry_state,
                "telemetry_label": _telemetry_label(telemetry_state),
                "probe_coverage_count": len(model.get("probes") or []),
                "probe_coverage_total": probe_coverage_total,
                "entropy_interpretation": _entropy_interpretation(entropy_delta, telemetry_state),
            }
        )

    state_order = {"current": 0, "partial": 1, "unavailable": 2}
    models.sort(
        key=lambda item: (
            state_order.get(item["telemetry_state"], 99),
            -(
                (_parse_timestamp(item.get("timestamp")) or datetime.fromtimestamp(0, tz=timezone.utc))
                .timestamp()
            ),
            str(item.get("display_name") or item.get("model_id") or "").lower(),
        )
    )
    return {"generated_at": _now_iso(), "models": models}


def build_all_metrics_rows() -> list[dict[str, Any]]:
    rows = []
    for entry in _metric_run_entries(_metric_rows(metric_names=METRIC_EXPORT_FIELDS)):
        rows.append({field: entry.get(field, "") for field in CSV_FIELDS})
    return rows


def build_all_metrics_csv() -> str:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=list(CSV_FIELDS))
    writer.writeheader()
    writer.writerows(build_all_metrics_rows())
    return output.getvalue()


def build_export_summary() -> dict[str, Any]:
    _, active_ids = _catalog_context()
    with SessionLocal() as session:
        count_query = _apply_metric_filters(
            session.query(func.count(func.distinct(MetricResult.run_id))),
            active_ids,
        )
        min_query = _apply_metric_filters(session.query(func.min(MetricResult.timestamp)), active_ids)
        run_count = int(count_query.scalar() or 0)
        min_timestamp = min_query.scalar()
    return {
        "generated_at": _now_iso(),
        "experiment_count": run_count,
        "data_since": _iso(min_timestamp)[:10] if min_timestamp else "",
    }


def _snapshot_range(range_name: str) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - RANGE_DELTAS.get(range_name, RANGE_DELTAS["30d"]), now


def _latest_observatory_metric_rows(active_ids: set[str]) -> list[ObservatoryMetricSample]:
    with SessionLocal() as session:
        base = session.query(ObservatoryMetricSample).filter(
            ObservatoryMetricSample.timestamp <= _current_cutoff()
        )
        if active_ids:
            base = base.filter(ObservatoryMetricSample.model_id.in_(tuple(active_ids)))
        subq = (
            base.with_entities(
                ObservatoryMetricSample.provider,
                ObservatoryMetricSample.model_id,
                ObservatoryMetricSample.metric_name,
                func.max(ObservatoryMetricSample.timestamp).label("max_ts"),
            )
            .group_by(
                ObservatoryMetricSample.provider,
                ObservatoryMetricSample.model_id,
                ObservatoryMetricSample.metric_name,
            )
            .subquery()
        )
        return (
            session.query(ObservatoryMetricSample)
            .join(
                subq,
                (ObservatoryMetricSample.provider == subq.c.provider)
                & (ObservatoryMetricSample.model_id == subq.c.model_id)
                & (ObservatoryMetricSample.metric_name == subq.c.metric_name)
                & (ObservatoryMetricSample.timestamp == subq.c.max_ts),
            )
            .order_by(ObservatoryMetricSample.provider.asc(), ObservatoryMetricSample.model_id.asc())
            .all()
        )


def build_live_observatory_snapshot_export() -> dict[str, Any]:
    history_range = "30d"
    start, end = _snapshot_range(history_range)
    active_models, active_ids = _catalog_context()
    observatory_config = load_observatory_config()
    constellation_config = observatory_config.get("constellation", {})
    threshold = float(
        constellation_config.get(
            "edge_threshold",
            load_weights_config().get("observatory", {}).get("constellation_similarity_threshold", 0.60),
        )
    )
    window_days = int(constellation_config.get("similarity_window_days", 7))
    probe_cycle_minutes = get_probe_cycle_interval_minutes(observatory_config)

    models_by_id: dict[str, dict[str, Any]] = {}
    for spec in active_models:
        model_id = str(spec.get("model_id") or "")
        if not model_id:
            continue
        models_by_id[model_id] = {
            "provider": spec.get("provider", "unknown"),
            "model_id": model_id,
            "display_name": spec.get("display_name", model_id),
            "enabled": True,
            "supported": True,
            "source": "config",
            "interval_minutes": spec.get("interval_minutes"),
            "rate_limit_rpm": spec.get("rate_limit_rpm"),
            "metrics": {},
            "last_seen": None,
            "is_degraded": False,
        }

    for row in _latest_observatory_metric_rows(active_ids):
        if row.model_id not in models_by_id:
            continue
        model = models_by_id[row.model_id]
        model["provider"] = row.provider
        model["metrics"][row.metric_name] = row.value
        model["is_degraded"] = model["is_degraded"] or bool(row.is_degraded)
        timestamp = _iso(row.timestamp)
        if model["last_seen"] is None or timestamp > model["last_seen"]:
            model["last_seen"] = timestamp

    now = datetime.now(timezone.utc)
    models = []
    for model in models_by_id.values():
        last_seen = _parse_timestamp(model["last_seen"])
        interval = max(int(model.get("interval_minutes") or 0), probe_cycle_minutes)
        stale = last_seen is None or (now - last_seen) > timedelta(minutes=interval)
        live = last_seen is not None and not stale
        models.append(
            {
                **model,
                "live": live,
                "stale": stale,
                "status": "active" if live else "configured",
            }
        )

    pcii_series = get_pcii_timeseries(start=start, end=end, limit=5000)
    latest_pcii = pcii_series[-1] if pcii_series else None
    cii_history = {
        model["model_id"]: [
            {"timestamp": row["timestamp"], "value": row["value"]}
            for row in get_observatory_timeseries(
                model_id=model["model_id"],
                metric_name="cii",
                start=start,
                end=end,
                limit=5000,
            )
            if row.get("value") is not None
        ]
        for model in models
    }
    events = get_observatory_events(limit=40)

    return {
        "generated_at": _now_iso(),
        "summary": {
            "history_range": history_range,
            "tracked_models": len(models),
            "live_models": sum(1 for model in models if model.get("live")),
            "n_models": len(models),
            "focused_metric": "cii",
            "constellation_threshold": threshold,
            "similarity_window_days": window_days,
            "latest_pcii": latest_pcii.get("value") if latest_pcii else None,
            "latest_pcii_timestamp": latest_pcii.get("timestamp") if latest_pcii else None,
            "available_ranges": list(RANGE_DELTAS.keys()),
        },
        "models": models,
        "events": events,
        "incidents": [],
        "incident_board": {
            "generated_at": _now_iso(),
            "items": [],
            "source_event_count": len(events),
        },
        "constellation": {
            "nodes": [
                {
                    "id": model["model_id"],
                    "provider": model["provider"],
                    "label": model["display_name"],
                    "cii": model["metrics"].get("cii"),
                    "ips": model["metrics"].get("ips"),
                    "srs": model["metrics"].get("srs"),
                    "metrics": model["metrics"],
                    "last_seen": model["last_seen"],
                    "telemetry_state": "live" if model.get("live") else "configured",
                }
                for model in models
            ],
            "edges": [],
            "threshold": threshold,
            "window_days": window_days,
        },
        "pcii_series": pcii_series,
        "cii_history": cii_history,
    }
