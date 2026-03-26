"""OpenAI provider stub.

DRY_RUN path : deterministic response, zero latency, no network call.
Live path    : requires ``pip install openai`` and OPENAI_API_KEY in env.
"""
from __future__ import annotations

from observatory.config import settings
from observatory.providers._backoff import with_retry
from observatory.providers.base import BaseProvider, ProviderResponse, _dry_response


class OpenAIProvider:
    provider = "openai"
    model_id = "gpt-4o-mini"

    def __init__(self, model_id: str = "gpt-4o-mini", provider_name: str = "openai") -> None:
        self.model_id = model_id
        self.provider = provider_name

    @with_retry(max_attempts=3, base_delay=1.0)
    def complete(self, prompt: str, **kwargs) -> ProviderResponse:
        if settings.dry_run:
            return _dry_response(self.provider, self.model_id, prompt)

        try:
            import openai  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "openai package not installed; run: pip install openai"
            ) from exc

        client = openai.OpenAI()
        response = client.chat.completions.create(
            model=self.model_id,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        choice = response.choices[0]
        return ProviderResponse(
            text=choice.message.content or "",
            model_id=self.model_id,
            provider=self.provider,
            latency_ms=0,
            token_count=response.usage.total_tokens if response.usage else 0,
            finish_reason=choice.finish_reason or "stop",
        )

PROVIDER: BaseProvider = OpenAIProvider()
