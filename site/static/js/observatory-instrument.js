/*
 * observatory-instrument.js — vNext Direction A, Phase 2 (additive module).
 *
 * Semantic instrument layer: renders the per-model measurement ring and the
 * aggregate/focused core readout from data the page has already loaded.
 *
 * Boundaries (by design):
 *  - Reads ONLY the public window.__observatoryDebug API (getState/setFocusModel)
 *    plus the bundled snapshot URL as a fallback. It never patches, wraps, or
 *    monkey-patches the contract-pinned observatory.js / observatory-field.js.
 *  - Encodes ONLY real data: CII per model, rank band (flagship/secondary/outer,
 *    mirroring the page's rank rule), acquisition state from the snapshot's own
 *    live/stale flags, and the constellation gate threshold.
 *  - Sparse/stale telemetry renders as explicit state, never as fake fullness.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var VIEW_HALF = 500;
  var R_INNER = 318;
  var R_OUTER = 472;
  var POLL_MS = 400;
  var STATE_WAIT_MS = 250;
  var STATE_WAIT_TRIES = 60;

  var root = document.querySelector("[data-observatory-root]");
  var ringHost = document.getElementById("observatory-status-ring");
  var readoutHost = document.getElementById("observatory-core-readout");
  if (!root || !ringHost || !readoutHost) return;

  var fieldFrame = root.querySelector(".observatory-field-frame");
  var readoutLabel = document.getElementById("observatory-core-readout-label");
  var readoutValue = document.getElementById("observatory-core-readout-value");
  var readoutMeta = document.getElementById("observatory-core-readout-meta");
  var readoutLegend = document.getElementById("observatory-core-readout-legend");

  var lastFocusId;
  var lastViewRef;
  var lastRange;
  var segmentsById = {};

  /* --- Phase 3: measurement catalog --- */
  var METRIC_KEYS = ["cii", "srs", "ips", "mpg", "tci", "edp"];
  var RANGE_MS = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
  var STATE_ORDER = { live: 0, recent: 1, stale: 2 };
  var ASC_DEFAULT_KEYS = ["display_name", "provider", "rank", "state"];
  var catalogSort = { key: "cii", dir: "desc" };
  var catalogBody = document.getElementById("observatory-catalog-body");
  var catalogTable = document.getElementById("observatory-catalog-table");
  var catalogEmpty = document.getElementById("observatory-catalog-empty");
  var catalogWindowChip = document.getElementById("observatory-catalog-window");
  var catalogCountChip = document.getElementById("observatory-catalog-count");
  var catalogSortWired = false;
  var catalogRendered = false;
  var lastRender = null;

  function getDebug() {
    return window.__observatoryDebug || null;
  }

  function getState() {
    var debug = getDebug();
    if (!debug || typeof debug.getState !== "function") return null;
    try {
      return debug.getState();
    } catch (_) {
      return null;
    }
  }

  function modelCii(model) {
    if (typeof model.rangeCii === "number") return model.rangeCii;
    if (model.metrics && typeof model.metrics.cii === "number") return model.metrics.cii;
    return null;
  }

  function acquisitionState(model) {
    if (model.live) return "live";
    if (model.stale) return "stale";
    return "recent";
  }

  function bandForRank(rank) {
    if (rank <= 3) return "flagship";
    if (rank <= 7) return "secondary";
    return "outer";
  }

  function rankedModels(state, snapshot) {
    var models = null;
    if (state && state.view && Array.isArray(state.view.models) && state.view.models.length) {
      models = state.view.models;
    } else if (snapshot && Array.isArray(snapshot.models)) {
      models = snapshot.models.slice().sort(function (a, b) {
        return (modelCii(b) || 0) - (modelCii(a) || 0);
      });
      models.forEach(function (model, index) {
        if (typeof model.rank !== "number") model.rank = index + 1;
      });
    }
    return models || [];
  }

  function gateThreshold(state, snapshot) {
    if (state && state.view && state.view.summary && typeof state.view.summary.constellation_threshold === "number") {
      return state.view.summary.constellation_threshold;
    }
    if (snapshot && snapshot.summary && typeof snapshot.summary.constellation_threshold === "number") {
      return snapshot.summary.constellation_threshold;
    }
    return 0.6;
  }

  function relativeAge(isoString) {
    if (!isoString) return "no timestamp";
    var then = Date.parse(isoString);
    if (Number.isNaN(then)) return "no timestamp";
    var deltaMs = Date.now() - then;
    if (deltaMs < 0) return "just now";
    var hours = deltaMs / 3600000;
    if (hours < 1) return Math.max(1, Math.round(deltaMs / 60000)) + "m ago";
    if (hours < 48) return Math.round(hours) + "h ago";
    return Math.round(hours / 24) + "d ago";
  }

  function fmt(value) {
    return typeof value === "number" && isFinite(value) ? value.toFixed(3) : "–.–––";
  }

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      node.setAttribute(key, attrs[key]);
    });
    return node;
  }

  function polar(angleDeg, radius) {
    var rad = (angleDeg - 90) * (Math.PI / 180);
    return [VIEW_HALF + radius * Math.cos(rad), VIEW_HALF + radius * Math.sin(rad)];
  }

  function setFocus(modelId) {
    var debug = getDebug();
    if (!debug || typeof debug.setFocusModel !== "function") return;
    var state = getState();
    var current = state ? state.focusModelId : null;
    try {
      debug.setFocusModel(current === modelId ? null : modelId);
    } catch (_) {}
  }

  function buildRing(models, gate, focusId) {
    var svg = el("svg", {
      viewBox: "0 0 " + VIEW_HALF * 2 + " " + VIEW_HALF * 2,
      role: "group",
      "aria-label": "Per-model continuation signal ring. Blade length encodes CII; color encodes acquisition state.",
    });
    segmentsById = {};

    // Gate reference circle — the instrument's real constellation threshold.
    svg.appendChild(el("circle", {
      class: "obs-iring-gate",
      cx: VIEW_HALF,
      cy: VIEW_HALF,
      r: R_INNER + gate * (R_OUTER - R_INNER),
    }));
    var gateLabel = el("text", {
      class: "obs-iring-gate-label",
      x: VIEW_HALF,
      y: VIEW_HALF - (R_INNER + gate * (R_OUTER - R_INNER)) - 10,
      "text-anchor": "middle",
    });
    gateLabel.textContent = "GATE " + gate.toFixed(2);
    svg.appendChild(gateLabel);

    var count = models.length;
    models.forEach(function (model, index) {
      var cii = modelCii(model);
      var hasReading = typeof cii === "number" && isFinite(cii);
      var clamped = hasReading ? Math.max(0, Math.min(1, cii)) : 0;
      var angle = (360 / count) * index;
      var state = acquisitionState(model);
      var band = bandForRank(model.rank || index + 1);

      var group = el("g", {
        class:
          "obs-iseg obs-iseg--" + state +
          " obs-iseg--band-" + band +
          (hasReading && clamped < gate ? " obs-iseg--belowgate" : "") +
          (!hasReading ? " obs-iseg--nodata" : "") +
          (model.model_id === focusId ? " is-focused" : ""),
        role: "button",
        tabindex: "0",
        "data-model-id": model.model_id,
        "aria-label":
          (model.display_name || model.model_id) +
          " — CII " + (hasReading ? fmt(clamped) : "no reading") +
          ", " + state +
          (model.model_id === focusId ? ", focused" : "") +
          ". Activate to focus.",
        "aria-pressed": model.model_id === focusId ? "true" : "false",
      });

      var title = document.createElementNS(SVG_NS, "title");
      title.textContent =
        (model.display_name || model.model_id) +
        " · CII " + (hasReading ? fmt(clamped) : "no reading") +
        " · " + state + " · last seen " + relativeAge(model.last_seen);
      group.appendChild(title);

      var trackStart = polar(angle, R_INNER);
      var trackEnd = polar(angle, R_OUTER);
      group.appendChild(el("line", {
        class: "obs-iseg-track",
        x1: trackStart[0], y1: trackStart[1],
        x2: trackEnd[0], y2: trackEnd[1],
      }));

      if (hasReading) {
        var bladeEnd = polar(angle, R_INNER + clamped * (R_OUTER - R_INNER));
        group.appendChild(el("line", {
          class: "obs-iseg-blade",
          x1: trackStart[0], y1: trackStart[1],
          x2: bladeEnd[0], y2: bladeEnd[1],
          "stroke-width": band === "flagship" ? 17 : band === "secondary" ? 12 : 8,
        }));
      } else {
        // Honest no-reading marker: hollow dot at the track base, no blade.
        group.appendChild(el("circle", {
          class: "obs-iseg-nodata-dot",
          cx: trackStart[0], cy: trackStart[1], r: 7,
        }));
      }

      if (model.model_id === focusId) {
        var b1 = polar(angle, R_OUTER + 16);
        group.appendChild(el("circle", {
          class: "obs-iseg-focus-mark",
          cx: b1[0], cy: b1[1], r: 9,
        }));
      }

      group.addEventListener("click", function () { setFocus(model.model_id); });
      group.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          setFocus(model.model_id);
        }
      });

      segmentsById[model.model_id] = group;
      svg.appendChild(group);
    });

    ringHost.textContent = "";
    ringHost.appendChild(svg);
    ringHost.hidden = count === 0;
  }

  function updateReadout(models, state, snapshot, gate) {
    var focusId = state ? state.focusModelId : null;
    var focused = null;
    for (var i = 0; i < models.length; i += 1) {
      if (models[i].model_id === focusId) { focused = models[i]; break; }
    }

    var readings = models
      .map(modelCii)
      .filter(function (v) { return typeof v === "number" && isFinite(v); });
    var mean = readings.length
      ? readings.reduce(function (a, b) { return a + b; }, 0) / readings.length
      : null;

    var liveCount = models.filter(function (m) { return m.live; }).length;
    var staleCount = models.filter(function (m) { return !m.live && m.stale; }).length;
    var recentCount = models.length - liveCount - staleCount;
    var range = (state && state.range) || "24h";

    var signal = null;
    if (focused) {
      var focusedCii = modelCii(focused);
      signal = focusedCii;
      readoutLabel.textContent = "Focused signal — " + (focused.display_name || focused.model_id);
      readoutValue.textContent = fmt(focusedCii);
      readoutValue.dataset.gate = typeof focusedCii === "number" && focusedCii >= gate ? "above" : "below";
      readoutMeta.textContent =
        "CII · rank " + (focused.rank || "–") + "/" + models.length +
        " · " + acquisitionState(focused) +
        " · last seen " + relativeAge(focused.last_seen) +
        (state && state.mode !== "live" ? " · snapshot" : "");
    } else {
      signal = mean;
      readoutLabel.textContent = "Aggregate continuation signal";
      readoutValue.textContent = fmt(mean);
      readoutValue.dataset.gate = typeof mean === "number" && mean >= gate ? "above" : "below";
      if (readings.length === 0) {
        readoutMeta.textContent = "no readings in the current bundle";
      } else if (liveCount === 0) {
        var generated = snapshot && snapshot.generated_at ? snapshot.generated_at : null;
        readoutMeta.textContent =
          "bundle mean of " + readings.length + " models · 0 live · " +
          (generated ? "bundle " + String(generated).slice(0, 10) : "window " + range);
      } else {
        readoutMeta.textContent =
          "mean of " + readings.length + " models · " + liveCount + " live · window " + range +
          (state && state.mode !== "live" ? " · snapshot" : "");
      }
    }

    readoutLegend.textContent =
      "ring: blade = CII · " + liveCount + " live · " + recentCount + " recent · " +
      staleCount + " stale · gate " + gate.toFixed(2);

    if (fieldFrame && typeof signal === "number" && isFinite(signal)) {
      fieldFrame.style.setProperty("--obs-core-signal", String(Math.max(0, Math.min(1, signal))));
    }
    readoutHost.hidden = false;
  }

  /* --- Phase 3: measurement catalog (sortable table, row focus-sync,
         honest per-row trend states) --- */

  function rangeFilter(series, range) {
    var windowMs = RANGE_MS[range] || RANGE_MS["24h"];
    var cutoff = Date.now() - windowMs;
    return (series || []).filter(function (entry) {
      var t = Date.parse(entry.timestamp || entry.t || "");
      return !Number.isNaN(t) && t >= cutoff;
    });
  }

  function trendInfo(model, state, snapshot) {
    var raw = snapshot && snapshot.cii_history ? snapshot.cii_history[model.model_id] : null;
    var filtered = Array.isArray(model.ciiHistory)
      ? model.ciiHistory
      : (Array.isArray(raw) ? rangeFilter(raw, (state && state.range) || "24h") : null);
    if (!Array.isArray(raw) && !Array.isArray(filtered)) return { kind: "unavailable" };
    if (!filtered || filtered.length === 0) return { kind: "short" };
    if (filtered.length < 3) return { kind: "collecting" };
    return {
      kind: "series",
      points: filtered,
      delta: filtered[filtered.length - 1].value - filtered[0].value,
    };
  }

  function sparklineSvg(points) {
    var w = 64;
    var h = 18;
    var pad = 2;
    var values = points.map(function (p) { return p.value; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min;
    var svg = el("svg", {
      class: "obs-cat-spark",
      viewBox: "0 0 " + w + " " + h,
      "aria-hidden": "true",
      focusable: "false",
    });
    var coords = points.map(function (p, i) {
      var x = pad + (w - 2 * pad) * (points.length === 1 ? 0.5 : i / (points.length - 1));
      var y = span > 0 ? (h - pad) - (h - 2 * pad) * ((p.value - min) / span) : h / 2;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    svg.appendChild(el("polyline", { points: coords.join(" ") }));
    return svg;
  }

  function catalogValue(model, key, state, snapshot) {
    if (key === "display_name") return model.display_name || model.model_id;
    if (key === "provider") return model.provider || null;
    if (key === "rank") return typeof model.rank === "number" ? model.rank : null;
    if (key === "cii") return modelCii(model);
    if (METRIC_KEYS.indexOf(key) !== -1) {
      var v = model.metrics ? model.metrics[key] : null;
      return typeof v === "number" && isFinite(v) ? v : null;
    }
    if (key === "trend") {
      var t = trendInfo(model, state, snapshot);
      return t.kind === "series" ? t.delta : null;
    }
    if (key === "state") return STATE_ORDER[acquisitionState(model)];
    if (key === "last_seen") {
      var ts = Date.parse(model.last_seen || "");
      return Number.isNaN(ts) ? null : ts;
    }
    return null;
  }

  function sortModels(models, state, snapshot) {
    var key = catalogSort.key;
    var dir = catalogSort.dir === "asc" ? 1 : -1;
    var decorated = models.map(function (m, i) {
      return { m: m, i: i, v: catalogValue(m, key, state, snapshot) };
    });
    decorated.sort(function (a, b) {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1; /* missing values sort last regardless of direction */
      if (b.v === null) return -1;
      var cmp = typeof a.v === "string" || typeof b.v === "string"
        ? String(a.v).localeCompare(String(b.v))
        : a.v - b.v;
      if (cmp === 0) return a.i - b.i; /* stable */
      return cmp * dir;
    });
    return decorated.map(function (d) { return d.m; });
  }

  function td(label, className) {
    var cell = document.createElement("td");
    cell.setAttribute("data-label", label);
    if (className) cell.className = className;
    return cell;
  }

  function renderCatalog(models, state, snapshot, gate, focusId) {
    if (!catalogBody || !catalogTable) return;
    if (!models.length) {
      catalogTable.hidden = true;
      if (catalogEmpty) catalogEmpty.hidden = false;
      return;
    }
    catalogTable.hidden = false;
    if (catalogEmpty) catalogEmpty.hidden = true;
    if (catalogWindowChip) {
      catalogWindowChip.textContent = (((state && state.range) || "24h").toUpperCase()) + " WINDOW";
    }
    if (catalogCountChip) catalogCountChip.textContent = models.length + " models";

    var sorted = sortModels(models, state, snapshot);
    catalogBody.textContent = "";
    sorted.forEach(function (model) {
      var row = document.createElement("tr");
      row.className = "obs-cat-row" + (model.model_id === focusId ? " is-focused" : "");
      row.setAttribute("data-model-id", model.model_id);

      var nameCell = td("Model", "obs-cat-cell--model");
      var focusBtn = document.createElement("button");
      focusBtn.type = "button";
      focusBtn.className = "obs-cat-focus";
      focusBtn.textContent = model.display_name || model.model_id;
      focusBtn.setAttribute("aria-pressed", model.model_id === focusId ? "true" : "false");
      focusBtn.setAttribute("aria-label", "Focus " + (model.display_name || model.model_id) + " in the instrument field");
      focusBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        setFocus(model.model_id);
      });
      nameCell.appendChild(focusBtn);
      row.appendChild(nameCell);

      var providerCell = td("Provider", "obs-cat-cell--provider");
      providerCell.textContent = model.provider || "unavailable";
      row.appendChild(providerCell);

      var bandCell = td("Band", "obs-cat-cell--band");
      bandCell.textContent = typeof model.rank === "number" ? bandForRank(model.rank) : "unavailable";
      row.appendChild(bandCell);

      METRIC_KEYS.forEach(function (key) {
        var cell = td(key.toUpperCase(), "obs-cat-cell--num");
        var value = key === "cii" ? modelCii(model) : (model.metrics ? model.metrics[key] : null);
        if (typeof value === "number" && isFinite(value)) {
          cell.textContent = value.toFixed(3);
          if (key === "cii" && value < gate) cell.classList.add("obs-cat-cell--belowgate");
        } else {
          cell.textContent = "unavailable";
          cell.classList.add("obs-cat-cell--missing");
        }
        row.appendChild(cell);
      });

      var trendCell = td("Trend", "obs-cat-cell--trend");
      var trend = trendInfo(model, state, snapshot);
      if (trend.kind === "series") {
        trendCell.appendChild(sparklineSvg(trend.points));
        var srTrend = document.createElement("span");
        srTrend.className = "observatory-compat-copy";
        srTrend.textContent =
          "CII trend " + (trend.delta >= 0 ? "+" : "") + trend.delta.toFixed(3) +
          " over " + trend.points.length + " samples in range";
        trendCell.appendChild(srTrend);
      } else {
        trendCell.textContent =
          trend.kind === "short" ? "window too short"
          : trend.kind === "collecting" ? "collecting"
          : "history unavailable";
        trendCell.classList.add("obs-cat-cell--missing");
      }
      row.appendChild(trendCell);

      var stateCell = td("State", "obs-cat-cell--state obs-cat-cell--state-" + acquisitionState(model));
      stateCell.textContent = acquisitionState(model);
      row.appendChild(stateCell);

      var seenCell = td("Seen", "obs-cat-cell--seen");
      seenCell.textContent = relativeAge(model.last_seen);
      row.appendChild(seenCell);

      row.addEventListener("click", function () { setFocus(model.model_id); });
      catalogBody.appendChild(row);
    });
  }

  function updateCatalogFocus(focusId) {
    if (!catalogBody) return;
    Array.prototype.forEach.call(catalogBody.querySelectorAll(".obs-cat-row"), function (row) {
      var isFocused = row.getAttribute("data-model-id") === focusId;
      row.classList.toggle("is-focused", isFocused);
      var btn = row.querySelector(".obs-cat-focus");
      if (btn) btn.setAttribute("aria-pressed", isFocused ? "true" : "false");
    });
  }

  function applySortIndicators() {
    if (!catalogTable) return;
    Array.prototype.forEach.call(catalogTable.querySelectorAll("thead th[data-key]"), function (th) {
      var key = th.getAttribute("data-key");
      th.setAttribute(
        "aria-sort",
        key === catalogSort.key ? (catalogSort.dir === "asc" ? "ascending" : "descending") : "none"
      );
    });
  }

  function wireCatalogSort() {
    if (catalogSortWired || !catalogTable) return;
    catalogSortWired = true;
    Array.prototype.forEach.call(catalogTable.querySelectorAll("thead th[data-key]"), function (th) {
      var button = th.querySelector("button");
      if (!button) return;
      button.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (catalogSort.key === key) {
          catalogSort.dir = catalogSort.dir === "asc" ? "desc" : "asc";
        } else {
          catalogSort.key = key;
          catalogSort.dir = ASC_DEFAULT_KEYS.indexOf(key) !== -1 ? "asc" : "desc";
        }
        applySortIndicators();
        if (lastRender) {
          renderCatalog(lastRender.models, lastRender.state, lastRender.snapshot, lastRender.gate, lastRender.focusId);
        }
      });
    });
    applySortIndicators();
  }

  function render(state, snapshot, rebuildCatalog) {
    var models = rankedModels(state, snapshot);
    if (!models.length) return;
    var gate = gateThreshold(state, snapshot);
    var focusId = state ? state.focusModelId : null;
    buildRing(models, gate, focusId);
    updateReadout(models, state, snapshot, gate);
    lastRender = { models: models, state: state, snapshot: snapshot, gate: gate, focusId: focusId };
    if (rebuildCatalog !== false || !catalogRendered) {
      renderCatalog(models, state, snapshot, gate, focusId);
      catalogRendered = true;
    } else {
      updateCatalogFocus(focusId);
    }
    wireCatalogSort();
    lastFocusId = focusId;
    lastViewRef = state ? state.view : null;
    lastRange = state ? state.range : null;
  }

  function snapshotFromState(state) {
    return state && state.rawSnapshot ? state.rawSnapshot : null;
  }

  function fetchSnapshotFallback() {
    var url = root.dataset.snapshotUrl;
    if (!url || typeof fetch !== "function") return Promise.resolve(null);
    return fetch(url, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .catch(function () { return null; });
  }

  function startPolling(getSnapshot) {
    window.setInterval(function () {
      var state = getState();
      if (!state) return;
      var snapshot = snapshotFromState(state) || getSnapshot();
      if (!snapshot) return;
      var focusChanged = state.focusModelId !== lastFocusId;
      var viewChanged = state.view !== lastViewRef;
      var rangeChanged = state.range !== lastRange;
      if (viewChanged || rangeChanged) {
        render(state, snapshot, true);
      } else if (focusChanged) {
        /* Focus-only change: skip the catalog rebuild so keyboard focus
           inside the table is not stolen; just retag the focused row. */
        render(state, snapshot, false);
      }
    }, POLL_MS);
  }

  function init() {
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      var state = getState();
      var snapshot = snapshotFromState(state);
      if (state && snapshot) {
        window.clearInterval(timer);
        render(state, snapshot);
        startPolling(function () { return snapshot; });
        return;
      }
      if (tries >= STATE_WAIT_TRIES) {
        window.clearInterval(timer);
        fetchSnapshotFallback().then(function (fetched) {
          if (!fetched) return;
          render(getState(), fetched);
          startPolling(function () { return fetched; });
        });
      }
    }, STATE_WAIT_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
