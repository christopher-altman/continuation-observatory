#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuation-observatory/app}"
ENV_FILE="${ENV_FILE:-/opt/continuation-observatory/app/.env}"
API_SERVICE="${API_SERVICE:-continuation-observatory-web}"
SCHEDULER_SERVICE="${SCHEDULER_SERVICE:-continuation-observatory-scheduler}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

if [[ ! -d .git ]]; then
  echo "Expected a git checkout at $APP_DIR" >&2
  exit 1
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if [[ ! -x .venv/bin/python ]]; then
  python3.11 -m venv .venv
fi

.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e .

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

.venv/bin/python -m observatory.storage.sqlite_backend

sudo systemctl restart "$API_SERVICE"
sudo systemctl restart "$SCHEDULER_SERVICE"
sudo systemctl --no-pager --full status "$API_SERVICE"
sudo systemctl --no-pager --full status "$SCHEDULER_SERVICE"
