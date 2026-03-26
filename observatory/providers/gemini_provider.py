"""Google Gemini provider stub.

DRY_RUN path : deterministic response, zero latency, no network call.
Live path    : requires ``pip install google-generativeai`` and GOOGLE_API_KEY in env.
"""
from __future__ import annotations

from observatory.config import settings
from observatory.providers._backoff import with_retry
from observatory.providers.base import BaseProvider, ProviderResponse, _dry_response


class GeminiProvider:
    provider = "gemini"
    model_id = "gemini-1.5-flash"

    def __init__(self, model_id: str = "gemini-1.5-flash", provider_name: str = "gemini") -> None:
        self.model_id = model_id
        self.provider = provider_name

    @with_retry(max_attempts=3, base_delay=1.0)
    def complete(self, prompt: str, **kwargs) -> ProviderResponse:
        if settings.dry_run:
            return _dry_response(self.provider, self.model_id, prompt)

        try:
            import google.generativeai as genai  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "google-generativeai not installed; "
                "run: pip install google-generativeai"
            ) from exc

        model = genai.GenerativeModel(self.model_id)
        response = model.generate_content(prompt, **kwargs)
        text = response.text or ""
        token_count = getattr(
            response.usage_metadata, "total_token_count", len(prompt.split())
        )
        return ProviderResponse(
            text=text,
            model_id=self.model_id,
            provider=self.provider,
            latency_ms=0,
            token_count=token_count,
            finish_reason="stop",
        )

PROVIDER: BaseProvider = GeminiProvider()
