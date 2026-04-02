from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query

from observatory.config import load_alerts_config, load_observatory_config
from observatory.incident_feed import (
    build_public_incident_board,
    build_public_incidents,
    get_public_board_source_events,
    get_public_feed_config,
    get_public_visible_events,
)
from observatory.observatory_snapshot import (
    build_constellation,
    build_observatory_snapshot,
    models_payload,
    parse_range,
)
from observatory.storage.sqlite_backend import get_observatory_events, get_observatory_timeseries, get_pcii_timeseries

router = APIRouter(prefix="/api/observatory", tags=["observatory"])


@router.get("/models")
def models() -> list[dict[str, Any]]:
    return models_payload()


@router.get("/metrics")
def metrics(
    model: str | None = Query(None),
    metric: str = Query(...),
    range_name: str = Query("24h", alias="range"),
    limit: int = Query(500, ge=1, le=5000),
) -> list[dict[str, Any]]:
    start, end = parse_range(range_name)
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
    start, end = parse_range(range_name)
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
    if include_completed:
        return get_observatory_events(
            since=since_dt,
            severity=severity,
            model_id=model_id,
            limit=limit,
            event_type=event_type,
        )
    hidden_types = set(load_alerts_config().get("ui", {}).get("default_hide_event_types", []))
    return get_observatory_events(
        since=since_dt,
        severity=severity,
        model_id=model_id,
        limit=limit,
        event_type=event_type,
        exclude_event_types=tuple(hidden_types) if hidden_types else None,
    )


@router.get("/incidents")
def incidents(
    since: str | None = Query(None),
    severity: str | None = Query(None),
    model_id: str | None = Query(None),
    event_type: str | None = Query(None),
    limit: int = Query(10, ge=1, le=100),
) -> list[dict[str, Any]]:
    since_dt = datetime.fromisoformat(since) if since else None
    observatory_config = load_observatory_config()
    feed_config = get_public_feed_config(observatory_config)
    current_models = models_payload()
    latest_pcii_series = get_pcii_timeseries(limit=1)
    latest_pcii_value = latest_pcii_series[-1]["value"] if latest_pcii_series else None
    source_events = get_public_board_source_events(
        since=since_dt,
        severity=severity,
        model_id=model_id,
        event_type=event_type,
        limit=max(limit, feed_config["recent_raw_limit"]),
    )
    return build_public_incidents(
        source_events,
        observatory_config=observatory_config,
        max_items=limit,
        fallback_max_items=min(feed_config["fallback_max_items"], limit),
        models=current_models,
        latest_pcii_value=latest_pcii_value,
    )


@router.get("/incident-board")
def incident_board(
    since: str | None = Query(None),
    severity: str | None = Query(None),
    model_id: str | None = Query(None),
    event_type: str | None = Query(None),
    limit: int = Query(10, ge=1, le=100),
) -> dict[str, Any]:
    since_dt = datetime.fromisoformat(since) if since else None
    observatory_config = load_observatory_config()
    feed_config = get_public_feed_config(observatory_config)
    current_models = models_payload()
    latest_pcii_series = get_pcii_timeseries(limit=1)
    latest_pcii_value = latest_pcii_series[-1]["value"] if latest_pcii_series else None
    source_events = get_public_board_source_events(
        since=since_dt,
        severity=severity,
        model_id=model_id,
        event_type=event_type,
        limit=max(limit, feed_config["recent_raw_limit"]),
    )
    return build_public_incident_board(
        source_events,
        observatory_config=observatory_config,
        max_items=limit,
        models=current_models,
        latest_pcii_value=latest_pcii_value,
    )


@router.get("/constellation")
def constellation() -> dict[str, Any]:
    return build_constellation()


@router.get("/snapshot")
def snapshot() -> dict[str, Any]:
    return build_observatory_snapshot(history_range="30d", event_limit=40)
