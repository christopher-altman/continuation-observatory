/**
 * table.js — Sortable model comparison table.
 * Uses an explicit template-provided data source and preserves server-rendered rows
 * until replacement data has been fetched and rendered successfully.
 */

(function () {
  "use strict";

  let sortCol = "entropy_delta";
  let sortDir = -1; // -1 = desc, 1 = asc
  let allModels = [];
  let initialRows = [];
  let figuresPrefix = "/static/figures/";

  function getTable() {
    return document.querySelector("#models-table");
  }

  function getTbody() {
    const table = getTable();
    return table ? table.querySelector("tbody") : null;
  }

  function parseNumber(value) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === "—" || trimmed === "--") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseServerRows() {
    const tbody = getTbody();
    if (!tbody) return [];
    const rows = Array.from(tbody.querySelectorAll("tr"));
    return rows.map(function (row) {
      const cells = Array.from(row.children);
      if (cells.length !== 6) return null;
      const rowText = row.textContent || "";
      if (/Collecting data/i.test(rowText)) return null;
      return {
        provider: (cells[0].textContent || "").trim() || "—",
        model_id: (cells[1].textContent || "").trim() || "—",
        entropy_delta: parseNumber(cells[2].textContent),
        probes: Array.from(cells[3].querySelectorAll(".probe-pill")).map(function (pill) {
          return (pill.textContent || "").trim();
        }),
        timestamp: (cells[4].textContent || "").trim() || null,
        figure: (cells[5].querySelector("a") || {}).getAttribute ? cells[5].querySelector("a").getAttribute("href") : null,
      };
    }).filter(Boolean);
  }

  function normalizeModel(model) {
    if (!model || typeof model !== "object") return null;
    return {
      provider: model.provider || "—",
      model_id: model.model_id || "—",
      entropy_delta: model.entropy_delta ?? null,
      probes: Array.isArray(model.probes) ? model.probes : [],
      timestamp: model.timestamp || model.last_seen || null,
      figure: model.figure || null,
    };
  }

  function normalizeFetchedModels(payload) {
    const records = Array.isArray(payload) ? payload : Array.isArray(payload && payload.models) ? payload.models : [];
    const normalized = records.map(normalizeModel).filter(Boolean);
    if (!normalized.length) return [];
    const fallbackById = new Map(initialRows.map(function (row) {
      return [row.model_id, row];
    }));
    return normalized.map(function (row) {
      const fallback = fallbackById.get(row.model_id) || {};
      return {
        provider: row.provider || fallback.provider || "—",
        model_id: row.model_id || fallback.model_id || "—",
        entropy_delta: row.entropy_delta ?? fallback.entropy_delta ?? null,
        probes: row.probes && row.probes.length ? row.probes : (fallback.probes || []),
        timestamp: row.timestamp || fallback.timestamp || null,
        figure: row.figure || fallback.figure || null,
      };
    });
  }

  function buildFigureHref(figure) {
    if (!figure) return null;
    if (/^(https?:)?\//.test(figure)) return figure;
    return figuresPrefix.replace(/\/+$/, "/") + String(figure).replace(/^\/+/, "");
  }

  async function init() {
    const table = getTable();
    if (!table) return;
    initialRows = parseServerRows();
    allModels = initialRows.slice();
    figuresPrefix = table.dataset.figuresPrefix || figuresPrefix;
    wireSort();

    const modelsUrl = table.dataset.modelsUrl;
    if (!modelsUrl) return;

    try {
      const resp = await fetch(modelsUrl, { credentials: "same-origin" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const fetchedModels = normalizeFetchedModels(data);
      if (!fetchedModels.length) {
        if (!allModels.length) showCollecting();
        return;
      }
      allModels = fetchedModels;
      renderTable();
    } catch (err) {
      console.error("Observatory models fetch error:", err.message);
      if (!allModels.length) showCollecting();
    }
  }

  function renderTable() {
    const tbody = getTbody();
    if (!tbody) return;

    const sorted = [...allModels].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });

    tbody.innerHTML = sorted
      .map((m) => {
        const delta = m.entropy_delta;
        const deltaStr = delta !== null && delta !== undefined
          ? Number(delta).toFixed(6)
          : "—";
        const deltaClass =
          delta === null || delta === undefined ? "val-muted"
          : delta > 0.05 ? "val-positive"
          : delta < -0.05 ? "val-negative"
          : "val-neutral";

        const ts = m.timestamp ? m.timestamp.slice(0, 10) : "—";
        const probes = (m.probes || [])
          .map((p) => `<span class="probe-pill">${escHtml(p.replace("_", " "))}</span>`)
          .join("");
        const figureHref = buildFigureHref(m.figure);
        const figLink = figureHref
          ? `<a href="${escHtml(figureHref)}" target="_blank">png</a>`
          : "—";

        return `<tr>
          <td>${escHtml(m.provider || "—")}</td>
          <td><code>${escHtml(m.model_id || "—")}</code></td>
          <td class="${deltaClass}">${deltaStr}</td>
          <td><div class="probe-list">${probes}</div></td>
          <td class="val-muted">${ts}</td>
          <td>${figLink}</td>
        </tr>`;
      })
      .join("");

    // Update sort indicators
    document.querySelectorAll("#models-table thead th[data-sort]").forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.sort === sortCol) {
        th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
      }
    });
  }

  function wireSort() {
    document.querySelectorAll("#models-table thead th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (col === sortCol) {
          sortDir *= -1;
        } else {
          sortCol = col;
          sortDir = -1;
        }
        renderTable();
      });
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showCollecting() {
    const tbody = getTbody();
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--muted);font-family:var(--font-mono);padding:1.25rem 1rem">
        Collecting data \u2014 run probes to populate.</td></tr>`;
    }
  }

  function showError(msg) {
    console.error("Observatory models:", msg);
    showCollecting();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
