from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
        env_file=".env",
        env_prefix="",
        case_sensitive=False,
        populate_by_name=True,
    )


settings = Settings()

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = REPO_ROOT / "config"
_YAML_CACHE: dict[str, tuple[float | None, dict[str, Any]]] = {}


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
    observatory_config = load_observatory_config()
    openai_compat = observatory_config.get("providers", {}).get("openai-compatible", {})
    for spec in load_models_config().get("models", []):
        if not spec.get("enabled", False):
            continue
        provider = spec.get("provider")
        if provider == "anthropic":
            required.add("ANTHROPIC_API_KEY")
        elif provider == "openai":
            required.add("OPENAI_API_KEY")
        elif provider == "gemini":
            required.add("GOOGLE_API_KEY")
        elif provider == "openai-compatible":
            compat = openai_compat.get(spec.get("id"), {})
            if compat.get("enabled", True):
                required.add(str(compat.get("api_key_env", "OPENAI_API_KEY")))
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
