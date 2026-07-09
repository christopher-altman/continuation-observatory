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


@router.api_route("/latest.json", methods=["GET", "HEAD"])
def latest_json():
    return _json_response(build_latest_export())


@router.api_route("/timeseries.json", methods=["GET", "HEAD"])
def timeseries_json():
    return _json_response(build_timeseries_export())


@router.api_route("/falsification.json", methods=["GET", "HEAD"])
def falsification_json():
    return _json_response(build_falsification_export())


@router.api_route("/models.json", methods=["GET", "HEAD"])
def models_json():
    return _json_response(build_models_export())


@router.api_route("/observatory_snapshot.json", methods=["GET", "HEAD"])
def observatory_snapshot_json():
    return _json_response(build_live_observatory_snapshot_export())


@router.api_route("/exports/all_metrics.json", methods=["GET", "HEAD"])
def all_metrics_json():
    return _json_response(build_all_metrics_rows())


@router.api_route("/exports/all_metrics.csv", methods=["GET", "HEAD"])
def all_metrics_csv():
    return Response(
        content=build_all_metrics_csv(),
        media_type="text/csv; charset=utf-8",
        headers=NO_STORE_HEADERS,
    )
