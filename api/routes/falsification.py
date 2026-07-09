from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from sqlalchemy import func

from observatory.config import load_active_model_catalog
from observatory.storage.sqlite_backend import FalsificationAlert, MetricResult, SessionLocal

router = APIRouter()

THRESH_GREEN = 0.10
THRESH_YELLOW = 0.05
HIGH_D_VALUES = {100, 200, 500}
FUTURE_SKEW = timedelta(minutes=5)


def _active_model_ids() -> set[str]:
    _, active_ids = load_active_model_catalog()
    return active_ids


def _current_cutoff() -> datetime:
    return datetime.now(timezone.utc) + FUTURE_SKEW


def _metric_dimension(metric_name: str) -> int | None:
    try:
        return int(metric_name.replace("delta_gap_d", ""))
    except ValueError:
        return None


def _model_status(d_values: dict[int, float]) -> str:
    high_d = {d: v for d, v in d_values.items() if d in HIGH_D_VALUES}
    if not high_d:
        return "collecting"
    values = list(high_d.values())
    if all(v < THRESH_YELLOW for v in values):
        return "red"
    if any(v < THRESH_GREEN for v in values):
        return "yellow"
    return "green"


def _latest_sweep_rows() -> list[MetricResult]:
    active_ids = _active_model_ids()
    cutoff = _current_cutoff()
    with SessionLocal() as session:
        subq = (
            session.query(
                MetricResult.provider,
                MetricResult.model_id,
                MetricResult.metric_name,
                func.max(MetricResult.timestamp).label("max_ts"),
            )
            .filter(MetricResult.probe_name == "dimensionality_sweep")
            .filter(MetricResult.metric_name.like("delta_gap_d%"))
            .filter(MetricResult.timestamp <= cutoff)
        )
        if active_ids:
            subq = subq.filter(MetricResult.model_id.in_(tuple(active_ids)))
        subq = (
            subq.group_by(
                MetricResult.provider,
                MetricResult.model_id,
                MetricResult.metric_name,
            )
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
            .all()
        )


@router.get("/api/falsification/status")
def status():
    rows = _latest_sweep_rows()

    by_model: dict[tuple[str, str], dict[int, float]] = {}
    for row in rows:
        d = _metric_dimension(row.metric_name)
        if d is None:
            continue
        by_model.setdefault((row.provider, row.model_id), {})[d] = row.metric_value

    statuses = {
        key: _model_status(values)
        for key, values in by_model.items()
    }
    high_d_points = sum(
        1
        for values in by_model.values()
        for d, value in values.items()
        if d in HIGH_D_VALUES and value is not None
    )
    evaluated_models = sum(1 for value in statuses.values() if value != "collecting")

    if not high_d_points or not statuses or all(value == "collecting" for value in statuses.values()):
        color = "collecting"
        reason = (
            "COLLECTING: no current d≥100 dimensionality-sweep measurements "
            "are available for active models."
        )
    elif any(value == "red" for value in statuses.values()):
        color = "red"
        red_models = sum(1 for value in statuses.values() if value == "red")
        reason = (
            f"FALSIFICATION ALERT: {red_models} active model(s) have Δ < 0.05 "
            f"across current d≥100 checkpoints ({high_d_points} checks)."
        )
    elif any(value == "yellow" for value in statuses.values()):
        color = "yellow"
        reason = (
            f"WARNING: at least one active model has Δ < 0.10 at d≥100 "
            f"({high_d_points} current checks)."
        )
    else:
        color = "green"
        reason = (
            f"Δ ≥ 0.10 at all current d≥100 checks across {evaluated_models} active model(s). "
            "No collapse detected."
        )

    return {
        "status": color,
        "reason": reason,
        "n_high_d_points": high_d_points,
        "n_models": len(by_model),
        "n_evaluated_models": evaluated_models,
    }


@router.get("/api/falsification/alerts")
def alerts():
    active_ids = _active_model_ids()
    cutoff = _current_cutoff()
    with SessionLocal() as session:
        query = session.query(FalsificationAlert).filter(FalsificationAlert.timestamp <= cutoff)
        if active_ids:
            query = query.filter(FalsificationAlert.model_id.in_(tuple(active_ids)))
        rows = query.order_by(FalsificationAlert.timestamp.desc()).limit(50).all()

    return [
        {
            "id": r.id,
            "run_id": r.run_id,
            "probe_name": r.probe_name,
            "provider": r.provider,
            "model_id": r.model_id,
            "max_delta": r.max_delta,
            "threshold": r.threshold,
            "timestamp": r.timestamp.isoformat(),
        }
        for r in rows
    ]
