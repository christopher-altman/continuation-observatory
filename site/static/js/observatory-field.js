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
        return {
          id: node.id,
          label: node.label,
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

    return sorted.map(function (node, index) {
      const score = node.rangeCii || node.cii || 0;
      const tier = index < 3 ? "flagship" : index < 7 ? "secondary" : "outer";
      const baseHash = hashString(`${node.id}:${node.provider}`);
      const scoreNorm = clamp(score / maxScore, 0.08, 1);
      const rankNorm = sorted.length > 1 ? index / (sorted.length - 1) : 0;
      const providerBand = providerToBand.get(node.provider) || 0;
      const providerMid = (providers.length - 1) / 2;
      const bandBias = (providerBand - providerMid) * 0.52;
      const tierRadius = tier === "flagship" ? 1.65 : tier === "secondary" ? 3.35 : 5.15;
      const radius = tierRadius + rankNorm * 0.65 + (1 - scoreNorm) * 0.45 + (((baseHash * 7.13) % 1) - 0.5) * 0.42;
      const angle = (baseHash * Math.PI * 2) + (index * 0.97) + providerBand * 0.18;
      const x = Math.cos(angle) * radius;
      const y = bandBias + Math.sin(angle * 1.18) * (tier === "flagship" ? 0.42 : tier === "secondary" ? 0.56 : 0.68) + (((baseHash * 13.1) % 1) - 0.5) * 0.18;
      const z = (tier === "flagship" ? -1.2 : tier === "secondary" ? 0.1 : 1.2) + (node.rangeTrend || 0) * 2.1 + (((baseHash * 11.37) % 1) - 0.5) * (tier === "outer" ? 1.5 : 0.95);
      return {
        ...node,
        tier,
        size: tier === "flagship" ? 0.22 + scoreNorm * 0.22 : tier === "secondary" ? 0.14 + scoreNorm * 0.14 : 0.09 + scoreNorm * 0.1,
        haloScale: tier === "flagship" ? 2.6 : tier === "secondary" ? 1.92 : 1.36,
        glow: tier === "flagship" ? 1 : tier === "secondary" ? 0.78 : 0.52,
        orbitPhase: baseHash * Math.PI * 2,
        driftSpeed: 0.4 + (((baseHash * 17.11) % 1) * 0.36),
        trailEligible: node.historyDepth >= 3,
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

  function createLabelElement(node) {
    const element = document.createElement("div");
    element.className = `observatory-node-label observatory-node-label--${node.tier}`;
    element.innerHTML = `
      <span class="observatory-node-label-name">${node.label}</span>
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
        "stroke-width": "1.8",
      });
      this.bracketNorthEast = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "1.8",
      });
      this.bracketSouthWest = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "1.8",
      });
      this.bracketSouthEast = createSvgElement("path", {
        class: "observatory-screen-overlay__focus-bracket",
        "stroke-width": "1.8",
      });
      this.scanLine = createSvgElement("line", {
        class: "observatory-screen-overlay__scan-line",
      });
      this.annotationRect = createSvgElement("rect", {
        class: "observatory-screen-overlay__annotation",
        rx: "12",
        ry: "12",
        width: "232",
        height: "52",
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
      const annotationWidth = clamp(196 + (meta.label.length * 4.6), 224, 316);
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
      this.annotationText.setAttribute("y", annotationY + 19);
      this.annotationText.textContent = meta.label.toUpperCase();
      this.annotationMeta.setAttribute("x", annotationX + 16);
      this.annotationMeta.setAttribute("y", annotationY + 37);
      this.annotationMeta.textContent = `${meta.provider.toUpperCase()} · RANK ${meta.rank} · Δ ${meta.trend}`;
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
      this.zoomRange = { min: 8.6, max: 15.4 };
      this.zoomTarget = 11.2;
      this.zoomCurrent = 11.2;
      this.zoomVelocity = 0;
      this.lastInteractionAt = 0;
      this.isActive = false;
      this.payload = latestPayload;
      this.frame = null;
      this.resizeObserver = null;
      this.labelFrameSkip = 0;
      this.bloomImpulse = 0;
      this.bloomBase = 0.52;
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
      this.onWheel = this.onWheel.bind(this);
      this.onFocus = this.onFocus.bind(this);
      this.onBlur = this.onBlur.bind(this);
      this.onResize = this.resize.bind(this);

      this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
      this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
      this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
      this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false });
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
          ? "Field active · arrows scan · wheel zoom · click model to pin focus"
          : "Field idle · click or tab to activate · arrows scan · wheel zoom";
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

    createLivingCoreTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 192;
      const context = canvas.getContext("2d");
      const primary = context.createRadialGradient(78, 82, 10, 96, 96, 82);
      primary.addColorStop(0, "rgba(255,255,255,0.96)");
      primary.addColorStop(0.18, "rgba(233,242,255,0.82)");
      primary.addColorStop(0.42, "rgba(184,213,255,0.34)");
      primary.addColorStop(0.72, "rgba(126,162,225,0.08)");
      primary.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = primary;
      context.beginPath();
      context.ellipse(92, 96, 74, 58, -0.28, 0, Math.PI * 2);
      context.fill();

      const secondary = context.createRadialGradient(118, 106, 8, 96, 96, 76);
      secondary.addColorStop(0, "rgba(255,255,255,0.76)");
      secondary.addColorStop(0.24, "rgba(210,228,255,0.36)");
      secondary.addColorStop(0.66, "rgba(153,184,232,0.06)");
      secondary.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = secondary;
      context.beginPath();
      context.ellipse(104, 96, 58, 44, 0.36, 0, Math.PI * 2);
      context.fill();

      return new this.THREE.CanvasTexture(canvas);
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
      return {
        core,
        emissive,
        halo,
        aura,
        shell,
        ring,
        nucleus,
        lobes: [
          new THREE.Color().setHSL(0.56 + familyShift + hueDrift * 0.12, 0.9, 0.63),
          new THREE.Color().setHSL(0.61 + familyShift + hueDrift * 0.14, 0.82, 0.65),
          new THREE.Color().setHSL(0.66 + familyShift + hueDrift * 0.14, 0.74, 0.66),
          new THREE.Color().setHSL(0.63 + familyShift + hueDrift * 0.1, 0.58, 0.72),
        ],
      };
    }

    buildNode(node) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.set(node.anchor.x, node.anchor.y, node.anchor.z);
      group.userData.modelId = node.id;
      const palette = this.buildOrbPalette(node);

      /* ── Core sphere — luminous instrument orb ── */
      const emissiveBase = node.tier === "flagship" ? 1.18 : node.tier === "secondary" ? 0.9 : 0.68;

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(node.size, 32, 32),
        new THREE.MeshStandardMaterial({
          color: palette.core,
          emissive: palette.emissive,
          emissiveIntensity: emissiveBase,
          roughness: 0.16,
          metalness: 0.1,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.56 : node.tier === "secondary" ? 0.48 : 0.4,
        }),
      );
      core.userData.modelId = node.id;
      group.add(core);

      const livingCoreGroup = new THREE.Group();
      livingCoreGroup.position.z = node.size * 0.12;
      const livingCoreTexture = this.livingCoreTexture || (this.livingCoreTexture = this.createLivingCoreTexture());
      const livingCoreConfigs = [
        { scaleX: 1.62, scaleY: 1.18, opacity: 0.28, offsetX: -0.08, offsetY: 0.03, speed: 0.34 },
        { scaleX: 1.34, scaleY: 1.48, opacity: 0.24, offsetX: 0.06, offsetY: -0.05, speed: 0.28 },
        { scaleX: 0.92, scaleY: 0.92, opacity: 0.18, offsetX: 0.02, offsetY: 0.06, speed: 0.22 },
      ];
      const livingCoreLayers = livingCoreConfigs.map((config, index) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: livingCoreTexture,
            color: index === 0 ? palette.emissive : index === 1 ? palette.ring : palette.shell,
            transparent: true,
            opacity: config.opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.scale.set(node.size * config.scaleX, node.size * config.scaleY, 1);
        sprite.position.set(node.size * config.offsetX, node.size * config.offsetY, 0);
        sprite.material.rotation = index * 0.6;
        livingCoreGroup.add(sprite);
        return {
          sprite,
          baseOpacity: config.opacity,
          baseScaleX: node.size * config.scaleX,
          baseScaleY: node.size * config.scaleY,
          baseOffsetX: node.size * config.offsetX,
          baseOffsetY: node.size * config.offsetY,
          speed: config.speed,
          phase: node.orbitPhase + index * 1.1,
        };
      });
      group.add(livingCoreGroup);

      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * (node.tier === "flagship" ? 2.55 : node.tier === "secondary" ? 2.1 : 1.72), 28, 28),
        new THREE.MeshBasicMaterial({
          color: palette.shell,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.16 : node.tier === "secondary" ? 0.12 : 0.08,
          blending: THREE.NormalBlending,
          depthWrite: false,
          side: THREE.BackSide,
        }),
      );
      group.add(shell);

      /* ── Nucleus — tight bright inner sprite echoing hero signal core ── */
      const nucleus = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.nucleusTexture || (this.nucleusTexture = this.createNucleusTexture()),
          color: palette.nucleus,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.1 : node.tier === "secondary" ? 0.08 : 0.06,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      nucleus.scale.setScalar(node.size * 1.64);
      nucleus.userData.modelId = node.id;
      group.add(nucleus);

      const lobeTexture = this.lobeTexture || (this.lobeTexture = this.createLobeTexture());
      const lobeConfigs = [
        { width: 2.45, height: 1.34, x: -0.08, y: 0.09, rotation: 0.3, speed: 0.58, amplitude: 0.09 },
        { width: 2.18, height: 1.48, x: 0.1, y: -0.06, rotation: -0.9, speed: 0.46, amplitude: 0.08 },
        { width: 2.28, height: 1.26, x: 0.06, y: 0.08, rotation: 1.16, speed: 0.5, amplitude: 0.07 },
      ];
      const lobeCount = node.tier === "flagship" ? 3 : node.tier === "secondary" ? 3 : 2;
      const lobes = lobeConfigs.slice(0, lobeCount).map((config, index) => {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: lobeTexture,
            color: palette.lobes[index],
            transparent: true,
            opacity: node.tier === "flagship" ? 0.36 : node.tier === "secondary" ? 0.28 : 0.18,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.scale.set(node.size * config.width * node.haloScale, node.size * config.height * node.haloScale, 1);
        sprite.position.set(node.size * config.x * node.haloScale, node.size * config.y * node.haloScale, 0);
        sprite.material.rotation = config.rotation;
        group.add(sprite);
        return {
          sprite,
          baseColor: palette.lobes[index].clone(),
          baseOpacity: sprite.material.opacity,
          baseWidth: node.size * config.width * node.haloScale,
          baseHeight: node.size * config.height * node.haloScale,
          baseX: node.size * config.x * node.haloScale,
          baseY: node.size * config.y * node.haloScale,
          rotation: config.rotation,
          speed: config.speed,
          amplitude: config.amplitude,
          phase: node.orbitPhase + index * 1.8,
        };
      });

      /* ── Primary halo — layered outer bloom ── */
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture || (this.glowTexture = this.createGlowTexture()),
          color: palette.halo,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.18 : node.tier === "secondary" ? 0.12 : 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.scale.setScalar(node.size * node.haloScale * 3.5);
      halo.userData.modelId = node.id;
      group.add(halo);

      /* ── Soft aura — ultra-wide subliminal depth glow (whisper layer) ── */
      const aura = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: palette.aura,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.028 : node.tier === "secondary" ? 0.02 : 0.012,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      aura.scale.setScalar(node.size * node.haloScale * 5.6);
      aura.userData.modelId = node.id;
      group.add(aura);

      const guideRing = new THREE.Mesh(
        new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 1.92 : node.tier === "secondary" ? 1.64 : 1.42), node.size * 0.022, 6, 56),
        new THREE.MeshBasicMaterial({
          color: palette.ring,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.18 : node.tier === "secondary" ? 0.14 : 0.1,
          depthWrite: false,
        }),
      );
      guideRing.rotation.x = 1.22;
      guideRing.rotation.z = -0.18;
      group.add(guideRing);

      /* ── Accent ring — inner instrument orbit ── */
      const accentRing = new THREE.Mesh(
        new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 2.6 : 2.0), node.size * 0.055, 10, 64),
        new THREE.MeshStandardMaterial({
          color: 0x000000,
          emissive: palette.ring,
          emissiveIntensity: node.tier === "flagship" ? 0.62 : node.tier === "secondary" ? 0.42 : 0.24,
          roughness: 0.4,
          metalness: 0.0,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.38 : node.tier === "secondary" ? 0.24 : 0.14,
        }),
      );
      accentRing.rotation.x = 1.0;
      accentRing.rotation.z = 0.2;
      group.add(accentRing);

      /* ── Orbit ring — hero-style wide ellipse (flagship + secondary only) ── */
      let orbitRing = null;
      if (node.tier !== "outer") {
        orbitRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 4.4 : 3.6), node.size * 0.03, 8, 64),
          new THREE.MeshBasicMaterial({
            color: palette.lobes[node.tier === "flagship" ? 1 : 2],
            transparent: true,
            opacity: node.tier === "flagship" ? 0.18 : 0.1,
          }),
        );
        orbitRing.rotation.x = 1.38;
        orbitRing.rotation.z = -0.28;
        group.add(orbitRing);
      }

      /* ── Focus lock ring — measurement-lock indicator (hidden until focused) ── */
      let focusRing = null;
      const addFocusRing = node.tier !== "outer" || this.nodes.length <= 20;
      if (addFocusRing) {
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
      this.labelLayer.appendChild(label);

      this.rootGroup.add(group);
      this.nodeLookup.set(node.id, {
        node,
        group,
        core,
        livingCoreGroup,
        livingCoreLayers,
        shell,
        nucleus,
        lobes,
        halo,
        aura,
        guideRing,
        accentRing,
        orbitRing,
        focusRing,
        metricBandGroup,
        metricBands,
        label,
        baseEmissiveIntensity: emissiveBase,
        baseCoreOpacity: core.material.opacity,
        baseNucleusOpacity: nucleus.material.opacity,
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

    onWheel(event) {
      event.preventDefault();
      this.shell.focus({ preventScroll: true });
      this.lastInteractionAt = performance.now();
      this.zoomVelocity = clamp(this.zoomVelocity + (event.deltaY * 0.0024), -0.95, 0.95);
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
        Array.from(this.nodeLookup.values()).map((entry) => entry.core),
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
        entry.group.position.x = entry.node.anchor.x
          + siriWaveA * (entry.node.tier === "flagship" ? 0.3 : entry.node.tier === "secondary" ? 0.2 : 0.16)
          + siriWaveB * 0.04;
        entry.group.position.y = entry.node.anchor.y
          + siriWaveB * (entry.node.tier === "flagship" ? 0.22 : entry.node.tier === "secondary" ? 0.15 : 0.12)
          + siriWaveC * 0.035;
        entry.group.position.z = entry.node.anchor.z
          + siriWaveC * (entry.node.tier === "outer" ? 0.22 : 0.14)
          + Math.sin(drift * 0.88 + entry.node.orbitPhase) * 0.04;
        entry.group.rotation.z = Math.sin(siriPhase * 0.42) * 0.08;
        entry.group.rotation.y = Math.cos(siriPhase * 0.36) * 0.06;

        const focused = this.focusId === entry.node.id;
        const hovered = this.hoverId === entry.node.id;
        const dimmed = Boolean(this.focusId) && !focused;

        /* ── Node breathing: subtle pulsing tied to CII ── */
        const breatheRate = 0.72 + entry.node.cii * 1.1;
        const breatheAmp = reducedMotion ? 0 : entry.node.tier === "flagship" ? 0.072 : entry.node.tier === "secondary" ? 0.05 : 0.038;
        const breathe = 1.0 + Math.sin(slowTime * breatheRate + entry.node.orbitPhase) * breatheAmp;

        const targetScale = (focused ? 1.42 : hovered ? 1.22 : dimmed ? 0.76 : 1) * breathe;
        entry.group.scale.setScalar(lerp(entry.group.scale.x, targetScale, 0.12));

        /* ── Emissive intensity breathing — boosted on focus/hover ── */
        const focusBoost = focused ? 0.86 : hovered ? 0.3 : 0;
        const emissivePulse = entry.baseEmissiveIntensity + focusBoost +
          (reducedMotion ? 0 : Math.sin(slowTime * breatheRate * 0.8 + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.26 : entry.node.tier === "secondary" ? 0.18 : 0.1));
        entry.core.material.emissiveIntensity = lerp(entry.core.material.emissiveIntensity, emissivePulse, 0.08);

        if (entry.livingCoreLayers) {
          entry.livingCoreLayers.forEach((layer, index) => {
            const layerWave = reducedMotion ? 0 : Math.sin(slowTime * (layer.speed + entry.node.cii * 0.18) + layer.phase);
            const crossWave = reducedMotion ? 0 : Math.cos(slowTime * (layer.speed * 0.72 + 0.08) + layer.phase);
            const focusLayerBoost = focused ? 1 + focusReveal * 0.22 : hovered ? 1.06 : dimmed ? 0.76 : 1;
            layer.sprite.material.opacity = lerp(
              layer.sprite.material.opacity,
              (focused ? layer.baseOpacity * 1.9 : hovered ? layer.baseOpacity * 1.2 : dimmed ? layer.baseOpacity * 0.36 : layer.baseOpacity) * focusLayerBoost,
              0.1,
            );
            layer.sprite.position.x = reducedMotion
              ? layer.baseOffsetX
              : layer.baseOffsetX + layerWave * entry.node.size * (0.12 + index * 0.02);
            layer.sprite.position.y = reducedMotion
              ? layer.baseOffsetY
              : layer.baseOffsetY + crossWave * entry.node.size * (0.1 + index * 0.015);
            layer.sprite.scale.set(
              layer.baseScaleX * focusLayerBoost * (1 + layerWave * 0.08),
              layer.baseScaleY * focusLayerBoost * (1 - crossWave * 0.06),
              1,
            );
            if (!reducedMotion) {
              layer.sprite.material.rotation += layer.speed * 0.0024;
            }
          });
        }

        /* ── Nucleus brightness ── */
        if (entry.nucleus) {
          entry.nucleus.material.opacity = lerp(
            entry.nucleus.material.opacity,
            focused ? 0.16 : hovered ? 0.11 : dimmed ? 0.04 : entry.baseNucleusOpacity,
            0.12,
          );
        }

        entry.core.material.opacity = lerp(
          entry.core.material.opacity,
          focused ? Math.min(0.7, entry.baseCoreOpacity + 0.16) : hovered ? Math.min(0.58, entry.baseCoreOpacity + 0.08) : dimmed ? 0.16 : entry.baseCoreOpacity,
          0.1,
        );

        if (entry.shell) {
          entry.shell.material.opacity = lerp(
            entry.shell.material.opacity,
            focused ? 0.11 : hovered ? 0.1 : dimmed ? 0.02 :
              entry.node.tier === "flagship" ? 0.08 : entry.node.tier === "secondary" ? 0.06 : 0.04,
            0.08,
          );
          const shellScale = 1 + (reducedMotion ? 0 : Math.sin(slowTime * 0.72 + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.04 : 0.025));
          entry.shell.scale.setScalar(shellScale);
        }

        if (entry.lobes) {
          entry.lobes.forEach((lobe, index) => {
            const wave = reducedMotion ? 0 : Math.sin(slowTime * (lobe.speed + entry.node.cii * 0.14) + lobe.phase);
            const hueNudge = reducedMotion ? 0 : Math.sin(slowTime * 0.28 + lobe.phase + index) * 0.01;
            lobe.sprite.material.color.copy(lobe.baseColor).offsetHSL(hueNudge, 0, wave * 0.03);
            lobe.sprite.material.opacity = lerp(
              lobe.sprite.material.opacity,
              (focused ? 0.34 : hovered ? 0.24 : dimmed ? 0.03 : lobe.baseOpacity) * (0.92 + wave * 0.1),
              0.08,
            );
            lobe.sprite.position.x = reducedMotion ? lobe.baseX : lobe.baseX + Math.sin(slowTime * lobe.speed + lobe.phase) * lobe.baseWidth * lobe.amplitude * 0.08;
            lobe.sprite.position.y = reducedMotion ? lobe.baseY : lobe.baseY + Math.cos(slowTime * (lobe.speed * 0.86) + lobe.phase) * lobe.baseHeight * lobe.amplitude * 0.07;
            lobe.sprite.scale.set(
              lobe.baseWidth * (1 + wave * 0.03),
              lobe.baseHeight * (1 - wave * 0.025),
              1,
            );
            lobe.sprite.material.rotation = reducedMotion ? lobe.rotation : lobe.rotation + slowTime * lobe.speed * 0.06;
          });
        }

        /* ── Primary halo opacity ── */
        entry.halo.material.opacity = lerp(
          entry.halo.material.opacity,
          focused ? 0.28 : hovered ? 0.18 : dimmed ? 0.02 :
            entry.node.tier === "flagship" ? 0.18 : entry.node.tier === "secondary" ? 0.12 : 0.08,
          0.12,
        );

        /* ── Soft aura opacity (whisper layer — subliminal transitions) ── */
        if (entry.aura) {
          entry.aura.material.opacity = lerp(
            entry.aura.material.opacity,
            focused ? 0.04 : hovered ? 0.028 : dimmed ? 0.004 :
              entry.node.tier === "flagship" ? 0.028 : entry.node.tier === "secondary" ? 0.02 : 0.012,
            0.06,
          );
        }

        if (entry.guideRing) {
          entry.guideRing.material.opacity = lerp(
            entry.guideRing.material.opacity,
            focused ? 0.26 : hovered ? 0.18 : dimmed ? 0.03 :
              entry.node.tier === "flagship" ? 0.18 : entry.node.tier === "secondary" ? 0.14 : 0.1,
            0.09,
          );
          entry.guideRing.rotation.y += focused ? 0.014 : 0.006;
          entry.guideRing.rotation.z -= focused ? 0.006 : 0.002;
        }

        /* ── Focus lock ring — measurement-lock indicator ── */
        if (entry.focusRing) {
          entry.focusRing.material.opacity = lerp(
            entry.focusRing.material.opacity,
            focused ? 0.58 : 0,
            0.06,
          );
          if (focused) entry.focusRing.rotation.z -= 0.008;
        }

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

        /* ── Accent ring opacity + rotation ── */
        entry.accentRing.material.opacity = lerp(
          entry.accentRing.material.opacity,
            focused ? 0.44 : hovered ? 0.28 : dimmed ? 0.05 :
            entry.node.tier === "flagship" ? 0.22 : entry.node.tier === "secondary" ? 0.16 : 0.1,
          0.1,
        );
        const ringSpeed = entry.node.tier === "flagship" ? 0.15 : 0.08;
        entry.accentRing.rotation.y += ringSpeed * 0.016; /* ~1/60s step */
        entry.accentRing.rotation.z += ringSpeed * 0.007;

        /* ── Orbit ring opacity + slow rotation ── */
        if (entry.orbitRing) {
          entry.orbitRing.material.opacity = lerp(
            entry.orbitRing.material.opacity,
            focused ? 0.18 : hovered ? 0.12 : dimmed ? 0.03 :
              entry.node.tier === "flagship" ? 0.12 : 0.08,
            0.08,
          );
          const orbitSpeed = entry.node.tier === "flagship" ? 0.028 : 0.018;
          entry.orbitRing.rotation.y += orbitSpeed * 0.016;
          entry.orbitRing.rotation.z -= orbitSpeed * 0.004;
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
          guide.line.material.opacity = guide.passive ? (this.modes.compare ? 0.12 : 0.04) : (this.focusId ? 0.56 : 0.16);
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
          ? 0.06
          : this.hoverId === trail.id || this.focusId === trail.id
          ? 0.24
          : entry.node.tier === "flagship"
          ? 0.18
          : 0.1;
      });
    }

    updateCamera(time) {
      this.zoomVelocity *= this.isActive ? 0.84 : 0.78;
      this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
      this.zoomCurrent = lerp(this.zoomCurrent, this.zoomTarget, 0.08);

      const idleX = motionQuery.matches ? 0 : Math.sin(time * 0.00008) * 0.18;
      const idleY = motionQuery.matches ? 0 : Math.cos(time * 0.00006) * 0.07;
      const activityAlpha = clamp((performance.now() - this.lastInteractionAt) < 2200 ? 1 : 0.35, 0.35, 1);
      const focusAlpha = this.isActive ? 1 : 0.7;
      const userAlpha = activityAlpha * focusAlpha;
      const yaw = idleX + (this.pointerTarget.x * 0.32 + this.keyTarget.x * 0.52) * userAlpha;
      const pitch = idleY + (this.pointerTarget.y * 0.16 + this.keyTarget.y * 0.3) * userAlpha;

      /* ── Smoother camera fly-to on focus ── */
      if (this.focusId && this.nodeLookup.has(this.focusId)) {
        const focusEntry = this.nodeLookup.get(this.focusId);
        const focusPos = focusEntry.group.position.clone().multiplyScalar(0.12);
        this.focusTarget.lerp(focusPos, 0.028);
      } else {
        this.focusTarget.lerp(new this.THREE.Vector3(0, 0, 0), 0.025);
      }

      const zoomNorm = (this.zoomCurrent - this.zoomRange.min) / (this.zoomRange.max - this.zoomRange.min);
      const desired = new this.THREE.Vector3(
        Math.sin(yaw) * lerp(2.7, 3.8, zoomNorm),
        1.2 + pitch * lerp(4.8, 6.35, zoomNorm),
        this.zoomCurrent + Math.cos(yaw * 1.18) * 1.15,
      );
      this.camera.position.lerp(desired, 0.032); /* slow and precise for instrument feel */
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
        const width = 118 + entry.node.label.length * 4.4;
        candidates.push({ entry, x, y, width, height: 36, priority: focusBoost, depth: position.z, isFocused: isFocused });
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

    animate(time) {
      const slowTime = time * 0.001;

      this.updateHover();
      this.updateNodes(time);
      this.updateStars(time);
      this.updateDust(time);
      this.updateNearDust(time);
      this.updateGuides(time);
      this.updateTrails();
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
      if (this.bloomPass && this.bloomImpulse > 0) {
        this.bloomImpulse *= 0.94;
        if (this.bloomImpulse < 0.005) this.bloomImpulse = 0;
        this.bloomPass.strength = this.bloomBase + this.bloomImpulse * 0.18;
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
      this.renderer.domElement.removeEventListener("wheel", this.onWheel);
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
      this.onWheel = this.onWheel.bind(this);
      this.onFocus = this.onFocus.bind(this);
      this.onBlur = this.onBlur.bind(this);
      this.onResize = this.resize.bind(this);
      this.shell.addEventListener("pointermove", this.onPointerMove);
      this.shell.addEventListener("pointerleave", this.onPointerLeave);
      this.shell.addEventListener("pointerdown", this.onPointerDown);
      this.shell.addEventListener("wheel", this.onWheel, { passive: false });
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
          ? `Field active${this.reducedMotion ? " · reduced motion" : " · fallback mode"} · wheel zoom`
          : `Field idle${this.reducedMotion ? " · reduced motion" : " · fallback mode"} · wheel zoom`;
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

    onWheel(event) {
      event.preventDefault();
      this.shell.focus({ preventScroll: true });
      this.zoomVelocity = clamp(this.zoomVelocity + (event.deltaY * 0.0009), -0.08, 0.08);
      if (this.reducedMotion) {
        this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
        this.zoomCurrent = this.zoomTarget;
        this.zoomVelocity = 0;
        this.layers.forEach((layer, index) => {
          const depth = 1 + index * 0.06;
          layer.style.transform = `scale(${this.zoomCurrent * depth})`;
        });
      }
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
            <span class="observatory-fallback-label-name">${node.label}</span>
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
      this.shell.removeEventListener("wheel", this.onWheel);
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
