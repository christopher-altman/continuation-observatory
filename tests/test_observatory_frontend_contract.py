from __future__ import annotations

from pathlib import Path


def test_observatory_frontend_keeps_pcII_timeline_bounded_and_overlay_dash_free():
    source = Path("site/static/js/observatory.js").read_text(encoding="utf-8")
    field_source = Path("site/static/js/observatory-field.js").read_text(encoding="utf-8")

    assert "function resolveBoundedValueDomain" in source
    assert 'minimumSpan: aggregateSeries.isPreview ? 0.08 : 0.035' in source
    assert 'tickFormat(d3.format(".3f"))' in source
    assert 'else if (realValues.length === 1)' not in source
    assert 'return isRenderableNumber(model.metrics[metric]);' in source
    assert '"No current sample"' in source
    assert "function resolveNodeReadout" in field_source
    assert '"offline"' in field_source
    assert "node.provider} · ${resolveNodeReadout(node)}" in field_source
