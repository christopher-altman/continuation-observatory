from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import sqrt
from typing import Any

from observatory.config import (
    load_alerts_config,
    load_models_config,
    load_observatory_config,
    load_weights_config,
)
from observatory.metrics.pcii import compute_pcii
from observatory.providers.runtime import build_runtime_providers
from observatory.storage.sqlite_backend import (
    get_latest_observatory_metrics,
    get_observatory_events,
    get_observatory_timeseries,
    get_pcii_timeseries,
)

COMPONENT_METRICS = ("srs", "ips", "mpg", "tci", "edp", "cii")
RANGE_DELTAS = {
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}


def parse_range(range_name: str) -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    delta = RANGE_DELTAS.get(range_name, RANGE_DELTAS["24h"])
    return now - delta, now


def supported_runtime_models() -> dict[str, dict[str, Any]]:
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


def group_latest_metrics() -> dict[tuple[str, str], dict[str, Any]]:
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


def _known_model_ids(runtime: dict[str, dict[str, Any]] | None = None) -> set[str]:
    known = {
        str(spec.get("model_string"))
        for spec in load_models_config().get("models", [])
        if spec.get("model_string")
    }
    if runtime is None:
        runtime = supported_runtime_models()
    known.update(runtime.keys())
    return known


def _filter_nested_model_ids(value: Any, allowed_model_ids: set[str], known_model_ids: set[str]) -> Any:
    if isinstance(value, dict):
        filtered: dict[str, Any] = {}
        for key, nested in value.items():
            if key in known_model_ids and key not in allowed_model_ids:
                continue
            filtered[key] = _filter_nested_model_ids(nested, allowed_model_ids, known_model_ids)
        return filtered
    if isinstance(value, list):
        filtered_items = []
        for item in value:
            if isinstance(item, dict):
                model_id = item.get("model_id")
                if model_id and model_id in known_model_ids and model_id not in allowed_model_ids:
                    continue
            filtered_items.append(_filter_nested_model_ids(item, allowed_model_ids, known_model_ids))
        return filtered_items
    return value


def _filter_pcii_series(
    start: datetime,
    end: datetime,
    allowed_model_ids: set[str],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    filtered_series: list[dict[str, Any]] = []
    latest_visible: dict[str, Any] | None = None
    for row in get_pcii_timeseries(start=start, end=end, limit=5000):
        model_cii = row.get("model_cii") or {}
        filtered_model_cii = {
            model_id: value
            for model_id, value in model_cii.items()
            if model_id in allowed_model_ids
        }
        value = compute_pcii(filtered_model_cii)
        if value is None:
            continue
        filtered_row = {
            **row,
            "value": value,
            "n_models": len([metric for metric in filtered_model_cii.values() if metric is not None]),
            "model_cii": filtered_model_cii,
        }
        filtered_series.append(filtered_row)
        latest_visible = filtered_row
    return filtered_series, latest_visible


def _filter_events(
    events: list[dict[str, Any]],
    allowed_model_ids: set[str],
    known_model_ids: set[str],
) -> list[dict[str, Any]]:
    filtered_events: list[dict[str, Any]] = []
    for event in events:
        model_id = event.get("model_id")
        if model_id and model_id not in allowed_model_ids:
            continue
        if not model_id and (
            event.get("metric_name") == "pcii"
            or str(event.get("event_type", "")).startswith("pcii_")
        ):
            continue
        filtered_event = dict(event)
        payload = filtered_event.get("payload")
        if payload is not None:
            filtered_event["payload"] = _filter_nested_model_ids(
                payload,
                allowed_model_ids,
                known_model_ids,
            )
        filtered_events.append(filtered_event)
    return filtered_events


def models_payload(allowed_model_ids: set[str] | None = None) -> list[dict[str, Any]]:
    configured = load_models_config().get("models", [])
    runtime = supported_runtime_models()
    latest = group_latest_metrics()
    merged: dict[str, dict[str, Any]] = {}
    include_disabled = load_observatory_config().get("runtime", {}).get(
        "include_disabled_models_in_api", True
    )

    for spec in configured:
        model_id = spec["model_string"]
        if allowed_model_ids is not None:
            if model_id not in allowed_model_ids:
                continue
        elif not include_disabled and not spec.get("enabled", False):
            continue
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
        if allowed_model_ids is not None and model_id not in allowed_model_ids:
            continue
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
        if allowed_model_ids is not None and model_id not in allowed_model_ids:
            continue
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
    if allowed_model_ids is None:
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


def _recent_cii_series(window_days: int) -> dict[str, list[float]]:
    start = datetime.now(timezone.utc) - timedelta(days=window_days)
    rows = get_observatory_timeseries(
        metric_name="cii",
        start=start,
        end=datetime.now(timezone.utc),
        limit=5000,
    )
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


def build_constellation(models: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    models = [
        model for model in (models if models is not None else models_payload())
        if model["metrics"].get("cii") is not None
    ]
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


def build_observatory_snapshot(
    history_range: str = "30d",
    event_limit: int = 40,
    allowed_model_ids: set[str] | None = None,
) -> dict[str, Any]:
    start, end = parse_range(history_range)
    models = models_payload(allowed_model_ids=allowed_model_ids)
    visible_model_ids = {model["model_id"] for model in models}
    constellation = build_constellation(models=models)
    known_model_ids = _known_model_ids()
    if allowed_model_ids is None:
        pcii_series = get_pcii_timeseries(start=start, end=end, limit=5000)
        latest_pcii = pcii_series[-1] if pcii_series else None
    else:
        pcii_series, latest_pcii = _filter_pcii_series(start, end, visible_model_ids)
    cii_rows = get_observatory_timeseries(metric_name="cii", start=start, end=end, limit=20000)
    cii_history: dict[str, list[dict[str, Any]]] = {}
    for row in cii_rows:
        if row.get("value") is None:
            continue
        if allowed_model_ids is not None and row["model_id"] not in visible_model_ids:
            continue
        cii_history.setdefault(row["model_id"], []).append(
            {"timestamp": row["timestamp"], "value": float(row["value"])}
        )
    for series in cii_history.values():
        series.sort(key=lambda item: item["timestamp"])

    events = get_observatory_events(limit=event_limit)
    event_hidden_types = set(load_alerts_config().get("ui", {}).get("default_hide_event_types", []))
    visible_events = [row for row in events if row["event_type"] not in event_hidden_types]
    if allowed_model_ids is not None:
        visible_events = _filter_events(visible_events, visible_model_ids, known_model_ids)
    summary = {
        "history_range": history_range,
        "tracked_models": len(models),
        "live_models": sum(1 for model in models if model.get("live")),
        "n_models": len(models),
        "focused_metric": "cii",
        "constellation_threshold": constellation["threshold"],
        "similarity_window_days": constellation["window_days"],
        "latest_pcii": latest_pcii["value"] if latest_pcii else None,
        "latest_pcii_timestamp": latest_pcii["timestamp"] if latest_pcii else None,
        "available_ranges": list(RANGE_DELTAS.keys()),
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": summary,
        "models": models,
        "events": visible_events,
        "constellation": constellation,
        "pcii_series": pcii_series,
        "cii_history": cii_history,
    }
