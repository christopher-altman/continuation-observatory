from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic_settings import SettingsConfigDict

from observatory.config import (
    Settings,
    get_cors_allowed_origins,
    parse_cors_allowed_origins,
    required_live_env_vars,
    settings,
    validate_live_configuration,
)
from api.routes.probes import require_admin_key


def test_parse_cors_allowed_origins():
    assert parse_cors_allowed_origins("") == []
    assert parse_cors_allowed_origins("*") == ["*"]
    assert parse_cors_allowed_origins("https://a.example, https://b.example") == [
        "https://a.example",
        "https://b.example",
    ]


def test_admin_trigger_allows_dry_run_without_key(monkeypatch):
    monkeypatch.setattr(settings, "dry_run", True)
    monkeypatch.setattr(settings, "admin_api_key", None)
    require_admin_key(None)


def test_admin_trigger_rejects_missing_key_in_live_mode(monkeypatch):
    monkeypatch.setattr(settings, "dry_run", False)
    monkeypatch.setattr(settings, "admin_api_key", "secret")
    with pytest.raises(HTTPException) as exc:
        require_admin_key(None)
    assert exc.value.status_code == 401


def test_admin_trigger_accepts_matching_key(monkeypatch):
    monkeypatch.setattr(settings, "dry_run", False)
    monkeypatch.setattr(settings, "admin_api_key", "secret")
    require_admin_key("secret")


def test_validate_live_configuration_blocks_unsafe_defaults(monkeypatch):
    monkeypatch.setattr(settings, "dry_run", False)
    monkeypatch.setattr(settings, "db_url", "sqlite:///observatory.db")
    monkeypatch.setattr(settings, "allow_live_sqlite", False)
    monkeypatch.setattr(settings, "cors_allowed_origins_raw", "*")
    monkeypatch.setattr(settings, "allow_insecure_live_cors", False)
    monkeypatch.setattr(settings, "admin_api_key", None)
    with pytest.raises(RuntimeError) as exc:
        validate_live_configuration()
    message = str(exc.value)
    assert "live mode with sqlite is blocked" in message
    assert "wildcard CORS is blocked" in message
    assert "ADMIN_API_KEY is required" in message


def test_validate_live_configuration_accepts_hardened_live_mode(monkeypatch):
    monkeypatch.setattr(settings, "dry_run", False)
    monkeypatch.setattr(settings, "db_url", "postgresql://user:pass@localhost/obs")
    monkeypatch.setattr(settings, "allow_live_sqlite", False)
    monkeypatch.setattr(settings, "cors_allowed_origins_raw", "https://observatory.example")
    monkeypatch.setattr(settings, "allow_insecure_live_cors", False)
    monkeypatch.setattr(settings, "admin_api_key", "secret")

    needed = required_live_env_vars()
    for name in needed:
        monkeypatch.setenv(name, "test-value")

    validate_live_configuration()
    assert get_cors_allowed_origins() == ["https://observatory.example"]


def test_settings_ignore_provider_env_keys(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("DRY_RUN", raising=False)
    monkeypatch.delenv("DB_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    env_path = tmp_path / ".env"
    env_path.write_text(
        "\n".join(
            [
                "DRY_RUN=false",
                "DB_URL=sqlite:///observatory.db",
                "OPENAI_API_KEY=test-openai",
                "ANTHROPIC_API_KEY=test-anthropic",
                "GOOGLE_API_KEY=test-google",
                "TOGETHER_API_KEY=test-together",
                "XAI_API_KEY=test-xai",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    class TestSettings(Settings):
        model_config = SettingsConfigDict(
            env_file=str(env_path),
            env_prefix="",
            case_sensitive=False,
            populate_by_name=True,
            extra="ignore",
        )

    loaded = TestSettings()
    assert loaded.dry_run is False
    assert loaded.db_url == "sqlite:///observatory.db"
