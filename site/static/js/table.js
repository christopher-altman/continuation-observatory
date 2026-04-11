/**
 * table.js — Grouped models surface.
 * Fetches static/data/models.json and upgrades the server-rendered grouped sections.
 */

(function () {
  "use strict";

  let figuresPrefix = "/static/figures/";

  function getRoot() {
    return document.querySelector("#models-root");
  }

  function buildFigureHref(figure) {
    if (!figure) return null;
    if (/^(https?:)?\//.test(figure)) return figure;
    return figuresPrefix.replace(/\/+$/, "/") + String(figure).replace(/^\/+/, "");
  }

  function parseTimestamp(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeModel(model) {
    if (!model || typeof model !== "object") return null;
    return {
      provider: model.provider || "—",
      model_id: model.model_id || "—",
      display_name: model.display_name || model.model_id || "—",
      entropy_delta: model.entropy_delta ?? null,
      entropy_interpretation: model.entropy_interpretation || "No current sample",
      probes: Array.isArray(model.probes) ? model.probes : [],
      timestamp: model.timestamp || null,
      figure: model.figure || null,
      telemetry_state: model.telemetry_state || "unavailable",
      telemetry_label: model.telemetry_label || "No current sample",
      probe_coverage_count: Number.isFinite(model.probe_coverage_count) ? model.probe_coverage_count : 0,
      probe_coverage_total: Number.isFinite(model.probe_coverage_total) ? model.probe_coverage_total : 0,
    };
  }

  function normalizeFetchedModels(payload) {
    const records = Array.isArray(payload)
      ? payload
      : Array.isArray(payload && payload.models)
      ? payload.models
      : [];
    return records.map(normalizeModel).filter(Boolean);
  }

  function sortGroupedRows(rows) {
    const grouped = {
      current: [],
      partial: [],
      unavailable: [],
    };
    rows.forEach(function (row) {
      const state = grouped[row.telemetry_state] ? row.telemetry_state : "unavailable";
      grouped[state].push(row);
    });

    ["current", "partial"].forEach(function (state) {
      grouped[state].sort(function (left, right) {
        return (parseTimestamp(right.timestamp) || 0) - (parseTimestamp(left.timestamp) || 0);
      });
    });
    grouped.unavailable.sort(function (left, right) {
      return String(left.display_name || left.model_id).localeCompare(String(right.display_name || right.model_id));
    });
    return grouped;
  }

  function interpretationClass(label) {
    const normalized = String(label || "").toLowerCase();
    if (normalized === "increased") return "models-metric-interpretation--increased";
    if (normalized === "decreased") return "models-metric-interpretation--decreased";
    if (normalized === "stable") return "models-metric-interpretation--stable";
    return "models-metric-interpretation--muted";
  }

  function formatTimestamp(timestamp) {
    return timestamp ? String(timestamp).slice(0, 19).replace("T", " ") : "—";
  }

  function renderRows(rows) {
    return rows.map(function (model) {
      const delta = model.entropy_delta;
      const deltaMarkup = delta !== null && delta !== undefined
        ? Number(delta).toFixed(6)
        : "—";
      const probes = model.probes
        .map(function (probe) {
          return `<span class="probe-pill">${escHtml(String(probe).replace(/_/g, " "))}</span>`;
        })
        .join("");
      const figureHref = buildFigureHref(model.figure);
      const figureMarkup = figureHref
        ? `<a href="${escHtml(figureHref)}" target="_blank">png</a>`
        : "—";

      return `<tr>
        <td>${escHtml(model.provider)}</td>
        <td>
          <div class="models-model-cell">
            <code>${escHtml(model.model_id)}</code>
            <span class="models-state-label">${escHtml(model.telemetry_label)}</span>
          </div>
        </td>
        <td>
          <div class="models-metric-cell">
            <strong class="models-metric-value">${deltaMarkup}</strong>
            <span class="models-metric-interpretation ${interpretationClass(model.entropy_interpretation)}">${escHtml(model.entropy_interpretation)}</span>
          </div>
        </td>
        <td>
          <div class="models-coverage-cell">
            <span class="models-coverage-ratio">${model.probe_coverage_count}/${model.probe_coverage_total}</span>
            <div class="probe-list">${probes}</div>
          </div>
        </td>
        <td class="val-muted">${escHtml(formatTimestamp(model.timestamp))}</td>
        <td>${figureMarkup}</td>
      </tr>`;
    }).join("");
  }

  function renderTable(rows) {
    return `<div class="table-wrap">
      <table class="models-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th>entropy_delta</th>
            <th>Probe Coverage</th>
            <th>Last Run</th>
            <th>Figure</th>
          </tr>
        </thead>
        <tbody>${renderRows(rows)}</tbody>
      </table>
    </div>`;
  }

  function renderSection(title, rows, summaryText, collapsed) {
    if (!rows.length) return "";
    const tableMarkup = renderTable(rows);
    if (collapsed) {
      return `<details class="panel models-section models-section--collapsed">
        <summary>
          <span class="panel-title">${escHtml(title)}</span>
          <span class="models-section-meta">${rows.length} models</span>
        </summary>
        <p class="models-section-copy">${escHtml(summaryText)}</p>
        ${tableMarkup}
      </details>`;
    }
    return `<section class="panel models-section">
      <div class="panel-title">${escHtml(title)}</div>
      <p class="models-section-copy">${escHtml(summaryText)}</p>
      ${tableMarkup}
    </section>`;
  }

  function renderEmptyCurrent() {
    return `<section class="panel models-section models-section--empty">
      <div class="panel-title">Current Readings</div>
      <p class="models-section-copy">No models currently meet the live-readout threshold. Recent incomplete and no-sample entries remain available below when present.</p>
    </section>`;
  }

  function renderGroupedModels(rows) {
    const grouped = sortGroupedRows(rows);
    const sections = [];

    if (grouped.current.length) {
      sections.push(renderSection(
        "Current Readings",
        grouped.current,
        "Models with current valid telemetry according to the observatory’s existing cadence semantics.",
        false
      ));
    } else {
      sections.push(renderEmptyCurrent());
    }

    if (grouped.partial.length) {
      sections.push(renderSection(
        "Partial / Recent but Incomplete",
        grouped.partial,
        "Recent or incomplete evidence exists for these models, but not enough for a full current display.",
        true
      ));
    }

    if (grouped.unavailable.length) {
      sections.push(renderSection(
        "No Current Sample",
        grouped.unavailable,
        "Tracked catalog entries without a current meaningful sample. Kept secondary so blank rows do not dominate the live surface.",
        true
      ));
    }

    return sections.join("");
  }

  async function init() {
    const root = getRoot();
    if (!root) return;
    figuresPrefix = root.dataset.figuresPrefix || figuresPrefix;
    const modelsUrl = root.dataset.modelsUrl;
    if (!modelsUrl) return;

    try {
      const resp = await fetch(modelsUrl, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const models = normalizeFetchedModels(await resp.json());
      if (!models.length) return;
      root.innerHTML = renderGroupedModels(models);
    } catch (err) {
      console.error("Observatory models fetch error:", err.message);
    }
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
