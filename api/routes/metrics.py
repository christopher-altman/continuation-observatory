from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query
from sqlalchemy import func

from observatory.storage.sqlite_backend import MetricResult, SessionLocal

router = APIRouter()


@router.get("/api/metrics/timeseries")
def timeseries(
    metric: str = Query(..., description="Metric name, e.g. 'entropy_delta'"),
    provider: Optional[str] = Query(None),
    model_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="ISO-8601 datetime"),
    end: Optional[str] = Query(None, description="ISO-8601 datetime"),
):
    with SessionLocal() as session:
        q = session.query(MetricResult).filter(MetricResult.metric_name == metric)
        if provider:
            q = q.filter(MetricResult.provider == provider)
        if model_id:
            q = q.filter(MetricResult.model_id == model_id)
        if start:
            q = q.filter(MetricResult.timestamp >= datetime.fromisoformat(start))
        if end:
            q = q.filter(MetricResult.timestamp <= datetime.fromisoformat(end))
        rows = q.order_by(MetricResult.timestamp.asc()).limit(2000).all()

    return [
        {
            "timestamp": r.timestamp.isoformat(),
            "provider": r.provider,
            "model_id": r.model_id,
            "probe_name": r.probe_name,
            "metric_name": r.metric_name,
            "metric_value": r.metric_value,
        }
        for r in rows
    ]


@router.get("/api/metrics/latest")
def latest():
    with SessionLocal() as session:
        subq = (
            session.query(
                MetricResult.provider,
                MetricResult.model_id,
                MetricResult.metric_name,
                func.max(MetricResult.timestamp).label("max_ts"),
            )
            .group_by(
                MetricResult.provider, MetricResult.model_id, MetricResult.metric_name
            )
            .subquery()
        )
        rows = (
            session.query(MetricResult)
            .join(
                subq,
                (MetricResult.provider == subq.c.provider)
                & (MetricResult.model_id == subq.c.model_id)
                & (MetricResult.metric_name == subq.c.metric_name)
                & (MetricResult.timestamp == subq.c.max_ts),
            )
            .all()
        )

    return [
        {
            "provider": r.provider,
            "model_id": r.model_id,
            "probe_name": r.probe_name,
            "metric_name": r.metric_name,
            "metric_value": r.metric_value,
            "timestamp": r.timestamp.isoformat(),
        }
        for r in rows
    ]
