from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from observatory.live_exports import (
    build_all_metrics_csv,
    build_all_metrics_rows,
    build_falsification_export,
    build_latest_export,
    build_live_observatory_snapshot_export,
    build_models_export,
    build_timeseries_export,
)

router = APIRouter(prefix="/static/data", tags=["data-exports"])

NO_STORE_HEADERS = {
    "Cache-Control": "no-store, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


def _json_response(payload):
    return JSONResponse(content=payload, headers=NO_STORE_HEADERS)


@router.get("/latest.json")
def latest_json():
    return _json_response(build_latest_export())


@router.get("/timeseries.json")
def timeseries_json():
    return _json_response(build_timeseries_export())


@router.get("/falsification.json")
def falsification_json():
    return _json_response(build_falsification_export())


@router.get("/models.json")
def models_json():
    return _json_response(build_models_export())


@router.get("/observatory_snapshot.json")
def observatory_snapshot_json():
    return _json_response(build_live_observatory_snapshot_export())


@router.get("/exports/all_metrics.json")
def all_metrics_json():
    return _json_response(build_all_metrics_rows())


@router.get("/exports/all_metrics.csv")
def all_metrics_csv():
    return Response(
        content=build_all_metrics_csv(),
        media_type="text/csv; charset=utf-8",
        headers=NO_STORE_HEADERS,
    )
