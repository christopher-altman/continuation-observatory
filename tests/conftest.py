from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

TEST_DB_PATH = Path(tempfile.gettempdir()) / f"continuation-observatory-pytest-{os.getpid()}.db"
TEST_DB_URL = f"sqlite:///{TEST_DB_PATH}"
TEST_RESULTS_PATH = Path(
    tempfile.mkdtemp(prefix=f"continuation-observatory-pytest-{os.getpid()}-results-")
)
(TEST_RESULTS_PATH / "manifest.json").write_text(
    '{"version": "1.0.0", "experiments": []}\n',
    encoding="utf-8",
)

# These must be set before test modules import the application and construct
# its SQLAlchemy engine. Tests must never append synthetic rows to the local or
# production-configured observatory database.
os.environ["DATABASE_URL"] = TEST_DB_URL
os.environ["DB_URL"] = TEST_DB_URL
os.environ["DRY_RUN"] = "true"
os.environ["OBSERVATORY_RESULTS_DIR"] = str(TEST_RESULTS_PATH)


@pytest.fixture(autouse=True)
def _isolate_tests_from_live_provider_credentials(monkeypatch):
    """Keep the test process offline even when the local env is production-like.

    Individual security tests may still set ``settings.dry_run`` to ``False``
    after this fixture runs when exercising live-mode validation explicitly.
    """
    from observatory.config import settings

    monkeypatch.setattr(settings, "dry_run", True)
    monkeypatch.setattr(settings, "admin_api_key", None)


@pytest.fixture(scope="session", autouse=True)
def _remove_isolated_test_database():
    yield

    from observatory.storage.sqlite_backend import get_engine

    get_engine().dispose()
    TEST_DB_PATH.unlink(missing_ok=True)
    shutil.rmtree(TEST_RESULTS_PATH, ignore_errors=True)
