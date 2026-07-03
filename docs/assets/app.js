"use strict";

/* ============================================================
   SyncroNow AI — docs interactions
   Vanilla, no dependencies. Progressive enhancement only:
   the page is fully readable and navigable without JS.
   ============================================================ */

(function () {
  /* ---- Mobile contents drawer (< 900px) ---- */
  const menuBtn = document.getElementById("menuBtn");
  const rail = document.getElementById("rail");
  const overlay = document.getElementById("overlay");

  function setNav(open) {
    if (!rail || !overlay || !menuBtn) return;
    rail.classList.toggle("is-open", open);
    overlay.classList.toggle("is-shown", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("nav-locked", open);
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", () => setNav(!rail.classList.contains("is-open")));
  }
  if (overlay) overlay.addEventListener("click", () => setNav(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setNav(false);
  });

  /* ---- Scroll-spy: highlight the active section in the rail ---- */
  const spyLinks = Array.from(document.querySelectorAll(".rail-link[data-spy]"));
  const sections = spyLinks
    .map((a) => document.getElementById(a.dataset.spy))
    .filter(Boolean);

  function activate(id) {
    spyLinks.forEach((a) => a.classList.toggle("is-active", a.dataset.spy === id));
  }

  if (sections.length && "IntersectionObserver" in window) {
    const visible = new Set();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        });
        // Pick the earliest section (document order) currently on screen.
        const active = sections.find((s) => visible.has(s.id));
        if (active) activate(active.id);
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );
    sections.forEach((s) => io.observe(s));
  }

  // Close the drawer and reflect the target when a rail link is tapped.
  spyLinks.forEach((a) => {
    a.addEventListener("click", () => {
      activate(a.dataset.spy);
      setNav(false);
    });
  });

  /* ---- Copy-to-clipboard buttons on code blocks ---- */
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const block = btn.closest(".code");
      const code = block && block.querySelector("code");
      if (!code) return;
      const text = code.innerText;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        const prev = btn.textContent;
        btn.textContent = "COPIED";
        btn.classList.add("copied");
        window.setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1400);
      } catch (_) {
        /* clipboard unavailable — silently no-op */
      }
    });
  });

  /* ---- Install tabs (source / npm) ---- */
  const tabs = Array.from(document.querySelectorAll(".tab[data-tab]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.tab;
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", String(active));
      });
      document.querySelectorAll(".steps[id^='steps-']").forEach((panel) => {
        panel.hidden = panel.id !== "steps-" + key;
      });
    });
  });

  /* ---- Live command filter ---- */
  const search = document.getElementById("cmdSearch");
  const rows = Array.from(document.querySelectorAll(".cmd-row[data-search]"));
  const empty = document.getElementById("cmdEmpty");

  if (search && rows.length) {
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach((row) => {
        const hit = !q || row.dataset.search.includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      });
      if (empty) empty.classList.toggle("is-shown", shown === 0);
    });
  }

  /* ---- MCP tool families: expand / collapse all ---- */
  const tools = Array.from(document.querySelectorAll(".tools .tool"));
  const expandBtn = document.getElementById("toolsExpand");
  const collapseBtn = document.getElementById("toolsCollapse");
  if (tools.length) {
    if (expandBtn) {
      expandBtn.addEventListener("click", () => {
        tools.forEach((t) => (t.open = true));
      });
    }
    if (collapseBtn) {
      collapseBtn.addEventListener("click", () => {
        tools.forEach((t) => (t.open = false));
      });
    }
  }
})();
