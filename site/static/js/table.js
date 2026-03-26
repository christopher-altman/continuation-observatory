/**
 * table.js — Sortable model comparison table.
 * Loads from static/data/models.json and populates #models-table.
 */

(function () {
  "use strict";

  let sortCol = "entropy_delta";
  let sortDir = -1; // -1 = desc, 1 = asc
  let allModels = [];

  async function init() {
    try {
      const resp = await fetch("./static/data/models.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      allModels = data.models || [];
      renderTable();
      wireSort();
    } catch (err) {
      console.error("Observatory models fetch error:", err.message);
      showCollecting();
    }
  }

  function renderTable() {
    const tbody = document.querySelector("#models-table tbody");
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
        const figLink = m.figure
          ? `<a href="static/figures/${escHtml(m.name || m.model_id)}/metrics.png" target="_blank">png</a>`
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
    const tbody = document.querySelector("#models-table tbody");
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
