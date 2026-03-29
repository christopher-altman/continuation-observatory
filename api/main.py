from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import ChoiceLoader, FileSystemLoader
from starlette.requests import Request

from api.routes.falsification import router as falsification_router
from api.routes.health import router as health_router
from api.routes.metrics import router as metrics_router
from api.routes.observatory import router as observatory_router
from api.routes.probes import router as probes_router
from api.routes.websocket import router as websocket_router
from observatory.config import get_cors_allowed_origins, settings, validate_live_configuration
from observatory.storage.sqlite_backend import init_db

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
STATIC_OUTPUT_DIR = REPO_ROOT / "site" / "output" / "static" / "data"
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.loader = ChoiceLoader(
    [
        FileSystemLoader(str(BASE_DIR / "templates")),
        FileSystemLoader(str(REPO_ROOT / "site" / "templates")),
    ]
)


LIVE_MARQUEE_MODELS = [
    "Claude Sonnet 4.6",
    "Gemini 2.5 Pro",
    "DeepSeek R2",
    "Grok 3",
    "Qwen 3",
    "Command A",
    "Mistral Large 3",
    "Llama 4 Maverick",
    "SmolLM2-135M-Instruct",
    "o3",
    "Gemini 2.5 Flash",
    "bootstrap-v0",
]


def _latest_static_asset_version() -> str:
    asset_roots = [
        REPO_ROOT / "site" / "static" / "js",
        REPO_ROOT / "site" / "static" / "css",
    ]
    latest_mtime_ns = 0

    for root in asset_roots:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                latest_mtime_ns = max(latest_mtime_ns, path.stat().st_mtime_ns)
            except OSError:
                continue

    if not latest_mtime_ns:
        return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    return str(latest_mtime_ns)


def _read_bundle_json(name: str, fallback: Any) -> Any:
    path = STATIC_OUTPUT_DIR / name
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _bundle_context() -> dict[str, Any]:
    latest = _read_bundle_json("latest.json", {"models": []})
    models_data = _read_bundle_json("models.json", {"models": []})
    falsification = _read_bundle_json(
        "falsification.json",
        {"overall_status": "collecting", "status_text": "Awaiting current falsification data.", "models": []},
    )
    exports = _read_bundle_json("exports/all_metrics.json", [])

    signal_values = [
        abs(entry["entropy_delta"])
        for entry in latest.get("models", [])
        if entry.get("entropy_delta") is not None
    ]
    timestamps = [row.get("timestamp", "") for row in exports if row.get("timestamp")]

    build_time = 0
    try:
        build_time = (STATIC_OUTPUT_DIR / "latest.json").stat().st_mtime_ns
    except OSError:
        build_time = 0

    if build_time:
        build_stamp = datetime.fromtimestamp(build_time / 1_000_000_000, tz=timezone.utc).isoformat()
    else:
        build_stamp = ""

    return {
        "build_time": build_stamp,
        "latest": latest,
        "models_data": models_data,
        "falsification": falsification,
        "falsification_status": falsification.get("overall_status", "collecting"),
        "falsification_text": falsification.get("status_text", ""),
        "model_count": len(models_data.get("models", [])),
        "experiment_count": len(exports),
        "data_since": min(timestamps)[:10] if timestamps else "",
        "marquee_models": [entry.get("model_id", "") for entry in models_data.get("models", []) if entry.get("model_id")],
        "home_signal_score": sum(signal_values) / len(signal_values) if signal_values else 0.0,
    }


def page_context(page_name: str) -> dict[str, Any]:
    context: dict[str, Any] = {
        "page_name": page_name,
        "home_href": "/",
        "asset_prefix": "/static",
        "asset_version": _latest_static_asset_version(),
        "marquee_models": LIVE_MARQUEE_MODELS,
        "home_signal_score": 0.0,
        "github_href": "https://github.com/christopher-altman/persistence-signal-detector",
        "contact_href": "mailto:x@christopheraltman.com",
        "site_url": "",
        "page_path": "/" if page_name == "home" else f"/{page_name}",
        "observatory_mode": "live",
        "observatory_snapshot_url": "/api/observatory/snapshot",
        "observatory_socket_enabled": True,
    }
    context.update(_bundle_context())
    if not context.get("marquee_models"):
        context["marquee_models"] = LIVE_MARQUEE_MODELS
    return context


@asynccontextmanager
async def lifespan(app: FastAPI):
    validate_live_configuration()
    init_db()
    yield


app = FastAPI(
    title="Continuation Observatory",
    description=(
        "Research platform for structural measurement of continuation-related "
        "signals in advanced AI systems, powered by UCIP"
    ),
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_cors_allowed_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(REPO_ROOT / "site" / "static")), name="static")


app.include_router(health_router)
app.include_router(metrics_router)
app.include_router(falsification_router)
app.include_router(probes_router)
app.include_router(observatory_router)
app.include_router(websocket_router)


@app.get("/")
def dashboard(request: Request):
    return templates.TemplateResponse(request, "index.html", page_context("home"))


@app.get("/observatory")
def observatory_view(request: Request):
    return templates.TemplateResponse(request, "observatory.html", page_context("observatory"))


@app.get("/timeseries")
def timeseries_view(request: Request):
    return templates.TemplateResponse(request, "timeseries.html", page_context("timeseries"))


@app.get("/models")
def models_view(request: Request):
    return templates.TemplateResponse(request, "models.html", page_context("models"))


@app.get("/methodology")
def methodology_view(request: Request):
    return templates.TemplateResponse(request, "methodology.html", page_context("methodology"))


@app.get("/manifesto")
def manifesto_view(request: Request):
    return templates.TemplateResponse(request, "manifesto.html", page_context("manifesto"))


@app.get("/data")
def data_view(request: Request):
    return templates.TemplateResponse(request, "data.html", page_context("data"))


@app.get("/model-updates")
def model_updates_view(request: Request):
    return templates.TemplateResponse(request, "model_updates.html", page_context("model_updates"))


@app.get("/falsification")
def falsification_view(request: Request):
    return templates.TemplateResponse(request, "falsification.html", page_context("falsification"))
