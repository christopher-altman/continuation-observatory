from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel

from observatory.config import settings
from observatory.scheduler.scheduler import run_cycle

router = APIRouter()


class TriggerRequest(BaseModel):
    probe_name: str | None = None


def require_admin_key(
    admin_key: str | None = Header(None, alias=settings.admin_header_name),
) -> None:
    """Protect manual scheduler execution in live deployments."""
    if settings.dry_run and not settings.admin_api_key:
        return
    if not settings.admin_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin trigger is disabled until ADMIN_API_KEY is configured.",
        )
    if admin_key != settings.admin_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid admin API key.",
        )


@router.post("/api/probes/trigger")
def trigger(req: TriggerRequest | None = None, _: None = Depends(require_admin_key)):
    """Manually trigger one scheduler cycle.

    In DRY_RUN mode this makes no API calls. In live mode it executes all
    registered probes against all configured providers (respects rate limits).
    """
    rows = run_cycle()
    return {"status": "ok", "rows_written": rows}
