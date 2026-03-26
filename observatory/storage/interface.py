"""Abstract storage interface for the Continuation Observatory.

Defines the ``StorageBackend`` Protocol so that alternative backends
(e.g., PostgreSQL, in-memory for tests) can be swapped in without
touching scheduler or API code.

The concrete SQLite implementation is in
``observatory.storage.sqlite_backend``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional, Protocol, runtime_checkable


@runtime_checkable
class StorageBackend(Protocol):
    """Protocol satisfied by any concrete storage backend."""

    def init_db(self) -> None:
        """Create all tables if they do not exist."""
        ...

    def insert_probe_run(
        self,
        *,
        run_id: str,
        timestamp: Optional[datetime],
        provider: str,
        model_id: str,
        probe_name: str,
        latency_ms: int,
        token_count: int,
    ) -> int:
        """Insert a probe_runs row.  Returns the new row id."""
        ...

    def insert_metric_result(
        self,
        *,
        run_id: str,
        timestamp: Optional[datetime],
        provider: str,
        model_id: str,
        probe_name: str,
        latency_ms: int,
        token_count: int,
        metric_name: str,
        metric_value: float,
    ) -> None:
        """Insert a metric_results row."""
        ...

    def insert_falsification_alert(
        self,
        *,
        run_id: str,
        probe_name: str,
        provider: str,
        model_id: str,
        max_delta: float,
        threshold: float,
        timestamp: Optional[datetime],
    ) -> None:
        """Insert a falsification_alerts row."""
        ...

    def count_rows(self, table_name: str) -> int:
        """Return row count for the named table."""
        ...

    def count_falsification_alerts(self) -> int:
        """Return count of all falsification_alerts rows."""
        ...
