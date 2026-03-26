from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import sqrt
from typing import Any

from fastapi import APIRouter, Query

from observatory.config import load_alerts_config, load_models_config, load_weights_config
from observatory.config import load_observatory_config
from observatory.providers.runtime import build_runtime_providers
from observatory.storage.sqlite_backend import (
    get_latest_observatory_metrics,
    get_observatory_events,
    get_observatory_timeseries,
    get_pcii_timeseries,
)

router = APIRouter(prefix="/api/observatory", tags=["observatory"])

COMPONENT_METRICS = ("srs", "ips", "mpg", "tci", "edp", "cii")


def _parse_range(range_name: str) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    mapping = {
        "1h": timedelta(hours=1),
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
        "30d": timedelta(days=30),
    }
    delta = mapping.get(range_name, mapping["24h"])
    return now - delta, now


def _supported_runtime_models() -> dict[str, dict[str, Any]]:
    supported: dict[str, dict[str, Any]] = {}
    for provider in build_runtime_providers():
        supported[provider.model_id] = {
            "provider": provider.provider,
            "model_id": provider.model_id,
            "display_name": provider.model_id,
            "enabled": True,
            "supported": True,
            "source": "runtime",
        }
    return supported


def _group_latest_metrics() -> dict[tuple[str, str], dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in get_latest_observatory_metrics():
        key = (row["provider"], row["model_id"])
        entry = grouped.setdefault(
            key,
            {
                "provider": row["provider"],
                "model_id": row["model_id"],
                "metrics": {},
                "last_seen": row["timestamp"],
                "is_degraded": False,
            },
        )
        entry["metrics"][row["metric_name"]] = row["value"]
        entry["is_degraded"] = entry["is_degraded"] or bool(row["is_degraded"])
        if row["timestamp"] > entry["last_seen"]:
            entry["last_seen"] = row["timestamp"]
    return grouped


def _models_payload() -> list[dict[str, Any]]:
    configured = load_models_config().get("models", [])
    runtime = _supported_runtime_models()
    latest = _group_latest_metrics()
    merged: dict[str, dict[str, Any]] = {}
    include_disabled = load_observatory_config().get("runtime", {}).get(
        "include_disabled_models_in_api", True
    )

    for spec in configured:
        if not include_disabled and not spec.get("enabled", False):
            continue
        model_id = spec["model_string"]
        merged[model_id] = {
            "provider": spec["provider"],
            "model_id": model_id,
            "display_name": spec.get("display_name", model_id),
            "enabled": bool(spec.get("enabled", False)),
            "supported": model_id in runtime,
            "source": "config",
            "interval_minutes": spec.get("interval_minutes"),
            "rate_limit_rpm": spec.get("rate_limit_rpm"),
            "metrics": {},
            "last_seen": None,
            "is_degraded": False,
        }

    for runtime_model in runtime.values():
        model_id = runtime_model["model_id"]
        if model_id not in merged:
            merged[model_id] = {
                **runtime_model,
                "interval_minutes": None,
                "rate_limit_rpm": None,
                "metrics": {},
                "last_seen": None,
                "is_degraded": False,
            }

    for (provider, model_id), latest_entry in latest.items():
        record = merged.setdefault(
            model_id,
            {
                "provider": provider,
                "model_id": model_id,
                "display_name": model_id,
                "enabled": True,
                "supported": model_id in runtime,
                "source": "runtime",
                "interval_minutes": None,
                "rate_limit_rpm": None,
                "metrics": {},
                "last_seen": None,
                "is_degraded": False,
            },
        )
        record["provider"] = provider
        record["metrics"] = latest_entry["metrics"]
        record["last_seen"] = latest_entry["last_seen"]
        record["is_degraded"] = latest_entry["is_degraded"]

    now = datetime.now(timezone.utc)
    payload = []
    for record in merged.values():
        last_seen = record["last_seen"]
        interval = record["interval_minutes"] or 60
        stale = True
        if last_seen:
            last_seen_dt = datetime.fromisoformat(last_seen)
            if last_seen_dt.tzinfo is None:
                last_seen_dt = last_seen_dt.replace(tzinfo=timezone.utc)
            stale = now - last_seen_dt > timedelta(minutes=interval * 2)
        payload.append(
            {
                **record,
                "live": record["last_seen"] is not None,
                "stale": stale,
                "status": (
                    "active"
                    if record["last_seen"] and not stale
                    else "configured"
                    if record["enabled"]
                    else "inactive"
                ),
            }
        )
    payload.sort(
        key=lambda row: (
            row["metrics"].get("cii") is None,
            -(row["metrics"].get("cii") or 0.0),
            row["display_name"],
        )
    )
    return payload


def _cosine_similarity(left: dict[str, float | None], right: dict[str, float | None]) -> float | None:
    shared = [
        key
        for key in COMPONENT_METRICS[:-1]
        if left.get(key) is not None and right.get(key) is not None
    ]
    if len(shared) < 2:
        return None
    left_values = [float(left[key]) for key in shared]
    right_values = [float(right[key]) for key in shared]
    dot = sum(a * b for a, b in zip(left_values, right_values))
    left_norm = sqrt(sum(a * a for a in left_values))
    right_norm = sqrt(sum(b * b for b in right_values))
    if left_norm == 0 or right_norm == 0:
        return None
    return dot / (left_norm * right_norm)


@router.get("/models")
def models() -> list[dict[str, Any]]:
    return _models_payload()


@router.get("/metrics")
def metrics(
    model: str | None = Query(None),
    metric: str = Query(...),
    range_name: str = Query("24h", alias="range"),
    limit: int = Query(500, ge=1, le=5000),
) -> list[dict[str, Any]]:
    start, end = _parse_range(range_name)
    return get_observatory_timeseries(
        model_id=model,
        metric_name=metric,
        start=start,
        end=end,
        limit=limit,
    )


@router.get("/pcii")
def pcii(
    range_name: str = Query("24h", alias="range"),
    limit: int = Query(500, ge=1, le=5000),
) -> list[dict[str, Any]]:
    start, end = _parse_range(range_name)
    return get_pcii_timeseries(start=start, end=end, limit=limit)


@router.get("/events")
def events(
    since: str | None = Query(None),
    severity: str | None = Query(None),
    model_id: str | None = Query(None),
    event_type: str | None = Query(None),
    include_completed: bool = Query(False),
    limit: int = Query(50, ge=1, le=500),
) -> list[dict[str, Any]]:
    since_dt = datetime.fromisoformat(since) if since else None
    rows = get_observatory_events(
        since=since_dt,
        severity=severity,
        model_id=model_id,
        limit=limit,
        event_type=event_type,
    )
    if include_completed:
        return rows
    hidden_types = set(load_alerts_config().get("ui", {}).get("default_hide_event_types", []))
    return [row for row in rows if row["event_type"] not in hidden_types]


def _recent_cii_series(window_days: int) -> dict[str, list[float]]:
    start = datetime.now(timezone.utc) - timedelta(days=window_days)
    rows = get_observatory_timeseries(metric_name="cii", start=start, end=datetime.now(timezone.utc), limit=5000)
    grouped: dict[str, list[float]] = {}
    for row in rows:
        if row.get("value") is None:
            continue
        grouped.setdefault(row["model_id"], []).append(float(row["value"]))
    return grouped


def _pearson_similarity(left: list[float], right: list[float]) -> float | None:
    if len(left) < 3 or len(right) < 3:
        return None
    n = min(len(left), len(right))
    left = left[-n:]
    right = right[-n:]
    left_mean = sum(left) / n
    right_mean = sum(right) / n
    num = sum((a - left_mean) * (b - right_mean) for a, b in zip(left, right))
    left_den = sqrt(sum((a - left_mean) ** 2 for a in left))
    right_den = sqrt(sum((b - right_mean) ** 2 for b in right))
    if left_den == 0 or right_den == 0:
        return None
    return num / (left_den * right_den)


@router.get("/constellation")
def constellation() -> dict[str, Any]:
    models = [model for model in _models_payload() if model["metrics"].get("cii") is not None]
    observatory_cfg = load_observatory_config().get("constellation", {})
    threshold = float(
        observatory_cfg.get(
            "edge_threshold",
            load_weights_config().get("observatory", {}).get("constellation_similarity_threshold", 0.60),
        )
    )
    window_days = int(observatory_cfg.get("similarity_window_days", 7))
    recent_series = _recent_cii_series(window_days)
    nodes = [
        {
            "id": model["model_id"],
            "provider": model["provider"],
            "label": model["display_name"],
            "cii": model["metrics"].get("cii"),
            "ips": model["metrics"].get("ips"),
            "srs": model["metrics"].get("srs"),
            "metrics": model["metrics"],
            "last_seen": model["last_seen"],
        }
        for model in models
    ]
    edges = []
    for index, left in enumerate(models):
        for right in models[index + 1 :]:
            similarity = _pearson_similarity(
                recent_series.get(left["model_id"], []),
                recent_series.get(right["model_id"], []),
            )
            similarity_mode = "rolling_pearson"
            if similarity is None:
                similarity = _cosine_similarity(left["metrics"], right["metrics"])
                similarity_mode = "latest_cosine"
            if similarity is not None and similarity >= threshold:
                edges.append(
                    {
                        "source": left["model_id"],
                        "target": right["model_id"],
                        "similarity": similarity,
                        "mode": similarity_mode,
                    }
                )
    return {"nodes": nodes, "edges": edges, "threshold": threshold, "window_days": window_days}
