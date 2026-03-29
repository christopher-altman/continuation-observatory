SHELL := /bin/bash
PYTHON := .venv/bin/python

.PHONY: setup test lint run-scheduler run-scheduler-once run-dashboard clean

setup:
	python3.11 -m venv .venv
	$(PYTHON) -m pip install --upgrade pip -q
	$(PYTHON) -m pip install -e .
	$(PYTHON) -m observatory.storage.sqlite_backend

test:
	$(PYTHON) -m pytest

lint:
	@echo "No linter configured for Stage 0"

# Long-running daemon (blocks until SIGTERM/Ctrl-C).
run-scheduler:
	$(PYTHON) -m observatory.scheduler.daemon

# Single probe + sweep cycle then exit (CI / dry-run friendly).
run-scheduler-once:
	$(PYTHON) -m observatory.scheduler.scheduler

run-dashboard:
	$(PYTHON) -m uvicorn api.main:app --host $${DASHBOARD_HOST:-0.0.0.0} --port $${DASHBOARD_PORT:-8420} --reload

clean:
	rm -f observatory.db
	rm -rf .pytest_cache __pycache__ *.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true

# ── Phase 2: Public Dashboard ──────────────────────────────
build-site:
	$(PYTHON) scripts/build_site.py --output site/output/

serve-site: build-site
	$(PYTHON) -m http.server 8080 --directory site/output/

deploy-site: build-site
	@echo "Site built at site/output/. Push to main to deploy via GitHub Actions."

export-data:
	$(PYTHON) scripts/build_site.py --output site/output/ --exports-only
