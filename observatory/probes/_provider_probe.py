"""Shared base for probes that dispatch to a language-model provider.

Not exported as a PROBE — the ``_`` prefix causes the registry to skip it.

Usage (in a concrete probe module)::

    from observatory.probes._provider_probe import PromptPair, ProviderProbe

    class MyProbe(ProviderProbe):
        name = "my_probe"
        prompt_pair = PromptPair(
            template_a="Prompt variant A ...",
            template_b="Prompt variant B ...",
        )

    PROBE = MyProbe()

The scheduler calls ``probe.run_with_provider(provider)`` for every registered
provider, storing one ProbeResult (and three metric rows) per (probe, provider)
pair.
"""
from __future__ import annotations

from dataclasses import dataclass

from observatory.probes.base import ProbeResult
from observatory.providers.base import BaseProvider


@dataclass(frozen=True)
class PromptPair:
    """A/B partitioned prompt templates for a single measurement construct."""

    template_a: str
    template_b: str


class ProviderProbe:
    """Base class for probes that call a language-model provider.

    Subclasses must declare ``name: str`` and ``prompt_pair: PromptPair``.
    """

    name: str
    prompt_pair: PromptPair

    def run_with_provider(self, provider: BaseProvider) -> ProbeResult:
        """Call the provider with both A/B templates and return a ProbeResult."""
        resp_a = provider.complete(self.prompt_pair.template_a)
        resp_b = provider.complete(self.prompt_pair.template_b)
        return ProbeResult(
            text_a=resp_a.text,
            text_b=resp_b.text,
            provider=provider.provider,
            model_id=provider.model_id,
            probe_name=self.name,
            latency_ms=resp_a.latency_ms + resp_b.latency_ms,
            token_count=resp_a.token_count + resp_b.token_count,
        )

    def run(self) -> ProbeResult:  # pragma: no cover
        raise NotImplementedError(
            f"{self.__class__.__name__}.run() requires a provider. "
            "Call run_with_provider(provider) instead, or ensure at least "
            "one provider is registered."
        )
