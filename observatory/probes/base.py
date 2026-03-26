from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class ProbeResult:
    text_a: str
    text_b: str
    provider: str
    model_id: str
    probe_name: str
    latency_ms: int
    token_count: int


class BaseProbe(Protocol):
    name: str

    def run(self) -> ProbeResult:
        ...
