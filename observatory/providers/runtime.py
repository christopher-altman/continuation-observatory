"""Runtime provider expansion for configured model surfaces."""
from __future__ import annotations

from observatory.config import load_models_config, load_observatory_config
from observatory.providers.anthropic_provider import AnthropicProvider
from observatory.providers.base import BaseProvider
from observatory.providers.generic_openai_provider import GenericOpenAIProvider
from observatory.providers.gemini_provider import GeminiProvider
from observatory.providers.hf_local_provider import HFLocalProvider
from observatory.providers.openai_provider import OpenAIProvider
from observatory.providers.registry import discover_providers


def build_runtime_providers() -> list[BaseProvider]:
    """Return runtime providers, optionally expanded from config/models.yaml."""
    observatory_config = load_observatory_config()
    runtime_cfg = observatory_config.get("runtime", {})
    if not runtime_cfg.get("expand_configured_models", False):
        return discover_providers()

    models = load_models_config().get("models", [])
    compat_cfg = observatory_config.get("providers", {}).get("openai-compatible", {})
    providers: list[BaseProvider] = []

    for spec in models:
        if not spec.get("enabled", False):
            continue
        provider_kind = spec.get("provider")
        model_id = spec.get("model_string")
        if provider_kind == "anthropic":
            providers.append(AnthropicProvider(model_id=model_id))
        elif provider_kind == "openai":
            providers.append(OpenAIProvider(model_id=model_id))
        elif provider_kind == "gemini":
            providers.append(GeminiProvider(model_id=model_id))
        elif provider_kind == "hf-local":
            providers.append(HFLocalProvider(model_id=model_id))
        elif provider_kind == "openai-compatible":
            compat = compat_cfg.get(spec.get("id"), {})
            if compat.get("enabled", True):
                providers.append(
                    GenericOpenAIProvider(
                        model_id=model_id,
                        provider_name=compat.get("provider_name", "openai-compatible"),
                        base_url=compat.get("base_url"),
                        api_key_env=compat.get("api_key_env", "OPENAI_API_KEY"),
                    )
                )

    if not providers:
        return discover_providers()
    return providers
