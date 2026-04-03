(function () {
  var canvas = document.getElementById('hero-torus-bg');
  if (!canvas || !window.THREE) return;

  // Switch to 'machine' to compare against the tighter contact motion.
  var TORUS_MOTION_MODE = 'legacy';
  var quarterTurn = Math.PI / 2;
  var hero = canvas.closest('.hero-stage') || canvas.parentElement;
  var backdrop = canvas.closest('.hero-backdrop') || hero;
  var signalCore = hero.querySelector('.hero-signal-core');
  var orbitA = hero.querySelector('.hero-orbit-a');
  var orbitB = hero.querySelector('.hero-orbit-b');
  var reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var prefersReducedMotion = !!reduceMotionQuery.matches;
  var animationFrame = null;

  function heroWidth() { return hero.offsetWidth || window.innerWidth; }
  function heroHeight() { return hero.offsetHeight || window.innerHeight; }

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(46, heroWidth() / heroHeight(), 0.1, 1000);
  var renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power'
  });

  renderer.setSize(heroWidth(), heroHeight());
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  var torusRadius = 1;
  var torusTubeRadius = 0.17;
  var torusOuterDiameter = (torusRadius + torusTubeRadius) * 2;
  var torusGeometry = new THREE.TorusGeometry(torusRadius, torusTubeRadius, 28, 196);
  var centerNodeGeometry = new THREE.SphereGeometry(0.055, 24, 24);
  var centerShellGeometry = new THREE.SphereGeometry(0.13, 24, 24);
  var centerAuraGeometry = new THREE.SphereGeometry(0.235, 20, 20);
  var torusGroup = new THREE.Group();
  var torusAssembly = new THREE.Group();
  function normalizeMotionMode(value) {
    return value === 'legacy' ? 'legacy' : value === 'machine' ? 'machine' : null;
  }

  function resolveMotionMode() {
    var params = new URLSearchParams(window.location.search);
    var queryMode = normalizeMotionMode(params.get('torusMotion'));
    var defaultMode = normalizeMotionMode(TORUS_MOTION_MODE);

    return queryMode || defaultMode || 'machine';
  }

  var motionMode = resolveMotionMode();

  torusGroup.add(torusAssembly);
  scene.add(torusGroup);

  var ringDefinitions = [
    {
      wireColor: 0x6f9fff,
      wireOpacity: 0.30,
      shellColor: 0x5e92f5,
      shellOpacity: 0.06,
      ghostColor: 0x6aa8ff,
      ghostOpacity: 0.018,
      ghostScale: 1.014,
      baseRotation: [0, 0, 0],
      machinePhase: 0,
      machineSpeed: 0.038,
      legacyPhase: 0,
      legacySpeed: 0.12
    },
    {
      wireColor: 0xe9e1fb,
      wireOpacity: 0.215,
      shellColor: 0xd9d3f4,
      shellOpacity: 0.052,
      ghostColor: 0xbdd3ff,
      ghostOpacity: 0.035,
      ghostScale: 1.025,
      baseRotation: [quarterTurn, 0, 0],
      machinePhase: 0,
      machineSpeed: -0.032,
      legacyPhase: quarterTurn * 0.35,
      legacySpeed: -0.1
    },
    {
      wireColor: 0x6487e8,
      wireOpacity: 0.10,
      shellColor: 0x5779d4,
      shellOpacity: 0.028,
      ghostColor: 0x6b9fff,
      ghostOpacity: 0.02,
      ghostScale: 1.02,
      baseRotation: [0, quarterTurn, 0],
      machinePhase: 0,
      machineSpeed: 0.028,
      legacyPhase: quarterTurn * 0.68,
      legacySpeed: 0.085
    }
  ];

  var rings = ringDefinitions.map(function (definition) {
    var occluderMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      side: THREE.DoubleSide,
      colorWrite: false,
      depthWrite: true,
      depthTest: true
    });
    var shellMaterial = new THREE.MeshBasicMaterial({
      color: definition.shellColor,
      side: THREE.DoubleSide,
      opacity: definition.shellOpacity,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });
    var ghostMaterial = new THREE.MeshBasicMaterial({
      color: definition.ghostColor,
      side: THREE.DoubleSide,
      opacity: definition.ghostOpacity,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });
    var wireMaterial = new THREE.MeshBasicMaterial({
      color: definition.wireColor,
      wireframe: true,
      opacity: definition.wireOpacity,
      transparent: true,
      depthWrite: false,
      depthTest: true
    });
    var ringBase = new THREE.Group();
    var ringSpin = new THREE.Group();
    var ringOccluder = new THREE.Mesh(torusGeometry, occluderMaterial);
    var ringShell = new THREE.Mesh(torusGeometry, shellMaterial);
    var ringGhost = new THREE.Mesh(torusGeometry, ghostMaterial);
    var ringWire = new THREE.Mesh(torusGeometry, wireMaterial);

    ringOccluder.renderOrder = 0;
    ringShell.renderOrder = 1;
    ringGhost.renderOrder = 2;
    ringWire.renderOrder = 3;
    ringGhost.scale.setScalar(definition.ghostScale);

    ringBase.rotation.set(
      definition.baseRotation[0],
      definition.baseRotation[1],
      definition.baseRotation[2]
    );
    ringSpin.add(ringOccluder);
    ringSpin.add(ringShell);
    ringSpin.add(ringGhost);
    ringSpin.add(ringWire);
    ringBase.add(ringSpin);
    torusAssembly.add(ringBase);

    return {
      base: ringBase,
      spin: ringSpin,
      occluder: ringOccluder,
      shell: ringShell,
      ghost: ringGhost,
      wire: ringWire,
      machinePhase: definition.machinePhase,
      machineSpeed: definition.machineSpeed,
      legacyPhase: definition.legacyPhase,
      legacySpeed: definition.legacySpeed
    };
  });

  var centerAnchor = new THREE.Group();
  var centerOuterAura = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 20, 20),
    new THREE.MeshBasicMaterial({
      color: 0x9ec8ff,
      opacity: 0.015,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    })
  );
  var centerAura = new THREE.Mesh(centerAuraGeometry, new THREE.MeshBasicMaterial({
    color: 0x7dd4ff,
    opacity: 0.045,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  }));
  var centerShell = new THREE.Mesh(centerShellGeometry, new THREE.MeshBasicMaterial({
    color: 0x84daff,
    opacity: 0.08,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  }));
  var centerNode = new THREE.Mesh(centerNodeGeometry, new THREE.MeshBasicMaterial({
    color: 0xe5f7ff,
    opacity: 0.32,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  }));

  centerOuterAura.renderOrder = 0;
  centerAura.renderOrder = 1;
  centerShell.renderOrder = 2;
  centerNode.renderOrder = 4;
  centerAnchor.add(centerOuterAura);
  centerAnchor.add(centerAura);
  centerAnchor.add(centerShell);
  centerAnchor.add(centerNode);
  torusAssembly.add(centerAnchor);

  var isMobile = window.innerWidth <= 768;
  var cameraZ = 8.6;
  var fov = camera.fov * Math.PI / 180;
  var idlePhase = 0;
  var last = performance.now();
  var showCore = hero.getAttribute('data-hero-signal-mode') !== 'torus';
  var assemblyBaseRotation = { x: 0, y: 0, z: 0 };
  var assemblyBasePosition = { x: 0, y: 0, z: 0 };

  hero.setAttribute('data-torus-motion-mode', motionMode);
  window.__UCIP_HERO_TORUS_MODE__ = motionMode;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function visibleHeight() {
    return 2 * Math.tan(fov / 2) * camera.position.z;
  }

  function visibleWidth() {
    return visibleHeight() * camera.aspect;
  }

  function rectCenter(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function averageCenters(centers) {
    var totals = centers.reduce(function (accumulator, center) {
      accumulator.x += center.x;
      accumulator.y += center.y;
      return accumulator;
    }, { x: 0, y: 0 });

    return {
      x: totals.x / centers.length,
      y: totals.y / centers.length
    };
  }

  function getTargetMetrics() {
    var heroRect = backdrop.getBoundingClientRect();
    var orbitRect = orbitA ? orbitA.getBoundingClientRect() : null;
    var orbitInnerRect = orbitB ? orbitB.getBoundingClientRect() : null;
    var orbitCenters = [];
    var defaultCenter;
    var coreRect;
    var center;
    var baseDiameter;

    if (orbitRect && orbitRect.width > 0) {
      orbitCenters.push(rectCenter(orbitRect));
    }
    if (orbitInnerRect && orbitInnerRect.width > 0) {
      orbitCenters.push(rectCenter(orbitInnerRect));
    }

    defaultCenter = orbitCenters.length > 0
      ? averageCenters(orbitCenters)
      : {
          x: heroRect.left + heroRect.width * (isMobile ? 0.64 : 0.73),
          y: heroRect.top + heroRect.height * (isMobile ? 0.34 : 0.48)
        };

    coreRect = showCore && signalCore ? signalCore.getBoundingClientRect() : null;
    center = coreRect && coreRect.width > 0 ? rectCenter(coreRect) : defaultCenter;
    baseDiameter = orbitRect ? orbitRect.width * 1.34 : heroRect.width * 0.48;

    if (orbitInnerRect && orbitInnerRect.width > 0) {
      baseDiameter = Math.max(baseDiameter, orbitInnerRect.width * 1.52);
    }

    baseDiameter = clamp(
      baseDiameter,
      isMobile ? Math.min(heroRect.width * 0.54, 190) : 360,
      isMobile ? Math.min(heroRect.width * 0.68, 248) : 700
    );

    return {
      centerX: center.x - heroRect.left,
      centerY: center.y - heroRect.top,
      diameter: baseDiameter
    };
  }

  function getSpinAngle(ring, mode, time) {
    if (mode === 'legacy') {
      return ring.legacyPhase + time * ring.legacySpeed;
    }

    return ring.machinePhase + time * ring.machineSpeed;
  }

  function applyStaticPose(mode) {
    var poseMode = mode || 'machine';

    torusAssembly.rotation.set(
      assemblyBaseRotation.x,
      assemblyBaseRotation.y,
      assemblyBaseRotation.z
    );
    torusGroup.position.set(
      assemblyBasePosition.x,
      assemblyBasePosition.y,
      assemblyBasePosition.z
    );
    rings.forEach(function (ring) {
      ring.spin.rotation.z = getSpinAngle(ring, poseMode, 0);
    });
    centerAura.scale.setScalar(1);
    centerShell.scale.setScalar(1);
    centerOuterAura.scale.setScalar(1);
  }

  function applyMachineMotion(time) {
    torusAssembly.rotation.x = assemblyBaseRotation.x + Math.sin(time * 0.18) * 0.016;
    torusAssembly.rotation.y = assemblyBaseRotation.y + time * 0.135;
    torusAssembly.rotation.z = assemblyBaseRotation.z + Math.cos(time * 0.16) * 0.012;
    torusGroup.position.x = assemblyBasePosition.x + Math.sin(time * 0.11) * 0.008;
    torusGroup.position.y = assemblyBasePosition.y + Math.sin(time * 0.24) * 0.018;
    torusGroup.position.z = assemblyBasePosition.z;

    rings.forEach(function (ring) {
      ring.spin.rotation.x = 0;
      ring.spin.rotation.y = 0;
      ring.spin.rotation.z = getSpinAngle(ring, 'machine', time);
    });

    centerAura.scale.setScalar(1 + Math.sin(time * 0.42) * 0.052);
    centerShell.scale.setScalar(1 + Math.sin(time * 0.52 + 0.4) * 0.03);
    centerOuterAura.scale.setScalar(1 + Math.sin(time * 0.28) * 0.04);
  }

  function applyLegacyMotion(time) {
    torusAssembly.rotation.x = assemblyBaseRotation.x + Math.sin(time * 0.29) * 0.055;
    torusAssembly.rotation.y = assemblyBaseRotation.y + time * 0.255;
    torusAssembly.rotation.z = assemblyBaseRotation.z + Math.cos(time * 0.23) * 0.042;
    torusGroup.position.x = assemblyBasePosition.x + Math.sin(time * 0.17) * 0.019;
    torusGroup.position.y = assemblyBasePosition.y + Math.sin(time * 0.37) * 0.036;
    torusGroup.position.z = assemblyBasePosition.z;

    rings.forEach(function (ring, index) {
      ring.spin.rotation.x = Math.sin(time * 0.72 + index * 1.4) * 0.22;
      ring.spin.rotation.y = Math.cos(time * 0.54 + index * 1.1) * 0.18;
      ring.spin.rotation.z = getSpinAngle(ring, 'legacy', time);
    });

    centerAura.scale.setScalar(1 + Math.sin(time * 0.66) * 0.082);
    centerShell.scale.setScalar(1 + Math.sin(time * 0.82 + 0.5) * 0.052);
    centerOuterAura.scale.setScalar(1 + Math.sin(time * 0.38) * 0.06);
  }

  function syncTorusToHero() {
    var metrics = getTargetMetrics();
    var width = heroWidth();
    var height = heroHeight();
    var normalizedX = metrics.centerX / width;
    var normalizedY = metrics.centerY / height;
    var worldWidth = visibleWidth();
    var worldHeight = visibleHeight();
    var worldDiameter = (metrics.diameter / width) * worldWidth;
    var scale = worldDiameter / torusOuterDiameter;

    assemblyBasePosition.x = (normalizedX - 0.5) * worldWidth;
    assemblyBasePosition.y = (0.5 - normalizedY) * worldHeight;
    assemblyBasePosition.z = showCore ? -0.05 : 0.02;

    torusGroup.position.set(
      assemblyBasePosition.x,
      assemblyBasePosition.y,
      assemblyBasePosition.z
    );
    torusGroup.scale.setScalar(scale);
    centerAnchor.position.set(0, 0, 0);

    assemblyBaseRotation.x = isMobile ? 0.82 : 0.86;
    assemblyBaseRotation.y = isMobile ? -0.46 : -0.54;
    assemblyBaseRotation.z = isMobile ? 0.12 : 0.1;

    applyStaticPose(prefersReducedMotion ? 'machine' : motionMode);
    canvas.style.opacity = isMobile ? '0.58' : '0.82';
  }

  camera.position.z = cameraZ;
  syncTorusToHero();

  function animate() {
    animationFrame = requestAnimationFrame(animate);
    var now = performance.now();
    var dt = (now - last) / 1000;
    last = now;

    if (dt > 0.1) dt = 0.016;

    if (!prefersReducedMotion) {
      idlePhase += dt;
      if (motionMode === 'legacy') {
        applyLegacyMotion(idlePhase);
      } else {
        applyMachineMotion(idlePhase);
      }
    } else {
      applyStaticPose('machine');
    }

    renderer.render(scene, camera);
  }

  animate();

  function onMotionPreferenceChange(event) {
    prefersReducedMotion = !!event.matches;
    if (prefersReducedMotion) {
      applyStaticPose('machine');
      renderer.render(scene, camera);
    }
  }

  function onResize() {
    isMobile = window.innerWidth <= 768;
    camera.aspect = heroWidth() / heroHeight();
    camera.updateProjectionMatrix();
    renderer.setSize(heroWidth(), heroHeight());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    syncTorusToHero();
    renderer.render(scene, camera);
  }

  window.addEventListener('resize', onResize);
  if (typeof reduceMotionQuery.addEventListener === 'function') {
    reduceMotionQuery.addEventListener('change', onMotionPreferenceChange);
  } else if (typeof reduceMotionQuery.addListener === 'function') {
    reduceMotionQuery.addListener(onMotionPreferenceChange);
  }
})();
