from __future__ import annotations

from fastapi import APIRouter

from observatory.storage.sqlite_backend import FalsificationAlert, MetricResult, SessionLocal

router = APIRouter()


@router.get("/api/falsification/status")
def status():
    with SessionLocal() as session:
        rows = (
            session.query(MetricResult)
            .filter(MetricResult.metric_name.like("delta_gap_d%"))
            .all()
        )

    high_d_deltas: list[float] = []
    for r in rows:
        try:
            d = int(r.metric_name.replace("delta_gap_d", ""))
        except ValueError:
            continue
        if d > 100:
            high_d_deltas.append(r.metric_value)

    if not high_d_deltas:
        color = "green"
        reason = "Insufficient data — no d>100 dimensionality sweeps completed yet."
    elif all(v < 0.05 for v in high_d_deltas):
        color = "red"
        reason = (
            f"FALSIFICATION ALERT: Δ < 0.05 at all d>100 points "
            f"({len(high_d_deltas)} measurements)."
        )
    elif any(v < 0.10 for v in high_d_deltas):
        color = "yellow"
        reason = (
            f"WARNING: Δ < 0.10 at one or more d>100 values "
            f"({len(high_d_deltas)} measurements)."
        )
    else:
        color = "green"
        reason = (
            f"Δ > 0.10 at all d>100 values ({len(high_d_deltas)} measurements). "
            "No collapse detected."
        )

    return {
        "status": color,
        "reason": reason,
        "n_high_d_points": len(high_d_deltas),
    }


@router.get("/api/falsification/alerts")
def alerts():
    with SessionLocal() as session:
        rows = (
            session.query(FalsificationAlert)
            .order_by(FalsificationAlert.timestamp.desc())
            .limit(50)
            .all()
        )

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
