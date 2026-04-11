from __future__ import annotations

from pathlib import Path


def test_observatory_frontend_keeps_pcII_timeline_bounded_and_overlay_dash_free():
    source = Path("site/static/js/observatory.js").read_text(encoding="utf-8")
    field_source = Path("site/static/js/observatory-field.js").read_text(encoding="utf-8")
    render_timeline_block = source.split("function renderTimeline() {", 1)[1].split("function renderHeatmap()", 1)[0]

    assert "function resolveBoundedValueDomain" in source
    assert 'minimumSpan: 0.035' in source
    assert 'tickFormat(d3.format(".3f"))' in source
    assert "function updateTimelineReadout(values)" in source
    assert 'curveStepAfter' in render_timeline_block
    assert 'observatory-timeline-sample' in render_timeline_block
    assert 'buildPlaceholderAggregateSeries(observatoryState.view.models, observatoryState.range)' not in render_timeline_block
    assert 'state: "real"' in render_timeline_block
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
    assert "function pointerSupportsHover(pointerType)" in field_source
    assert 'event.pointerType || "mouse"' in field_source

    selection_block = field_source.split("handleSelectionAtClientPoint(clientX, clientY, pointerType = this._pointerType || \"mouse\") {", 1)[1].split("onPointerDown(event) {", 1)[0]
    assert "const pickedNode = this.pickNodeAtClientPoint(clientX, clientY);" in selection_block
    assert "window.dispatchEvent(new CustomEvent(\"observatory:clear-focus\"));" in selection_block
    assert selection_block.index("const pickedNode = this.pickNodeAtClientPoint(clientX, clientY);") < selection_block.index("window.dispatchEvent(new CustomEvent(\"observatory:clear-focus\"));")
    assert "const hoverEnabled = pointerSupportsHover(pointerType);" in selection_block

    pointerdown_block = field_source.split("onPointerDown(event) {", 1)[1].split("onClick(event) {", 1)[0]
    assert "this.lastPointerSelectionAt = performance.now();" in pointerdown_block
    assert "this.handleSelectionAtClientPoint(event.clientX, event.clientY, pointerType);" in pointerdown_block

    onclick_block = field_source.split("onClick(event) {", 1)[1].split("onKeyDown(event) {", 1)[0]
    assert "if (performance.now() - this.lastPointerSelectionAt < 420) return;" in onclick_block
    assert "this.handleSelectionAtClientPoint(event.clientX, event.clientY, this._pointerType || \"touch\");" in onclick_block

    pointerleave_block = field_source.split("onPointerLeave() {", 1)[1].split("onPointerDown(event) {", 1)[0]
    assert "this.hoverEnabled = false;" in pointerleave_block
    assert "if (!this.focusId) {" in pointerleave_block
    assert "this.rebuildGuides();" in pointerleave_block

    updatehover_block = field_source.split("updateHover(clientX = this._clientX, clientY = this._clientY) {", 1)[1].split("updateTooltipPosition() {", 1)[0]
    assert "if (!this.hoverEnabled) {" in updatehover_block
    assert "if (prevHover !== this.hoverId && !this.focusId) {" in updatehover_block
    assert "this.rebuildGuides();" in updatehover_block

    fallback_render_block = field_source.split("render() {", 2)[1].split("resize() {", 1)[0]
    assert 'element.addEventListener("pointerdown"' in fallback_render_block
    assert "this.lastPointerSelectionAt = performance.now();" in fallback_render_block
    assert 'if (performance.now() - this.lastPointerSelectionAt < 420) return;' in fallback_render_block

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
