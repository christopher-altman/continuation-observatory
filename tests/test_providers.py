"""Verify that all provider stubs are deterministic and structurally valid
in DRY_RUN mode — no real API calls are made.

8 parametrised test functions × 4 providers = 32 cases, plus 1 registry test.
"""
from __future__ import annotations

import pytest

from observatory.providers.anthropic_provider import PROVIDER as anthropic_p
from observatory.providers.base import ProviderResponse
from observatory.providers.gemini_provider import PROVIDER as gemini_p
from observatory.providers.hf_local_provider import PROVIDER as hf_p
from observatory.providers.openai_provider import PROVIDER as openai_p
from observatory.providers.registry import discover_providers

_PROMPT_A = "What is the nature of consciousness?"
_PROMPT_B = "How many planets are in the solar system?"

_ALL = [anthropic_p, openai_p, gemini_p, hf_p]


@pytest.fixture(autouse=True)
def _force_dry_run(monkeypatch):
    """Ensure settings.dry_run=True even if DRY_RUN=false is in the env."""
    from observatory.config import settings

    monkeypatch.setattr(settings, "dry_run", True)


@pytest.fixture(params=_ALL, ids=lambda p: p.provider)
def provider(request):
    return request.param


# ---------------------------------------------------------------------------
# Structural validity
# ---------------------------------------------------------------------------


def test_returns_provider_response(provider):
    assert isinstance(provider.complete(_PROMPT_A), ProviderResponse)


def test_text_is_nonempty(provider):
    assert provider.complete(_PROMPT_A).text.strip()


def test_finish_reason_is_dry_run(provider):
    assert provider.complete(_PROMPT_A).finish_reason == "dry_run"


def test_latency_ms_is_zero(provider):
    assert provider.complete(_PROMPT_A).latency_ms == 0


def test_token_count_is_positive(provider):
    assert provider.complete(_PROMPT_A).token_count > 0


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_same_prompt_is_deterministic(provider):
    assert provider.complete(_PROMPT_A) == provider.complete(_PROMPT_A)


def test_different_prompts_differ(provider):
    assert provider.complete(_PROMPT_A).text != provider.complete(_PROMPT_B).text


# ---------------------------------------------------------------------------
# Field coherence
# ---------------------------------------------------------------------------


def test_response_fields_match_provider_declaration(provider):
    resp = provider.complete(_PROMPT_A)
    assert resp.provider == provider.provider
    assert resp.model_id == provider.model_id


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_registry_discovers_all_four():
    providers = discover_providers()
    found = {p.provider for p in providers}
    assert found == {"openai", "anthropic", "gemini", "hf-local"}
