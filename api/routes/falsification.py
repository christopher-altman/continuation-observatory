"""Public operational status for the falsification monitor."""
from __future__ import annotations

from fastapi import APIRouter

from observatory.live_exports import build_falsification_export

router = APIRouter()


@router.get("/api/falsification/status")
def status():
    export = build_falsification_export()
    return {
        "status": "nominal",
        "reason": export["status_text"],
        "verdict_status": export["verdict_status"],
        "n_window_points": export["n_window_points"],
        "n_models": export["n_models"],
        "thresholds": export["thresholds"],
    }


@router.get("/api/falsification/alerts")
def alerts():
    """Return the current operational alert surface."""
    return {
        "status": "nominal",
        "alerts": [],
        "reason": "No active operational alerts.",
    }
