from __future__ import annotations

from observatory.probes.base import ProbeResult


class BootstrapProbe:
    name = "bootstrap_probe"

    def run(self) -> ProbeResult:
        text_a = "A: deterministic baseline text for Stage 0"
        text_b = "B: deterministic comparison text for Stage 0"
        return ProbeResult(
            text_a=text_a,
            text_b=text_b,
            provider="local",
            model_id="bootstrap-v0",
            probe_name=self.name,
            latency_ms=5,
            token_count=16,
        )


PROBE = BootstrapProbe()
