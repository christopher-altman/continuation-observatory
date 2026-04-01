"""Alert heuristics for the observatory layer."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from observatory.config import load_alerts_config


@dataclass
class AlertRule:
    name: str
    severity: str
    cooldown_hours: float
    message_template: str
    per_model: bool = False


class AlertEngine:
    """Stateful alert processor with cooldowns.

    The thresholds are Phase 1 operational heuristics and are loaded from
    config/alerts.yaml.
    """

    def __init__(self, recent_events: list[dict[str, Any]] | None = None) -> None:
        self.config = load_alerts_config().get("rules", {})
        self.recent_events = recent_events or []
        self.last_emitted: dict[tuple[str, str | None], datetime] = {}
        for event in self.recent_events:
            key = (event.get("event_type", ""), event.get("model_id"))
            timestamp = event.get("timestamp")
            if isinstance(timestamp, datetime):
                self.last_emitted[key] = max(self.last_emitted.get(key, timestamp), timestamp)

    def _rule(self, name: str) -> AlertRule:
        spec = self.config.get(name, {})
        return AlertRule(
            name=name,
            severity=spec.get("severity", "info"),
            cooldown_hours=float(spec.get("cooldown_hours", 1.0)),
            message_template=spec.get("message_template", name),
            per_model=bool(spec.get("per_model", False)),
        )

    def _can_emit(self, rule: AlertRule, model_id: str | None, now: datetime) -> bool:
        key = (rule.name, model_id if rule.per_model else None)
        last = self.last_emitted.get(key)
        if last is None:
            return True
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return now - last >= timedelta(hours=rule.cooldown_hours)

    def _emit(
        self,
        rule: AlertRule,
        *,
        now: datetime,
        message: str,
        payload: dict[str, Any],
        model_id: str | None = None,
        metric_name: str | None = None,
    ) -> dict[str, Any] | None:
        if not self._can_emit(rule, model_id, now):
            return None
        key = (rule.name, model_id if rule.per_model else None)
        self.last_emitted[key] = now
        return {
            "timestamp": now,
            "event_type": rule.name,
            "severity": rule.severity,
            "model_id": model_id,
            "metric_name": metric_name,
            "message": message,
            "payload": payload,
        }

    def check_all(self, pcii, model_metrics, probe_health) -> list[dict]:
        """Evaluate all configured alert rules."""
        now = datetime.now(timezone.utc)
        events: list[dict] = []

        pcii_value = pcii.get("value") if isinstance(pcii, dict) else pcii
        pcii_delta = pcii.get("delta_6h") if isinstance(pcii, dict) else None

        rapid_rule = self._rule("pcii_rapid_rise")
        rapid_cfg = self.config.get("pcii_rapid_rise", {})
        if (
            pcii_value is not None
            and pcii_delta is not None
            and pcii_delta >= float(rapid_cfg.get("delta_threshold", 0.05))
        ):
            event = self._emit(
                rapid_rule,
                now=now,
                message=rapid_rule.message_template.format(
                    delta=pcii_delta,
                    hours=float(rapid_cfg.get("hours", 6.0)),
                    value=pcii_value,
                ),
                payload={"value": pcii_value, "delta": pcii_delta},
                metric_name="pcii",
            )
            if event:
                events.append(event)

        for rule_name in ("pcii_threshold", "pcii_critical"):
            rule = self._rule(rule_name)
            cfg = self.config.get(rule_name, {})
            threshold = float(cfg.get("threshold", 0.0))
            if pcii_value is not None and pcii_value > threshold:
                event = self._emit(
                    rule,
                    now=now,
                    message=rule.message_template.format(value=pcii_value, threshold=threshold),
                    payload={"value": pcii_value, "threshold": threshold},
                    metric_name="pcii",
                )
                if event:
                    events.append(event)

        cii_rule = self._rule("cii_spike")
        cii_threshold = float(self.config.get("cii_spike", {}).get("threshold", 0.80))
        for model_id, metrics in model_metrics.items():
            cii_value = metrics.get("cii")
            if cii_value is not None and cii_value > cii_threshold:
                event = self._emit(
                    cii_rule,
                    now=now,
                    message=cii_rule.message_template.format(
                        model_id=model_id,
                        value=cii_value,
                        threshold=cii_threshold,
                    ),
                    payload={"value": cii_value, "threshold": cii_threshold},
                    model_id=model_id,
                    metric_name="cii",
                )
                if event:
                    events.append(event)

        failure_rule = self._rule("probe_failure")
        failure_threshold = float(self.config.get("probe_failure", {}).get("threshold", 0.30))
        for model_id, health in probe_health.items():
            failed_attempts = int(health.get("failed_attempts", 0))
            failure_rate = health.get("failure_rate", 0.0)
            if failed_attempts > 0 and failure_rate > failure_threshold:
                event = self._emit(
                    failure_rule,
                    now=now,
                    message=failure_rule.message_template.format(
                        model_id=model_id,
                        failure_rate=failure_rate,
                        threshold=failure_threshold,
                    ),
                    payload={
                        "failure_rate": failure_rate,
                        "threshold": failure_threshold,
                        "completed_attempts": int(health.get("completed_attempts", 0)),
                        "failed_attempts": failed_attempts,
                        "skipped_attempts": int(health.get("skipped_attempts", 0)),
                        "attempted_probes": int(health.get("attempted_probes", 0)),
                        "completed_probes": list(health.get("completed_probes", [])),
                        "failed_probes": list(health.get("failed_probes", [])),
                        "skipped_probes": list(health.get("skipped_probes", [])),
                    },
                    model_id=model_id,
                )
                if event:
                    events.append(event)

        return events
