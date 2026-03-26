(function () {
  "use strict";

  const state = {
    range: "24h",
    includeCompleted: false,
    pcii: [],
    models: [],
    events: [],
    constellation: { nodes: [], edges: [], threshold: 0.6 },
    focusModelId: null,
    ws: null,
    refreshTimer: null,
  };

  const METRIC_LABELS = {
    cii: "Composite Score",
    ips: "Identity Proxy",
    srs: "Shutdown Proxy",
    mpg: "Sweep Proxy",
    tci: "Temporal Proxy",
    edp: "Entropy Proxy",
  };

  function qs(selector) {
    return document.querySelector(selector);
  }

  function fmt(value, digits = 3) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";
  }

  function timeLabel(iso) {
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

  async function fetchJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function scheduleRefresh() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(function () {
      refreshData().catch(function (error) {
        console.error("Observatory refresh failed", error);
      });
    }, 250);
  }

  function publishFieldState() {
    const root = qs("#constellation-root");
    if (!root) return;
    window.dispatchEvent(new CustomEvent("observatory:data", {
      detail: {
        models: state.models,
        constellation: state.constellation,
        focusModelId: state.focusModelId,
      },
    }));
  }

  function updateModelPanelFocus() {
    const panels = document.querySelectorAll(".model-panel[data-model-id]");
    panels.forEach(function (panel) {
      const modelId = panel.dataset.modelId;
      const focused = Boolean(state.focusModelId) && modelId === state.focusModelId;
      const dimmed = Boolean(state.focusModelId) && modelId !== state.focusModelId;
      panel.classList.toggle("is-focused", focused);
      panel.classList.toggle("is-dimmed", dimmed);
      panel.setAttribute("aria-pressed", focused ? "true" : "false");
    });
  }

  function setFocusModel(modelId) {
    const nextModelId = modelId || null;
    if (state.focusModelId === nextModelId) return;
    state.focusModelId = nextModelId;
    updateModelPanelFocus();
    publishFieldState();
  }

  async function refreshData() {
    const eventsUrl = `/api/observatory/events?limit=40${state.includeCompleted ? "&include_completed=true" : ""}`;
    const [pcii, models, events, constellation] = await Promise.all([
      fetchJSON(`/api/observatory/pcii?range=${encodeURIComponent(state.range)}`),
      fetchJSON("/api/observatory/models"),
      fetchJSON(eventsUrl),
      fetchJSON("/api/observatory/constellation"),
    ]);
    state.pcii = pcii;
    state.models = models;
    state.events = events;
    state.constellation = constellation;
    renderLanding();
    renderObservatory();
  }

  async function refreshHealth() {
    const statusNode = qs("#landing-status-note");
    if (!statusNode) return;
    const health = await fetchJSON("/api/health");
    const liveModels = state.models.filter(function (model) { return model.live; }).length;
    const trackedModels = liveModels || state.models.length;
    statusNode.textContent = health.last_run
      ? `Research-only instrumentation. ${trackedModels} tracked models in the observatory field. Last probe run ${ageLabel(health.last_run)}.`
      : "Research-only instrumentation. Awaiting current observatory telemetry.";
  }

  function updateLiveMarquee() {
    const stack = qs("[data-live-marquee='true']");
    if (!stack || !state.models.length) return;
    const names = state.models.map(function (model) {
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

  function renderLanding() {
    const latest = state.pcii[state.pcii.length - 1];
    const scoreNode = qs("#live-home-score");
    const modelsNode = qs("#live-home-model-count");
    const latestNode = qs("#live-home-latest");
    const statusNode = qs("#live-home-status");
    const briefsNode = qs("#landing-model-briefs");

    if (scoreNode) scoreNode.textContent = fmt(latest && latest.value);
    if (modelsNode) modelsNode.textContent = String(state.models.length);
    if (latestNode) {
      latestNode.textContent = latest ? `latest sample ${ageLabel(latest.timestamp)}` : "awaiting live telemetry";
    }
    if (statusNode) {
      statusNode.textContent = state.events.length
        ? String(state.events[0].severity || "live").toUpperCase()
        : "LIVE";
    }

    if (briefsNode) {
      const topModels = state.models
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
        : `<p class="muted">No model readouts yet \u2014 results will appear here as probe runs complete.</p>`;
    }

    updateLiveMarquee();
  }

  function renderObservatory() {
    renderReadout();
    renderModelPanels();
    renderHeatmap();
    renderTimeline();
    publishFieldState();

    const eventsNode = qs("#events-root");
    if (eventsNode) eventsNode.innerHTML = renderEventList(state.events);

    const modelCount = qs("#observatory-model-count");
    if (modelCount) modelCount.textContent = `${state.models.length} MODELS`;
  }

  function renderReadout() {
    const target = qs("#pcii-readout");
    if (!target) return;
    const latest = state.pcii[state.pcii.length - 1];
    const previous = state.pcii.length > 1 ? state.pcii[state.pcii.length - 2] : null;
    const delta = latest && previous ? latest.value - previous.value : null;
    const pct = latest ? Math.max(0, Math.min(1, latest.value)) : 0;
    const circumference = 2 * Math.PI * 54;
    const offset = circumference * (1 - pct);
    const direction = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    target.innerHTML = `
      <div class="gauge-wrap">
        <svg viewBox="0 0 140 140" class="gauge">
          <circle cx="70" cy="70" r="54" class="gauge-track"></circle>
          <circle cx="70" cy="70" r="54" class="gauge-arc ${direction}" style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}"></circle>
        </svg>
        <div class="gauge-value">${fmt(latest && latest.value)}</div>
      </div>
      <div class="pcii-meta">
        <div class="summary-label">Trend</div>
        <div class="trend ${direction}">${delta == null ? "--" : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} ${fmt(Math.abs(delta))}`}</div>
        <div class="summary-sub">${latest ? `${latest.n_models} models contributing · ${timeLabel(latest.timestamp)}` : "No aggregate-score samples yet."}</div>
      </div>
    `;
  }

  function renderModelPanels() {
    const target = qs("#model-panels");
    if (!target) return;
    const liveModels = state.models.filter(function (model) { return model.live; }).slice(0, 10);
    if (!liveModels.length) {
      target.innerHTML = `<p class="muted">No model panels yet \u2014 panels will populate as observatory data accumulates.</p>`;
      return;
    }
    target.innerHTML = liveModels.map(function (model) {
      const bars = ["cii", "ips", "srs", "mpg", "tci", "edp"].map(function (metric) {
        const value = model.metrics[metric];
        const width = value == null ? 0 : Math.max(0, Math.min(100, value * 100));
        return `
          <div class="metric-row">
            <span>${METRIC_LABELS[metric] || metric.toUpperCase()}</span>
            <div class="mini-bar"><div style="width:${width}%"></div></div>
            <span>${fmt(value)}</span>
          </div>
        `;
      }).join("");
      return `
        <article class="model-panel ${model.stale ? "stale" : ""} ${state.focusModelId === model.model_id ? "is-focused" : state.focusModelId ? "is-dimmed" : ""}" data-model-id="${model.model_id}" tabindex="0" role="button" aria-pressed="${state.focusModelId === model.model_id ? "true" : "false"}">
          <header>
            <div>
              <h3>${model.display_name}</h3>
              <p class="mono-muted">${model.provider}</p>
            </div>
            <span class="status-chip ${model.stale ? "amber" : "green"}">${model.stale ? "STALE" : "CURRENT"}</span>
          </header>
          <div class="panel-cii">${fmt(model.metrics.cii)}</div>
          <p class="muted">Last update ${ageLabel(model.last_seen)}</p>
          ${bars}
        </article>
      `;
    }).join("");
  }

  function renderTimeline() {
    const target = qs("#timeline-root");
    if (!target) return;
    if (!state.pcii.length || typeof d3 === "undefined") {
      target.innerHTML = `<p class="muted">No aggregate-score timeseries available yet.</p>`;
      return;
    }

    const width = target.clientWidth || 900;
    const height = 240;
    const padding = { top: 16, right: 16, bottom: 28, left: 40 };
    target.innerHTML = "";
    const svg = d3.select(target).append("svg").attr("viewBox", `0 0 ${width} ${height}`);
    const values = state.pcii.map(function (row) { return { t: new Date(row.timestamp), v: row.value }; });
    const x = d3.scaleTime().domain(d3.extent(values, function (d) { return d.t; })).range([padding.left, width - padding.right]);
    const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(values, function (d) { return d.v; }) || 1)]).nice().range([height - padding.bottom, padding.top]);
    const line = d3.line().x(function (d) { return x(d.t); }).y(function (d) { return y(d.v); });

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
      .attr("fill", "none")
      .attr("stroke", "var(--accent)")
      .attr("stroke-width", 2.5)
      .attr("d", line);
    svg.selectAll("circle")
      .data(values.slice(-20))
      .enter()
      .append("circle")
      .attr("cx", function (d) { return x(d.t); })
      .attr("cy", function (d) { return y(d.v); })
      .attr("r", 2.5)
      .attr("fill", "var(--accent)");
  }

  function renderHeatmap() {
    const target = qs("#heatmap-root");
    if (!target) return;
    const rows = state.models.filter(function (model) {
      return model.metrics && model.metrics.cii != null;
    }).slice(0, 12);
    if (!rows.length) {
      target.innerHTML = `<p class="muted">No comparative heatmap data yet.</p>`;
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

  function renderEventList(events) {
    if (!events.length) {
      return `<p class="muted">No observatory events recorded yet.</p>`;
    }
    return `<div class="event-list">${
      events.map(function (event) {
        const level = event.severity === "critical" ? "red" : event.severity === "alert" || event.severity === "warning" ? "amber" : "green";
        return `
          <article class="event-item ${event.severity}">
            <div class="event-topline">
              <span class="status-chip ${level}">${event.severity.toUpperCase()}</span>
              <span class="mono-muted">${event.event_type}</span>
              <span class="mono-muted">${timeLabel(event.timestamp)}</span>
            </div>
            <p>${event.message}</p>
          </article>
        `;
      }).join("")
    }</div>`;
  }

  function connectSocket() {
    if (!("WebSocket" in window)) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    state.ws = new WebSocket(`${protocol}://${window.location.host}/ws/observatory`);
    state.ws.addEventListener("open", function () {
      state.ws.send(JSON.stringify({ action: "subscribe", channels: ["pcii", "metrics", "events"] }));
    });
    state.ws.addEventListener("message", scheduleRefresh);
    state.ws.addEventListener("close", function () {
      window.setTimeout(connectSocket, 2000);
    });
  }

  function bindControls() {
    document.querySelectorAll("[data-range]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.range = button.dataset.range;
        document.querySelectorAll("[data-range]").forEach(function (candidate) {
          candidate.classList.remove("active");
        });
        button.classList.add("active");
        refreshData().catch(function (error) {
          console.error("Range refresh failed", error);
        });
      });
    });
    const toggle = qs("#include-completions");
    if (toggle) {
      toggle.addEventListener("change", function () {
        state.includeCompleted = Boolean(toggle.checked);
        refreshData().catch(function (error) {
          console.error("Event refresh failed", error);
        });
      });
    }

    const panelList = qs("#model-panels");
    if (panelList && !panelList.dataset.boundFocus) {
      panelList.dataset.boundFocus = "true";
      panelList.addEventListener("click", function (event) {
        const panel = event.target.closest(".model-panel[data-model-id]");
        if (!panel) return;
        const modelId = panel.dataset.modelId;
        setFocusModel(state.focusModelId === modelId ? null : modelId);
      });
      panelList.addEventListener("keydown", function (event) {
        const panel = event.target.closest(".model-panel[data-model-id]");
        if (!panel) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const modelId = panel.dataset.modelId;
        setFocusModel(state.focusModelId === modelId ? null : modelId);
      });
    }

    window.addEventListener("observatory:focus-model", function (event) {
      setFocusModel(event.detail && event.detail.modelId ? event.detail.modelId : null);
    });
    window.addEventListener("observatory:clear-focus", function () {
      setFocusModel(null);
    });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    bindControls();
    connectSocket();
    try {
      await refreshData();
      await refreshHealth();
    } catch (error) {
      console.error("Observatory UI load failed", error);
    }
  });
})();
