from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env"

# Provider SDKs read credentials from process env, so keep `.env` hydration
# aligned with pydantic-settings instead of only parsing it into Settings().
load_dotenv(ENV_FILE, override=False)


class Settings(BaseSettings):
    # Accepts DATABASE_URL (tests), DB_URL, or the field name itself.
    db_url: str = Field(
        "sqlite:///observatory.db",
        validation_alias=AliasChoices("DATABASE_URL", "DB_URL", "db_url"),
    )
    dry_run: bool = True
    scheduler_timezone: str = "UTC"
    cors_allowed_origins_raw: str = Field(
        "",
        validation_alias=AliasChoices(
            "CORS_ALLOWED_ORIGINS",
            "cors_allowed_origins",
            "cors_allowed_origins_raw",
        ),
    )
    admin_api_key: str | None = Field(
        None,
        validation_alias=AliasChoices("ADMIN_API_KEY", "admin_api_key"),
    )
    admin_header_name: str = Field(
        "x-admin-key",
        validation_alias=AliasChoices("ADMIN_HEADER_NAME", "admin_header_name"),
    )
    allow_live_sqlite: bool = Field(
        False,
        validation_alias=AliasChoices("ALLOW_LIVE_SQLITE", "allow_live_sqlite"),
    )
    allow_insecure_live_cors: bool = Field(
        False,
        validation_alias=AliasChoices(
            "ALLOW_INSECURE_LIVE_CORS",
            "allow_insecure_live_cors",
        ),
    )

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_prefix="",
        case_sensitive=False,
        populate_by_name=True,
        extra="ignore",
    )


settings = Settings()
CONFIG_DIR = REPO_ROOT / "config"
_YAML_CACHE: dict[str, tuple[float | None, dict[str, Any]]] = {}
_NATIVE_PROVIDER_API_KEYS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GOOGLE_API_KEY",
}
_OPENAI_COMPATIBLE_BASE_URL_DEFAULTS = {
    "together": "https://api.together.xyz/v1",
    "xai": "https://api.x.ai/v1",
}


def _load_yaml_file(filename: str) -> dict[str, Any]:
    path = CONFIG_DIR / filename
    if not path.exists():
        return {}
    stat = path.stat()
    cached = _YAML_CACHE.get(filename)
    if cached is not None and cached[0] == stat.st_mtime:
        return cached[1]
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise TypeError(f"Expected mapping in {path}")
    _YAML_CACHE[filename] = (stat.st_mtime, data)
    return data


def load_models_config() -> dict[str, Any]:
    return _load_yaml_file("models.yaml")


def load_weights_config() -> dict[str, Any]:
    return _load_yaml_file("weights.yaml")


def load_alerts_config() -> dict[str, Any]:
    return _load_yaml_file("alerts.yaml")


def load_observatory_config() -> dict[str, Any]:
    return _load_yaml_file("observatory.yaml")


def get_probe_cycle_interval_hours(observatory_config: dict[str, Any] | None = None) -> int:
    observatory_config = observatory_config or load_observatory_config()
    runtime_config = observatory_config.get("runtime", {})
    try:
        value = int(runtime_config.get("probe_cycle_hours", 6))
    except (TypeError, ValueError):
        value = 6
    return max(1, value)


def get_probe_cycle_interval_minutes(observatory_config: dict[str, Any] | None = None) -> int:
    return get_probe_cycle_interval_hours(observatory_config) * 60


def _provider_base_url_env_name(provider_name: str) -> str:
    normalized = provider_name.upper().replace("-", "_")
    return f"{normalized}_BASE_URL"


def resolve_runtime_model_spec(
    spec: dict[str, Any],
    *,
    observatory_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve the effective runtime provider surface for one model spec."""
    observatory_config = observatory_config or load_observatory_config()
    provider_kind = str(spec.get("provider") or "")
    model_id = spec.get("model_string")
    resolved = dict(spec)
    resolved["provider_kind"] = provider_kind
    resolved["model_id"] = model_id
    resolved["effective_provider"] = provider_kind
    resolved["effective_api_key_env"] = _NATIVE_PROVIDER_API_KEYS.get(provider_kind)
    resolved["effective_base_url"] = None

    if provider_kind == "openai-compatible":
        compat_cfg = observatory_config.get("providers", {}).get("openai-compatible", {})
        compat = compat_cfg.get(spec.get("id"), {})
        provider_name = str(compat.get("provider_name", "openai-compatible"))
        api_key_env = str(compat.get("api_key_env", "OPENAI_API_KEY"))
        configured_base_url = compat.get("base_url") or _OPENAI_COMPATIBLE_BASE_URL_DEFAULTS.get(
            provider_name
        )
        base_url = os.getenv(_provider_base_url_env_name(provider_name)) or configured_base_url
        resolved["effective_provider"] = provider_name
        resolved["effective_api_key_env"] = api_key_env
        resolved["effective_base_url"] = base_url

    # Expose the effective provider label on the projected runtime record so
    # API/static payloads and scheduler/runtime construction stay aligned.
    resolved["provider"] = resolved["effective_provider"]
    return resolved


def load_active_model_catalog() -> tuple[list[dict[str, Any]], set[str]]:
    """Return the effective active model catalog in configured order.

    This is a read-only projection of repo truth used by runtime expansion.
    It intentionally preserves the ordering in ``config/models.yaml`` and
    applies the same openai-compatible gating already used by runtime
    provider construction.
    """
    observatory_config = load_observatory_config()
    compat_cfg = observatory_config.get("providers", {}).get("openai-compatible", {})
    active_models: list[dict[str, Any]] = []
    active_model_ids: set[str] = set()

    for spec in load_models_config().get("models", []):
        if not spec.get("enabled", False):
            continue
        if spec.get("provider") == "openai-compatible":
            compat = compat_cfg.get(spec.get("id"), {})
            if not compat.get("enabled", True):
                continue
        record = resolve_runtime_model_spec(spec, observatory_config=observatory_config)
        active_models.append(record)
        if record["model_id"]:
            active_model_ids.add(str(record["model_id"]))

    return active_models, active_model_ids


def parse_cors_allowed_origins(raw: str) -> list[str]:
    if not raw.strip():
        return []
    if raw.strip() == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def get_cors_allowed_origins() -> list[str]:
    return parse_cors_allowed_origins(settings.cors_allowed_origins_raw)


def required_live_env_vars() -> list[str]:
    required: set[str] = set()
    active_models, _ = load_active_model_catalog()
    for spec in active_models:
        api_key_env = spec.get("effective_api_key_env")
        if api_key_env:
            required.add(str(api_key_env))
    return sorted(required)


def validate_live_configuration() -> None:
    """Fail fast on unsafe production configuration."""
    if settings.dry_run:
        return

    errors: list[str] = []
    if settings.db_url.startswith("sqlite:///") and not settings.allow_live_sqlite:
        errors.append(
            "live mode with sqlite is blocked by default; set ALLOW_LIVE_SQLITE=true to override"
        )

    cors_origins = get_cors_allowed_origins()
    if "*" in cors_origins and not settings.allow_insecure_live_cors:
        errors.append(
            "wildcard CORS is blocked in live mode; set explicit CORS_ALLOWED_ORIGINS or ALLOW_INSECURE_LIVE_CORS=true"
        )

    if not settings.admin_api_key:
        errors.append("ADMIN_API_KEY is required in live mode")

    missing = [name for name in required_live_env_vars() if not os.getenv(name)]
    if missing:
        errors.append(f"missing provider credentials: {', '.join(missing)}")

    if errors:
        message = "\n".join(f"- {error}" for error in errors)
        raise RuntimeError(f"Live configuration invalid:\n{message}")
