const root = document.querySelector("#constellation-root");

if (root) {
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let controller = null;
  let latestPayload = {
    models: [],
    constellation: { nodes: [], edges: [], threshold: 0.6 },
    ciiHistory: {},
    focusModelId: null,
    range: "24h",
    toggles: { history: true, compare: false, threshold: true },
    summary: {},
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function lerp(start, end, alpha) {
    return start + (end - start) * alpha;
  }

  function easeOutCubic(value) {
    const clamped = clamp(value, 0, 1);
    return 1 - Math.pow(1 - clamped, 3);
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  function hasWebGL() {
    try {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    } catch (_) {
      return false;
    }
  }

  const FOCUS_RING_ORDER = ["cii", "ips", "srs", "tci"];
  const FOCUS_RING_START_ANGLE = 216;
  const FOCUS_RING_MAX_SWEEP = 324;
  const LABEL_QUALIFIER_SUFFIXES = ["Fast Reasoning", "Reasoning"];

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function normalizeMetric(value) {
    return clamp(isFiniteNumber(value) ? value : 0, 0, 1);
  }

  function thresholdRelativeMetric(rangeCii, threshold) {
    if (!isFiniteNumber(rangeCii)) return 0;
    if (!isFiniteNumber(threshold)) return normalizeMetric(rangeCii);
    return clamp(0.5 + (rangeCii - threshold), 0, 1);
  }

  function resolveFocusRingMetrics(modelMetrics, rangeCii, threshold) {
    const metrics = modelMetrics || {};
    const tciValue = isFiniteNumber(metrics.tci)
      ? metrics.tci
      : isFiniteNumber(metrics.mpg)
      ? metrics.mpg
      : thresholdRelativeMetric(rangeCii, threshold);

    return [
      { key: "cii", label: "CII", value: normalizeMetric(metrics.cii != null ? metrics.cii : rangeCii) },
      { key: "ips", label: "IPS", value: normalizeMetric(metrics.ips) },
      { key: "srs", label: "SRS", value: normalizeMetric(metrics.srs) },
      { key: "tci", label: isFiniteNumber(metrics.tci) ? "TCI" : isFiniteNumber(metrics.mpg) ? "MPG" : "THR", value: normalizeMetric(tciValue) },
    ];
  }

  function buildFallbackRingMarkup(node) {
    if (!node || !Array.isArray(node.ringMetrics) || !node.ringMetrics.length) return "";
    const guideMarkup = node.ringMetrics.map(function (metric, index) {
      const radius = 27 + index * 6.4;
      const sweep = Math.max(6, metric.value * FOCUS_RING_MAX_SWEEP);
      const trackPath = describeArc(50, 50, radius, radius, FOCUS_RING_START_ANGLE, FOCUS_RING_START_ANGLE + FOCUS_RING_MAX_SWEEP);
      const activePath = describeArc(50, 50, radius, radius, FOCUS_RING_START_ANGLE, FOCUS_RING_START_ANGLE + sweep);
      return `
        <path class="observatory-fallback-ring-track observatory-fallback-ring-track--${metric.key}" d="${trackPath}"></path>
        <path class="observatory-fallback-ring observatory-fallback-ring--${metric.key}" d="${activePath}"></path>
      `;
    }).join("");
    const labelMarkup = node.ringMetrics.map(function (metric) {
      return `<span class="observatory-fallback-ring-label observatory-fallback-ring-label--${metric.key}">${metric.label}</span>`;
    }).join("");
    return `
      <span class="observatory-fallback-rings" aria-hidden="true">
        <svg viewBox="0 0 100 100" class="observatory-fallback-rings-svg">${guideMarkup}</svg>
        <span class="observatory-fallback-ring-legend">${labelMarkup}</span>
      </span>
    `;
  }

  function buildFieldNodes(payload) {
    const modelsById = new Map((payload.models || []).map(function (model) {
      return [model.model_id, model];
    }));
    const sorted = (payload.constellation.nodes || [])
      .map(function (node) {
        const model = modelsById.get(node.id) || {};
        const metrics = model.metrics || {};
        const rangeCii = typeof model.rangeCii === "number"
          ? model.rangeCii
          : (typeof node.cii === "number" ? node.cii : metrics.cii) || 0;
        const telemetryState = node.telemetry_state || (model.status === "active" ? "live" : model.status || "inactive");
        return {
          id: node.id,
          label: node.label,
          labelDisplay: splitFocusedLabel(node.label),
          provider: node.provider || model.provider || "unknown",
          rank: typeof model.rank === "number" ? model.rank : null,
          relativeStanding: model.relativeStanding || null,
          metrics: metrics,
          cii: typeof node.cii === "number" ? node.cii : metrics.cii || 0,
          rangeCii: rangeCii,
          rangeTrend: typeof model.rangeTrend === "number" ? model.rangeTrend : 0,
          historyDepth: typeof model.historyDepth === "number" ? model.historyDepth : ((payload.ciiHistory && payload.ciiHistory[node.id]) || []).length,
          ips: typeof node.ips === "number" ? node.ips : metrics.ips || 0,
          srs: typeof node.srs === "number" ? node.srs : metrics.srs || 0,
          stale: Boolean(model.stale),
          live: Boolean(model.live),
          lastSeen: node.last_seen || model.last_seen || null,
          ringMetrics: resolveFocusRingMetrics(metrics, rangeCii, payload.constellation && payload.constellation.threshold),
          telemetryState: telemetryState,
          inactive: telemetryState !== "live",
        };
      })
      .sort(function (left, right) {
        return (right.rangeCii || right.cii || 0) - (left.rangeCii || left.cii || 0);
      });

    const providers = Array.from(new Set(sorted.map(function (node) {
      return node.provider;
    })));
    const providerToBand = new Map(providers.map(function (provider, index) {
      return [provider, index];
    }));
    const maxScore = Math.max.apply(null, sorted.map(function (node) {
      return node.rangeCii || node.cii || 0;
    }).concat([1]));

    let activeCount = 0;
    return sorted.map(function (node, index) {
      const score = node.rangeCii || node.cii || 0;
      let tier;
      if (node.inactive) {
        tier = "outer";
      } else {
        const activeIndex = activeCount++;
        tier = activeIndex < 3 ? "flagship" : activeIndex < 7 ? "secondary" : "outer";
      }
      const baseHash = hashString(`${node.id}:${node.provider}`);
      const scoreNorm = clamp(score / maxScore, 0.08, 1);
      const rankNorm = sorted.length > 1 ? index / (sorted.length - 1) : 0;
      const providerBand = providerToBand.get(node.provider) || 0;
      const providerMid = (providers.length - 1) / 2;
      const bandBias = (providerBand - providerMid) * 0.52;
      const tierRadius = node.inactive ? 6.5 : tier === "flagship" ? 1.65 : tier === "secondary" ? 3.35 : 5.15;
      const radius = tierRadius + rankNorm * 0.65 + (1 - scoreNorm) * 0.45 + (((baseHash * 7.13) % 1) - 0.5) * (node.inactive ? 0.8 : 0.42);
      const angle = (baseHash * Math.PI * 2) + (index * 0.97) + providerBand * 0.18;
      const x = Math.cos(angle) * radius;
      const y = bandBias + Math.sin(angle * 1.18) * (tier === "flagship" ? 0.42 : tier === "secondary" ? 0.56 : 0.68) + (((baseHash * 13.1) % 1) - 0.5) * (node.inactive ? 0.35 : 0.18);
      const z = (node.inactive ? 1.8 : tier === "flagship" ? -1.2 : tier === "secondary" ? 0.1 : 1.2) + (node.rangeTrend || 0) * 2.1 + (((baseHash * 11.37) % 1) - 0.5) * (node.inactive ? 2.5 : tier === "outer" ? 1.5 : 0.95);
      const inactiveScale = node.inactive ? 0.72 : 1;
      return {
        ...node,
        tier,
        size: (tier === "flagship" ? 0.36 + scoreNorm * 0.32 : tier === "secondary" ? 0.24 + scoreNorm * 0.22 : 0.16 + scoreNorm * 0.15) * inactiveScale,
        haloScale: tier === "flagship" ? 2.6 : tier === "secondary" ? 1.92 : 1.36,
        glow: tier === "flagship" ? 1 : tier === "secondary" ? 0.78 : 0.52,
        orbitPhase: baseHash * Math.PI * 2,
        driftSpeed: (0.4 + (((baseHash * 17.11) % 1) * 0.36)) * (node.inactive ? 0.3 : 1),
        trailEligible: !node.inactive && node.historyDepth >= 3,
        anchor: { x, y, z },
      };
    });
  }

  function topNeighbors(payload, modelId, limit = 3) {
    return (payload.constellation.edges || [])
      .filter(function (edge) {
        return edge.source === modelId || edge.target === modelId;
      })
      .sort(function (left, right) {
        return right.similarity - left.similarity;
      })
      .slice(0, limit)
      .map(function (edge) {
        return edge.source === modelId ? edge.target : edge.source;
      });
  }

  function splitFocusedLabel(label) {
    const full = String(label || "").replace(/\s+/g, " ").trim();
    for (let index = 0; index < LABEL_QUALIFIER_SUFFIXES.length; index += 1) {
      const qualifier = LABEL_QUALIFIER_SUFFIXES[index];
      const suffix = ` ${qualifier}`;
      if (full.length > suffix.length && full.endsWith(suffix)) {
        return {
          full,
          primary: full.slice(0, -suffix.length).trim(),
          qualifier,
        };
      }
    }
    return {
      full,
      primary: full,
      qualifier: "",
    };
  }

  function buildLabelTitleMarkup(baseClass, labelDisplay) {
    const display = labelDisplay || splitFocusedLabel("");
    return `
      <span class="${baseClass}-title${display.qualifier ? ` ${baseClass}-title--split` : ""}">
        <span class="${baseClass}-name ${baseClass}-name--full">${display.full}</span>
        ${display.qualifier ? `
          <span class="${baseClass}-name ${baseClass}-name--primary">${display.primary}</span>
          <span class="${baseClass}-qualifier">${display.qualifier}</span>
        ` : ""}
      </span>
    `;
  }

  function createLabelElement(node) {
    const element = document.createElement("div");
    element.className = `observatory-node-label observatory-node-label--${node.tier}`;
    if (node.labelDisplay && node.labelDisplay.qualifier) {
      element.classList.add("has-qualifier");
    }
    element.innerHTML = `
      ${buildLabelTitleMarkup("observatory-node-label", node.labelDisplay || splitFocusedLabel(node.label))}
      <span class="observatory-node-label-meta">${node.provider} · ${(node.rangeCii || node.cii).toFixed(3)}</span>
    `;
    return element;
  }

  /* ── Hover tooltip with full metrics breakdown ── */
  function createTooltipElement() {
    const el = document.createElement("div");
    el.className = "observatory-tooltip";
    el.style.display = "none";
    return el;
  }

  function formatTooltipHTML(node) {
    const trend = node.rangeTrend || 0;
    const trendSign = trend > 0 ? "+" : "";
    const trendClass = trend > 0.01 ? " is-rising" : trend < -0.01 ? " is-falling" : "";
    return `
      <div class="observatory-tooltip-header">${node.label}</div>
      <div class="observatory-tooltip-provider">${node.provider} · ${node.tier}</div>
      <div class="observatory-tooltip-metrics">
        <div class="observatory-tooltip-row"><span>CII</span><span>${(node.rangeCii || node.cii).toFixed(3)}</span></div>
        <div class="observatory-tooltip-row"><span>IPS</span><span>${node.ips.toFixed(3)}</span></div>
        <div class="observatory-tooltip-row"><span>SRS</span><span>${node.srs.toFixed(3)}</span></div>
        <div class="observatory-tooltip-row${trendClass}"><span>Trend</span><span>${trendSign}${trend.toFixed(3)}</span></div>
      </div>
    `;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  function createSvgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes || {}).forEach(function ([key, value]) {
      element.setAttribute(key, String(value));
    });
    return element;
  }

  function polarPoint(cx, cy, radiusX, radiusY, angle) {
    const radians = (angle - 90) * (Math.PI / 180);
    return {
      x: cx + (radiusX * Math.cos(radians)),
      y: cy + (radiusY * Math.sin(radians)),
    };
  }

  function describeArc(cx, cy, radiusX, radiusY, startAngle, endAngle) {
    const start = polarPoint(cx, cy, radiusX, radiusY, endAngle);
    const end = polarPoint(cx, cy, radiusX, radiusY, startAngle);
    const largeArcFlag = Math.abs(endAngle - startAngle) <= 180 ? "0" : "1";
    return `M ${start.x} ${start.y} A ${radiusX} ${radiusY} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
  }

  class ObservatoryScreenOverlay {
    constructor(shell, reducedMotion) {
      this.shell = shell;
      this.reducedMotion = reducedMotion;
      this.width = 0;
      this.height = 0;
      this.focusId = null;
      this.focusChangedAt = 0;

      this.svg = createSvgElement("svg", {
        class: "observatory-screen-overlay",
        "aria-hidden": "true",
      });
      this.staticGroup = createSvgElement("g", { class: "observatory-screen-overlay__static" });
      this.focusGroup = createSvgElement("g", { class: "observatory-screen-overlay__focus" });
      this.focusTrace = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-trace",
        "stroke-width": "1.15",
      });
      this.focusEcho = createSvgElement("ellipse", {
        class: "observatory-screen-overlay__focus-echo",
        "stroke-width": "1.2",
        "stroke-dasharray": "14 10",
      });
      this.focusRing = createSvgElement("ellipse", {
        class: "observatory-screen-overlay__focus-ring",
        "stroke-width": "1.65",
      });
      this.counterRingA = createSvgElement("ellipse", {
        class: "observatory-screen-overlay__focus-ring",
        "stroke-width": "1.1",
        "stroke-dasharray": "18 8",
      });
      this.counterRingB = createSvgElement("ellipse", {
        class: "observatory-screen-overlay__focus-echo",
        "stroke-width": "1",
        "stroke-dasharray": "9 7",
      });
      this.focusSweep = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-sweep",
        "stroke-width": "2.1",
      });
      this.bracketNorthWest = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "2.1",
      });
      this.bracketNorthEast = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "2.1",
      });
      this.bracketSouthWest = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "2.1",
      });
      this.bracketSouthEast = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "2.1",
      });
      this.scanLine = createSvgElement("line", {
        class: "observatory-screen-overlay__scan-line",
      });
      this.annotationRect = createSvgElement("rect", {
        class: "observatory-screen-overlay__annotation",
        rx: "12",
        ry: "12",
        width: "232",
        height: "56",
      });
      this.annotationText = createSvgElement("text", {
        class: "observatory-screen-overlay__annotation-text",
        "font-size": "9",
      });
      this.annotationMeta = createSvgElement("text", {
        class: "observatory-screen-overlay__annotation-meta",
        "font-size": "7",
      });

      this.focusGroup.append(
        this.focusTrace,
        this.focusEcho,
        this.focusRing,
        this.counterRingA,
        this.counterRingB,
        this.focusSweep,
        this.bracketNorthWest,
        this.bracketNorthEast,
        this.bracketSouthWest,
        this.bracketSouthEast,
        this.scanLine,
        this.annotationRect,
        this.annotationText,
        this.annotationMeta,
      );
      this.svg.append(this.staticGroup, this.focusGroup);
      this.shell.appendChild(this.svg);
    }

    setFocus(modelId, time) {
      if (modelId !== this.focusId) {
        this.focusId = modelId;
        this.focusChangedAt = time || performance.now();
      }
      this.svg.classList.toggle("is-locked", Boolean(modelId));
    }

    resize(width, height) {
      this.width = width;
      this.height = height;
      this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      this.renderStatic();
    }

    renderStatic() {
      this.staticGroup.replaceChildren();
      if (!this.width || !this.height) return;

      const cx = this.width * 0.52;
      const cy = this.height * 0.54;
      const outerRadiusX = Math.min(this.width * 0.32, this.height * 0.44);
      const outerRadiusY = outerRadiusX * 0.72;
      const midRadiusX = outerRadiusX * 0.74;
      const midRadiusY = outerRadiusY * 0.74;
      const innerRadiusX = outerRadiusX * 0.42;
      const innerRadiusY = outerRadiusY * 0.42;
      const coreWash = createSvgElement("ellipse", {
        cx,
        cy,
        rx: outerRadiusX * 1.22,
        ry: outerRadiusY * 1.18,
        fill: "rgba(78, 120, 198, 0.035)",
        stroke: "none",
      });

      const sectorLeft = createSvgElement("path", {
        d: [
          `M ${cx} ${cy}`,
          describeArc(cx, cy, outerRadiusX * 0.94, outerRadiusY * 0.94, 212, 302),
          "Z",
        ].join(" "),
        fill: "rgba(112, 173, 234, 0.05)",
        stroke: "none",
      });
      const sectorRight = createSvgElement("path", {
        d: [
          `M ${cx} ${cy}`,
          describeArc(cx, cy, outerRadiusX * 0.82, outerRadiusY * 0.82, 34, 108),
          "Z",
        ].join(" "),
        fill: "rgba(160, 198, 244, 0.035)",
        stroke: "none",
      });
      const outerEllipse = createSvgElement("ellipse", {
        cx,
        cy,
        rx: outerRadiusX,
        ry: outerRadiusY,
        "stroke-width": "1.2",
        fill: "none",
      });
      const midEllipse = createSvgElement("ellipse", {
        cx,
        cy,
        rx: midRadiusX,
        ry: midRadiusY,
        "stroke-width": "1",
        fill: "none",
        opacity: "0.75",
      });
      const innerEllipse = createSvgElement("ellipse", {
        cx,
        cy,
        rx: innerRadiusX,
        ry: innerRadiusY,
        "stroke-width": "0.9",
        fill: "none",
        opacity: "0.62",
      });
      const upperArc = createSvgElement("path", {
        d: describeArc(cx, cy, outerRadiusX * 1.08, outerRadiusY * 1.02, 198, 344),
        "stroke-width": "1.1",
        fill: "none",
        opacity: "0.84",
      });
      const lowerArc = createSvgElement("path", {
        d: describeArc(cx, cy, outerRadiusX * 0.92, outerRadiusY * 0.88, 28, 158),
        "stroke-width": "0.95",
        fill: "none",
        opacity: "0.64",
      });
      const horizon = createSvgElement("line", {
        x1: this.width * 0.1,
        y1: cy,
        x2: this.width * 0.9,
        y2: cy,
        "stroke-width": "0.9",
        opacity: "0.54",
      });
      const meridian = createSvgElement("line", {
        x1: cx,
        y1: this.height * 0.14,
        x2: cx,
        y2: this.height * 0.86,
        "stroke-width": "0.7",
        opacity: "0.4",
      });

      this.staticGroup.append(
        coreWash,
        sectorLeft,
        sectorRight,
        outerEllipse,
        midEllipse,
        innerEllipse,
        upperArc,
        lowerArc,
        horizon,
        meridian,
      );

      [
        { rx: outerRadiusX * 1.18, ry: outerRadiusY * 1.12, start: 192, end: 346, width: "0.82", opacity: "0.44" },
        { rx: outerRadiusX * 1.26, ry: outerRadiusY * 1.2, start: 206, end: 332, width: "0.78", opacity: "0.32" },
        { rx: outerRadiusX * 0.72, ry: outerRadiusY * 0.72, start: 26, end: 156, width: "0.76", opacity: "0.28" },
      ].forEach((band) => {
        this.staticGroup.append(createSvgElement("path", {
          d: describeArc(cx, cy, band.rx, band.ry, band.start, band.end),
          "stroke-width": band.width,
          fill: "none",
          opacity: band.opacity,
        }));
      });

      [-62, -38, -18, 18, 38, 62].forEach((angle) => {
        const start = polarPoint(cx, cy, midRadiusX * 0.96, midRadiusY * 0.96, angle);
        const end = polarPoint(cx, cy, outerRadiusX * 1.06, outerRadiusY * 1.06, angle);
        this.staticGroup.append(createSvgElement("line", {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          "stroke-width": "0.8",
          opacity: angle === -18 || angle === 18 ? "0.82" : "0.54",
        }));
      });

      for (let index = 0; index < 16; index += 1) {
        const angle = 196 + (index * 10);
        const start = polarPoint(cx, cy, outerRadiusX * 1.03, outerRadiusY * 1.03, angle);
        const end = polarPoint(cx, cy, outerRadiusX * (index % 4 === 0 ? 1.13 : 1.08), outerRadiusY * (index % 4 === 0 ? 1.13 : 1.08), angle);
        this.staticGroup.append(createSvgElement("line", {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          "stroke-width": index % 4 === 0 ? "1.2" : "0.72",
          opacity: index % 4 === 0 ? "0.74" : "0.46",
        }));
      }

      [0.22, 0.33, 0.44, 0.55, 0.66, 0.77].forEach((ratio) => {
        const y = this.height * ratio;
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.08,
          y1: y,
          x2: this.width * 0.16,
          y2: y,
          "stroke-width": "0.7",
          opacity: "0.36",
        }));
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.84,
          y1: y,
          x2: this.width * 0.92,
          y2: y,
          "stroke-width": "0.7",
          opacity: "0.36",
        }));
      });

      [0.68, 0.74, 0.8, 0.86].forEach((ratio) => {
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.12,
          y1: this.height * ratio,
          x2: this.width * 0.88,
          y2: this.height * ratio,
          "stroke-width": "0.6",
          opacity: ratio === 0.8 ? "0.42" : "0.22",
        }));
      });

      [
        { text: "AZIMUTH 000", x: cx, y: cy - outerRadiusY - 28, anchor: "middle" },
        { text: "ELEV +045", x: this.width * 0.19, y: cy - outerRadiusY * 0.22, anchor: "start" },
        { text: "SIGNAL PLANE", x: this.width * 0.81, y: cy - outerRadiusY * 0.18, anchor: "end" },
        { text: "TRACK GRID", x: this.width * 0.17, y: cy + outerRadiusY * 0.88, anchor: "start" },
        { text: "LOCK WINDOW", x: this.width * 0.83, y: cy + outerRadiusY * 0.88, anchor: "end" },
      ].forEach((label) => {
        this.staticGroup.append(createSvgElement("text", {
          class: "observatory-screen-overlay__static-text",
          x: label.x,
          y: label.y,
          "text-anchor": label.anchor,
        }));
        this.staticGroup.lastChild.textContent = label.text;
      });
    }

    update(time, target, meta) {
      this.setFocus(meta ? meta.id : null, time);
      if (!target || !target.visible) {
        this.focusGroup.setAttribute("opacity", "0");
        return;
      }

      const progress = this.reducedMotion
        ? 1
        : clamp((time - this.focusChangedAt) / 760, 0, 1);
      const settleRadius = target.radius || 72;
      const radiusX = settleRadius * (1.08 + (1 - progress) * 0.32);
      const radiusY = settleRadius * (0.82 + (1 - progress) * 0.22);
      const rotation = this.reducedMotion ? 26 : (progress * 28) + ((time * 0.018) % 360);
      const counterRotation = this.reducedMotion ? -18 : (-progress * 36) - ((time * 0.022) % 360);
      const bracketOffset = settleRadius + (1 - progress) * 28;
      const bracketLength = 12 + progress * 18;
      const scanProgress = this.reducedMotion ? 0.88 : Math.min(1, progress * 1.45);
      const scanCenter = target.x - radiusX - 30 + ((radiusX * 2) + 60) * scanProgress;
      const annotationLabel = (meta.labelPrimary || meta.label || "").toUpperCase();
      const annotationMetaText = [
        meta.labelQualifier ? meta.labelQualifier.toUpperCase() : null,
        meta.provider.toUpperCase(),
        `RANK ${meta.rank}`,
        `Δ ${meta.trend}`,
      ].filter(Boolean).join(" · ");
      const annotationWidth = clamp(
        Math.max(206 + (annotationLabel.length * 5.8), 180 + (annotationMetaText.length * 3.2)),
        236,
        340,
      );
      const annotationX = Math.min(this.width - annotationWidth - 18, target.x + radiusX + 30);
      const annotationY = Math.max(52, target.y - radiusY - 54);

      this.focusGroup.setAttribute("opacity", "1");

      this.focusTrace.setAttribute("d", `M ${annotationX} ${annotationY + 44} C ${annotationX - 28} ${annotationY + 58}, ${target.x + 22} ${target.y + 16}, ${target.x} ${target.y}`);

      this.focusEcho.setAttribute("cx", target.x);
      this.focusEcho.setAttribute("cy", target.y);
      this.focusEcho.setAttribute("rx", radiusX * 1.16);
      this.focusEcho.setAttribute("ry", radiusY * 1.16);

      this.focusRing.setAttribute("cx", target.x);
      this.focusRing.setAttribute("cy", target.y);
      this.focusRing.setAttribute("rx", radiusX);
      this.focusRing.setAttribute("ry", radiusY);

      this.counterRingA.setAttribute("cx", target.x);
      this.counterRingA.setAttribute("cy", target.y);
      this.counterRingA.setAttribute("rx", radiusX * 0.84);
      this.counterRingA.setAttribute("ry", radiusY * 0.84);
      this.counterRingA.setAttribute("transform", `rotate(${rotation} ${target.x} ${target.y})`);

      this.counterRingB.setAttribute("cx", target.x);
      this.counterRingB.setAttribute("cy", target.y);
      this.counterRingB.setAttribute("rx", radiusX * 1.28);
      this.counterRingB.setAttribute("ry", radiusY * 1.28);
      this.counterRingB.setAttribute("transform", `rotate(${counterRotation} ${target.x} ${target.y})`);

      this.focusSweep.setAttribute(
        "d",
        describeArc(target.x, target.y, radiusX * 1.42, radiusY * 1.42, 18, 18 + (progress * 292)),
      );
      this.focusSweep.setAttribute("opacity", `${0.62 + (progress * 0.3)}`);

      this.bracketNorthWest.setAttribute("d", `M ${target.x - bracketOffset} ${target.y - bracketOffset * 0.84} h ${bracketLength} M ${target.x - bracketOffset} ${target.y - bracketOffset * 0.84} v ${bracketLength}`);
      this.bracketNorthEast.setAttribute("d", `M ${target.x + bracketOffset} ${target.y - bracketOffset * 0.84} h -${bracketLength} M ${target.x + bracketOffset} ${target.y - bracketOffset * 0.84} v ${bracketLength}`);
      this.bracketSouthWest.setAttribute("d", `M ${target.x - bracketOffset} ${target.y + bracketOffset * 0.84} h ${bracketLength} M ${target.x - bracketOffset} ${target.y + bracketOffset * 0.84} v -${bracketLength}`);
      this.bracketSouthEast.setAttribute("d", `M ${target.x + bracketOffset} ${target.y + bracketOffset * 0.84} h -${bracketLength} M ${target.x + bracketOffset} ${target.y + bracketOffset * 0.84} v -${bracketLength}`);

      this.scanLine.setAttribute("x1", scanCenter - 26);
      this.scanLine.setAttribute("y1", target.y);
      this.scanLine.setAttribute("x2", scanCenter + 26);
      this.scanLine.setAttribute("y2", target.y);
      this.scanLine.setAttribute("opacity", `${this.reducedMotion ? 0.6 : Math.max(0.16, 1 - Math.abs((scanProgress * 2) - 1))}`);

      this.annotationRect.setAttribute("width", annotationWidth);
      this.annotationRect.setAttribute("x", annotationX);
      this.annotationRect.setAttribute("y", annotationY);
      this.annotationText.setAttribute("x", annotationX + 16);
      this.annotationText.setAttribute("y", annotationY + 21);
      this.annotationText.textContent = annotationLabel;
      this.annotationMeta.setAttribute("x", annotationX + 16);
      this.annotationMeta.setAttribute("y", annotationY + 40);
      this.annotationMeta.textContent = annotationMetaText;
    }
  }

  class PremiumObservatoryField {
    constructor(target, THREE, addons) {
      this.target = target;
      this.THREE = THREE;
      this.addons = addons;
      this.nodes = [];
      this.nodeLookup = new Map();
      this.guides = [];
      this.trails = [];
      this.measurementRings = [];
      this.focusId = null;
      this.hoverId = null;
      this.pointer = { x: 0, y: 0 };
      this.pointerTarget = { x: 0, y: 0 };
      this.keyTarget = { x: 0, y: 0 };
      this.keyVelocity = { x: 0, y: 0 };
      this.zoomRange = { min: 7.2, max: 16.8 };
      this.zoomTarget = 16.4;
      this.zoomCurrent = 16.4;
      this.zoomVelocity = 0;
      this.lastInteractionAt = 0;
      this.isActive = false;
      this.payload = latestPayload;
      this.frame = null;
      this.resizeObserver = null;
      this.labelFrameSkip = 0;
      this.bloomImpulse = 0;
      this.bloomBase = 0.46;
      this.focusChangedAt = performance.now();
      this.modes = latestPayload.toggles || { history: true, compare: false, threshold: true };

      this.target.innerHTML = `
        <div class="observatory-field-shell observatory-field-shell--3d" tabindex="0" role="application" aria-label="Interactive observatory field">
          <div class="observatory-field-hud">Field idle · click or tab to activate · arrows scan</div>
          <div class="observatory-label-layer"></div>
        </div>
      `;

      this.shell = this.target.firstElementChild;
      this.hud = this.shell.querySelector(".observatory-field-hud");
      this.labelLayer = this.shell.querySelector(".observatory-label-layer");
      this.overlay = new ObservatoryScreenOverlay(this.shell, motionQuery.matches);

      /* Tooltip element */
      this.tooltip = createTooltipElement();
      this.shell.appendChild(this.tooltip);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x020408);
      this.scene.fog = new THREE.FogExp2(0x030609, 0.034);
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      this.camera.position.set(0, 1.2, 11.8);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.06;
      this.renderer.domElement.className = "observatory-field-canvas";
      this.shell.prepend(this.renderer.domElement);

      this.raycaster = new THREE.Raycaster();
      this.raycaster.params.Sprite = { threshold: 0.5 };
      this.mouse = new THREE.Vector2(-10, -10);
      this.focusPoint = new THREE.Vector3();
      this.focusTarget = new THREE.Vector3();

      this.rootGroup = new THREE.Group();
      this.scene.add(this.rootGroup);

      /* ── Bloom post-processing ── */
      this.composer = null;
      this.bloomPass = null;
      this.setupPostProcessing();

      this.buildBackdrop();
      this.buildGridPlane();
      this.buildDustParticles();
      this.bindEvents();
      this.resize();
      this.animate = this.animate.bind(this);
      this.setData(latestPayload);
      this.frame = window.requestAnimationFrame(this.animate);
    }

    setupPostProcessing() {
      const { THREE, addons } = this;
      if (!addons || !addons.EffectComposer) return;
      try {
        this.composer = new addons.EffectComposer(this.renderer);
        const renderPass = new addons.RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.bloomPass = new addons.UnrealBloomPass(
          new THREE.Vector2(this.target.clientWidth || 700, this.target.clientHeight || 460),
          0.68,  /* strength — slightly more luminous */
          0.52,  /* radius  — tighter, more precise spread */
          0.62   /* threshold — catches more of the node glow */
        );
        this.composer.addPass(this.bloomPass);
      } catch (e) {
        console.warn("Bloom post-processing unavailable:", e);
        this.composer = null;
      }
    }

    buildBackdrop() {
      const { THREE } = this;

      const ambient = new THREE.AmbientLight(0xc6ddff, 0.56);
      const rim = new THREE.PointLight(0x8ebfff, 2.8, 28, 2.2);
      rim.position.set(4.2, 5.1, 9.4);
      const fill = new THREE.PointLight(0x4f78c8, 1.9, 34, 2.1);
      fill.position.set(-6.4, -3.8, 7.4);
      const depthLight = new THREE.PointLight(0xd8ecff, 0.94, 22, 1.8);
      depthLight.position.set(0, 0.6, -7.5);
      const prism = new THREE.PointLight(0x7aa4ff, 0.88, 20, 1.9);
      prism.position.set(-2.8, 2.1, 5.6);
      const aqua = new THREE.PointLight(0xb5d6ff, 0.76, 18, 1.8);
      aqua.position.set(2.5, -1.4, 4.8);
      this.scene.add(ambient, rim, fill, depthLight, prism, aqua);
      this.ambientLight = ambient;
      this.ambientBaseIntensity = 0.58;

      [1.55, 2.35, 3.85, 5.35].forEach((radius, index) => {
        const points = [];
        for (let step = 0; step <= 96; step += 1) {
          const angle = (step / 96) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.22, Math.sin(angle * 0.5) * 0.5));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const ringMaterial = new THREE.LineDashedMaterial({
          color: index === 0 ? 0xd6ebff : 0x79abff,
          transparent: true,
          opacity: index === 0 ? 0.28 : 0.2 - ((index - 1) * 0.02),
          dashSize: index === 0 ? 0.12 : 0.28,
          gapSize: index === 0 ? 0.08 : 0.16,
          depthWrite: false,
        });
        const line = new THREE.LineLoop(geometry, ringMaterial);
        line.computeLineDistances();
        line.rotation.x = 1.02 + index * 0.09;
        line.rotation.z = index === 1 ? 0.36 : -0.18 * (index + 1);
        this.scene.add(line);
        this.measurementRings.push(line);
      });

      /* ── Star field with twinkling support ── */
      const starCount = 1600;
      const positions = new Float32Array(starCount * 3);
      const colors = new Float32Array(starCount * 3);
      const starPhases = new Float32Array(starCount); /* per-star phase for twinkling */
      const starSpeeds = new Float32Array(starCount);
      const baseSizes = new Float32Array(starCount);
      const anchorThreshold = starCount - 30; /* last 30 are bright anchor stars */

      for (let index = 0; index < starCount; index += 1) {
        const isAnchor = index >= anchorThreshold;
        const distance = (isAnchor ? 20 : 16) + Math.random() * (isAnchor ? 22 : 32);
        const angle = Math.random() * Math.PI * 2;
        const elevation = (Math.random() - 0.5) * (isAnchor ? 18 : 28);
        positions[index * 3] = Math.cos(angle) * distance;
        positions[index * 3 + 1] = elevation;
        positions[index * 3 + 2] = (Math.random() - 0.5) * 36;
        colors[index * 3] = 0.52 + Math.random() * 0.18;
        colors[index * 3 + 1] = 0.72 + Math.random() * 0.16;
        colors[index * 3 + 2] = 0.96;
        starPhases[index] = Math.random() * Math.PI * 2;
        starSpeeds[index] = isAnchor ? 0.15 + Math.random() * 0.35 : 0.3 + Math.random() * 1.2;
        baseSizes[index] = isAnchor ? 0.12 + Math.random() * 0.04 : 0.05 + Math.random() * 0.08;
      }
      const starGeometry = new THREE.BufferGeometry();
      starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      starGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      starGeometry.setAttribute("size", new THREE.BufferAttribute(baseSizes.slice(), 1));
      const starMaterial = new THREE.PointsMaterial({
        size: 0.08,
        transparent: true,
        opacity: 0.7,
        vertexColors: true,
        sizeAttenuation: true,
      });
      this.starField = new THREE.Points(starGeometry, starMaterial);
      this.starPhases = starPhases;
      this.starSpeeds = starSpeeds;
      this.starBaseSizes = baseSizes;
      this.scene.add(this.starField);

      /* ── Warp lines — flowing radial hyperdrive streaks ── */
      this.warpLineGroup = new THREE.Group();
      const warpLineCount = 72;
      this.warpLineMeta = [];
      for (let i = 0; i < warpLineCount; i += 1) {
        const angle = (i / warpLineCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.18;
        const innerR = 1.2 + Math.random() * 1.8;
        const outerR = 14 + Math.random() * 18;
        const elev = (Math.random() - 0.5) * 6;
        const thickness = 0.02 + Math.random() * 0.04;
        /* Multi-segment line for visible thickness — parallel pair */
        const pts1 = [];
        const pts2 = [];
        const segments = 8;
        for (let s = 0; s <= segments; s += 1) {
          const t = s / segments;
          const r = innerR + t * (outerR - innerR);
          const e = elev * 0.3 + t * elev * 0.7;
          const x = Math.cos(angle) * r;
          const z = Math.sin(angle) * r;
          pts1.push(new THREE.Vector3(x, e - thickness, z));
          pts2.push(new THREE.Vector3(x, e + thickness, z));
        }
        /* Pick color: mostly bright blue-white with warm accents */
        const colorPool = [0x88ccff, 0xaaddff, 0xeef6ff, 0xffeedd, 0x99ddff, 0xbbddff, 0xddeeff, 0xffd488];
        const lineColor = colorPool[i % colorPool.length];
        const mat1 = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const mat2 = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const line1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts1), mat1);
        const line2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts2), mat2);
        this.warpLineGroup.add(line1, line2);
        this.warpLineMeta.push({
          line1, line2, mat1, mat2,
          phase: Math.random() * Math.PI * 2,
          flickerSpeed: 2 + Math.random() * 6,
          baseOpacity: 0.3 + Math.random() * 0.4,
        });
      }
      this.scene.add(this.warpLineGroup);
    }

    /*
     * ── Ground-plane grid ──
     * Toggle: set USE_SHADER_GRID to false for instant rollback to GridHelper.
     * The shader path draws a radial-fade grid that dissolves at the edges;
     * the classic path uses THREE.GridHelper at uniform opacity.
     * Both are kept intact so the swap is a one-line change.
     */
    static USE_SHADER_GRID = true;

    buildGridPlane() {
      const { THREE } = this;
      if (this.constructor.USE_SHADER_GRID) {
        try {
          this._buildShaderGrid(THREE);
          return; /* shader succeeded — skip classic path */
        } catch (_) {
          /* shader compilation failed; fall through to classic */
        }
      }
      this._buildClassicGrid(THREE);
    }

    _buildShaderGrid(THREE) {
      const gridPlane = new THREE.PlaneGeometry(34, 34);
      const gridShaderMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color(0x1a3568) },
          uFade: { value: 15.0 },
          uTime: { value: 0.0 },
        },
        vertexShader: [
          "varying vec2 vUv;",
          "varying vec3 vWorldPos;",
          "void main() {",
          "  vUv = uv;",
          "  vec4 wp = modelMatrix * vec4(position, 1.0);",
          "  vWorldPos = wp.xyz;",
          "  gl_Position = projectionMatrix * viewMatrix * wp;",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uColor;",
          "uniform float uFade;",
          "uniform float uTime;",
          "varying vec2 vUv;",
          "varying vec3 vWorldPos;",
          "void main() {",
          "  vec2 grid = abs(fract(vWorldPos.xz - 0.5) - 0.5) / fwidth(vWorldPos.xz);",
          "  float line = min(grid.x, grid.y);",
          "  float gridAlpha = 1.0 - min(line, 1.0);",
          "  float dist = length(vWorldPos.xz);",
          "  float radialFade = 1.0 - smoothstep(2.0, uFade, dist);",
          "  float breath = 0.16 + 0.03 * sin(uTime * 0.35);",
          "  gl_FragColor = vec4(uColor, gridAlpha * breath * radialFade);",
          "}",
        ].join("\n"),
      });
      const gridMesh = new THREE.Mesh(gridPlane, gridShaderMaterial);
      gridMesh.rotation.x = -Math.PI / 2;
      gridMesh.position.y = -3.4;
      this.scene.add(gridMesh);
      this.gridMesh = gridMesh;
    }

    _buildClassicGrid(THREE) {
      const gridHelper = new THREE.GridHelper(24, 28, 0x1a3a6a, 0x0e1f3a);
      gridHelper.position.y = -4.2;
      gridHelper.material.transparent = true;
      gridHelper.material.opacity = 0.12;
      gridHelper.material.depthWrite = false;
      this.scene.add(gridHelper);
    }

    /* ── Ambient floating dust particles ── */
    buildDustParticles() {
      const { THREE } = this;
      const dustCount = 400;
      const dustPositions = new Float32Array(dustCount * 3);
      const dustPhases = new Float32Array(dustCount);
      const dustColors = new Float32Array(dustCount * 3);

      for (let i = 0; i < dustCount; i++) {
        dustPositions[i * 3] = (Math.random() - 0.5) * 20;
        dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 12;
        dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 20;
        dustPhases[i] = Math.random() * Math.PI * 2;
        /* Vary between cool blue (0x6da8ff) and pale cyan (0xa8d4ff) */
        var blend = Math.random();
        dustColors[i * 3] = 0.427 + blend * 0.231;
        dustColors[i * 3 + 1] = 0.659 + blend * 0.173;
        dustColors[i * 3 + 2] = 1.0;
      }

      const dustGeometry = new THREE.BufferGeometry();
      dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
      dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
      const dustMaterial = new THREE.PointsMaterial({
        size: 0.055,
        transparent: true,
        opacity: 0.34,
        vertexColors: true,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.dustField = new THREE.Points(dustGeometry, dustMaterial);
      this.dustPhases = dustPhases;
      this.dustPositionsRef = dustPositions;
      this.scene.add(this.dustField);

      /* ── Near-dust: larger foreground sensing motes ── */
      const nearCount = 120;
      const nearPositions = new Float32Array(nearCount * 3);
      const nearPhases = new Float32Array(nearCount);
      for (let i = 0; i < nearCount; i++) {
        nearPositions[i * 3] = (Math.random() - 0.5) * 12;
        nearPositions[i * 3 + 1] = (Math.random() - 0.5) * 8;
        nearPositions[i * 3 + 2] = (Math.random() - 0.5) * 12;
        nearPhases[i] = Math.random() * Math.PI * 2;
      }
      const nearGeometry = new THREE.BufferGeometry();
      nearGeometry.setAttribute("position", new THREE.BufferAttribute(nearPositions, 3));
      const nearMaterial = new THREE.PointsMaterial({
        size: 0.09,
        transparent: true,
        opacity: 0.12,
        color: 0x8fc4ff,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.nearDust = new THREE.Points(nearGeometry, nearMaterial);
      this.nearDustPhases = nearPhases;
      this.nearDustPositionsRef = nearPositions;
      this.scene.add(this.nearDust);
    }

    bindEvents() {
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerLeave = this.onPointerLeave.bind(this);
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onFocus = this.onFocus.bind(this);
      this.onBlur = this.onBlur.bind(this);
      this.onResize = this.resize.bind(this);

      this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
      this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
      this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
      this.shell.addEventListener("keydown", this.onKeyDown);
      this.shell.addEventListener("focus", this.onFocus);
      this.shell.addEventListener("blur", this.onBlur);
      window.addEventListener("resize", this.onResize);
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.target);
    }

    setActive(active) {
      this.isActive = active;
      this.shell.classList.toggle("is-active", active);
      this.target.classList.toggle("is-field-active", active);
      if (this.hud) {
        this.hud.textContent = active
          ? "Field active · arrows scan · click model to pin focus"
          : "Field idle · click or tab to activate · arrows scan";
      }
    }

    onFocus() {
      this.setActive(true);
    }

    onBlur() {
      this.setActive(false);
    }

    createGlowTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
      /* Layered halo: bright nucleus → ice band → blue falloff → silver whisper → transparent */
      gradient.addColorStop(0,    "rgba(255,255,255,1)");
      gradient.addColorStop(0.06, "rgba(232,250,255,0.97)");
      gradient.addColorStop(0.14, "rgba(200,238,255,0.88)");
      gradient.addColorStop(0.24, "rgba(156,222,255,0.72)");
      gradient.addColorStop(0.36, "rgba(110,185,255,0.48)");
      gradient.addColorStop(0.50, "rgba(76,145,245,0.28)");
      gradient.addColorStop(0.64, "rgba(55,105,210,0.14)");
      gradient.addColorStop(0.78, "rgba(52,72,180,0.06)");
      gradient.addColorStop(0.90, "rgba(58,48,148,0.02)");
      gradient.addColorStop(1,    "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 256, 256);
      return new this.THREE.CanvasTexture(canvas);
    }

    /* Tight bright inner texture for the nucleus sprite */
    createNucleusTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
      gradient.addColorStop(0,    "rgba(255,253,248,1)");
      gradient.addColorStop(0.10, "rgba(255,255,255,0.97)");
      gradient.addColorStop(0.22, "rgba(235,250,255,0.88)");
      gradient.addColorStop(0.38, "rgba(180,236,255,0.62)");
      gradient.addColorStop(0.56, "rgba(130,200,255,0.30)");
      gradient.addColorStop(0.78, "rgba(90,160,255,0.08)");
      gradient.addColorStop(1,    "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
      return new this.THREE.CanvasTexture(canvas);
    }

    createLobeTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(128, 128, 24, 128, 128, 128);
      gradient.addColorStop(0, "rgba(255,255,255,0.98)");
      gradient.addColorStop(0.14, "rgba(255,255,255,0.84)");
      gradient.addColorStop(0.34, "rgba(255,255,255,0.46)");
      gradient.addColorStop(0.62, "rgba(255,255,255,0.12)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 256, 256);
      return new this.THREE.CanvasTexture(canvas);
    }

    createGlintTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, 64, 64);
      /* Asymmetric lens-flare style glint: wider horizontally */
      ctx.save();
      ctx.translate(32, 32);
      ctx.scale(1.5, 1.0);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
      g.addColorStop(0, "rgba(255, 255, 255, 1.0)");
      g.addColorStop(0.15, "rgba(240, 250, 255, 0.9)");
      g.addColorStop(0.4, "rgba(200, 230, 255, 0.4)");
      g.addColorStop(0.7, "rgba(150, 200, 255, 0.1)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(-22, -22, 44, 44);
      ctx.restore();
      const texture = new this.THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    createLivingCoreTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 224;
      canvas.height = 224;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      function fillBlob(cx, cy, radius, stops, ellipseX = 1, ellipseY = 1, rotation = 0) {
        const gradient = context.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
        stops.forEach(function ([stop, color]) {
          gradient.addColorStop(stop, color);
        });
        context.save();
        context.translate(cx, cy);
        context.rotate(rotation);
        context.scale(ellipseX, ellipseY);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }

      function strokeStream(points, width, alpha, blur, colors) {
        const gradient = context.createLinearGradient(points[0][0], points[0][1], points[points.length - 1][0], points[points.length - 1][1]);
        colors.forEach(function ([stop, color]) {
          gradient.addColorStop(stop, color);
        });
        context.save();
        context.globalAlpha = alpha;
        context.filter = `blur(${blur}px)`;
        context.strokeStyle = gradient;
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = width;
        context.beginPath();
        context.moveTo(points[0][0], points[0][1]);
        for (let index = 1; index < points.length; index += 1) {
          const prev = points[index - 1];
          const point = points[index];
          const midX = (prev[0] + point[0]) / 2;
          const midY = (prev[1] + point[1]) / 2;
          context.quadraticCurveTo(prev[0], prev[1], midX, midY);
        }
        const last = points[points.length - 1];
        context.lineTo(last[0], last[1]);
        context.stroke();
        context.restore();
      }

      fillBlob(110, 108, 80, [
        [0, "rgba(214,236,255,0.16)"],
        [0.22, "rgba(162,204,245,0.22)"],
        [0.5, "rgba(92,140,206,0.16)"],
        [0.82, "rgba(36,60,118,0.08)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.08, 0.94, -0.22);
      fillBlob(104, 116, 68, [
        [0, "rgba(126,170,228,0.16)"],
        [0.28, "rgba(82,124,192,0.22)"],
        [0.62, "rgba(28,48,98,0.14)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.18, 0.84, -0.12);
      fillBlob(126, 92, 42, [
        [0, "rgba(255,255,255,0.42)"],
        [0.16, "rgba(233,246,255,0.52)"],
        [0.44, "rgba(176,216,255,0.26)"],
        [0.76, "rgba(102,142,214,0.05)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.22, 0.84, 0.44);
      fillBlob(88, 132, 36, [
        [0, "rgba(242,250,255,0.32)"],
        [0.2, "rgba(198,229,255,0.24)"],
        [0.56, "rgba(132,178,232,0.12)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.34, 0.72, -0.78);
      fillBlob(102, 98, 22, [
        [0, "rgba(255,255,255,0.4)"],
        [0.18, "rgba(236,247,255,0.28)"],
        [0.5, "rgba(176,214,250,0.12)"],
        [1, "rgba(0,0,0,0)"],
      ], 0.82, 1.18, 0.18);
      fillBlob(136, 126, 24, [
        [0, "rgba(255,255,255,0.22)"],
        [0.24, "rgba(214,236,255,0.18)"],
        [0.6, "rgba(140,188,244,0.1)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.46, 0.66, 0.58);

      context.globalCompositeOperation = "multiply";
      fillBlob(98, 116, 56, [
        [0, "rgba(9,18,34,0.82)"],
        [0.26, "rgba(12,24,46,0.44)"],
        [0.6, "rgba(10,18,34,0.14)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.16, 0.8, -0.44);
      fillBlob(132, 86, 32, [
        [0, "rgba(8,16,31,0.72)"],
        [0.3, "rgba(10,20,38,0.28)"],
        [0.7, "rgba(0,0,0,0.04)"],
        [1, "rgba(0,0,0,0)"],
      ], 0.92, 1.34, 0.24);
      fillBlob(146, 132, 28, [
        [0, "rgba(10,18,34,0.58)"],
        [0.28, "rgba(8,16,31,0.24)"],
        [0.74, "rgba(0,0,0,0)"],
        [1, "rgba(0,0,0,0)"],
      ], 1.38, 0.72, 0.68);
      strokeStream([[56, 122], [84, 114], [112, 120], [142, 108], [170, 92]], 12, 0.18, 7, [
        [0, "rgba(8,18,38,0)"],
        [0.24, "rgba(10,20,42,0.72)"],
        [0.62, "rgba(18,34,66,0.46)"],
        [1, "rgba(8,18,38,0)"],
      ]);

      context.globalCompositeOperation = "screen";
      strokeStream([[44, 102], [78, 86], [110, 94], [148, 120], [180, 126]], 14, 0.24, 8, [
        [0, "rgba(164,216,255,0)"],
        [0.18, "rgba(206,236,255,0.72)"],
        [0.56, "rgba(135,194,246,0.5)"],
        [1, "rgba(110,160,235,0)"],
      ]);
      strokeStream([[64, 156], [94, 132], [124, 126], [150, 92], [172, 64]], 10, 0.18, 10, [
        [0, "rgba(164,216,255,0)"],
        [0.24, "rgba(230,245,255,0.62)"],
        [0.58, "rgba(158,208,250,0.42)"],
        [1, "rgba(115,164,236,0)"],
      ]);
      strokeStream([[76, 54], [98, 82], [128, 96], [158, 142]], 9, 0.22, 8, [
        [0, "rgba(172,220,255,0)"],
        [0.22, "rgba(242,249,255,0.74)"],
        [0.52, "rgba(170,216,255,0.48)"],
        [1, "rgba(120,176,240,0)"],
      ]);
      context.globalCompositeOperation = "source-over";

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    createSiriCoreTexture() {
      /* ── Siri core palette — centralized for easy dial-back ── */
      const RIBBON_CYAN = "hsl(195, 85%, 70%)";
      const RIBBON_BLUE = "hsl(220, 80%, 65%)";
      const RIBBON_VIOLET = "hsl(260, 72%, 58%)";
      const RIBBON_ALPHA = 0.72;
      const BASE_DARK = "rgba(3, 6, 14, 1.0)";

      const canvas = document.createElement("canvas");
      canvas.width = 384;
      canvas.height = 384;
      const ctx = canvas.getContext("2d");
      const cx = 192;
      const cy = 192;

      /* Dark base fill */
      ctx.fillStyle = BASE_DARK;
      ctx.fillRect(0, 0, 384, 384);

      /* Circular mask */
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 182, 0, Math.PI * 2);
      ctx.clip();

      /* Subtle dark depth blobs (multiply) */
      ctx.globalCompositeOperation = "multiply";
      function darkBlob(x, y, r, alpha) {
        const g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
        g.addColorStop(0, `rgba(2, 4, 10, ${alpha})`);
        g.addColorStop(0.5, `rgba(4, 8, 18, ${alpha * 0.5})`);
        g.addColorStop(1, "rgba(3, 6, 14, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      darkBlob(160, 210, 80, 0.85);
      darkBlob(220, 150, 65, 0.75);

      /* Bright luminous ribbons (screen composite) */
      ctx.globalCompositeOperation = "screen";

      function ribbon(points, width, blur, alpha, colorStops) {
        const gradient = ctx.createLinearGradient(
          points[0][0], points[0][1],
          points[points.length - 1][0], points[points.length - 1][1],
        );
        colorStops.forEach(function (pair) { gradient.addColorStop(pair[0], pair[1]); });
        ctx.save();
        ctx.globalAlpha = alpha * RIBBON_ALPHA;
        ctx.filter = `blur(${blur}px)`;
        ctx.strokeStyle = gradient;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const pt = points[i];
          ctx.quadraticCurveTo(prev[0], prev[1], (prev[0] + pt[0]) / 2, (prev[1] + pt[1]) / 2);
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1]);
        ctx.stroke();
        ctx.restore();
      }

      /* Ribbon 1: cyan sweep */
      ribbon(
        [[40, 220], [100, 185], [165, 195], [230, 170], [310, 140], [355, 115]],
        20, 4, 0.88,
        [
          [0, "rgba(102, 204, 255, 0)"],
          [0.15, "rgba(102, 220, 255, 0.9)"],
          [0.5, "rgba(140, 235, 255, 1.0)"],
          [0.85, "rgba(80, 195, 255, 0.85)"],
          [1, "rgba(60, 170, 240, 0)"],
        ],
      );

      /* Ribbon 2: blue-violet sweep */
      ribbon(
        [[50, 140], [110, 170], [175, 160], [235, 200], [300, 230], [350, 260]],
        16, 3, 0.78,
        [
          [0, "rgba(100, 120, 255, 0)"],
          [0.18, "rgba(120, 140, 255, 0.85)"],
          [0.48, "rgba(160, 160, 255, 0.95)"],
          [0.82, "rgba(130, 110, 245, 0.8)"],
          [1, "rgba(100, 80, 220, 0)"],
        ],
      );

      /* Ribbon 3: violet-magenta accent */
      ribbon(
        [[80, 80], [130, 120], [185, 145], [240, 130], [290, 95]],
        13, 5, 0.65,
        [
          [0, "rgba(180, 120, 255, 0)"],
          [0.2, "rgba(190, 140, 255, 0.8)"],
          [0.55, "rgba(210, 160, 255, 0.9)"],
          [0.8, "rgba(170, 130, 240, 0.7)"],
          [1, "rgba(140, 100, 220, 0)"],
        ],
      );

      /* Soft central glow for depth */
      ctx.globalCompositeOperation = "screen";
      const centerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120);
      centerGlow.addColorStop(0, "rgba(180, 220, 255, 0.18)");
      centerGlow.addColorStop(0.3, "rgba(120, 180, 255, 0.08)");
      centerGlow.addColorStop(0.7, "rgba(60, 100, 200, 0.03)");
      centerGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = centerGlow;
      ctx.fillRect(0, 0, 384, 384);

      ctx.restore();
      ctx.globalCompositeOperation = "source-over";

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    createFocusedHighlightTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      context.globalCompositeOperation = "screen";
      context.translate(128, 128);

      const streaks = [
        { rotation: -0.72, width: 132, height: 28, alpha: 0.82 },
        { rotation: 0.34, width: 112, height: 22, alpha: 0.58 },
      ];
      streaks.forEach(function (streak) {
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, streak.width * 0.5);
        gradient.addColorStop(0, `rgba(255,255,255,${streak.alpha})`);
        gradient.addColorStop(0.32, `rgba(214,236,255,${streak.alpha * 0.74})`);
        gradient.addColorStop(0.62, "rgba(128,186,244,0.14)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        context.save();
        context.rotate(streak.rotation);
        context.scale(streak.width / streak.height, 1);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(0, 0, streak.height, 0, Math.PI * 2);
        context.fill();
        context.restore();
      });

      const bloom = context.createRadialGradient(0, 0, 0, 0, 0, 72);
      bloom.addColorStop(0, "rgba(255,255,255,0.38)");
      bloom.addColorStop(0.22, "rgba(212,236,255,0.28)");
      bloom.addColorStop(0.68, "rgba(110,166,236,0.08)");
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = bloom;
      context.beginPath();
      context.arc(0, 0, 72, 0, Math.PI * 2);
      context.fill();

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    createMetricBand(radius, colorHex, opacity) {
      const track = new this.THREE.Line(
        new this.THREE.BufferGeometry(),
        new this.THREE.LineBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: opacity,
          depthWrite: false,
        }),
      );
      const active = new this.THREE.Line(
        new this.THREE.BufferGeometry(),
        new this.THREE.LineBasicMaterial({
          color: colorHex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      this.setMetricArcGeometry(track, radius, FOCUS_RING_MAX_SWEEP);
      this.setMetricArcGeometry(active, radius, 6);
      return { radius, track, active, value: 0, reveal: 0 };
    }

    setMetricArcGeometry(line, radius, sweepAngle) {
      const segments = 52;
      const points = [];
      const limitedSweep = clamp(sweepAngle, 2, FOCUS_RING_MAX_SWEEP);
      for (let step = 0; step <= segments; step += 1) {
        const progress = step / segments;
        const angle = FOCUS_RING_START_ANGLE + (limitedSweep * progress);
        const radians = (angle - 90) * (Math.PI / 180);
        points.push(new this.THREE.Vector3(
          Math.cos(radians) * radius,
          Math.sin(radians) * radius,
          0,
        ));
      }
      line.geometry.dispose();
      line.geometry = new this.THREE.BufferGeometry().setFromPoints(points);
    }

    buildOrbPalette(node) {
      const { THREE } = this;
      const seed = hashString(`orb:${node.provider}:${node.id}`);
      const hueDrift = ((seed * 2) - 1) * 0.022;
      const tierBoost = node.tier === "flagship" ? 1 : node.tier === "secondary" ? 0.78 : 0.56;
      const familyShift = (Math.floor(seed * 4) - 1.5) * 0.012;
      const core = new THREE.Color().setHSL(0.61 + familyShift + hueDrift * 0.3, 0.84, node.tier === "flagship" ? 0.56 : node.tier === "secondary" ? 0.51 : 0.47);
      const emissive = new THREE.Color().setHSL(0.59 + familyShift + hueDrift * 0.3, 0.94, 0.58 + tierBoost * 0.04);
      const halo = new THREE.Color().setHSL(0.64 + familyShift + hueDrift * 0.26, 0.7, 0.54);
      const aura = new THREE.Color().setHSL(0.62 + familyShift + hueDrift * 0.22, 0.62, 0.5);
      const shell = new THREE.Color().setHSL(0.63 + familyShift + hueDrift * 0.24, 0.62, 0.54);
      const ring = new THREE.Color().setHSL(0.58 + familyShift + hueDrift * 0.2, 0.86, 0.68);
      const nucleus = new THREE.Color().setHSL(0.6 + familyShift + hueDrift * 0.18, 0.18, 0.78);
      const metalDark = new THREE.Color().setHSL(0.61 + familyShift * 0.3, 0.1, 0.18);
      const metalMid = new THREE.Color().setHSL(0.59 + familyShift * 0.3, 0.08, 0.3);
      const metalLight = new THREE.Color().setHSL(0.58 + familyShift * 0.2, 0.12, 0.62);
      const tick = new THREE.Color().setHSL(0.57 + familyShift * 0.1, 0.72, 0.84);
      const tickSoft = new THREE.Color().setHSL(0.58 + familyShift * 0.12, 0.48, 0.68);
      const focusCoreDark = new THREE.Color().setHSL(0.61 + familyShift * 0.18, 0.62, 0.08);
      const focusCoreMid = new THREE.Color().setHSL(0.59 + familyShift * 0.18, 0.44, 0.15);
      const focusCoreGlow = new THREE.Color().setHSL(0.57 + familyShift * 0.14, 0.86, 0.78);
      return {
        core,
        emissive,
        halo,
        aura,
        shell,
        ring,
        nucleus,
        metalDark,
        metalMid,
        metalLight,
        tick,
        tickSoft,
        focusCoreDark,
        focusCoreMid,
        focusCoreGlow,
        lobes: [
          new THREE.Color().setHSL(0.56 + familyShift + hueDrift * 0.12, 0.9, 0.63),
          new THREE.Color().setHSL(0.61 + familyShift + hueDrift * 0.14, 0.82, 0.65),
          new THREE.Color().setHSL(0.66 + familyShift + hueDrift * 0.14, 0.74, 0.66),
          new THREE.Color().setHSL(0.63 + familyShift + hueDrift * 0.1, 0.58, 0.72),
        ],
      };
    }

    createFocusedContour(radius, config, material) {
      const { THREE } = this;
      const points = [];
      const segments = 88;
      for (let step = 0; step < segments; step += 1) {
        const progress = step / segments;
        const angle = progress * Math.PI * 2;
        const radialScale = 1 + Math.sin((angle * config.primaryFreq) + config.phase) * config.radialAmplitude
          + Math.cos((angle * config.secondaryFreq) - config.phase * 0.8) * config.secondaryAmplitude;
        const x = Math.cos(angle) * radius * config.aspectX * radialScale;
        const y = Math.sin(angle) * radius * config.aspectY * (1 + Math.cos((angle * 2.0) + config.phase) * (config.radialAmplitude * 0.35));
        const z = Math.sin((angle * config.depthFreq) + config.phase) * radius * config.depthAmplitude;
        points.push(new THREE.Vector3(x, y, z));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      return new THREE.LineLoop(geometry, material);
    }

    createFocusedTickRing(radius, minorCount, majorEvery, minorLength, majorLength, minorMaterial, majorMaterial) {
      const { THREE } = this;
      const minorPositions = [];
      const majorPositions = [];

      for (let index = 0; index < minorCount; index += 1) {
        const angle = (index / minorCount) * Math.PI * 2;
        const isMajor = index % majorEvery === 0;
        const outerRadius = radius;
        const innerRadius = radius - (isMajor ? majorLength : minorLength);
        const target = isMajor ? majorPositions : minorPositions;
        target.push(
          Math.cos(angle) * innerRadius, Math.sin(angle) * innerRadius, 0,
          Math.cos(angle) * outerRadius, Math.sin(angle) * outerRadius, 0,
        );
      }

      const minor = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(minorPositions, 3)),
        minorMaterial,
      );
      const major = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(majorPositions, 3)),
        majorMaterial,
      );
      return { minor, major };
    }

    buildFocusedCore(node, palette) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.z = node.size * 0.08;
      group.visible = false;

      const sphereRadius = node.size * 1.72;
      const bezelRadius = sphereRadius * 1.26;
      const tickRadius = bezelRadius * 1.08;

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius, 40, 40),
        new THREE.MeshPhysicalMaterial({
          color: palette.focusCoreDark,
          emissive: palette.focusCoreMid,
          emissiveIntensity: 0.14,
          roughness: 0.72,
          metalness: 0.12,
          clearcoat: 0.28,
          clearcoatRoughness: 0.46,
          transparent: true,
          opacity: 0,
        }),
      );
      group.add(sphere);

      const innerShell = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius * 0.94, 34, 34),
        new THREE.MeshBasicMaterial({
          color: palette.focusCoreMid,
          transparent: true,
          opacity: 0,
          side: THREE.BackSide,
          depthWrite: false,
        }),
      );
      group.add(innerShell);

      const sphereRim = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius * 1.028, 36, 36),
        new THREE.MeshBasicMaterial({
          color: palette.tickSoft,
          transparent: true,
          opacity: 0,
          side: THREE.BackSide,
          depthWrite: false,
        }),
      );
      group.add(sphereRim);

      const bezel = new THREE.Mesh(
        new THREE.TorusGeometry(bezelRadius, node.size * 0.092, 16, 144),
        new THREE.MeshStandardMaterial({
          color: palette.metalDark,
          emissive: palette.metalMid,
          emissiveIntensity: 0.16,
          roughness: 0.34,
          metalness: 0.84,
          transparent: true,
          opacity: 0,
        }),
      );
      bezel.rotation.x = 0.12;
      group.add(bezel);

      const bezelEdge = new THREE.Mesh(
        new THREE.TorusGeometry(bezelRadius * 1.012, node.size * 0.032, 12, 144),
        new THREE.MeshBasicMaterial({
          color: palette.metalLight,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      bezelEdge.rotation.x = bezel.rotation.x;
      group.add(bezelEdge);

      const tickMinorMaterial = new THREE.LineBasicMaterial({
        color: palette.tickSoft,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const tickMajorMaterial = new THREE.LineBasicMaterial({
        color: palette.tick,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const ticks = this.createFocusedTickRing(
        tickRadius,
        120,
        10,
        node.size * 0.10,
        node.size * 0.20,
        tickMinorMaterial,
        tickMajorMaterial,
      );
      ticks.minor.rotation.x = bezel.rotation.x;
      ticks.major.rotation.x = bezel.rotation.x;
      group.add(ticks.minor, ticks.major);

      const tickGlowRing = new THREE.Mesh(
        new THREE.TorusGeometry(tickRadius * 0.986, node.size * 0.032, 18, 160),
        new THREE.MeshBasicMaterial({
          color: palette.tick,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      tickGlowRing.rotation.x = bezel.rotation.x;
      group.add(tickGlowRing);

      const tickDiffuseRing = new THREE.Mesh(
        new THREE.TorusGeometry(tickRadius * 0.986, node.size * 0.06, 22, 160),
        new THREE.MeshBasicMaterial({
          color: palette.tickSoft,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      tickDiffuseRing.rotation.x = bezel.rotation.x;
      group.add(tickDiffuseRing);

      const chapterRing = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(Array.from({ length: 72 }, function (_, index) {
          const angle = (index / 72) * Math.PI * 2;
          return new THREE.Vector3(
            Math.cos(angle) * (tickRadius * 0.94),
            Math.sin(angle) * (tickRadius * 0.94),
            0,
          );
        })),
        new THREE.LineBasicMaterial({
          color: palette.metalLight,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      chapterRing.rotation.x = bezel.rotation.x;
      group.add(chapterRing);

      /* ── JARVIS inner concentric rings — depth layers inside the disc ── */
      const innerRingConfigs = [
        { radiusFactor: 0.72, opacity: 0.14 },
        { radiusFactor: 0.56, opacity: 0.10 },
        { radiusFactor: 0.38, opacity: 0.08 },
      ];
      const innerRings = innerRingConfigs.map((config) => {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(sphereRadius * config.radiusFactor, node.size * 0.012, 6, 64),
          new THREE.MeshBasicMaterial({
            color: palette.tickSoft,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        ring.rotation.x = bezel.rotation.x;
        group.add(ring);
        return { ring, baseOpacity: config.opacity };
      });

      /* ── JARVIS outer decorative rings — layered precision architecture ── */
      /* Outer ring 1: segmented (gaps every 30 degrees) — group of 12 arcs */
      const outerRing1Group = new THREE.Group();
      const outerRing1Mat = new THREE.LineBasicMaterial({ color: palette.tickSoft, transparent: true, opacity: 0, depthWrite: false });
      for (let seg = 0; seg < 12; seg += 1) {
        const segStart = (seg / 12) * Math.PI * 2 + 0.02;
        const segEnd = ((seg + 0.7) / 12) * Math.PI * 2;
        const arcPts = [];
        for (let j = 0; j <= 16; j += 1) {
          const a = segStart + (j / 16) * (segEnd - segStart);
          arcPts.push(new THREE.Vector3(Math.cos(a) * bezelRadius * 1.36, Math.sin(a) * bezelRadius * 1.36, 0));
        }
        const arcLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), outerRing1Mat);
        outerRing1Group.add(arcLine);
      }
      outerRing1Group.rotation.x = bezel.rotation.x;
      group.add(outerRing1Group);

      /* Outer ring 2: thin continuous torus */
      const outerRing2 = new THREE.Mesh(
        new THREE.TorusGeometry(bezelRadius * 1.52, node.size * 0.008, 6, 96),
        new THREE.MeshBasicMaterial({ color: palette.metalLight, transparent: true, opacity: 0, depthWrite: false }),
      );
      outerRing2.rotation.x = bezel.rotation.x;
      group.add(outerRing2);

      /* Outer ring 3: broken arcs (4 segments of 60 degrees) — group of 4 arcs */
      const outerRing3Group = new THREE.Group();
      const outerRing3Mat = new THREE.LineBasicMaterial({ color: palette.tick, transparent: true, opacity: 0, depthWrite: false });
      for (let seg = 0; seg < 4; seg += 1) {
        const segStart = (seg / 4) * Math.PI * 2 + 0.15;
        const segEnd = segStart + Math.PI / 3;
        const arcPts = [];
        for (let j = 0; j <= 24; j += 1) {
          const a = segStart + (j / 24) * (segEnd - segStart);
          arcPts.push(new THREE.Vector3(Math.cos(a) * bezelRadius * 1.68, Math.sin(a) * bezelRadius * 1.68, 0));
        }
        const arcLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), outerRing3Mat);
        outerRing3Group.add(arcLine);
      }
      outerRing3Group.rotation.x = bezel.rotation.x;
      group.add(outerRing3Group);

      const outerRings = [
        { ring: outerRing1Group, material: outerRing1Mat, baseOpacity: 0.10, speed: -0.008, isGroup: true },
        { ring: outerRing2, material: outerRing2.material, baseOpacity: 0.06, speed: 0.006, isGroup: false },
        { ring: outerRing3Group, material: outerRing3Mat, baseOpacity: 0.08, speed: -0.01, isGroup: true },
      ];

      /* ── JARVIS clock-position markers — small circles at 6 positions ── */
      const clockMarkers = [];
      for (let ci = 0; ci < 6; ci += 1) {
        const clockAngle = (ci / 6) * Math.PI * 2;
        const cx = Math.cos(clockAngle) * bezelRadius * 0.94;
        const cy = Math.sin(clockAngle) * bezelRadius * 0.94;
        const markerPoints = [];
        for (let j = 0; j <= 24; j += 1) {
          const a = (j / 24) * Math.PI * 2;
          markerPoints.push(new THREE.Vector3(
            cx + Math.cos(a) * node.size * 0.06,
            cy + Math.sin(a) * node.size * 0.06,
            0,
          ));
        }
        const marker = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(markerPoints),
          new THREE.LineBasicMaterial({ color: palette.tick, transparent: true, opacity: 0, depthWrite: false }),
        );
        marker.rotation.x = bezel.rotation.x;
        group.add(marker);
        clockMarkers.push({ line: marker, baseOpacity: 0.16 });
      }

      /* ── JARVIS parallelogram tick layer — leaning 45deg right ── */
      const parallelogramTicks = [];
      for (let pi = 0; pi < 24; pi += 1) {
        const pAngle = (pi / 24) * Math.PI * 2;
        const pr = bezelRadius * 0.82;
        const pcx = Math.cos(pAngle) * pr;
        const pcy = Math.sin(pAngle) * pr;
        const pw = node.size * 0.05;
        const ph = node.size * 0.03;
        const lean = 0.015; /* 45deg lean offset */
        const pPoints = [
          new THREE.Vector3(pcx - pw / 2 + lean, pcy - ph / 2, 0),
          new THREE.Vector3(pcx + pw / 2 + lean, pcy - ph / 2, 0),
          new THREE.Vector3(pcx + pw / 2 - lean, pcy + ph / 2, 0),
          new THREE.Vector3(pcx - pw / 2 - lean, pcy + ph / 2, 0),
        ];
        const pLine = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(pPoints),
          new THREE.LineBasicMaterial({ color: palette.tick, transparent: true, opacity: 0, depthWrite: false }),
        );
        pLine.rotation.x = bezel.rotation.x;
        group.add(pLine);
        parallelogramTicks.push({ line: pLine, baseOpacity: 0.12 });
      }

      /* ── JARVIS iris / shutter blades — glowing camera-aperture segments ── */
      const irisBladeCount = 8;
      const irisBlades = [];
      const irisInnerR = bezelRadius * 0.68;
      const irisOuterR = bezelRadius * 1.12;
      const bladeSweep = (Math.PI * 2 / irisBladeCount) * 0.72;
      for (let bi = 0; bi < irisBladeCount; bi += 1) {
        const bladeAngle = (bi / irisBladeCount) * Math.PI * 2;
        const bladePoints = [];
        /* Trapezoid blade shape — inner arc to outer arc */
        const steps = 12;
        for (let s = 0; s <= steps; s += 1) {
          const a = bladeAngle + (s / steps) * bladeSweep;
          bladePoints.push(new THREE.Vector3(Math.cos(a) * irisInnerR, Math.sin(a) * irisInnerR, 0));
        }
        for (let s = steps; s >= 0; s -= 1) {
          const a = bladeAngle + 0.04 + (s / steps) * (bladeSweep - 0.08);
          bladePoints.push(new THREE.Vector3(Math.cos(a) * irisOuterR, Math.sin(a) * irisOuterR, 0));
        }
        bladePoints.push(bladePoints[0].clone());
        const bladeLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(bladePoints),
          new THREE.LineBasicMaterial({
            color: palette.tick,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        bladeLine.rotation.x = bezel.rotation.x;
        group.add(bladeLine);
        irisBlades.push({ line: bladeLine, baseOpacity: 0.22 });
      }

      /* ── JARVIS iris glow ring — bright ring at iris inner edge ── */
      const irisGlowRing = new THREE.Mesh(
        new THREE.TorusGeometry(irisInnerR, node.size * 0.024, 8, 96),
        new THREE.MeshBasicMaterial({
          color: palette.tick,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      irisGlowRing.rotation.x = bezel.rotation.x;
      group.add(irisGlowRing);

      /* ── JARVIS iris outer glow ring ── */
      const irisOuterGlowRing = new THREE.Mesh(
        new THREE.TorusGeometry(irisOuterR, node.size * 0.018, 8, 96),
        new THREE.MeshBasicMaterial({
          color: palette.tickSoft,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      irisOuterGlowRing.rotation.x = bezel.rotation.x;
      group.add(irisOuterGlowRing);

      const membraneTexture = this.siriCoreTexture || (this.siriCoreTexture = this.createSiriCoreTexture());
      /* ── Siri membrane tints — centralized for easy dial-back ── */
      const MEMBRANE_TINTS = [
        new THREE.Color().setHSL(195 / 360, 0.85, 0.70),
        new THREE.Color().setHSL(240 / 360, 0.78, 0.62),
        new THREE.Color().setHSL(280 / 360, 0.65, 0.55),
        new THREE.Color().setHSL(185 / 360, 0.80, 0.65),
        palette.focusCoreMid.clone().lerp(new THREE.Color(0x02060c), 0.15),
      ];
      const membraneConfigs = [
        { scaleX: 1.72, scaleY: 1.30, offsetX: -0.05, offsetY: 0.03, rotation: -0.18, opacity: 0.60, speed: 0.22, driftX: 0.06, driftY: 0.05, scaleAmpX: 0.10, scaleAmpY: 0.08, blending: THREE.AdditiveBlending, color: MEMBRANE_TINTS[0] },
        { scaleX: 1.46, scaleY: 1.62, offsetX: 0.07, offsetY: -0.04, rotation: 0.62, opacity: 0.46, speed: 0.17, driftX: 0.05, driftY: 0.06, scaleAmpX: 0.08, scaleAmpY: 0.10, blending: THREE.AdditiveBlending, color: MEMBRANE_TINTS[1] },
        { scaleX: 1.44, scaleY: 1.12, offsetX: -0.02, offsetY: 0.05, rotation: -0.44, opacity: 0.38, speed: 0.13, driftX: 0.04, driftY: 0.04, scaleAmpX: 0.07, scaleAmpY: 0.06, blending: THREE.AdditiveBlending, color: MEMBRANE_TINTS[2] },
        { scaleX: 1.18, scaleY: 1.34, offsetX: 0.04, offsetY: -0.02, rotation: 0.28, opacity: 0.26, speed: 0.10, driftX: 0.03, driftY: 0.05, scaleAmpX: 0.06, scaleAmpY: 0.08, blending: THREE.AdditiveBlending, color: MEMBRANE_TINTS[3] },
        { scaleX: 1.06, scaleY: 1.04, offsetX: 0.01, offsetY: 0.01, rotation: -0.52, opacity: 0.20, speed: 0.08, driftX: 0.02, driftY: 0.02, scaleAmpX: 0.04, scaleAmpY: 0.04, blending: THREE.NormalBlending, color: MEMBRANE_TINTS[4] },
      ];
      const membranes = membraneConfigs.map((config, index) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: membraneTexture,
            color: config.color,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: config.blending,
          }),
        );
        sprite.scale.set(sphereRadius * config.scaleX, sphereRadius * config.scaleY, 1);
        sprite.position.set(sphereRadius * config.offsetX, sphereRadius * config.offsetY, sphereRadius * 0.08);
        sprite.material.rotation = config.rotation;
        group.add(sprite);
        return {
          sprite,
          baseOpacity: config.opacity,
          baseScaleX: sphereRadius * config.scaleX,
          baseScaleY: sphereRadius * config.scaleY,
          baseOffsetX: sphereRadius * config.offsetX,
          baseOffsetY: sphereRadius * config.offsetY,
          baseRotation: config.rotation,
          speed: config.speed,
          driftX: config.driftX,
          driftY: config.driftY,
          scaleAmpX: config.scaleAmpX,
          scaleAmpY: config.scaleAmpY,
          phase: node.orbitPhase + index * 0.92,
        };
      });

      const contourConfigs = [
        { aspectX: 0.98, aspectY: 0.74, primaryFreq: 2.8, secondaryFreq: 4.2, radialAmplitude: 0.06, secondaryAmplitude: 0.03, depthFreq: 2.0, depthAmplitude: 0.2, phase: node.orbitPhase + 0.34, rotationX: 0.98, rotationY: 0.18, rotationZ: -0.22, opacity: 0.78, speed: 0.12, wobbleSpeed: 0.52, scaleAmplitude: 0.035, emissiveBias: 0.18 },
        { aspectX: 0.88, aspectY: 0.58, primaryFreq: 3.2, secondaryFreq: 5.1, radialAmplitude: 0.08, secondaryAmplitude: 0.04, depthFreq: 1.6, depthAmplitude: 0.24, phase: node.orbitPhase + 1.18, rotationX: 0.46, rotationY: 0.82, rotationZ: 0.24, opacity: 0.62, speed: -0.09, wobbleSpeed: 0.44, scaleAmplitude: 0.03, emissiveBias: 0.08 },
        { aspectX: 0.78, aspectY: 0.66, primaryFreq: 2.1, secondaryFreq: 4.6, radialAmplitude: 0.05, secondaryAmplitude: 0.028, depthFreq: 2.8, depthAmplitude: 0.16, phase: node.orbitPhase + 2.12, rotationX: 1.32, rotationY: 0.24, rotationZ: -0.58, opacity: 0.48, speed: 0.07, wobbleSpeed: 0.36, scaleAmplitude: 0.024, emissiveBias: -0.04 },
      ];
      const contourBands = contourConfigs.map((config) => {
        const line = this.createFocusedContour(
          sphereRadius * 0.74,
          config,
          new THREE.LineBasicMaterial({
            color: palette.focusCoreGlow.clone().lerp(palette.tickSoft, Math.max(0, config.emissiveBias)),
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        line.rotation.set(config.rotationX, config.rotationY, config.rotationZ);
        group.add(line);
        return {
          line,
          baseOpacity: config.opacity,
          baseRotationX: config.rotationX,
          baseRotationY: config.rotationY,
          baseRotationZ: config.rotationZ,
          speed: config.speed,
          wobbleSpeed: config.wobbleSpeed,
          scaleAmplitude: config.scaleAmplitude,
          phase: config.phase,
        };
      });

      const highlightTexture = this.focusHighlightTexture || (this.focusHighlightTexture = this.createFocusedHighlightTexture());
      const highlightConfigs = [
        { scaleX: 2.02, scaleY: 1.08, offsetX: -0.08, offsetY: 0.04, rotation: -0.42, opacity: 0.60, speed: 0.1 },
        { scaleX: 1.58, scaleY: 0.9, offsetX: 0.1, offsetY: -0.08, rotation: 0.58, opacity: 0.46, speed: -0.08 },
      ];
      const highlights = highlightConfigs.map((config, index) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: highlightTexture,
            color: index === 0 ? palette.focusCoreGlow : palette.tick,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.scale.set(sphereRadius * config.scaleX, sphereRadius * config.scaleY, 1);
        sprite.position.set(sphereRadius * config.offsetX, sphereRadius * config.offsetY, sphereRadius * 0.12);
        sprite.material.rotation = config.rotation;
        group.add(sprite);
        return {
          sprite,
          baseOpacity: config.opacity,
          baseScaleX: sphereRadius * config.scaleX,
          baseScaleY: sphereRadius * config.scaleY,
          baseX: sphereRadius * config.offsetX,
          baseY: sphereRadius * config.offsetY,
          baseRotation: config.rotation,
          speed: config.speed,
          phase: node.orbitPhase + index * 0.8,
        };
      });

      /* ── Wireframe sphere cage — geodesic structural base ── */
      const wireframeSphereGeo = new THREE.IcosahedronGeometry(sphereRadius * 0.96, 2);
      const wireframeEdges = new THREE.EdgesGeometry(wireframeSphereGeo, 1);
      const wireframeMaterial = new THREE.LineBasicMaterial({
        color: palette.tickSoft,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const wireframeSphere = new THREE.LineSegments(wireframeEdges, wireframeMaterial);
      wireframeSphere.rotation.set(0.32, 0.18, -0.12);
      group.add(wireframeSphere);

      /* ── Accent latitude rings — reinforce spherical read ── */
      const cageConfigs = [
        { radius: sphereRadius * 0.82, rotationX: 1.34, rotationY: 0.0, rotationZ: 0.0, opacity: 0.10, speed: 0.04 },
        { radius: sphereRadius * 0.62, rotationX: 0.52, rotationY: 0.86, rotationZ: 0.24, opacity: 0.07, speed: -0.03 },
      ];
      const cageLines = cageConfigs.map((config) => {
        const points = [];
        for (let index = 0; index < 72; index += 1) {
          const angle = (index / 72) * Math.PI * 2;
          points.push(new THREE.Vector3(
            Math.cos(angle) * config.radius,
            Math.sin(angle) * config.radius,
            0,
          ));
        }
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: palette.tickSoft,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        line.rotation.set(config.rotationX, config.rotationY, config.rotationZ);
        group.add(line);
        return {
          line,
          baseOpacity: config.opacity,
          baseRotationX: config.rotationX,
          baseRotationY: config.rotationY,
          baseRotationZ: config.rotationZ,
          speed: config.speed,
        };
      });

      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture || (this.glowTexture = this.createGlowTexture()),
          color: palette.tickSoft,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      glow.scale.setScalar(sphereRadius * 2.6);
      group.add(glow);

      /* ── Focused bezel glint — premium specular highlight ── */
      const bezelGlint = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glintTexture || (this.glintTexture = this.createGlintTexture()),
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      bezelGlint.scale.setScalar(sphereRadius * 0.22);
      group.add(bezelGlint);
      const bezelGlintState = {
        nextGlintAt: performance.now() + 2000 + Math.random() * 4000,
        progress: 0,
        angle: Math.random() * Math.PI * 2,
        active: false,
        bezelRadius: bezelRadius,
      };

      /* ── Siri-orb internal ribbons — bold luminous planes filling ~70% of sphere ── */
      const siriColors = [0x5ef0ff, 0xc488ff, 0xff6eb4, 0x74eea0, 0x88bbff, 0xff99cc];
      const siriRibbonConfigs = [
        { scaleW: 1.52, scaleH: 1.24, rotX: 0.8, rotY: 0.3, rotZ: -0.2, opacity: 0.34, speed: 0.22 },
        { scaleW: 1.38, scaleH: 1.44, rotX: -0.4, rotY: 1.1, rotZ: 0.4, opacity: 0.30, speed: -0.18 },
        { scaleW: 1.46, scaleH: 1.12, rotX: 1.2, rotY: -0.5, rotZ: 0.7, opacity: 0.28, speed: 0.15 },
        { scaleW: 1.28, scaleH: 1.36, rotX: -0.9, rotY: 0.6, rotZ: -0.8, opacity: 0.24, speed: -0.12 },
        { scaleW: 1.18, scaleH: 1.52, rotX: 0.3, rotY: -0.9, rotZ: 1.1, opacity: 0.22, speed: 0.25 },
        { scaleW: 1.34, scaleH: 0.98, rotX: 1.6, rotY: 0.2, rotZ: -0.5, opacity: 0.20, speed: -0.16 },
      ];
      const siriRibbons = siriRibbonConfigs.map((config, index) => {
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(sphereRadius * config.scaleW, sphereRadius * config.scaleH),
          new THREE.MeshBasicMaterial({
            color: siriColors[index],
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        );
        mesh.rotation.set(config.rotX, config.rotY, config.rotZ);
        group.add(mesh);
        return {
          mesh,
          baseOpacity: config.opacity,
          speed: config.speed,
        };
      });

      /* ── Siri inner glow sphere — soft luminous body mass ── */
      const siriGlowSphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius * 0.72, 24, 24),
        new THREE.MeshBasicMaterial({
          color: 0x4488cc,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(siriGlowSphere);

      /* ── Siri central energy crossing — bright core point ── */
      const siriCenter = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * 0.24, 16, 16),
        new THREE.MeshBasicMaterial({
          color: 0xeaf8ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(siriCenter);

      /* ── Siri shell rim highlight — thin luminous edge ── */
      const siriRim = new THREE.Mesh(
        new THREE.TorusGeometry(sphereRadius * 1.0, sphereRadius * 0.028, 8, 96),
        new THREE.MeshBasicMaterial({
          color: palette.ring,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      siriRim.rotation.set(0.72, 0.28, 0.14);
      group.add(siriRim);

      /* ── Second Siri rim — 3D rim-light at different tilt ── */
      const siriRim2 = new THREE.Mesh(
        new THREE.TorusGeometry(sphereRadius * 1.01, sphereRadius * 0.022, 8, 96),
        new THREE.MeshBasicMaterial({
          color: palette.halo,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      siriRim2.rotation.set(1.42, -0.38, 0.52);
      group.add(siriRim2);

      /* ── Third Siri rim — equatorial highlight ── */
      const siriRim3 = new THREE.Mesh(
        new THREE.TorusGeometry(sphereRadius * 0.98, sphereRadius * 0.016, 8, 96),
        new THREE.MeshBasicMaterial({
          color: 0x5ef0ff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      siriRim3.rotation.set(0.18, 1.12, -0.32);
      group.add(siriRim3);

      /* ── JARVIS-inspired chassis arcs — segmented precision decoration ── */
      const chassisArcConfigs = [
        { radius: bezelRadius * 1.14, startAngle: 0.4, sweepAngle: 1.8, segments: 48, opacity: 0.18, speed: -0.02, color: palette.tickSoft },
        { radius: bezelRadius * 1.22, startAngle: 2.8, sweepAngle: 1.2, segments: 32, opacity: 0.14, speed: 0.015, color: palette.metalLight },
        { radius: bezelRadius * 0.88, startAngle: 4.2, sweepAngle: 1.5, segments: 40, opacity: 0.16, speed: -0.025, color: palette.tick },
        { radius: bezelRadius * 0.98, startAngle: 1.0, sweepAngle: 1.4, segments: 36, opacity: 0.14, speed: 0.018, color: palette.tick },
        { radius: bezelRadius * 1.32, startAngle: 3.6, sweepAngle: 1.0, segments: 28, opacity: 0.11, speed: -0.012, color: palette.tickSoft },
        { radius: bezelRadius * 1.06, startAngle: 5.2, sweepAngle: 0.8, segments: 24, opacity: 0.13, speed: 0.022, color: palette.metalLight },
      ];
      const chassisArcs = chassisArcConfigs.map((config) => {
        const points = [];
        for (let i = 0; i <= config.segments; i += 1) {
          const angle = config.startAngle + (i / config.segments) * config.sweepAngle;
          points.push(new THREE.Vector3(
            Math.cos(angle) * config.radius,
            Math.sin(angle) * config.radius,
            0,
          ));
        }
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: config.color,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        line.rotation.x = bezel.rotation.x;
        group.add(line);
        return {
          line,
          baseOpacity: config.opacity,
          speed: config.speed,
        };
      });

      return {
        group,
        sphere,
        innerShell,
        sphereRim,
        bezel,
        bezelEdge,
        chapterRing,
        ticks,
        tickGlowRing,
        tickDiffuseRing,
        membranes,
        contourBands,
        highlights,
        wireframeSphere,
        cageLines,
        glow,
        innerRings,
        outerRings,
        clockMarkers,
        parallelogramTicks,
        irisBlades,
        irisGlowRing,
        irisOuterGlowRing,
        siriRibbons,
        siriGlowSphere,
        siriCenter,
        siriRim,
        siriRim2,
        siriRim3,
        chassisArcs,
        bezelGlint,
        bezelGlintState,
      };
    }

    buildNode(node) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.set(node.anchor.x, node.anchor.y, node.anchor.z);
      group.userData.modelId = node.id;
      const palette = this.buildOrbPalette(node);
      const isInactive = Boolean(node.inactive);

      /* ── Hero-style wireframe sphere cage (primary visual element) ── */
      const tierDetail = node.tier === "flagship" ? 2 : 1;
      const icoGeo = new THREE.IcosahedronGeometry(node.size * 1.0, tierDetail);
      const edgesGeo = new THREE.EdgesGeometry(icoGeo, 1);

      const wireOpacity = isInactive
        ? (node.tier === "flagship" ? 0.15 : node.tier === "secondary" ? 0.11 : 0.07)
        : (node.tier === "flagship" ? 0.38 : node.tier === "secondary" ? 0.28 : 0.18);
      const wireframe = new THREE.LineSegments(
        edgesGeo,
        new THREE.LineBasicMaterial({
          color: palette.ring,
          transparent: true,
          opacity: wireOpacity,
          depthWrite: false,
        }),
      );
      wireframe.userData.modelId = node.id;
      group.add(wireframe);

      /* ── Shell sphere — faint dark fill for silhouette/depth ── */
      const shellOpacity = isInactive
        ? (node.tier === "flagship" ? 0.05 : 0.03)
        : (node.tier === "flagship" ? 0.10 : node.tier === "secondary" ? 0.08 : 0.05);
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(node.size * 0.98, tierDetail),
        new THREE.MeshBasicMaterial({
          color: palette.shell,
          transparent: true,
          opacity: shellOpacity,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      );
      group.add(shell);

      /* ── Hit sphere — invisible, for raycaster interaction ── */
      const hitSphere = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * 1.1, 8, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hitSphere.userData.modelId = node.id;
      group.add(hitSphere);

      /* ── Ghost sphere — subtle additive glow, tightly scaled ── */
      const ghostOpacity = isInactive ? 0
        : (node.tier === "flagship" ? 0.04 : node.tier === "secondary" ? 0.03 : 0.018);
      const ghost = new THREE.Mesh(
        new THREE.IcosahedronGeometry(node.size * 1.02, tierDetail),
        new THREE.MeshBasicMaterial({
          color: palette.halo,
          transparent: true,
          opacity: ghostOpacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(ghost);

      /* ── Internal field contours — structural objecthood cue ── */
      const nodeContourGroup = new THREE.Group();
      const contourCount = isInactive ? 0 : (node.tier === "flagship" ? 3 : node.tier === "secondary" ? 2 : 1);
      const nodeContourConfigs = [
        { radiusX: node.size * 0.92, radiusY: node.size * 0.68, rotationX: 1.12, rotationY: 0.24, rotationZ: -0.18, opacity: node.tier === "flagship" ? 0.26 : 0.20, speed: 0.04 },
        { radiusX: node.size * 0.74, radiusY: node.size * 0.86, rotationX: 0.48, rotationY: 0.78, rotationZ: 0.28, opacity: node.tier === "flagship" ? 0.18 : 0.14, speed: -0.03 },
        { radiusX: node.size * 0.58, radiusY: node.size * 0.52, rotationX: 1.46, rotationY: 0.12, rotationZ: -0.42, opacity: 0.12, speed: 0.025 },
      ];
      const nodeContours = nodeContourConfigs.slice(0, contourCount).map((config) => {
        const points = [];
        for (let i = 0; i < 64; i += 1) {
          const angle = (i / 64) * Math.PI * 2;
          points.push(new THREE.Vector3(
            Math.cos(angle) * config.radiusX,
            Math.sin(angle) * config.radiusY,
            0,
          ));
        }
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: palette.ring,
            transparent: true,
            opacity: config.opacity,
            depthWrite: false,
          }),
        );
        line.rotation.set(config.rotationX, config.rotationY, config.rotationZ);
        nodeContourGroup.add(line);
        return {
          line,
          baseOpacity: config.opacity,
          baseRotationX: config.rotationX,
          baseRotationY: config.rotationY,
          baseRotationZ: config.rotationZ,
          speed: config.speed,
        };
      });
      group.add(nodeContourGroup);

      /* ── Center node — bright core point (hero centerNode style) ── */
      const centerNode = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * 0.12, 12, 12),
        new THREE.MeshBasicMaterial({
          color: palette.nucleus,
          transparent: true,
          opacity: isInactive ? 0.18 : 0.42,
          depthWrite: false,
        }),
      );
      group.add(centerNode);

      /* ── Focused core (full apparatus — only built for active nodes) ── */
      let focusedCore = null;
      if (!isInactive) {
        focusedCore = this.buildFocusedCore(node, palette);
        group.add(focusedCore.group);
      }

      /* ── Guide ring — thin instrument torus ── */
      let guideRing = null;
      if (!isInactive) {
        guideRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 1.92 : node.tier === "secondary" ? 1.64 : 1.42), node.size * 0.016, 6, 56),
          new THREE.MeshBasicMaterial({
            color: palette.ring,
            transparent: true,
            opacity: node.tier === "flagship" ? 0.25 : node.tier === "secondary" ? 0.20 : 0.14,
            depthWrite: false,
          }),
        );
        guideRing.rotation.x = 1.22;
        guideRing.rotation.z = -0.18;
        group.add(guideRing);
      }

      /* ── Accent ring — inner instrument orbit ── */
      let accentRing = null;
      if (!isInactive) {
        accentRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 2.6 : 2.0), node.size * 0.038, 10, 64),
          new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: palette.ring,
            emissiveIntensity: node.tier === "flagship" ? 0.62 : node.tier === "secondary" ? 0.42 : 0.16,
            roughness: 0.4,
            metalness: 0.0,
            transparent: true,
            opacity: node.tier === "flagship" ? 0.33 : node.tier === "secondary" ? 0.21 : 0.06,
          }),
        );
        accentRing.rotation.x = 1.0;
        accentRing.rotation.z = 0.2;
        group.add(accentRing);
      }

      /* ── Orbit ring — wide ellipse (flagship active only) ── */
      let orbitRing = null;
      if (node.tier === "flagship" && !isInactive) {
        orbitRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * 4.4, node.size * 0.018, 8, 64),
          new THREE.MeshBasicMaterial({
            color: palette.lobes[1],
            transparent: true,
            opacity: 0.16,
          }),
        );
        orbitRing.rotation.x = 1.38;
        orbitRing.rotation.z = -0.28;
        group.add(orbitRing);
      }

      /* ── Focus lock ring (hidden until focused) ── */
      let focusRing = null;
      if (!isInactive && (node.tier !== "outer" || this.nodes.length <= 20)) {
        focusRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * 3.2, node.size * 0.02, 6, 48),
          new THREE.MeshBasicMaterial({
            color: palette.ring,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        );
        focusRing.rotation.x = 0.6;
        group.add(focusRing);
      }

      /* ── Metric bands ── */
      const metricBandGroup = new THREE.Group();
      metricBandGroup.position.z = node.size * 0.18;
      metricBandGroup.visible = false;
      const metricBandColors = [
        palette.ring.clone(),
        palette.shell.clone().lerp(palette.ring, 0.24),
        palette.emissive.clone().lerp(palette.shell, 0.22),
        palette.halo.clone().lerp(palette.ring, 0.36),
      ];
      const metricBands = (node.ringMetrics || []).map((metric, index) => {
        const band = this.createMetricBand(
          node.size * (3.58 + index * 0.42),
          metricBandColors[index % metricBandColors.length].getHex(),
          0.08 - index * 0.01,
        );
        band.metric = metric;
        band.track.rotation.z = 0.02 * index;
        band.active.rotation.z = 0.02 * index;
        metricBandGroup.add(band.track, band.active);
        return band;
      });
      group.add(metricBandGroup);

      const label = createLabelElement(node);
      if (isInactive) {
        label.classList.add("is-inactive");
      }
      this.labelLayer.appendChild(label);

      this.rootGroup.add(group);
      this.nodeLookup.set(node.id, {
        node,
        group,
        wireframe,
        shell,
        hitSphere,
        ghost,
        centerNode,
        nodeContours,
        nodeContourGroup,
        focusedCore,
        guideRing,
        accentRing,
        orbitRing,
        focusRing,
        metricBandGroup,
        metricBands,
        label,
        baseWireOpacity: wireOpacity,
        baseShellOpacity: shellOpacity,
        baseGhostOpacity: ghostOpacity,
        baseCenterOpacity: centerNode.material.opacity,
        wireRotationSpeed: isInactive ? 0.018 : (node.tier === "flagship" ? 0.06 : node.tier === "secondary" ? 0.04 : 0.025),
      });
    }

    clearNodes() {
      this.guides.forEach((guide) => this.scene.remove(guide.line));
      this.guides = [];
      this.trails.forEach((trail) => this.scene.remove(trail.line));
      this.trails = [];
      this.nodeLookup.forEach((entry) => {
        entry.label.remove();
        this.rootGroup.remove(entry.group);
      });
      this.nodeLookup.clear();
    }

    setData(payload) {
      const prevFocus = this.focusId;
      this.payload = payload;
      this.focusId = payload.focusModelId || null;
      if (this.focusId !== prevFocus) {
        this.focusChangedAt = performance.now();
        /* Click-to-zoom: dramatic instrument acquisition / release */
        if (this.focusId) {
          this.zoomTarget = this.zoomRange.min;
        } else {
          this.zoomTarget = this.zoomRange.max - 0.4;
        }
      }
      /* Bloom impulse on new focus acquisition */
      if (this.focusId && this.focusId !== prevFocus) {
        this.bloomImpulse = 1.0;
      }
      this.overlay.setFocus(this.focusId, performance.now());
      this.modes = payload.toggles || this.modes;
      this.nodes = buildFieldNodes(payload);
      this.clearNodes();
      this.nodes.forEach((node) => this.buildNode(node));
      this.rebuildGuides();
      this.rebuildTrails();
      this.shell.classList.toggle("is-compare-mode", Boolean(this.modes.compare));
      this.shell.classList.toggle("is-threshold-muted", !this.modes.threshold);
      this.measurementRings.forEach((ring, index) => {
        ring.material.opacity = this.modes.threshold ? (0.22 - index * 0.03) : 0.05;
      });
      this.renderLabels();
    }

    /* ── Animated dashed connection edges ── */
    rebuildGuides() {
      this.guides.forEach((guide) => this.scene.remove(guide.line));
      this.guides = [];
      const edges = this.payload.constellation.edges || [];
      if (!edges.length) return;

      let selectedEdges = [];
      if (this.focusId) {
        selectedEdges = topNeighbors(this.payload, this.focusId, 3).map((neighborId) => {
          return { source: this.focusId, target: neighborId, passive: false };
        });
      } else if (this.modes.compare) {
        const limit = this.nodeLookup.size > 18 ? 8 : 12;
        selectedEdges = edges
          .slice()
          .sort(function (left, right) { return right.similarity - left.similarity; })
          .slice(0, limit)
          .map(function (edge) {
            return { source: edge.source, target: edge.target, passive: true };
          });
      }

      selectedEdges.forEach((edge) => {
        const source = this.nodeLookup.get(edge.source);
        const target = this.nodeLookup.get(edge.target);
        if (!source || !target) return;
        const geometry = new this.THREE.BufferGeometry();
        const material = edge.passive
          ? new this.THREE.LineBasicMaterial({
              color: 0x6aaeff,
              transparent: true,
              opacity: 0.1,
            })
          : new this.THREE.LineDashedMaterial({
              color: 0x81d8ff,
              transparent: true,
              opacity: 0.38,
              dashSize: 0.18,
              gapSize: 0.12,
              linewidth: 1,
            });
        const guideLine = new this.THREE.Line(geometry, material);
        this.scene.add(guideLine);
        this.guides.push({
          fromId: edge.source,
          toId: edge.target,
          passive: edge.passive,
          line: guideLine,
        });
      });
    }

    rebuildTrails() {
      this.trails.forEach((trail) => this.scene.remove(trail.line));
      this.trails = [];
      if (!this.modes.history) return;

      const eligibleNodes = this.nodes.filter(function (node) {
        return node.trailEligible;
      });
      if (!eligibleNodes.length) return;

      const maxTrailNodes = this.nodeLookup.size > 18 ? (this.focusId ? 4 : 0) : this.focusId ? 4 : 8;
      const trailNodes = this.focusId
        ? eligibleNodes.filter((node) => node.id === this.focusId || topNeighbors(this.payload, this.focusId, 3).includes(node.id)).slice(0, maxTrailNodes)
        : eligibleNodes.slice(0, maxTrailNodes);

      trailNodes.forEach((node) => {
        const history = (this.payload.ciiHistory && this.payload.ciiHistory[node.id]) || [];
        if (history.length < 3) return;
        const line = new this.THREE.Line(
          new this.THREE.BufferGeometry(),
          new this.THREE.LineBasicMaterial({
            color: node.tier === "flagship" ? 0x9ce6ff : node.tier === "secondary" ? 0x6aacff : 0x4d74c8,
            transparent: true,
            opacity: node.tier === "flagship" ? 0.18 : 0.12,
          }),
        );
        this.scene.add(line);
        this.trails.push({
          id: node.id,
          line,
          history: history.slice(-10),
        });
      });
    }

    onPointerMove(event) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      this.pointerTarget.x = clamp(this.mouse.x, -1, 1);
      this.pointerTarget.y = clamp(this.mouse.y, -1, 1);
      this.lastInteractionAt = performance.now();
      this._clientX = event.clientX;
      this._clientY = event.clientY;
      this.updateHover();
    }

    onPointerLeave() {
      this.mouse.x = -10;
      this.mouse.y = -10;
      this.pointerTarget.x = 0;
      this.pointerTarget.y = 0;
      this.hoverId = null;
      this.renderer.domElement.style.cursor = "";
      this.tooltip.style.display = "none";
    }

    onPointerDown() {
      this.shell.focus({ preventScroll: true });
      this.lastInteractionAt = performance.now();
      if (!this.hoverId) {
        window.dispatchEvent(new CustomEvent("observatory:clear-focus"));
        return;
      }
      window.dispatchEvent(new CustomEvent("observatory:focus-model", {
        detail: { modelId: this.focusId === this.hoverId ? null : this.hoverId },
      }));
    }

    onKeyDown(event) {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      this.lastInteractionAt = performance.now();
      if (event.key === "ArrowLeft") this.keyVelocity.x = clamp(this.keyVelocity.x - 0.014, -0.08, 0.08);
      if (event.key === "ArrowRight") this.keyVelocity.x = clamp(this.keyVelocity.x + 0.014, -0.08, 0.08);
      if (event.key === "ArrowUp") this.keyVelocity.y = clamp(this.keyVelocity.y + 0.011, -0.06, 0.06);
      if (event.key === "ArrowDown") this.keyVelocity.y = clamp(this.keyVelocity.y - 0.011, -0.06, 0.06);
    }

    updateHover() {
      this.raycaster.setFromCamera(this.mouse, this.camera);
      const intersections = this.raycaster.intersectObjects(
        Array.from(this.nodeLookup.values()).map((entry) => entry.hitSphere),
        false,
      );
      const prevHover = this.hoverId;
      this.hoverId = intersections.length ? intersections[0].object.userData.modelId : null;

      /* Cursor change */
      this.renderer.domElement.style.cursor = this.hoverId ? "pointer" : "";

      /* Tooltip */
      if (this.hoverId && this.hoverId !== prevHover) {
        const entry = this.nodeLookup.get(this.hoverId);
        if (entry) {
          this.tooltip.innerHTML = formatTooltipHTML(entry.node);
          this.tooltip.style.display = "block";
        }
      } else if (!this.hoverId) {
        this.tooltip.style.display = "none";
      }
    }

    updateTooltipPosition() {
      if (!this.hoverId || this.tooltip.style.display === "none") return;
      const entry = this.nodeLookup.get(this.hoverId);
      if (!entry) return;
      const pos = entry.group.position.clone().project(this.camera);
      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = ((pos.x + 1) / 2) * rect.width;
      const y = ((-pos.y + 1) / 2) * rect.height;
      this.tooltip.style.transform = `translate(${x}px, ${y - 16}px)`;
    }

    updateNodes(time) {
      const idleDecay = performance.now() - this.lastInteractionAt > 1800;
      const damping = this.isActive ? 0.9 : 0.82;
      this.keyVelocity.x *= damping;
      this.keyVelocity.y *= damping;
      this.keyTarget.x = clamp((this.keyTarget.x + this.keyVelocity.x) * (idleDecay ? 0.985 : 0.992), -1.05, 1.05);
      this.keyTarget.y = clamp((this.keyTarget.y + this.keyVelocity.y) * (idleDecay ? 0.985 : 0.992), -0.78, 0.78);

      const slowTime = time * 0.001;
      const reducedMotion = motionQuery.matches;
      const focusReveal = this.focusId ? clamp((performance.now() - this.focusChangedAt) / (reducedMotion ? 220 : 720), 0, 1) : 0;

      this.nodeLookup.forEach((entry) => {
        const drift = time * 0.0002 * entry.node.driftSpeed;
        const siriPhase = slowTime * (0.48 + entry.node.driftSpeed * 0.34) + entry.node.orbitPhase;
        const siriWaveA = Math.sin(siriPhase);
        const siriWaveB = Math.sin(siriPhase * 1.37 + entry.node.cii * 4.2);
        const siriWaveC = Math.cos(siriPhase * 0.82 - entry.node.cii * 3.1);
        const isInactive = Boolean(entry.node.inactive);
        const driftScale = isInactive ? 0.5 : 1;
        entry.group.position.x = entry.node.anchor.x
          + siriWaveA * (entry.node.tier === "flagship" ? 0.3 : entry.node.tier === "secondary" ? 0.2 : 0.16) * driftScale
          + siriWaveB * 0.04 * driftScale;
        entry.group.position.y = entry.node.anchor.y
          + siriWaveB * (entry.node.tier === "flagship" ? 0.22 : entry.node.tier === "secondary" ? 0.15 : 0.12) * driftScale
          + siriWaveC * 0.035 * driftScale;
        entry.group.position.z = entry.node.anchor.z
          + siriWaveC * (entry.node.tier === "outer" ? 0.22 : 0.14) * driftScale
          + Math.sin(drift * 0.88 + entry.node.orbitPhase) * 0.04 * driftScale;
        entry.group.rotation.z = Math.sin(siriPhase * 0.42) * 0.08 * driftScale;
        entry.group.rotation.y = Math.cos(siriPhase * 0.36) * 0.06 * driftScale;

        const focused = this.focusId === entry.node.id;
        const hovered = this.hoverId === entry.node.id;
        const dimmed = Boolean(this.focusId) && !focused;
        const focusLevel = focused ? easeOutCubic(focusReveal) : 0;

        /* ── Node breathing: subtle pulsing ── */
        const breatheRate = 0.72 + entry.node.cii * 1.1;
        const breatheAmp = reducedMotion ? 0 : (isInactive ? 0.02 : entry.node.tier === "flagship" ? 0.036 : entry.node.tier === "secondary" ? 0.025 : 0.019);
        const breathe = 1.0 + Math.sin(slowTime * breatheRate + entry.node.orbitPhase) * breatheAmp;

        const dimScale = isInactive ? 0.65 : 0.78;
        const targetScale = (focused ? 1.92 : hovered ? 1.22 : dimmed ? dimScale : 1) * breathe;
        entry.group.scale.setScalar(lerp(entry.group.scale.x, targetScale, 0.12));

        /* ── Wireframe sphere rotation ── */
        if (entry.wireframe && !reducedMotion) {
          entry.wireframe.rotation.y += entry.wireRotationSpeed * 0.016;
          entry.wireframe.rotation.x += entry.wireRotationSpeed * 0.004;
        }

        /* ── Wireframe opacity ── */
        if (entry.wireframe) {
          const wireTarget = focused ? 0.32 + focusLevel * 0.12
            : hovered ? entry.baseWireOpacity * 1.5
            : dimmed ? entry.baseWireOpacity * (isInactive ? 0.20 : 0.40)
            : entry.baseWireOpacity;
          entry.wireframe.material.opacity = lerp(entry.wireframe.material.opacity, wireTarget, 0.1);
        }

        /* ── Shell opacity ── */
        if (entry.shell) {
          const shellTarget = focused ? entry.baseShellOpacity * 0.3
            : hovered ? entry.baseShellOpacity * 1.8
            : dimmed ? entry.baseShellOpacity * (isInactive ? 0.20 : 0.30)
            : entry.baseShellOpacity;
          entry.shell.material.opacity = lerp(entry.shell.material.opacity, shellTarget, 0.08);
        }

        /* ── Ghost opacity ── */
        if (entry.ghost) {
          const ghostTarget = focused ? 0
            : hovered ? entry.baseGhostOpacity * 1.6
            : dimmed ? 0
            : entry.baseGhostOpacity;
          entry.ghost.material.opacity = lerp(entry.ghost.material.opacity, ghostTarget, 0.1);
        }

        /* ── Center node ── */
        if (entry.centerNode) {
          const centerTarget = focused ? 0.50
            : hovered ? entry.baseCenterOpacity * 1.4
            : dimmed ? entry.baseCenterOpacity * 0.40
            : entry.baseCenterOpacity;
          entry.centerNode.material.opacity = lerp(entry.centerNode.material.opacity, centerTarget, 0.12);
        }

        /* ── Internal field contour animation ── */
        if (entry.nodeContours) {
          entry.nodeContours.forEach((contour) => {
            contour.line.material.opacity = lerp(
              contour.line.material.opacity,
              focused ? 0.02 : hovered ? contour.baseOpacity * 1.4 : dimmed ? contour.baseOpacity * 0.2 : contour.baseOpacity,
              0.1,
            );
            if (!reducedMotion) {
              contour.line.rotation.y += contour.speed * 0.016;
              contour.line.rotation.z = contour.baseRotationZ + Math.sin(slowTime * 0.3 + contour.speed * 6) * 0.03;
            }
          });
        }

        /* ── Guide ring ── */
        if (entry.guideRing) {
          entry.guideRing.material.opacity = lerp(
            entry.guideRing.material.opacity,
            focused ? 0.012 : hovered ? 0.18 : dimmed ? 0.015 :
              entry.node.tier === "flagship" ? 0.18 : entry.node.tier === "secondary" ? 0.14 : 0.1,
            0.09,
          );
          entry.guideRing.rotation.y += focused ? 0.014 : 0.006;
          entry.guideRing.rotation.z -= focused ? 0.006 : 0.002;
        }

        /* ── Focus lock ring ── */
        if (entry.focusRing) {
          entry.focusRing.material.opacity = lerp(
            entry.focusRing.material.opacity,
            focused ? 0.02 : 0,
            0.06,
          );
          if (focused) entry.focusRing.rotation.z -= 0.008;
        }

        /* ── Metric bands ── */
        if (entry.metricBands && entry.metricBandGroup) {
          const revealTarget = focused ? focusReveal : 0;
          entry.metricBandGroup.visible = revealTarget > 0.01 || entry.metricBands.some(function (band) {
            return band.reveal > 0.01;
          });
          entry.metricBandGroup.scale.setScalar(focused ? 1.02 + revealTarget * 0.04 : 1);
          entry.metricBandGroup.rotation.z = reducedMotion ? 0 : Math.sin(slowTime * 0.18 + entry.node.orbitPhase) * 0.06;
          entry.metricBands.forEach((band, index) => {
            band.reveal = lerp(band.reveal, revealTarget, focused ? 0.14 : 0.12);
            band.value = lerp(band.value, band.metric.value * band.reveal, focused ? 0.14 : 0.1);
            this.setMetricArcGeometry(
              band.active,
              band.radius,
              Math.max(5, band.value * FOCUS_RING_MAX_SWEEP),
            );
            band.track.material.opacity = lerp(
              band.track.material.opacity,
              focused ? Math.max(0.1, 0.14 - index * 0.015) : 0,
              0.12,
            );
            band.active.material.opacity = lerp(
              band.active.material.opacity,
              focused ? Math.max(0.18, 0.5 - index * 0.055) * band.reveal : 0,
              0.12,
            );
          });
        }

        /* ── Accent ring ── */
        if (entry.accentRing) {
          entry.accentRing.material.opacity = lerp(
            entry.accentRing.material.opacity,
            focused ? 0.018 : hovered ? 0.28 : dimmed ? 0.02 :
              entry.node.tier === "flagship" ? 0.22 : entry.node.tier === "secondary" ? 0.14 : 0.04,
            0.1,
          );
          const ringSpeed = entry.node.tier === "flagship" ? 0.15 : 0.08;
          entry.accentRing.rotation.y += ringSpeed * 0.016;
          entry.accentRing.rotation.z += ringSpeed * 0.007;
        }

        /* ── Orbit ring ── */
        if (entry.orbitRing) {
          entry.orbitRing.material.opacity = lerp(
            entry.orbitRing.material.opacity,
            focused ? 0.012 : hovered ? 0.18 : dimmed ? 0.02 :
              entry.node.tier === "flagship" ? 0.16 : 0.08,
            0.08,
          );
          const orbitSpeed = entry.node.tier === "flagship" ? 0.028 : 0.018;
          entry.orbitRing.rotation.y += orbitSpeed * 0.016;
          entry.orbitRing.rotation.z -= orbitSpeed * 0.004;
        }

        /* ── Focused core apparatus ── */
        if (entry.focusedCore) {
          const focusCoreActive = focused || entry.focusedCore.sphere.material.opacity > 0.01;
          entry.focusedCore.group.visible = focusCoreActive;
          const focusScaleTarget = focused ? 0.98 + focusLevel * 0.06 : 0.94;
          entry.focusedCore.group.scale.setScalar(lerp(entry.focusedCore.group.scale.x || 1, focusScaleTarget, 0.12));

          entry.focusedCore.sphere.material.opacity = lerp(
            entry.focusedCore.sphere.material.opacity,
            focused ? 0.68 + focusLevel * 0.12 : 0,
            focused ? 0.14 : 0.12,
          );
          entry.focusedCore.sphere.material.emissiveIntensity = lerp(
            entry.focusedCore.sphere.material.emissiveIntensity,
            focused ? 0.18 + focusLevel * 0.14 : 0.04,
            0.1,
          );
          entry.focusedCore.innerShell.material.opacity = lerp(
            entry.focusedCore.innerShell.material.opacity,
            focused ? 0.32 + focusLevel * 0.12 : 0,
            0.12,
          );
          entry.focusedCore.sphereRim.material.opacity = lerp(
            entry.focusedCore.sphereRim.material.opacity,
            focused ? 0.34 + focusLevel * 0.10 : 0,
            0.12,
          );
          entry.focusedCore.bezel.material.opacity = lerp(
            entry.focusedCore.bezel.material.opacity,
            focused ? 0.9 : 0,
            0.12,
          );
          entry.focusedCore.bezel.material.emissiveIntensity = lerp(
            entry.focusedCore.bezel.material.emissiveIntensity,
            focused ? 0.3 + focusLevel * 0.14 : 0.12,
            0.1,
          );
          entry.focusedCore.bezelEdge.material.opacity = lerp(
            entry.focusedCore.bezelEdge.material.opacity,
            focused ? 0.54 + focusLevel * 0.12 : 0,
            0.12,
          );
          entry.focusedCore.chapterRing.material.opacity = lerp(
            entry.focusedCore.chapterRing.material.opacity,
            focused ? 0.28 : 0,
            0.1,
          );
          entry.focusedCore.tickGlowRing.material.opacity = lerp(
            entry.focusedCore.tickGlowRing.material.opacity,
            focused ? 0.18 + focusLevel * 0.08 : 0,
            0.1,
          );
          entry.focusedCore.tickDiffuseRing.material.opacity = lerp(
            entry.focusedCore.tickDiffuseRing.material.opacity,
            focused ? 0.08 + focusLevel * 0.04 : 0,
            0.08,
          );
          entry.focusedCore.ticks.minor.material.opacity = lerp(
            entry.focusedCore.ticks.minor.material.opacity,
            focused ? 0.80 + focusLevel * 0.08 : 0,
            0.12,
          );
          entry.focusedCore.ticks.major.material.opacity = lerp(
            entry.focusedCore.ticks.major.material.opacity,
            focused ? 1 : 0,
            0.12,
          );
          entry.focusedCore.tickGlowRing.rotation.z += reducedMotion ? 0 : 0.001;
          entry.focusedCore.tickDiffuseRing.rotation.z -= reducedMotion ? 0 : 0.0006;
          entry.focusedCore.ticks.minor.rotation.z += reducedMotion ? 0 : 0.0014;
          entry.focusedCore.ticks.major.rotation.z -= reducedMotion ? 0 : 0.0018;

          /* ── Membranes — top 2 layers at low opacity for body mass, rest zero ── */
          entry.focusedCore.membranes.forEach((layer, memIdx) => {
            const memTarget = (focused && memIdx < 2) ? 0.08 * focusLevel : 0;
            layer.sprite.material.opacity = lerp(layer.sprite.material.opacity, memTarget, 0.14);
          });

          /* ── Contour bands ── */
          entry.focusedCore.contourBands.forEach((band) => {
            const wobble = reducedMotion ? 0 : Math.sin(slowTime * band.wobbleSpeed + band.phase);
            const bandScale = 1 + wobble * band.scaleAmplitude;
            band.line.material.opacity = lerp(
              band.line.material.opacity,
              focused ? band.baseOpacity * (1.3 + focusLevel * 0.32) : 0,
              0.12,
            );
            band.line.rotation.x = band.baseRotationX + (reducedMotion ? 0 : wobble * 0.08);
            band.line.rotation.y += reducedMotion ? 0 : band.speed * 0.016;
            band.line.rotation.z = band.baseRotationZ + (reducedMotion ? 0 : Math.cos(slowTime * band.wobbleSpeed * 0.62 + band.phase) * 0.07);
            band.line.scale.setScalar(bandScale);
          });

          /* ── Highlights — fade to zero (fog eliminated) ── */
          entry.focusedCore.highlights.forEach((highlight) => {
            highlight.sprite.material.opacity = lerp(highlight.sprite.material.opacity, 0, 0.12);
          });

          /* ── Wireframe sphere — boost on focus ── */
          if (entry.focusedCore.wireframeSphere) {
            entry.focusedCore.wireframeSphere.material.opacity = lerp(
              entry.focusedCore.wireframeSphere.material.opacity,
              focused ? 0.32 + focusLevel * 0.12 : 0,
              0.1,
            );
            if (!reducedMotion) {
              entry.focusedCore.wireframeSphere.rotation.y += 0.0012;
              entry.focusedCore.wireframeSphere.rotation.x += 0.0004;
            }
          }

          /* ── Cage lines (great-circle loops) ── */
          entry.focusedCore.cageLines.forEach((cage) => {
            cage.line.material.opacity = lerp(
              cage.line.material.opacity,
              focused ? cage.baseOpacity * (1.2 + focusLevel * 0.3) : 0,
              0.1,
            );
            cage.line.rotation.x = cage.baseRotationX;
            cage.line.rotation.y += reducedMotion ? 0 : cage.speed * 0.016;
            cage.line.rotation.z = cage.baseRotationZ + (reducedMotion ? 0 : Math.sin(slowTime * 0.24 + cage.speed * 8) * 0.04);
          });

          /* ── Siri-orb internal ribbons — bold luminous planes (focused only) ── */
          if (entry.focusedCore.siriRibbons) {
            entry.focusedCore.siriRibbons.forEach((ribbon, rIdx) => {
              ribbon.mesh.material.opacity = lerp(
                ribbon.mesh.material.opacity,
                focused ? ribbon.baseOpacity * focusLevel : 0,
                0.1,
              );
              if (!reducedMotion) {
                ribbon.mesh.rotation.x += ribbon.speed * 0.008;
                ribbon.mesh.rotation.y += ribbon.speed * 0.003 * Math.sin(slowTime * 0.4 + rIdx);
                ribbon.mesh.rotation.z += ribbon.speed * 0.005;
              }
            });
          }

          /* ── Siri inner glow sphere ── */
          if (entry.focusedCore.siriGlowSphere) {
            entry.focusedCore.siriGlowSphere.material.opacity = lerp(
              entry.focusedCore.siriGlowSphere.material.opacity,
              focused ? 0.18 * focusLevel : 0,
              0.08,
            );
            if (!reducedMotion) {
              const gpulse = 1 + Math.sin(slowTime * 0.8) * 0.06;
              entry.focusedCore.siriGlowSphere.scale.setScalar(gpulse);
            }
          }

          /* ── Siri central energy crossing ── */
          if (entry.focusedCore.siriCenter) {
            entry.focusedCore.siriCenter.material.opacity = lerp(
              entry.focusedCore.siriCenter.material.opacity,
              focused ? 0.65 * focusLevel : 0,
              0.1,
            );
            if (!reducedMotion) {
              const pulse = 1 + Math.sin(slowTime * 1.2) * 0.12;
              entry.focusedCore.siriCenter.scale.setScalar(pulse);
            }
          }

          /* ── Siri rim highlight ── */
          if (entry.focusedCore.siriRim) {
            entry.focusedCore.siriRim.material.opacity = lerp(
              entry.focusedCore.siriRim.material.opacity,
              focused ? 0.26 * focusLevel : 0,
              0.08,
            );
            if (!reducedMotion) {
              entry.focusedCore.siriRim.rotation.x += 0.002;
              entry.focusedCore.siriRim.rotation.z += 0.001;
            }
          }

          /* ── Siri rim 2 — second rim-light at different tilt ── */
          if (entry.focusedCore.siriRim2) {
            entry.focusedCore.siriRim2.material.opacity = lerp(
              entry.focusedCore.siriRim2.material.opacity,
              focused ? 0.18 * focusLevel : 0,
              0.08,
            );
            if (!reducedMotion) {
              entry.focusedCore.siriRim2.rotation.x += 0.0015;
              entry.focusedCore.siriRim2.rotation.z -= 0.0012;
            }
          }

          /* ── Siri rim 3 — equatorial highlight ── */
          if (entry.focusedCore.siriRim3) {
            entry.focusedCore.siriRim3.material.opacity = lerp(
              entry.focusedCore.siriRim3.material.opacity,
              focused ? 0.14 * focusLevel : 0,
              0.08,
            );
            if (!reducedMotion) {
              entry.focusedCore.siriRim3.rotation.y += 0.0018;
              entry.focusedCore.siriRim3.rotation.x += 0.0008;
            }
          }

          /* ── JARVIS iris / shutter blades ── */
          if (entry.focusedCore.irisBlades) {
            entry.focusedCore.irisBlades.forEach((blade, bIdx) => {
              blade.line.material.opacity = lerp(
                blade.line.material.opacity,
                focused ? blade.baseOpacity * focusLevel : 0,
                0.1,
              );
            });
            if (!reducedMotion) {
              /* Slow collective rotation for iris breathing */
              entry.focusedCore.irisBlades.forEach((blade) => {
                blade.line.rotation.z += 0.0006;
              });
            }
          }

          /* ── JARVIS iris glow rings ── */
          if (entry.focusedCore.irisGlowRing) {
            entry.focusedCore.irisGlowRing.material.opacity = lerp(
              entry.focusedCore.irisGlowRing.material.opacity,
              focused ? 0.20 * focusLevel : 0,
              0.1,
            );
            if (!reducedMotion) entry.focusedCore.irisGlowRing.rotation.z -= 0.0008;
          }
          if (entry.focusedCore.irisOuterGlowRing) {
            entry.focusedCore.irisOuterGlowRing.material.opacity = lerp(
              entry.focusedCore.irisOuterGlowRing.material.opacity,
              focused ? 0.12 * focusLevel : 0,
              0.1,
            );
            if (!reducedMotion) entry.focusedCore.irisOuterGlowRing.rotation.z += 0.0006;
          }

          /* ── JARVIS inner concentric rings ── */
          if (entry.focusedCore.innerRings) {
            entry.focusedCore.innerRings.forEach((ir) => {
              ir.ring.material.opacity = lerp(ir.ring.material.opacity, focused ? ir.baseOpacity * focusLevel : 0, 0.1);
            });
          }

          /* ── JARVIS outer decorative rings ── */
          if (entry.focusedCore.outerRings) {
            entry.focusedCore.outerRings.forEach((or) => {
              or.material.opacity = lerp(or.material.opacity, focused ? or.baseOpacity * focusLevel : 0, 0.08);
              if (!reducedMotion) {
                or.ring.rotation.z += or.speed * 0.016;
              }
            });
          }

          /* ── JARVIS clock-position markers ── */
          if (entry.focusedCore.clockMarkers) {
            entry.focusedCore.clockMarkers.forEach((cm) => {
              cm.line.material.opacity = lerp(cm.line.material.opacity, focused ? cm.baseOpacity * focusLevel : 0, 0.1);
            });
          }

          /* ── JARVIS parallelogram ticks ── */
          if (entry.focusedCore.parallelogramTicks) {
            entry.focusedCore.parallelogramTicks.forEach((pt) => {
              pt.line.material.opacity = lerp(pt.line.material.opacity, focused ? pt.baseOpacity * focusLevel : 0, 0.1);
            });
          }

          /* ── JARVIS chassis arcs ── */
          if (entry.focusedCore.chassisArcs) {
            entry.focusedCore.chassisArcs.forEach((arc) => {
              arc.line.material.opacity = lerp(
                arc.line.material.opacity,
                focused ? arc.baseOpacity * focusLevel : 0,
                0.1,
              );
              if (!reducedMotion) {
                arc.line.rotation.z += arc.speed * 0.016;
              }
            });
          }

          /* ── Focused glow — eliminated ── */
          entry.focusedCore.glow.material.opacity = lerp(
            entry.focusedCore.glow.material.opacity,
            0,
            0.08,
          );
        }
      });
    }

    /* ── Star field twinkling (multi-harmonic) ── */
    updateStars(time) {
      const sizes = this.starField.geometry.attributes.size;
      if (!sizes) return;
      const t = time * 0.001;
      for (let i = 0; i < this.starPhases.length; i++) {
        const s = this.starSpeeds[i];
        const p = this.starPhases[i];
        /* Compound wave for organic, irregular flicker */
        var twinkle = 0.55 + 0.25 * Math.sin(t * s + p)
          + 0.12 * Math.sin(t * s * 2.7 + p * 1.4)
          + 0.08 * Math.cos(t * s * 0.3 + p * 0.7);
        /* Rare bright flash stars (~3% of field) */
        if (p < 0.19) {
          twinkle *= 1 + 0.4 * Math.pow(Math.sin(t * 0.4 + p), 8);
        }
        sizes.array[i] = this.starBaseSizes[i] * twinkle;
      }
      sizes.needsUpdate = true;
    }

    /* ── Ambient dust drift ── */
    updateDust(time) {
      if (!this.dustField) return;
      const positions = this.dustField.geometry.attributes.position;
      const t = time * 0.0003;
      for (let i = 0; i < this.dustPhases.length; i++) {
        const phase = this.dustPhases[i];
        const base = i * 3;
        positions.array[base] += Math.sin(t + phase) * 0.0016;
        positions.array[base + 1] += Math.cos(t * 0.7 + phase) * 0.0012;
        positions.array[base + 2] += Math.sin(t * 0.5 + phase * 1.3) * 0.0014;
      }
      positions.needsUpdate = true;
    }

    /* ── Near-dust drift (foreground sensing motes) ── */
    updateNearDust(time) {
      if (!this.nearDust) return;
      const positions = this.nearDust.geometry.attributes.position;
      const t = time * 0.00018;
      for (let i = 0; i < this.nearDustPhases.length; i++) {
        const phase = this.nearDustPhases[i];
        const base = i * 3;
        positions.array[base] += Math.sin(t + phase) * 0.0009;
        positions.array[base + 1] += Math.cos(t * 0.6 + phase) * 0.0007;
        positions.array[base + 2] += Math.sin(t * 0.4 + phase * 1.2) * 0.0008;
      }
      positions.needsUpdate = true;
    }

    /* ── Measurement ring animation (flowing dashes + gentle rotation) ── */
    updateMeasurementRings(time) {
      const t = time * 0.001;
      this.measurementRings.forEach((ring, index) => {
        if (ring.material.dashSize) {
          ring.material.dashOffset -= 0.002;
        }
        ring.rotation.y += 0.0006 * (index + 1);
        /* 22s-cycle opacity breathing */
        const baseOpacity = this.modes.threshold ? 0.26 - index * 0.04 : 0.035;
        ring.material.opacity = baseOpacity + Math.sin(t * 0.285 + index * 1.2) * 0.03;
      });
    }

    updateGuides(time) {
      this.guides.forEach((guide) => {
        const fromEntry = this.nodeLookup.get(guide.fromId);
        const toEntry = this.nodeLookup.get(guide.toId);
        if (!fromEntry || !toEntry) return;
        const from = fromEntry.group.position.clone();
        const to = toEntry.group.position.clone();
        const midpoint = from.clone().lerp(to, 0.5);
        midpoint.y += 0.9;
        const curve = new this.THREE.QuadraticBezierCurve3(from, midpoint, to);
        const pts = curve.getPoints(28);
        guide.line.geometry.setFromPoints(pts);
        guide.line.computeLineDistances();
        if (guide.line.material.opacity != null) {
          guide.line.material.opacity = guide.passive ? (this.modes.compare ? 0.08 : 0.03) : (this.focusId ? 0.18 : 0.16);
        }

        /* ── Animated dash offset for flowing effect (faster when focused) ── */
        if (!guide.passive && guide.line.material.dashOffset !== undefined) {
          guide.line.material.dashOffset -= this.focusId ? 0.007 : 0.004;
        }
      });
    }

    updateTrails() {
      this.trails.forEach((trail) => {
        const entry = this.nodeLookup.get(trail.id);
        if (!entry) return;
        const history = trail.history;
        if (!history || history.length < 3) return;
        const values = history.map(function (sample) { return sample.value; });
        const minValue = Math.min.apply(null, values);
        const maxValue = Math.max.apply(null, values);
        const spread = Math.max(0.0001, maxValue - minValue);
        const points = history.map(function (sample, index) {
          const progress = history.length > 1 ? index / (history.length - 1) : 1;
          const offset = 1 - progress;
          const normalized = (sample.value - minValue) / spread;
          return new this.THREE.Vector3(
            entry.group.position.x - offset * (entry.node.tier === "flagship" ? 1.35 : 0.9),
            entry.group.position.y + (normalized - 0.5) * (entry.node.tier === "flagship" ? 0.72 : 0.44) + offset * 0.08,
            entry.group.position.z + offset * (entry.node.tier === "outer" ? 0.28 : 0.18),
          );
        }, this);
        trail.line.geometry.setFromPoints(points);
        trail.line.material.opacity = this.focusId && this.focusId !== trail.id
          ? 0.03
          : this.hoverId === trail.id || this.focusId === trail.id
          ? 0.12
          : entry.node.tier === "flagship"
          ? 0.18
          : 0.1;
      });
    }

    updateCamera(time) {
      const reducedMotion = motionQuery.matches;
      this.zoomVelocity *= this.isActive ? 0.84 : 0.78;
      this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
      this.zoomCurrent = lerp(this.zoomCurrent, this.zoomTarget, 0.08);

      /* ── Cinematic transition speed boost ── */
      const now = performance.now();
      const transitionAge = (now - (this.focusChangedAt || 0)) / 1000;
      const cameraLerp = transitionAge < 1.2 ? lerp(0.078, 0.032, transitionAge / 1.2) : 0.032;

      /* ── Transition intensity — time-based for sustained hyperdrive effect ── */
      const transitionDuration = 1.8;
      const transitionRaw = clamp(1 - transitionAge / transitionDuration, 0, 1);
      /* Sharp attack, slow decay for cinematic feel */
      const transitionIntensity = transitionAge < 0.15
        ? clamp(transitionAge / 0.15, 0, 1) * transitionRaw
        : transitionRaw * transitionRaw;

      /* ── Star field expansion during transition ── */
      if (this.starField && !reducedMotion) {
        const expansionFactor = 1 + transitionIntensity * 0.5;
        this.starField.material.size = 0.08 * Math.pow(expansionFactor, 1.5);
      }

      /* ── Warp lines — flowing radial hyperdrive streaks ── */
      if (this.warpLineMeta && !reducedMotion) {
        const t = time * 0.001;
        this.warpLineMeta.forEach((meta) => {
          /* Per-line flicker for flowing animation */
          const flicker = 0.5 + 0.5 * Math.sin(t * meta.flickerSpeed + meta.phase);
          const pulse = 0.7 + 0.3 * Math.sin(t * meta.flickerSpeed * 0.37 + meta.phase * 2.1);
          const warpOpacity = transitionIntensity > 0.02
            ? clamp(transitionIntensity * meta.baseOpacity * flicker * pulse, 0, 0.65)
            : 0;
          meta.mat1.opacity = lerp(meta.mat1.opacity, warpOpacity, 0.22);
          meta.mat2.opacity = lerp(meta.mat2.opacity, warpOpacity * 0.7, 0.22);
        });
        this.warpLineGroup.rotation.z += 0.001 * (1 + transitionIntensity * 2);
        /* Extend line length based on intensity */
        const warpScale = 1 + transitionIntensity * 0.8;
        this.warpLineGroup.scale.setScalar(lerp(this.warpLineGroup.scale.x, warpScale, 0.12));
      }

      const idleX = reducedMotion ? 0 : Math.sin(time * 0.00008) * 0.18;
      const idleY = reducedMotion ? 0 : Math.cos(time * 0.00006) * 0.07;
      const activityAlpha = clamp((now - this.lastInteractionAt) < 2200 ? 1 : 0.35, 0.35, 1);
      const focusAlpha = this.isActive ? 1 : 0.7;
      const userAlpha = activityAlpha * focusAlpha;
      const yaw = idleX + (this.pointerTarget.x * 0.32 + this.keyTarget.x * 0.52) * userAlpha;
      const pitch = idleY + (this.pointerTarget.y * 0.16 + this.keyTarget.y * 0.3) * userAlpha;

      /* ── Camera re-centering on focused node — prevents peripheral off-screen ── */
      if (this.focusId && this.nodeLookup.has(this.focusId)) {
        const focusEntry = this.nodeLookup.get(this.focusId);
        /* Strong re-centering: use 0.45 of the node position so peripheral
           nodes are pulled well into frame. Fast lerp (0.06) during fresh
           transition, slower (0.025) once settled. */
        const focusPos = focusEntry.group.position.clone().multiplyScalar(0.45);
        const focusLerp = transitionAge < 1.5 ? 0.06 : 0.025;
        this.focusTarget.lerp(focusPos, focusLerp);
      } else {
        this.focusTarget.lerp(new this.THREE.Vector3(0, 0, 0), 0.025);
      }

      const zoomNorm = (this.zoomCurrent - this.zoomRange.min) / (this.zoomRange.max - this.zoomRange.min);
      const desired = new this.THREE.Vector3(
        Math.sin(yaw) * lerp(2.7, 3.8, zoomNorm),
        1.2 + pitch * lerp(4.8, 6.35, zoomNorm),
        this.zoomCurrent + Math.cos(yaw * 1.18) * 1.15,
      );
      this.camera.position.lerp(desired, cameraLerp);
      this.focusPoint.lerp(this.focusTarget, 0.04);
      this.camera.lookAt(this.focusPoint);
    }

    updateOverlay(time) {
      if (!this.overlay) return;
      if (!this.focusId || !this.nodeLookup.has(this.focusId)) {
        this.overlay.update(time, null, null);
        return;
      }
      const focusEntry = this.nodeLookup.get(this.focusId);
      const position = focusEntry.group.position.clone().project(this.camera);
      const visible = position.z > -1 && position.z < 1;
      if (!visible) {
        this.overlay.update(time, null, null);
        return;
      }
      const width = this.target.clientWidth || 700;
      const height = this.target.clientHeight || 460;
      const target = {
        x: ((position.x + 1) / 2) * width,
        y: ((-position.y + 1) / 2) * height,
        radius: 42 + (focusEntry.node.size * 148),
        visible: true,
      };
      const meta = {
        id: focusEntry.node.id,
        label: focusEntry.node.label,
        labelPrimary: focusEntry.node.labelDisplay ? focusEntry.node.labelDisplay.primary : focusEntry.node.label,
        labelQualifier: focusEntry.node.labelDisplay ? focusEntry.node.labelDisplay.qualifier : "",
        provider: focusEntry.node.provider,
        tier: focusEntry.node.tier,
        rank: focusEntry.node.relativeStanding || "--",
        trend: `${focusEntry.node.rangeTrend >= 0 ? "+" : ""}${focusEntry.node.rangeTrend.toFixed(3)}`,
        cii: (focusEntry.node.rangeCii || focusEntry.node.cii).toFixed(3),
      };
      this.overlay.update(time, target, meta);
    }

    renderLabels() {
      if (!this.nodeLookup.size) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const candidates = [];
      const hasFocusedLock = Boolean(this.focusId);
      this.nodeLookup.forEach((entry) => {
        const position = entry.group.position.clone().project(this.camera);
        const visible = position.z > -1 && position.z < 1;
        if (!visible) {
          entry.label.classList.remove("is-visible");
          entry.label.classList.remove("is-secondary-callout");
          return;
        }
        const x = ((position.x + 1) / 2) * rect.width;
        const y = ((-position.y + 1) / 2) * rect.height;
        const isFocused = this.focusId === entry.node.id;
        const splitLabel = entry.node.labelDisplay || splitFocusedLabel(entry.node.label);
        const focusBoost = isFocused
          ? 160
          : this.hoverId === entry.node.id
          ? 96
          : entry.node.tier === "flagship"
          ? 64
          : entry.node.tier === "secondary" && position.z < 0.45 && !entry.node.stale
          ? 38
          : 12;
        if (focusBoost < 20) {
          entry.label.classList.remove("is-visible");
          entry.label.classList.remove("is-secondary-callout");
          return;
        }
        const width = isFocused && splitLabel.qualifier
          ? clamp(156 + Math.max(splitLabel.primary.length * 5.4, splitLabel.qualifier.length * 5.1), 176, 278)
          : clamp(118 + (isFocused ? splitLabel.primary.length * 5 : entry.node.label.length * 4.4), 118, 244);
        const height = isFocused
          ? splitLabel.qualifier ? 58 : 42
          : 36;
        candidates.push({ entry, x, y, width, height, priority: focusBoost, depth: position.z, isFocused: isFocused });
      });

      candidates.sort(function (left, right) {
        return right.priority - left.priority || left.depth - right.depth;
      });

      const accepted = [];
      let secondaryCalloutCount = 0;
      candidates.forEach(function (candidate) {
        if (hasFocusedLock && !candidate.isFocused && secondaryCalloutCount >= 1) {
          candidate.entry.label.classList.remove("is-visible");
          candidate.entry.label.classList.remove("is-secondary-callout");
          return;
        }
        const collision = accepted.some(function (other) {
          const xFactor = other.isFocused || candidate.isFocused ? 0.66 : 0.42;
          const yFactor = other.isFocused || candidate.isFocused ? 0.98 : 0.68;
          return Math.abs(other.x - candidate.x) < (other.width + candidate.width) * xFactor
            && Math.abs(other.y - candidate.y) < (other.height + candidate.height) * yFactor;
        });
        if (collision && (!candidate.isFocused || candidate.priority < 150)) {
          candidate.entry.label.classList.remove("is-visible");
          candidate.entry.label.classList.remove("is-secondary-callout");
          return;
        }
        if (hasFocusedLock && !candidate.isFocused && candidate.priority < 90) {
          candidate.entry.label.classList.remove("is-visible");
          candidate.entry.label.classList.remove("is-secondary-callout");
          return;
        }
        accepted.push(candidate);
        candidate.entry.label.classList.add("is-visible");
        candidate.entry.label.classList.toggle("is-focused", this.focusId === candidate.entry.node.id);
        candidate.entry.label.classList.toggle("is-dimmed", Boolean(this.focusId) && this.focusId !== candidate.entry.node.id);
        candidate.entry.label.classList.toggle("is-secondary-callout", hasFocusedLock && !candidate.isFocused);
        if (hasFocusedLock && !candidate.isFocused) secondaryCalloutCount += 1;
        candidate.entry.label.style.transform = `translate(${candidate.x}px, ${candidate.y}px)`;
      }, this);

      this.nodeLookup.forEach(function (entry) {
        if (!accepted.some(function (candidate) { return candidate.entry === entry; })) {
          entry.label.classList.remove("is-visible");
          entry.label.classList.remove("is-secondary-callout");
        }
      });
    }

    resize() {
      const width = this.target.clientWidth || 700;
      const height = this.target.clientHeight || 460;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.overlay.resize(width, height);
      if (this.composer) {
        this.composer.setSize(width, height);
      }
      if (this.bloomPass) {
        this.bloomPass.resolution.set(width, height);
      }
      this.renderLabels();
    }

    updateGlints(time) {
      const now = performance.now();
      const reducedMotion = motionQuery.matches;
      if (reducedMotion) return;

      this.nodeLookup.forEach((entry) => {
        /* ── Unfocused node glints ── */
        if (entry.glintSprite && entry.glintState) {
          const gs = entry.glintState;
          const dimmed = Boolean(this.focusId) && this.focusId !== entry.node.id;
          if (dimmed) {
            entry.glintSprite.material.opacity = lerp(entry.glintSprite.material.opacity, 0, 0.15);
            return;
          }
          if (!gs.active && now > gs.nextGlintAt) {
            gs.active = true;
            gs.progress = 0;
            gs.angle = Math.random() * Math.PI * 2;
          }
          if (gs.active) {
            gs.progress += 0.016;
            const riseDuration = 0.10;
            const totalDuration = 0.75;
            const t = gs.progress / totalDuration;
            let opacity = t < (riseDuration / totalDuration)
              ? t / (riseDuration / totalDuration)
              : 1 - ((t - riseDuration / totalDuration) / (1 - riseDuration / totalDuration));
            opacity = clamp(opacity, 0, 1);
            const peakOpacity = entry.node.tier === "flagship" ? 0.45 : entry.node.tier === "secondary" ? 0.28 : 0.12;
            entry.glintSprite.material.opacity = opacity * peakOpacity;
            const ringRadius = entry.node.size * 1.8;
            entry.glintSprite.position.set(
              Math.cos(gs.angle) * ringRadius,
              Math.sin(gs.angle) * ringRadius,
              entry.node.size * 0.08,
            );
            if (t >= 1) {
              gs.active = false;
              gs.progress = 0;
              entry.glintSprite.material.opacity = 0;
              gs.nextGlintAt = now + gs.baseInterval + Math.random() * gs.intervalRange;
            }
          }
        }

        /* ── Focused bezel glint ── */
        if (entry.focusedCore && entry.focusedCore.bezelGlint && entry.focusedCore.bezelGlintState) {
          const focused = this.focusId === entry.node.id;
          const bgs = entry.focusedCore.bezelGlintState;
          if (!focused) {
            entry.focusedCore.bezelGlint.material.opacity = lerp(entry.focusedCore.bezelGlint.material.opacity, 0, 0.2);
            return;
          }
          if (!bgs.active && now > bgs.nextGlintAt) {
            bgs.active = true;
            bgs.progress = 0;
            bgs.angle = Math.random() * Math.PI * 2;
          }
          if (bgs.active) {
            bgs.progress += 0.016;
            const riseDuration = 0.08;
            const totalDuration = 0.6;
            const t = bgs.progress / totalDuration;
            let opacity = t < (riseDuration / totalDuration)
              ? t / (riseDuration / totalDuration)
              : 1 - ((t - riseDuration / totalDuration) / (1 - riseDuration / totalDuration));
            opacity = clamp(opacity, 0, 1) * 0.65;
            entry.focusedCore.bezelGlint.material.opacity = opacity;
            const r = bgs.bezelRadius;
            entry.focusedCore.bezelGlint.position.set(
              Math.cos(bgs.angle) * r,
              Math.sin(bgs.angle) * r,
              0.02,
            );
            if (t >= 1) {
              bgs.active = false;
              bgs.progress = 0;
              entry.focusedCore.bezelGlint.material.opacity = 0;
              bgs.nextGlintAt = now + 2000 + Math.random() * 4000;
            }
          }
        }
      });
    }

    animate(time) {
      const slowTime = time * 0.001;

      this.updateHover();
      this.updateNodes(time);
      this.updateStars(time);
      this.updateDust(time);
      this.updateNearDust(time);
      this.updateGuides(time);
      this.updateTrails();
      this.updateGlints(time);
      this.updateCamera(time);
      this.updateTooltipPosition();
      this.updateMeasurementRings(time);

      /* ── Ambient light breathing (18s cycle) ── */
      if (this.ambientLight) {
        this.ambientLight.intensity = this.ambientBaseIntensity + Math.sin(slowTime * 0.35) * 0.04;
      }

      /* ── Grid time uniform for breathing ── */
      if (this.gridMesh && this.gridMesh.material.uniforms && this.gridMesh.material.uniforms.uTime) {
        this.gridMesh.material.uniforms.uTime.value = slowTime;
      }

      /* ── Bloom impulse decay ── */
      if (this.bloomPass) {
        if (this.bloomImpulse > 0) {
          this.bloomImpulse *= 0.94;
          if (this.bloomImpulse < 0.005) this.bloomImpulse = 0;
        }
        const bloomTarget = this.focusId ? 0.34 : this.bloomBase;
        this.bloomPass.strength = lerp(this.bloomPass.strength, bloomTarget + this.bloomImpulse * 0.12, 0.08);
      }

      /* Throttle label rendering: every 3rd frame */
      this.labelFrameSkip = (this.labelFrameSkip + 1) % 3;
      if (this.labelFrameSkip === 0) {
        this.renderLabels();
      }

      this.updateOverlay(time);

      /* Render with bloom if available, otherwise standard */
      if (this.composer) {
        this.composer.render();
      } else {
        this.renderer.render(this.scene, this.camera);
      }

      this.frame = window.requestAnimationFrame(this.animate);
    }

    destroy() {
      if (this.frame) window.cancelAnimationFrame(this.frame);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      window.removeEventListener("resize", this.onResize);
      this.shell.removeEventListener("keydown", this.onKeyDown);
      this.shell.removeEventListener("focus", this.onFocus);
      this.shell.removeEventListener("blur", this.onBlur);
      this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
      this.renderer.domElement.removeEventListener("pointerleave", this.onPointerLeave);
      this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
      if (this.composer) this.composer.dispose();
      this.renderer.dispose();
      this.target.innerHTML = "";
    }
  }

  class LayeredFallbackField {
    constructor(target, reducedMotion) {
      this.target = target;
      this.reducedMotion = reducedMotion;
      this.payload = latestPayload;
      this.focusId = null;
      this.pointer = { x: 0, y: 0 };
      this.keyOffset = { x: 0, y: 0 };
      this.keyVelocity = { x: 0, y: 0 };
      this.zoomRange = { min: 0.9, max: 1.2 };
      this.zoomTarget = 1;
      this.zoomCurrent = 1;
      this.zoomVelocity = 0;
      this.frame = null;
      this.layers = [];
      this.nodeElements = new Map();
      this.fieldNodes = [];
      this.focusChangedAt = 0;

      this.target.innerHTML = `
        <div class="observatory-fallback-field ${reducedMotion ? "is-reduced" : ""}" tabindex="0" role="application" aria-label="Interactive observatory field">
          <div class="observatory-field-hud">Field idle${reducedMotion ? " · reduced motion" : " · fallback mode"}</div>
          <div class="observatory-fallback-layer observatory-fallback-layer--far"></div>
          <div class="observatory-fallback-layer observatory-fallback-layer--mid"></div>
          <div class="observatory-fallback-layer observatory-fallback-layer--near"></div>
        </div>
      `;

      this.shell = this.target.firstElementChild;
      this.hud = this.shell.querySelector(".observatory-field-hud");
      this.layers = Array.from(this.shell.querySelectorAll(".observatory-fallback-layer"));
      this.overlay = new ObservatoryScreenOverlay(this.shell, reducedMotion);
      this.bindEvents();
      this.resize();
      this.setData(latestPayload);
      if (!this.reducedMotion) {
        this.animate = this.animate.bind(this);
        this.frame = window.requestAnimationFrame(this.animate);
      }
    }

    bindEvents() {
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerLeave = this.onPointerLeave.bind(this);
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onFocus = this.onFocus.bind(this);
      this.onBlur = this.onBlur.bind(this);
      this.onResize = this.resize.bind(this);
      this.shell.addEventListener("pointermove", this.onPointerMove);
      this.shell.addEventListener("pointerleave", this.onPointerLeave);
      this.shell.addEventListener("pointerdown", this.onPointerDown);
      this.shell.addEventListener("keydown", this.onKeyDown);
      this.shell.addEventListener("focus", this.onFocus);
      this.shell.addEventListener("blur", this.onBlur);
      window.addEventListener("resize", this.onResize);
    }

    setActive(active) {
      this.shell.classList.toggle("is-active", active);
      this.target.classList.toggle("is-field-active", active);
      if (this.hud) {
        this.hud.textContent = active
          ? `Field active${this.reducedMotion ? " · reduced motion" : " · fallback mode"} · click to focus`
          : `Field idle${this.reducedMotion ? " · reduced motion" : " · fallback mode"} · click to focus`;
      }
    }

    onFocus() {
      this.setActive(true);
    }

    onBlur() {
      this.setActive(false);
    }

    onPointerDown() {
      this.shell.focus({ preventScroll: true });
    }

    onKeyDown(event) {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") this.keyVelocity.x = clamp(this.keyVelocity.x - 0.012, -0.08, 0.08);
      if (event.key === "ArrowRight") this.keyVelocity.x = clamp(this.keyVelocity.x + 0.012, -0.08, 0.08);
      if (event.key === "ArrowUp") this.keyVelocity.y = clamp(this.keyVelocity.y - 0.012, -0.08, 0.08);
      if (event.key === "ArrowDown") this.keyVelocity.y = clamp(this.keyVelocity.y + 0.012, -0.08, 0.08);
    }

    onPointerMove(event) {
      const rect = this.shell.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) - 0.5;
      this.pointer.y = ((event.clientY - rect.top) / rect.height) - 0.5;
    }

    onPointerLeave() {
      this.pointer.x = 0;
      this.pointer.y = 0;
    }

    setData(payload) {
      const previousFocus = this.focusId;
      this.payload = payload;
      this.focusId = payload.focusModelId || null;
      if (this.focusId !== previousFocus) {
        this.focusChangedAt = performance.now();
        /* Click-to-zoom: zoom in on focus, zoom out on clear */
        if (this.focusId) {
          this.zoomTarget = this.zoomRange.min;
        } else {
          this.zoomTarget = this.zoomRange.max;
        }
      }
      this.overlay.setFocus(this.focusId, this.focusChangedAt || performance.now());
      this.fieldNodes = buildFieldNodes(this.payload);
      this.render();
      this.updateOverlay(performance.now());
    }

    render() {
      this.layers.forEach(function (layer) {
        layer.innerHTML = "";
      });
      this.nodeElements.clear();
      this.fieldNodes.forEach((node) => {
        const normalizedX = clamp((node.anchor.x + 5.9) / 11.8, 0.09, 0.91);
        const normalizedY = clamp((node.anchor.y + 3.35) / 6.7, 0.12, 0.88);
        const layer = node.tier === "flagship" ? this.layers[2] : node.tier === "secondary" ? this.layers[1] : this.layers[0];
        const element = document.createElement("button");
        element.type = "button";
        element.className = `observatory-fallback-node observatory-fallback-node--${node.tier}`;
        if (node.labelDisplay && node.labelDisplay.qualifier) element.classList.add("has-qualifier");
        if (this.focusId === node.id) element.classList.add("is-focused");
        if (this.focusId && this.focusId !== node.id) element.classList.add("is-dimmed");
        if (node.tier !== "flagship" && this.focusId !== node.id) element.classList.add("is-label-suppressed");
        element.style.left = `${normalizedX * 100}%`;
        element.style.top = `${normalizedY * 100}%`;
        element.style.setProperty("--node-size", `${40 + node.size * 100}px`);
        element.innerHTML = `
          <span class="observatory-fallback-target-shell">
            ${this.focusId === node.id ? buildFallbackRingMarkup(node) : ""}
            <span class="observatory-fallback-star">
              <span class="observatory-fallback-core">
                <span class="observatory-fallback-core-layer observatory-fallback-core-layer--a"></span>
                <span class="observatory-fallback-core-layer observatory-fallback-core-layer--b"></span>
                <span class="observatory-fallback-core-layer observatory-fallback-core-layer--c"></span>
              </span>
            </span>
          </span>
          <span class="observatory-fallback-label">
            ${buildLabelTitleMarkup("observatory-fallback-label", node.labelDisplay || splitFocusedLabel(node.label))}
            <span class="observatory-fallback-label-meta">${node.provider} · ${node.cii.toFixed(3)}</span>
          </span>
        `;
        element.addEventListener("click", () => {
          window.dispatchEvent(new CustomEvent("observatory:focus-model", {
            detail: { modelId: this.focusId === node.id ? null : node.id },
          }));
        });
        layer.appendChild(element);
        this.nodeElements.set(node.id, element);
      });
    }

    resize() {
      if (!this.overlay) return;
      this.overlay.resize(this.target.clientWidth || 700, this.target.clientHeight || 460);
      this.updateOverlay(performance.now());
    }

    updateOverlay(time) {
      if (!this.overlay || !this.focusId) {
        if (this.overlay) this.overlay.update(time, null, null);
        return;
      }
      const element = this.nodeElements.get(this.focusId);
      const focusedNode = this.fieldNodes.find((node) => node.id === this.focusId);
      if (!element || !focusedNode) {
        this.overlay.update(time, null, null);
        return;
      }
      const shellRect = this.shell.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const target = {
        x: rect.left - shellRect.left + (rect.width / 2),
        y: rect.top - shellRect.top + (rect.height / 2),
        radius: Math.max(42, rect.width * 0.7),
        visible: true,
      };
      const meta = {
        id: focusedNode.id,
        label: focusedNode.label,
        labelPrimary: focusedNode.labelDisplay ? focusedNode.labelDisplay.primary : focusedNode.label,
        labelQualifier: focusedNode.labelDisplay ? focusedNode.labelDisplay.qualifier : "",
        provider: focusedNode.provider,
        tier: focusedNode.tier,
        rank: focusedNode.relativeStanding || "--",
        trend: `${focusedNode.rangeTrend >= 0 ? "+" : ""}${focusedNode.rangeTrend.toFixed(3)}`,
        cii: (focusedNode.rangeCii || focusedNode.cii).toFixed(3),
      };
      this.overlay.update(time, target, meta);
    }

    animate() {
      this.keyVelocity.x *= 0.86;
      this.keyVelocity.y *= 0.86;
      this.zoomVelocity *= 0.82;
      this.keyOffset.x = clamp((this.keyOffset.x + this.keyVelocity.x) * 0.98, -0.35, 0.35);
      this.keyOffset.y = clamp((this.keyOffset.y + this.keyVelocity.y) * 0.98, -0.35, 0.35);
      this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
      this.zoomCurrent = lerp(this.zoomCurrent, this.zoomTarget, 0.08);
      this.layers.forEach((layer, index) => {
        const depth = (index + 1) * 0.85;
        const scale = this.zoomCurrent * (1 + index * 0.06);
        layer.style.transform = `translate3d(${(this.pointer.x + this.keyOffset.x) * depth * 22}px, ${(this.pointer.y + this.keyOffset.y) * depth * 22}px, 0) scale(${scale})`;
      });
      this.updateOverlay(performance.now());
      this.frame = window.requestAnimationFrame(this.animate);
    }

    destroy() {
      if (this.frame) window.cancelAnimationFrame(this.frame);
      window.removeEventListener("resize", this.onResize);
      this.shell.removeEventListener("pointermove", this.onPointerMove);
      this.shell.removeEventListener("pointerleave", this.onPointerLeave);
      this.shell.removeEventListener("pointerdown", this.onPointerDown);
      this.shell.removeEventListener("keydown", this.onKeyDown);
      this.shell.removeEventListener("focus", this.onFocus);
      this.shell.removeEventListener("blur", this.onBlur);
      this.target.innerHTML = "";
    }
  }

  async function createController() {
    if (controller) controller.destroy();

    if (motionQuery.matches || !hasWebGL()) {
      controller = new LayeredFallbackField(root, motionQuery.matches);
      controller.setData(latestPayload);
      return;
    }

    try {
      const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js");

      /* Attempt to load post-processing addons for bloom */
      let addons = {};
      try {
        const [composerModule, renderPassModule, bloomModule] = await Promise.all([
          import("https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/EffectComposer.js"),
          import("https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/RenderPass.js"),
          import("https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]);
        addons = {
          EffectComposer: composerModule.EffectComposer,
          RenderPass: renderPassModule.RenderPass,
          UnrealBloomPass: bloomModule.UnrealBloomPass,
        };
      } catch (addonError) {
        console.warn("Post-processing addons unavailable, continuing without bloom:", addonError);
      }

      controller = new PremiumObservatoryField(root, THREE, addons);
      controller.setData(latestPayload);
    } catch (error) {
      console.error("Observatory field 3D init failed, falling back", error);
      controller = new LayeredFallbackField(root, motionQuery.matches);
      controller.setData(latestPayload);
    }
  }

  window.addEventListener("observatory:data", function (event) {
    latestPayload = event.detail || latestPayload;
    if (controller) controller.setData(latestPayload);
  });

  motionQuery.addEventListener("change", function () {
    createController().catch(function (error) {
      console.error("Observatory field reinit failed", error);
    });
  });

  createController().catch(function (error) {
    console.error("Observatory field boot failed", error);
  });
}
