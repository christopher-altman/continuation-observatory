const root = document.querySelector("#constellation-root");

if (root) {
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let controller = null;
  let latestPayload = { models: [], constellation: { nodes: [], edges: [], threshold: 0.6 }, focusModelId: null };

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
          ips: typeof node.ips === "number" ? node.ips : (model.metrics && model.metrics.ips) || 0,
          srs: typeof node.srs === "number" ? node.srs : (model.metrics && model.metrics.srs) || 0,
          stale: Boolean(model.stale),
          live: Boolean(model.live),
          lastSeen: node.last_seen || model.last_seen || null,
        };
      })
      .sort(function (left, right) {
        return (right.cii || 0) - (left.cii || 0);
      });

    return sorted.map(function (node, index) {
      const score = node.cii || 0;
      const tier = index < 3 ? "flagship" : index < 7 ? "secondary" : "outer";
      const baseHash = hashString(`${node.id}:${node.provider}`);
      const providerHash = hashString(node.provider);
      const radiusBase = tier === "flagship" ? 2.15 : tier === "secondary" ? 4.05 : 5.55;
      const radiusSpread = tier === "flagship" ? 0.58 : tier === "secondary" ? 0.82 : 1.02;
      const angle = (baseHash * Math.PI * 2) + (index * 1.618);
      const radius = radiusBase + radiusSpread * (0.18 + ((baseHash * 7.13) % 1));
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle * 1.37) * (tier === "flagship" ? 1.2 : tier === "secondary" ? 1.8 : 2.25) + (providerHash - 0.5) * 1.15;
      const z = (tier === "flagship" ? -2.05 : tier === "secondary" ? -0.35 : 1.45) + (((baseHash * 11.37) % 1) - 0.5) * (tier === "outer" ? 4.4 : 2.25);
      return {
        ...node,
        tier,
        size: tier === "flagship" ? 0.22 + score * 0.24 : tier === "secondary" ? 0.15 + score * 0.18 : 0.11 + score * 0.12,
        haloScale: tier === "flagship" ? 2.4 : tier === "secondary" ? 1.9 : 1.4,
        glow: tier === "flagship" ? 1 : tier === "secondary" ? 0.78 : 0.52,
        orbitPhase: baseHash * Math.PI * 2,
        driftSpeed: 0.4 + (((baseHash * 17.11) % 1) * 0.36),
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
      <span class="observatory-node-label-meta">${node.provider} · ${node.cii.toFixed(3)}</span>
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
        <div class="observatory-tooltip-row"><span>CII</span><span>${node.cii.toFixed(3)}</span></div>
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
      this.renderer.toneMappingExposure = 1.1;
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
          0.72,  /* strength — slightly more luminous core */
          0.58,  /* radius  — slightly more bloom spread  */
          0.68   /* threshold — catch nucleus + halo pixels */
        );
        this.composer.addPass(this.bloomPass);
      } catch (e) {
        console.warn("Bloom post-processing unavailable:", e);
        this.composer = null;
      }
    }

    buildBackdrop() {
      const { THREE } = this;

      const ambient = new THREE.AmbientLight(0x8ec0ff, 0.56);
      const rim = new THREE.PointLight(0x7ec7ff, 3.1, 28, 2.2);
      rim.position.set(4.2, 5.1, 9.4);
      const fill = new THREE.PointLight(0x3768d8, 2.1, 34, 2.1);
      fill.position.set(-6.4, -3.8, 7.4);
      const depthLight = new THREE.PointLight(0x8fe7ff, 1.2, 22, 1.8);
      depthLight.position.set(0, 0.6, -7.5);
      this.scene.add(ambient, rim, fill, depthLight);

      const guideMaterial = new THREE.LineBasicMaterial({
        color: 0x4d7dd9,
        transparent: true,
        opacity: 0.16,
      });

      [2.0, 3.85, 5.35].forEach((radius, index) => {
        const points = [];
        for (let step = 0; step <= 96; step += 1) {
          const angle = (step / 96) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.22, Math.sin(angle * 0.5) * 0.5));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.LineLoop(geometry, guideMaterial.clone());
        line.rotation.x = 1.12 + index * 0.08;
        line.rotation.z = index === 1 ? 0.38 : -0.22 * (index + 1);
        this.scene.add(line);
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

    /* ── Subtle reference grid on the ground plane ── */
    buildGridPlane() {
      const { THREE } = this;
      const gridSize = 24;
      const gridDivisions = 28;
      const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x1a3a6a, 0x0e1f3a);
      gridHelper.position.y = -4.2;
      gridHelper.material.transparent = true;
      gridHelper.material.opacity = 0.12;
      gridHelper.material.depthWrite = false;
      this.scene.add(gridHelper);
    }

    /* ── Ambient floating dust particles ── */
    buildDustParticles() {
      const { THREE } = this;
      const dustCount = 280;
      const dustPositions = new Float32Array(dustCount * 3);
      const dustPhases = new Float32Array(dustCount);

      for (let i = 0; i < dustCount; i++) {
        dustPositions[i * 3] = (Math.random() - 0.5) * 18;
        dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 10;
        dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 18;
        dustPhases[i] = Math.random() * Math.PI * 2;
      }

      const dustGeometry = new THREE.BufferGeometry();
      dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
      const dustMaterial = new THREE.PointsMaterial({
        size: 0.03,
        transparent: true,
        opacity: 0.22,
        color: 0x6da8ff,
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
      canvas.width = 128;
      canvas.height = 128;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
      /* Hero-matched layered halo: bright nucleus → cyan band → blue falloff → transparent */
      gradient.addColorStop(0,    "rgba(255,255,255,1)");
      gradient.addColorStop(0.08, "rgba(224,247,255,0.96)");
      gradient.addColorStop(0.22, "rgba(156,222,255,0.78)");
      gradient.addColorStop(0.44, "rgba(86,158,255,0.38)");
      gradient.addColorStop(0.66, "rgba(50,90,190,0.12)");
      gradient.addColorStop(0.86, "rgba(28,55,140,0.04)");
      gradient.addColorStop(1,    "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
      return new this.THREE.CanvasTexture(canvas);
    }

    /* Tight bright inner texture for the nucleus sprite */
    createNucleusTexture() {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d");
      const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0,    "rgba(255,255,255,1)");
      gradient.addColorStop(0.18, "rgba(230,248,255,0.94)");
      gradient.addColorStop(0.42, "rgba(160,230,255,0.56)");
      gradient.addColorStop(0.72, "rgba(100,170,255,0.14)");
      gradient.addColorStop(1,    "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 64, 64);
      return new this.THREE.CanvasTexture(canvas);
    }

    buildNode(node) {
      const { THREE } = this;
      const group = new THREE.Group();
      group.position.set(node.anchor.x, node.anchor.y, node.anchor.z);
      group.userData.modelId = node.id;

      /* ── Core sphere — hero-matched color palette ── */
      const coreColor    = node.tier === "flagship" ? 0xeef8ff : node.tier === "secondary" ? 0xc0e4ff : 0x9ab8f8;
      const emissiveColor = node.tier === "flagship" ? 0x80d8ff : node.tier === "secondary" ? 0x4daeff : 0x2d65c8;
      const emissiveBase  = node.tier === "flagship" ? 1.8     : node.tier === "secondary" ? 1.0     : 0.7;

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(node.size, 32, 32),
        new THREE.MeshStandardMaterial({
          color: coreColor,
          emissive: emissiveColor,
          emissiveIntensity: emissiveBase,
          roughness: 0.18,
          metalness: 0.05,
        }),
      );
      core.userData.modelId = node.id;
      group.add(core);

      /* ── Nucleus — tight bright inner sprite echoing hero signal core ── */
      const nucleus = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.nucleusTexture || (this.nucleusTexture = this.createNucleusTexture()),
          color: 0xf0faff,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.95 : node.tier === "secondary" ? 0.8 : 0.62,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      nucleus.scale.setScalar(node.size * 2.2);
      nucleus.userData.modelId = node.id;
      group.add(nucleus);

      /* ── Primary halo — layered outer bloom ── */
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture || (this.glowTexture = this.createGlowTexture()),
          color: node.tier === "flagship" ? 0xb0f0ff : node.tier === "secondary" ? 0x70c0ff : 0x5090ef,
          transparent: true,
          opacity: node.tier === "flagship" ? 0.85 : node.tier === "secondary" ? 0.52 : 0.36,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      halo.scale.setScalar(node.size * node.haloScale * 4.7);
      halo.userData.modelId = node.id;
      group.add(halo);

      /* ── Accent ring — inner instrument orbit ── */
      const accentRing = new THREE.Mesh(
        new THREE.TorusGeometry(node.size * (node.tier === "flagship" ? 2.6 : 2.0), node.size * 0.055, 10, 64),
        new THREE.MeshBasicMaterial({
          color: node.tier === "flagship" ? 0xa0e8ff : node.tier === "secondary" ? 0x70b8ff : 0x5080e0,
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
            color: node.tier === "flagship" ? 0x90e0ff : 0x6aadff,
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
      this.nodeLookup.set(node.id, { node, group, core, nucleus, halo, accentRing, orbitRing, label, baseEmissiveIntensity: emissiveBase });
    }

    clearNodes() {
      this.guides.forEach((guide) => this.scene.remove(guide.line));
      this.guides = [];
      this.nodeLookup.forEach((entry) => {
        entry.label.remove();
        this.rootGroup.remove(entry.group);
      });
      this.nodeLookup.clear();
    }

    setData(payload) {
      this.payload = payload;
      this.focusId = payload.focusModelId || null;
      this.nodes = buildFieldNodes(payload);
      this.clearNodes();
      this.nodes.forEach((node) => this.buildNode(node));
      this.rebuildGuides();
      this.renderLabels();
    }

    /* ── Animated dashed connection edges ── */
    rebuildGuides() {
      this.guides.forEach((guide) => this.scene.remove(guide.line));
      this.guides = [];
      if (!this.focusId) return;
      const focused = this.nodeLookup.get(this.focusId);
      if (!focused) return;
      const neighbors = topNeighbors(this.payload, this.focusId, 3);
      neighbors.forEach((neighborId) => {
        const neighbor = this.nodeLookup.get(neighborId);
        if (!neighbor) return;
        const geometry = new this.THREE.BufferGeometry();
        const material = new this.THREE.LineDashedMaterial({
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
          fromId: this.focusId,
          toId: neighborId,
          line: guideLine,
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
            focused ? 1.0 : hovered ? 0.92 : dimmed ? 0.28 :
              entry.node.tier === "flagship" ? 0.95 : entry.node.tier === "secondary" ? 0.8 : 0.62,
            0.12,
          );
        }

        /* ── Primary halo opacity ── */
        entry.halo.material.opacity = lerp(
          entry.halo.material.opacity,
          focused ? 1 : hovered ? 0.82 : dimmed ? 0.12 :
            entry.node.tier === "flagship" ? 0.85 : entry.node.tier === "secondary" ? 0.52 : 0.36,
          0.12,
        );

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

    /* ── Star field twinkling ── */
    updateStars(time) {
      const sizes = this.starField.geometry.attributes.size;
      if (!sizes) return;
      const t = time * 0.001;
      for (let i = 0; i < this.starPhases.length; i++) {
        const twinkle = 0.7 + 0.3 * Math.sin(t * this.starSpeeds[i] + this.starPhases[i]);
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
        positions.array[base] += Math.sin(t + phase) * 0.001;
        positions.array[base + 1] += Math.cos(t * 0.7 + phase) * 0.0008;
        positions.array[base + 2] += Math.sin(t * 0.5 + phase * 1.3) * 0.001;
      }
      positions.needsUpdate = true;
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

        /* ── Animated dash offset for flowing effect ── */
        if (guide.line.material.dashOffset !== undefined) {
          guide.line.material.dashOffset -= 0.004;
        }
      });
    }

    updateCamera(time) {
      this.zoomVelocity *= this.isActive ? 0.84 : 0.78;
      this.zoomTarget = clamp(this.zoomTarget + this.zoomVelocity, this.zoomRange.min, this.zoomRange.max);
      this.zoomCurrent = lerp(this.zoomCurrent, this.zoomTarget, 0.08);

      const idleX = motionQuery.matches ? 0 : Math.sin(time * 0.00011) * 0.34;
      const idleY = motionQuery.matches ? 0 : Math.cos(time * 0.00008) * 0.14;
      const activityAlpha = clamp((performance.now() - this.lastInteractionAt) < 2200 ? 1 : 0.35, 0.35, 1);
      const focusAlpha = this.isActive ? 1 : 0.7;
      const userAlpha = activityAlpha * focusAlpha;
      const yaw = idleX + (this.pointerTarget.x * 0.5 + this.keyTarget.x * 0.78) * userAlpha;
      const pitch = idleY + (this.pointerTarget.y * 0.24 + this.keyTarget.y * 0.44) * userAlpha;

      /* ── Smoother camera fly-to on focus ── */
      if (this.focusId && this.nodeLookup.has(this.focusId)) {
        const focusEntry = this.nodeLookup.get(this.focusId);
        const focusPos = focusEntry.group.position.clone().multiplyScalar(0.22);
        /* Slightly orbit toward the focused node */
        this.focusTarget.lerp(focusPos, 0.045); /* slower, smoother approach */
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
      this.updateCamera(time);
      this.updateTooltipPosition();

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
