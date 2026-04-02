from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Sequence

from observatory.config import (
    load_alerts_config,
    load_models_config,
    load_observatory_config,
    resolve_runtime_model_spec,
)
from observatory.storage.sqlite_backend import get_observatory_events

SEVERITY_RANK = {
    "critical": 5,
    "alert": 4,
    "error": 4,
    "warning": 3,
    "info": 1,
}

STATUS_PRIORITY = {
    "active": 0,
    "quieted": 1,
    "stale": 2,
}

TRANSITION_LABELS = {
    "active": "fresh recurrence inside active window",
    "quieted": "inferred quieted by non-recurrence inside active window",
    "stale": "aged beyond quiet window without fresh recurrence",
}


def get_public_feed_config(observatory_config: dict[str, Any] | None = None) -> dict[str, Any]:
    observatory_config = observatory_config or load_observatory_config()
    feed_config = observatory_config.get("public_feed", {})
    quiet_window_hours = int(
        feed_config.get("quiet_window_hours", feed_config.get("recent_window_hours", 24))
    )
    return {
        "active_window_hours": int(feed_config.get("active_window_hours", 6)),
        "quiet_window_hours": quiet_window_hours,
        "stale_after_hours": int(feed_config.get("stale_after_hours", 72)),
        "burst_window_minutes": int(feed_config.get("burst_window_minutes", 90)),
        "recent_raw_limit": int(feed_config.get("recent_raw_limit", 500)),
        "max_items": int(feed_config.get("max_items", 10)),
        "fallback_max_items": int(feed_config.get("fallback_max_items", 4)),
        "suppressed_error_families": list(feed_config.get("suppressed_error_families", ["ResourceExhausted"])),
        "suppressed_event_patterns": list(
            feed_config.get(
                "suppressed_event_patterns",
                [
                    "quota exhausted",
                    "quota exceeded",
                    "low balance",
                    "insufficient balance",
                    "credit exhausted",
                ],
            )
        ),
        "observatory_scope_min_providers": int(feed_config.get("observatory_scope_min_providers", 2)),
        "observatory_scope_min_models": int(feed_config.get("observatory_scope_min_models", 3)),
        "provider_scope_min_models": int(feed_config.get("provider_scope_min_models", 2)),
    }


def get_public_visible_events(
    *,
    since: datetime | None = None,
    severity: str | None = None,
    model_id: str | None = None,
    limit: int = 50,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    hidden_types = tuple(load_alerts_config().get("ui", {}).get("default_hide_event_types", []))
    return get_observatory_events(
        since=since,
        severity=severity,
        model_id=model_id,
        limit=limit,
        event_type=event_type,
        exclude_event_types=hidden_types if hidden_types else None,
    )


def _coerce_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        timestamp = value
    else:
        timestamp = datetime.fromisoformat(str(value))
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return timestamp


def _severity_rank(value: Any) -> int:
    return SEVERITY_RANK.get(str(value or "").lower(), 0)


def _normalize_text(value: Any) -> str:
    normalized = re.sub(r"\s+", " ", str(value or "").strip().lower())
    normalized = re.sub(r"\d+(?:\.\d+)?", "#", normalized)
    return normalized


def _titleize_provider(provider: str | None) -> str:
    if not provider:
        return "Unknown provider"
    return str(provider).replace("_", " ").replace("-", " ").strip().title()


def _model_provider_map(observatory_config: dict[str, Any] | None = None) -> dict[str, str]:
    observatory_config = observatory_config or load_observatory_config()
    provider_map: dict[str, str] = {}
    for spec in load_models_config().get("models", []):
        if not spec.get("model_string"):
            continue
        resolved = resolve_runtime_model_spec(spec, observatory_config=observatory_config)
        provider_map[str(resolved["model_id"])] = str(resolved.get("effective_provider") or resolved.get("provider") or "")
    return provider_map


def _fallback_provider_from_model_id(model_id: str | None) -> str | None:
    if not model_id:
        return None
    prefixes = {
        "gpt": "openai",
        "o1": "openai",
        "o3": "openai",
        "claude": "anthropic",
        "gemini": "gemini",
        "grok": "xai",
        "llama": "meta",
        "mistral": "mistral",
        "command": "cohere",
        "deepseek": "deepseek",
        "qwen": "qwen",
        "nova": "amazon-nova",
    }
    lowered = str(model_id).lower()
    for prefix, provider in prefixes.items():
        if lowered.startswith(prefix):
            return provider
    if "/" in lowered:
        return lowered.split("/", 1)[0]
    return None


def _extract_provider(event: dict[str, Any], provider_map: dict[str, str]) -> str:
    payload = event.get("payload") or {}
    payload_provider = payload.get("provider")
    if payload_provider:
        return str(payload_provider)
    model_id = str(event.get("model_id") or "")
    return provider_map.get(model_id) or _fallback_provider_from_model_id(model_id) or "unknown"


def _failure_bucket(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    failure_rate = payload.get("failure_rate")
    try:
        return str(int(round(float(failure_rate) * 100)))
    except (TypeError, ValueError):
        return _normalize_text(event.get("message") or "probe_failure")


def _error_family(event: dict[str, Any]) -> str:
    payload = event.get("payload") or {}
    return str(
        payload.get("error_class")
        or payload.get("error")
        or event.get("message")
        or event.get("event_type")
        or "execution_failure"
    ).strip()


def _normalized_error_family(event: dict[str, Any]) -> str:
    return _normalize_text(_error_family(event))


def _base_incident_family(event_type: str) -> str:
    if event_type in {"pcii_threshold", "pcii_critical"}:
        return "pcii_state"
    return event_type


def _family_key(event: dict[str, Any]) -> tuple[Any, ...]:
    event_type = str(event.get("event_type") or "")
    incident_family = _base_incident_family(event_type)

    if incident_family == "probe_failure":
        return (incident_family, _failure_bucket(event))
    if incident_family == "probe_execution_failed":
        return (incident_family, _normalized_error_family(event))
    if incident_family == "cii_spike":
        return (incident_family,)
    if incident_family == "pcii_state":
        return (incident_family,)
    return (incident_family, _normalize_text(event.get("message")))


def _event_family_label(family_key: tuple[Any, ...]) -> str:
    return str(family_key[0])


def _select_representative(events: Sequence[dict[str, Any]]) -> dict[str, Any]:
    return max(
        events,
        key=lambda event: (
            _severity_rank(event.get("severity")),
            _coerce_timestamp(event.get("timestamp")),
            int(event.get("id") or 0),
        ),
    )


def _matches_suppression(
    event: dict[str, Any],
    *,
    feed_config: dict[str, Any],
) -> str | None:
    if _base_incident_family(str(event.get("event_type") or "")) != "probe_execution_failed":
        return None

    normalized_family = _normalized_error_family(event)
    family_map = {
        _normalize_text(entry): str(entry)
        for entry in feed_config["suppressed_error_families"]
    }
    if normalized_family in family_map:
        return family_map[normalized_family]

    payload = event.get("payload") or {}
    haystack = " ".join(
        [
            normalized_family,
            _normalize_text(payload.get("error")),
            _normalize_text(event.get("message")),
        ]
    )
    for pattern in feed_config["suppressed_event_patterns"]:
        normalized_pattern = _normalize_text(pattern)
        if normalized_pattern and normalized_pattern in haystack:
            return str(pattern)
    return None


def _cluster_by_time(
    events: Sequence[dict[str, Any]],
    *,
    burst_window_minutes: int,
) -> list[list[dict[str, Any]]]:
    if not events:
        return []
    sorted_events = sorted(events, key=lambda event: _coerce_timestamp(event.get("timestamp")))
    clusters: list[list[dict[str, Any]]] = []
    current_cluster: list[dict[str, Any]] = []
    burst_window = timedelta(minutes=burst_window_minutes)

    for event in sorted_events:
        if not current_cluster:
            current_cluster = [event]
            continue
        previous_ts = _coerce_timestamp(current_cluster[-1].get("timestamp"))
        current_ts = _coerce_timestamp(event.get("timestamp"))
        if current_ts - previous_ts <= burst_window:
            current_cluster.append(event)
            continue
        clusters.append(current_cluster)
        current_cluster = [event]

    if current_cluster:
        clusters.append(current_cluster)
    return clusters


def _status_for_timestamp(latest_timestamp: datetime, *, now: datetime, feed_config: dict[str, Any]) -> str | None:
    age = now - latest_timestamp
    if age <= timedelta(hours=feed_config["active_window_hours"]):
        return "active"
    if age <= timedelta(hours=feed_config["quiet_window_hours"]):
        return "quieted"
    if age <= timedelta(hours=feed_config["stale_after_hours"]):
        return "stale"
    return None


def _format_compact_timestamp(timestamp: datetime) -> str:
    return timestamp.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _duration_label(first_seen: datetime, latest_timestamp: datetime) -> str:
    span = latest_timestamp - first_seen
    total_minutes = int(span.total_seconds() // 60)
    if total_minutes <= 0:
        return "single observation"
    if total_minutes < 60:
        return f"{total_minutes}m span"
    total_hours = total_minutes // 60
    if total_hours < 48:
        return f"{total_hours}h span"
    return f"{max(1, total_hours // 24)}d span"


def _scope_entity_key(scope: str, events: Sequence[dict[str, Any]], providers: Sequence[str]) -> str | None:
    if scope == "provider":
        return providers[0] if providers else None
    if scope == "model":
        model_ids = sorted({str(event.get("model_id")) for event in events if event.get("model_id")})
        return model_ids[0] if model_ids else None
    return None


def _build_scope_groups(
    family_key: tuple[Any, ...],
    events: list[dict[str, Any]],
    *,
    provider_map: dict[str, str],
    feed_config: dict[str, Any],
) -> list[tuple[str, tuple[Any, ...], list[dict[str, Any]]]]:
    family = _event_family_label(family_key)
    if family == "pcii_state":
        return [("observatory", family_key, list(events))]

    providers_by_event = {
        id(event): _extract_provider(event, provider_map)
        for event in events
    }
    model_ids = sorted({str(event.get("model_id")) for event in events if event.get("model_id")})
    providers = sorted({providers_by_event[id(event)] for event in events})

    if (
        len(providers) >= feed_config["observatory_scope_min_providers"]
        and len(model_ids) >= feed_config["observatory_scope_min_models"]
    ):
        return [("observatory", family_key, list(events))]

    provider_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        provider_groups[providers_by_event[id(event)]].append(event)

    scoped_groups: list[tuple[str, tuple[Any, ...], list[dict[str, Any]]]] = []
    consumed_ids: set[int] = set()
    for provider, provider_events in provider_groups.items():
        provider_models = {
            str(event.get("model_id"))
            for event in provider_events
            if event.get("model_id")
        }
        if len(provider_models) < feed_config["provider_scope_min_models"]:
            continue
        scoped_groups.append(("provider", family_key + (provider,), provider_events))
        consumed_ids.update(id(event) for event in provider_events)

    remaining_events = [event for event in events if id(event) not in consumed_ids]
    if not remaining_events and scoped_groups:
        return scoped_groups

    model_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in remaining_events:
        model_id = str(event.get("model_id") or "")
        model_groups[model_id].append(event)

    for model_id, model_events in model_groups.items():
        if model_id:
            scoped_groups.append(("model", family_key + (model_id,), model_events))
        else:
            scoped_groups.append(("observatory", family_key + ("fallback",), model_events))
    return scoped_groups or [("observatory", family_key, list(events))]


def _headline_and_summary(
    *,
    scope: str,
    incident_family: str,
    representative: dict[str, Any],
    repeat_count: int,
    first_seen: datetime,
    latest_timestamp: datetime,
    affected_models: list[str],
    affected_providers: list[str],
    status: str,
) -> tuple[str, str]:
    provider_label = _titleize_provider(affected_providers[0] if affected_providers else None)
    model_label = affected_models[0] if affected_models else "Model"
    span_label = _duration_label(first_seen, latest_timestamp)
    latest_label = _format_compact_timestamp(latest_timestamp)
    repeat_label = "observed once" if repeat_count == 1 else f"repeated {repeat_count} times"

    if incident_family == "probe_failure":
        if scope == "observatory":
            headline = "Multi-provider probe failure burst"
            summary = (
                f"{len(affected_models)} models across {len(affected_providers)} providers were "
                f"{repeat_label} over a {span_label}; latest {latest_label}."
            )
            return headline, summary
        if scope == "provider":
            headline = f"{provider_label} multi-model probe failure burst"
            summary = (
                f"{len(affected_models)} {provider_label} models were {repeat_label} over a "
                f"{span_label}; latest {latest_label}."
            )
            return headline, summary
        headline = f"{model_label} sustained probe failure" if repeat_count > 1 else f"{model_label} probe failure"
        summary = f"{model_label} was {repeat_label} over a {span_label}; latest {latest_label}."
        return headline, summary

    if incident_family == "probe_execution_failed":
        error_family = _error_family(representative)
        if scope == "observatory":
            headline = "Multi-provider execution failure burst"
            summary = (
                f"{error_family} affected {len(affected_models)} models across {len(affected_providers)} "
                f"providers; {repeat_label}, latest {latest_label}."
            )
            return headline, summary
        if scope == "provider":
            headline = f"{provider_label} execution failure burst"
            summary = (
                f"{error_family} affected {len(affected_models)} {provider_label} models; "
                f"{repeat_label}, latest {latest_label}."
            )
            return headline, summary
        headline = f"{model_label} execution failure"
        summary = f"{error_family} was {repeat_label} for {model_label}; latest {latest_label}."
        return headline, summary

    if incident_family == "cii_spike":
        if scope == "observatory":
            headline = f"CII threshold spike in {len(affected_models)} models"
            summary = (
                f"CII threshold pressure was {repeat_label} across {len(affected_providers)} providers "
                f"over a {span_label}; latest {latest_label}."
            )
            return headline, summary
        if scope == "provider":
            headline = f"{provider_label} CII threshold spike"
            summary = (
                f"{len(affected_models)} {provider_label} models crossed the CII threshold and were "
                f"{repeat_label}; latest {latest_label}."
            )
            return headline, summary
        headline = f"{model_label} CII threshold spike"
        summary = f"{model_label} crossed the CII threshold and was {repeat_label}; latest {latest_label}."
        return headline, summary

    if incident_family == "pcii_state":
        headline = (
            "Observatory PCII entered critical state"
            if str(representative.get("event_type")) == "pcii_critical"
            else "Observatory PCII exceeded threshold"
        )
        summary = f"Aggregate PCII state was {repeat_label} over a {span_label}; latest {latest_label}."
        return headline, summary

    headline = str(representative.get("message") or representative.get("event_type") or "Observatory incident")
    if scope == "observatory":
        summary = f"{repeat_label.capitalize()} across the observatory; latest {latest_label}."
    elif scope == "provider":
        summary = f"{repeat_label.capitalize()} across {provider_label}; latest {latest_label}."
    else:
        summary = f"{repeat_label.capitalize()} for {model_label}; latest {latest_label}."
    if status != "active":
        summary = f"{summary[:-1]}; state inferred from non-recurrence."
    return headline, summary


def _build_board_item(
    *,
    family_key: tuple[Any, ...],
    scope: str,
    scoped_events: list[dict[str, Any]],
    provider_map: dict[str, str],
    now: datetime,
    feed_config: dict[str, Any],
) -> dict[str, Any] | None:
    representative = _select_representative(scoped_events)
    timestamps = [_coerce_timestamp(event.get("timestamp")) for event in scoped_events]
    latest_timestamp = max(timestamps)
    status = _status_for_timestamp(latest_timestamp, now=now, feed_config=feed_config)
    if status is None:
        return None

    first_seen = min(timestamps)
    affected_models = sorted(
        {
            str(event.get("model_id"))
            for event in scoped_events
            if event.get("model_id")
        }
    )
    affected_providers = sorted(
        {
            _extract_provider(event, provider_map)
            for event in scoped_events
        }
    )
    incident_family = _event_family_label(family_key)
    headline, summary = _headline_and_summary(
        scope=scope,
        incident_family=incident_family,
        representative=representative,
        repeat_count=len(scoped_events),
        first_seen=first_seen,
        latest_timestamp=latest_timestamp,
        affected_models=affected_models,
        affected_providers=affected_providers,
        status=status,
    )
    entity_key = _scope_entity_key(scope, scoped_events, affected_providers)
    incident_id = "|".join(
        [
            incident_family,
            scope,
            str(entity_key or "all"),
            str(family_key[-1] if len(family_key) > 1 else incident_family),
        ]
    )
    return {
        "incident_id": incident_id,
        "incident_family": incident_family,
        "scope": scope,
        "severity": representative.get("severity"),
        "status": status,
        "headline": headline,
        "summary": summary,
        "latest_timestamp": latest_timestamp.isoformat(),
        "first_seen": first_seen.isoformat(),
        "repeat_count": len(scoped_events),
        "source_event_count": len(scoped_events),
        "rollup_count": max(0, len(scoped_events) - 1),
        "affected_models": affected_models,
        "affected_providers": affected_providers,
        "latest_transition": TRANSITION_LABELS[status],
        "status_hint": "active_fresh" if status == "active" else f"{status}_inferred",
        "event_type": representative.get("event_type"),
        "metric_name": representative.get("metric_name"),
        "payload": representative.get("payload"),
        "model_id": affected_models[0] if scope == "model" and len(affected_models) == 1 else None,
    }


def _merge_board_items(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str, str | None], list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        entity_key = None
        if item["scope"] == "provider":
            entity_key = item["affected_providers"][0] if item["affected_providers"] else None
        elif item["scope"] == "model":
            entity_key = item["model_id"]
        merged[(item["incident_family"], item["scope"], entity_key)].append(item)

    merged_items: list[dict[str, Any]] = []
    for _, grouped_items in merged.items():
        if len(grouped_items) == 1:
            merged_items.append(grouped_items[0])
            continue
        representative = max(
            grouped_items,
            key=lambda item: (
                _severity_rank(item.get("severity")),
                _coerce_timestamp(item.get("latest_timestamp")),
            ),
        )
        latest_timestamp = max(_coerce_timestamp(item["latest_timestamp"]) for item in grouped_items)
        first_seen = min(_coerce_timestamp(item["first_seen"]) for item in grouped_items)
        repeat_count = sum(int(item.get("repeat_count", 0)) for item in grouped_items)
        source_event_count = sum(int(item.get("source_event_count", 0)) for item in grouped_items)
        affected_models = sorted(
            {
                model_id
                for item in grouped_items
                for model_id in item.get("affected_models", [])
            }
        )
        affected_providers = sorted(
            {
                provider
                for item in grouped_items
                for provider in item.get("affected_providers", [])
            }
        )
        merged_item = dict(representative)
        merged_item["latest_timestamp"] = latest_timestamp.isoformat()
        merged_item["first_seen"] = first_seen.isoformat()
        merged_item["repeat_count"] = repeat_count
        merged_item["source_event_count"] = source_event_count
        merged_item["rollup_count"] = max(0, source_event_count - 1)
        merged_item["affected_models"] = affected_models
        merged_item["affected_providers"] = affected_providers
        merged_item["status"] = representative["status"]
        merged_item["latest_transition"] = TRANSITION_LABELS[merged_item["status"]]
        headline, summary = _headline_and_summary(
            scope=merged_item["scope"],
            incident_family=merged_item["incident_family"],
            representative=merged_item,
            repeat_count=repeat_count,
            first_seen=first_seen,
            latest_timestamp=latest_timestamp,
            affected_models=affected_models,
            affected_providers=affected_providers,
            status=merged_item["status"],
        )
        merged_item["headline"] = headline
        merged_item["summary"] = summary
        merged_items.append(merged_item)
    return merged_items


def _limit_board_items(
    items: Sequence[dict[str, Any]],
    *,
    max_items: int,
) -> list[dict[str, Any]]:
    ordered = sorted(
        items,
        key=lambda item: (
            STATUS_PRIORITY.get(str(item.get("status")), 99),
            -_severity_rank(item.get("severity")),
            -_coerce_timestamp(item.get("latest_timestamp")).timestamp(),
        ),
    )
    return ordered[:max_items]


def _board_meta(
    *,
    source_event_count: int,
    visible_event_count: int,
    suppressed_reasons: Counter[str],
    total_unsuppressed_items: int,
    total_unsuppressed_events: int,
) -> dict[str, Any]:
    return {
        "source_event_count": source_event_count,
        "visible_event_count": visible_event_count,
        "suppressed_count": sum(suppressed_reasons.values()),
        "suppressed_reasons": [
            {"reason": reason, "count": count}
            for reason, count in suppressed_reasons.most_common()
        ],
        "rollup_count": max(0, total_unsuppressed_events - total_unsuppressed_items),
    }


def build_public_incident_board(
    raw_events: Sequence[dict[str, Any]],
    *,
    observatory_config: dict[str, Any] | None = None,
    now: datetime | None = None,
    max_items: int | None = None,
) -> dict[str, Any]:
    observatory_config = observatory_config or load_observatory_config()
    feed_config = get_public_feed_config(observatory_config)
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    source_event_count = len(raw_events)
    stale_cutoff = current_time - timedelta(hours=feed_config["stale_after_hours"])
    visible_events = [
        dict(event)
        for event in raw_events
        if _coerce_timestamp(event.get("timestamp")) >= stale_cutoff
    ]
    visible_event_count = len(visible_events)
    provider_map = _model_provider_map(observatory_config)

    suppressed_reasons: Counter[str] = Counter()
    unsuppressed_events: list[dict[str, Any]] = []
    for event in visible_events:
        suppression_reason = _matches_suppression(event, feed_config=feed_config)
        if suppression_reason:
            suppressed_reasons[suppression_reason] += 1
            continue
        unsuppressed_events.append(event)

    grouped_events: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for event in unsuppressed_events:
        grouped_events[_family_key(event)].append(event)

    board_items: list[dict[str, Any]] = []
    for family_key, family_events in grouped_events.items():
        for cluster in _cluster_by_time(
            family_events,
            burst_window_minutes=feed_config["burst_window_minutes"],
        ):
            scope_groups = _build_scope_groups(
                family_key,
                cluster,
                provider_map=provider_map,
                feed_config=feed_config,
            )
            for scope, scoped_key, scoped_events in scope_groups:
                item = _build_board_item(
                    family_key=scoped_key,
                    scope=scope,
                    scoped_events=scoped_events,
                    provider_map=provider_map,
                    now=current_time,
                    feed_config=feed_config,
                )
                if item is not None:
                    board_items.append(item)

    merged_items = _merge_board_items(board_items)
    limited_items = _limit_board_items(
        merged_items,
        max_items=max_items or feed_config["max_items"],
    )

    board = {
        "generated_at": current_time.isoformat(),
        "meta": _board_meta(
            source_event_count=source_event_count,
            visible_event_count=visible_event_count,
            suppressed_reasons=suppressed_reasons,
            total_unsuppressed_items=len(merged_items),
            total_unsuppressed_events=len(unsuppressed_events),
        ),
        "active": [],
        "quieted": [],
        "stale": [],
    }
    for item in limited_items:
        board[item["status"]].append(item)
    return board


def _compat_message(item: dict[str, Any]) -> str:
    return str(item.get("summary") or item.get("headline") or item.get("incident_family") or "Observatory incident")


def flatten_incident_board(board: dict[str, Any]) -> list[dict[str, Any]]:
    items = [
        *board.get("active", []),
        *board.get("quieted", []),
        *board.get("stale", []),
    ]
    flattened: list[dict[str, Any]] = []
    for item in items:
        flattened.append(
            {
                "event_type": item.get("event_type"),
                "incident_family": item.get("incident_family"),
                "severity": item.get("severity"),
                "model_id": item.get("model_id"),
                "metric_name": item.get("metric_name"),
                "message": _compat_message(item),
                "timestamp": item.get("latest_timestamp"),
                "first_seen": item.get("first_seen"),
                "repeat_count": item.get("repeat_count"),
                "payload": item.get("payload"),
                "status_hint": item.get("status_hint"),
            }
        )
    return flattened


def build_public_incidents(
    raw_events: Sequence[dict[str, Any]],
    *,
    observatory_config: dict[str, Any] | None = None,
    now: datetime | None = None,
    max_items: int | None = None,
    fallback_max_items: int | None = None,
) -> list[dict[str, Any]]:
    del fallback_max_items
    board = build_public_incident_board(
        raw_events,
        observatory_config=observatory_config,
        now=now,
        max_items=max_items,
    )
    return flatten_incident_board(board)
