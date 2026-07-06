/*
 * feeds.js - the Subscribe page.
 *
 * Headline feeds (all, free), By category (every category in the taxonomy),
 * and By organization (orgs where ics is non-null). Each feed exposes
 * Subscribe, Copy link, and Download, all composed in the ONE FEED_BASE
 * path in data.js.
 */
(function () {
  "use strict";

  var AEC = window.AEC;
  var OUT = "out"; // the feed URL's target opens in a new tab

  /* ---- terminal states ---- */
  AEC.onError(function (st) {
    var sections = [
      document.getElementById("headline-feeds"),
      document.getElementById("by-category"),
      document.getElementById("by-org")
    ];
    sections.forEach(function (s) { s.removeAttribute("aria-busy"); });

    if (st.kind === "loading") {
      // A calm skeleton in each section while events.json is in flight.
      sections.forEach(function (s) {
        s.innerHTML = '<div class="skel-stack"><div class="skeleton"><div class="skeleton__bar"></div><div class="skeleton__bar--md"></div></div><div class="skeleton"><div class="skeleton__bar"></div><div class="skeleton__bar--sm"></div></div></div>';
      });
      return;
    }

    // fetch-error / schema-changed: one message, not one per section.
    var msg = st.kind === "fetch-error"
      ? "The calendar could not load. Try again shortly."
      : "The calendar data format changed. This page needs an update.";
    sections.forEach(function (s) { s.innerHTML = ""; });
    sections[0].appendChild(el("div", { class: "state" }, [el("h2", { text: msg })]));
  });

  AEC.load().then(function (data) {
    if (!data) return; // error state already shown
    var M = AEC.maps(data);
    var tz = AEC.timezone(data);

    renderFooter(data, tz);
    renderHeadline(data);
    renderCategories(data);
    renderOrgs(data);
  });

  /* ---------------------------------------------------------------- */
  function renderFooter(data, tz) {
    var s = AEC.updatedString(data, tz);
    document.getElementById("footer-updated").textContent = s;
    var u = document.getElementById("updated");
    u.textContent = s;
    u.hidden = false;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    if (children) appendAll(node, children);
    return node;
  }
  function appendAll(node, children) {
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
  }

  /* A copy-and-subscribe control cluster for one feed URL. */
  function feedControls(relPath, fallback) {
    var url = AEC.feedUrl(relPath);
    if (!url) return null;
    var webcalUrl = AEC.feedUrlWebcal(relPath);
    var wrap = document.createDocumentFragment();

    var actions = el("div", { class: "feed-actions" });

    // Subscribe: the primary action. A webcal: link opens the visitor's
    // calendar app straight into its subscribe flow, so the feed stays live
    // and updates nightly rather than importing a frozen copy.
    var sub = el("a", { class: "btn btn--primary btn--sm", href: webcalUrl });
    sub.appendChild(svgCalendar());
    sub.appendChild(document.createTextNode("Subscribe"));

    var copyBtn = el("button", {
      class: "btn btn--ghost btn--sm",
      type: "button",
      "aria-label": "Copy this feed link to the clipboard"
    });
    copyBtn.appendChild(svgCopy());
    copyBtn.appendChild(document.createTextNode("Copy link"));
    var copied = el("span", { class: "copied", role: "status", "aria-live": "polite" });

    // Download: a one-time snapshot for apps that import rather than subscribe.
    var dl = el("a", { class: "btn btn--ghost btn--sm", href: url, download: "" });
    dl.appendChild(svgDownload());
    dl.appendChild(document.createTextNode("Download .ics"));

    copyBtn.addEventListener("click", function () {
      copyText(url, copied, copyBtn, fallback);
    });

    actions.appendChild(sub);
    actions.appendChild(copyBtn);
    actions.appendChild(dl);
    actions.appendChild(copied);
    wrap.appendChild(actions);
    wrap.appendChild(el("div", { class: "feed-card__url", text: url }));
    return wrap;
  }

  function copyText(text, statusNode, btn, fallback) {
    var done = function () {
      statusNode.textContent = "Copied";
      btn.classList.add("btn--primary");
      btn.classList.remove("btn--ghost");
      setTimeout(function () {
        statusNode.textContent = "";
        btn.classList.remove("btn--primary");
        btn.classList.add("btn--ghost");
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, fallback); done(); });
    } else { legacyCopy(text, fallback); done(); }
  }
  function legacyCopy(text, fallback) {
    // Defensive fallback: a textarea + execCommand, hidden off-screen.
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed"; ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* best effort */ }
    document.body.removeChild(ta);
  }

  /* ---- Headline (All + Free) ---- */
  function renderHeadline(data) {
    var sec = document.getElementById("headline-feeds");
    sec.removeAttribute("aria-busy");
    sec.innerHTML = "";

    sec.appendChild(el("h2", { text: "All events and free events" }));
    sec.appendChild(el("p", { text: "The whole calendar in two feeds. Add either one and events update when this calendar refreshes nightly." }));

    var grid = el("div", { class: "feed-grid feed-grid--pair" });

    // All events card
    var allCard = el("div", { class: "feed-card" });
    allCard.appendChild(el("div", { class: "feed-card__name", text: "All events" }));
    allCard.appendChild(el("p", { class: "feed-card__desc", text: "Every scheduled and cancelled showing in the calendar." }));
    allCard.appendChild(feedControls(data.feeds.all, true));
    grid.appendChild(allCard);

    // Free events card
    var freeCard = el("div", { class: "feed-card" });
    freeCard.appendChild(el("div", { class: "feed-card__name", text: "Free events" }));
    freeCard.appendChild(el("p", { class: "feed-card__desc", text: "Only occurrences marked free, matching the free feed." }));
    freeCard.appendChild(feedControls(data.feeds.free, true));
    grid.appendChild(freeCard);

    sec.appendChild(grid);
  }

  /* ---- By category ---- */
  function renderCategories(data) {
    var sec = document.getElementById("by-category");
    sec.removeAttribute("aria-busy");
    sec.innerHTML = "";
    sec.appendChild(el("h2", { text: "By category" }));
    sec.appendChild(el("p", { text: "Every category has its own feed, even categories with no current events." }));

    var grid = el("div", { class: "feed-grid" });
    data.categories.forEach(function (c) {
      var card = el("div", { class: "feed-card" });
      card.appendChild(el("div", { class: "feed-card__name" },
        [svgTag(), document.createTextNode(c.name)]));
      var controls = feedControls(c.ics, true);
      if (controls) { card.appendChild(controls); grid.appendChild(card); }
    });
    sec.appendChild(grid);
  }

  /* ---- By organization (skip null-ics orgs) ---- */
  function renderOrgs(data) {
    var sec = document.getElementById("by-org");
    sec.removeAttribute("aria-busy");
    sec.innerHTML = "";
    sec.appendChild(el("h2", { text: "By organization" }));
    var listed = data.orgs.filter(function (o) { return o.ics != null; });
    sec.appendChild(el("p", { text: listed.length + " organizations publish a feed. Grab the ones you follow." }));

    var grid = el("div", { class: "feed-grid" });
    data.orgs.forEach(function (o) {
      if (o.ics == null) return; // disabled org: no feed to subscribe to
      var card = el("div", { class: "feed-card" });
      card.appendChild(el("div", { class: "feed-card__name" },
        [svgTag(), document.createTextNode(o.name)]));
      var controls = feedControls(o.ics, true);
      if (controls) { card.appendChild(controls); grid.appendChild(card); }
    });
    sec.appendChild(grid);
  }

  /* ---- Inline SVG glyphs (same-origin, uniform stroke) ---- */
  function svgIcon(path) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    s.appendChild(p);
    return s;
  }
  function svgCopy() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round"); s.setAttribute("aria-hidden", "true");
    [["d", "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"],
     ["d", "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"]].forEach(function (d) {
      var p = document.createElementNS(ns, "path"); p.setAttribute("d", d[1]); s.appendChild(p);
    });
    return s;
  }
  function svgDownload() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    [["d", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
     ["d", "M7 10l5 5 5-5"],
     ["d", "M12 15V3"]].forEach(function (d) {
      var p = document.createElementNS(ns, "path"); p.setAttribute("d", d[1]); s.appendChild(p);
    });
    return s;
  }
  function svgTag() {
    return svgIcon("M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z");
  }
  function svgCalendar() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    var rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", "3"); rect.setAttribute("y", "4"); rect.setAttribute("width", "18");
    rect.setAttribute("height", "18"); rect.setAttribute("rx", "2"); s.appendChild(rect);
    [["16", "2", "16", "6"], ["8", "2", "8", "6"], ["3", "10", "21", "10"]].forEach(function (a) {
      var l = document.createElementNS(ns, "line"); var i = 0;
      ["x1", "y1", "x2", "y2"].forEach(function (k) { l.setAttribute(k, a[i++]); }); s.appendChild(l);
    });
    return s;
  }
})();
