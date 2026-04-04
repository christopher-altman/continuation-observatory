from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
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


LIVE_PAGE_PATHS = {
    "home": "/",
    "observatory": "/observatory",
    "timeseries": "/timeseries",
    "models": "/models",
    "methodology": "/methodology",
    "research": "/research/",
    "context": "/context/",
    "data": "/data",
    "falsification": "/falsification",
    "model_updates": "/model-updates",
    "ucip": "/ucip/",
    "ucip_paper": "/ucip/paper/",
    "ucip_patent": "/ucip/patent/",
    "ucip_code": "/ucip/code/",
    "links": "/links/",
}

LIVE_PAGE_TITLES = {
    "home": "Continuation Observatory",
    "observatory": "Observatory",
    "timeseries": "Time Series",
    "models": "Models",
    "methodology": "Methodology",
    "research": "Research",
    "context": "Contemporary Context",
    "data": "Data",
    "falsification": "Falsification Analysis",
    "model_updates": "Model Updates",
    "ucip": "UCIP Explainer",
    "ucip_paper": "UCIP Paper Overview",
    "ucip_patent": "UCIP Patent Status",
    "ucip_code": "UCIP Reproducibility Hub",
    "links": "LINKS",
}


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
        {"overall_status": "collecting", "status_text": "COLLECTING. The observatory is live, and this panel is awaiting sufficient provider-backed dimensionality-sweep history to evaluate Δ(d).", "models": []},
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
        "page_title": LIVE_PAGE_TITLES.get(page_name, "Continuation Observatory"),
        "home_href": "/",
        "route_home": "/",
        "route_observatory": "/observatory",
        "route_timeseries": "/timeseries",
        "route_falsification": "/falsification",
        "route_models": "/models",
        "route_methodology": "/methodology",
        "route_research": "/research/",
        "route_context": "/context/",
        "route_data": "/data",
        "route_ucip": "/ucip/",
        "route_ucip_paper": "/ucip/paper/",
        "route_ucip_patent": "/ucip/patent/",
        "route_ucip_code": "/ucip/code/",
        "route_links": "/links/",
        "asset_prefix": "/static",
        "asset_version": _latest_static_asset_version(),
        "models_data_url": "/api/observatory/models",
        "figures_prefix": "/static/figures/",
        "marquee_models": LIVE_MARQUEE_MODELS,
        "home_signal_score": 0.0,
        "github_href": "https://github.com/christopher-altman/persistence-signal-detector",
        "paper_href": "https://arxiv.org/abs/2603.11382",
        "patent_screenshot_href": "/static/img/USPTO-Patent-Submission.jpg",
        "contact_href": "mailto:x@christopheraltman.com",
        "site_url": "https://continuationobservatory.org",
        "page_path": LIVE_PAGE_PATHS.get(page_name, "/"),
        "observatory_mode": "live",
        "observatory_snapshot_url": "/api/observatory/snapshot",
        "observatory_socket_enabled": True,
    }
    context.update(_bundle_context())
    if not context.get("marquee_models"):
        context["marquee_models"] = LIVE_MARQUEE_MODELS
    return context


def render_page(request: Request, template_name: str, page_name: str):
    response = templates.TemplateResponse(request, template_name, page_context(page_name))
    response.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


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
    return render_page(request, "index.html", "home")


@app.get("/observatory")
def observatory_view(request: Request):
    return render_page(request, "observatory.html", "observatory")


@app.get("/timeseries")
def timeseries_view(request: Request):
    return render_page(request, "timeseries.html", "timeseries")


@app.get("/models")
def models_view(request: Request):
    return render_page(request, "models.html", "models")


@app.get("/methodology")
def methodology_view(request: Request):
    return render_page(request, "methodology.html", "methodology")


@app.get("/research/")
def research_view(request: Request):
    return render_page(request, "research.html", "research")


@app.get("/context/")
def context_view(request: Request):
    return render_page(request, "context.html", "context")


@app.get("/manifesto")
@app.get("/manifesto/")
def manifesto_redirect() -> RedirectResponse:
    response = RedirectResponse(url="/research/", status_code=307)
    response.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.get("/data")
def data_view(request: Request):
    return render_page(request, "data.html", "data")


@app.get("/model-updates")
def model_updates_view(request: Request):
    return render_page(request, "model_updates.html", "model_updates")


@app.get("/falsification")
def falsification_view(request: Request):
    return render_page(request, "falsification.html", "falsification")


@app.get("/ucip/")
def ucip_view(request: Request):
    return render_page(request, "ucip/index.html", "ucip")


@app.get("/ucip/paper/")
def ucip_paper_view(request: Request):
    return render_page(request, "ucip/paper.html", "ucip_paper")


@app.get("/ucip/patent/")
def ucip_patent_view(request: Request):
    return render_page(request, "ucip/patent.html", "ucip_patent")


@app.get("/ucip/code/")
def ucip_code_view(request: Request):
    return render_page(request, "ucip/code.html", "ucip_code")


@app.get("/links/")
def links_view(request: Request):
    return render_page(request, "links.html", "links")
