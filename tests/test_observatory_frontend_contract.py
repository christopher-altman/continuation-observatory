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
    assert "projectNodeScreenState(entry)" in field_source
    assert "pickNodeAtClientPoint(clientX, clientY)" in field_source
    assert "this.updateHover(event.clientX, event.clientY);" in field_source
    assert "? this.pickNodeAtClientPoint(clientX, clientY)" in field_source
    assert "function canonicalEdgePair(edge)" in field_source
    assert "function uniqueStableEdges(edges)" in field_source
    assert "function selectGuideEdges(payload, focusId, hoverId, compareMode, nodeCount)" in field_source

    pointerdown_block = field_source.split("onPointerDown(event) {", 1)[1].split("onKeyDown(event) {", 1)[0]
    assert "const pickedNode = this.pickNodeAtClientPoint(event.clientX, event.clientY);" in pointerdown_block
    assert "window.dispatchEvent(new CustomEvent(\"observatory:clear-focus\"));" in pointerdown_block
    assert pointerdown_block.index("const pickedNode = this.pickNodeAtClientPoint(event.clientX, event.clientY);") < pointerdown_block.index("window.dispatchEvent(new CustomEvent(\"observatory:clear-focus\"));")

    pointerleave_block = field_source.split("onPointerLeave() {", 1)[1].split("onPointerDown(event) {", 1)[0]
    assert "if (!this.focusId) {" in pointerleave_block
    assert "this.rebuildGuides();" in pointerleave_block

    updatehover_block = field_source.split("updateHover(clientX = this._clientX, clientY = this._clientY) {", 1)[1].split("updateTooltipPosition() {", 1)[0]
    assert "if (prevHover !== this.hoverId && !this.focusId) {" in updatehover_block
    assert "this.rebuildGuides();" in updatehover_block

    assert "/* ── Shell sphere — primary body mass for idle readability ── */" in field_source
    assert "/* ── Center node — bright core point (hero centerNode style) ── */" in field_source
    assert "/* ── Internal field contours — structural objecthood cue ── */" in field_source
    assert "/* ── Siri-orb internals are intentionally suppressed in this restore pass ── */" in field_source
    assert "chapterRing" in field_source
    assert "tickGlowRing" in field_source
    assert "chassisArcs" in field_source
    assert "entry.focusedCore.siriRibbons.forEach" in field_source
    assert "entry.focusedCore.siriGlowSphere.material.opacity" in field_source
    assert "entry.focusedCore.siriCenter.material.opacity" in field_source
    assert "entry.focusedCore.siriRim.material.opacity" in field_source
    assert '"AZIMUTH 000"' in field_source
    assert '"LOCK WINDOW"' in field_source
