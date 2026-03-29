(function () {
  "use strict";

  const RANGE_TO_MS = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  const METRIC_LABELS = {
    cii: "Composite Score",
    ips: "Identity Proxy",
    srs: "Shutdown Proxy",
    mpg: "Sweep Proxy",
    tci: "Temporal Proxy",
    edp: "Entropy Proxy",
  };

  const landingState = {
    refreshTimer: null,
    ws: null,
    models: [],
    pcii: [],
    events: [],
  };

  const observatoryRoot = document.querySelector("[data-observatory-root]");
  const observatoryState = observatoryRoot
    ? {
        mode: observatoryRoot.dataset.mode || "live",
        snapshotUrl: observatoryRoot.dataset.snapshotUrl || "/api/observatory/snapshot",
        socketEnabled: observatoryRoot.dataset.socketEnabled === "true",
        refreshTimer: null,
        ws: null,
        range: "24h",
        focusModelId: null,
        toggles: {
          history: true,
          compare: false,
          threshold: true,
        },
        rawSnapshot: null,
        view: null,
      }
    : null;

  function qs(selector) {
    return document.querySelector(selector);
  }

  function fmt(value, digits = 3) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";
  }

  function formatCompactDate(iso) {
    if (!iso) return "no data";
    const date = new Date(iso);
    return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  }

  function ageLabel(iso) {
    if (!iso) return "never";
    const deltaMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.max(0, Math.round(deltaMs / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function extractProvider(modelId) {
    if (!modelId) return "unknown";
    return modelId.split("-")[0];
  }

  async function fetchJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function updateLiveMarquee(models) {
    const stack = qs("[data-live-marquee='true']");
    if (!stack || !models.length) return;
    const names = models.map(function (model) {
      return model.display_name || model.model_id;
    }).slice(0, 18);
    if (!names.length) return;
    const rows = [
      names,
      names.slice(3).concat(names.slice(0, 3)),
      names.slice(6).concat(names.slice(0, 6)),
    ];
    stack.querySelectorAll(".marquee-track").forEach(function (track, index) {
      const row = rows[index] || names;
      track.innerHTML = row.concat(row).map(function (name) {
        return `<span class="marquee-item">${name}</span>`;
      }).join("");
    });
    window.dispatchEvent(new Event("observatory:marquee-refresh"));
  }

  function renderLanding(models, pcii, events) {
    const latest = pcii[pcii.length - 1];
    const scoreNode = qs("#live-home-score");
    const modelsNode = qs("#live-home-model-count");
    const latestNode = qs("#live-home-latest");
    const statusNode = qs("#live-home-status");
    const briefsNode = qs("#landing-model-briefs");

    if (scoreNode) scoreNode.textContent = fmt(latest && latest.value);
    if (modelsNode) modelsNode.textContent = String(models.length);
    if (latestNode) {
      latestNode.textContent = latest ? `latest sample ${ageLabel(latest.timestamp)}` : "awaiting live telemetry";
    }
    if (statusNode) {
      statusNode.textContent = events.length
        ? String(events[0].severity || "live").toUpperCase()
        : "LIVE";
    }

    if (briefsNode) {
      const topModels = models
        .filter(function (model) { return model.metrics && model.metrics.cii != null; })
        .slice(0, 3);
      briefsNode.innerHTML = topModels.length
        ? topModels.map(function (model) {
            return `
              <article class="landing-model-brief">
                <header>
                  <strong>${model.display_name}</strong>
                  <span class="mono-muted">${model.provider}</span>
                </header>
                <div class="brief-value">${fmt(model.metrics.cii)}</div>
                <p class="muted">Identity proxy ${fmt(model.metrics.ips)} · shutdown proxy ${fmt(model.metrics.srs)} · last seen ${ageLabel(model.last_seen)}</p>
              </article>
            `;
          }).join("")
        : `<p class="muted">No model readouts yet — results will appear here as probe runs complete.</p>`;
    }

    updateLiveMarquee(models);
  }

  function scheduleLandingRefresh() {
    if (landingState.refreshTimer) window.clearTimeout(landingState.refreshTimer);
    landingState.refreshTimer = window.setTimeout(function () {
      refreshLandingData().catch(function (error) {
        console.error("Observatory landing refresh failed", error);
      });
    }, 250);
  }

  async function refreshLandingData() {
    const eventsUrl = "/api/observatory/events?limit=40&include_completed=true";
    const [pcii, models, events] = await Promise.all([
      fetchJSON("/api/observatory/pcii?range=24h"),
      fetchJSON("/api/observatory/models"),
      fetchJSON(eventsUrl),
    ]);
    landingState.pcii = pcii;
    landingState.models = models;
    landingState.events = events;
    renderLanding(models, pcii, events);
  }

  function connectLandingSocket() {
    if (!("WebSocket" in window) || !qs("#live-home-score")) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    landingState.ws = new WebSocket(`${protocol}://${window.location.host}/ws/observatory`);
    landingState.ws.addEventListener("open", function () {
      landingState.ws.send(JSON.stringify({ action: "subscribe", channels: ["pcii", "metrics", "events"] }));
    });
    landingState.ws.addEventListener("message", scheduleLandingRefresh);
    landingState.ws.addEventListener("close", function () {
      window.setTimeout(connectLandingSocket, 2000);
    });
  }

  function filterSeriesByRange(series, range) {
    const windowMs = RANGE_TO_MS[range] || RANGE_TO_MS["24h"];
    const cutoff = Date.now() - windowMs;
    return (series || []).filter(function (entry) {
      return new Date(entry.timestamp || entry.t).getTime() >= cutoff;
    });
  }

  function topNeighbors(snapshot, modelId, limit) {
    return (snapshot.constellation.edges || [])
      .filter(function (edge) {
        return edge.source === modelId || edge.target === modelId;
      })
      .sort(function (left, right) {
        return right.similarity - left.similarity;
      })
      .slice(0, limit)
      .map(function (edge) {
        return {
          modelId: edge.source === modelId ? edge.target : edge.source,
          similarity: edge.similarity,
          mode: edge.mode,
        };
      });
  }

  function deriveObservatoryView() {
    const snapshot = observatoryState.rawSnapshot || {
      summary: {},
      models: [],
      events: [],
      constellation: { nodes: [], edges: [], threshold: 0.6 },
      pcii_series: [],
      cii_history: {},
    };
    const models = (snapshot.models || []).map(function (model) {
      const fullHistory = snapshot.cii_history[model.model_id] || [];
      const history = filterSeriesByRange(fullHistory, observatoryState.range);
      const latestHistory = history[history.length - 1];
      const firstHistory = history[0];
      const rangeCii = latestHistory ? latestHistory.value : (model.metrics && model.metrics.cii);
      const rangeTrend = history.length > 1 ? latestHistory.value - firstHistory.value : 0;
      const meanCii = history.length
        ? history.reduce(function (sum, sample) { return sum + sample.value; }, 0) / history.length
        : rangeCii;
      return {
        ...model,
        rangeCii: typeof rangeCii === "number" ? rangeCii : null,
        rangeTrend: typeof rangeTrend === "number" ? rangeTrend : 0,
        meanCii: typeof meanCii === "number" ? meanCii : null,
        historyDepth: history.length,
        ciiHistory: history,
      };
    });

    models.sort(function (left, right) {
      return (right.rangeCii || right.metrics.cii || 0) - (left.rangeCii || left.metrics.cii || 0);
    });
    models.forEach(function (model, index) {
      model.rank = index + 1;
      model.relativeStanding = `${index + 1}/${models.length || 1}`;
      model.neighbors = topNeighbors(snapshot, model.model_id, 3);
    });

    observatoryState.view = {
      summary: snapshot.summary || {},
      models: models,
      events: snapshot.events || [],
      constellation: snapshot.constellation || { nodes: [], edges: [], threshold: 0.6 },
      pciiSeries: filterSeriesByRange(snapshot.pcii_series || [], observatoryState.range),
      ciiHistory: models.reduce(function (acc, model) {
        acc[model.model_id] = model.ciiHistory;
        return acc;
      }, {}),
    };
  }

  function publishFieldState() {
    if (!observatoryState.view) return;
    window.dispatchEvent(new CustomEvent("observatory:data", {
      detail: {
        models: observatoryState.view.models,
        constellation: observatoryState.view.constellation,
        ciiHistory: observatoryState.view.ciiHistory,
        focusModelId: observatoryState.focusModelId,
        range: observatoryState.range,
        toggles: observatoryState.toggles,
        summary: observatoryState.view.summary,
      },
    }));
  }

  function renderRangeState() {
    document.querySelectorAll("[data-range]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.range === observatoryState.range);
    });
    const rangeReadout = qs("#observatory-range-readout");
    if (rangeReadout) rangeReadout.textContent = `${observatoryState.range.toUpperCase()} WINDOW`;
  }

  function renderInspector() {
    const target = qs("#observatory-inspector");
    if (!target || !observatoryState.view) return;
    const latestPcii = observatoryState.view.pciiSeries[observatoryState.view.pciiSeries.length - 1];
    const focused = observatoryState.view.models.find(function (model) {
      return model.model_id === observatoryState.focusModelId;
    });
    if (!focused) {
      const liveCount = observatoryState.view.models.filter(function (model) { return model.live; }).length;
      const topModels = observatoryState.view.models.slice(0, 3);
      target.innerHTML = `
        <div class="panel-title">Inspector Rail</div>
        <div class="observatory-inspector-state">
          <div class="observatory-inspector-block">
            <span class="summary-label">Surface Summary</span>
            <div class="observatory-inspector-value">${fmt(latestPcii && latestPcii.value)}</div>
            <p class="observatory-inspector-copy">
              ${latestPcii ? `${observatoryState.view.models.length} tracked models · ${liveCount} currently live · latest aggregate sample ${ageLabel(latestPcii.timestamp)}` : "Awaiting aggregate signal telemetry."}
            </p>
          </div>
          <div class="observatory-inspector-grid">
            <div>
              <span class="summary-label">Tracking Mode</span>
              <strong>${observatoryState.mode === "live" ? "Live Instrument" : "Bundled Snapshot"}</strong>
            </div>
            <div>
              <span class="summary-label">Similarity Threshold</span>
              <strong>${fmt(observatoryState.view.summary.constellation_threshold, 2)}</strong>
            </div>
            <div>
              <span class="summary-label">Range</span>
              <strong>${observatoryState.range.toUpperCase()}</strong>
            </div>
            <div>
              <span class="summary-label">History Window</span>
              <strong>${observatoryState.view.summary.similarity_window_days || 7}d</strong>
            </div>
          </div>
          <div class="observatory-inspector-block">
            <span class="summary-label">Signal Leaders</span>
            <div class="observatory-leader-list">
              ${topModels.map(function (model) {
                return `<button type="button" class="observatory-leader" data-focus-model="${model.model_id}">
                  <span>${model.display_name}</span>
                  <span>${fmt(model.rangeCii)}</span>
                </button>`;
              }).join("") || `<span class="muted">No tracked models yet.</span>`}
            </div>
          </div>
        </div>
      `;
      return;
    }

    const metrics = ["cii", "ips", "srs", "mpg", "tci", "edp"];
    const metricMarkup = metrics.map(function (metric) {
      const value = focused.metrics[metric];
      const width = value == null ? 0 : Math.max(0, Math.min(100, value * 100));
      return `
        <div class="observatory-metric-row">
          <span>${METRIC_LABELS[metric] || metric.toUpperCase()}</span>
          <div class="observatory-metric-bar"><div style="width:${width}%"></div></div>
          <span>${fmt(value)}</span>
        </div>
      `;
    }).join("");

    const neighbors = focused.neighbors || [];
    const evidence = Array.isArray(focused.evidence_links) ? focused.evidence_links : [];
    target.innerHTML = `
      <div class="panel-title">Model Dossier</div>
      <div class="observatory-dossier">
        <div class="observatory-dossier-head">
          <div>
            <span class="summary-label">Selected Model</span>
            <h2>${focused.display_name}</h2>
            <p class="mono-muted">${focused.provider} · rank ${focused.relativeStanding}</p>
          </div>
          <button type="button" class="console-btn observatory-clear-focus" data-clear-focus="true">Release Focus</button>
        </div>
        <div class="observatory-inspector-grid">
          <div>
            <span class="summary-label">CII / Core Score</span>
            <strong>${fmt(focused.metrics.cii)}</strong>
          </div>
          <div>
            <span class="summary-label">Recency</span>
            <strong>${ageLabel(focused.last_seen)}</strong>
          </div>
          <div>
            <span class="summary-label">Status</span>
            <strong>${focused.stale ? "Stale" : focused.live ? "Current" : "Configured"}</strong>
          </div>
          <div>
            <span class="summary-label">Range Trend</span>
            <strong>${focused.historyDepth > 1 ? `${focused.rangeTrend >= 0 ? "▲" : "▼"} ${fmt(Math.abs(focused.rangeTrend))}` : "Insufficient history"}</strong>
          </div>
        </div>
        <div class="observatory-inspector-block">
          <span class="summary-label">Component Metrics</span>
          <div class="observatory-metric-list">${metricMarkup}</div>
        </div>
        <div class="observatory-inspector-block">
          <span class="summary-label">Relative Standing</span>
          <p class="observatory-inspector-copy">
            ${focused.display_name} sits ${focused.rank <= 3 ? "inside the flagship concentration" : focused.rank <= 7 ? "inside the secondary field" : "in the outer field"} with ${focused.historyDepth} in-range CII sample${focused.historyDepth === 1 ? "" : "s"} and last observed ${formatCompactDate(focused.last_seen)}.
          </p>
        </div>
        <div class="observatory-inspector-block">
          <span class="summary-label">Closest Neighbors</span>
          <div class="observatory-neighbor-list">
            ${neighbors.length ? neighbors.map(function (neighbor) {
              const model = observatoryState.view.models.find(function (candidate) { return candidate.model_id === neighbor.modelId; });
              if (!model) return "";
              return `<button type="button" class="observatory-neighbor" data-focus-model="${model.model_id}">
                <span>${model.display_name}</span>
                <span>${fmt(neighbor.similarity, 2)}</span>
              </button>`;
            }).join("") : `<span class="muted">No strong neighboring relation in the current constellation.</span>`}
          </div>
        </div>
        ${evidence.length ? `
          <div class="observatory-inspector-block">
            <span class="summary-label">Evidence</span>
            <div class="observatory-evidence-list">
              ${evidence.map(function (item) {
                return `<a href="${item.href}" target="_blank" rel="noopener">${item.label}</a>`;
              }).join("")}
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderTimeline() {
    const target = qs("#timeline-root");
    if (!target || !observatoryState.view) return;
    if (!observatoryState.view.pciiSeries.length || typeof d3 === "undefined") {
      target.innerHTML = `<p class="muted">No aggregate-score timeseries available for this window.</p>`;
      return;
    }
    const width = target.clientWidth || 980;
    const height = 250;
    const padding = { top: 18, right: 18, bottom: 28, left: 42 };
    target.innerHTML = "";
    const svg = d3.select(target).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
    const values = observatoryState.view.pciiSeries.map(function (row) {
      return { t: new Date(row.timestamp), v: row.value };
    });
    const x = d3.scaleTime().domain(d3.extent(values, function (d) { return d.t; })).range([padding.left, width - padding.right]);
    const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(values, function (d) { return d.v; }) || 1)]).nice().range([height - padding.bottom, padding.top]);
    const area = d3.area()
      .x(function (d) { return x(d.t); })
      .y0(height - padding.bottom)
      .y1(function (d) { return y(d.v); })
      .curve(d3.curveMonotoneX);
    const line = d3.line()
      .x(function (d) { return x(d.t); })
      .y(function (d) { return y(d.v); })
      .curve(d3.curveMonotoneX);

    svg.append("defs")
      .append("linearGradient")
      .attr("id", "observatoryTimelineGradient")
      .attr("x1", "0%")
      .attr("x2", "0%")
      .attr("y1", "0%")
      .attr("y2", "100%")
      .selectAll("stop")
      .data([
        { offset: "0%", color: "rgba(122, 210, 255, 0.38)" },
        { offset: "100%", color: "rgba(122, 210, 255, 0.02)" },
      ])
      .enter()
      .append("stop")
      .attr("offset", function (d) { return d.offset; })
      .attr("stop-color", function (d) { return d.color; });

    svg.append("g")
      .attr("transform", `translate(0,${height - padding.bottom})`)
      .call(d3.axisBottom(x).ticks(6).tickSizeOuter(0))
      .attr("class", "axis");
    svg.append("g")
      .attr("transform", `translate(${padding.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0))
      .attr("class", "axis");
    svg.append("path")
      .datum(values)
      .attr("fill", "url(#observatoryTimelineGradient)")
      .attr("d", area);
    svg.append("path")
      .datum(values)
      .attr("fill", "none")
      .attr("stroke", "var(--cyan)")
      .attr("stroke-width", 2.3)
      .attr("d", line);
    svg.selectAll("circle")
      .data(values.slice(-18))
      .enter()
      .append("circle")
      .attr("cx", function (d) { return x(d.t); })
      .attr("cy", function (d) { return y(d.v); })
      .attr("r", 2.4)
      .attr("fill", "var(--accent)");
  }

  function renderHeatmap() {
    const target = qs("#heatmap-root");
    if (!target || !observatoryState.view) return;
    const rows = observatoryState.view.models.slice(0, 10);
    if (!rows.length) {
      target.innerHTML = `<p class="muted">No comparative metric rows available.</p>`;
      return;
    }
    const metrics = ["cii", "ips", "srs", "mpg", "tci", "edp"];
    let html = `<div class="heatmap-table"><div class="heatmap-cell head">MODEL</div>`;
    html += metrics.map(function (metric) {
      return `<div class="heatmap-cell head">${METRIC_LABELS[metric] || metric.toUpperCase()}</div>`;
    }).join("");
    rows.forEach(function (model) {
      html += `<div class="heatmap-cell label">${model.display_name}</div>`;
      metrics.forEach(function (metric) {
        const value = model.metrics[metric];
        const alpha = value == null ? 0.08 : Math.max(0.08, Math.min(0.95, value));
        html += `<div class="heatmap-cell metric" style="background: rgba(92, 166, 255, ${alpha});">${fmt(value)}</div>`;
      });
    });
    html += `</div>`;
    target.innerHTML = html;
  }

  function renderEvents() {
    const target = qs("#events-root");
    if (!target || !observatoryState.view) return;
    const events = observatoryState.view.events || [];
    if (!events.length) {
      target.innerHTML = `<p class="muted">No observatory events recorded in the current bundle.</p>`;
      return;
    }
    target.innerHTML = `<div class="event-list">${
      events.map(function (event) {
        const level = event.severity === "critical" ? "red" : event.severity === "alert" || event.severity === "warning" ? "amber" : "green";
        return `
          <article class="event-item ${event.severity}">
            <div class="event-topline">
              <span class="status-chip ${level}">${String(event.severity || "live").toUpperCase()}</span>
              <span class="mono-muted">${event.event_type}</span>
              <span class="mono-muted">${formatCompactDate(event.timestamp)}</span>
            </div>
            <p>${event.message}</p>
          </article>
        `;
      }).join("")
    }</div>`;
  }

  function renderObservatoryHeader() {
    const modelCount = qs("#observatory-model-count");
    const livePill = qs("#observatory-live-pill");
    const calibrationNote = qs("#observatory-calibration-note");
    const fieldStatus = qs("#observatory-field-status");
    if (modelCount && observatoryState.view) {
      modelCount.textContent = `${observatoryState.view.models.length} MODELS`;
    }
    if (livePill) {
      livePill.textContent = observatoryState.mode === "live" ? "CURRENT" : "SNAPSHOT";
    }
    if (calibrationNote && observatoryState.view) {
      const threshold = observatoryState.view.summary.constellation_threshold;
      calibrationNote.textContent = `Centrality follows current CII strength. Provider bands bias vertical placement only. Similarity threshold ${fmt(threshold, 2)}.`;
    }
    if (fieldStatus) {
      const focused = observatoryState.view && observatoryState.view.models.find(function (model) {
        return model.model_id === observatoryState.focusModelId;
      });
      if (focused) {
        fieldStatus.textContent = `${focused.display_name} in measured focus · ${focused.historyDepth >= 3 && observatoryState.toggles.history ? "historical trace active" : "trace gated by depth"}`;
      } else {
        fieldStatus.textContent = observatoryState.toggles.compare
          ? "Comparative overlay active"
          : "Range-stable constellation";
      }
    }
  }

  function renderObservatory() {
    if (!observatoryState || !observatoryState.view) return;
    renderRangeState();
    renderObservatoryHeader();
    renderInspector();
    renderTimeline();
    renderHeatmap();
    renderEvents();
    publishFieldState();
  }

  function setFocusModel(modelId) {
    observatoryState.focusModelId = modelId || null;
    renderObservatory();
  }

  function scheduleObservatoryRefresh() {
    if (observatoryState.refreshTimer) window.clearTimeout(observatoryState.refreshTimer);
    observatoryState.refreshTimer = window.setTimeout(function () {
      refreshObservatorySnapshot().catch(function (error) {
        console.error("Observatory snapshot refresh failed", error);
      });
    }, 250);
  }

  async function refreshObservatorySnapshot() {
    observatoryState.rawSnapshot = await fetchJSON(observatoryState.snapshotUrl);
    deriveObservatoryView();
    renderObservatory();
  }

  function connectObservatorySocket() {
    if (!observatoryState.socketEnabled || !("WebSocket" in window)) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    observatoryState.ws = new WebSocket(`${protocol}://${window.location.host}/ws/observatory`);
    observatoryState.ws.addEventListener("open", function () {
      observatoryState.ws.send(JSON.stringify({ action: "subscribe", channels: ["pcii", "metrics", "events"] }));
    });
    observatoryState.ws.addEventListener("message", scheduleObservatoryRefresh);
    observatoryState.ws.addEventListener("close", function () {
      window.setTimeout(connectObservatorySocket, 2000);
    });
  }

  function bindObservatoryControls() {
    document.querySelectorAll("[data-range]").forEach(function (button) {
      button.addEventListener("click", function () {
        observatoryState.range = button.dataset.range;
        deriveObservatoryView();
        renderObservatory();
      });
    });

    document.querySelectorAll("[data-console-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        const key = button.dataset.consoleToggle;
        observatoryState.toggles[key] = !observatoryState.toggles[key];
        button.classList.toggle("is-active", observatoryState.toggles[key]);
        renderObservatory();
      });
    });

    observatoryRoot.addEventListener("click", function (event) {
      const focusButton = event.target.closest("[data-focus-model]");
      if (focusButton) {
        setFocusModel(focusButton.dataset.focusModel);
        return;
      }
      if (event.target.closest("[data-clear-focus]")) {
        setFocusModel(null);
      }
    });

    window.addEventListener("observatory:focus-model", function (event) {
      setFocusModel(event.detail && event.detail.modelId ? event.detail.modelId : null);
    });
    window.addEventListener("observatory:clear-focus", function () {
      setFocusModel(null);
    });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (observatoryState) {
      bindObservatoryControls();
      try {
        await refreshObservatorySnapshot();
        connectObservatorySocket();
      } catch (error) {
        console.error("Observatory UI load failed", error);
      }
      return;
    }

    if (qs("#live-home-score")) {
      try {
        await refreshLandingData();
        connectLandingSocket();
      } catch (error) {
        console.error("Observatory landing load failed", error);
      }
    }
  });
})();
