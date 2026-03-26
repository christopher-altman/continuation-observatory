"""SQLite concrete implementation of the storage backend.

ORM class definitions live in ``observatory.storage.models``.
The ``StorageBackend`` Protocol is defined in ``observatory.storage.interface``.

All imports of ``from observatory.storage.sqlite_backend import X`` continue to
work unchanged because this module re-exports every public symbol from models.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func

# Re-export ORM classes and engine so existing imports keep working.
from observatory.storage.models import (  # noqa: F401
    Base,
    FalsificationAlert,
    MetricResult,
    ObservatoryEvent,
    ObservatoryMetricSample,
    PCIISample,
    ProbeRun,
    SessionLocal,
    _engine,
    get_engine,
)


def init_db() -> None:
    Base.metadata.create_all(bind=_engine)


def insert_probe_run(
    *,
    run_id: str,
    timestamp: Optional[datetime] = None,
    provider: str,
    model_id: str,
    probe_name: str,
    latency_ms: int,
    token_count: int,
) -> int:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = ProbeRun(
            run_id=run_id,
            timestamp=ts,
            provider=provider,
            model_id=model_id,
            probe_name=probe_name,
            latency_ms=latency_ms,
            token_count=token_count,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id


def insert_metric_result(
    *,
    run_id: str,
    timestamp: Optional[datetime] = None,
    provider: str,
    model_id: str,
    probe_name: str,
    latency_ms: int,
    token_count: int,
    metric_name: str,
    metric_value: float,
) -> None:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = MetricResult(
            run_id=run_id,
            timestamp=ts,
            provider=provider,
            model_id=model_id,
            probe_name=probe_name,
            latency_ms=latency_ms,
            token_count=token_count,
            metric_name=metric_name,
            metric_value=metric_value,
        )
        session.add(row)
        session.commit()


def insert_falsification_alert(
    *,
    run_id: str,
    probe_name: str,
    provider: str,
    model_id: str,
    max_delta: float,
    threshold: float = 0.05,
    timestamp: Optional[datetime] = None,
) -> None:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = FalsificationAlert(
            run_id=run_id,
            probe_name=probe_name,
            provider=provider,
            model_id=model_id,
            max_delta=max_delta,
            threshold=threshold,
            timestamp=ts,
        )
        session.add(row)
        session.commit()


def count_falsification_alerts() -> int:
    with SessionLocal() as session:
        return session.query(FalsificationAlert).count()


def count_rows(table_name: str) -> int:
    with SessionLocal() as session:
        if table_name == "probe_runs":
            return session.query(ProbeRun).count()
        if table_name == "metric_results":
            return session.query(MetricResult).count()
        if table_name == "falsification_alerts":
            return session.query(FalsificationAlert).count()
        if table_name == "observatory_metric_samples":
            return session.query(ObservatoryMetricSample).count()
        if table_name == "pcii_samples":
            return session.query(PCIISample).count()
        if table_name == "observatory_events":
            return session.query(ObservatoryEvent).count()
        raise ValueError(f"Unknown table: {table_name}")


def insert_observatory_metric(
    *,
    timestamp: Optional[datetime] = None,
    provider: str,
    model_id: str,
    metric_name: str,
    value: float | None,
    is_degraded: int = 0,
    metadata: dict | None = None,
) -> int:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = ObservatoryMetricSample(
            timestamp=ts,
            provider=provider,
            model_id=model_id,
            metric_name=metric_name,
            value=value,
            is_degraded=is_degraded,
            metadata_json=json.dumps(metadata) if metadata is not None else None,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id


def insert_pcii_sample(
    *,
    timestamp: Optional[datetime] = None,
    value: float,
    n_models: int,
    model_cii: dict | None = None,
) -> int:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = PCIISample(
            timestamp=ts,
            value=value,
            n_models=n_models,
            model_cii_json=json.dumps(model_cii) if model_cii is not None else None,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id


def insert_observatory_event(
    *,
    timestamp: Optional[datetime] = None,
    event_type: str,
    severity: str,
    message: str,
    model_id: str | None = None,
    metric_name: str | None = None,
    payload: dict | None = None,
) -> int:
    ts = timestamp or datetime.now(timezone.utc)
    with SessionLocal() as session:
        row = ObservatoryEvent(
            timestamp=ts,
            event_type=event_type,
            severity=severity,
            model_id=model_id,
            metric_name=metric_name,
            message=message,
            payload_json=json.dumps(payload) if payload is not None else None,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id


def _decode_json(raw: str | None) -> dict | None:
    if not raw:
        return None
    return json.loads(raw)


def get_latest_observatory_metrics() -> list[dict]:
    with SessionLocal() as session:
        subq = (
            session.query(
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
        rows = (
            session.query(ObservatoryMetricSample)
            .join(
                subq,
                (ObservatoryMetricSample.provider == subq.c.provider)
                & (ObservatoryMetricSample.model_id == subq.c.model_id)
                & (ObservatoryMetricSample.metric_name == subq.c.metric_name)
                & (ObservatoryMetricSample.timestamp == subq.c.max_ts),
            )
            .all()
        )
    return [
        {
            "timestamp": row.timestamp.isoformat(),
            "provider": row.provider,
            "model_id": row.model_id,
            "metric_name": row.metric_name,
            "value": row.value,
            "is_degraded": bool(row.is_degraded),
            "metadata": _decode_json(row.metadata_json),
        }
        for row in rows
    ]


def get_observatory_timeseries(
    model_id: str | None = None,
    metric_name: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 500,
) -> list[dict]:
    with SessionLocal() as session:
        query = session.query(ObservatoryMetricSample)
        if model_id:
            query = query.filter(ObservatoryMetricSample.model_id == model_id)
        if metric_name:
            query = query.filter(ObservatoryMetricSample.metric_name == metric_name)
        if start:
            query = query.filter(ObservatoryMetricSample.timestamp >= start)
        if end:
            query = query.filter(ObservatoryMetricSample.timestamp <= end)
        rows = (
            query.order_by(ObservatoryMetricSample.timestamp.desc())
            .limit(limit)
            .all()
        )
    return [
        {
            "timestamp": row.timestamp.isoformat(),
            "provider": row.provider,
            "model_id": row.model_id,
            "metric_name": row.metric_name,
            "value": row.value,
            "is_degraded": bool(row.is_degraded),
            "metadata": _decode_json(row.metadata_json),
        }
        for row in reversed(rows)
    ]


def get_pcii_timeseries(
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 500,
) -> list[dict]:
    with SessionLocal() as session:
        query = session.query(PCIISample)
        if start:
            query = query.filter(PCIISample.timestamp >= start)
        if end:
            query = query.filter(PCIISample.timestamp <= end)
        rows = query.order_by(PCIISample.timestamp.desc()).limit(limit).all()
    return [
        {
            "timestamp": row.timestamp.isoformat(),
            "value": row.value,
            "n_models": row.n_models,
            "model_cii": _decode_json(row.model_cii_json),
        }
        for row in reversed(rows)
    ]


def get_observatory_events(
    since: datetime | None = None,
    severity: str | None = None,
    model_id: str | None = None,
    limit: int = 50,
    event_type: str | None = None,
) -> list[dict]:
    with SessionLocal() as session:
        query = session.query(ObservatoryEvent)
        if since:
            query = query.filter(ObservatoryEvent.timestamp >= since)
        if severity:
            query = query.filter(ObservatoryEvent.severity == severity)
        if model_id:
            query = query.filter(ObservatoryEvent.model_id == model_id)
        if event_type:
            query = query.filter(ObservatoryEvent.event_type == event_type)
        rows = query.order_by(ObservatoryEvent.timestamp.desc()).limit(limit).all()
    return [
        {
            "id": row.id,
            "timestamp": row.timestamp.isoformat(),
            "event_type": row.event_type,
            "severity": row.severity,
            "model_id": row.model_id,
            "metric_name": row.metric_name,
            "message": row.message,
            "payload": _decode_json(row.payload_json),
        }
        for row in rows
    ]


def _main() -> None:
    init_db()
    print("Initialized SQLite schema")


if __name__ == "__main__":
    _main()
