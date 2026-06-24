// SyncroNow AI docs — small progressive-enhancement script, no dependencies.
(function () {
  "use strict";

  /* ---- Theme (persisted; respects system preference on first visit) ---- */
  var root = document.documentElement;
  var themeBtn = document.getElementById("themeBtn");
  var stored = null;
  try {
    stored = localStorage.getItem("syncrona-theme");
  } catch (e) {
    /* private mode */
  }
  var initial =
    stored ||
    (window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  setTheme(initial);

  function setTheme(t) {
    root.setAttribute("data-theme", t);
    if (themeBtn) {
      themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
      themeBtn.setAttribute("aria-pressed", String(t === "dark"));
      themeBtn.title = t === "dark" ? "Switch to light theme" : "Switch to dark theme";
    }
  }
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next =
        root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setTheme(next);
      try {
        localStorage.setItem("syncrona-theme", next);
      } catch (e) {
        /* ignore */
      }
    });
  }

  /* ---- Mobile sidebar ---- */
  var sidebar = document.getElementById("sidebar");
  var backdrop = document.getElementById("backdrop");
  var menuBtn = document.getElementById("menuBtn");
  function closeMenu() {
    if (sidebar) sidebar.classList.remove("open");
    if (backdrop) backdrop.classList.remove("show");
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      if (!sidebar) return;
      var open = sidebar.classList.toggle("open");
      if (backdrop) backdrop.classList.toggle("show", open);
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeMenu);
  if (sidebar) {
    sidebar.addEventListener("click", function (e) {
      if (e.target && e.target.tagName === "A") closeMenu();
    });
  }

  /* ---- Back-to-top button ---- */
  var toTop = document.getElementById("toTop");
  if (toTop) {
    window.addEventListener(
      "scroll",
      function () {
        toTop.classList.toggle("show", window.scrollY > 700);
      },
      { passive: true },
    );
    toTop.addEventListener("click", function () {
      var reduce =
        window.matchMedia &&
        matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
  }

  /* ---- Accessibility: mark table header cells as column scope ---- */
  document.querySelectorAll("thead th").forEach(function (th) {
    th.setAttribute("scope", "col");
  });

  /* ---- Copy buttons + language labels on code blocks ---- */
  document.querySelectorAll(".codeblock").forEach(function (block) {
    var lang = block.getAttribute("data-lang");
    if (lang) {
      var tag = document.createElement("span");
      tag.className = "lang";
      tag.textContent = lang;
      block.appendChild(tag);
    }
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var code = block.querySelector("code");
      var text = code ? code.innerText : "";
      var done = function () {
        btn.textContent = "Copied";
        setTimeout(function () {
          btn.textContent = "Copy";
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch (e) {
          /* ignore */
        }
        document.body.removeChild(ta);
        done();
      }
    });
    block.appendChild(btn);
  });

  /* ---- Heading anchor links ---- */
  document.querySelectorAll("section[id] > h2").forEach(function (h) {
    var sec = h.closest("section[id]");
    if (!sec || !h.parentElement) return;
    var a = document.createElement("a");
    a.className = "anchor";
    a.href = "#" + sec.id;
    a.textContent = "#";
    a.setAttribute("aria-label", "Link to this section");
    h.appendChild(a);
  });

  /* ---- Scrollspy: highlight the active sidebar link ---- */
  var links = Array.prototype.slice.call(
    document.querySelectorAll(".sidebar nav a"),
  );
  var byId = {};
  links.forEach(function (a) {
    var id = a.getAttribute("href");
    if (id && id.charAt(0) === "#") byId[id.slice(1)] = a;
  });
  var sections = links
    .map(function (a) {
      var id = a.getAttribute("href").slice(1);
      return document.getElementById(id);
    })
    .filter(Boolean);

  function setActive(id) {
    links.forEach(function (a) {
      a.classList.remove("active");
      a.removeAttribute("aria-current");
    });
    if (byId[id]) {
      byId[id].classList.add("active");
      byId[id].setAttribute("aria-current", "true");
    }
  }

  // Highlight the section in the URL hash (or the first one) on load.
  var initialId = (location.hash || "").replace("#", "");
  setActive(byId[initialId] ? initialId : sections.length ? sections[0].id : "");

  if ("IntersectionObserver" in window && sections.length) {
    var visible = new Set();
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        });
        // Pick the topmost visible section.
        var best = null;
        var bestTop = Infinity;
        sections.forEach(function (s) {
          if (!visible.has(s.id)) return;
          var top = s.getBoundingClientRect().top;
          if (top < bestTop) {
            bestTop = top;
            best = s.id;
          }
        });
        if (best) setActive(best);
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 },
    );
    sections.forEach(function (s) {
      observer.observe(s);
    });
  }

  /* ---- Reference panels: expand / collapse all ---- */
  function allToolDetails() {
    return Array.prototype.slice.call(
      document.querySelectorAll("details.tool"),
    );
  }
  var expandBtn = document.getElementById("expand-all-tools");
  var collapseBtn = document.getElementById("collapse-all-tools");
  if (expandBtn) {
    expandBtn.addEventListener("click", function () {
      allToolDetails().forEach(function (d) {
        d.open = true;
      });
    });
  }
  if (collapseBtn) {
    collapseBtn.addEventListener("click", function () {
      allToolDetails().forEach(function (d) {
        d.open = false;
      });
    });
  }

  /* ---- Hero terminal: typed commands, color-coded output, cycling scenarios ---- */
  (function heroTerminal() {
    var body = document.getElementById("term-body");
    if (!body) return;

    // Each step is { cmd } (typed out), { out: [[text, class], …] } (rendered
    // instantly) or { wait: ms } (pause). Colours reference .term-body token
    // classes so they stay themeable and consistent with the rest of the UI;
    // a segment with no class inherits the terminal's foreground colour.
    var scenarios = [
      // 1 · Dev workflow
      [
        { cmd: "syncrona login" },
        { out: [["✔ ", "ok"], ["Saved credentials · ", "muted"], ["dev12345.service-now.com"]] },
        { cmd: "syncrona init" },
        { out: [["✔ ", "ok"], ["Wrote ", "muted"], ["sync.config.js · sync.manifest.json · .env"]] },
        { out: [["✔ ", "ok"], ["Scope ", "muted"], ["x_acme_app", "accent"], [" · 142 files tracked", "muted"]] },
        { cmd: "syncrona dev" },
        { out: [["▸ ", "blue"], ["watching ", "muted"], ["src/"], [" · build & push on save", "muted"]] },
        { wait: 700 },
        { out: [["~ ", "warn"], ["PriceCalc/script.ts"], [" → babel + typescript", "muted"]], delay: 280 },
        { out: [["✔ ", "ok"], ["pushed ", "muted"], ["PriceCalc"], [" · 312ms", "dim"]] },
        { wait: 900 },
        { out: [["~ ", "warn"], ["Utils/helpers.ts"], [" → babel + typescript", "muted"]], delay: 280 },
        { out: [["✔ ", "ok"], ["pushed ", "muted"], ["Utils"], [" · 198ms", "dim"]] },
        { wait: 2000 },
      ],
      // 2 · Diff push
      [
        { cmd: "syncrona push --diff main" },
        { out: [["▸ ", "blue"], ["git diff main"], [" · 3 files changed", "muted"]] },
        { wait: 350 },
        { out: [["~ ", "warn"], ["PriceCalc/script.ts"], [" → babel + typescript", "muted"]], delay: 240 },
        { out: [["~ ", "warn"], ["TaxRule/rule.ts"], [" → typescript", "muted"]], delay: 240 },
        { out: [["~ ", "warn"], ["theme.scss"], [" → sass", "muted"]], delay: 240 },
        { out: [["✔ ", "ok"], ["pushed ", "muted"], ["3 records"], [" · 1.2s", "dim"]] },
        { wait: 2200 },
      ],
      // 3 · MCP / AI analysis
      [
        { cmd: "syncrona mcp" },
        { out: [["▸ ", "blue"], ["MCP server listening"], [" · stdio · 59 tools", "muted"]] },
        { wait: 600 },
        { out: [["🤖 ", "accent"], ["sn_build_dependency_graph"]], delay: 320 },
        { out: [["✔ ", "ok"], ["142 nodes · 318 edges"], [" · 2 cycles", "warn"]] },
        { wait: 700 },
        { out: [["🤖 ", "accent"], ["sn_analyze_impact "], ["PriceCalc", "accent"]], delay: 320 },
        { out: [["✔ ", "ok"], ["blast radius: ", "muted"], ["7 downstream records"]] },
        { wait: 2200 },
      ],
      // 4 · Docs
      [
        { cmd: "syncrona docs" },
        { out: [["▸ ", "blue"], ["generating ", "muted"], ["markdown + mermaid"]] },
        { wait: 650 },
        { out: [["✔ ", "ok"], ["overview.md"], [" · 12 tables · 142 records", "muted"]], delay: 300 },
        { out: [["✔ ", "ok"], ["dependency-graph.mmd"], [" · rendered", "muted"]], delay: 300 },
        { out: [["✔ ", "ok"], ["wrote ", "muted"], ["docs/"], [" · 3.4s", "dim"]] },
        { wait: 2200 },
      ],
    ];

    var reduce =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var scenario = 0;

    function span(text, cls) {
      var s = document.createElement("span");
      if (cls) s.className = cls;
      s.textContent = text;
      return s;
    }
    function row() {
      var r = document.createElement("div");
      r.className = "l";
      return r;
    }
    function cursor() {
      var c = document.createElement("span");
      c.className = "term-cursor";
      return c;
    }
    function addLine(segs) {
      var r = row();
      segs.forEach(function (sg) {
        r.appendChild(span(sg[0], sg[1]));
      });
      body.appendChild(r);
    }
    function idlePrompt() {
      var r = row();
      r.appendChild(span("❯ ", "prompt"));
      r.appendChild(cursor());
      body.appendChild(r);
    }
    function typeCmd(text, done) {
      var r = row();
      r.appendChild(span("❯ ", "prompt"));
      var typed = span("", "cmd");
      var cur = cursor();
      r.appendChild(typed);
      r.appendChild(cur);
      body.appendChild(r);
      var k = 0;
      function tick() {
        k++;
        typed.textContent = text.slice(0, k);
        if (k < text.length) setTimeout(tick, 42 + Math.random() * 55);
        else
          setTimeout(function () {
            r.removeChild(cur);
            done();
          }, 480);
      }
      setTimeout(tick, 360);
    }

    function run(i) {
      var seq = scenarios[scenario];
      if (i >= seq.length) {
        setTimeout(function () {
          body.innerHTML = "";
          scenario = (scenario + 1) % scenarios.length;
          run(0);
        }, 650);
        return;
      }
      var step = seq[i];
      if (step.cmd != null) {
        typeCmd(step.cmd, function () {
          run(i + 1);
        });
      } else if (step.out) {
        setTimeout(function () {
          addLine(step.out);
          run(i + 1);
        }, step.delay || 170);
      } else if (step.wait) {
        setTimeout(function () {
          run(i + 1);
        }, step.wait);
      } else {
        run(i + 1);
      }
    }

    body.innerHTML = "";
    if (reduce) {
      // Static fallback: render the first scenario in full, no typing.
      scenarios[0].forEach(function (s) {
        if (s.cmd != null) addLine([["❯ ", "prompt"], [s.cmd, "cmd"]]);
        else if (s.out) addLine(s.out);
      });
      idlePrompt();
    } else {
      run(0);
    }
  })();
})();
