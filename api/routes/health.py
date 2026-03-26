from __future__ import annotations

from fastapi import APIRouter

from observatory.storage.sqlite_backend import SessionLocal, ProbeRun, count_rows

router = APIRouter()


@router.get("/api/health")
def health():
    try:
        db_rows = count_rows("probe_runs")
        with SessionLocal() as session:
            last = session.query(ProbeRun).order_by(ProbeRun.timestamp.desc()).first()
            last_run = last.timestamp.isoformat() if last else None
    except Exception:
        db_rows = 0
        last_run = None
    return {"status": "ok", "db_rows": db_rows, "last_run": last_run}
