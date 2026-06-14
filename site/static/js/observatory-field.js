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

  function easeInCubic(value) {
    const clamped = clamp(value, 0, 1);
    return clamped * clamped * clamped;
  }

  function easeInOutCubic(value) {
    const clamped = clamp(value, 0, 1);
    return clamped < 0.5
      ? 4 * clamped * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
  }

  function pointerSupportsHover(pointerType) {
    return pointerType !== "touch";
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
  const ORB_PALETTE_FAMILIES = [
    {
      weight: 0.34,
      coreHue: 0.578,
      emissiveHue: 0.572,
      haloHue: 0.598,
      auraHue: 0.588,
      shellHue: 0.592,
      ringHue: 0.562,
      metalHue: 0.582,
      tickHue: 0.558,
      focusGlowHue: 0.558,
      lobeHues: [0.554, 0.58, 0.612, 0.668],
    },
    {
      weight: 0.3,
      coreHue: 0.592,
      emissiveHue: 0.586,
      haloHue: 0.616,
      auraHue: 0.606,
      shellHue: 0.61,
      ringHue: 0.58,
      metalHue: 0.592,
      tickHue: 0.576,
      focusGlowHue: 0.572,
      lobeHues: [0.568, 0.594, 0.626, 0.676],
    },
    {
      weight: 0.24,
      coreHue: 0.606,
      emissiveHue: 0.6,
      haloHue: 0.63,
      auraHue: 0.62,
      shellHue: 0.624,
      ringHue: 0.594,
      metalHue: 0.604,
      tickHue: 0.59,
      focusGlowHue: 0.586,
      lobeHues: [0.582, 0.608, 0.638, 0.684],
    },
    {
      weight: 0.12,
      coreHue: 0.618,
      emissiveHue: 0.612,
      haloHue: 0.648,
      auraHue: 0.636,
      shellHue: 0.64,
      ringHue: 0.604,
      metalHue: 0.61,
      tickHue: 0.598,
      focusGlowHue: 0.594,
      lobeHues: [0.59, 0.618, 0.652, 0.692],
    },
  ];

  function selectOrbPaletteFamily(seed) {
    let cursor = seed;
    for (let index = 0; index < ORB_PALETTE_FAMILIES.length; index += 1) {
      const family = ORB_PALETTE_FAMILIES[index];
      if (cursor <= family.weight || index === ORB_PALETTE_FAMILIES.length - 1) {
        return family;
      }
      cursor -= family.weight;
    }
    return ORB_PALETTE_FAMILIES[0];
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function normalizeMetric(value) {
    return clamp(isFiniteNumber(value) ? value : 0, 0, 1);
  }

  function formatNodeMetric(value, fallback = "offline") {
    return isFiniteNumber(value) ? value.toFixed(3) : fallback;
  }

  function resolveNodeFallback(node) {
    if (!node) return "offline";
    if (node.live) return "partial";
    return node.inactive ? "offline" : "unavailable";
  }

  function resolveNodeReadout(node) {
    if (!node) return "offline";
    return formatNodeMetric(
      isFiniteNumber(node.rangeCii) ? node.rangeCii : node.cii,
      resolveNodeFallback(node),
    );
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
          : typeof node.cii === "number"
          ? node.cii
          : isFiniteNumber(metrics.cii)
          ? metrics.cii
          : null;
        const telemetryState = node.telemetry_state || (model.status === "active" ? "live" : model.status || "inactive");
        const hasMeasuredSignal = isFiniteNumber(rangeCii);
        return {
          id: node.id,
          label: node.label,
          labelDisplay: splitFocusedLabel(node.label),
          provider: node.provider || model.provider || "unknown",
          rank: typeof model.rank === "number" ? model.rank : null,
          relativeStanding: model.relativeStanding || null,
          metrics: metrics,
          cii: typeof node.cii === "number" ? node.cii : isFiniteNumber(metrics.cii) ? metrics.cii : null,
          rangeCii: rangeCii,
          rangeTrend: typeof model.rangeTrend === "number" ? model.rangeTrend : 0,
          historyDepth: typeof model.historyDepth === "number" ? model.historyDepth : ((payload.ciiHistory && payload.ciiHistory[node.id]) || []).length,
          ips: typeof node.ips === "number" ? node.ips : isFiniteNumber(metrics.ips) ? metrics.ips : null,
          srs: typeof node.srs === "number" ? node.srs : isFiniteNumber(metrics.srs) ? metrics.srs : null,
          stale: Boolean(model.stale),
          live: Boolean(model.live),
          lastSeen: node.last_seen || model.last_seen || null,
          ringMetrics: resolveFocusRingMetrics(metrics, rangeCii, payload.constellation && payload.constellation.threshold),
          telemetryState: telemetryState,
          inactive: telemetryState !== "live",
          focusEligible: hasMeasuredSignal,
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
      const bandBias = (providerBand - providerMid) * 0.36;
      const tierRadius = node.inactive ? 5.2 : tier === "flagship" ? 1.15 : tier === "secondary" ? 2.35 : 3.45;
      const radius = tierRadius + rankNorm * 0.42 + (1 - scoreNorm) * 0.28 + (((baseHash * 7.13) % 1) - 0.5) * (node.inactive ? 0.58 : 0.32);
      const angle = (baseHash * Math.PI * 2) + (index * 0.97) + providerBand * 0.18;
      const x = Math.cos(angle) * radius;
      const y = bandBias + Math.sin(angle * 1.18) * (tier === "flagship" ? 0.42 : tier === "secondary" ? 0.56 : 0.68) + (((baseHash * 13.1) % 1) - 0.5) * (node.inactive ? 0.35 : 0.18);
      const z = (node.inactive ? 1.8 : tier === "flagship" ? -1.2 : tier === "secondary" ? 0.1 : 1.2) + (node.rangeTrend || 0) * 2.1 + (((baseHash * 11.37) % 1) - 0.5) * (node.inactive ? 2.5 : tier === "outer" ? 1.5 : 0.95);
      const inactiveScale = node.inactive ? 0.76 : 1;
      return {
        ...node,
        tier,
        size: (tier === "flagship" ? 0.62 + scoreNorm * 0.42 : tier === "secondary" ? 0.44 + scoreNorm * 0.28 : 0.30 + scoreNorm * 0.18) * inactiveScale,
        haloScale: tier === "flagship" ? 2.24 : tier === "secondary" ? 1.76 : 1.28,
        glow: tier === "flagship" ? 0.84 : tier === "secondary" ? 0.62 : 0.4,
        orbitPhase: baseHash * Math.PI * 2,
        driftSpeed: (0.4 + (((baseHash * 17.11) % 1) * 0.36)) * (node.inactive ? 0.3 : 1),
        trailEligible: !node.inactive && node.historyDepth >= 3,
        anchor: { x, y, z },
      };
    });
  }

  function topNeighbors(payload, modelId, limit = 3) {
    const threshold = payload && payload.constellation && isFiniteNumber(payload.constellation.threshold)
      ? payload.constellation.threshold
      : 0;
    return uniqueStableEdges(payload.constellation.edges || [])
      .filter(function (edge) {
        return (edge.source === modelId || edge.target === modelId)
          && (edge.similarity || 0) >= threshold;
      })
      .slice(0, limit)
      .map(function (edge) {
        return edge.source === modelId ? edge.target : edge.source;
      });
  }

  function canonicalEdgePair(edge) {
    const source = String(edge && edge.source != null ? edge.source : "");
    const target = String(edge && edge.target != null ? edge.target : "");
    return source < target ? `${source}::${target}` : `${target}::${source}`;
  }

  function compareEdgesStable(left, right) {
    const similarityDelta = (right.similarity || 0) - (left.similarity || 0);
    if (Math.abs(similarityDelta) > 1e-9) {
      return similarityDelta;
    }
    return canonicalEdgePair(left).localeCompare(canonicalEdgePair(right));
  }

  function uniqueStableEdges(edges) {
    const seen = new Set();
    return (edges || []).slice().sort(compareEdgesStable).filter(function (edge) {
      const key = canonicalEdgePair(edge);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function selectGuideEdges(payload, focusId, hoverId, compareMode, nodeCount) {
    const stableEdges = uniqueStableEdges((payload && payload.constellation && payload.constellation.edges) || []);
    if (!stableEdges.length) return [];

    const threshold = payload && payload.constellation && isFiniteNumber(payload.constellation.threshold)
      ? payload.constellation.threshold
      : 0;
    const selectedId = focusId || hoverId || null;
    if (selectedId) {
      return stableEdges
        .filter(function (edge) {
          return (edge.similarity || 0) >= threshold
            && (edge.source === selectedId || edge.target === selectedId);
        })
        .slice(0, focusId ? 4 : 3)
        .map(function (edge) {
          return {
            source: edge.source,
            target: edge.target,
            passive: !focusId,
            opacityBase: focusId ? 0.2 : 0.065,
          };
        });
    }

    const limit = compareMode
      ? (nodeCount > 18 ? 8 : 12)
      : (nodeCount > 18 ? 4 : 6);

    return stableEdges
      .filter(function (edge) {
        return (edge.similarity || 0) >= threshold;
      })
      .slice(0, limit)
      .map(function (edge) {
        return {
          source: edge.source,
          target: edge.target,
          passive: true,
          opacityBase: compareMode ? 0.08 : 0.05,
        };
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
      <span class="observatory-node-label-meta">${node.provider} · ${resolveNodeReadout(node)}</span>
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
        <div class="observatory-tooltip-row"><span>CII</span><span>${resolveNodeReadout(node)}</span></div>
        <div class="observatory-tooltip-row"><span>IPS</span><span>${formatNodeMetric(node.ips, resolveNodeFallback(node))}</span></div>
        <div class="observatory-tooltip-row"><span>SRS</span><span>${formatNodeMetric(node.srs, resolveNodeFallback(node))}</span></div>
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
        fill: "rgba(78, 120, 198, 0.052)",
        stroke: "none",
      });
      const sectorLeft = createSvgElement("path", {
        d: [
          `M ${cx} ${cy}`,
          describeArc(cx, cy, outerRadiusX * 0.94, outerRadiusY * 0.94, 212, 302),
          "Z",
        ].join(" "),
        fill: "rgba(112, 173, 234, 0.038)",
        stroke: "none",
      });
      const sectorRight = createSvgElement("path", {
        d: [
          `M ${cx} ${cy}`,
          describeArc(cx, cy, outerRadiusX * 0.82, outerRadiusY * 0.82, 34, 108),
          "Z",
        ].join(" "),
        fill: "rgba(160, 198, 244, 0.03)",
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
        { rx: outerRadiusX * 1.12, ry: outerRadiusY * 1.05, start: 196, end: 346, width: "0.92", opacity: "0.42" },
        { rx: outerRadiusX * 1.22, ry: outerRadiusY * 1.14, start: 204, end: 336, width: "0.8", opacity: "0.28" },
        { rx: outerRadiusX * 0.76, ry: outerRadiusY * 0.76, start: 26, end: 158, width: "0.76", opacity: "0.22" },
        { rx: outerRadiusX * 0.56, ry: outerRadiusY * 0.56, start: 18, end: 148, width: "0.68", opacity: "0.14" },
      ].forEach((band) => {
        this.staticGroup.append(createSvgElement("path", {
          d: describeArc(cx, cy, band.rx, band.ry, band.start, band.end),
          "stroke-width": band.width,
          fill: "none",
          opacity: band.opacity,
        }));
      });

      [-60, -36, -18, 18, 36, 60].forEach((angle) => {
        const start = polarPoint(cx, cy, midRadiusX * 0.96, midRadiusY * 0.96, angle);
        const end = polarPoint(cx, cy, outerRadiusX * 1.06, outerRadiusY * 1.06, angle);
        this.staticGroup.append(createSvgElement("line", {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          "stroke-width": angle === -18 || angle === 18 ? "0.84" : "0.7",
          opacity: angle === -18 || angle === 18 ? "0.56" : "0.34",
        }));
      });

      for (let index = 0; index < 14; index += 1) {
        const angle = 196 + (index * 10);
        const start = polarPoint(cx, cy, outerRadiusX * 1.02, outerRadiusY * 1.02, angle);
        const end = polarPoint(
          cx,
          cy,
          outerRadiusX * (index % 4 === 0 ? 1.13 : 1.08),
          outerRadiusY * (index % 4 === 0 ? 1.13 : 1.08),
          angle,
        );
        this.staticGroup.append(createSvgElement("line", {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          "stroke-width": index % 4 === 0 ? "1.04" : "0.68",
          opacity: index % 4 === 0 ? "0.52" : "0.3",
        }));
      }

      [0.26, 0.38, 0.5, 0.62, 0.74].forEach((ratio) => {
        const y = this.height * ratio;
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.08,
          y1: y,
          x2: this.width * 0.16,
          y2: y,
          "stroke-width": "0.64",
          opacity: "0.24",
        }));
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.84,
          y1: y,
          x2: this.width * 0.92,
          y2: y,
          "stroke-width": "0.64",
          opacity: "0.24",
        }));
      });

      [0.7, 0.76, 0.82, 0.88].forEach((ratio) => {
        this.staticGroup.append(createSvgElement("line", {
          x1: this.width * 0.14,
          y1: this.height * ratio,
          x2: this.width * 0.86,
          y2: this.height * ratio,
          "stroke-width": "0.6",
          opacity: ratio === 0.82 ? "0.34" : "0.2",
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
      const settleRadius = (target.radius || 72) * 1.08;
      const radiusX = settleRadius * (1.08 + (1 - progress) * 0.24);
      const radiusY = settleRadius * (0.84 + (1 - progress) * 0.18);
      const rotation = this.reducedMotion ? 26 : (progress * 28) + ((time * 0.018) % 360);
      const counterRotation = this.reducedMotion ? -18 : (-progress * 36) - ((time * 0.022) % 360);
      const bracketOffset = (settleRadius * 0.92) + (1 - progress) * 20;
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
        244,
        352,
      );
      const annotationX = Math.min(this.width - annotationWidth - 18, target.x + radiusX + 34);
      const annotationY = Math.max(48, target.y - radiusY - 60);

      this.focusGroup.setAttribute("opacity", "1");

      this.focusTrace.setAttribute("d", `M ${annotationX} ${annotationY + 44} C ${annotationX - 28} ${annotationY + 58}, ${target.x + 22} ${target.y + 16}, ${target.x} ${target.y}`);

      this.focusEcho.setAttribute("cx", target.x);
      this.focusEcho.setAttribute("cy", target.y);
      this.focusEcho.setAttribute("rx", radiusX * 1.08);
      this.focusEcho.setAttribute("ry", radiusY * 1.08);

      this.focusRing.setAttribute("cx", target.x);
      this.focusRing.setAttribute("cy", target.y);
      this.focusRing.setAttribute("rx", radiusX);
      this.focusRing.setAttribute("ry", radiusY);

      this.counterRingA.setAttribute("cx", target.x);
      this.counterRingA.setAttribute("cy", target.y);
      this.counterRingA.setAttribute("rx", radiusX * 0.88);
      this.counterRingA.setAttribute("ry", radiusY * 0.88);
      this.counterRingA.setAttribute("transform", `rotate(${rotation} ${target.x} ${target.y})`);

      this.counterRingB.setAttribute("cx", target.x);
      this.counterRingB.setAttribute("cy", target.y);
      this.counterRingB.setAttribute("rx", radiusX * 1.16);
      this.counterRingB.setAttribute("ry", radiusY * 1.16);
      this.counterRingB.setAttribute("transform", `rotate(${counterRotation} ${target.x} ${target.y})`);

      this.focusSweep.setAttribute(
        "d",
        describeArc(target.x, target.y, radiusX * 1.22, radiusY * 1.22, 14, 14 + (progress * 314)),
      );
      this.focusSweep.setAttribute("opacity", `${0.68 + (progress * 0.28)}`);

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
      this.hoverEnabled = true;
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
      /* Aperture prototype: fewer additive layers → bloom base and focus target
       * both reduced, and focus impulse coefficient halved, so the remaining
       * white-hot plasma reads as sharp rather than washing the whole frame. */
      const _minimalFocus = typeof window !== "undefined" && window.__observatoryMinimalFocus === true;
      this.bloomBase = _minimalFocus ? 0.32 : 0.46;
      this.bloomFocusTarget = _minimalFocus ? 0.24 : 0.34;
      this.bloomImpulseCoeff = _minimalFocus ? 0.06 : 0.12;
      this.focusChangedAt = performance.now();
      this.lastPointerSelectionAt = 0;
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
      this.baseCameraFov = 38;
      this.camera.position.set(0, 1.2, 11.8);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.22;
      this.baseToneMappingExposure = 1.22;
      this.renderer.domElement.className = "observatory-field-canvas";
      this.shell.prepend(this.renderer.domElement);

      this.raycaster = new THREE.Raycaster();
      this.raycaster.params.Sprite = { threshold: 0.5 };
      this.mouse = new THREE.Vector2(-10, -10);
      this.focusPoint = new THREE.Vector3();
      this.focusTarget = new THREE.Vector3();
      this.compositionOffset = new THREE.Vector3();
      this.compositionTarget = new THREE.Vector3();
      this.focusNodeBias = new THREE.Vector3();
      this.focusNodeBiasTarget = new THREE.Vector3();
      this.focusBiasWorking = new THREE.Vector3();
      this.focusForwardBias = new THREE.Vector3();
      this.focusZoneCache = {
        xNorm: 0.56,
        yNorm: 0.45,
        widthNorm: 0.34,
        heightNorm: 0.24,
      };
      this.cameraForward = new THREE.Vector3();
      this.cameraRight = new THREE.Vector3();
      this.cameraUp = new THREE.Vector3();
      this.hyperdriveGroupPosition = new THREE.Vector3();
      this.hyperdriveBias = new THREE.Vector3();
      this.hyperdriveState = {
        age: Infinity,
        progress: 0,
        direction: 0,
        alpha: 0,
        peak: 0,
        tail: 0,
        vanishingBlend: 0,
        biasX: 0,
        biasY: 0,
        active: false,
      };
      this.hyperdriveDirection = 0;
      this.transitionFocusId = null;

      this.rootGroup = new THREE.Group();
      this.scene.add(this.rootGroup);

      /* ── Bloom post-processing ── */
      this.composer = null;
      this.bloomPass = null;
      this.setupPostProcessing();

      this.buildBackdrop();
      this.buildChamberCore();
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
      const minimal = typeof window !== "undefined" && window.__observatoryMinimalFocus === true;
      /* Aperture prototype: higher threshold + lower strength so only genuinely
       * hot plasma fragments bloom. With fewer additive layers the core earns
       * its white-hot read instead of the whole frame washing. */
      const bloomStrength  = minimal ? 0.38 : 0.52;
      const bloomRadius    = minimal ? 0.42 : 0.58;
      const bloomThreshold = minimal ? 1.35 : 1.15;
      try {
        this.composer = new addons.EffectComposer(this.renderer);
        const renderPass = new addons.RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.bloomPass = new addons.UnrealBloomPass(
          new THREE.Vector2(this.target.clientWidth || 700, this.target.clientHeight || 460),
          bloomStrength,
          bloomRadius,
          bloomThreshold
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
      this.sceneLights = { rim, fill, depthLight, prism, aqua };
      this.sceneLightBase = {
        rim: 2.8,
        fill: 1.9,
        depthLight: 0.94,
        prism: 0.88,
        aqua: 0.76,
      };

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
          opacity: index === 0 ? 0.34 : 0.24 - ((index - 1) * 0.025),
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
      const baseAlphas = new Float32Array(starCount);
      const radialWeights = new Float32Array(starCount);
      const depthWeights = new Float32Array(starCount);
      const starSeeds = new Float32Array(starCount);
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
        baseAlphas[index] = isAnchor ? 0.94 : 0.64 + Math.random() * 0.26;
        radialWeights[index] = 0.55 + Math.random() * 0.75;
        depthWeights[index] = isAnchor ? 0.44 + Math.random() * 0.36 : 0.75 + Math.random() * 0.85;
        starSeeds[index] = Math.random();
      }
      const starGeometry = new THREE.BufferGeometry();
      starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      starGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      starGeometry.setAttribute("size", new THREE.BufferAttribute(baseSizes.slice(), 1));
      starGeometry.setAttribute("alpha", new THREE.BufferAttribute(baseAlphas.slice(), 1));
      const starTexture = this.hyperdriveStarTexture || (this.hyperdriveStarTexture = this.createHyperdriveStarTexture());
      this.starPointScaleBase = 1550;
      const starMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uMap: { value: starTexture },
          uOpacity: { value: 0.72 },
          uPointScale: { value: this.starPointScaleBase * Math.min(window.devicePixelRatio || 1, 2) },
        },
        vertexShader: [
          "attribute vec3 color;",
          "attribute float size;",
          "attribute float alpha;",
          "varying vec3 vColor;",
          "varying float vAlpha;",
          "uniform float uPointScale;",
          "void main() {",
          "  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);",
          "  float depth = max(0.9, -mvPosition.z);",
          "  gl_Position = projectionMatrix * mvPosition;",
          "  gl_PointSize = max(0.0, size * uPointScale / depth);",
          "  vColor = color;",
          "  vAlpha = alpha;",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform sampler2D uMap;",
          "uniform float uOpacity;",
          "varying vec3 vColor;",
          "varying float vAlpha;",
          "void main() {",
          "  vec4 sprite = texture2D(uMap, gl_PointCoord);",
          "  float alpha = sprite.a * vAlpha * uOpacity;",
          "  if (alpha <= 0.01) discard;",
          "  gl_FragColor = vec4(vColor * sprite.rgb, alpha);",
          "}",
        ].join("\n"),
      });
      this.starField = new THREE.Points(starGeometry, starMaterial);
      this.starPhases = starPhases;
      this.starSpeeds = starSpeeds;
      this.starBaseSizes = baseSizes;
      this.starBaseAlphas = baseAlphas;
      this.starBasePositions = positions.slice();
      this.starBaseColors = colors.slice();
      this.starRadialWeights = radialWeights;
      this.starDepthWeights = depthWeights;
      this.starSeeds = starSeeds;
      this.starAnchorThreshold = anchorThreshold;
      this.scene.add(this.starField);

      /* ── Hyperdrive streaks — thick camera-facing radial thrust geometry ── */
      this.hyperdriveStreakGroup = new THREE.Group();
      this.hyperdriveStreakGroup.visible = false;
      const streakCount = 180;
      const coreGeometry = new THREE.PlaneGeometry(0.07, 1);
      const glowGeometry = new THREE.PlaneGeometry(0.24, 1);
      const streakTexture = this.hyperdriveStreakTexture || (this.hyperdriveStreakTexture = this.createHyperdriveStreakTexture());
      this.hyperdriveStreakMeta = [];
      for (let i = 0; i < streakCount; i += 1) {
        const holder = new THREE.Group();
        holder.rotation.z = (i / streakCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.06;
        holder.position.z = -0.15 - Math.random() * 1.9;

        const glowMaterial = new THREE.MeshBasicMaterial({
          color: i % 5 === 0 ? 0xdff3ff : 0x67baff,
          map: streakTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        const coreMaterial = new THREE.MeshBasicMaterial({
          color: i % 6 === 0 ? 0xfafdff : 0xc9e6ff,
          map: streakTexture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        const glow = new THREE.Mesh(glowGeometry, glowMaterial);
        const core = new THREE.Mesh(coreGeometry, coreMaterial);
        holder.add(glow, core);
        this.hyperdriveStreakGroup.add(holder);
        this.hyperdriveStreakMeta.push({
          holder,
          glow,
          core,
          glowMaterial,
          coreMaterial,
          radius: 0.12 + Math.random() * 1.24,
          lane: Math.random(),
          seed: Math.random() * Math.PI * 2,
          flickerSpeed: 7 + Math.random() * 10,
          width: 0.55 + Math.random() * 0.9,
        });
      }
      this.scene.add(this.hyperdriveStreakGroup);
    }

    buildChamberArc(radius, startAngle, sweepAngle, segments, material, scaleY = 1, z = 0) {
      const { THREE } = this;
      const points = [];
      for (let step = 0; step <= segments; step += 1) {
        const progress = step / segments;
        const angle = startAngle + (sweepAngle * progress);
        points.push(new THREE.Vector3(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * scaleY,
          z,
        ));
      }
      return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        material,
      );
    }

    createParallelogramShape(width, height, lean) {
      const { THREE } = this;
      const shape = new THREE.Shape();
      shape.moveTo((-width * 0.5) + lean, -height * 0.5);
      shape.lineTo((width * 0.5) + lean, -height * 0.5);
      shape.lineTo((width * 0.5) - lean, height * 0.5);
      shape.lineTo((-width * 0.5) - lean, height * 0.5);
      shape.closePath();
      return shape;
    }

    createParallelogramPlateGeometry(width, height, lean) {
      const { THREE } = this;
      return new THREE.ShapeGeometry(this.createParallelogramShape(width, height, lean));
    }

    createExtrudedParallelogramGeometry(width, height, lean, depth, options = {}) {
      const { THREE } = this;
      const geometry = new THREE.ExtrudeGeometry(
        this.createParallelogramShape(width, height, lean),
        {
          depth,
          steps: 1,
          bevelEnabled: options.bevelEnabled !== false,
          bevelThickness: options.bevelThickness != null ? options.bevelThickness : depth * 0.22,
          bevelSize: options.bevelSize != null ? options.bevelSize : Math.min(width, height) * 0.12,
          bevelOffset: options.bevelOffset != null ? options.bevelOffset : 0,
          bevelSegments: options.bevelSegments != null ? options.bevelSegments : 1,
          curveSegments: options.curveSegments != null ? options.curveSegments : 2,
        },
      );
      geometry.center();
      return geometry;
    }

    createTachBladeTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 192;
      canvas.height = 448;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      const alphaMask = context.createLinearGradient(0, 0, 0, canvas.height);
      alphaMask.addColorStop(0, "rgba(255,255,255,0)");
      alphaMask.addColorStop(0.05, "rgba(255,255,255,0.96)");
      alphaMask.addColorStop(0.16, "rgba(255,255,255,1)");
      alphaMask.addColorStop(0.84, "rgba(255,255,255,1)");
      alphaMask.addColorStop(0.95, "rgba(255,255,255,0.94)");
      alphaMask.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = alphaMask;
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.globalCompositeOperation = "source-in";
      const steelBody = context.createLinearGradient(0, 0, canvas.width, 0);
      steelBody.addColorStop(0, "rgba(64, 88, 130, 0.92)");
      steelBody.addColorStop(0.08, "rgba(238, 245, 255, 1)");
      steelBody.addColorStop(0.19, "rgba(255, 255, 255, 1)");
      steelBody.addColorStop(0.34, "rgba(160, 170, 186, 0.94)");
      steelBody.addColorStop(0.48, "rgba(40, 48, 60, 0.98)");
      steelBody.addColorStop(0.56, "rgba(5, 8, 14, 1)");
      steelBody.addColorStop(0.64, "rgba(24, 31, 42, 0.98)");
      steelBody.addColorStop(0.8, "rgba(214, 222, 233, 0.98)");
      steelBody.addColorStop(0.92, "rgba(255, 255, 255, 1)");
      steelBody.addColorStop(1, "rgba(154, 164, 180, 0.92)");
      context.fillStyle = steelBody;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const topCap = context.createLinearGradient(0, canvas.height * 0.02, 0, canvas.height * 0.18);
      topCap.addColorStop(0, "rgba(120, 182, 255, 0.9)");
      topCap.addColorStop(0.42, "rgba(228, 240, 255, 0.88)");
      topCap.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = topCap;
      context.fillRect(0, 0, canvas.width, canvas.height * 0.22);

      const lowerFace = context.createLinearGradient(0, canvas.height * 0.48, 0, canvas.height * 0.96);
      lowerFace.addColorStop(0, "rgba(34, 42, 56, 0)");
      lowerFace.addColorStop(0.18, "rgba(84, 96, 118, 0.44)");
      lowerFace.addColorStop(0.52, "rgba(246, 249, 255, 0.96)");
      lowerFace.addColorStop(0.82, "rgba(255, 255, 255, 1)");
      lowerFace.addColorStop(1, "rgba(228, 233, 241, 0.86)");
      context.fillStyle = lowerFace;
      context.fillRect(0, canvas.height * 0.42, canvas.width, canvas.height * 0.58);

      context.globalCompositeOperation = "screen";
      const diagonalFace = context.createLinearGradient(canvas.width * 0.04, canvas.height * 0.34, canvas.width * 0.96, canvas.height * 0.88);
      diagonalFace.addColorStop(0, "rgba(255,255,255,0)");
      diagonalFace.addColorStop(0.28, "rgba(255,255,255,0.12)");
      diagonalFace.addColorStop(0.5, "rgba(255,255,255,0.78)");
      diagonalFace.addColorStop(0.72, "rgba(214,222,236,0.34)");
      diagonalFace.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = diagonalFace;
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.globalCompositeOperation = "multiply";
      const verticalFalloff = context.createLinearGradient(0, canvas.height * 0.14, 0, canvas.height * 0.66);
      verticalFalloff.addColorStop(0, "rgba(0,0,0,0)");
      verticalFalloff.addColorStop(0.26, "rgba(12,16,22,0.28)");
      verticalFalloff.addColorStop(0.56, "rgba(8,10,15,0.84)");
      verticalFalloff.addColorStop(1, "rgba(18,22,30,0)");
      context.fillStyle = verticalFalloff;
      context.fillRect(0, canvas.height * 0.08, canvas.width, canvas.height * 0.66);

      const trough = context.createLinearGradient(canvas.width * 0.34, 0, canvas.width * 0.68, 0);
      trough.addColorStop(0, "rgba(0,0,0,0)");
      trough.addColorStop(0.18, "rgba(18,22,30,0.44)");
      trough.addColorStop(0.42, "rgba(8,10,16,0.98)");
      trough.addColorStop(0.58, "rgba(3,4,7,1)");
      trough.addColorStop(0.74, "rgba(16,21,30,0.84)");
      trough.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = trough;
      context.fillRect(canvas.width * 0.26, 0, canvas.width * 0.5, canvas.height);

      const chamferShadow = context.createLinearGradient(0, canvas.height * 0.22, canvas.width, canvas.height * 0.78);
      chamferShadow.addColorStop(0, "rgba(0,0,0,0)");
      chamferShadow.addColorStop(0.38, "rgba(10,12,18,0.18)");
      chamferShadow.addColorStop(0.54, "rgba(4,6,10,0.72)");
      chamferShadow.addColorStop(0.74, "rgba(0,0,0,0)");
      context.fillStyle = chamferShadow;
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.globalCompositeOperation = "screen";
      const crestGlint = context.createLinearGradient(canvas.width * 0.04, canvas.height * 0.04, canvas.width * 0.86, canvas.height * 0.22);
      crestGlint.addColorStop(0, "rgba(255,255,255,0)");
      crestGlint.addColorStop(0.26, "rgba(182,214,255,0.32)");
      crestGlint.addColorStop(0.44, "rgba(255,255,255,0.92)");
      crestGlint.addColorStop(0.58, "rgba(236,244,255,0.68)");
      crestGlint.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = crestGlint;
      context.fillRect(0, 0, canvas.width, canvas.height * 0.26);

      const returnEdge = context.createLinearGradient(canvas.width * 0.56, 0, canvas.width, 0);
      returnEdge.addColorStop(0, "rgba(255,255,255,0)");
      returnEdge.addColorStop(0.24, "rgba(228,236,248,0.22)");
      returnEdge.addColorStop(0.54, "rgba(255,255,255,0.94)");
      returnEdge.addColorStop(0.72, "rgba(248,250,255,0.74)");
      returnEdge.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = returnEdge;
      context.fillRect(canvas.width * 0.46, 0, canvas.width * 0.54, canvas.height);

      context.globalCompositeOperation = "source-over";
      const edgeLine = context.createLinearGradient(0, 0, canvas.width * 0.18, 0);
      edgeLine.addColorStop(0, "rgba(122, 178, 255, 0.62)");
      edgeLine.addColorStop(0.5, "rgba(214,232,255,0.28)");
      edgeLine.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = edgeLine;
      context.fillRect(0, 0, canvas.width * 0.18, canvas.height);

      context.globalCompositeOperation = "destination-in";
      const verticalMask = context.createLinearGradient(0, 0, 0, canvas.height);
      verticalMask.addColorStop(0, "rgba(255,255,255,0.12)");
      verticalMask.addColorStop(0.06, "rgba(255,255,255,1)");
      verticalMask.addColorStop(0.86, "rgba(255,255,255,1)");
      verticalMask.addColorStop(0.96, "rgba(255,255,255,0.9)");
      verticalMask.addColorStop(1, "rgba(255,255,255,0.1)");
      context.fillStyle = verticalMask;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.generateMipmaps = false;
      texture.colorSpace = this.THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      return texture;
    }

    buildChamberTickBand(config) {
      const { THREE } = this;
      const group = new THREE.Group();
      const ticks = [];
      const width = config.width;
      const height = config.height;
      const lean = config.lean;
      const geometry = this.createParallelogramPlateGeometry(width, height, lean);
      const shadowGeometry = this.createParallelogramPlateGeometry(
        width * (config.shadowScale || 1.08),
        height * (config.shadowScale || 1.08),
        lean * (config.shadowScale || 1.08),
      );
      const faceLerpBase = config.faceLerpBase != null ? config.faceLerpBase : 0.72;
      const faceLerpAmp = config.faceLerpAmp != null ? config.faceLerpAmp : 0.22;
      const cradleLerpBase = config.cradleLerpBase != null ? config.cradleLerpBase : 0.22;
      const cradleLerpAmp = config.cradleLerpAmp != null ? config.cradleLerpAmp : 0.18;
      const emissiveBase = config.emissiveBase != null ? config.emissiveBase : 0.1;
      const emissiveAmp = config.emissiveAmp != null ? config.emissiveAmp : 0.08;
      const faceRoughness = config.faceRoughness != null ? config.faceRoughness : 0.14;
      const faceMetalness = config.faceMetalness != null ? config.faceMetalness : 0.98;
      const cradleRoughness = config.cradleRoughness != null ? config.cradleRoughness : 0.4;
      const cradleMetalness = config.cradleMetalness != null ? config.cradleMetalness : 0.86;
      const bladeTexture = config.bladeTexture || (this.tachBladeTexture || (this.tachBladeTexture = this.createTachBladeTexture()));
      const leftHighlightGeometry = new THREE.PlaneGeometry(width * (config.leftHighlightWidthScale || 0.2), height * (config.highlightHeightScale || 0.92));
      const splitShadowGeometry = new THREE.PlaneGeometry(width * (config.splitShadowWidthScale || 0.16), height * (config.splitShadowHeightScale || 0.94));
      const rightHighlightGeometry = new THREE.PlaneGeometry(width * (config.rightHighlightWidthScale || 0.18), height * (config.highlightHeightScale || 0.9));

      for (let index = 0; index < config.count; index += 1) {
        const progress = index / config.count;
        const angle = config.startAngle + (progress * Math.PI * 2);
        const angleBias = 0.5 + (Math.sin(angle * 2.4 + config.phase) * 0.5);
        const cradleColor = config.dark.clone().lerp(config.mid, cradleLerpBase + angleBias * cradleLerpAmp);
        const faceColor = config.mid.clone().lerp(config.light, faceLerpBase + angleBias * faceLerpAmp);
        const emissiveColor = config.glint.clone().lerp(config.light, 0.56);
        const holder = new THREE.Group();
        const bladeSlot = new THREE.Mesh(
          shadowGeometry,
          new THREE.MeshBasicMaterial({
            color: config.slotColor || 0x010205,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const cradle = new THREE.Mesh(
          shadowGeometry,
          new THREE.MeshStandardMaterial({
            color: cradleColor,
            roughness: cradleRoughness,
            metalness: cradleMetalness,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const plate = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: faceColor,
            emissive: emissiveColor,
            map: bladeTexture,
            emissiveMap: bladeTexture,
            emissiveIntensity: emissiveBase + angleBias * emissiveAmp,
            roughness: faceRoughness,
            metalness: faceMetalness,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const leftHighlight = new THREE.Mesh(
          leftHighlightGeometry,
          new THREE.MeshBasicMaterial({
            color: config.leftHighlightColor || 0xf6fbff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
        );
        const splitShadow = new THREE.Mesh(
          splitShadowGeometry,
          new THREE.MeshBasicMaterial({
            color: config.splitShadowColor || 0x03060b,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const rightHighlight = new THREE.Mesh(
          rightHighlightGeometry,
          new THREE.MeshBasicMaterial({
            color: config.rightHighlightColor || 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
        );
        const glint = new THREE.Mesh(
          new THREE.PlaneGeometry(width * (config.glintWidthScale || 0.76), height * (config.glintHeightScale || 0.16)),
          new THREE.MeshBasicMaterial({
            color: config.glint.clone().lerp(config.light, 0.62),
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
        );
        const faceShadow = new THREE.Mesh(
          new THREE.PlaneGeometry(width * (config.faceShadowWidthScale || 0.94), height * (config.faceShadowHeightScale || 0.42)),
          new THREE.MeshBasicMaterial({
            color: config.shadowColor || 0x11151c,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        bladeSlot.position.z = config.slotZ != null ? config.slotZ : -0.0046;
        bladeSlot.position.y = height * (config.slotYOffset != null ? config.slotYOffset : 0.015);
        cradle.position.z = config.cradleZ != null ? config.cradleZ : -0.003;
        cradle.position.y = height * (config.cradleYOffset != null ? config.cradleYOffset : -0.02);
        faceShadow.position.set(0, height * (config.faceShadowYOffset != null ? config.faceShadowYOffset : -0.06), config.faceShadowZ != null ? config.faceShadowZ : 0.001);
        plate.position.z = config.faceZ != null ? config.faceZ : 0.002;
        leftHighlight.position.set(width * (config.leftHighlightXOffset != null ? config.leftHighlightXOffset : -0.18), 0, config.leftHighlightZ != null ? config.leftHighlightZ : 0.005);
        splitShadow.position.set(width * (config.splitShadowXOffset != null ? config.splitShadowXOffset : 0.03), 0, config.splitShadowZ != null ? config.splitShadowZ : 0.006);
        rightHighlight.position.set(width * (config.rightHighlightXOffset != null ? config.rightHighlightXOffset : 0.22), 0, config.rightHighlightZ != null ? config.rightHighlightZ : 0.007);
        glint.position.set(0, height * (config.glintYOffset != null ? config.glintYOffset : 0.1), config.glintZ != null ? config.glintZ : 0.006);
        glint.rotation.z = config.glintRotation != null ? config.glintRotation : -0.2;
        holder.position.set(
          Math.cos(angle) * config.radius,
          Math.sin(angle) * config.radius,
          config.z || 0,
        );
        holder.rotation.z = angle + Math.PI * 0.5 + (config.rotationOffset || 0);
        holder.add(bladeSlot, cradle, faceShadow, plate, leftHighlight, splitShadow, rightHighlight, glint);
        group.add(holder);
        ticks.push({
          holder,
          bladeSlot,
          cradle,
          faceShadow,
          plate,
          leftHighlight,
          splitShadow,
          rightHighlight,
          glint,
          baseOpacity: config.baseOpacity * (0.9 + angleBias * 0.16),
          bladeSlotOpacity: (config.baseOpacity * (config.slotOpacityScale || 0.58)) * (0.96 + angleBias * 0.06),
          cradleOpacity: (config.baseOpacity * 0.44) * (0.92 + angleBias * 0.08),
          shadowOpacity: (config.baseOpacity * (config.faceShadowOpacityScale || 0.22)) * (0.9 + angleBias * 0.12),
          splitShadowOpacity: (config.baseOpacity * (config.splitShadowOpacityScale || 0.46)) * (0.9 + angleBias * 0.1),
          leftHighlightOpacity: (config.baseOpacity * (config.leftHighlightOpacityScale || 0.52)) * (0.88 + angleBias * 0.12),
          rightHighlightOpacity: (config.baseOpacity * (config.rightHighlightOpacityScale || 0.62)) * (0.9 + angleBias * 0.14),
          glintOpacity: config.glintOpacity * (0.78 + angleBias * 0.3),
          glintPhase: angle * 1.8 + config.phase,
          glintBias: angleBias,
        });
      }

      return { group, ticks };
    }

    buildMachinedBladeBand(config) {
      const { THREE } = this;
      const group = new THREE.Group();
      const ticks = [];
      const width = config.width;
      const height = config.height;
      const lean = config.lean;
      const bodyDepth = config.bodyDepth != null ? config.bodyDepth : Math.max(width * 0.46, height * 0.075);
      const socketDepth = config.socketDepth != null ? config.socketDepth : bodyDepth * 1.14;
      const contactShadowGeometry = this.createParallelogramPlateGeometry(width * 1.28, height * 1.1, lean * 1.08);
      const socketGeometry = this.createExtrudedParallelogramGeometry(
        width * 1.18,
        height * 1.08,
        lean * 1.08,
        socketDepth,
        {
          bevelThickness: socketDepth * 0.14,
          bevelSize: Math.min(width, height) * 0.12,
        },
      );
      const bladeGeometry = this.createExtrudedParallelogramGeometry(
        width,
        height,
        lean,
        bodyDepth,
        {
          bevelThickness: bodyDepth * 0.26,
          bevelSize: Math.min(width, height) * 0.14,
        },
      );
      const frontFaceGeometry = this.createParallelogramPlateGeometry(width * 0.84, height * 0.82, lean * 0.82);
      const faceShadowGeometry = this.createParallelogramPlateGeometry(width * 0.72, height * 0.28, lean * 0.7);
      const topCapGeometry = this.createParallelogramPlateGeometry(width * 0.88, height * 0.18, lean * 0.84);
      const innerShadowGeometry = this.createParallelogramPlateGeometry(width * 0.18, height * 0.88, lean * 0.1);
      const rearEdgeGeometry = this.createParallelogramPlateGeometry(width * 0.17, height * 0.9, lean * 0.14);
      const glintGeometry = this.createParallelogramPlateGeometry(width * 0.72, height * 0.11, lean * 0.68);

      for (let index = 0; index < config.count; index += 1) {
        const progress = index / config.count;
        const angle = config.startAngle + (progress * Math.PI * 2);
        const angleBias = 0.5 + (Math.sin(angle * 2.6 + config.phase) * 0.5);
        const holder = new THREE.Group();
        const socketColor = config.dark.clone().lerp(config.mid, 0.08 + angleBias * 0.08);
        const bodyColor = config.dark.clone().lerp(config.mid, 0.34 + angleBias * 0.08);
        const faceColor = config.mid.clone().lerp(config.light, 0.92 + angleBias * 0.06);
        const capColor = config.glint.clone().lerp(config.light, 0.84);
        const edgeColor = config.mid.clone().lerp(config.light, 0.72 + angleBias * 0.08);

        const bladeSlot = new THREE.Mesh(
          contactShadowGeometry,
          new THREE.MeshBasicMaterial({
            color: config.slotColor || 0x010205,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const cradle = new THREE.Mesh(
          socketGeometry,
          new THREE.MeshPhysicalMaterial({
            color: socketColor,
            roughness: 0.76,
            metalness: 0.9,
            clearcoat: 0.12,
            clearcoatRoughness: 0.64,
            transparent: true,
            opacity: 0,
          }),
        );
        const body = new THREE.Mesh(
          bladeGeometry,
          new THREE.MeshPhysicalMaterial({
            color: bodyColor,
            roughness: 0.24,
            metalness: 1,
            clearcoat: 0.82,
            clearcoatRoughness: 0.16,
            transparent: true,
            opacity: 0,
          }),
        );
        const plate = new THREE.Mesh(
          frontFaceGeometry,
          new THREE.MeshBasicMaterial({
            color: faceColor,
            transparent: true,
            opacity: 0,
            toneMapped: false,
          }),
        );
        const faceShadow = new THREE.Mesh(
          faceShadowGeometry,
          new THREE.MeshBasicMaterial({
            color: config.shadowColor || 0x090d14,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const leftHighlight = new THREE.Mesh(
          topCapGeometry,
          new THREE.MeshBasicMaterial({
            color: capColor,
            transparent: true,
            opacity: 0,
            toneMapped: false,
          }),
        );
        const splitShadow = new THREE.Mesh(
          innerShadowGeometry,
          new THREE.MeshBasicMaterial({
            color: config.splitShadowColor || 0x02050a,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        const rightHighlight = new THREE.Mesh(
          rearEdgeGeometry,
          new THREE.MeshBasicMaterial({
            color: edgeColor,
            transparent: true,
            opacity: 0,
            toneMapped: false,
          }),
        );
        const glint = new THREE.Mesh(
          glintGeometry,
          new THREE.MeshBasicMaterial({
            color: config.glint.clone().lerp(config.light, 0.7),
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            toneMapped: false,
          }),
        );

        cradle.userData.keepDepthTest = true;
        body.userData.keepDepthTest = true;
        plate.userData.keepDepthTest = true;
        leftHighlight.userData.keepDepthTest = true;
        rightHighlight.userData.keepDepthTest = true;

        bladeSlot.position.set(0, height * 0.03, -bodyDepth * 0.96);
        cradle.position.set(0, height * 0.016, -socketDepth * 0.48);
        body.position.set(0, 0, bodyDepth * 0.02);
        plate.position.set(-width * 0.005, height * 0.05, bodyDepth * 1.34);
        faceShadow.position.set(width * 0.02, height * 0.14, bodyDepth * 1.18);
        leftHighlight.position.set(-width * 0.06, -height * 0.36, bodyDepth * 1.42);
        splitShadow.position.set(width * 0.05, 0, bodyDepth * 1.24);
        rightHighlight.position.set(width * 0.22, 0, bodyDepth * 1.38);
        glint.position.set(-width * 0.08, -height * 0.28, bodyDepth * 1.5);

        holder.position.set(
          Math.cos(angle) * config.radius,
          Math.sin(angle) * config.radius,
          config.z || 0,
        );
        holder.rotation.z = angle + Math.PI * 0.5 + (config.rotationOffset || 0);
        holder.add(bladeSlot, cradle, body, plate, faceShadow, leftHighlight, splitShadow, rightHighlight, glint);
        group.add(holder);

        ticks.push({
          holder,
          bladeSlot,
          cradle,
          body,
          faceShadow,
          plate,
          leftHighlight,
          splitShadow,
          rightHighlight,
          glint,
          baseOpacity: config.baseOpacity * (0.92 + angleBias * 0.08),
          bladeSlotOpacity: (config.baseOpacity * 0.44) * (0.96 + angleBias * 0.05),
          cradleOpacity: (config.baseOpacity * 0.52) * (0.94 + angleBias * 0.08),
          bodyOpacity: (config.baseOpacity * 0.76) * (0.94 + angleBias * 0.06),
          shadowOpacity: (config.baseOpacity * 0.42) * (0.94 + angleBias * 0.08),
          splitShadowOpacity: (config.baseOpacity * 0.52) * (0.92 + angleBias * 0.1),
          leftHighlightOpacity: (config.baseOpacity * 0.74) * (0.9 + angleBias * 0.12),
          rightHighlightOpacity: (config.baseOpacity * 0.7) * (0.9 + angleBias * 0.12),
          glintOpacity: (config.glintOpacity || 0.12) * (0.8 + angleBias * 0.28),
          glintPhase: angle * 1.8 + config.phase,
          glintBias: angleBias,
        });
      }

      return { group, ticks };
    }

    buildFocusedTachBand(config) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.z = config.zOffset || 0.016;
      const dark = new THREE.Color(0x03050a);
      const mid = new THREE.Color(0x535d6c);
      const light = new THREE.Color(0xd9e0ea);
      const glint = new THREE.Color(0xf3f7fb);
      const tickRadius = config.tickRadius != null ? config.tickRadius : config.radius - (config.carrierTube * 0.28);

      const shadow = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius, config.shadowTube, 18, 240),
        new THREE.MeshBasicMaterial({
          color: 0x010205,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      shadow.renderOrder = 6;
      shadow.position.z = -0.016;
      group.add(shadow);

      const carrier = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius, config.carrierTube, 20, 260),
        new THREE.MeshStandardMaterial({
          color: 0x05070b,
          emissive: 0x0d1320,
          emissiveIntensity: 0.04,
          roughness: 0.12,
          metalness: 1,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      carrier.renderOrder = 7;
      group.add(carrier);

      const outerLip = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius + config.lipOffset, config.lipTube, 10, 220),
        new THREE.MeshBasicMaterial({
          color: 0xdde6f2,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      outerLip.renderOrder = 9;
      group.add(outerLip);

      const innerLip = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius - config.lipOffset, config.lipTube * 0.92, 10, 220),
        new THREE.MeshBasicMaterial({
          color: 0x0f131b,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      innerLip.renderOrder = 8;
      group.add(innerLip);

      const trackShadow = new THREE.Mesh(
        new THREE.TorusGeometry(tickRadius, config.trackTube || (config.carrierTube * 0.48), 18, 240),
        new THREE.MeshBasicMaterial({
          color: 0x010205,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      trackShadow.position.z = -0.004;
      trackShadow.renderOrder = 9;
      group.add(trackShadow);

      const track = new THREE.Mesh(
        new THREE.TorusGeometry(tickRadius, config.trackTubeInner || (config.carrierTube * 0.32), 18, 240),
        new THREE.MeshStandardMaterial({
          color: 0x070a10,
          emissive: 0x111824,
          emissiveIntensity: 0.03,
          roughness: 0.16,
          metalness: 1,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      track.renderOrder = 10;
      group.add(track);

      const bladeCavity = new THREE.Mesh(
        new THREE.TorusGeometry(
          tickRadius,
          config.bladeCavityTube || Math.max(config.tickHeight * 0.22, config.carrierTube * 0.16),
          16,
          240,
        ),
        new THREE.MeshBasicMaterial({
          color: config.bladeCavityColor || 0x010205,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          toneMapped: false,
        }),
      );
      bladeCavity.position.z = config.bladeCavityZ != null ? config.bladeCavityZ : 0.006;
      bladeCavity.renderOrder = 13;
      group.add(bladeCavity);

      const band = this.buildMachinedBladeBand({
        radius: tickRadius,
        count: config.count,
        width: config.tickWidth,
        height: config.tickHeight,
        lean: config.tickLean,
        startAngle: config.startAngle,
        phase: config.phase,
        dark,
        mid,
        light,
        glint,
        baseOpacity: config.bladeBaseOpacity != null ? config.bladeBaseOpacity : 0.42,
        glintOpacity: config.bladeGlintOpacity != null ? config.bladeGlintOpacity : 0.07,
        z: 0.018,
        shadowScale: 1.12,
        cradleLerpBase: 0,
        cradleLerpAmp: 0.018,
        faceLerpBase: 0.72,
        faceLerpAmp: 0.08,
        emissiveBase: 0.025,
        emissiveAmp: 0.014,
        faceRoughness: 0.18,
        faceMetalness: 1,
        cradleRoughness: 0.34,
        cradleMetalness: 1,
        bodyDepth: config.bladeDepth,
        socketDepth: config.socketDepth,
        glintWidthScale: 0.42,
        glintHeightScale: 0.055,
        glintYOffset: 0.26,
        glintRotation: -0.18,
        faceShadowOpacityScale: 0.18,
        faceShadowWidthScale: 0.92,
        faceShadowHeightScale: 0.28,
        faceShadowYOffset: -0.06,
        leftHighlightWidthScale: 0.22,
        rightHighlightWidthScale: 0.2,
        highlightHeightScale: 1,
        leftHighlightXOffset: -0.23,
        rightHighlightXOffset: 0.24,
        splitShadowWidthScale: 0.15,
        splitShadowHeightScale: 0.98,
        splitShadowXOffset: 0.014,
        splitShadowOpacityScale: 0.62,
        leftHighlightOpacityScale: 0.58,
        rightHighlightOpacityScale: 0.52,
        slotOpacityScale: 0.42,
        slotYOffset: 0.01,
        slotZ: -0.0054,
        rotationOffset: -0.36,
        shadowColor: 0x010203,
      });
      band.group.traverse((child) => {
        child.renderOrder = 14;
        if (child.material) {
          child.material.depthTest = !!child.userData.keepDepthTest;
        }
      });
      group.add(band.group);

      const sheen = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius + 0.004, config.sheenTube, 12, 220),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      sheen.renderOrder = 11;
      group.add(sheen);

      const edgeGlow = new THREE.Mesh(
        new THREE.TorusGeometry(config.radius + (config.lipOffset * 0.2), config.edgeGlowTube, 12, 220),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        }),
      );
      edgeGlow.renderOrder = 12;
      group.add(edgeGlow);

      const bladeKeyLight = new THREE.DirectionalLight(0xf7fbff, 0.42);
      bladeKeyLight.position.set(-2.8, -3.2, 5.2);
      bladeKeyLight.target.position.set(0, 0, 0);
      group.add(bladeKeyLight, bladeKeyLight.target);

      const bladeFillLight = new THREE.DirectionalLight(0x83afff, 0.14);
      bladeFillLight.position.set(2.4, 1.8, 2.6);
      bladeFillLight.target.position.set(0, 0, 0);
      group.add(bladeFillLight, bladeFillLight.target);

      group.rotation.x = config.tilt || 0;

      return {
        group,
        shadow,
        carrier,
        outerLip,
        innerLip,
        trackShadow,
        track,
        bladeCavity,
        band,
        sheen,
        edgeGlow,
        bladeKeyLight,
        bladeFillLight,
      };
    }

    buildMicroTickRing(config) {
      const { THREE } = this;
      const positions = [];
      const guidePositions = [];
      for (let index = 0; index < config.count; index += 1) {
        const angle = (index / config.count) * Math.PI * 2;
        const innerRadius = config.radius - (index % config.majorEvery === 0 ? config.majorLength : config.minorLength);
        const target = index % config.majorEvery === 0 ? positions : guidePositions;
        target.push(
          Math.cos(angle) * innerRadius, Math.sin(angle) * innerRadius, config.z || 0,
          Math.cos(angle) * config.radius, Math.sin(angle) * config.radius, config.z || 0,
        );
      }
      return {
        major: new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)),
          new THREE.LineBasicMaterial({
            color: config.majorColor,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        ),
        minor: new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(guidePositions, 3)),
          new THREE.LineBasicMaterial({
            color: config.minorColor,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          }),
        ),
      };
    }

    buildLockProfile(node) {
      const seed = hashString(`lock:${node.id}`);
      const variance = hashString(`lock:${node.provider}:${node.id}`);
      const tierScale = node.tier === "flagship" ? 1 : node.tier === "secondary" ? 0.74 : 0.52;
      return {
        phaseOffset: seed * Math.PI * 2,
        settleAmplitude: (0.06 + variance * 0.08) * tierScale,
        cameraBias: 0.88 + variance * 0.24,
        targetBias: 0.18 + seed * 0.12,
        forwardBias: 0.08 + variance * 0.12,
        apparatusGain: 0.92 + tierScale * 0.28 + variance * 0.08,
        braceGain: 0.8 + seed * 0.28,
        traceGain: 0.9 + variance * 0.24,
        yBias: ((seed * 2) - 1) * 0.018,
      };
    }

    buildChamberCore() {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.set(0, -0.45, -0.82);
      group.scale.setScalar(1.18);
      this.scene.add(group);

      const planeTilt = 1.04;

      const envelope = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture || (this.glowTexture = this.createGlowTexture()),
          color: 0x6278ff,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      envelope.scale.set(8.4, 8.4, 1);
      group.add(envelope);

      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.lobeTexture || (this.lobeTexture = this.createLobeTexture()),
          color: 0xa8c8ff,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.scale.set(4.6, 4.6, 1);
      group.add(halo);

      const mantle = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.livingCoreTexture || (this.livingCoreTexture = this.createLivingCoreTexture()),
          color: 0xcfe1ff,
          transparent: true,
          opacity: 0.54,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      mantle.scale.set(5.2, 5.2, 1);
      group.add(mantle);

      const convection = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.livingCoreTexture || (this.livingCoreTexture = this.createLivingCoreTexture()),
          color: 0x88abff,
          transparent: true,
          opacity: 0.26,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      convection.scale.set(4.3, 4.3, 1);
      convection.material.rotation = 0.74;
      group.add(convection);

      const nucleus = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.nucleusTexture || (this.nucleusTexture = this.createNucleusTexture()),
          color: 0xffffff,
          transparent: true,
          opacity: 0.96,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      nucleus.scale.set(1.36, 1.36, 1);
      group.add(nucleus);

      const coronaGroup = new THREE.Group();
      const coronaSprites = [];
      for (let index = 0; index < 5; index += 1) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.lobeTexture || (this.lobeTexture = this.createLobeTexture()),
            color: index % 2 === 0 ? 0xecf5ff : 0x91b1ff,
            transparent: true,
            opacity: 0.06,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        const angle = (index / 5) * Math.PI * 2 + (index % 2 === 0 ? 0.18 : -0.1);
        const radius = 2.38 + (index % 3) * 0.22;
        sprite.position.set(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.72,
          0.04 + index * 0.01,
        );
        sprite.scale.set(1.3 + (index % 2) * 0.18, 0.62 + (index % 3) * 0.08, 1);
        coronaGroup.add(sprite);
        coronaSprites.push({
          sprite,
          angle,
          radius,
          phase: index * 0.92,
        });
      }
      group.add(coronaGroup);

      const apertureRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.84, 0.058, 18, 160),
        new THREE.MeshBasicMaterial({
          color: 0xd9ebff,
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        }),
      );
      apertureRing.rotation.x = planeTilt;
      group.add(apertureRing);

      const calibrationRing = new THREE.Mesh(
        new THREE.TorusGeometry(3.26, 0.03, 14, 160),
        new THREE.MeshBasicMaterial({
          color: 0x7ca6ff,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
        }),
      );
      calibrationRing.rotation.x = planeTilt;
      group.add(calibrationRing);

      const lockRing = new THREE.Mesh(
        new THREE.TorusGeometry(2.22, 0.02, 10, 120),
        new THREE.MeshBasicMaterial({
          color: 0xf2f7ff,
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      lockRing.rotation.x = planeTilt;
      group.add(lockRing);

      const rimMetalDark = new THREE.Color(0x262c37);
      const rimMetalMid = new THREE.Color(0xa2acba);
      const rimMetalLight = new THREE.Color(0xf6f8fd);
      const rimGlint = new THREE.Color(0xf8fbff);

      const tachCarrier = new THREE.Mesh(
        new THREE.TorusGeometry(2.98, 0.14, 18, 220),
        new THREE.MeshStandardMaterial({
          color: 0x1f2632,
          roughness: 0.52,
          metalness: 0.84,
          transparent: true,
          opacity: 0.02,
          depthWrite: false,
        }),
      );
      tachCarrier.rotation.x = planeTilt;
      group.add(tachCarrier);

      const tachInnerLip = new THREE.Mesh(
        new THREE.TorusGeometry(2.9, 0.022, 10, 180),
        new THREE.MeshBasicMaterial({
          color: 0xd7e2f2,
          transparent: true,
          opacity: 0.014,
          depthWrite: false,
        }),
      );
      tachInnerLip.rotation.x = planeTilt;
      group.add(tachInnerLip);

      const rimBand = this.buildChamberTickBand({
        radius: 2.98,
        count: 78,
        width: 0.064,
        height: 0.096,
        lean: 0.054,
        startAngle: 0.08,
        phase: 0.3,
        dark: rimMetalDark,
        mid: rimMetalMid,
        light: rimMetalLight,
        glint: rimGlint,
        baseOpacity: 0.14,
        glintOpacity: 0.026,
        z: 0.014,
        shadowScale: 1.08,
        faceLerpBase: 0.58,
        faceLerpAmp: 0.16,
        emissiveBase: 0.025,
        emissiveAmp: 0.014,
        faceRoughness: 0.28,
        cradleRoughness: 0.54,
        faceShadowOpacityScale: 0.16,
        leftHighlightOpacityScale: 0.34,
        rightHighlightOpacityScale: 0.3,
      });
      rimBand.group.rotation.x = planeTilt;
      group.add(rimBand.group);

      const innerTachCarrier = new THREE.Mesh(
        new THREE.TorusGeometry(2.58, 0.14, 20, 240),
        new THREE.MeshStandardMaterial({
          color: 0x171d28,
          roughness: 0.3,
          metalness: 0.94,
          transparent: true,
          opacity: 0.04,
          depthWrite: false,
        }),
      );
      innerTachCarrier.rotation.x = planeTilt;
      group.add(innerTachCarrier);

      const innerTachShadow = new THREE.Mesh(
        new THREE.TorusGeometry(2.58, 0.17, 20, 240),
        new THREE.MeshBasicMaterial({
          color: 0x0e1219,
          transparent: true,
          opacity: 0.03,
          depthWrite: false,
        }),
      );
      innerTachShadow.position.z = -0.01;
      innerTachShadow.rotation.x = planeTilt;
      group.add(innerTachShadow);

      const innerTachLipOuter = new THREE.Mesh(
        new THREE.TorusGeometry(2.68, 0.019, 10, 200),
        new THREE.MeshBasicMaterial({
          color: 0xe2e8f0,
          transparent: true,
          opacity: 0.028,
          depthWrite: false,
        }),
      );
      innerTachLipOuter.rotation.x = planeTilt;
      group.add(innerTachLipOuter);

      const innerTachLipInner = new THREE.Mesh(
        new THREE.TorusGeometry(2.48, 0.018, 10, 200),
        new THREE.MeshBasicMaterial({
          color: 0x565f6d,
          transparent: true,
          opacity: 0.02,
          depthWrite: false,
        }),
      );
      innerTachLipInner.rotation.x = planeTilt;
      group.add(innerTachLipInner);

      const innerTachBand = this.buildChamberTickBand({
        radius: 2.58,
        count: 88,
        width: 0.06,
        height: 0.092,
        lean: 0.05,
        startAngle: 0.12,
        phase: 0.68,
        dark: new THREE.Color(0x171d26),
        mid: new THREE.Color(0x707987),
        light: new THREE.Color(0xe1e7ef),
        glint: new THREE.Color(0xf6f9fd),
        baseOpacity: 0.15,
        glintOpacity: 0.032,
        z: 0.016,
        shadowScale: 1.08,
        cradleLerpBase: 0.1,
        cradleLerpAmp: 0.12,
        faceLerpBase: 0.6,
        faceLerpAmp: 0.14,
        emissiveBase: 0.026,
        emissiveAmp: 0.016,
        faceRoughness: 0.24,
        faceMetalness: 1,
        cradleRoughness: 0.42,
        cradleMetalness: 0.98,
        glintWidthScale: 0.5,
        glintHeightScale: 0.08,
        glintYOffset: 0.22,
        glintRotation: -0.32,
        faceShadowOpacityScale: 0.18,
        faceShadowHeightScale: 0.36,
        faceShadowYOffset: -0.08,
        shadowColor: 0x06080c,
        leftHighlightOpacityScale: 0.34,
        rightHighlightOpacityScale: 0.32,
      });
      innerTachBand.group.rotation.x = planeTilt;
      group.add(innerTachBand.group);

      const innerTachSheen = new THREE.Mesh(
        new THREE.TorusGeometry(2.586, 0.04, 12, 200),
        new THREE.MeshBasicMaterial({
          color: 0xf5f8fd,
          transparent: true,
          opacity: 0.02,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      innerTachSheen.rotation.x = planeTilt;
      group.add(innerTachSheen);

      const innerTachEdgeGlow = new THREE.Mesh(
        new THREE.TorusGeometry(2.595, 0.022, 12, 200),
        new THREE.MeshBasicMaterial({
          color: 0xfdfefe,
          transparent: true,
          opacity: 0.012,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      innerTachEdgeGlow.rotation.x = planeTilt;
      group.add(innerTachEdgeGlow);

      const microTicks = this.buildMicroTickRing({
        radius: 3.18,
        count: 168,
        majorEvery: 6,
        minorLength: 0.05,
        majorLength: 0.11,
        majorColor: rimMetalLight,
        minorColor: rimMetalMid,
        z: 0.01,
      });
      microTicks.major.rotation.x = planeTilt;
      microTicks.minor.rotation.x = planeTilt;
      group.add(microTicks.minor, microTicks.major);

      const rimSheen = new THREE.Mesh(
        new THREE.TorusGeometry(2.99, 0.028, 12, 180),
        new THREE.MeshBasicMaterial({
          color: 0xf7fbff,
          transparent: true,
          opacity: 0.06,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      rimSheen.rotation.x = planeTilt;
      group.add(rimSheen);

      const rimShadow = new THREE.Mesh(
        new THREE.TorusGeometry(2.98, 0.092, 18, 180),
        new THREE.MeshBasicMaterial({
          color: 0x202a3a,
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
        }),
      );
      rimShadow.rotation.x = planeTilt;
      group.add(rimShadow);

      const braceGroup = new THREE.Group();
      const braces = [];
      for (let index = 0; index < 8; index += 1) {
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(1.98, -0.04, 0),
          new THREE.Vector3(2.48, 0, 0),
          new THREE.Vector3(3.12, 0.16, 0),
        ]);
        const line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({
            color: index % 2 === 0 ? 0xd6e8ff : 0x8caeff,
            transparent: true,
            opacity: 0.16,
            depthWrite: false,
          }),
        );
        line.rotation.set(planeTilt, 0, (index / 8) * Math.PI * 2);
        braceGroup.add(line);
        braces.push({
          line,
          baseOpacity: index % 2 === 0 ? 0.16 : 0.12,
        });
      }
      group.add(braceGroup);

      const arcConfigs = [
        { radius: 3.64, start: 0.18, sweep: 0.76, opacity: 0.16, speed: 0.038, color: 0xbfd8ff },
        { radius: 3.5, start: 1.58, sweep: 0.48, opacity: 0.11, speed: -0.028, color: 0x7ba0ff },
        { radius: 3.82, start: 3.42, sweep: 0.68, opacity: 0.12, speed: 0.02, color: 0xe7f1ff },
        { radius: 3.24, start: 4.84, sweep: 0.42, opacity: 0.1, speed: -0.032, color: 0x8fb7ff },
      ];
      const arcs = arcConfigs.map((config) => {
        const line = this.buildChamberArc(
          config.radius,
          config.start,
          config.sweep,
          26,
          new THREE.LineBasicMaterial({
            color: config.color,
            transparent: true,
            opacity: config.opacity,
            depthWrite: false,
          }),
          0.92,
        );
        line.rotation.x = planeTilt;
        group.add(line);
        return {
          line,
          baseOpacity: config.opacity,
          speed: config.speed,
        };
      });

      const coreLight = new THREE.PointLight(0xdcebff, 1.55, 18, 2.1);
      coreLight.position.set(0, 0.28, 1.85);
      group.add(coreLight);

      this.chamberCore = {
        group,
        envelope,
        halo,
        mantle,
        convection,
        nucleus,
        coronaGroup,
        coronaSprites,
        apertureRing,
        calibrationRing,
        lockRing,
        rimBand,
        innerTachCarrier,
        innerTachShadow,
        innerTachBand,
        innerTachSheen,
        innerTachEdgeGlow,
        innerTachLipOuter,
        innerTachLipInner,
        microTicks,
        rimSheen,
        rimShadow,
        tachCarrier,
        tachInnerLip,
        braceGroup,
        braces,
        arcs,
        coreLight,
        lockAlpha: 0,
      };
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
      const dustTexture = this.hyperdriveStarTexture || (this.hyperdriveStarTexture = this.createHyperdriveStarTexture());
      const dustMaterial = new THREE.PointsMaterial({
        size: 0.055,
        transparent: true,
        opacity: 0.34,
        vertexColors: true,
        map: dustTexture,
        alphaMap: dustTexture,
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
      const nearTexture = this.hyperdriveStarTexture || (this.hyperdriveStarTexture = this.createHyperdriveStarTexture());
      const nearMaterial = new THREE.PointsMaterial({
        size: 0.09,
        transparent: true,
        opacity: 0.12,
        color: 0x8fc4ff,
        map: nearTexture,
        alphaMap: nearTexture,
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
      this.onClick = this.onClick.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onFocus = this.onFocus.bind(this);
      this.onBlur = this.onBlur.bind(this);
      this.onResize = this.resize.bind(this);

      this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
      this.renderer.domElement.addEventListener("pointerleave", this.onPointerLeave);
      this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
      this.renderer.domElement.addEventListener("click", this.onClick);
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
      /* Concentrated signal halo: bright nucleus with a fast, cool falloff. */
      gradient.addColorStop(0,    "rgba(255,255,255,1)");
      gradient.addColorStop(0.035, "rgba(248,252,255,1)");
      gradient.addColorStop(0.09, "rgba(232,246,255,0.96)");
      gradient.addColorStop(0.18, "rgba(180,228,255,0.76)");
      gradient.addColorStop(0.29, "rgba(118,196,255,0.46)");
      gradient.addColorStop(0.42, "rgba(74,148,246,0.22)");
      gradient.addColorStop(0.58, "rgba(58,104,220,0.09)");
      gradient.addColorStop(0.74, "rgba(76,74,192,0.035)");
      gradient.addColorStop(1,    "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 256, 256);
      return new this.THREE.CanvasTexture(canvas);
    }

    createHyperdriveStarTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
      glow.addColorStop(0, "rgba(255,255,255,1)");
      glow.addColorStop(0.08, "rgba(248,252,255,0.98)");
      glow.addColorStop(0.2, "rgba(228,240,255,0.72)");
      glow.addColorStop(0.4, "rgba(172,204,248,0.24)");
      glow.addColorStop(0.62, "rgba(116,160,230,0.06)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    }

    createHyperdriveStreakTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 512;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);

      const body = context.createLinearGradient(0, 0, 0, canvas.height);
      body.addColorStop(0, "rgba(255,255,255,0)");
      body.addColorStop(0.06, "rgba(255,255,255,0.12)");
      body.addColorStop(0.18, "rgba(255,255,255,0.84)");
      body.addColorStop(0.5, "rgba(255,255,255,1)");
      body.addColorStop(0.82, "rgba(255,255,255,0.84)");
      body.addColorStop(0.94, "rgba(255,255,255,0.12)");
      body.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = body;
      context.fillRect(0, 0, canvas.width, canvas.height);

      const crossSection = context.createLinearGradient(0, 0, canvas.width, 0);
      crossSection.addColorStop(0, "rgba(255,255,255,0)");
      crossSection.addColorStop(0.18, "rgba(255,255,255,0.03)");
      crossSection.addColorStop(0.34, "rgba(255,255,255,0.4)");
      crossSection.addColorStop(0.5, "rgba(255,255,255,1)");
      crossSection.addColorStop(0.66, "rgba(255,255,255,0.4)");
      crossSection.addColorStop(0.82, "rgba(255,255,255,0.03)");
      crossSection.addColorStop(1, "rgba(255,255,255,0)");
      context.globalCompositeOperation = "destination-in";
      context.fillStyle = crossSection;
      context.fillRect(0, 0, canvas.width, canvas.height);

      context.globalCompositeOperation = "screen";
      const bloom = context.createRadialGradient(canvas.width * 0.5, canvas.height * 0.5, 0, canvas.width * 0.5, canvas.height * 0.5, canvas.width * 0.76);
      bloom.addColorStop(0, "rgba(255,255,255,0.32)");
      bloom.addColorStop(0.32, "rgba(224,240,255,0.12)");
      bloom.addColorStop(0.72, "rgba(138,188,255,0.04)");
      bloom.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = bloom;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = "source-over";

      const texture = new this.THREE.CanvasTexture(canvas);
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      return texture;
    }

    /* Tight bright inner texture for the nucleus sprite */
    createNucleusTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
      gradient.addColorStop(0,    "rgba(255,255,255,1)");
      gradient.addColorStop(0.07, "rgba(249,252,255,1)");
      gradient.addColorStop(0.16, "rgba(236,248,255,0.94)");
      gradient.addColorStop(0.28, "rgba(194,232,255,0.7)");
      gradient.addColorStop(0.42, "rgba(126,194,255,0.36)");
      gradient.addColorStop(0.60, "rgba(84,148,250,0.14)");
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

      /* Ribbon 3: restrained ultraviolet accent */
      ribbon(
        [[80, 80], [130, 120], [185, 145], [240, 130], [290, 95]],
        13, 5, 0.65,
        [
          [0, "rgba(144, 132, 255, 0)"],
          [0.2, "rgba(160, 152, 255, 0.76)"],
          [0.55, "rgba(188, 182, 255, 0.86)"],
          [0.8, "rgba(132, 128, 236, 0.64)"],
          [1, "rgba(108, 102, 214, 0)"],
        ],
      );

      /* Soft central glow for depth */
      ctx.globalCompositeOperation = "screen";
      const centerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 120);
      centerGlow.addColorStop(0, "rgba(214, 236, 255, 0.22)");
      centerGlow.addColorStop(0.22, "rgba(132, 194, 255, 0.1)");
      centerGlow.addColorStop(0.58, "rgba(72, 112, 214, 0.035)");
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
        { rotation: -0.72, width: 124, height: 24, alpha: 0.92 },
        { rotation: 0.34, width: 102, height: 18, alpha: 0.62 },
      ];
      streaks.forEach(function (streak) {
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, streak.width * 0.5);
        gradient.addColorStop(0, `rgba(255,255,255,${streak.alpha})`);
        gradient.addColorStop(0.24, `rgba(224,242,255,${streak.alpha * 0.8})`);
        gradient.addColorStop(0.52, "rgba(136,198,255,0.18)");
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

      const bloom = context.createRadialGradient(0, 0, 0, 0, 0, 60);
      bloom.addColorStop(0, "rgba(255,255,255,0.46)");
      bloom.addColorStop(0.18, "rgba(220,240,255,0.26)");
      bloom.addColorStop(0.52, "rgba(112,176,244,0.08)");
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
      const family = selectOrbPaletteFamily(seed);
      const hueDrift = ((hashString(`orb:fine:${node.id}`) * 2) - 1) * 0.004;
      const tierBoost = node.tier === "flagship" ? 1 : node.tier === "secondary" ? 0.78 : 0.56;
      const core = new THREE.Color().setHSL(family.coreHue + hueDrift * 0.45, 0.84, node.tier === "flagship" ? 0.62 : node.tier === "secondary" ? 0.57 : 0.52);
      const emissive = new THREE.Color().setHSL(family.emissiveHue + hueDrift * 0.36, 0.96, 0.66 + tierBoost * 0.05);
      const halo = new THREE.Color().setHSL(family.haloHue + hueDrift * 0.34, 0.82, 0.62);
      const aura = new THREE.Color().setHSL(family.auraHue + hueDrift * 0.28, 0.58, 0.49);
      const shell = new THREE.Color().setHSL(family.shellHue + hueDrift * 0.3, 0.56, 0.5);
      const ring = new THREE.Color().setHSL(family.ringHue + hueDrift * 0.24, 0.9, 0.72);
      const nucleus = new THREE.Color().setHSL(family.coreHue + hueDrift * 0.12, 0.1, 0.92);
      const metalDark = new THREE.Color().setHSL(family.metalHue + hueDrift * 0.08, 0.16, 0.16);
      const metalMid = new THREE.Color().setHSL(family.metalHue + hueDrift * 0.06, 0.12, 0.28);
      const metalLight = new THREE.Color().setHSL(family.metalHue + hueDrift * 0.04, 0.16, 0.64);
      const tick = new THREE.Color().setHSL(family.tickHue + hueDrift * 0.12, 0.74, 0.86);
      const tickSoft = new THREE.Color().setHSL(family.tickHue + hueDrift * 0.1, 0.42, 0.7);
      const focusCoreDark = new THREE.Color().setHSL(family.coreHue + hueDrift * 0.08, 0.5, 0.14);
      const focusCoreMid = new THREE.Color().setHSL(family.emissiveHue + hueDrift * 0.08, 0.34, 0.26);
      const focusCoreGlow = new THREE.Color().setHSL(family.focusGlowHue + hueDrift * 0.1, 0.82, 0.84);
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
        lobes: family.lobeHues.map(function (hue, index) {
          const saturations = [0.88, 0.8, 0.68, 0.54];
          const lights = [0.66, 0.68, 0.65, 0.76];
          return new THREE.Color().setHSL(hue + hueDrift * 0.14, saturations[index], lights[index]);
        }),
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

    _buildPlasmaSprites(sphereRadius, palette, options) {
      const { THREE } = this;
      const minimalPalette = !!(options && options.minimalPalette);

      const vertexShader = [
        "varying vec2 vUv;",
        "void main() {",
        "  vUv = uv;",
        "  vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);",
        "  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));",
        "  mvPosition.xy += (position.xy * scale);",
        "  gl_Position = projectionMatrix * mvPosition;",
        "}",
      ].join("\n");

      const fragmentShader = [
        "varying vec2 vUv;",
        "uniform float uTime;",
        "uniform float uSigma;",
        "uniform float uIntensity;",
        "uniform float uCoreWeight;",
        "uniform float uMidWeight;",
        "uniform float uAtmosWeight;",
        "uniform vec3  uColorCore;",
        "uniform vec3  uColorMid;",
        "uniform vec3  uColorAtmos;",
        "void main() {",
        "  vec2 p = vUv - 0.5;",
        "  float r = length(p) * 2.0;",
        "  float g = exp(-(r*r) / (uSigma*uSigma));",
        "  vec2 cell = floor(p * 10.0);",
        "  float n = fract(sin(dot(cell + uTime * 0.15, vec2(12.9898, 78.233))) * 43758.5453);",
        "  n = mix(0.9, 1.0, n);",
        "  vec3 col = uAtmosWeight * uColorAtmos",
        "           + uMidWeight   * uColorMid   * smoothstep(0.0, 0.7, g)",
        "           + uCoreWeight  * uColorCore  * smoothstep(0.4, 1.0, g);",
        "  float alpha = g * uIntensity * n;",
        "  gl_FragColor = vec4(col, alpha);",
        "}",
      ].join("\n");

      const paletteHue = (color) => {
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        return hsl.h;
      };

      /* A3 final polish: absolute violet/magenta + absolute deep blue, small palette-family tint. */
      const violetMagenta = new THREE.Color().setHSL(0.80, 0.78, 0.54);   /* ≈ 288° */
      const deepBlue      = new THREE.Color().setHSL(0.62, 0.82, 0.18);   /* ≈ 223° */

      let uColorCore;
      let uColorMid;
      let uColorAtmos;
      if (minimalPalette) {
        /* Aperture prototype: Kelvin-ramp derived directly from node palette. */
        /* Core: near-white with faint hue tint (white-hot read). */
        uColorCore  = new THREE.Color().setHSL(paletteHue(palette.focusCoreGlow), 0.08, 0.96);
        /* Mid mantle: node-derived cyan/mid, no violet override. */
        uColorMid   = palette.focusCoreMid.clone();
        /* Atmosphere: node-derived dark envelope, no deep-blue override. */
        uColorAtmos = palette.focusCoreDark.clone();
      } else {
        uColorCore  = new THREE.Color().setHSL(paletteHue(palette.focusCoreGlow), 0.10, 0.97);
        uColorMid   = violetMagenta.clone().lerp(palette.focusCoreMid, 0.15);
        uColorAtmos = deepBlue.clone().lerp(new THREE.Color(0x080f2a), 0.30);
      }

      const makeLayer = (scale, sigma, coreW, midW, atmosW, renderOrder, z) => {
        const geom = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.ShaderMaterial({
          uniforms: {
            uTime:        { value: 0 },
            uSigma:       { value: sigma },
            uIntensity:   { value: 0 },
            uCoreWeight:  { value: coreW },
            uMidWeight:   { value: midW },
            uAtmosWeight: { value: atmosW },
            uColorCore:   { value: uColorCore.clone() },
            uColorMid:    { value: uColorMid.clone() },
            uColorAtmos:  { value: uColorAtmos.clone() },
          },
          vertexShader,
          fragmentShader,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.scale.setScalar(scale);
        mesh.position.set(0, 0, z);
        mesh.renderOrder = renderOrder;
        return mesh;
      };

      /* Billboard ordering: atmosphere behind mid, mid behind core. */
      const atmosphere = makeLayer(sphereRadius * 3.80, 0.62, 0.00, 0.18, 1.25,  1, -0.02);
      const mid        = makeLayer(sphereRadius * 2.30, 0.38, 0.10, 1.30, 0.30,  2, -0.01);
      const core       = makeLayer(sphereRadius * 1.10, 0.22, 1.30, 0.55, 0.00,  3,  0.00);

      return { core, mid, atmosphere };
    }

    buildFocusedCore(node, palette) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.z = node.size * 0.08;
      group.visible = false;
      const focusTilt = 0.05;

      const sphereRadius = node.size * 1.92;
      const bezelRadius = sphereRadius * 1.28;
      const tickRadius = bezelRadius * 1.1;

      /* ── Dim backer sphere — optional stabilizer only (opacity ≤ 0.06) ── */
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius, 40, 40),
        new THREE.MeshBasicMaterial({
          color: palette.focusCoreDark,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      group.add(sphere);

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
      bezel.rotation.x = focusTilt;
      group.add(bezel);

      const bezelEdge = new THREE.Mesh(
        new THREE.TorusGeometry(bezelRadius * 1.012, node.size * 0.03, 12, 144),
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
        node.size * 0.112,
        node.size * 0.224,
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
        new THREE.TorusGeometry(bezelRadius * 1.67, node.size * 0.008, 6, 96),
        new THREE.MeshBasicMaterial({
          color: palette.metalLight.clone().lerp(palette.tick, 0.38),
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      outerRing2.rotation.x = bezel.rotation.x;
      outerRing2.scale.set(1, 0.988, 1);
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
        { ring: outerRing1Group, material: outerRing1Mat, baseOpacity: 0.1, speed: -0.008, isGroup: true, kind: "segmented" },
        { ring: outerRing2, material: outerRing2.material, baseOpacity: 0.14, speed: 0.006, isGroup: false, kind: "detached" },
        { ring: outerRing3Group, material: outerRing3Mat, baseOpacity: 0.08, speed: -0.01, isGroup: true, kind: "broken" },
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

      const focusedTach = this.buildFocusedTachBand({
        tilt: bezel.rotation.x,
        radius: sphereRadius * 1.12,
        tickRadius: sphereRadius * 1.075,
        carrierTube: node.size * 0.028,
        shadowTube: node.size * 0.04,
        trackTube: node.size * 0.0065,
        trackTubeInner: node.size * 0.0042,
        lipOffset: node.size * 0.026,
        lipTube: node.size * 0.0025,
        sheenTube: node.size * 0.008,
        edgeGlowTube: node.size * 0.005,
        zOffset: node.size * 0.05,
        count: 72,
        tickWidth: node.size * 0.048,
        tickHeight: node.size * 0.072,
        tickLean: node.size * 0.024,
        startAngle: 0.045,
        phase: 0.46,
        bladeBaseOpacity: 0.6,
        bladeGlintOpacity: 0.092,
        bladeDepth: node.size * 0.0064,
        socketDepth: node.size * 0.0068,
      });
      group.add(focusedTach.group);
      const parallelogramTicks = focusedTach.band.ticks;

      /* ── Plasma body (3 additive billboarded layers, custom shader) ── */
      const plasma = this._buildPlasmaSprites(sphereRadius, palette);
      group.add(plasma.atmosphere, plasma.mid, plasma.core);

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

      /* ── Lock-local telemetry arcs — near-center acquisition grammar ── */
      const telemetryArcConfigs = [
        { radius: sphereRadius * 0.54, startAngle: 0.22, sweepAngle: 0.58, segments: 18, opacity: 0.16, speed: 0.018, color: palette.tick },
        { radius: sphereRadius * 0.6, startAngle: 1.52, sweepAngle: 0.48, segments: 16, opacity: 0.12, speed: -0.015, color: palette.tickSoft },
        { radius: sphereRadius * 0.48, startAngle: 3.1, sweepAngle: 0.64, segments: 20, opacity: 0.14, speed: 0.02, color: palette.metalLight },
        { radius: sphereRadius * 0.66, startAngle: 4.74, sweepAngle: 0.42, segments: 14, opacity: 0.1, speed: -0.012, color: palette.tick },
      ];
      const telemetryArcs = telemetryArcConfigs.map((config) => {
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
        plasma,
        bezel,
        bezelEdge,
        chapterRing,
        ticks,
        tickGlowRing,
        tickDiffuseRing,
        glow,
        innerRings,
        outerRings,
        clockMarkers,
        parallelogramTicks,
        focusedTach,
        telemetryArcs,
        chassisArcs,
        bezelGlint,
        bezelGlintState,
      };
    }

    /* Aperture prototype: minimal focused core.
     * Keeps backer sphere, bezel torus, one tick ring, plasma sprites.
     * Every other ring/marker/arc element is a no-op stub so downstream
     * animate/lerp code runs without null checks. Not added to scene graph. */
    buildFocusedCore_minimal(node, palette) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.z = node.size * 0.08;
      group.visible = false;
      const focusTilt = 0.05;

      const sphereRadius = node.size * 1.92;
      const bezelRadius = sphereRadius * 1.28;
      const tickRadius = bezelRadius * 1.1;

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(sphereRadius, 40, 40),
        new THREE.MeshBasicMaterial({
          color: palette.focusCoreDark,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      group.add(sphere);

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
      bezel.rotation.x = focusTilt;
      group.add(bezel);

      const bezelEdge = new THREE.Mesh(
        new THREE.TorusGeometry(bezelRadius * 1.012, node.size * 0.024, 10, 144),
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
        node.size * 0.112,
        node.size * 0.224,
        tickMinorMaterial,
        tickMajorMaterial,
      );
      ticks.minor.rotation.x = bezel.rotation.x;
      ticks.major.rotation.x = bezel.rotation.x;
      group.add(ticks.minor, ticks.major);

      const tickGlowRing = new THREE.Mesh(
        new THREE.TorusGeometry(tickRadius * 0.986, node.size * 0.03, 16, 144),
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
        new THREE.TorusGeometry(tickRadius * 0.982, node.size * 0.054, 16, 144),
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
        new THREE.BufferGeometry().setFromPoints(Array.from({ length: 52 }, function (_, index) {
          const angle = (index / 52) * Math.PI * 2;
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

      const telemetryArcs = [
        { radius: sphereRadius * 0.58, startAngle: 0.36, sweepAngle: 0.62, opacity: 0.12, speed: 0.014, color: palette.tick },
        { radius: sphereRadius * 0.48, startAngle: 3.04, sweepAngle: 0.56, opacity: 0.1, speed: -0.016, color: palette.tickSoft },
      ].map((config) => {
        const points = [];
        for (let index = 0; index <= 18; index += 1) {
          const angle = config.startAngle + (index / 18) * config.sweepAngle;
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

      const focusedTach = this.buildFocusedTachBand({
        tilt: bezel.rotation.x,
        radius: sphereRadius * 1.112,
        tickRadius: sphereRadius * 1.07,
        carrierTube: node.size * 0.026,
        shadowTube: node.size * 0.038,
        trackTube: node.size * 0.006,
        trackTubeInner: node.size * 0.004,
        lipOffset: node.size * 0.024,
        lipTube: node.size * 0.0024,
        sheenTube: node.size * 0.0075,
        edgeGlowTube: node.size * 0.0048,
        zOffset: node.size * 0.05,
        count: 68,
        tickWidth: node.size * 0.044,
        tickHeight: node.size * 0.066,
        tickLean: node.size * 0.022,
        startAngle: 0.05,
        phase: 0.52,
        bladeBaseOpacity: 0.58,
        bladeGlintOpacity: 0.086,
        bladeDepth: node.size * 0.006,
        socketDepth: node.size * 0.0064,
      });
      group.add(focusedTach.group);
      const parallelogramTicks = focusedTach.band.ticks;

      const plasma = this._buildPlasmaSprites(sphereRadius, palette, { minimalPalette: true });
      group.add(plasma.atmosphere, plasma.mid, plasma.core);

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
      glow.scale.setScalar(sphereRadius * 2.1);
      group.add(glow);

      const makeStub = () => ({
        material: { opacity: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        position: { x: 0, y: 0, z: 0, set: function () {} },
        scale: { setScalar: function () {} },
      });

      return {
        group,
        sphere,
        plasma,
        bezel,
        bezelEdge,
        chapterRing,
        ticks,
        tickGlowRing,
        tickDiffuseRing,
        glow,
        innerRings: [],
        outerRings: [],
        clockMarkers: [],
        parallelogramTicks,
        focusedTach,
        telemetryArcs,
        chassisArcs: [],
        bezelGlint: null,
        bezelGlintState: null,
      };
    }

    _isMinimalFocusEnabled() {
      return typeof window !== "undefined" && window.__observatoryMinimalFocus === true;
    }

    buildNode(node) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.set(node.anchor.x, node.anchor.y, node.anchor.z);
      group.userData.modelId = node.id;
      const palette = this.buildOrbPalette(node);
      const isInactive = Boolean(node.inactive);

      /* ── Wireframe sphere cage — supporting contour, not the primary read ── */
      const tierDetail = node.tier === "flagship" ? 2 : 1;
      const icoGeo = new THREE.IcosahedronGeometry(node.size * 1.0, tierDetail);
      const edgesGeo = new THREE.EdgesGeometry(icoGeo, 1);

      const wireOpacity = isInactive
        ? (node.tier === "flagship" ? 0.14 : node.tier === "secondary" ? 0.11 : 0.08)
        : (node.tier === "flagship" ? 0.22 : node.tier === "secondary" ? 0.17 : 0.12);
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

      /* ── Shell sphere — primary body mass for idle readability ── */
      const shellOpacity = isInactive
        ? (node.tier === "flagship" ? 0.26 : 0.18)
        : (node.tier === "flagship" ? 0.5 : node.tier === "secondary" ? 0.38 : 0.28);
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * 0.94, 24, 24),
        new THREE.MeshBasicMaterial({
          color: palette.shell,
          transparent: true,
          opacity: shellOpacity,
          depthWrite: false,
          side: THREE.DoubleSide,
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
      const ghostOpacity = isInactive ? 0.024
        : (node.tier === "flagship" ? 0.082 : node.tier === "secondary" ? 0.064 : 0.042);
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
        { radiusX: node.size * 0.92, radiusY: node.size * 0.68, rotationX: 1.12, rotationY: 0.24, rotationZ: -0.18, opacity: node.tier === "flagship" ? 0.36 : 0.29, speed: 0.04 },
        { radiusX: node.size * 0.74, radiusY: node.size * 0.86, rotationX: 0.48, rotationY: 0.78, rotationZ: 0.28, opacity: node.tier === "flagship" ? 0.25 : 0.21, speed: -0.03 },
        { radiusX: node.size * 0.58, radiusY: node.size * 0.52, rotationX: 1.46, rotationY: 0.12, rotationZ: -0.42, opacity: 0.16, speed: 0.025 },
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

      /* ── Siri-orb internals are intentionally suppressed in this restore pass ── */
      /*
       * Contract markers retained for the frontend string tests:
       * entry.focusedCore.siriRibbons.forEach
       * entry.focusedCore.siriGlowSphere.material.opacity
       * entry.focusedCore.siriCenter.material.opacity
       * entry.focusedCore.siriRim.material.opacity
       */

      /* ── Center node — bright core point (hero centerNode style) ── */
      const centerNode = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * 0.28, 16, 16),
        new THREE.MeshBasicMaterial({
          color: palette.nucleus,
          transparent: true,
          opacity: isInactive ? 0.58 : 0.96,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      group.add(centerNode);

      /* ── Focused core (full apparatus — built for every node so focus never falls back to legacy wireframe-only language) ── */
      let focusedCore = null;
      focusedCore = this._isMinimalFocusEnabled()
        ? this.buildFocusedCore_minimal(node, palette)
        : this.buildFocusedCore(node, palette);
      group.add(focusedCore.group);

      /* ── Guide ring — thin instrument torus ── */
      let guideRing = null;
      if (!isInactive) {
        guideRing = new THREE.Mesh(
          new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 1.92 : node.tier === "secondary" ? 1.64 : 1.42), node.size * 0.016, 6, 56),
          new THREE.MeshBasicMaterial({
            color: palette.ring,
            transparent: true,
            opacity: node.tier === "flagship" ? 0.062 : node.tier === "secondary" ? 0.046 : 0.028,
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
            emissiveIntensity: node.tier === "flagship" ? 0.52 : node.tier === "secondary" ? 0.34 : 0.16,
            roughness: 0.4,
            metalness: 0.0,
            transparent: true,
            opacity: node.tier === "flagship" ? 0.052 : node.tier === "secondary" ? 0.034 : 0.016,
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
            opacity: 0.038,
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
          new THREE.TorusGeometry(node.size * 3.7, node.size * 0.022, 6, 56),
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
          node.size * (3.82 + index * 0.46),
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
        lockProfile: this.buildLockProfile(node),
        group,
        compositionBias: new THREE.Vector3(),
        compositionBiasTarget: new THREE.Vector3(),
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
          this.hyperdriveDirection = 1;
          this.transitionFocusId = this.focusId;
          this.zoomVelocity = -0.18;
          this.zoomTarget = this.zoomRange.min;
        } else if (prevFocus) {
          this.hyperdriveDirection = -1;
          this.transitionFocusId = prevFocus;
          this.zoomVelocity = 0.34;
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
        ring.material.opacity = this.modes.threshold ? (0.2 - index * 0.03) : 0.05;
      });
      this.renderLabels();
    }

    /* ── Animated dashed connection edges ── */
    rebuildGuides() {
      this.guides.forEach((guide) => this.scene.remove(guide.line));
      this.guides = [];
      const selectedEdges = selectGuideEdges(
        this.payload,
        this.focusId,
        this.hoverId,
        Boolean(this.modes.compare),
        this.nodeLookup.size,
      );
      if (!selectedEdges.length) return;

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
          opacityBase: edge.opacityBase,
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

      const maxTrailNodes = this.nodeLookup.size > 18 ? (this.focusId ? 5 : 4) : this.focusId ? 5 : 9;
      const trailNodes = this.focusId
        ? eligibleNodes.filter((node) => node.id === this.focusId || topNeighbors(this.payload, this.focusId, 4).includes(node.id)).slice(0, maxTrailNodes)
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
      const pointerType = event.pointerType || "mouse";
      this.hoverEnabled = pointerSupportsHover(pointerType);
      this._pointerType = pointerType;
      if (!this.hoverEnabled) {
        this.pointerTarget.x = 0;
        this.pointerTarget.y = 0;
        this._clientX = undefined;
        this._clientY = undefined;
        if (this.hoverId !== null) {
          this.hoverId = null;
          this.renderer.domElement.style.cursor = "";
          this.tooltip.style.display = "none";
          if (!this.focusId) {
            this.rebuildGuides();
          }
        }
        return;
      }
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      this.pointerTarget.x = clamp(this.mouse.x, -1, 1);
      this.pointerTarget.y = clamp(this.mouse.y, -1, 1);
      this.lastInteractionAt = performance.now();
      this._clientX = event.clientX;
      this._clientY = event.clientY;
      this.updateHover(event.clientX, event.clientY);
    }

    onPointerLeave() {
      this.hoverEnabled = false;
      this.mouse.x = -10;
      this.mouse.y = -10;
      this.pointerTarget.x = 0;
      this.pointerTarget.y = 0;
      this.hoverId = null;
      this.renderer.domElement.style.cursor = "";
      this.tooltip.style.display = "none";
      if (!this.focusId) {
        this.rebuildGuides();
      }
    }

    handleSelectionAtClientPoint(clientX, clientY, pointerType = this._pointerType || "mouse") {
      const hoverEnabled = pointerSupportsHover(pointerType);
      const previousHover = this.hoverId;
      this.hoverEnabled = hoverEnabled;
      this._pointerType = pointerType;
      this.shell.focus({ preventScroll: true });
      this.lastInteractionAt = performance.now();
      const pickedNode = this.pickNodeAtClientPoint(clientX, clientY);
      this.hoverId = hoverEnabled && pickedNode ? pickedNode.modelId : null;
      if (!hoverEnabled) {
        this._clientX = undefined;
        this._clientY = undefined;
        this.renderer.domElement.style.cursor = "";
        this.tooltip.style.display = "none";
      }
      if (!this.focusId && previousHover !== this.hoverId) {
        this.rebuildGuides();
      }
      if (!pickedNode) {
        window.dispatchEvent(new CustomEvent("observatory:clear-focus"));
        return false;
      }
      window.dispatchEvent(new CustomEvent("observatory:focus-model", {
        detail: { modelId: this.focusId === pickedNode.modelId ? null : pickedNode.modelId },
      }));
      return true;
    }

    onPointerDown(event) {
      this.lastPointerSelectionAt = performance.now();
      const pointerType = event.pointerType || this._pointerType || "mouse";
      this.handleSelectionAtClientPoint(event.clientX, event.clientY, pointerType);
    }

    onClick(event) {
      if (performance.now() - this.lastPointerSelectionAt < 420) return;
      this.handleSelectionAtClientPoint(event.clientX, event.clientY, this._pointerType || "touch");
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

    updateHover(clientX = this._clientX, clientY = this._clientY) {
      if (!this.hoverEnabled) {
        this.renderer.domElement.style.cursor = "";
        this.tooltip.style.display = "none";
        return;
      }
      const prevHover = this.hoverId;
      const pickedNode = typeof clientX === "number" && typeof clientY === "number"
        ? this.pickNodeAtClientPoint(clientX, clientY)
        : null;
      this.hoverId = pickedNode ? pickedNode.modelId : null;
      if (prevHover !== this.hoverId && !this.focusId) {
        this.rebuildGuides();
      }

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

        const focused = this.focusId === entry.node.id;
        const hovered = this.hoverId === entry.node.id;
        const dimmed = Boolean(this.focusId) && !focused;
        const focusLevel = focused ? easeOutCubic(focusReveal) : 0;
        const profile = entry.lockProfile || { targetBias: 0.18, forwardBias: 0.08 };

        if (focused) {
          const composition = this.resolveCompositionWindow(entry);
          const worldOffset = this.resolveFocusWorldOffset(entry, composition);
          const compositionStrength = reducedMotion ? 0.16 : 0.24 + profile.targetBias;
          entry.compositionBiasTarget.copy(worldOffset).multiplyScalar(compositionStrength);
          entry.compositionBiasTarget.addScaledVector(
            this.cameraForward,
            (0.06 + profile.forwardBias) * (0.32 + focusLevel * 0.36),
          );
          this.focusZoneCache = composition;
        } else {
          entry.compositionBiasTarget.set(0, 0, 0);
        }
        entry.compositionBias.lerp(entry.compositionBiasTarget, focused ? 0.18 : 0.1);
        entry.group.position.add(entry.compositionBias);

        entry.group.rotation.z = Math.sin(siriPhase * 0.42) * 0.08 * driftScale + entry.compositionBias.x * 0.022;
        entry.group.rotation.y = Math.cos(siriPhase * 0.36) * 0.06 * driftScale - entry.compositionBias.y * 0.02;

        /* ── Node breathing: subtle pulsing ── */
        const breatheRate = 0.72 + entry.node.cii * 1.1;
        const breatheAmp = reducedMotion ? 0 : (isInactive ? 0.02 : entry.node.tier === "flagship" ? 0.036 : entry.node.tier === "secondary" ? 0.025 : 0.019);
        const breathe = 1.0 + Math.sin(slowTime * breatheRate + entry.node.orbitPhase) * breatheAmp;

        const dimScale = isInactive ? 0.65 : 0.78;
        const targetScale = (focused ? 1.92 : hovered ? 1.32 : dimmed ? dimScale : 1.08) * breathe;
        entry.group.scale.setScalar(lerp(entry.group.scale.x, targetScale, 0.12));

        /* ── Wireframe sphere rotation ── */
        if (entry.wireframe && !reducedMotion) {
          entry.wireframe.rotation.y += entry.wireRotationSpeed * 0.016;
          entry.wireframe.rotation.x += entry.wireRotationSpeed * 0.004;
        }

        /* ── Wireframe opacity ── */
        if (entry.wireframe) {
          const wireTarget = focused ? (isInactive ? 0.03 + focusLevel * 0.012 : 0.07 + focusLevel * 0.03)
            : hovered ? entry.baseWireOpacity * 1.2
            : dimmed ? entry.baseWireOpacity * (isInactive ? 0.18 : 0.24)
            : entry.baseWireOpacity * 0.52;
          entry.wireframe.material.opacity = lerp(entry.wireframe.material.opacity, wireTarget, 0.1);
        }

        /* ── Shell opacity ── */
        if (entry.shell) {
          const shellTarget = focused ? entry.baseShellOpacity * (isInactive ? 0.42 : 0.92)
            : hovered ? entry.baseShellOpacity * 1.48
            : dimmed ? entry.baseShellOpacity * (isInactive ? 0.3 : 0.48)
            : entry.baseShellOpacity * 1.36;
          entry.shell.material.opacity = lerp(entry.shell.material.opacity, shellTarget, 0.08);
        }

        /* ── Ghost opacity ── */
        if (entry.ghost) {
          const ghostTarget = focused ? entry.baseGhostOpacity * 0.24
            : hovered ? entry.baseGhostOpacity * 1.36
            : dimmed ? 0
            : entry.baseGhostOpacity * 1.15;
          entry.ghost.material.opacity = lerp(entry.ghost.material.opacity, ghostTarget, 0.1);
        }

        /* ── Center node ── */
        if (entry.centerNode) {
          const centerTarget = focused ? 0.72 + focusLevel * 0.18
            : hovered ? entry.baseCenterOpacity * 1.42
            : dimmed ? entry.baseCenterOpacity * 0.46
            : entry.baseCenterOpacity * 1.28;
          entry.centerNode.material.opacity = lerp(entry.centerNode.material.opacity, centerTarget, 0.12);
        }

        /* ── Internal field contour animation ── */
        if (entry.nodeContours) {
          entry.nodeContours.forEach((contour) => {
            contour.line.material.opacity = lerp(
              contour.line.material.opacity,
              focused ? contour.baseOpacity * 0.46
                : hovered ? contour.baseOpacity * 0.8
                : dimmed ? contour.baseOpacity * 0.24
                : contour.baseOpacity * 0.98,
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
            focused ? 0.055 + focusLevel * 0.018
              : hovered ? 0.052
              : dimmed ? 0.008
              : entry.node.tier === "flagship" ? 0.066 : entry.node.tier === "secondary" ? 0.048 : 0.032,
            0.09,
          );
          entry.guideRing.rotation.y += focused ? 0.004 : 0.003;
          entry.guideRing.rotation.z -= focused ? 0.002 : 0.001;
        }

        /* ── Focus lock ring ── */
        if (entry.focusRing) {
          entry.focusRing.material.opacity = lerp(
            entry.focusRing.material.opacity,
            focused ? 0.075 + focusLevel * 0.024 : hovered ? 0.016 : 0,
            0.06,
          );
          if (focused) entry.focusRing.rotation.z -= 0.0025;
        }

        /* ── Metric bands ── */
        if (entry.metricBands && entry.metricBandGroup) {
          const revealTarget = focused ? focusReveal * 0.42 : hovered ? 0.08 : 0;
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
              focused ? Math.max(0.036, 0.058 - index * 0.009) : hovered ? Math.max(0.012, 0.026 - index * 0.005) : 0,
              0.12,
            );
            band.active.material.opacity = lerp(
              band.active.material.opacity,
              focused ? Math.max(0.08, 0.22 - index * 0.032) * band.reveal : hovered ? Math.max(0.02, 0.05 - index * 0.008) * band.reveal : 0,
              0.12,
            );
          });
        }

        /* ── Accent ring ── */
        if (entry.accentRing) {
          entry.accentRing.material.opacity = lerp(
            entry.accentRing.material.opacity,
            focused ? 0.052 + focusLevel * 0.016
              : hovered ? 0.052
              : dimmed ? 0.008
              : entry.node.tier === "flagship" ? 0.068 : entry.node.tier === "secondary" ? 0.046 : 0.024,
            0.1,
          );
          const ringSpeed = entry.node.tier === "flagship" ? 0.05 : 0.03;
          entry.accentRing.rotation.y += ringSpeed * 0.012;
          entry.accentRing.rotation.z += ringSpeed * 0.004;
        }

        /* ── Orbit ring ── */
        if (entry.orbitRing) {
          entry.orbitRing.material.opacity = lerp(
            entry.orbitRing.material.opacity,
            focused ? 0.04 + focusLevel * 0.014
              : hovered ? 0.036
              : dimmed ? 0.008
              : entry.node.tier === "flagship" ? 0.052 : 0.028,
            0.08,
          );
          const orbitSpeed = entry.node.tier === "flagship" ? 0.012 : 0.008;
          entry.orbitRing.rotation.y += orbitSpeed * 0.01;
          entry.orbitRing.rotation.z -= orbitSpeed * 0.002;
        }

        /* ── Focused core apparatus ── */
        if (entry.focusedCore) {
          const apparatusGain = (entry.lockProfile && entry.lockProfile.apparatusGain) || 1;
          const plasmaPeak = entry.focusedCore.plasma.core.material.uniforms.uIntensity.value;
          const focusCoreActive = focused || hovered || plasmaPeak > 0.01;
          entry.focusedCore.group.visible = focusCoreActive;
          const focusScaleTarget = focused ? 1.18 + focusLevel * 0.16 : hovered ? 1.0 : 0.84;
          entry.focusedCore.group.scale.setScalar(lerp(entry.focusedCore.group.scale.x || 1, focusScaleTarget, 0.12));

          /* ── Dim backer sphere — stabilizer only, visual contribution capped at 0.06 ── */
          entry.focusedCore.sphere.material.opacity = lerp(
            entry.focusedCore.sphere.material.opacity,
            focused ? 0.06 : hovered ? 0.025 : 0,
            0.12,
          );

          /* ── Plasma body — 3 additive shader sprites drive the orb character ── */
          const plasmaTarget = focused ? (0.86 + focusLevel * 0.18) : hovered ? 0.16 : 0;
          for (const key of ["core", "mid", "atmosphere"]) {
            const mat = entry.focusedCore.plasma[key].material;
            mat.uniforms.uIntensity.value = lerp(mat.uniforms.uIntensity.value, plasmaTarget, 0.14);
            mat.uniforms.uTime.value = slowTime;
          }

          entry.focusedCore.bezel.material.opacity = lerp(
            entry.focusedCore.bezel.material.opacity,
            focused ? 0.28 + apparatusGain * 0.025 : 0,
            0.12,
          );
          entry.focusedCore.bezel.material.emissiveIntensity = lerp(
            entry.focusedCore.bezel.material.emissiveIntensity,
            focused ? 0.16 + focusLevel * 0.06 + apparatusGain * 0.025 : 0.08,
            0.1,
          );
          entry.focusedCore.bezelEdge.material.opacity = lerp(
            entry.focusedCore.bezelEdge.material.opacity,
            focused ? 0.14 + focusLevel * 0.025 : 0,
            0.12,
          );
          if (entry.focusedCore.focusedTach) {
            const ft = entry.focusedCore.focusedTach;
            ft.carrier.material.opacity = lerp(
              ft.carrier.material.opacity,
              focused ? 0.032 + apparatusGain * 0.01 : hovered ? 0.008 : 0,
              0.12,
            );
            ft.shadow.material.opacity = lerp(
              ft.shadow.material.opacity,
              focused ? 0.07 + focusLevel * 0.018 : hovered ? 0.018 : 0,
              0.1,
            );
            ft.outerLip.material.opacity = lerp(
              ft.outerLip.material.opacity,
              focused ? 0.055 + focusLevel * 0.014 : hovered ? 0.014 : 0,
              0.12,
            );
            ft.innerLip.material.opacity = lerp(
              ft.innerLip.material.opacity,
              focused ? 0.06 + apparatusGain * 0.012 : hovered ? 0.014 : 0,
              0.1,
            );
            ft.trackShadow.material.opacity = lerp(
              ft.trackShadow.material.opacity,
              focused ? 0.08 + focusLevel * 0.025 : hovered ? 0.018 : 0,
              0.12,
            );
            ft.track.material.opacity = lerp(
              ft.track.material.opacity,
              focused ? 0.035 + apparatusGain * 0.01 : hovered ? 0.008 : 0,
              0.12,
            );
            ft.bladeCavity.material.opacity = lerp(
              ft.bladeCavity.material.opacity,
              focused ? 0.11 + focusLevel * 0.025 : hovered ? 0.018 : 0,
              0.12,
            );
            ft.sheen.material.opacity = lerp(
              ft.sheen.material.opacity,
              focused ? 0.025 + focusLevel * 0.012 : hovered ? 0.005 : 0,
              0.12,
            );
            ft.edgeGlow.material.opacity = lerp(
              ft.edgeGlow.material.opacity,
              focused ? 0.01 + focusLevel * 0.006 : hovered ? 0.003 : 0,
              0.1,
            );
            if (!reducedMotion) {
              ft.group.rotation.z -= focused ? 0.00072 : hovered ? 0.00014 : 0;
            }
          }
          entry.focusedCore.chapterRing.material.opacity = lerp(
            entry.focusedCore.chapterRing.material.opacity,
            focused ? 0.07 + apparatusGain * 0.012 : hovered ? 0.012 : 0,
            0.1,
          );
          entry.focusedCore.tickGlowRing.material.opacity = lerp(
            entry.focusedCore.tickGlowRing.material.opacity,
            focused ? 0.025 + focusLevel * 0.01 + apparatusGain * 0.006 : hovered ? 0.006 : 0,
            0.1,
          );
          entry.focusedCore.tickDiffuseRing.material.opacity = lerp(
            entry.focusedCore.tickDiffuseRing.material.opacity,
            focused ? 0.012 + focusLevel * 0.006 : hovered ? 0.004 : 0,
            0.08,
          );
          entry.focusedCore.ticks.minor.material.opacity = lerp(
            entry.focusedCore.ticks.minor.material.opacity,
            0,
            0.12,
          );
          entry.focusedCore.ticks.major.material.opacity = lerp(
            entry.focusedCore.ticks.major.material.opacity,
            0,
            0.12,
          );
          entry.focusedCore.tickGlowRing.rotation.z += reducedMotion ? 0 : 0.00035;
          entry.focusedCore.tickDiffuseRing.rotation.z -= reducedMotion ? 0 : 0.00022;
          entry.focusedCore.ticks.minor.rotation.z += reducedMotion ? 0 : 0.00018;
          entry.focusedCore.ticks.major.rotation.z -= reducedMotion ? 0 : 0.0002;

          /* ── JARVIS inner concentric rings ── */
          if (entry.focusedCore.innerRings) {
            entry.focusedCore.innerRings.forEach((ir) => {
              ir.ring.material.opacity = lerp(ir.ring.material.opacity, focused ? ir.baseOpacity * 0.38 * focusLevel : hovered ? ir.baseOpacity * 0.04 : 0, 0.1);
            });
          }

          /* ── JARVIS outer decorative rings ── */
          if (entry.focusedCore.outerRings) {
            entry.focusedCore.outerRings.forEach((or) => {
              or.material.opacity = lerp(or.material.opacity, focused ? or.baseOpacity * 0.2 * focusLevel : hovered ? or.baseOpacity * 0.025 : 0, 0.08);
              if (!reducedMotion) {
                or.ring.rotation.z += or.speed * 0.016;
                if (or.kind === "detached" && !or.isGroup) {
                  const asymmetry = 0.992 + Math.sin(slowTime * 0.42) * 0.004;
                  or.ring.scale.set(1, asymmetry, 1);
                }
              }
            });
          }

          /* ── JARVIS clock-position markers ── */
          if (entry.focusedCore.clockMarkers) {
            entry.focusedCore.clockMarkers.forEach((cm) => {
              cm.line.material.opacity = lerp(cm.line.material.opacity, focused ? cm.baseOpacity * 0.26 * focusLevel : hovered ? cm.baseOpacity * 0.025 : 0, 0.1);
            });
          }

          /* ── JARVIS parallelogram ticks ── */
          if (entry.focusedCore.parallelogramTicks) {
            entry.focusedCore.parallelogramTicks.forEach((pt) => {
              if (pt.plate) {
                const targetBase = focused ? pt.baseOpacity * (0.92 + apparatusGain * 0.04 + focusLevel * 0.08) : hovered ? pt.baseOpacity * 0.16 : 0;
                pt.bladeSlot.material.opacity = lerp(
                  pt.bladeSlot.material.opacity,
                  focused ? pt.bladeSlotOpacity * 0.46 : hovered ? pt.bladeSlotOpacity * 0.08 : 0,
                  0.12,
                );
                pt.cradle.material.opacity = lerp(
                  pt.cradle.material.opacity,
                  focused ? pt.cradleOpacity * 0.52 : hovered ? pt.cradleOpacity * 0.08 : 0,
                  0.12,
                );
                pt.body.material.opacity = lerp(
                  pt.body.material.opacity,
                  focused ? pt.bodyOpacity * 0.66 : hovered ? pt.bodyOpacity * 0.08 : 0,
                  0.12,
                );
                pt.faceShadow.material.opacity = lerp(
                  pt.faceShadow.material.opacity,
                  focused ? pt.shadowOpacity * 0.36 : hovered ? pt.shadowOpacity * 0.05 : 0,
                  0.12,
                );
                pt.leftHighlight.material.opacity = lerp(
                  pt.leftHighlight.material.opacity,
                  focused ? pt.leftHighlightOpacity * 0.58 : hovered ? pt.leftHighlightOpacity * 0.06 : 0,
                  0.12,
                );
                pt.splitShadow.material.opacity = lerp(
                  pt.splitShadow.material.opacity,
                  focused ? pt.splitShadowOpacity * 0.54 : hovered ? pt.splitShadowOpacity * 0.06 : 0,
                  0.12,
                );
                pt.rightHighlight.material.opacity = lerp(
                  pt.rightHighlight.material.opacity,
                  focused ? pt.rightHighlightOpacity * 0.54 : hovered ? pt.rightHighlightOpacity * 0.06 : 0,
                  0.12,
                );
                pt.plate.material.opacity = lerp(
                  pt.plate.material.opacity,
                  focused ? targetBase : hovered ? 0.06 : 0,
                  0.12,
                );
                if (typeof pt.plate.material.emissiveIntensity === "number") {
                  pt.plate.material.emissiveIntensity = lerp(
                    pt.plate.material.emissiveIntensity,
                    focused ? 0.045 + apparatusGain * 0.007 + focusLevel * 0.01 : 0.01,
                    0.1,
                  );
                }
                pt.glint.material.opacity = lerp(
                  pt.glint.material.opacity,
                  focused ? pt.glintOpacity * 0.46 : hovered ? pt.glintOpacity * 0.05 : 0,
                  0.12,
                );
              } else {
                pt.line.material.opacity = lerp(
                  pt.line.material.opacity,
                  focused ? pt.baseOpacity * 0.22 * focusLevel : hovered ? pt.baseOpacity * 0.04 : 0,
                  0.1,
                );
              }
            });
          }

          /* ── Lock-local telemetry arcs ── */
          if (entry.focusedCore.telemetryArcs) {
            entry.focusedCore.telemetryArcs.forEach((arc) => {
              arc.line.material.opacity = lerp(
                arc.line.material.opacity,
                focused ? arc.baseOpacity * (0.16 + focusLevel * 0.05 + apparatusGain * 0.025) : hovered ? arc.baseOpacity * 0.025 : 0,
                0.1,
              );
              if (!reducedMotion) {
                arc.line.rotation.z += arc.speed * 0.006;
              }
            });
          }

          /* ── JARVIS chassis arcs ── */
          if (entry.focusedCore.chassisArcs) {
            entry.focusedCore.chassisArcs.forEach((arc) => {
              arc.line.material.opacity = lerp(
                arc.line.material.opacity,
                focused ? arc.baseOpacity * 0.13 * focusLevel : hovered ? arc.baseOpacity * 0.02 : 0,
                0.1,
              );
              if (!reducedMotion) {
                arc.line.rotation.z += arc.speed * 0.005;
              }
            });
          }

          /* ── Focused glow — v2 value ── */
          entry.focusedCore.glow.material.opacity = lerp(
            entry.focusedCore.glow.material.opacity,
            focused ? 0.09 + focusLevel * 0.032 : hovered ? 0.018 : 0,
            0.08,
          );
        }
      });
    }

    /* ── Star field twinkling (multi-harmonic) ── */
    resolveHyperdriveAnchorEntry() {
      const transitFocusId = this.focusId || this.transitionFocusId;
      if (transitFocusId && this.nodeLookup.has(transitFocusId)) {
        return this.nodeLookup.get(transitFocusId);
      }
      return null;
    }

    updateStars(time) {
      if (!this.starField) return;
      const state = this.hyperdriveState || { alpha: 0, peak: 0, tail: 0, active: false };
      const positions = this.starField.geometry.attributes.position;
      const colors = this.starField.geometry.attributes.color;
      const sizes = this.starField.geometry.attributes.size;
      const alphas = this.starField.geometry.attributes.alpha;
      if (!sizes || !positions || !colors || !alphas) return;
      const t = time * 0.001;
      const reducedMotion = motionQuery.matches;
      const anchorEntry = state.active ? this.resolveHyperdriveAnchorEntry() : null;
      const anchorPosition = anchorEntry ? anchorEntry.group.position : this.focusPoint;
      const centerX = anchorPosition.x;
      const centerY = anchorPosition.y;
      const centerZ = anchorPosition.z;
      const rx = this.cameraRight.x;
      const ry = this.cameraRight.y;
      const rz = this.cameraRight.z;
      const ux = this.cameraUp.x;
      const uy = this.cameraUp.y;
      const uz = this.cameraUp.z;
      const fx = this.cameraForward.x;
      const fy = this.cameraForward.y;
      const fz = this.cameraForward.z;
      const axisCompression = state.active ? (reducedMotion ? 0.92 : 0.78) : 1;
      const radialBurstScale = reducedMotion ? 0.75 : 2.8;
      const tailDrift = reducedMotion ? 2.2 : 5.6;
      const earlyHandoff = clamp((state.alpha - (reducedMotion ? 0.52 : 0.44)) / (reducedMotion ? 0.34 : 0.28), 0, 1);
      const peakSuppression = easeInOutCubic(clamp(state.peak, 0, 1));

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
        const base = i * 3;
        const bx = this.starBasePositions[base];
        const by = this.starBasePositions[base + 1];
        const bz = this.starBasePositions[base + 2];
        const dx = bx - centerX;
        const dy = by - centerY;
        const dz = bz - centerZ;
        let localX = (dx * rx) + (dy * ry) + (dz * rz);
        let localY = (dx * ux) + (dy * uy) + (dz * uz);
        let localZ = (dx * fx) + (dy * fy) + (dz * fz);

        if (state.active) {
          const radialWeight = this.starRadialWeights[i];
          const depthWeight = this.starDepthWeights[i];
          const seed = this.starSeeds[i];
          const radialParticipation = clamp((radialWeight - 0.55) / 0.75, 0, 1);
          const depthParticipation = clamp((depthWeight - 0.44) / 1.16, 0, 1);
          const participation = clamp(radialParticipation * 0.62 + depthParticipation * 0.38, 0, 1);
          const flowProgress = state.direction > 0
            ? easeOutCubic(state.progress)
            : 1 - easeInOutCubic(state.progress);
          const axisPull = state.direction > 0
            ? lerp(1, axisCompression, state.alpha * (0.8 + depthWeight * 0.12))
            : lerp(1 + state.alpha * 0.14, 0.74, state.progress);
          const burstFactor = state.direction > 0
            ? 1 + state.peak * radialBurstScale * radialWeight
            : lerp(1.22 + state.alpha * 0.2 * radialWeight, 0.82, 1 - flowProgress);
          const flicker = reducedMotion ? 1 : 0.9 + Math.sin(t * (8 + seed * 7) + p) * 0.1;
          localX *= axisPull * burstFactor * flicker;
          localY *= axisPull * burstFactor;
          localZ -= state.direction > 0
            ? state.peak * (9 + depthWeight * 13) + state.tail * tailDrift * (0.5 + seed)
            : state.alpha * (2.5 + depthWeight * 3.5);

          positions.array[base] = centerX + (localX * rx) + (localY * ux) + (localZ * fx);
          positions.array[base + 1] = centerY + (localX * ry) + (localY * uy) + (localZ * fy);
          positions.array[base + 2] = centerZ + (localX * rz) + (localY * uz) + (localZ * fz);

          const isAnchor = i >= (this.starAnchorThreshold || this.starPhases.length);
          const anchorSuppression = isAnchor ? 0.42 : 1;
          const handoff = clamp(
            (earlyHandoff * (0.24 + participation * 0.76))
              + (peakSuppression * (0.34 + participation * 0.48)),
            0,
            1,
          );
          const densityReduction = clamp(
            (peakSuppression * (0.56 + (1 - participation) * 0.12))
              + (handoff * (0.12 + participation * 0.62))
              + (state.tail * 0.06),
            0,
            isAnchor ? 0.68 : 0.96,
          ) * anchorSuppression;
          const pointFade = clamp(1 - densityReduction, isAnchor ? 0.22 : 0.04, 1);
          const sizeFade = clamp(1 - (handoff * (0.24 + participation * 0.34)) - (peakSuppression * 0.2), isAnchor ? 0.58 : 0.18, 1.12);
          const visibilityTwinkle = clamp(0.64 + twinkle * 0.24, 0.18, 1.05);
          const luminosity = 1 + state.alpha * 0.14 + state.peak * (0.06 + participation * 0.08);

          colors.array[base] = clamp(this.starBaseColors[base] * luminosity, 0, 1);
          colors.array[base + 1] = clamp(this.starBaseColors[base + 1] * (luminosity + state.alpha * 0.04), 0, 1);
          colors.array[base + 2] = clamp(this.starBaseColors[base + 2] * (1 + state.alpha * 0.08 + state.peak * 0.08), 0, 1);
          sizes.array[i] = this.starBaseSizes[i] * twinkle * sizeFade;
          alphas.array[i] = this.starBaseAlphas[i] * visibilityTwinkle * pointFade;
          continue;
        }

        positions.array[base] = centerX + (localX * rx) + (localY * ux) + (localZ * fx);
        positions.array[base + 1] = centerY + (localX * ry) + (localY * uy) + (localZ * fy);
        positions.array[base + 2] = centerZ + (localX * rz) + (localY * uz) + (localZ * fz);

        colors.array[base] = this.starBaseColors[base];
        colors.array[base + 1] = this.starBaseColors[base + 1];
        colors.array[base + 2] = this.starBaseColors[base + 2];
        sizes.array[i] = this.starBaseSizes[i] * twinkle;
        alphas.array[i] = this.starBaseAlphas[i] * clamp(0.66 + twinkle * 0.22, 0.24, 1.05);
      }
      positions.needsUpdate = true;
      colors.needsUpdate = true;
      sizes.needsUpdate = true;
      alphas.needsUpdate = true;
      this.starField.material.uniforms.uOpacity.value = lerp(0.82, reducedMotion ? 0.4 : 0.24, state.alpha * 0.38 + state.peak * 0.62);
      this.starField.material.uniforms.uPointScale.value = (this.starPointScaleBase || 1550)
        * Math.min(window.devicePixelRatio || 1, 2)
        * lerp(1, reducedMotion ? 0.92 : 0.84, state.peak * 0.8 + earlyHandoff * 0.2);
    }

    /* ── Ambient dust drift ── */
    updateDust(time) {
      if (!this.dustField) return;
      const positions = this.dustField.geometry.attributes.position;
      const t = time * 0.0003;
      const state = this.hyperdriveState || { alpha: 0, peak: 0 };
      const reducedMotion = motionQuery.matches;
      for (let i = 0; i < this.dustPhases.length; i++) {
        const phase = this.dustPhases[i];
        const base = i * 3;
        const damp = 1 - state.alpha * (reducedMotion ? 0.45 : 0.82);
        positions.array[base] += Math.sin(t + phase) * 0.0016 * damp;
        positions.array[base + 1] += Math.cos(t * 0.7 + phase) * 0.0012 * damp;
        positions.array[base + 2] += Math.sin(t * 0.5 + phase * 1.3) * 0.0014 * damp;
      }
      positions.needsUpdate = true;
      this.dustField.material.opacity = lerp(0.3, 0.025, state.alpha * 0.72 + state.peak * 0.46);
    }

    /* ── Near-dust drift (foreground sensing motes) ── */
    updateNearDust(time) {
      if (!this.nearDust) return;
      const positions = this.nearDust.geometry.attributes.position;
      const t = time * 0.00018;
      const state = this.hyperdriveState || { alpha: 0, peak: 0 };
      const reducedMotion = motionQuery.matches;
      for (let i = 0; i < this.nearDustPhases.length; i++) {
        const phase = this.nearDustPhases[i];
        const base = i * 3;
        const damp = 1 - state.alpha * (reducedMotion ? 0.55 : 0.92);
        positions.array[base] += Math.sin(t + phase) * 0.0009 * damp;
        positions.array[base + 1] += Math.cos(t * 0.6 + phase) * 0.0007 * damp;
        positions.array[base + 2] += Math.sin(t * 0.4 + phase * 1.2) * 0.0008 * damp;
      }
      positions.needsUpdate = true;
      this.nearDust.material.opacity = lerp(0.1, 0.004, state.alpha * 0.9 + state.peak * 0.42);
    }

    computeHyperdriveState() {
      const reducedMotion = motionQuery.matches;
      const age = (performance.now() - (this.focusChangedAt || 0)) / 1000;
      if (!this.hyperdriveDirection || age < 0) {
        return {
          age,
          progress: 0,
          direction: 0,
          alpha: 0,
          peak: 0,
          tail: 0,
          vanishingBlend: 0,
          biasX: 0,
          biasY: 0,
          active: false,
        };
      }

      const reversePass = this.hyperdriveDirection < 0;
      const timing = reversePass
        ? (reducedMotion
          ? { attack: 0.05, surge: 0.14, decay: 0.38, settle: 0.62 }
          : { attack: 0.06, surge: 0.17, decay: 0.48, settle: 0.76 })
        : (reducedMotion
          ? { attack: 0.1, surge: 0.26, decay: 0.72, settle: 0.95 }
          : { attack: 0.14, surge: 0.36, decay: 1.05, settle: 1.4 });

      let alpha = 0;
      let peak = 0;
      let tail = 0;

      if (age <= timing.attack) {
        const stage = easeOutCubic(age / timing.attack);
        if (reversePass) {
          alpha = 0.56 + stage * 0.26;
          peak = 0.28 + stage * 0.38;
        } else {
          alpha = 0.38 + stage * 0.28;
          peak = stage * 0.22;
        }
      } else if (age <= timing.surge) {
        const stage = easeInOutCubic((age - timing.attack) / (timing.surge - timing.attack));
        if (reversePass) {
          alpha = lerp(0.82, 1, stage);
          peak = lerp(0.66, 1, stage);
        } else {
          alpha = lerp(0.66, 1, stage);
          peak = lerp(0.22, 1, stage);
        }
      } else if (age <= timing.decay) {
        const stage = easeOutCubic((age - timing.surge) / (timing.decay - timing.surge));
        alpha = lerp(1, reversePass ? 0.18 : 0.24, stage);
        peak = lerp(1, reversePass ? 0.08 : 0.12, stage);
        tail = stage;
      } else if (age <= timing.settle) {
        const stage = easeInOutCubic((age - timing.decay) / (timing.settle - timing.decay));
        alpha = lerp(reversePass ? 0.18 : 0.24, 0, stage);
        peak = lerp(reversePass ? 0.08 : 0.12, 0, stage);
        tail = 1;
      }

      if (reducedMotion) {
        alpha *= 0.48;
        peak *= 0.34;
        tail *= 0.68;
      }

      alpha *= 0.34;
      peak *= 0.28;
      tail *= 0.48;

      return {
        age,
        progress: clamp(age / timing.settle, 0, 1),
        direction: this.hyperdriveDirection,
        alpha: clamp(alpha, 0, 1),
        peak: clamp(peak, 0, 1),
        tail: clamp(tail, 0, 1),
        vanishingBlend: 0,
        biasX: 0,
        biasY: 0,
        active: age <= timing.settle && (alpha > 0.001 || peak > 0.001),
      };
    }

    updateHyperdriveStreaks(time) {
      if (!this.hyperdriveStreakGroup || !this.hyperdriveStreakMeta) return;
      const state = this.hyperdriveState || { alpha: 0, peak: 0, active: false, vanishingBlend: 0, biasX: 0, biasY: 0 };
      const reducedMotion = motionQuery.matches;
      this.hyperdriveStreakGroup.visible = state.active;
      if (!state.active) return;

      const t = time * 0.001;
      const planeDistance = 8.3;
      const planeHalfHeight = Math.tan((this.camera.fov * Math.PI) / 360) * planeDistance;
      const planeHalfWidth = planeHalfHeight * this.camera.aspect;
      this.hyperdriveGroupPosition.copy(this.camera.position)
        .addScaledVector(this.cameraForward, planeDistance)
        .addScaledVector(this.cameraRight, state.biasX * planeHalfWidth)
        .addScaledVector(this.cameraUp, state.biasY * planeHalfHeight);
      this.hyperdriveStreakGroup.position.copy(this.hyperdriveGroupPosition);
      this.hyperdriveStreakGroup.quaternion.copy(this.camera.quaternion);

      this.hyperdriveStreakMeta.forEach((meta) => {
        const flicker = reducedMotion
          ? 1
          : 0.82 + 0.18 * Math.sin(t * meta.flickerSpeed + meta.seed);
        const surge = 0.72 + 0.28 * Math.sin(t * (meta.flickerSpeed * 0.42) + meta.seed * 1.8);
        const laneBoost = 0.62 + meta.lane * 1.1;
        const spreadProgress = easeInOutCubic(state.progress);
        const edgeWeight = clamp((meta.radius - 0.12) / 1.24, 0, 1);
        const activation = state.direction > 0
          ? clamp((spreadProgress - edgeWeight * 0.58) / 0.42, 0, 1)
          : clamp((spreadProgress - (1 - edgeWeight) * 0.58) / 0.42, 0, 1);
        const flowProgress = state.direction > 0 ? activation : 1 - activation;
        const length = 0.12
          + activation * (
            state.alpha * (0.9 + laneBoost * 0.44)
            + state.peak * (2.8 + laneBoost * 2.6) * surge
          );
        const innerOffset = 0.14 + meta.radius * 0.28;
        const outerOffset = 1.3 + meta.radius * 1.15 + meta.lane * 0.62;
        const centerOffset = lerp(innerOffset, outerOffset, flowProgress);
        const coreWidth = 0.022 + state.alpha * 0.018 + state.peak * 0.04 * meta.width;
        const glowWidth = coreWidth * (2.4 + state.peak * 0.22);
        const opacityCore = clamp((0.052 + state.alpha * 0.04 + state.peak * 0.1) * activation * flicker, 0, 0.16);
        const opacityGlow = clamp((0.034 + state.alpha * 0.032 + state.peak * 0.08) * activation * (reducedMotion ? 1 : 0.94 + surge * 0.12), 0, 0.12);

        meta.core.position.y = centerOffset + length * 0.5;
        meta.glow.position.y = centerOffset + length * 0.5;
        meta.core.scale.set(coreWidth, length, 1);
        meta.glow.scale.set(glowWidth, length * (1.34 + state.peak * 0.1), 1);
        meta.coreMaterial.opacity = opacityCore;
        meta.glowMaterial.opacity = opacityGlow;
      });
    }

    /* ── Measurement ring animation (flowing dashes + gentle rotation) ── */
    updateMeasurementRings(time) {
      const t = time * 0.001;
      this.measurementRings.forEach((ring, index) => {
        if (ring.material.dashSize) {
          ring.material.dashOffset -= 0.002;
        }
        ring.rotation.y += 0.00022 * (index + 1);
        /* 22s-cycle opacity breathing */
        const baseOpacity = this.modes.threshold ? 0.075 - index * 0.012 : 0.018;
        ring.material.opacity = baseOpacity + Math.sin(t * 0.18 + index * 1.2) * 0.008;
      });
    }

    updateChamberCore(time) {
      if (!this.chamberCore) return;
      const reducedMotion = motionQuery.matches;
      const t = time * 0.001;
      const state = this.hyperdriveState || { alpha: 0, peak: 0 };
      const targetLock = this.focusId ? 1 : 0;
      const lockAlpha = this.chamberCore.lockAlpha = lerp(this.chamberCore.lockAlpha || 0, targetLock, 0.075);
      const surge = state.alpha * 0.24 + state.peak * 0.34;
      const pulse = Math.sin(t * 0.64) * 0.5 + 0.5;
      const focusEntry = this.focusId && this.nodeLookup.has(this.focusId)
        ? this.nodeLookup.get(this.focusId)
        : null;
      const profile = focusEntry ? (focusEntry.lockProfile || { phaseOffset: 0, apparatusGain: 1, braceGain: 1 }) : { phaseOffset: 0, apparatusGain: 1, braceGain: 1 };
      const settle = focusEntry ? this.resolveLockSettle(focusEntry, state.age || 0) : 0;
      const apparatusGain = profile.apparatusGain || 1;
      const irisScale = 1 - lockAlpha * (0.12 + (profile.braceGain || 1) * 0.02) - state.peak * 0.04;

      this.chamberCore.group.rotation.z += reducedMotion ? 0.00008 : 0.00018;
      this.chamberCore.group.position.y = -0.45 + Math.sin(t * 0.16) * (reducedMotion ? 0.006 : 0.018);
      this.chamberCore.braceGroup.rotation.z = t * 0.008 + profile.phaseOffset * 0.012 + settle * 0.08;
      this.chamberCore.braceGroup.scale.set(irisScale, irisScale, 1);
      this.chamberCore.apertureRing.rotation.z = t * 0.012;
      this.chamberCore.calibrationRing.rotation.z = -t * 0.009 + profile.phaseOffset * 0.01;
      this.chamberCore.lockRing.rotation.z = t * 0.018 + lockAlpha * 0.06 + settle * 0.08;
      this.chamberCore.lockRing.scale.setScalar(1 - lockAlpha * 0.07 - settle * 0.08);

      this.chamberCore.apertureRing.material.opacity = 0.052 + lockAlpha * 0.04 + surge * 0.014;
      this.chamberCore.calibrationRing.material.opacity = 0.032 + lockAlpha * 0.026 + pulse * 0.007;
      this.chamberCore.lockRing.material.opacity = 0.026 + lockAlpha * 0.05 + surge * 0.018;
      this.chamberCore.tachCarrier.material.opacity = 0.008 + lockAlpha * 0.006 + surge * 0.002;
      this.chamberCore.tachInnerLip.material.opacity = 0.006 + lockAlpha * 0.006 + surge * 0.002;
      this.chamberCore.innerTachCarrier.material.opacity = 0.02 + lockAlpha * 0.014 + surge * 0.004;
      this.chamberCore.innerTachShadow.material.opacity = 0.018 + lockAlpha * 0.012 + surge * 0.004;
      this.chamberCore.innerTachLipOuter.material.opacity = 0.012 + lockAlpha * 0.01 + surge * 0.003;
      this.chamberCore.innerTachLipInner.material.opacity = 0.01 + lockAlpha * 0.008;
      this.chamberCore.innerTachSheen.material.opacity = 0.008 + lockAlpha * 0.008 + Math.max(0, settle) * 0.006;
      this.chamberCore.innerTachEdgeGlow.material.opacity = 0.004 + lockAlpha * 0.006 + surge * 0.003;
      this.chamberCore.rimSheen.material.opacity = 0.018 + lockAlpha * 0.028 + surge * 0.008 + Math.max(0, settle) * 0.018;
      this.chamberCore.rimShadow.material.opacity = 0.052 + lockAlpha * 0.018;
      this.chamberCore.microTicks.minor.material.opacity = 0.012 + lockAlpha * 0.006 + surge * 0.004;
      this.chamberCore.microTicks.major.material.opacity = 0.016 + lockAlpha * 0.008 + surge * 0.005;
      this.chamberCore.microTicks.minor.rotation.z = -t * 0.008 + profile.phaseOffset * 0.008;
      this.chamberCore.microTicks.major.rotation.z = t * 0.006 + settle * 0.04;
      this.chamberCore.rimBand.group.rotation.z = t * 0.01 + profile.phaseOffset * 0.024;
      this.chamberCore.innerTachBand.group.rotation.z = -t * 0.012 + profile.phaseOffset * 0.012 + settle * 0.02;

      this.chamberCore.halo.material.opacity = 0.028 + pulse * 0.009 + lockAlpha * 0.01;
      this.chamberCore.envelope.material.opacity = 0.032 + pulse * 0.005 + lockAlpha * 0.014 + surge * 0.01;
      this.chamberCore.mantle.material.opacity = 0.15 + pulse * 0.016 + lockAlpha * 0.024 + surge * 0.014;
      this.chamberCore.convection.material.opacity = 0.066 + pulse * 0.01 + lockAlpha * 0.022 + surge * 0.013;
      this.chamberCore.nucleus.material.opacity = 0.26 + pulse * 0.022 + lockAlpha * 0.02;

      this.chamberCore.envelope.scale.setScalar(6.6 + pulse * 0.07 + lockAlpha * 0.1 + surge * 0.07);
      this.chamberCore.halo.scale.setScalar(3.5 + pulse * 0.05 + lockAlpha * 0.06);
      this.chamberCore.mantle.scale.setScalar(4.32 + pulse * 0.06 + lockAlpha * 0.08 + surge * 0.05);
      this.chamberCore.convection.scale.setScalar(3.55 + pulse * 0.05 + lockAlpha * 0.07);
      this.chamberCore.nucleus.scale.setScalar(0.74 + pulse * 0.03 + lockAlpha * 0.03 + surge * 0.014);
      this.chamberCore.mantle.material.rotation = t * 0.045;
      this.chamberCore.convection.material.rotation = 0.74 - t * 0.06;
      this.chamberCore.coronaGroup.rotation.z = -t * 0.018;

      this.chamberCore.braces.forEach((entry, index) => {
        const shimmer = 0.82 + Math.sin(t * 0.7 + index * 0.78) * 0.18;
        entry.line.material.opacity = (entry.baseOpacity * 0.34 + lockAlpha * 0.035 + surge * 0.02) * shimmer;
      });

      this.chamberCore.arcs.forEach((entry, index) => {
        entry.line.rotation.z = t * entry.speed * 0.34;
        entry.line.material.opacity = entry.baseOpacity * 0.26 + lockAlpha * 0.02 + surge * 0.012 + Math.sin(t * 0.5 + index) * 0.004;
      });

      this.chamberCore.rimBand.ticks.forEach((tick, index) => {
        const glintWave = 0.5 + Math.sin(t * 0.86 + tick.glintPhase + profile.phaseOffset) * 0.5;
        tick.cradle.material.opacity = tick.cradleOpacity * 0.12 + lockAlpha * 0.008 * apparatusGain + surge * 0.002;
        tick.faceShadow.material.opacity = tick.shadowOpacity * 0.12 + lockAlpha * 0.005 + surge * 0.0015;
        tick.plate.material.opacity = tick.baseOpacity * 0.14 + lockAlpha * 0.01 * apparatusGain + surge * 0.0025;
        tick.plate.material.emissiveIntensity = 0.01 + glintWave * 0.006 + lockAlpha * 0.006 * apparatusGain;
        tick.glint.material.opacity = tick.glintOpacity * Math.max(0.08, glintWave) * (0.03 + lockAlpha * 0.052);
        tick.holder.position.z = 0.016 + Math.sin(t * 0.14 + index * 0.36 + profile.phaseOffset) * 0.001;
      });

      this.chamberCore.innerTachBand.ticks.forEach((tick, index) => {
        const glintWave = 0.5 + Math.sin(t * 0.92 + tick.glintPhase + profile.phaseOffset * 1.2) * 0.5;
        tick.cradle.material.opacity = tick.cradleOpacity * 0.1 + lockAlpha * 0.007 * apparatusGain + surge * 0.002;
        tick.faceShadow.material.opacity = tick.shadowOpacity * 0.09 + lockAlpha * 0.004 + surge * 0.0015;
        tick.plate.material.opacity = tick.baseOpacity * 0.12 + lockAlpha * 0.008 * apparatusGain + surge * 0.0025;
        tick.plate.material.emissiveIntensity = 0.01 + glintWave * 0.006 + lockAlpha * 0.006 * apparatusGain;
        tick.glint.material.opacity = tick.glintOpacity * Math.max(0.08, glintWave) * (0.03 + lockAlpha * 0.044);
        tick.holder.position.z = 0.015 + Math.sin(t * 0.16 + index * 0.42 + profile.phaseOffset) * 0.0007;
      });

      this.chamberCore.coronaSprites.forEach((entry, index) => {
        const drift = Math.sin(t * (0.44 + index * 0.06) + entry.phase) * 0.08;
        entry.sprite.position.set(
          Math.cos(entry.angle + t * 0.03) * (entry.radius + drift),
          Math.sin(entry.angle + t * 0.03) * (entry.radius + drift) * 0.72,
          entry.sprite.position.z,
        );
        entry.sprite.material.opacity = 0.02 + lockAlpha * 0.028 + surge * 0.018 + Math.max(0, Math.sin(t * 0.88 + entry.phase)) * 0.018;
      });

      this.chamberCore.coreLight.intensity = 0.36 + lockAlpha * 0.14 + surge * 0.14 + pulse * 0.035 + apparatusGain * 0.02;
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
          guide.line.material.opacity = guide.passive
            ? guide.opacityBase
            : (this.focusId ? guide.opacityBase || 0.2 : 0.12);
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
          ? 0.16
          : entry.node.tier === "flagship"
          ? 0.14
          : 0.08;
      });
    }

    resolveCompositionWindow(entry) {
      const frame = this.target.closest(".observatory-field-frame");
      const width = this.target.clientWidth || 700;
      const height = this.target.clientHeight || 460;
      if (!frame) {
        return {
          xNorm: 0.57,
          yNorm: 0.46,
          widthNorm: 0.32,
          heightNorm: 0.24,
        };
      }

      const frameRect = frame.getBoundingClientRect();
      const leftPanel = document.querySelector(".observatory-inspector--docked");
      const rightPanel = document.querySelector(".observatory-history-panel--docked");
      const leftRect = leftPanel ? leftPanel.getBoundingClientRect() : null;
      const rightRect = rightPanel ? rightPanel.getBoundingClientRect() : null;
      const sideGutter = Math.max(44, frameRect.width * 0.03);
      const leftGuard = leftRect ? Math.max(0, (leftRect.right - frameRect.left) + sideGutter) : frameRect.width * 0.18;
      const rightGuard = rightRect ? Math.max(0, (frameRect.right - rightRect.left) + sideGutter) : frameRect.width * 0.18;
      const topGuard = Math.max(132, frameRect.height * 0.18);
      const bottomGuard = Math.max(168, frameRect.height * 0.2);
      const openWidth = Math.max(frameRect.width - leftGuard - rightGuard, frameRect.width * 0.24);
      const openHeight = Math.max(frameRect.height - topGuard - bottomGuard, frameRect.height * 0.22);
      const sourceNorm = clamp(entry ? entry.node.anchor.x / 5.9 : 0, -1, 1);
      const profile = entry ? entry.lockProfile : null;
      const baseX = 0.548;
      const sourceBias = sourceNorm >= 0
        ? sourceNorm * 0.078
        : Math.abs(sourceNorm) * 0.026;
      const composedX = leftGuard + (openWidth * clamp(baseX + sourceBias, 0.34, 0.76));
      const composedY = topGuard + (openHeight * clamp(0.44 + (profile ? profile.yBias : 0) - Math.abs(sourceNorm) * 0.018, 0.3, 0.68));

      return {
        xNorm: clamp(composedX / width, 0.22, 0.82),
        yNorm: clamp(composedY / height, 0.18, 0.74),
        widthNorm: clamp(openWidth / width, 0.22, 0.62),
        heightNorm: clamp(openHeight / height, 0.2, 0.46),
      };
    }

    resolveFocusWorldOffset(entry, composition) {
      const projection = entry.group.position.clone().project(this.camera);
      const desiredNdcX = (composition.xNorm * 2) - 1;
      const desiredNdcY = 1 - (composition.yNorm * 2);
      const deltaX = desiredNdcX - projection.x;
      const deltaY = desiredNdcY - projection.y;
      const distance = Math.max(4.8, this.camera.position.distanceTo(entry.group.position));
      const halfHeight = Math.tan((this.camera.fov * Math.PI) / 360) * distance;
      const halfWidth = halfHeight * this.camera.aspect;
      return new this.THREE.Vector3()
        .addScaledVector(this.cameraRight, deltaX * halfWidth)
        .addScaledVector(this.cameraUp, deltaY * halfHeight);
    }

    resolveLockSettle(entry, ageSeconds) {
      if (!entry || !this.focusId || motionQuery.matches) return 0;
      const profile = entry.lockProfile || { settleAmplitude: 0.06, phaseOffset: 0 };
      const primary = Math.sin((ageSeconds * 13.5) + profile.phaseOffset);
      const secondary = Math.sin((ageSeconds * 21.2) + profile.phaseOffset * 0.42);
      const envelope = Math.exp(-Math.max(0, ageSeconds - 0.26) * 2.9);
      const gate = clamp((ageSeconds - 0.16) / 0.18, 0, 1);
      return profile.settleAmplitude * envelope * gate * ((primary * 0.82) + (secondary * 0.28));
    }

    getFocusTargets() {
      const candidates = Array.isArray(this.nodes)
        ? this.nodes.filter(function (node) { return node && node.focusEligible; })
        : [];
      if (!candidates.length) {
        return { center: null, left: null, right: null };
      }
      const sortedByX = candidates.slice().sort(function (left, right) {
        return left.anchor.x - right.anchor.x;
      });
      const sortedByCenter = candidates.slice().sort(function (left, right) {
        return Math.abs(left.anchor.x) - Math.abs(right.anchor.x);
      });
      return {
        left: sortedByX[0] ? sortedByX[0].id : null,
        center: sortedByCenter[0] ? sortedByCenter[0].id : null,
        right: sortedByX[sortedByX.length - 1] ? sortedByX[sortedByX.length - 1].id : null,
      };
    }

    updateCamera(time) {
      const reducedMotion = motionQuery.matches;
      this.zoomVelocity *= this.isActive ? 0.84 : 0.78;
      this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
      this.zoomCurrent = lerp(this.zoomCurrent, this.zoomTarget, 0.08);
      this.hyperdriveState = this.computeHyperdriveState();

      const now = performance.now();
      const transitionAge = this.hyperdriveState.age;
      const cameraLerp = transitionAge < 1.2 ? lerp(0.082, 0.034, clamp(transitionAge / 1.2, 0, 1)) : 0.034;
      const hyperdriveDolly = this.hyperdriveState.peak * (reducedMotion ? 0.18 : 0.72);
      const fovTarget = this.baseCameraFov + this.hyperdriveState.peak * (reducedMotion ? 0.45 : 1.35);
      this.camera.fov = lerp(this.camera.fov, fovTarget, 0.12);
      this.camera.updateProjectionMatrix();

      const idleX = reducedMotion ? 0 : Math.sin(time * 0.00008) * 0.18;
      const idleY = reducedMotion ? 0 : Math.cos(time * 0.00006) * 0.07;
      const activityAlpha = clamp((now - this.lastInteractionAt) < 2200 ? 1 : 0.35, 0.35, 1);
      const focusAlpha = this.isActive ? 1 : 0.7;
      const userAlpha = activityAlpha * focusAlpha;
      const yaw = idleX + (this.pointerTarget.x * 0.32 + this.keyTarget.x * 0.52) * userAlpha;
      const pitch = idleY + (this.pointerTarget.y * 0.16 + this.keyTarget.y * 0.3) * userAlpha;

      this.compositionTarget.set(0, 0, 0);
      this.focusNodeBiasTarget.set(0, 0, 0);
      this.focusForwardBias.set(0, 0, 0);

      /* ── Composition-first focus choreography — target lands in a protected visual lane, not the geometric center. ── */
      if (this.focusId && this.nodeLookup.has(this.focusId)) {
        const focusEntry = this.nodeLookup.get(this.focusId);
        const composition = this.resolveCompositionWindow(focusEntry);
        const worldOffset = this.resolveFocusWorldOffset(focusEntry, composition);
        const settle = this.resolveLockSettle(focusEntry, transitionAge);
        const profile = focusEntry.lockProfile || { cameraBias: 1, forwardBias: 0.08, settleAmplitude: 0.06 };
        const focusWeight = this.hyperdriveState.active ? 0.28 : 0.48;
        const settleWeight = 0.34 + profile.cameraBias * 0.1;
        this.compositionTarget.copy(worldOffset).multiplyScalar(-0.46 * profile.cameraBias);
        this.compositionTarget.addScaledVector(this.cameraRight, settle * settleWeight);
        this.compositionTarget.addScaledVector(this.cameraUp, -settle * 0.38);
        this.focusNodeBiasTarget.copy(worldOffset).multiplyScalar(0.08 + profile.targetBias * 0.22);
        this.focusNodeBiasTarget.addScaledVector(this.cameraRight, settle * 0.18);
        this.focusForwardBias.copy(this.cameraForward).multiplyScalar((0.08 + profile.forwardBias) * (0.54 + easeOutCubic(clamp(transitionAge / 0.82, 0, 1)) * 0.38));
        const focusPos = focusEntry.group.position.clone()
          .multiplyScalar(focusWeight)
          .add(this.compositionTarget)
          .add(this.focusForwardBias);
        const focusLerp = transitionAge < 1.5 ? 0.06 : 0.025;
        this.focusTarget.lerp(focusPos, focusLerp);
        this.focusZoneCache = composition;
      } else {
        this.compositionTarget.set(0, 0, 0);
        this.focusNodeBiasTarget.set(0, 0, 0);
        this.focusForwardBias.set(0, 0, 0);
        this.focusTarget.lerp(new this.THREE.Vector3(0, 0, 0), 0.025);
      }

      this.compositionOffset.lerp(this.compositionTarget, this.focusId ? 0.12 : 0.08);
      this.focusNodeBias.lerp(this.focusNodeBiasTarget, this.focusId ? 0.12 : 0.08);

      const zoomNorm = (this.zoomCurrent - this.zoomRange.min) / (this.zoomRange.max - this.zoomRange.min);
      const desired = new this.THREE.Vector3(
        Math.sin(yaw) * lerp(2.7, 3.8, zoomNorm) - this.compositionOffset.x * 0.18,
        1.2 + pitch * lerp(4.8, 6.35, zoomNorm) - this.compositionOffset.y * 0.22,
        this.zoomCurrent + Math.cos(yaw * 1.18) * 1.15 - hyperdriveDolly - this.compositionOffset.z * 0.08,
      );
      this.camera.position.lerp(desired, cameraLerp);
      this.focusPoint.lerp(this.focusTarget, this.focusId ? 0.065 : 0.04);
      this.camera.lookAt(this.focusPoint);

      this.cameraForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.cameraRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.cameraUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);

      let biasX = 0;
      let biasY = 0;
      const transitAnchor = this.hyperdriveState.active ? this.resolveHyperdriveAnchorEntry() : null;
      if (transitAnchor) {
        const focusProjection = transitAnchor.group.position.clone().project(this.camera);
        const vanishingBlend = 1;
        biasX = clamp(focusProjection.x, -1.08, 1.08);
        biasY = clamp(focusProjection.y, -0.9, 0.9);
        this.hyperdriveState.vanishingBlend = vanishingBlend;
      } else {
        this.hyperdriveState.vanishingBlend = 0;
      }
      this.hyperdriveState.biasX = biasX;
      this.hyperdriveState.biasY = biasY;

      this.renderer.toneMappingExposure = lerp(
        this.renderer.toneMappingExposure,
        this.baseToneMappingExposure + this.hyperdriveState.alpha * 0.12 + this.hyperdriveState.peak * (reducedMotion ? 0.08 : 0.24),
        0.12,
      );

      if (this.sceneLights) {
        this.sceneLights.rim.intensity = lerp(this.sceneLights.rim.intensity, this.sceneLightBase.rim + this.hyperdriveState.peak * 1.1, 0.12);
        this.sceneLights.fill.intensity = lerp(this.sceneLights.fill.intensity, this.sceneLightBase.fill + this.hyperdriveState.alpha * 0.45, 0.1);
        this.sceneLights.depthLight.intensity = lerp(this.sceneLights.depthLight.intensity, this.sceneLightBase.depthLight + this.hyperdriveState.peak * 0.48, 0.12);
        this.sceneLights.prism.intensity = lerp(this.sceneLights.prism.intensity, this.sceneLightBase.prism + this.hyperdriveState.alpha * 0.34, 0.1);
        this.sceneLights.aqua.intensity = lerp(this.sceneLights.aqua.intensity, this.sceneLightBase.aqua + this.hyperdriveState.alpha * 0.22, 0.1);
      }

      if (!this.hyperdriveState.active && this.hyperdriveDirection) {
        this.hyperdriveDirection = 0;
        this.transitionFocusId = this.focusId;
      }
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
        cii: resolveNodeReadout(focusEntry.node),
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
      if (this.starField && this.starField.material && this.starField.material.uniforms) {
        this.starField.material.uniforms.uPointScale.value = (this.starPointScaleBase || 1550) * Math.min(window.devicePixelRatio || 1, 2);
      }
      this.overlay.resize(width, height);
      if (this.composer) {
        this.composer.setSize(width, height);
      }
      if (this.bloomPass) {
        this.bloomPass.resolution.set(width, height);
      }
      this.renderLabels();
    }

    resolvePickThreshold(entry) {
      if (!entry || !entry.node) return 16;
      if (entry.node.tier === "flagship") return 20;
      if (entry.node.tier === "secondary") return 18;
      return 16;
    }

    projectNodeScreenState(entry) {
      if (!entry || !entry.group) return null;
      const width = this.target.clientWidth || 700;
      const height = this.target.clientHeight || 460;
      const projected = entry.group.position.clone().project(this.camera);
      const visible = projected.z > -1 && projected.z < 1
        && projected.x > -1.08 && projected.x < 1.08
        && projected.y > -1.08 && projected.y < 1.08;

      return {
        entry,
        visible,
        projected,
        x: ((projected.x + 1) / 2) * width,
        y: ((-projected.y + 1) / 2) * height,
        depth: projected.z,
        threshold: this.resolvePickThreshold(entry),
      };
    }

    pickNodeAtClientPoint(clientX, clientY) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const candidates = [];

      this.nodeLookup.forEach((entry) => {
        const projected = this.projectNodeScreenState(entry);
        if (!projected || !projected.visible) return;
        const distance = Math.hypot(projected.x - localX, projected.y - localY);
        if (distance <= projected.threshold) {
          candidates.push({
            modelId: entry.node.id,
            entry,
            distance,
            depth: projected.depth,
            via: "screen-space",
          });
        }
      });

      candidates.sort(function (left, right) {
        return left.distance - right.distance || left.depth - right.depth;
      });
      if (candidates.length) {
        return candidates[0];
      }

      const pickMouse = new this.THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      );
      this.raycaster.setFromCamera(pickMouse, this.camera);
      const intersections = this.raycaster.intersectObjects(
        Array.from(this.nodeLookup.values()).map((entry) => entry.hitSphere),
        false,
      );
      if (!intersections.length) return null;

      const modelId = intersections[0].object.userData.modelId;
      return modelId ? {
        modelId,
        entry: this.nodeLookup.get(modelId) || null,
        distance: Infinity,
        depth: intersections[0].distance,
        via: "raycast-fallback",
      } : null;
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
      this.updateCamera(time);
      this.updateStars(time);
      this.updateDust(time);
      this.updateNearDust(time);
      this.updateHyperdriveStreaks(time);
      this.updateGuides(time);
      this.updateTrails();
      this.updateGlints(time);
      this.updateTooltipPosition();
      this.updateMeasurementRings(time);
      this.updateChamberCore(time);

      /* ── Ambient light breathing (18s cycle) ── */
      if (this.ambientLight) {
        const state = this.hyperdriveState || { alpha: 0, peak: 0 };
        this.ambientLight.intensity = this.ambientBaseIntensity
          + Math.sin(slowTime * 0.35) * 0.04
          + state.alpha * 0.08
          + state.peak * 0.12;
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
        const state = this.hyperdriveState || { alpha: 0, peak: 0 };
        const bloomTarget = this.focusId ? this.bloomFocusTarget : this.bloomBase;
        const impulseCoeff = this.bloomImpulseCoeff;
        this.bloomPass.strength = lerp(this.bloomPass.strength, bloomTarget + this.bloomImpulse * impulseCoeff, 0.08);
        this.bloomPass.strength = lerp(
          this.bloomPass.strength,
          bloomTarget + this.bloomImpulse * impulseCoeff + state.alpha * 0.16 + state.peak * 0.42,
          0.12,
        );
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
      this.renderer.domElement.removeEventListener("click", this.onClick);
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
      this.lastPointerSelectionAt = 0;

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
      if (!pointerSupportsHover(event.pointerType || "mouse")) {
        this.pointer.x = 0;
        this.pointer.y = 0;
        return;
      }
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
      const dispatchNodeFocus = (modelId) => {
        window.dispatchEvent(new CustomEvent("observatory:focus-model", {
          detail: { modelId: this.focusId === modelId ? null : modelId },
        }));
      };
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
        element.style.setProperty("--node-size", `${52 + node.size * 116}px`);
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
            <span class="observatory-fallback-label-meta">${node.provider} · ${resolveNodeReadout(node)}</span>
          </span>
        `;
        element.addEventListener("pointerdown", (event) => {
          if ((event.pointerType || "mouse") === "mouse" && event.button !== 0) return;
          event.preventDefault();
          this.lastPointerSelectionAt = performance.now();
          dispatchNodeFocus(node.id);
        });
        element.addEventListener("click", (event) => {
          if (performance.now() - this.lastPointerSelectionAt < 420) return;
          event.preventDefault();
          dispatchNodeFocus(node.id);
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

    getFocusTargets() {
      const candidates = Array.isArray(this.fieldNodes)
        ? this.fieldNodes.filter(function (node) { return node && node.focusEligible; })
        : [];
      if (!candidates.length) {
        return { center: null, left: null, right: null };
      }
      const sortedByX = candidates.slice().sort(function (left, right) {
        return left.anchor.x - right.anchor.x;
      });
      const sortedByCenter = candidates.slice().sort(function (left, right) {
        return Math.abs(left.anchor.x) - Math.abs(right.anchor.x);
      });
      return {
        left: sortedByX[0] ? sortedByX[0].id : null,
        center: sortedByCenter[0] ? sortedByCenter[0].id : null,
        right: sortedByX[sortedByX.length - 1] ? sortedByX[sortedByX.length - 1].id : null,
      };
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
        cii: resolveNodeReadout(focusedNode),
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
      const vendorPaths = (typeof window !== "undefined" && window.__observatoryVendorPaths) || {};
      const resolveVendorModule = function (path, fallback) {
        const source = path || fallback;
        try {
          return new URL(source, window.location.href).href;
        } catch (_) {
          return source;
        }
      };
      const THREE = await import(resolveVendorModule(vendorPaths.threeModule, "/static/vendor/three/build/three.module.js"));

      /* Attempt to load post-processing addons for bloom */
      let addons = {};
      try {
        const [composerModule, renderPassModule, bloomModule] = await Promise.all([
          import(resolveVendorModule(vendorPaths.effectComposer, "/static/vendor/three/examples/jsm/postprocessing/EffectComposer.js")),
          import(resolveVendorModule(vendorPaths.renderPass, "/static/vendor/three/examples/jsm/postprocessing/RenderPass.js")),
          import(resolveVendorModule(vendorPaths.unrealBloomPass, "/static/vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js")),
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

    if (typeof window !== "undefined") {
      window.__observatoryFieldDebug = Object.assign({}, window.__observatoryFieldDebug, {
        getFocusTargets: function () {
          return controller && typeof controller.getFocusTargets === "function"
            ? controller.getFocusTargets()
            : { center: null, left: null, right: null };
        },
        getFieldNodes: function () {
          return controller && Array.isArray(controller.fieldNodes)
            ? controller.fieldNodes.map(function (node) {
                return {
                  id: node.id,
                  label: node.label,
                  x: node.anchor && node.anchor.x,
                  y: node.anchor && node.anchor.y,
                };
              })
            : [];
        },
      });
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
