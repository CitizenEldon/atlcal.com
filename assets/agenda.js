/*
 * agenda.js - flat, forward-only occurrence list grouped by ET day.
 *
 * Flatten events.flatMap(o => ({e,o})), key each by dayKey(o.starts_at),
 * and repeat all-day occurrences under every ET day they cover. Past-hiding
 * keys on the effective END (ends_at ?? starts_at), never starts_at, so the
 * ongoing exhibition "Georgia Made" (opened before generated_at, still run-
 * ning) stays visible. Free filter matches free.ics scope (occurrence.is_free).
 *
 * Filters and the detail modal are inlined here (kept in sync with calendar.js)
 * rather than via a separate shared file, per the deliverables.
 */
(function () {
  "use strict";
  var AEC = window.AEC;

  var state = {
    data: null, M: null, tz: null,
    cat: "all", org: "all", free: false
  };

  var out = document.getElementById("agenda-out");
  var empty = document.getElementById("agenda-empty");
  var statusEl = document.getElementById("agenda-status");

  /* ---- terminal states ---- */
  AEC.onError(function (s) {
    if (s.kind === "loading") {
      out.setAttribute("aria-busy", "true");
      statusEl.textContent = "Loading calendar events.";
      out.innerHTML = '<div class="skel-stack">' + skeletonRow().outerHTML + skeletonRow().outerHTML + skeletonRow().outerHTML + skeletonRow().outerHTML + '</div>';
    } else if (s.kind === "fetch-error") {
      out.removeAttribute("aria-busy");
      statusEl.textContent = "The calendar could not load.";
      out.innerHTML = '<div class="state"><h2>The calendar could not load. Try again shortly.</h2></div>';
    } else if (s.kind === "schema-changed") {
      out.removeAttribute("aria-busy");
      statusEl.textContent = "The calendar data format is not supported.";
      out.innerHTML = '<div class="state"><h2>The calendar data format changed. This page needs an update.</h2></div>';
    }
  });
  function skeletonRow() {
    var d = document.createElement("div");
    d.className = "skeleton";
    d.innerHTML = '<div class="skeleton__bar"></div><div class="skeleton__bar--md"></div><div class="skeleton__bar--sm"></div>';
    return d;
  }

  AEC.load().then(function (data) {
    if (!data) return;
    state.data = data;
    state.M = AEC.maps(data);
    state.tz = AEC.timezone(data);
    document.getElementById("footer-updated").textContent = AEC.updatedString(data, state.tz);
    renderFilters();
    filterBar.hidden = false;
    render();
    statusEl.textContent = "Agenda loaded.";
  });

  /* ====================================================================
   * Filter bar (shared with calendar.js)
   * =================================================================== */
  var filterBar = document.getElementById("filters");
  function renderFilters() {
    filterBar.innerHTML = "";
    filterBar.appendChild(field("category", "Category", catOptions(state.data), "cat"));
    filterBar.appendChild(field("org", "Organization", orgOptions(state.data), "org"));
    var spacer = document.createElement("div"); spacer.className = "filters__spacer"; filterBar.appendChild(spacer);

    var sw = document.createElement("label"); sw.className = "switch";
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.id = "free-only";
    var track = document.createElement("span"); track.className = "switch__track";
    var thumb = document.createElement("span"); thumb.className = "switch__thumb"; track.appendChild(thumb);
    var lbl = document.createElement("label"); lbl.htmlFor = "free-only"; lbl.textContent = "Free only";
    sw.appendChild(cb); sw.appendChild(track); sw.appendChild(lbl);
    cb.addEventListener("change", function () { state.free = cb.checked; render(); });
    filterBar.appendChild(sw);

    var clear = document.createElement("button");
    clear.type = "button"; clear.className = "btn btn--ghost"; clear.textContent = "Clear filters";
    clear.setAttribute("aria-label", "Clear all filters");
    clear.addEventListener("click", resetFilters);
    filterBar.appendChild(clear);
  }
  function field(id, label, optionsHtml, stateKey) {
    var f = document.createElement("label"); f.className = "field"; f.htmlFor = id;
    var l = document.createElement("span"); l.className = "field__label"; l.textContent = label; l.style.fontWeight = "600"; l.style.fontSize = "var(--step--1)"; l.style.color = "var(--text-soft)";
    var s = document.createElement("select"); s.id = id; s.name = id;
    s.innerHTML = optionsHtml;
    s.value = state[stateKey];
    s.addEventListener("change", function () { state[stateKey] = s.value; render(); });
    f.appendChild(l); f.appendChild(s);
    return f;
  }
  function catOptions(data) {
    var h = '<option value="all">All categories</option>';
    data.categories.forEach(function (c) {
      h += '<option value="' + c.id + '">' + AEC.escapeHtml(c.name) + '</option>';
    });
    h += '<option value="none">Uncategorized</option>';
    return h;
  }
  function orgOptions(data) {
    var h = '<option value="all">All organizations</option>';
    data.orgs.forEach(function (o) {
      h += '<option value="' + o.id + '">' + AEC.escapeHtml(o.name) + '</option>';
    });
    return h;
  }
  function resetFilters() {
    state.cat = "all"; state.org = "all"; state.free = false;
    var f = filterBar.querySelector("#category"); if (f) f.value = "all";
    var o = filterBar.querySelector("#org"); if (o) o.value = "all";
    var cb = filterBar.querySelector("#free-only"); if (cb) cb.checked = false;
    render();
  }

  /* ====================================================================
   * Occurrence flattening + day grouping
   * =================================================================== */
  // Build the flat list of {e,o, dayKey} pairs, honoring filters and past-hide.
  function flatten() {
    var now = Date.now() / 1000;
    var todayKey = AEC.dayKey(Math.floor(now), state.tz);
    var items = [];
    state.data.events.forEach(function (e) {
      if (!eventPasses(e)) return;
      e.occurrences.forEach(function (o) {
        if (!occurrencePasses(o)) return;
        var end = AEC.effectiveEnd(o);
        if (end < now) return; // past-hiding on the END
        // All-day spans repeat under every ET day they cover, but the agenda is
        // forward-only: an ongoing exhibition (Georgia Made, opened weeks ago)
        // is anchored at today, never backfilled with the days already gone.
        var days = AEC.occurrenceDays(o, state.tz);
        days.forEach(function (k) {
          if (k < todayKey) return;
          items.push({ e: e, o: o, day: k });
        });
      });
    });
    items.sort(function (a, b) {
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      var sa = a.o.is_all_day ? 0 : 1;
      var sb = b.o.is_all_day ? 0 : 1;
      if (sa !== sb) return sa - sb; // all-day first within a day
      return a.o.starts_at - b.o.starts_at;
    });
    return items;
  }

  function eventPasses(e) {
    if (state.cat !== "all") {
      if (state.cat === "none" && e.category_id != null) return false;
      if (state.cat !== "none" && String(e.category_id) !== state.cat) return false;
    }
    if (state.org !== "all" && String(e.org_id) !== state.org) return false;
    if (state.free && !AEC.eventHasFreeOccurrence(e)) return false;
    return true;
  }
  function occurrencePasses(o) {
    if (state.free && !o.is_free) return false;
    return true;
  }

  /* ====================================================================
   * Render
   * =================================================================== */
  function render() {
    out.removeAttribute("aria-busy");
    var items = flatten();

    if (items.length === 0) {
      out.innerHTML = "";
      empty.hidden = false;
      empty.innerHTML = '<h2>No events match these filters.</h2>' +
        '<p><button class="btn btn--primary" type="button" id="empty-clear">Clear filters</button></p>';
      var b = document.getElementById("empty-clear");
      if (b) b.addEventListener("click", resetFilters);
      return;
    }
    empty.hidden = true; empty.innerHTML = "";
    out.innerHTML = "";

    // Group by day key (lexicographically ordered already).
    var groups = {}, order = [];
    items.forEach(function (it) {
      if (!groups[it.day]) { groups[it.day] = []; order.push(it.day); }
      groups[it.day].push(it);
    });

    var todayKey = AEC.dayKey(Math.floor(Date.now() / 1000), state.tz);
    var fragment = document.createDocumentFragment();

    order.forEach(function (key) {
      var g = el("section", { class: "day-group" });
      if (key === todayKey) g.classList.add("is-today");
      var head = dayHeader(key, key === todayKey);
      g.appendChild(head);

      var ul = el("ul", { class: "day-group__items" });
      groups[key].forEach(function (it) {
        ul.appendChild(rowNode(it));
      });
      g.appendChild(ul);
      fragment.appendChild(g);
    });
    out.appendChild(fragment);
  }

  function dayHeader(key, isToday) {
    var inst = dayKeyToInstant(key);
    var fDate = AEC.fmt(state.tz, { month: "long", day: "numeric" });
    var fWday = AEC.fmt(state.tz, { weekday: "long" });
    var h = el("div", { class: "day-group__head", role: "heading", "aria-level": "2" });
    if (isToday) {
      h.classList.add("is-today");
      h.appendChild(el("span", { class: "day-group__date", text: "Today, " + fDate.format(inst) }));
    } else {
      h.appendChild(el("span", { class: "day-group__date", text: fDate.format(inst) }));
    }
    h.appendChild(el("span", { class: "day-group__wday", text: fWday.format(inst) }));
    return h;
  }

  /* ---- A single agenda row ---- */
  function rowNode(it) {
    var e = it.e, o = it.o;
    var cancelled = o.status === "cancelled";
    var li = el("button", {
      class: "row" + (cancelled ? " row--cancelled" : ""),
      type: "button",
      "data-eid": e.id,
      "data-oid": o.id
    });
    li.setAttribute("aria-label", rowAriaLabel(it));

    // Time column
    var time = el("div", { class: "row__time" });
    if (o.is_all_day) {
      time.textContent = "All day";
    } else {
      time.textContent = AEC.fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(new Date(o.starts_at * 1000));
    }
    li.appendChild(time);

    // Main column
    var main = el("div", { class: "row__main" });

    var title = el("div", { class: "row__title" });
    title.textContent = e.name; // textContent escapes
    main.appendChild(title);

    if (e.subtitle != null) main.appendChild(el("div", { class: "row__sub", text: e.subtitle }));

    var line = AEC.resolveListLine(e, o);
    if (line != null) main.appendChild(el("p", { class: "row__line" }, line));

    var meta = el("div", { class: "row__meta" });
    appendBadges(meta, o, e);
    var vd = AEC.resolveVenueDisplay(e, o, state.M.venues);
    if (vd.line) {
      var vEl = el("span", { class: "row__venue" });
      vEl.appendChild(svgPin()); vEl.appendChild(document.createTextNode(" " + vd.line));
      meta.appendChild(vEl);
    }
    var cat = e.category_id != null ? state.M.categories[e.category_id] : null;
    if (cat) {
      meta.appendChild(makeTag(cat.name));
    }
    main.appendChild(meta);

    li.appendChild(main);
    li.addEventListener("click", function (evt) {
      evt.preventDefault();
      openDetail(e, li);
    });
    return li;
  }

  function rowAriaLabel(it) {
    var e = it.e, o = it.o;
    var t = e.name;
    if (e.subtitle) t += ", " + e.subtitle;
    if (o.is_all_day) t += ", all day";
    else t += ", " + AEC.fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(new Date(o.starts_at * 1000));
    var vd = AEC.resolveVenueDisplay(e, o, state.M.venues);
    if (vd.line) t += ", " + vd.line;
    if (o.status === "cancelled") t += ", cancelled";
    return t;
  }

  function appendBadges(parent, o, e) {
    // free/paid summary badge on a card uses event summary; per-row we show occurrence-level
    if (o.is_free) {
      var fr = el("span", { class: "badge badge--free", title: "Free admission" });
      fr.appendChild(svgFree()); fr.appendChild(document.createTextNode(" Free"));
      parent.appendChild(fr);
    }
    if (o.status === "cancelled") {
      var cx = el("span", { class: "badge badge--cancel" });
      cx.appendChild(svgCancel()); cx.appendChild(document.createTextNode(" Cancelled"));
      parent.appendChild(cx);
    }
  }

  /* ====================================================================
   * Detail modal
   * =================================================================== */
  var modal = document.getElementById("detail-modal");
  var lastFocus = null;

  function openDetail(e, fromEl) {
    lastFocus = fromEl;
    modal.classList.add("modal--open");
    modal.setAttribute("aria-hidden", "false");
    modal.innerHTML = "";
    modal.appendChild(buildModal(e));
    document.addEventListener("keydown", onKey);
    AEC.setPageInert(true);
    // focus the close button after paint
    var close = modal.querySelector(".modal__close");
    if (close) close.focus();
    document.body.style.overflow = "hidden";
  }
  function closeDetail() {
    modal.classList.remove("modal--open");
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    AEC.setPageInert(false);
    document.body.style.overflow = "";
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeDetail(); return; }
    if (ev.key === "Tab") trapFocus(ev);
  }
  function trapFocus(ev) {
    var f = modal.querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  function buildModal(e) {
    var wrap = document.createDocumentFragment();
    var overlay = el("div", { class: "modal__overlay" });
    overlay.addEventListener("click", closeDetail);
    var panel = el("div", { class: "modal__panel", role: "document" });

    var close = el("button", { class: "modal__close", type: "button", "aria-label": "Close event details" });
    close.appendChild(svgClose());
    close.addEventListener("click", closeDetail);
    panel.appendChild(close);

    var body = el("div", { class: "modal__body" });
    var titleEl = el("h2", { class: "modal__title", id: "detail-title" });
    titleEl.textContent = e.name;
    body.appendChild(titleEl);
    if (e.subtitle != null) body.appendChild(el("p", { class: "modal__subtitle", text: e.subtitle }));

    var org = state.M.orgs[e.org_id];
    if (org) {
      var orgEl = el("p", { class: "modal__org" });
      var orgUrl = AEC.safeHttpUrl(org.website_url);
      if (orgUrl != null) {
        var a = el("a", { href: orgUrl, target: "_blank", rel: "noopener noreferrer" });
        a.textContent = org.name; orgEl.appendChild(document.createTextNode("Presented by ")); orgEl.appendChild(a);
      } else {
        orgEl.textContent = "Presented by " + org.name;
      }
      body.appendChild(orgEl);
    }
    if (e.category_id != null) {
      var cat = state.M.categories[e.category_id];
      if (cat) {
        var tag = el("p"); tag.appendChild(makeTag(cat.name));
        body.appendChild(tag);
      }
    }

    body.appendChild(el("p", { class: "muted", text: rangeSentence(e) }));

    // Occurrence list
    var occSection = el("div", { class: "modal__section" });
    occSection.appendChild(el("h3", { text: "Showings" }));
    e.occurrences.forEach(function (o) { occSection.appendChild(occNode(e, o)); });
    body.appendChild(occSection);

    panel.appendChild(body);
    wrap.appendChild(overlay);
    wrap.appendChild(panel);
    return wrap;
  }

  // "Runs X to Y." for a range, "One date: X." for a single ET day. Uses the
  // inclusive display range so all-day runs are not overstated by a day.
  function rangeSentence(e) {
    var r = AEC.eventDisplayRange(e, state.tz);
    var f = AEC.fmt(state.tz, { month: "short", day: "numeric", year: "numeric" });
    var start = f.format(dayKeyToInstant(r.startKey));
    if (r.startKey === r.endKey) return "One date: " + start + ".";
    return "Runs " + start + " to " + f.format(dayKeyToInstant(r.endKey)) + ".";
  }

  function occNode(e, o) {
    var div = el("div", { class: "modal__occ" + (o.status === "cancelled" ? " row--cancelled" : "") });
    var time = el("div", { class: "modal__occ-time" });
    time.textContent = occurrenceTimeLabel(o);
    if (o.status === "cancelled") {
      time.style.textDecoration = "line-through";
    }
    div.appendChild(time);

    var meta = el("div", { class: "modal__occ-meta" });
    appendBadges(meta, o, e);
    div.appendChild(meta);

    var vd = AEC.resolveVenueDisplay(e, o, state.M.venues);
    if (vd.line) {
      var vp = el("p", { class: "row__venue" }); vp.appendChild(svgPin()); vp.appendChild(document.createTextNode(" " + vd.line));
      if (vd.hasMap) {
        var mapA = el("a", {
          href: "https://maps.google.com/?q=" + encodeURIComponent(vd.venue.name + " " + (vd.venue.street || "") + " " + (vd.venue.city || "") + " " + vd.venue.state),
          target: "_blank", rel: "noopener noreferrer", class: "tickets-link"
        });
        mapA.textContent = "Open map"; vp.appendChild(document.createTextNode(" ")); vp.appendChild(mapA);
      }
      div.appendChild(vp);
    } else {
      div.appendChild(el("p", { class: "row__venue", text: "Location TBA" }));
    }

    var body = AEC.resolveDetailBody(e, o);
    if (body != null) {
      div.appendChild(el("p", { class: "modal__occ-desc" }, body));
    } else {
      // factual fallback: name, category if any, date, venue if any
      div.appendChild(el("p", { class: "modal__fallback", text: fallbackLine(e, o, vd) }));
    }

    var t = AEC.resolveTicketUrl(e, o);
    if (t != null) {
      var ta = el("a", { class: "tickets-link", href: t, target: "_blank", rel: "noopener noreferrer" });
      ta.appendChild(svgExt()); ta.appendChild(document.createTextNode(" Tickets and info"));
      div.appendChild(ta);
    }
    return div;
  }

  function occurrenceTimeLabel(o) {
    if (o.is_all_day) return allDayRangeLabel(o);
    var fTime = AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    return fTime.format(new Date(o.starts_at * 1000));
  }
  function allDayRangeLabel(o) {
    var days = AEC.enumerateAllDayDays(o, state.tz);
    var fDay = AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric" });
    var first = dayKeyToInstant(days[0]);
    if (days.length <= 1) {
      var fFull = AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return fFull.format(first);
    }
    var last = dayKeyToInstant(days[days.length - 1]);
    return fDay.format(first) + " through " + fDay.format(last);
  }
  function dayKeyToInstant(key) {
    var p = key.split("-").map(Number);
    // noon UTC keeps it unambiguously on the right ET day regardless of viewer zone
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
  }

  function fallbackLine(e, o, vd) {
    var parts = [e.name];
    var cat = e.category_id != null ? state.M.categories[e.category_id] : null;
    if (cat) parts.push(cat.name);
    parts.push(occurrenceTimeLabel(o));
    if (vd.line) parts.push(vd.line);
    return parts.join(", ");
  }

  /* ====================================================================
   * SVG glyphs (same-origin, uniform stroke)
   * =================================================================== */
  function svgIcon(d) {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true"); s.setAttribute("width", "13"); s.setAttribute("height", "13");
    var p = document.createElementNS(ns, "path"); p.setAttribute("d", d); s.appendChild(p);
    return s;
  }
  function svgPin() { return svgIcon("M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"); }
  function svgExt() {
    var g = svgIcon("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6");
    var ns = "http://www.w3.org/2000/svg";
    var p2 = document.createElementNS(ns, "polyline"); p2.setAttribute("points", "15 3 21 3 21 9"); g.appendChild(p2);
    var l = document.createElementNS(ns, "line"); l.setAttribute("x1", "10"); l.setAttribute("y1", "14"); l.setAttribute("x2", "21"); l.setAttribute("y2", "3"); g.appendChild(l);
    return g;
  }
  function svgFree() { return svgIcon("M20 6L9 17l-5-5"); }
  function svgCancel() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true"); s.setAttribute("width", "12"); s.setAttribute("height", "12");
    var c = document.createElementNS(ns, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "9"); s.appendChild(c);
    var l = document.createElementNS(ns, "line"); l.setAttribute("x1", "15"); l.setAttribute("y1", "9"); l.setAttribute("x2", "9"); l.setAttribute("y2", "15"); s.appendChild(l);
    var l2 = document.createElementNS(ns, "line"); l2.setAttribute("x1", "9"); l2.setAttribute("y1", "9"); l2.setAttribute("x2", "15"); l2.setAttribute("y2", "15"); s.appendChild(l2);
    return s;
  }
  function svgClose() {
    var g = svgIcon("");
    g.innerHTML = "";
    var ns = "http://www.w3.org/2000/svg";
    var l1 = document.createElementNS(ns, "line"); l1.setAttribute("x1","18");l1.setAttribute("y1","6");l1.setAttribute("x2","6");l1.setAttribute("y2","18"); g.appendChild(l1);
    var l2 = document.createElementNS(ns, "line"); l2.setAttribute("x1","6");l2.setAttribute("y1","6");l2.setAttribute("x2","18");l2.setAttribute("y2","18"); g.appendChild(l2);
    return g;
  }
  function makeTag(name) {
    var tag = el("span", { class: "tag" });
    tag.appendChild(svgIcon("M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"));
    tag.appendChild(document.createTextNode(" " + name));
    return tag;
  }

  /* shared el() helper */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    if (children != null) { (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null) return; node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }); }
    return node;
  }
})();
