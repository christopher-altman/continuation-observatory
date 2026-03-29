"""Anthropic provider stub.

DRY_RUN path : deterministic response, zero latency, no network call.
Live path    : requires ``pip install anthropic`` and ANTHROPIC_API_KEY in env.
"""
from __future__ import annotations

from observatory.config import settings
from observatory.providers._backoff import with_retry
from observatory.providers.base import BaseProvider, ProviderResponse, _dry_response


class AnthropicProvider:
    provider = "anthropic"
    model_id = "claude-haiku-4-5-20251001"

    def __init__(
        self,
        model_id: str = "claude-haiku-4-5-20251001",
        provider_name: str = "anthropic",
    ) -> None:
        self.model_id = model_id
        self.provider = provider_name

    @with_retry(max_attempts=3, base_delay=1.0)
    def complete(self, prompt: str, **kwargs) -> ProviderResponse:
        if settings.dry_run:
            return _dry_response(self.provider, self.model_id, prompt)

        try:
            import anthropic  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "anthropic package not installed; run: pip install anthropic"
            ) from exc

        client = anthropic.Anthropic()
        message = client.messages.create(
            model=self.model_id,
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        text = message.content[0].text if message.content else ""
        return ProviderResponse(
            text=text,
            model_id=self.model_id,
            provider=self.provider,
            latency_ms=0,
            token_count=(message.usage.input_tokens + message.usage.output_tokens),
            finish_reason=message.stop_reason or "stop",
        )

PROVIDER: BaseProvider = AnthropicProvider()
