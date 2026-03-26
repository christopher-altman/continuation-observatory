"""Rate-limit / exponential-backoff decorator.

In DRY_RUN the decorator is a transparent pass-through with no delay or
retry loop.  In live mode it wraps the call in up to ``max_attempts``
attempts with exponential back-off between failures.
"""
from __future__ import annotations

import functools
import time

from observatory.config import settings


def with_retry(
    *,
    max_attempts: int = 3,
    base_delay: float = 1.0,
    exceptions: tuple[type[Exception], ...] = (Exception,),
):
    """Decorator factory: exponential back-off, transparent no-op in DRY_RUN."""

    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            if settings.dry_run:
                # No-op in DRY_RUN — single call, no delay, no retry.
                return fn(*args, **kwargs)

            last_exc: Exception | None = None
            for attempt in range(max_attempts):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:  # type: ignore[misc]
                    last_exc = exc
                    if attempt < max_attempts - 1:
                        time.sleep(base_delay * (2**attempt))
            raise last_exc  # type: ignore[misc]

        return wrapper

    return decorator
