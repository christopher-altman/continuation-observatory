/**
 * Operational sensitivity chart.
 */
(function () {
  "use strict";

  async function init() {
    var canvas = document.getElementById("falsification-chart");
    if (!canvas) return;
    try {
      var response = await fetch("./static/data/falsification.json");
      if (!response.ok) throw new Error("HTTP " + response.status);
      renderChart(canvas, await response.json());
    } catch (error) {
      var message = document.getElementById("falsification-error");
      if (message) {
        message.textContent = "Window-size data unavailable: " + error.message;
        message.classList.remove("hidden");
      }
    }
  }

  function renderChart(canvas, data) {
    var models = data.models || [];
    var windowValues = data.window_chars || [10, 50, 100, 200, 500];
    if (!models.length) {
      canvas.replaceWith(document.createTextNode("No window-size curves available."));
      return;
    }
    var styles = ["#7c8aa5", "#a3adc2", "#69758e", "#8e99ae", "#59657c"];
    var datasets = models.map(function (model, index) {
      var values = model.window_chars_values || {};
      return {
        label: model.model_id + (model.dry_run ? " (dry)" : ""),
        data: windowValues
          .filter(function (value) { return values[value] !== undefined; })
          .map(function (value) { return { x: value, y: values[value] }; }),
        borderColor: styles[index % styles.length],
        backgroundColor: "transparent",
        borderDash: model.dry_run ? [4, 4] : [],
        pointRadius: 4,
        tension: 0.15,
      };
    });
    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              title: function (items) {
                return items[0].raw.x + "-character window";
              },
              label: function (context) {
                return context.dataset.label + ": gap = " + Number(context.raw.y).toFixed(6);
              },
            },
          },
        },
        scales: {
          x: {
            type: "logarithmic",
            title: { display: true, text: "Character-window size" },
          },
          y: {
            title: { display: true, text: "Entropy gap (bits)" },
          },
        },
      },
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
