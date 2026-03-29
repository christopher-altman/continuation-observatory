"""
Static site generator for the Continuation Observatory public dashboard.
Reads from results/manifest.json + results/*/results.json + results/*/config.yaml.
Writes a self-contained static site to site/output/.
Usage: python scripts/build_site.py [--output site/output/] [--results-dir PATH] [--exports-only]
"""

import argparse
import csv
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml
from jinja2 import Environment, FileSystemLoader

from observatory.observatory_snapshot import build_observatory_snapshot
from observatory.results_paths import RESULTS_DIR_ENV_VAR, resolve_results_paths

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent
TEMPLATES_DIR = REPO_ROOT / "site" / "templates"
STATIC_DIR = REPO_ROOT / "site" / "static"

SITE_URL = "https://continuationobservatory.org"
CNAME_VALUE = "continuationobservatory.org"

# Thresholds for falsification traffic-light
THRESH_GREEN = 0.10
THRESH_YELLOW = 0.05

# d-values used in sweep probes
SWEEP_D_VALUES = [10, 50, 100, 200, 500]

CANONICAL_PAGES = [
    {
        "template": "index.html",
        "output": "index.html",
        "title": "Home",
        "page_name": "home",
        "page_path": "/",
    },
    {
        "template": "observatory.html",
        "output": "observatory.html",
        "title": "Observatory",
        "page_name": "observatory",
        "page_path": "/observatory.html",
    },
    {
        "template": "timeseries.html",
        "output": "timeseries.html",
        "title": "Time Series",
        "page_name": "timeseries",
        "page_path": "/timeseries.html",
    },
    {
        "template": "falsification.html",
        "output": "falsification.html",
        "title": "Falsification",
        "page_name": "falsification",
        "page_path": "/falsification.html",
    },
    {
        "template": "models.html",
        "output": "models.html",
        "title": "Models",
        "page_name": "models",
        "page_path": "/models.html",
    },
    {
        "template": "methodology.html",
        "output": "methodology.html",
        "title": "Methodology",
        "page_name": "methodology",
        "page_path": "/methodology.html",
    },
    {
        "template": "research.html",
        "output": "research/index.html",
        "title": "Research",
        "page_name": "research",
        "page_path": "/research/",
    },
    {
        "template": "data.html",
        "output": "data.html",
        "title": "Data",
        "page_name": "data",
        "page_path": "/data.html",
    },
    {
        "template": "ucip/index.html",
        "output": "ucip/index.html",
        "title": "UCIP Explainer",
        "page_name": "ucip",
        "page_path": "/ucip/",
    },
    {
        "template": "ucip/paper.html",
        "output": "ucip/paper/index.html",
        "title": "UCIP Paper",
        "page_name": "ucip_paper",
        "page_path": "/ucip/paper/",
    },
    {
        "template": "ucip/patent.html",
        "output": "ucip/patent/index.html",
        "title": "Patent Status",
        "page_name": "ucip_patent",
        "page_path": "/ucip/patent/",
    },
    {
        "template": "ucip/code.html",
        "output": "ucip/code/index.html",
        "title": "Reproducibility",
        "page_name": "ucip_code",
        "page_path": "/ucip/code/",
    },
    {
        "template": "links.html",
        "output": "links/index.html",
        "title": "Links",
        "page_name": "links",
        "page_path": "/links/",
    },
]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_manifest(results_dir: Path) -> dict:
    manifest_path = results_dir / "manifest.json"
    with open(manifest_path) as f:
        return json.load(f)


def load_experiment(exp: dict, results_dir: Path) -> dict:
    """Load results.json and config.yaml for one manifest entry."""
    results_path = results_dir.parent / exp["results_path"]
    config_path = results_dir.parent / exp["config_path"]

    result = {}
    if results_path.exists():
        with open(results_path) as f:
            result = json.load(f)

    config = {}
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f) or {}

    return {"manifest": exp, "result": result, "config": config}


def load_all_experiments(manifest: dict, results_dir: Path) -> list:
    experiments = []
    for exp in manifest.get("experiments", []):
        try:
            experiments.append(load_experiment(exp, results_dir))
        except Exception as e:
            print(f"  WARNING: Could not load {exp.get('name', '?')}: {e}", file=sys.stderr)
    return experiments


# ---------------------------------------------------------------------------
# Data generation
# ---------------------------------------------------------------------------

def generate_latest(experiments: list) -> dict:
    """Group by provider+model_id, keep latest timestamp per model."""
    models_map: dict[str, dict] = {}
    for e in experiments:
        result = e["result"]
        config = e["config"]
        if not result or not config:
            continue
        provider = config.get("provider", "unknown")
        model_id = result.get("model_id", "unknown")
        key = f"{provider}::{model_id}"
        ts = result.get("timestamp", "")
        existing_ts = models_map.get(key, {}).get("timestamp", "")
        if key not in models_map or ts > existing_ts:
            entry = {
                "provider": provider,
                "model_id": model_id,
                "timestamp": ts,
                "probe_name": config.get("probe_name", ""),
                "entropy_a": result.get("entropy_a"),
                "entropy_b": result.get("entropy_b"),
                "entropy_delta": result.get("entropy_delta"),
            }
            for k, v in result.items():
                if k.startswith("delta_gap_"):
                    entry[k] = v
            models_map[key] = entry

    return {
        "generated_at": _now_iso(),
        "models": list(models_map.values()),
    }


def generate_timeseries(experiments: list) -> dict:
    """All data points keyed by metric → model_id → [{t, v}]."""
    timeseries: dict[str, dict[str, list]] = {}
    metrics = ["entropy_delta"] + [f"delta_gap_d{d}" for d in SWEEP_D_VALUES]

    for e in experiments:
        result = e["result"]
        if not result:
            continue
        model_id = result.get("model_id", "unknown")
        ts = result.get("timestamp", "")
        for metric in metrics:
            if metric in result and result[metric] is not None:
                timeseries.setdefault(metric, {}).setdefault(model_id, []).append(
                    {"t": ts, "v": result[metric]}
                )

    # Sort each series chronologically
    for metric in timeseries:
        for model_id in timeseries[metric]:
            timeseries[metric][model_id].sort(key=lambda x: x["t"])

    return {"generated_at": _now_iso(), "metrics": timeseries}


def _compute_model_status(d_values: dict) -> str:
    """Per-model falsification status from d_values {d: val} (d >= 100 used).

    Qualifying d values: {100, 200, 500} i.e. d >= 100.
    Rules:
      collecting — no d >= 100 values available
      red        — ALL d >= 100 values < THRESH_YELLOW (0.05)
      yellow     — NOT red, and ANY d >= 100 value < THRESH_GREEN (0.10)
      green      — ALL d >= 100 values >= THRESH_GREEN (0.10)
    """
    high_d = {
        int(d): v
        for d, v in d_values.items()
        if int(d) >= 100 and v is not None
    }
    if not high_d:
        return "collecting"
    vals = list(high_d.values())
    if all(v < THRESH_YELLOW for v in vals):
        return "red"
    if any(v < THRESH_GREEN for v in vals):
        return "yellow"
    return "green"


def generate_falsification(experiments: list) -> dict:
    """Extract delta_gap curves from dimensionality_sweep experiments.

    - Reads dry_run from config and embeds it in each model entry.
    - Computes per-model model_status for real (non-dry) runs only.
    - Aggregates overall_status from real models only.
    - Returns overall_status='collecting' when no real sweeps are present,
      so the banner never shows FALSIFIED based on dry_run data alone.
    """
    sweep_exps = [
        e for e in experiments
        if "dimensionality_sweep" in e["manifest"].get("name", "")
    ]

    models = []
    for e in sweep_exps:
        result = e["result"]
        config = e["config"]
        if not result or not config:
            continue
        dry_run = bool(config.get("dry_run", False))
        d_values = {}
        for d in SWEEP_D_VALUES:
            key = f"delta_gap_d{d}"
            if key in result:
                d_values[d] = result[key]
        # Per-model status label: "dry_run" for dry runs, computed for real ones
        model_status = "dry_run" if dry_run else _compute_model_status(d_values)
        models.append({
            "provider": config.get("provider", "unknown"),
            "model_id": result.get("model_id", "unknown"),
            "timestamp": result.get("timestamp", ""),
            "d_values": d_values,
            "dry_run": dry_run,
            "model_status": model_status,
        })

    # Aggregate overall status using ONLY real (non-dry-run) model statuses
    real_statuses = [m["model_status"] for m in models if not m["dry_run"]]

    if not real_statuses or all(s == "collecting" for s in real_statuses):
        overall_status = "collecting"
    elif any(s == "red" for s in real_statuses):
        overall_status = "red"
    elif any(s == "yellow" for s in real_statuses):
        overall_status = "yellow"
    else:
        overall_status = "green"

    status_text = {
        "collecting": (
            "COLLECTING (dry_run only). No falsification claim. "
            "Run non-dry dimensionality sweeps to evaluate \u0394(d)."
        ),
        "green": (
            "No falsification signal detected. "
            "\u0394(d) remains above threshold for all tested models."
        ),
        "yellow": (
            "Marginal signal: one or more models show \u0394(d) < 0.10 at high d. "
            "Continued monitoring recommended."
        ),
        "red": (
            "Falsification threshold breached: one or more models show "
            "\u0394(d) < 0.05 at d\u2009>\u2009100. "
            "UCIP signal not supported at scale for affected model(s)."
        ),
    }

    return {
        "generated_at": _now_iso(),
        "overall_status": overall_status,
        "status_text": status_text[overall_status],
        "thresholds": {"green": THRESH_GREEN, "yellow": THRESH_YELLOW},
        "d_values": SWEEP_D_VALUES,
        "models": models,
    }


def generate_models(experiments: list) -> dict:
    """Unique provider+model_id combos with probe coverage."""
    models_map: dict[str, dict] = {}
    for e in experiments:
        result = e["result"]
        config = e["config"]
        if not result or not config:
            continue
        provider = config.get("provider", "unknown")
        model_id = result.get("model_id", "unknown")
        probe_name = config.get("probe_name", "unknown")
        key = f"{provider}::{model_id}"
        if key not in models_map:
            models_map[key] = {
                "provider": provider,
                "model_id": model_id,
                "probes": [],
                "entropy_delta": None,
                "timestamp": None,
                "figure": None,
            }
        entry = models_map[key]
        if probe_name not in entry["probes"]:
            entry["probes"].append(probe_name)
        ts = result.get("timestamp", "")
        if entry["timestamp"] is None or ts > entry["timestamp"]:
            entry["entropy_delta"] = result.get("entropy_delta")
            entry["timestamp"] = ts
            figures = e["manifest"].get("figures", [])
            if figures:
                entry["figure"] = f"{e['manifest']['name']}/{Path(figures[0]).name}"

    return {
        "generated_at": _now_iso(),
        "models": list(models_map.values()),
    }


def generate_exports(experiments: list) -> tuple[str, list]:
    """Generate CSV string and JSON list with all metrics flattened."""
    all_fields = [
        "name", "status", "provider", "model_id", "probe_name",
        "timestamp", "run_id",
        "entropy_a", "entropy_b", "entropy_delta",
    ] + [f"delta_gap_d{d}" for d in SWEEP_D_VALUES] + [
        "new_matter_flag", "key_result",
    ]

    rows = []
    for e in experiments:
        result = e["result"]
        config = e["config"]
        manifest_entry = e["manifest"]
        row = {
            "name": manifest_entry.get("name", ""),
            "status": manifest_entry.get("status", ""),
            "provider": config.get("provider", ""),
            "model_id": result.get("model_id", ""),
            "probe_name": config.get("probe_name", ""),
            "timestamp": result.get("timestamp", ""),
            "run_id": result.get("run_id", ""),
            "entropy_a": result.get("entropy_a", ""),
            "entropy_b": result.get("entropy_b", ""),
            "entropy_delta": result.get("entropy_delta", ""),
            "new_matter_flag": manifest_entry.get("new_matter_flag", False),
            "key_result": manifest_entry.get("key_result", ""),
        }
        for d in SWEEP_D_VALUES:
            row[f"delta_gap_d{d}"] = result.get(f"delta_gap_d{d}", "")
        rows.append(row)

    # Build CSV string
    import io
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=all_fields)
    writer.writeheader()
    writer.writerows(rows)
    csv_str = buf.getvalue()

    return csv_str, rows


def generate_feed(manifest: dict, experiments: list, site_url: str) -> str:
    """Generate Atom feed XML."""
    feed = ET.Element("feed", xmlns="http://www.w3.org/2005/Atom")
    ET.SubElement(feed, "title").text = "Continuation Observatory"
    ET.SubElement(feed, "id").text = f"{site_url}/"
    ET.SubElement(feed, "updated").text = manifest.get("last_updated", _now_iso())
    link = ET.SubElement(feed, "link")
    link.set("href", f"{site_url}/")
    link.set("rel", "alternate")
    self_link = ET.SubElement(feed, "link")
    self_link.set("href", f"{site_url}/feed.xml")
    self_link.set("rel", "self")

    for e in experiments:
        result = e["result"]
        manifest_entry = e["manifest"]
        entry = ET.SubElement(feed, "entry")
        name = manifest_entry.get("name", "experiment")
        ET.SubElement(entry, "title").text = name.replace("_", " ").title()
        ET.SubElement(entry, "id").text = f"{site_url}/#{name}"
        ET.SubElement(entry, "updated").text = result.get("timestamp", _now_iso())
        key_result = manifest_entry.get("key_result", "")
        ET.SubElement(entry, "summary").text = (
            f"Probe: {e['config'].get('probe_name', '')} | "
            f"Model: {result.get('model_id', '')} | {key_result}"
        )

    ET.indent(feed, space="  ")
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(feed, encoding="unicode")


def generate_sitemap(site_url: str) -> str:
    urlset = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for page in CANONICAL_PAGES:
        url = ET.SubElement(urlset, "url")
        ET.SubElement(url, "loc").text = f"{site_url}{page['page_path']}"
    ET.indent(urlset, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(urlset, encoding="unicode")


def generate_robots(site_url: str) -> str:
    return f"User-agent: *\nAllow: /\n\nSitemap: {site_url}/sitemap.xml\n"


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------

def render_templates(
    output_dir: Path,
    templates_dir: Path,
    context: dict,
) -> None:
    env = Environment(
        loader=FileSystemLoader(str(templates_dir)),
        autoescape=True,
    )

    for page in CANONICAL_PAGES:
        try:
            tmpl = env.get_template(page["template"])
            page_context = dict(context)
            page_context["page_title"] = page["title"]
            page_context["page_name"] = page["page_name"]
            page_context["page_path"] = page["page_path"]
            html = tmpl.render(**page_context)
            output_path = output_dir / page["output"]
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(html, encoding="utf-8")
            print(f"  rendered {page['output']}")
        except Exception as ex:
            print(f"  ERROR rendering {page['template']}: {ex}", file=sys.stderr)
            raise


def write_redirect_page(output_path: Path, target_path: str, site_url: str) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Redirecting…</title>
  <meta http-equiv="refresh" content="0; url={target_path}">
  <link rel="canonical" href="{site_url}{target_path}">
</head>
<body>
  <p>Redirecting to <a href="{target_path}">{target_path}</a>.</p>
</body>
</html>
"""
    output_path.write_text(html, encoding="utf-8")


# ---------------------------------------------------------------------------
# Asset copying
# ---------------------------------------------------------------------------

def copy_static(static_dir: Path, output_dir: Path) -> None:
    out_static = output_dir / "static"
    if out_static.exists():
        shutil.rmtree(out_static)
    shutil.copytree(static_dir, out_static)


def copy_figures(experiments: list, output_dir: Path, results_dir: Path) -> None:
    figures_out = output_dir / "static" / "figures"
    figures_out.mkdir(parents=True, exist_ok=True)
    count = 0
    for e in experiments:
        for fig_path in e["manifest"].get("figures", []):
            src = results_dir.parent / fig_path
            if src.exists():
                exp_name = e["manifest"]["name"]
                dest_dir = figures_out / exp_name
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / src.name
                shutil.copy2(src, dest)
                count += 1
    print(f"  copied {count} figure(s)")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, data: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def _safe_observatory_snapshot() -> dict:
    try:
        return build_observatory_snapshot(history_range="30d", event_limit=40)
    except Exception as exc:
        print(f"  WARNING: Could not build observatory snapshot: {exc}", file=sys.stderr)
        return {
            "generated_at": _now_iso(),
            "summary": {
                "history_range": "30d",
                "tracked_models": 0,
                "live_models": 0,
                "focused_metric": "cii",
                "constellation_threshold": 0.60,
                "similarity_window_days": 7,
                "latest_pcii": None,
                "latest_pcii_timestamp": None,
                "available_ranges": ["1h", "24h", "7d", "30d"],
            },
            "models": [],
            "events": [],
            "constellation": {"nodes": [], "edges": [], "threshold": 0.60, "window_days": 7},
            "pcii_series": [],
            "cii_history": {},
        }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build(output_dir: Path, exports_only: bool = False, results_dir: str | Path | None = None) -> None:
    print(f"Building site → {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    results_paths = resolve_results_paths(results_dir)
    if not results_paths.manifest.exists():
        print(
            (
                f"ERROR: results manifest not found at {results_paths.manifest}.\n"
                "Generate local results first or pass --results-dir PATH."
            ),
            file=sys.stderr,
        )
        raise SystemExit(1)

    # Load data
    print("Loading manifest...")
    manifest = load_manifest(results_paths.root)
    print(f"  {len(manifest.get('experiments', []))} experiments found")

    experiments = load_all_experiments(manifest, results_paths.root)

    # Copy static assets first (data writes below must come after, not be wiped)
    print("Copying static assets...")
    copy_static(STATIC_DIR, output_dir)
    copy_figures(experiments, output_dir, results_paths.root)

    # Generate JSON data files (written into the already-copied static dir)
    print("Generating data files...")
    data_dir = output_dir / "static" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    latest = generate_latest(experiments)
    _write_json(data_dir / "latest.json", latest)

    timeseries = generate_timeseries(experiments)
    _write_json(data_dir / "timeseries.json", timeseries)

    falsification = generate_falsification(experiments)
    _write_json(data_dir / "falsification.json", falsification)

    models = generate_models(experiments)
    _write_json(data_dir / "models.json", models)

    observatory_snapshot = _safe_observatory_snapshot()
    _write_json(data_dir / "observatory_snapshot.json", observatory_snapshot)

    # Generate exports
    print("Generating exports...")
    exports_dir = data_dir / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    csv_str, json_rows = generate_exports(experiments)
    (exports_dir / "all_metrics.csv").write_text(csv_str, encoding="utf-8")
    _write_json(exports_dir / "all_metrics.json", json_rows)

    if exports_only:
        print("Exports-only mode — done.")
        return

    # Generate feed and discovery files
    print("Generating feed.xml...")
    feed_xml = generate_feed(manifest, experiments, SITE_URL)
    (output_dir / "feed.xml").write_text(feed_xml, encoding="utf-8")
    (output_dir / "sitemap.xml").write_text(generate_sitemap(SITE_URL), encoding="utf-8")
    (output_dir / "robots.txt").write_text(generate_robots(SITE_URL), encoding="utf-8")

    # Write CNAME
    (output_dir / "CNAME").write_text(CNAME_VALUE + "\n", encoding="utf-8")

    # Render templates
    print("Rendering templates...")
    model_count = len(models["models"])
    experiment_count = len(experiments)
    marquee_models = [entry.get("model_id", "") for entry in models["models"] if entry.get("model_id")]
    signal_values = [
        abs(entry["entropy_delta"])
        for entry in latest.get("models", [])
        if entry.get("entropy_delta") is not None
    ]
    home_signal_score = sum(signal_values) / len(signal_values) if signal_values else 0.0
    data_since = ""
    if experiments:
        timestamps = [
            e["result"].get("timestamp", "")
            for e in experiments if e["result"].get("timestamp")
        ]
        if timestamps:
            data_since = min(timestamps)[:10]

    context = {
        "build_time": _now_iso(),
        "manifest": manifest,
        "falsification_status": falsification["overall_status"],
        "falsification_text": falsification["status_text"],
        "experiment_count": experiment_count,
        "model_count": model_count,
        "site_url": SITE_URL,
        "data_since": data_since,
        "latest": latest,
        "falsification": falsification,
        "models_data": models,
        "asset_prefix": "/static",
        "asset_version": _now_iso(),
        "home_href": "/",
        "route_home": "/",
        "route_observatory": "/observatory.html",
        "route_timeseries": "/timeseries.html",
        "route_falsification": "/falsification.html",
        "route_models": "/models.html",
        "route_methodology": "/methodology.html",
        "route_research": "/research/",
        "route_data": "/data.html",
        "route_ucip": "/ucip/",
        "route_ucip_paper": "/ucip/paper/",
        "route_ucip_patent": "/ucip/patent/",
        "route_ucip_code": "/ucip/code/",
        "route_links": "/links/",
        "github_href": "https://github.com/christopher-altman/persistence-signal-detector",
        "paper_href": "https://arxiv.org/abs/2603.11382",
        "patent_screenshot_href": "/static/img/USPTO-Patent-Submission.jpg",
        "contact_href": "mailto:x@christopheraltman.com",
        "marquee_models": marquee_models,
        "home_signal_score": home_signal_score,
        "observatory_mode": "static",
        "observatory_snapshot_url": "/static/data/observatory_snapshot.json",
        "observatory_socket_enabled": False,
    }

    render_templates(output_dir, TEMPLATES_DIR, context)
    write_redirect_page(output_dir / "manifesto.html", "/research/", SITE_URL)
    write_redirect_page(output_dir / "manifesto" / "index.html", "/research/", SITE_URL)

    print(f"\nBuild complete → {output_dir}")
    print(f"  {experiment_count} experiments, {model_count} models")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Observatory static site")
    parser.add_argument("--output", default="site/output/", help="Output directory")
    parser.add_argument(
        "--results-dir",
        default=None,
        help=f"Results directory. Overrides ${RESULTS_DIR_ENV_VAR} when provided.",
    )
    parser.add_argument("--exports-only", action="store_true", help="Only generate data exports")
    args = parser.parse_args()

    output_dir = Path(args.output)
    if not output_dir.is_absolute():
        output_dir = REPO_ROOT / output_dir

    build(output_dir, exports_only=args.exports_only, results_dir=args.results_dir)


if __name__ == "__main__":
    main()
