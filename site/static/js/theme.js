(function () {
  "use strict";

  const NAV_COLLAPSE_BREAKPOINT = 1180;

  function closeNav(nav, toggle) {
    if (!nav || !toggle) return;
    nav.dataset.navOpen = "false";
    toggle.setAttribute("aria-expanded", "false");
  }

  function initNavToggle() {
    const nav = document.querySelector(".site-nav");
    const toggle = document.getElementById("nav-menu-toggle");
    const panel = document.getElementById("nav-panel");
    const hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)");
    if (!nav || !toggle || !panel) return;

    function navIsCollapsed() {
      return window.innerWidth <= NAV_COLLAPSE_BREAKPOINT;
    }

    function openNav() {
      if (!nav || !toggle || !navIsCollapsed()) return;
      nav.dataset.navOpen = "true";
      toggle.setAttribute("aria-expanded", "true");
    }

    toggle.addEventListener("click", function () {
      const nextState = nav.dataset.navOpen === "true" ? "false" : "true";
      nav.dataset.navOpen = nextState;
      toggle.setAttribute("aria-expanded", String(nextState === "true"));
    });

    var closeTimer = null;

    function clearCloseTimer() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    }

    toggle.addEventListener("mouseenter", function () {
      if (!hoverCapable.matches) return;
      clearCloseTimer();
      openNav();
    });

    nav.addEventListener("mouseleave", function () {
      if (!hoverCapable.matches) return;
      closeTimer = setTimeout(function () {
        closeNav(nav, toggle);
      }, 180);
    });

    nav.addEventListener("mouseenter", function () {
      clearCloseTimer();
    });

    panel.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        clearCloseTimer();
        closeNav(nav, toggle);
      });
    });

    document.addEventListener("click", function (event) {
      if (!navIsCollapsed()) return;
      if (!nav.contains(event.target)) {
        clearCloseTimer();
        closeNav(nav, toggle);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.dataset.navOpen === "true") {
        clearCloseTimer();
        closeNav(nav, toggle);
        toggle.focus();
      }
    });

    window.addEventListener("resize", function () {
      if (!navIsCollapsed()) {
        clearCloseTimer();
        closeNav(nav, toggle);
      }
    });
  }

  function initRevealAnimations() {
    const elements = document.querySelectorAll(".reveal");
    if (!elements.length) return;

    elements.forEach(function (element) {
      const delay = element.dataset.delay;
      if (delay) {
        element.style.setProperty("--reveal-delay", delay + "ms");
      }
    });

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.forEach(function (element) {
        element.classList.add("is-visible");
      });
      return;
    }

    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.14, rootMargin: "0px 0px -30px 0px" }
    );

    elements.forEach(function (element) {
      if (!element.classList.contains("is-visible")) {
        observer.observe(element);
      }
    });
  }

  function initMarqueeMotion() {
    const stacks = Array.from(document.querySelectorAll(".marquee-stack"));
    if (!stacks.length) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rows = [];
    let frame = null;
    let lastTime = performance.now();
    let lastScrollY = window.scrollY;

    function resetRows() {
      rows.forEach(function (row) {
        row.track.style.transform = "";
        row.track.style.animation = "";
      });
      rows = [];
    }

    function measureRows() {
      resetRows();
      if (reducedMotion.matches) return;

      rows = stacks.flatMap(function (stack, stackIndex) {
        return Array.from(stack.querySelectorAll(".marquee-row")).map(function (row, rowIndex) {
          const track = row.querySelector(".marquee-track");
          if (!track) return null;
          track.style.animation = "none";
          return {
            track,
            direction: row.classList.contains("reverse") ? 1 : -1,
            baseSpeed: 18 + (stackIndex * 2.5) + rowIndex * 2.5,
            impulse: 0,
            offset: row.classList.contains("reverse") ? -(track.scrollWidth / 4 || 0) : 0,
            span: Math.max(track.scrollWidth / 2, 1),
          };
        }).filter(Boolean);
      });
    }

    function applyImpulse(delta) {
      if (!rows.length) return;
      const strength = Math.min(110, Math.abs(delta) * 5);
      rows.forEach(function (row, index) {
        row.impulse = Math.min(130, row.impulse + strength * (1 + index * 0.04));
      });
    }

    function step(now) {
      if (!rows.length) {
        frame = null;
        return;
      }

      const dt = Math.min(0.04, (now - lastTime) / 1000 || 0.016);
      lastTime = now;

      rows.forEach(function (row) {
        const speed = row.baseSpeed + row.impulse;
        row.offset += row.direction * speed * dt;
        row.impulse *= 0.93;

        while (row.offset <= -row.span) row.offset += row.span;
        while (row.offset >= 0) row.offset -= row.span;

        row.track.style.transform = "translate3d(" + row.offset.toFixed(2) + "px, 0, 0)";
      });

      frame = window.requestAnimationFrame(step);
    }

    function onScroll() {
      const current = window.scrollY;
      const delta = current - lastScrollY;
      lastScrollY = current;
      if (delta !== 0) applyImpulse(delta);
      if (!frame && rows.length && !reducedMotion.matches) {
        lastTime = performance.now();
        frame = window.requestAnimationFrame(step);
      }
    }

    function refresh() {
      measureRows();
      if (frame) window.cancelAnimationFrame(frame);
      frame = null;
      if (!reducedMotion.matches && rows.length) {
        lastTime = performance.now();
        frame = window.requestAnimationFrame(step);
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", refresh);
    window.addEventListener("observatory:marquee-refresh", refresh);
    reducedMotion.addEventListener("change", refresh);
    refresh();
  }

  document.documentElement.dataset.theme = "dark";

  function initThemeToggle() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var current = document.documentElement.dataset.theme || "dark";
      var next = current === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("obs-theme", next); } catch (_) {}
    });
  }

  function initTableScrollAffordance() {
    document.querySelectorAll(".table-wrap").forEach(function (wrap) {
      function check() {
        var atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
        wrap.classList.toggle("scrolled-end", atEnd);
      }
      wrap.addEventListener("scroll", check, { passive: true });
      check();
      window.addEventListener("resize", check);
    });
  }

  function init() {
    initNavToggle();
    initThemeToggle();
    initRevealAnimations();
    initMarqueeMotion();
    initTableScrollAffordance();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
