"""Provider interface and shared DRY_RUN helper.

Every provider module MUST export a ``PROVIDER`` singleton that satisfies
``BaseProvider``.  All network I/O lives inside ``complete()``; the bridge
to DRY_RUN is ``_dry_response()``, which is deterministic for any given
(provider, model_id, prompt) triple.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class ProviderResponse:
    """Structurally valid response returned by every provider."""

    text: str
    model_id: str
    provider: str
    latency_ms: int
    token_count: int
    finish_reason: str  # "stop" | "length" | "dry_run"


def _dry_response(provider: str, model_id: str, prompt: str) -> ProviderResponse:
    """Return a deterministic DRY_RUN ProviderResponse — no network call."""
    h = hashlib.sha256(prompt.encode()).hexdigest()[:12]
    words = len(prompt.split())
    return ProviderResponse(
        text=f"[DRY_RUN {provider}/{model_id}] hash={h} words={words}",
        model_id=model_id,
        provider=provider,
        latency_ms=0,
        token_count=words,
        finish_reason="dry_run",
    )


@runtime_checkable
class BaseProvider(Protocol):
    provider: str
    model_id: str

    def complete(self, prompt: str, **kwargs) -> ProviderResponse: ...
