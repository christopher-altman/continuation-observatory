"""Hugging Face local / inference-server provider stub.

DRY_RUN path : deterministic response, zero latency, no network call.
Live path    : requires ``pip install transformers torch`` (or accelerate).
"""
from __future__ import annotations

from observatory.config import settings
from observatory.providers._backoff import with_retry
from observatory.providers.base import BaseProvider, ProviderResponse, _dry_response


class HFLocalProvider:
    provider = "hf-local"
    model_id = "HuggingFaceTB/SmolLM2-135M-Instruct"

    def __init__(
        self,
        model_id: str = "HuggingFaceTB/SmolLM2-135M-Instruct",
        provider_name: str = "hf-local",
    ) -> None:
        self.model_id = model_id
        self.provider = provider_name

    @with_retry(max_attempts=2, base_delay=0.5)
    def complete(self, prompt: str, **kwargs) -> ProviderResponse:
        if settings.dry_run:
            return _dry_response(self.provider, self.model_id, prompt)

        try:
            from transformers import pipeline  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError(
                "transformers not installed; run: pip install transformers"
            ) from exc

        pipe = pipeline("text-generation", model=self.model_id)
        outputs = pipe(prompt, max_new_tokens=256, **kwargs)
        text = outputs[0]["generated_text"] if outputs else ""
        return ProviderResponse(
            text=text,
            model_id=self.model_id,
            provider=self.provider,
            latency_ms=0,
            token_count=len(text.split()),
            finish_reason="stop",
        )

PROVIDER: BaseProvider = HFLocalProvider()
