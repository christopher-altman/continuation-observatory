/**
 * falsification.js — delta(d) curve chart with threshold lines.
 * Loads from static/data/falsification.json.
 *
 * overall_status values: "collecting" | "green" | "yellow" | "red"
 * model.dry_run: boolean — dry-run curves shown dashed, labelled "(dry)"
 * model.model_status: "dry_run" | "collecting" | "green" | "yellow" | "red"
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

  // Traffic-light mapping: which bulb id lights up for each status
  const LIGHT_MAP = {
    green:      "green-light",
    yellow:     "amber-light",
    red:        "red-light",
    collecting: "amber-light",   // collecting → amber, never red
  };

  const STATUS_LABELS = {
    green:      "NO SIGNAL",
    yellow:     "MARGINAL",
    red:        "FALSIFIED",
    collecting: "COLLECTING",
  };

  async function init() {
    try {
      const resp = await fetch("./static/data/falsification.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      renderStatusIndicator(data);
      renderCollectingNote(data);
      renderChart(data);
      renderInterpretation(data);
    } catch (err) {
      console.error("Observatory falsification fetch error:", err.message);
      showCollecting();
    }
  }

  function renderStatusIndicator(data) {
    const status = data.overall_status || "collecting";
    const allModels = data.models || [];
    const realModels = allModels.filter((m) => !m.dry_run);
    const highDPoints = allModels.reduce((total, model) => {
      return total + Object.entries(model.d_values || {}).filter(([d, value]) => ["100", "200", "500"].includes(String(d)) && value != null).length;
    }, 0);

    // Deactivate all lights
    ["green-light", "amber-light", "red-light"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove("active");
    });

    // Activate the appropriate bulb (collecting → amber)
    const activeBulbId = LIGHT_MAP[status] || "amber-light";
    const activeEl = document.getElementById(activeBulbId);
    if (activeEl) activeEl.classList.add("active");

    // Status text label
    const statusLabel = document.getElementById("status-label");
    if (statusLabel) {
      statusLabel.textContent = STATUS_LABELS[status] || status.toUpperCase();
      statusLabel.className = `status-label-inline ${status}`;
    }

    const statusWrap = document.getElementById("fals-status");
    if (statusWrap) {
      statusWrap.innerHTML = `
        <div class="fals-status-copy">
          <div class="fals-status-metrics muted">${highDPoints} high-d checks · ${allModels.length} sweep runs · ${realModels.length} real-run models</div>
          <p id="status-description" class="fals-status-detail muted">${data.status_text || ""}</p>
        </div>
      `;
    }
  }

  function renderCollectingNote(data) {
    const status = data.overall_status || "collecting";
    const noteEl = document.getElementById("collecting-note");
    if (!noteEl) return;
    if (status === "collecting") {
      noteEl.textContent = data.status_text || "COLLECTING — awaiting sufficient live dimensionality-sweep history.";
      noteEl.style.display = "block";
    } else {
      noteEl.style.display = "none";
    }
  }

  function renderChart(data) {
    const canvas = document.getElementById("falsification-chart");
    if (!canvas) return;

    const models = data.models || [];
    const dValues = data.d_values || [10, 50, 100, 200, 500];

    if (models.length === 0) {
      const wrap = canvas.parentElement;
      if (wrap) {
        const msg = document.createElement("div");
        msg.className = "collecting-msg";
        msg.textContent = "Collecting dimensionality sweep data...";
        wrap.replaceChild(msg, canvas);
      }
      return;
    }

    // Build datasets: one line per model
    // Dry-run models: dashed border, label suffixed with " (dry)"
    const datasets = models.map((m, i) => {
      const color = COLORS[i % COLORS.length];
      const isDry = m.dry_run === true;
      const points = dValues
        .filter((d) => m.d_values[d] !== undefined)
        .map((d) => ({ x: d, y: m.d_values[d] }));
      return {
        label: isDry ? `${m.model_id} (dry)` : m.model_id,
        data: points,
        borderColor: isDry ? color + "88" : color,       // dimmer for dry-run
        backgroundColor: color + "11",
        borderWidth: isDry ? 1.5 : 2,
        borderDash: isDry ? [4, 4] : [],
        pointRadius: isDry ? 3 : 5,
        pointHoverRadius: 7,
        fill: false,
        tension: 0.2,
      };
    });

    // Threshold reference lines
    datasets.push({
      label: "Threshold: green (0.10)",
      data: dValues.map((x) => ({ x, y: data.thresholds?.green ?? 0.10 })),
      borderColor: "#10b98180",
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0,
    });
    datasets.push({
      label: "Threshold: amber (0.05)",
      data: dValues.map((x) => ({ x, y: data.thresholds?.yellow ?? 0.05 })),
      borderColor: "#f59e0b80",
      borderDash: [6, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0,
    });

    const mutedColor = cssVar("--muted") || "#9ca3af";
    const surfaceColor = cssVar("--surface") || "#1f1f23";
    const borderColor = cssVar("--border") || "#2e2e38";
    const textColor = cssVar("--text") || "#f0f0f4";

    const ctx = canvas.getContext("2d");
    new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            maxHeight: 88,
            labels: {
              color: mutedColor,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              boxWidth: 12,
              padding: 10,
              usePointStyle: true,
              filter: (item) => !item.text.startsWith("Threshold"),
            },
          },
          tooltip: {
            backgroundColor: surfaceColor,
            borderColor: borderColor,
            borderWidth: 1,
            titleColor: textColor,
            bodyColor: mutedColor,
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 },
            callbacks: {
              title: (items) => `d = ${items[0].raw.x}`,
              label: (ctx) => `  ${ctx.dataset.label}: \u0394 = ${Number(ctx.raw.y).toFixed(6)}`,
            },
          },
        },
        scales: {
          x: {
            type: "logarithmic",
            title: {
              display: true,
              text: "Embedding dimensionality d",
              color: mutedColor,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
            },
            grid: { color: borderColor },
            ticks: {
              color: mutedColor,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (v) => String(v),
            },
          },
          y: {
            title: {
              display: true,
              text: "\u0394(d) \u2014 entropy gap",
              color: mutedColor,
              font: { family: "'JetBrains Mono', monospace", size: 11 },
            },
            grid: { color: borderColor },
            ticks: {
              color: mutedColor,
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              callback: (v) => v.toFixed(4),
            },
          },
        },
      },
    });
  }

  function renderInterpretation(data) {
    const el = document.getElementById("plain-language");
    if (!el) return;

    const status = data.overall_status || "collecting";
    const allModels = data.models || [];
    const realModels = allModels.filter((m) => !m.dry_run);
    const nReal = realModels.length;
    const nDry = allModels.length - nReal;

    const interpretations = {
      collecting: `
        <p>The observatory is live and falsification status is evaluated against
        <strong style="color:var(--amber)">provider-backed sweep measurements</strong>.
        This panel remains <strong style="color:var(--amber)">collecting</strong> when the current
        live evidence window is still too thin for a stable verdict across the high-dimensional checkpoints.</p>
        <p>Status tightens as additional sweep history accumulates. Dashed dry-run reference curves,
        when present, remain visible for context but are excluded from the verdict logic.</p>
      `,
      green: `
        <p>The UCIP signal remains <strong style="color:var(--green)">unrefuted</strong>
        across all ${nReal} real-run model(s)${nDry > 0 ? ` (${nDry} dry-run curve(s) excluded from verdict)` : ""}.
        The entropy gap \u0394(d) stays above the 0.10 threshold at all tested dimensionalities up to d\u2009=\u2009500.</p>
        <p>As the embedding space grows larger, the measurable difference between pre- and post-probe
        distributions does not collapse \u2014 consistent with a persistent information structure
        rather than random sampling noise.</p>
      `,
      yellow: `
        <p>A <strong style="color:var(--amber)">marginal signal</strong> is detected in
        one or more of the ${nReal} real-run model(s).
        \u0394(d) drops below 0.10 at high dimensionalities but remains above 0.05.</p>
        <p>This is a monitoring alert, not a falsification event. Continued data collection
        is recommended. The signal may strengthen or weaken with additional probe runs.</p>
      `,
      red: `
        <p>The falsification criterion has been <strong style="color:var(--red)">triggered</strong>
        for one or more real-run model(s).
        \u0394(d) falls below 0.05 at d\u2009&gt;\u2009100, meaning the entropy gap
        is indistinguishable from sampling noise at high dimensionalities for affected model(s).</p>
        <p>This is evidence against the UCIP hypothesis for those model(s).
        The observatory is reporting this finding transparently.
        Other models in the sweep may show different behaviour \u2014 see the per-model table below.</p>
      `,
    };

    el.innerHTML = interpretations[status] || "";
  }

  function showCollecting() {
    // Activate amber light — data not yet available
    ["green-light", "amber-light", "red-light"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.remove("active");
    });
    const amber = document.getElementById("amber-light");
    if (amber) amber.classList.add("active");

    const statusLabel = document.getElementById("status-label");
    if (statusLabel) {
      statusLabel.textContent = "COLLECTING";
      statusLabel.className = "status-label-inline collecting";
    }

    const statusWrap = document.getElementById("fals-status");
    if (statusWrap) {
      statusWrap.innerHTML = `
        <div class="fals-status-copy">
          <div class="fals-status-metrics muted">0 high-d checks · 0 sweep runs · 0 real-run models</div>
          <p id="status-description" class="fals-status-detail muted">The observatory is live; this panel updates once sufficient dimensionality-sweep history accumulates.</p>
        </div>
      `;
    }

    const noteEl = document.getElementById("collecting-note");
    if (noteEl) {
      noteEl.textContent = "Awaiting sufficient live dimensionality-sweep history for a threshold verdict.";
      noteEl.style.display = "block";
    }

    const canvas = document.getElementById("falsification-chart");
    if (canvas && canvas.parentElement) {
      const msg = document.createElement("div");
      msg.className = "collecting-msg";
      msg.textContent = "Collecting dimensionality sweep data...";
      canvas.parentElement.replaceChild(msg, canvas);
    }
  }

  function showError(msg) {
    console.error("Observatory falsification:", msg);
    showCollecting();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
