"""Generic OpenAI-compatible provider.

Used in Phase 2 to support model families that expose an OpenAI-compatible
chat completions surface (DeepSeek, Mistral, xAI, Qwen, Cohere-compatible,
and similar vendors) without changing the base provider registry contract.
"""
from __future__ import annotations

import os

from observatory.config import settings
from observatory.providers._backoff import with_retry
from observatory.providers.base import ProviderResponse, _dry_response


class GenericOpenAIProvider:
    def __init__(
        self,
        *,
        model_id: str,
        provider_name: str = "openai-compatible",
        base_url: str | None = None,
        api_key_env: str = "OPENAI_API_KEY",
    ) -> None:
        self.model_id = model_id
        self.provider = provider_name
        self.base_url = base_url
        self.api_key_env = api_key_env

    @with_retry(max_attempts=3, base_delay=1.0)
    def complete(self, prompt: str, **kwargs) -> ProviderResponse:
        if settings.dry_run:
            return _dry_response(self.provider, self.model_id, prompt)

        try:
            import openai  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError("openai package not installed; run: pip install openai") from exc

        api_key = os.getenv(self.api_key_env)
        if not api_key:
            raise RuntimeError(f"{self.api_key_env} is not set")

        client = openai.OpenAI(api_key=api_key, base_url=self.base_url)
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
