/**
 * charts.js — Chart.js wrapper for the time series page.
 * Loads from static/data/timeseries.json.
 */

(function () {
  "use strict";

  const COLORS = [
    "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
    "#8b5cf6", "#06b6d4", "#f97316", "#84cc16",
  ];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: cssVar("--muted") || "#9ca3af",
            font: { family: "'JetBrains Mono', monospace", size: 11 },
            boxWidth: 14,
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: cssVar("--surface") || "#1f1f23",
          borderColor: cssVar("--border") || "#2e2e38",
          borderWidth: 1,
          titleColor: cssVar("--text") || "#f0f0f4",
          bodyColor: cssVar("--muted") || "#9ca3af",
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
          callbacks: {
            label: function (ctx) {
              return `  ${ctx.dataset.label}: ${Number(ctx.raw.y ?? ctx.raw).toFixed(6)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { tooltipFormat: "yyyy-MM-dd HH:mm" },
          grid: { color: cssVar("--border") || "#2e2e38" },
          ticks: {
            color: cssVar("--muted") || "#9ca3af",
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: cssVar("--border") || "#2e2e38" },
          ticks: {
            color: cssVar("--muted") || "#9ca3af",
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: (v) => v.toFixed(4),
          },
        },
      },
    };
  }

  let tsData = null;
  let activeChart = null;

  async function loadData() {
    try {
      const resp = await fetch("./static/data/timeseries.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      tsData = await resp.json();
      populateSelectors();
      renderChart();
    } catch (err) {
      showError("Collecting data — awaiting probe results");
    }
  }

  function populateSelectors() {
    const metricSel = document.getElementById("metric-select");
    const providerSel = document.getElementById("provider-select");
    if (!metricSel || !providerSel || !tsData) return;

    const metrics = Object.keys(tsData.metrics || {});
    metricSel.innerHTML = metrics.map(
      (m) => `<option value="${m}">${m.replace(/_/g, " ")}</option>`
    ).join("");

    // Collect all providers from model IDs (prefix before first "-")
    const allModels = new Set();
    metrics.forEach((m) => {
      Object.keys(tsData.metrics[m] || {}).forEach((id) => allModels.add(id));
    });
    const providers = ["all", ...new Set([...allModels].map(extractProvider))];
    providerSel.innerHTML = providers.map(
      (p) => `<option value="${p}">${p}</option>`
    ).join("");
  }

  function extractProvider(modelId) {
    // Known prefixes
    if (modelId.startsWith("claude")) return "anthropic";
    if (modelId.startsWith("gemini")) return "gemini";
    if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
    if (modelId.startsWith("bootstrap")) return "local";
    return modelId.split("-")[0];
  }

  function renderChart() {
    const metricSel = document.getElementById("metric-select");
    const providerSel = document.getElementById("provider-select");
    const canvas = document.getElementById("ts-chart");
    const emptyMsg = document.getElementById("ts-empty");

    if (!canvas || !tsData) return;

    const metric = metricSel ? metricSel.value : "entropy_delta";
    const provider = providerSel ? providerSel.value : "all";

    const metricData = (tsData.metrics || {})[metric] || {};
    const filteredModels = Object.entries(metricData).filter(([modelId]) =>
      provider === "all" || extractProvider(modelId) === provider
    );

    if (filteredModels.length === 0) {
      if (emptyMsg) emptyMsg.style.display = "block";
      if (canvas) canvas.style.display = "none";
      if (activeChart) { activeChart.destroy(); activeChart = null; }
      return;
    }

    if (emptyMsg) emptyMsg.style.display = "none";
    if (canvas) canvas.style.display = "block";

    // Check if single-point (scatter) mode
    const maxPoints = Math.max(...filteredModels.map(([, pts]) => pts.length));
    const isScatter = maxPoints <= 1;

    const datasets = filteredModels.map(([modelId, points], i) => ({
      label: modelId,
      data: points.map((p) => ({ x: p.t, y: p.v })),
      borderColor: COLORS[i % COLORS.length],
      backgroundColor: COLORS[i % COLORS.length] + "33",
      borderWidth: 2,
      pointRadius: isScatter ? 6 : 3,
      pointHoverRadius: 8,
      fill: false,
      tension: 0.2,
      showLine: !isScatter,
    }));

    if (activeChart) {
      activeChart.destroy();
      activeChart = null;
    }

    const cfg = chartDefaults();
    const mutedColor = cssVar("--muted") || "#9ca3af";
    cfg.scales.x.title = {
      display: true,
      text: isScatter ? "Single data point — collecting over time" : "Time",
      color: mutedColor,
      font: { family: "'JetBrains Mono', monospace", size: 10 },
    };
    cfg.scales.y.title = {
      display: true,
      text: metric.replace(/_/g, " "),
      color: mutedColor,
      font: { family: "'JetBrains Mono', monospace", size: 10 },
    };

    const ctx = canvas.getContext("2d");
    activeChart = new Chart(ctx, {
      type: "scatter",
      data: { datasets },
      options: cfg,
    });

    if (isScatter) {
      const note = document.getElementById("scatter-note");
      if (note) note.style.display = "block";
    }
  }

  function showError(msg) {
    console.error("Observatory timeseries:", msg);
    // Show collecting state in chart area instead of error text
    const canvas = document.getElementById("ts-chart");
    if (canvas && canvas.parentElement) {
      const existing = canvas.parentElement.querySelector(".collecting-msg");
      if (!existing) {
        const div = document.createElement("div");
        div.className = "collecting-msg collecting-msg--compact";
        div.textContent = "No time-series data yet \u2014 results will appear here as probe runs complete.";
        canvas.parentElement.insertBefore(div, canvas);
        canvas.style.display = "none";
      }
    }
  }

  // Wire up selectors
  document.addEventListener("DOMContentLoaded", () => {
    const metricSel = document.getElementById("metric-select");
    const providerSel = document.getElementById("provider-select");
    if (metricSel) metricSel.addEventListener("change", renderChart);
    if (providerSel) providerSel.addEventListener("change", renderChart);
    loadData();
  });
})();
