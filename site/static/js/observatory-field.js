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

  function buildFieldNodes(payload) {
    const modelsById = new Map((payload.models || []).map(function (model) {
      return [model.model_id, model];
    }));
    const sorted = (payload.constellation.nodes || [])
      .map(function (node) {
        const model = modelsById.get(node.id) || {};
        return {
          id: node.id,
          label: node.label,
          provider: node.provider || model.provider || "unknown",
          cii: typeof node.cii === "number" ? node.cii : (model.metrics && model.metrics.cii) || 0,
          rangeCii: typeof model.rangeCii === "number" ? model.rangeCii : (typeof node.cii === "number" ? node.cii : (model.metrics && model.metrics.cii) || 0),
          rangeTrend: typeof model.rangeTrend === "number" ? model.rangeTrend : 0,
          historyDepth: typeof model.historyDepth === "number" ? model.historyDepth : ((payload.ciiHistory && payload.ciiHistory[node.id]) || []).length,
          ips: typeof node.ips === "number" ? node.ips : (model.metrics && model.metrics.ips) || 0,
          srs: typeof node.srs === "number" ? node.srs : (model.metrics && model.metrics.srs) || 0,
          stale: Boolean(model.stale),
          live: Boolean(model.live),
          lastSeen: node.last_seen || model.last_seen || null,
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
    return `
      <div class="observatory-tooltip-header">${node.label}</div>
      <div class="observatory-tooltip-provider">${node.provider}</div>
      <div class="observatory-tooltip-metrics">
        <div class="observatory-tooltip-row"><span>CII</span><span>${(node.rangeCii || node.cii).toFixed(3)}</span></div>
        <div class="observatory-tooltip-row"><span>IPS</span><span>${node.ips.toFixed(3)}</span></div>
        <div class="observatory-tooltip-row"><span>SRS</span><span>${node.srs.toFixed(3)}</span></div>
      </div>
      <div class="observatory-tooltip-band">${node.tier} band</div>
    `;
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

      /* Tooltip element */
      this.tooltip = createTooltipElement();
      this.shell.appendChild(this.tooltip);

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(0x030609, 0.042);
      this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
      this.camera.position.set(0, 1.2, 11.8);
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.18;
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
          0.62,  /* strength — preserve color separation inside the orb */
          0.56,  /* radius  — soft spread without washing lobe colors */
          0.68   /* threshold — keeps highlights luminous while protecting contrast */
        );
        this.composer.addPass(this.bloomPass);
      } catch (e) {
        console.warn("Bloom post-processing unavailable:", e);
        this.composer = null;
      }
    }

    buildBackdrop() {
      const { THREE } = this;

      const ambient = new THREE.AmbientLight(0x92c4ff, 0.58);
      const rim = new THREE.PointLight(0x7ec7ff, 3.1, 28, 2.2);
      rim.position.set(4.2, 5.1, 9.4);
      const fill = new THREE.PointLight(0x3768d8, 2.1, 34, 2.1);
      fill.position.set(-6.4, -3.8, 7.4);
      const depthLight = new THREE.PointLight(0x8fe7ff, 1.2, 22, 1.8);
      depthLight.position.set(0, 0.6, -7.5);
      const prism = new THREE.PointLight(0xff56c8, 1.15, 20, 1.9);
      prism.position.set(-2.8, 2.1, 5.6);
      const aqua = new THREE.PointLight(0x4fffd4, 1.05, 18, 1.8);
      aqua.position.set(2.5, -1.4, 4.8);
      this.scene.add(ambient, rim, fill, depthLight, prism, aqua);

      [2.0, 3.85, 5.35].forEach((radius, index) => {
        const points = [];
        for (let step = 0; step <= 96; step += 1) {
          const angle = (step / 96) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.22, Math.sin(angle * 0.5) * 0.5));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const ringMaterial = new THREE.LineDashedMaterial({
          color: 0x4d7dd9,
          transparent: true,
          opacity: 0.22 - index * 0.03,
          dashSize: 0.3,
          gapSize: 0.15,
          depthWrite: false,
        });
        const line = new THREE.LineLoop(geometry, ringMaterial);
        line.computeLineDistances();
        line.rotation.x = 1.12 + index * 0.08;
        line.rotation.z = index === 1 ? 0.38 : -0.22 * (index + 1);
        this.scene.add(line);
        this.measurementRings.push(line);
      });

      /* ── Star field with twinkling support ── */
      const starCount = 1200;
      const positions = new Float32Array(starCount * 3);
      const colors = new Float32Array(starCount * 3);
      const starPhases = new Float32Array(starCount); /* per-star phase for twinkling */
      const starSpeeds = new Float32Array(starCount);
      const baseSizes = new Float32Array(starCount);

      for (let index = 0; index < starCount; index += 1) {
        const distance = 18 + Math.random() * 24;
        const angle = Math.random() * Math.PI * 2;
        const elevation = (Math.random() - 0.5) * 20;
        positions[index * 3] = Math.cos(angle) * distance;
        positions[index * 3 + 1] = elevation;
        positions[index * 3 + 2] = (Math.random() - 0.5) * 30;
        colors[index * 3] = 0.52 + Math.random() * 0.18;
        colors[index * 3 + 1] = 0.72 + Math.random() * 0.16;
        colors[index * 3 + 2] = 0.96;
        starPhases[index] = Math.random() * Math.PI * 2;
        starSpeeds[index] = 0.3 + Math.random() * 1.2;
        baseSizes[index] = 0.05 + Math.random() * 0.08;
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
      const gridPlane = new THREE.PlaneGeometry(28, 28);
      const gridShaderMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color(0x1a3a6a) },
          uFade: { value: 12.0 },
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
          "varying vec2 vUv;",
          "varying vec3 vWorldPos;",
          "void main() {",
          "  vec2 grid = abs(fract(vWorldPos.xz - 0.5) - 0.5) / fwidth(vWorldPos.xz);",
          "  float line = min(grid.x, grid.y);",
          "  float gridAlpha = 1.0 - min(line, 1.0);",
          "  float dist = length(vWorldPos.xz);",
          "  float radialFade = 1.0 - smoothstep(2.0, uFade, dist);",
          "  gl_FragColor = vec4(uColor, gridAlpha * 0.18 * radialFade);",
          "}",
        ].join("\n"),
      });
      const gridMesh = new THREE.Mesh(gridPlane, gridShaderMaterial);
      gridMesh.rotation.x = -Math.PI / 2;
      gridMesh.position.y = -4.2;
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
      /* Layered halo: bright nucleus → cyan band → blue falloff → violet whisper → transparent */
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

    buildOrbPalette(node) {
      const { THREE } = this;
      const seed = hashString(`orb:${node.provider}:${node.id}`);
      const families = [
        { coreHue: 0.53, emissiveHue: 0.5, haloHue: 0.54, auraHue: 0.71, shellHue: 0.56, nucleusHue: 0.54, lobes: [0.49, 0.77, 0.73, 0.44] },
        { coreHue: 0.61, emissiveHue: 0.59, haloHue: 0.63, auraHue: 0.76, shellHue: 0.66, nucleusHue: 0.62, lobes: [0.56, 0.72, 0.79, 0.48] },
        { coreHue: 0.68, emissiveHue: 0.66, haloHue: 0.7, auraHue: 0.8, shellHue: 0.73, nucleusHue: 0.69, lobes: [0.52, 0.8, 0.75, 0.58] },
        { coreHue: 0.57, emissiveHue: 0.55, haloHue: 0.59, auraHue: 0.74, shellHue: 0.62, nucleusHue: 0.58, lobes: [0.47, 0.69, 0.82, 0.53] },
      ];
      const family = families[Math.floor(seed * families.length) % families.length];
      const hueDrift = ((seed * 2) - 1) * 0.03;
      const core = new THREE.Color().setHSL(family.coreHue + hueDrift, 0.56, node.tier === "flagship" ? 0.86 : node.tier === "secondary" ? 0.77 : 0.71);
      const emissive = new THREE.Color().setHSL(family.emissiveHue + hueDrift, 0.78, node.tier === "flagship" ? 0.5 : node.tier === "secondary" ? 0.44 : 0.38);
      const halo = new THREE.Color().setHSL(family.haloHue + hueDrift * 0.8, 0.52, 0.55);
      const aura = new THREE.Color().setHSL(family.auraHue + hueDrift * 0.45, 0.5, 0.52);
      const shell = new THREE.Color().setHSL(family.shellHue + hueDrift * 0.9, 0.46, 0.6);
      const ring = new THREE.Color().setHSL(family.haloHue + hueDrift * 0.7, 0.74, 0.68);
      const nucleus = new THREE.Color().setHSL(family.nucleusHue + hueDrift * 0.65, 0.28, 0.94);
      return {
        core,
        emissive,
        halo,
        aura,
        shell,
        ring,
        nucleus,
        lobes: [
          new THREE.Color().setHSL(family.lobes[0] + hueDrift * 0.4, 0.9, 0.68),
          new THREE.Color().setHSL(family.lobes[1] + hueDrift * 0.35, 0.84, 0.66),
          new THREE.Color().setHSL(family.lobes[2] + hueDrift * 0.35, 0.76, 0.7),
          new THREE.Color().setHSL(family.lobes[3] + hueDrift * 0.3, 0.82, 0.63),
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
      const emissiveBase = node.tier === "flagship" ? 1.45 : node.tier === "secondary" ? 0.92 : 0.66;

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(node.size, 32, 32),
        new THREE.MeshStandardMaterial({
          color: palette.core,
          emissive: palette.emissive,
          emissiveIntensity: emissiveBase,
          roughness: 0.12,
          metalness: 0.08,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.52 : node.tier === "secondary" ? 0.42 : 0.34,
        }),
      );
      core.userData.modelId = node.id;
      group.add(core);

      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(node.size * (node.tier === "flagship" ? 2.55 : node.tier === "secondary" ? 2.1 : 1.72), 28, 28),
        new THREE.MeshBasicMaterial({
          color: palette.shell,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.1 : node.tier === "secondary" ? 0.07 : 0.045,
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
          opacity: node.tier === "flagship" ? 0.24 : node.tier === "secondary" ? 0.18 : 0.14,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      nucleus.scale.setScalar(node.size * 2.2);
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
            opacity: node.tier === "flagship" ? 0.56 : node.tier === "secondary" ? 0.4 : 0.24,
            depthWrite: false,
            blending: THREE.NormalBlending,
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
          opacity: node.tier === "flagship" ? 0.44 : node.tier === "secondary" ? 0.3 : 0.2,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.scale.setScalar(node.size * node.haloScale * 4.7);
      halo.userData.modelId = node.id;
      group.add(halo);

      /* ── Soft aura — ultra-wide subliminal depth glow (whisper layer) ── */
      const aura = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: palette.aura,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.1 : node.tier === "secondary" ? 0.06 : 0.03,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      aura.scale.setScalar(node.size * node.haloScale * 8.5);
      aura.userData.modelId = node.id;
      group.add(aura);

      /* ── Accent ring — inner instrument orbit ── */
      const accentRing = new THREE.Mesh(
        new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 2.6 : 2.0), node.size * 0.055, 10, 64),
        new THREE.MeshStandardMaterial({
          color: 0x000000,
          emissive: palette.ring,
          emissiveIntensity: node.tier === "flagship" ? 0.8 : node.tier === "secondary" ? 0.5 : 0.3,
          roughness: 0.4,
          metalness: 0.0,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.32 : node.tier === "secondary" ? 0.18 : 0.09,
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
            opacity: node.tier === "flagship" ? 0.18 : 0.08,
          }),
        );
        orbitRing.rotation.x = 1.38;
        orbitRing.rotation.z = -0.28;
        group.add(orbitRing);
      }

      const label = createLabelElement(node);
      this.labelLayer.appendChild(label);

      this.rootGroup.add(group);
      this.nodeLookup.set(node.id, {
        node,
        group,
        core,
        shell,
        nucleus,
        lobes,
        halo,
        aura,
        accentRing,
        orbitRing,
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
      this.payload = payload;
      this.focusId = payload.focusModelId || null;
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
        guideLine.computeLineDistances();
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

      this.nodeLookup.forEach((entry) => {
        const drift = time * 0.0002 * entry.node.driftSpeed;
        entry.group.position.x = entry.node.anchor.x + Math.sin(drift + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.34 : entry.node.tier === "secondary" ? 0.22 : 0.18);
        entry.group.position.y = entry.node.anchor.y + Math.cos(drift * 1.36 + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.3 : entry.node.tier === "secondary" ? 0.18 : 0.14);
        entry.group.position.z = entry.node.anchor.z + Math.sin(drift * 0.88 + entry.node.orbitPhase) * (entry.node.tier === "outer" ? 0.32 : 0.18);

        const focused = this.focusId === entry.node.id;
        const hovered = this.hoverId === entry.node.id;
        const dimmed = Boolean(this.focusId) && !focused;

        /* ── Node breathing: subtle pulsing tied to CII ── */
        const breatheRate = 0.6 + entry.node.cii * 1.4; /* higher CII = faster pulse */
        const breatheAmp = entry.node.tier === "flagship" ? 0.06 : 0.035;
        const breathe = 1.0 + Math.sin(slowTime * breatheRate + entry.node.orbitPhase) * breatheAmp;

        const targetScale = (focused ? 1.32 : hovered ? 1.18 : dimmed ? 0.84 : 1) * breathe;
        entry.group.scale.setScalar(lerp(entry.group.scale.x, targetScale, 0.12));

        /* ── Emissive intensity breathing — boosted on focus/hover ── */
        const focusBoost = focused ? 0.55 : hovered ? 0.22 : 0;
        const emissivePulse = entry.baseEmissiveIntensity + focusBoost +
          Math.sin(slowTime * breatheRate * 0.8 + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.35 : 0.15);
        entry.core.material.emissiveIntensity = lerp(entry.core.material.emissiveIntensity, emissivePulse, 0.08);

        /* ── Nucleus brightness ── */
        if (entry.nucleus) {
          entry.nucleus.material.opacity = lerp(
            entry.nucleus.material.opacity,
            focused ? 0.42 : hovered ? 0.34 : dimmed ? 0.12 : entry.baseNucleusOpacity,
            0.12,
          );
        }

        entry.core.material.opacity = lerp(
          entry.core.material.opacity,
          focused ? Math.min(0.68, entry.baseCoreOpacity + 0.1) : hovered ? Math.min(0.58, entry.baseCoreOpacity + 0.06) : dimmed ? 0.18 : entry.baseCoreOpacity,
          0.1,
        );

        if (entry.shell) {
          entry.shell.material.opacity = lerp(
            entry.shell.material.opacity,
            focused ? 0.22 : hovered ? 0.18 : dimmed ? 0.03 :
              entry.node.tier === "flagship" ? 0.12 : entry.node.tier === "secondary" ? 0.08 : 0.05,
            0.08,
          );
          const shellScale = 1 + Math.sin(slowTime * 0.72 + entry.node.orbitPhase) * (entry.node.tier === "flagship" ? 0.06 : 0.04);
          entry.shell.scale.setScalar(shellScale);
        }

        if (entry.lobes) {
          entry.lobes.forEach((lobe, index) => {
            const wave = Math.sin(slowTime * (lobe.speed + entry.node.cii * 0.14) + lobe.phase);
            const hueNudge = Math.sin(slowTime * 0.28 + lobe.phase + index) * 0.02;
            lobe.sprite.material.color.copy(lobe.baseColor).offsetHSL(hueNudge, 0, wave * 0.03);
            lobe.sprite.material.opacity = lerp(
              lobe.sprite.material.opacity,
              (focused ? 0.5 : hovered ? 0.4 : dimmed ? 0.05 : lobe.baseOpacity) * (0.88 + wave * 0.14),
              0.08,
            );
            lobe.sprite.position.x = lobe.baseX + Math.sin(slowTime * lobe.speed + lobe.phase) * lobe.baseWidth * lobe.amplitude * 0.12;
            lobe.sprite.position.y = lobe.baseY + Math.cos(slowTime * (lobe.speed * 0.86) + lobe.phase) * lobe.baseHeight * lobe.amplitude * 0.1;
            lobe.sprite.scale.set(
              lobe.baseWidth * (1 + wave * 0.05),
              lobe.baseHeight * (1 - wave * 0.04),
              1,
            );
            lobe.sprite.material.rotation = lobe.rotation + slowTime * lobe.speed * 0.1;
          });
        }

        /* ── Primary halo opacity ── */
        entry.halo.material.opacity = lerp(
          entry.halo.material.opacity,
          focused ? 1 : hovered ? 0.82 : dimmed ? 0.12 :
            entry.node.tier === "flagship" ? 0.44 : entry.node.tier === "secondary" ? 0.3 : 0.2,
          0.12,
        );

        /* ── Soft aura opacity (whisper layer — subliminal transitions) ── */
        if (entry.aura) {
          entry.aura.material.opacity = lerp(
            entry.aura.material.opacity,
            focused ? 0.20 : hovered ? 0.14 : dimmed ? 0.02 :
              entry.node.tier === "flagship" ? 0.1 : entry.node.tier === "secondary" ? 0.06 : 0.03,
            0.06,
          );
        }

        /* ── Accent ring opacity + rotation ── */
        entry.accentRing.material.opacity = lerp(
          entry.accentRing.material.opacity,
          focused ? 0.62 : hovered ? 0.38 : dimmed ? 0.06 :
            entry.node.tier === "flagship" ? 0.32 : entry.node.tier === "secondary" ? 0.18 : 0.09,
          0.1,
        );
        const ringSpeed = entry.node.tier === "flagship" ? 0.15 : 0.08;
        entry.accentRing.rotation.y += ringSpeed * 0.016; /* ~1/60s step */
        entry.accentRing.rotation.z += ringSpeed * 0.007;

        /* ── Orbit ring opacity + slow rotation ── */
        if (entry.orbitRing) {
          entry.orbitRing.material.opacity = lerp(
            entry.orbitRing.material.opacity,
            focused ? 0.44 : hovered ? 0.28 : dimmed ? 0.03 :
              entry.node.tier === "flagship" ? 0.18 : 0.08,
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

    /* ── Measurement ring animation (flowing dashes + gentle rotation) ── */
    updateMeasurementRings(time) {
      const t = time * 0.001;
      this.measurementRings.forEach((ring, index) => {
        if (ring.material.dashSize) {
          ring.material.dashOffset -= 0.002;
        }
        ring.rotation.y += 0.0006 * (index + 1);
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
          guide.line.material.opacity = guide.passive ? (this.modes.compare ? 0.12 : 0.04) : (this.focusId ? 0.42 : 0.16);
        }

        /* ── Animated dash offset for flowing effect ── */
        if (!guide.passive && guide.line.material.dashOffset !== undefined) {
          guide.line.material.dashOffset -= 0.004;
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

      const idleX = motionQuery.matches ? 0 : Math.sin(time * 0.00011) * 0.26;
      const idleY = motionQuery.matches ? 0 : Math.cos(time * 0.00008) * 0.1;
      const activityAlpha = clamp((performance.now() - this.lastInteractionAt) < 2200 ? 1 : 0.35, 0.35, 1);
      const focusAlpha = this.isActive ? 1 : 0.7;
      const userAlpha = activityAlpha * focusAlpha;
      const yaw = idleX + (this.pointerTarget.x * 0.32 + this.keyTarget.x * 0.52) * userAlpha;
      const pitch = idleY + (this.pointerTarget.y * 0.16 + this.keyTarget.y * 0.3) * userAlpha;

      /* ── Smoother camera fly-to on focus ── */
      if (this.focusId && this.nodeLookup.has(this.focusId)) {
        const focusEntry = this.nodeLookup.get(this.focusId);
        const focusPos = focusEntry.group.position.clone().multiplyScalar(0.12);
        this.focusTarget.lerp(focusPos, 0.038);
      } else {
        this.focusTarget.lerp(new this.THREE.Vector3(0, 0, 0), 0.035);
      }

      const zoomNorm = (this.zoomCurrent - this.zoomRange.min) / (this.zoomRange.max - this.zoomRange.min);
      const desired = new this.THREE.Vector3(
        Math.sin(yaw) * lerp(2.7, 3.8, zoomNorm),
        1.2 + pitch * lerp(4.8, 6.35, zoomNorm),
        this.zoomCurrent + Math.cos(yaw * 1.18) * 1.15,
      );
      this.camera.position.lerp(desired, 0.04); /* slightly slower for smoother feel */
      this.focusPoint.lerp(this.focusTarget, 0.06);
      this.camera.lookAt(this.focusPoint);
    }

    renderLabels() {
      if (!this.nodeLookup.size) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const candidates = [];
      this.nodeLookup.forEach((entry) => {
        const position = entry.group.position.clone().project(this.camera);
        const visible = position.z > -1 && position.z < 1;
        if (!visible) {
          entry.label.classList.remove("is-visible");
          return;
        }
        const x = ((position.x + 1) / 2) * rect.width;
        const y = ((-position.y + 1) / 2) * rect.height;
        const focusBoost = this.focusId === entry.node.id ? 120 : this.hoverId === entry.node.id ? 95 : entry.node.tier === "flagship" ? 72 : entry.node.tier === "secondary" && position.z < 0.45 && !entry.node.stale ? 44 : 16;
        if (focusBoost < 20) {
          entry.label.classList.remove("is-visible");
          return;
        }
        const width = 118 + entry.node.label.length * 4.4;
        candidates.push({ entry, x, y, width, height: 36, priority: focusBoost, depth: position.z });
      });

      candidates.sort(function (left, right) {
        return right.priority - left.priority || left.depth - right.depth;
      });

      const accepted = [];
      candidates.forEach(function (candidate) {
        const collision = accepted.some(function (other) {
          return Math.abs(other.x - candidate.x) < (other.width + candidate.width) * 0.42
            && Math.abs(other.y - candidate.y) < (other.height + candidate.height) * 0.68;
        });
        if (collision && candidate.priority < 90) {
          candidate.entry.label.classList.remove("is-visible");
          return;
        }
        accepted.push(candidate);
        candidate.entry.label.classList.add("is-visible");
        candidate.entry.label.classList.toggle("is-focused", this.focusId === candidate.entry.node.id);
        candidate.entry.label.classList.toggle("is-dimmed", Boolean(this.focusId) && this.focusId !== candidate.entry.node.id);
        candidate.entry.label.style.transform = `translate(${candidate.x}px, ${candidate.y}px)`;
      }, this);

      this.nodeLookup.forEach(function (entry) {
        if (!accepted.some(function (candidate) { return candidate.entry === entry; })) {
          entry.label.classList.remove("is-visible");
        }
      });
    }

    resize() {
      const width = this.target.clientWidth || 700;
      const height = this.target.clientHeight || 460;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      if (this.composer) {
        this.composer.setSize(width, height);
      }
      if (this.bloomPass) {
        this.bloomPass.resolution.set(width, height);
      }
      this.renderLabels();
    }

    animate(time) {
      this.updateHover();
      this.updateNodes(time);
      this.updateStars(time);
      this.updateDust(time);
      this.updateGuides(time);
      this.updateTrails();
      this.updateCamera(time);
      this.updateTooltipPosition();
      this.updateMeasurementRings(time);

      /* Throttle label rendering: every 3rd frame */
      this.labelFrameSkip = (this.labelFrameSkip + 1) % 3;
      if (this.labelFrameSkip === 0) {
        this.renderLabels();
      }

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
      this.bindEvents();
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
      this.shell.addEventListener("pointermove", this.onPointerMove);
      this.shell.addEventListener("pointerleave", this.onPointerLeave);
      this.shell.addEventListener("pointerdown", this.onPointerDown);
      this.shell.addEventListener("wheel", this.onWheel, { passive: false });
      this.shell.addEventListener("keydown", this.onKeyDown);
      this.shell.addEventListener("focus", this.onFocus);
      this.shell.addEventListener("blur", this.onBlur);
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
      this.payload = payload;
      this.focusId = payload.focusModelId || null;
      this.render();
    }

    render() {
      this.layers.forEach(function (layer) {
        layer.innerHTML = "";
      });
      this.nodeElements.clear();
      buildFieldNodes(this.payload).forEach((node) => {
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
          <span class="observatory-fallback-star"></span>
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
      this.frame = window.requestAnimationFrame(this.animate);
    }

    destroy() {
      if (this.frame) window.cancelAnimationFrame(this.frame);
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
