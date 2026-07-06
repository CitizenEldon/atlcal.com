/*
 * calendar.js - month grid of Atlanta arts events, in ET.
 *
 * Timed occurrences bucket by dayKey(starts_at). All-day occurrences span
 * their covered ET cells as one band (one entry per day, linked back to the
 * same detail). Chip overflow collapses to "+K more" opening that day's list.
 * Mobile collapses the grid to a scrollable per-day list. Month nav uses
 * real buttons; the grid is keyboard-operable (cells are focusable). The
 * detail modal is the same surface as the agenda's, inlined here.
 *
 * Day enumeration everywhere uses ET date-STRING strings (dayKey/nextDay),
 * never +86400, so the Roots-and-Routes span crossing the Nov 1 fall-back
 * counts the right number of days with none dropped or duplicated.
 */
(function () {
  "use strict";
  var AEC = window.AEC;

  var state = {
    data: null, M: null, tz: null,
    cat: "all", org: "all", free: false,
    year: null, month: null // 0-based month; ET month containing today by default
  };

  var out = document.getElementById("cal-out");
  var titleEl = document.getElementById("cal-title");

  /* ---- terminal states ---- */
  AEC.onError(function (s) {
    out.removeAttribute("aria-busy");
    if (s.kind === "loading") {
      out.innerHTML = '<div class="skel-stack"><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:120px"></div></div>';
    } else if (s.kind === "fetch-error") {
      out.innerHTML = '<div class="state"><h2>The calendar could not load. Try again shortly.</h2></div>';
    } else if (s.kind === "schema-changed") {
      out.innerHTML = '<div class="state"><h2>The calendar data format changed. This page needs an update.</h2></div>';
    }
  });

  AEC.load().then(function (data) {
    if (!data) return;
    state.data = data;
    state.M = AEC.maps(data);
    state.tz = AEC.timezone(data);
    document.getElementById("footer-updated").textContent = AEC.updatedString(data, state.tz);

    // Default the displayed month to the ET month containing today.
    var todayKey = AEC.dayKey(Math.floor(Date.now() / 1000), state.tz);
    var tp = todayKey.split("-").map(Number);
    state.year = tp[0]; state.month = tp[1] - 1;

    renderFilters();
    filterBar.hidden = false;
    wireNav();
    render();
  });

  /* ====================================================================
   * Build the render model both grids read.
   *   timedByDay:  dayKey -> [{e,o}] for timed occurrences (desktop chips)
   *   allDayList:  [{e,o,days,firstKey,lastKey}] for all-day spans (desktop
   *                bands; one entry per occurrence, NOT one per covered day)
   *   mobileByDay: dayKey -> [{e,o}] with all-day repeated on every covered
   *                day (the mobile day-list and the "open day" sheet)
   * =================================================================== */
  function buildModel() {
    var now = Date.now() / 1000;
    var timedByDay = Object.create(null);
    var mobileByDay = Object.create(null);
    var allDayList = [];
    function push(map, k, it) { (map[k] || (map[k] = [])).push(it); }

    state.data.events.forEach(function (e) {
      if (!eventPasses(e)) return;
      e.occurrences.forEach(function (o) {
        if (!occurrencePasses(o)) return;
        if (AEC.effectiveEnd(o) < now) return; // past-hide on effective END
        var it = { e: e, o: o };
        if (o.is_all_day) {
          var days = AEC.enumerateAllDayDays(o, state.tz);
          if (!days.length) return;
          allDayList.push({ e: e, o: o, days: days, firstKey: days[0], lastKey: days[days.length - 1] });
          days.forEach(function (k) { push(mobileByDay, k, it); });
        } else {
          var k = AEC.dayKey(o.starts_at, state.tz);
          push(timedByDay, k, it);
          push(mobileByDay, k, it);
        }
      });
    });
    Object.keys(timedByDay).forEach(function (k) {
      timedByDay[k].sort(function (a, b) { return a.o.starts_at - b.o.starts_at; });
    });
    Object.keys(mobileByDay).forEach(function (k) {
      mobileByDay[k].sort(function (a, b) {
        var sa = a.o.is_all_day ? 0 : 1, sb = b.o.is_all_day ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return a.o.starts_at - b.o.starts_at;
      });
    });
    return { timedByDay: timedByDay, allDayList: allDayList, mobileByDay: mobileByDay };
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
   * Month grid render
   * =================================================================== */
  function render() {
    out.removeAttribute("aria-busy");
    var model = buildModel();

    var y = state.year, m = state.month; // 0-based month
    titleEl.textContent = monthTitle(y, m);
    var monthPrefix = y + "-" + pad2(m + 1);

    // Filtered-empty month: show the message in place of the grid (the month
    // title and nav stay above, so the visitor can clear filters or page on).
    // An UNFILTERED empty month is not an error (rule 17): it renders below as
    // plain empty cells, with no message.
    var filtersActive = state.cat !== "all" || state.org !== "all" || state.free;
    var visibleDays = 0;
    Object.keys(model.mobileByDay).forEach(function (kk) { if (kk.slice(0, 7) === monthPrefix) visibleDays++; });
    if (visibleDays === 0 && filtersActive) {
      out.innerHTML = "";
      var st = el("div", { class: "state" });
      st.appendChild(el("h2", { text: "No events match these filters." }));
      var clr = el("button", { class: "btn btn--primary", type: "button" }); clr.textContent = "Clear filters";
      clr.addEventListener("click", resetFilters);
      st.appendChild(el("p", {}, [clr]));
      out.appendChild(st);
      return;
    }

    // Month boundaries in ET date strings (render the grid by stepping strings).
    var firstKey = monthPrefix + "-01";
    var firstDow = dayKeyToDow(firstKey); // 0..6, Sunday first
    var gridStartKey = firstDow === 0 ? firstKey : shiftDays(firstKey, -firstDow);
    var nextMonthKey = (m === 11 ? (y + 1) + "-01-01" : y + "-" + pad2(m + 2) + "-01");
    var lastKey = shiftDays(nextMonthKey, -1);
    var lastDow = dayKeyToDow(lastKey);
    var gridEndKey = lastDow === 6 ? lastKey : shiftDays(lastKey, 6 - lastDow);

    // Chunk the grid span into weeks of 7 ET day-strings.
    var weeks = [], wk = [];
    for (var k = gridStartKey; ; k = nextDay(k)) {
      wk.push(k);
      if (wk.length === 7) { weeks.push(wk); wk = []; }
      if (k === gridEndKey) break;
    }

    var todayKey = AEC.dayKey(Math.floor(Date.now() / 1000), state.tz);
    var MAX_CHIPS = 3; // timed chips shown per day before +K more

    var fragment = document.createDocumentFragment();

    // Desktop grid: weekday header + one .cal-week per week (each a sub-grid).
    // Cells are plain buttons with descriptive labels rather than an ARIA grid,
    // since navigation is Tab + Enter, not roving arrow keys.
    var grid = el("div", { class: "cal-grid", "aria-label": titleEl.textContent + " calendar" });
    grid.appendChild(renderWeekdays());
    weeks.forEach(function (weekDays) {
      grid.appendChild(renderWeek(weekDays, model, monthPrefix, todayKey, MAX_CHIPS));
    });
    fragment.appendChild(grid);

    // Mobile list (the grid collapses to this on small screens).
    var mobileWrap = el("div", { class: "cal-list" });
    weeks.forEach(function (weekDays) {
      weekDays.forEach(function (dk) {
        if (dk.slice(0, 7) !== monthPrefix) return;
        var items = model.mobileByDay[dk];
        if (items && items.length) mobileWrap.appendChild(mobileDayNode(dk, items, dk === todayKey));
      });
    });
    fragment.appendChild(mobileWrap);

    out.innerHTML = "";
    out.appendChild(fragment);
  }

  function renderWeekdays() {
    var row = el("div", { class: "cal-weekdays", role: "row", "aria-hidden": "true" });
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (w) {
      row.appendChild(el("div", { class: "cal-weekdays__cell", text: w }));
    });
    return row;
  }

  /* ---- One week row: 7 day cells + spanning all-day bands + timed chips ---- */
  function renderWeek(weekDays, model, monthPrefix, todayKey, MAX_CHIPS) {
    var week = el("div", { class: "cal-week" });
    var wFirst = weekDays[0], wLast = weekDays[6];

    // 1. All-day segments overlapping this week, clamped to the week's columns.
    var segs = [];
    model.allDayList.forEach(function (item) {
      if (item.lastKey < wFirst || item.firstKey > wLast) return;
      var cl = item.firstKey < wFirst, cr = item.lastKey > wLast;
      segs.push({
        item: item,
        startCol: cl ? 0 : weekDays.indexOf(item.firstKey),
        endCol: cr ? 6 : weekDays.indexOf(item.lastKey),
        cl: cl, cr: cr
      });
    });
    // Stable ordering, then greedy lane packing so segments never overlap columns.
    segs.sort(function (a, b) {
      if (a.startCol !== b.startCol) return a.startCol - b.startCol;
      var la = a.endCol - a.startCol, lb = b.endCol - b.startCol;
      if (la !== lb) return lb - la;
      if (a.item.o.starts_at !== b.item.o.starts_at) return a.item.o.starts_at - b.item.o.starts_at;
      return a.item.e.id - b.item.e.id;
    });
    var lanes = [];
    segs.forEach(function (s) {
      for (var li = 0; li < lanes.length; li++) {
        var ok = true;
        for (var r = 0; r < lanes[li].length; r++) {
          if (!(s.endCol < lanes[li][r][0] || s.startCol > lanes[li][r][1])) { ok = false; break; }
        }
        if (ok) { lanes[li].push([s.startCol, s.endCol]); s.lane = li; return; }
      }
      s.lane = lanes.length; lanes.push([[s.startCol, s.endCol]]);
    });
    var L = lanes.length;

    // Row 1 is a fixed lane for the day numbers. It must not be `auto`: the day
    // cells span every row (1 / -1), so an auto number row collapses to 0 and
    // the first band lane paints over the numbers. A fixed height reserves it.
    week.style.gridTemplateColumns = "repeat(7, minmax(0, 1fr))";
    week.style.gridTemplateRows = "30px " + (L ? "repeat(" + L + ", auto) " : "") + "1fr";

    // 2. Day-cell backgrounds (span every row of the week), with the day number.
    weekDays.forEach(function (dk, c) {
      var inMonth = dk.slice(0, 7) === monthPrefix;
      var isWeekend = c === 0 || c === 6;
      var isToday = dk === todayKey;
      var items = model.mobileByDay[dk] || [];
      var cell = el("button", {
        type: "button",
        class: "cal-cell" + (inMonth ? "" : " cal-cell--out") + (isWeekend ? " cal-cell--weekend" : "") + (isToday ? " cal-cell--today" : ""),
        "data-day": dk,
        "aria-label": cellAriaLabel(dk, items)
      });
      cell.style.gridColumn = (c + 1) + " / " + (c + 2);
      cell.style.gridRow = "1 / -1";
      cell.appendChild(el("span", { class: "cal-cell__num", text: String(Number(dk.slice(8, 10))) }));
      cell.addEventListener("click", function (ev) { openDay(ev.currentTarget.getAttribute("data-day"), ev.currentTarget); });
      week.appendChild(cell);
    });

    // 3. All-day bands, each spanning its covered columns on its assigned lane.
    segs.forEach(function (s) {
      var band = bandSegNode(s);
      band.style.gridColumn = (s.startCol + 1) + " / " + (s.endCol + 2);
      band.style.gridRow = (s.lane + 2) + " / " + (s.lane + 3);
      week.appendChild(band);
    });

    // 4. Timed chips, stacked per day in the flexible bottom row.
    weekDays.forEach(function (dk, c) {
      var items = model.timedByDay[dk];
      if (!items || !items.length) return;
      var box = el("div", { class: "cal-daychips" });
      box.style.gridColumn = (c + 1) + " / " + (c + 2);
      box.style.gridRow = (2 + L) + " / " + (3 + L);
      items.slice(0, MAX_CHIPS).forEach(function (it) { box.appendChild(timedChipNode(it)); });
      if (items.length > MAX_CHIPS) {
        var more = el("button", { type: "button", class: "cal-cell__more", "data-day": dk });
        more.textContent = "+" + (items.length - MAX_CHIPS) + " more";
        more.setAttribute("aria-label", (items.length - MAX_CHIPS) + " more events on " + dayLongTitle(dk));
        more.addEventListener("click", function (ev) { ev.stopPropagation(); openDay(ev.currentTarget.getAttribute("data-day"), ev.currentTarget); });
        box.appendChild(more);
      }
      week.appendChild(box);
    });

    return week;
  }

  /* A timed occurrence chip (start time + title, 2-line clamp). */
  function timedChipNode(it) {
    var e = it.e, o = it.o;
    var cancelled = o.status === "cancelled";
    var node = el("button", {
      type: "button",
      class: "chip" + (o.is_free ? " chip--free" : "") + (cancelled ? " chip--cancelled" : ""),
      "data-eid": e.id
    });
    var timeStr = AEC.fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(new Date(o.starts_at * 1000));
    var time = el("span", { class: "chip__time" });
    time.textContent = timeStr + " ";
    node.appendChild(time);
    node.appendChild(document.createTextNode(e.name));
    node.setAttribute("aria-label", e.name + ", " + timeStr + (cancelled ? ", cancelled" : ""));
    if (cancelled) {
      node.title = "Cancelled";
      node.insertBefore(svgCancelMini(), node.firstChild);
    }
    node.addEventListener("click", function (ev) { ev.stopPropagation(); openDetail(e, node); });
    return node;
  }

  /* An all-day band segment for one week (flat edges where the run continues). */
  function bandSegNode(s) {
    var e = s.item.e, o = s.item.o;
    var cancelled = o.status === "cancelled";
    var node = el("button", {
      type: "button",
      class: "band" + (o.is_free ? " band--free" : "") + (cancelled ? " band--cancelled" : "") +
        (s.cl ? " band--cont-l" : "") + (s.cr ? " band--cont-r" : ""),
      "data-eid": e.id
    });
    node.appendChild(document.createTextNode(e.name));
    node.setAttribute("aria-label", e.name + ", all day" + (s.cl || s.cr ? ", continues" : "") + (cancelled ? ", cancelled" : ""));
    if (cancelled) {
      node.title = "Cancelled";
      node.insertBefore(svgCancelMini(), node.firstChild);
    }
    node.addEventListener("click", function (ev) { ev.stopPropagation(); openDetail(e, node); });
    return node;
  }

  function mobileDayNode(key, items, isToday) {
    var wrap = el("div", { class: "cal-listday" + (isToday ? " cal-listday--today" : "") });
    var inst = dayKeyToInstant(key);
    var head = el("div", { class: "cal-listday__head", role: "heading", "aria-level": "2" });
    head.appendChild(el("div", { class: "cal-listday__date", text: AEC.fmt(state.tz, { month: "long", day: "numeric" }).format(inst) }));
    head.appendChild(el("div", { class: "cal-listday__wday", text: AEC.fmt(state.tz, { weekday: "long" }).format(inst) + (isToday ? " (today)" : "") }));
    wrap.appendChild(head);
    var chips = el("div", { class: "cal-listday__chips" });
    items.forEach(function (it) { chips.appendChild(listRowNode(it)); });
    wrap.appendChild(chips);
    return wrap;
  }

  function listRowNode(it) {
    var e = it.e, o = it.o;
    var cancelled = o.status === "cancelled";
    var li = el("button", { class: "row" + (cancelled ? " row--cancelled" : ""), type: "button", "data-eid": e.id });
    var time = el("div", { class: "row__time" });
    if (o.is_all_day) time.textContent = "All day";
    else time.textContent = AEC.fmt(state.tz, { hour: "numeric", minute: "2-digit" }).format(new Date(o.starts_at * 1000));
    li.appendChild(time);
    var main = el("div", { class: "row__main" });
    var title = el("div", { class: "row__title" }); title.textContent = e.name; main.appendChild(title);
    var meta = el("div", { class: "row__meta" });
    appendBadges(meta, o, e);
    var vd = AEC.resolveVenueDisplay(e, o, state.M.venues);
    if (vd.line) {
      var v = el("span", { class: "row__venue" }); v.appendChild(svgPin()); v.appendChild(document.createTextNode(" " + vd.line));
      meta.appendChild(v);
    }
    main.appendChild(meta);
    li.appendChild(main);
    li.addEventListener("click", function (ev) { ev.preventDefault(); openDetail(e, li); });
    return li;
  }

  function cellAriaLabel(key, items) {
    var inst = dayKeyToInstant(key);
    var label = AEC.fmt(state.tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(inst);
    label += ", " + items.length + (items.length === 1 ? " event" : " events");
    return label;
  }

  function monthTitle(y, m) {
    var inst = dayKeyToInstant(y + "-" + pad2(m + 1) + "-15");
    return AEC.fmt(state.tz, { month: "long", year: "numeric" }).format(inst);
  }

  /* ---- nav wiring ---- */
  function wireNav() {
    document.getElementById("cal-prev").addEventListener("click", function () { shiftMonth(-1); });
    document.getElementById("cal-next").addEventListener("click", function () { shiftMonth(1); });
    document.getElementById("cal-today").addEventListener("click", function () {
      var tk = AEC.dayKey(Math.floor(Date.now() / 1000), state.tz).split("-").map(Number);
      state.year = tk[0]; state.month = tk[1] - 1; render();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.target.classList && (ev.target.classList.contains("cal-cell"))) return; // cell has its own handling
      if (document.getElementById("detail-modal").classList.contains("modal--open")) return;
      if (ev.key === "ArrowLeft" && ev.altKey) { ev.preventDefault(); shiftMonth(-1); }
      if (ev.key === "ArrowRight" && ev.altKey) { ev.preventDefault(); shiftMonth(1); }
    });
  }
  function shiftMonth(d) {
    state.month += d;
    if (state.month < 0) { state.month = 11; state.year--; }
    if (state.month > 11) { state.month = 0; state.year++; }
    render();
  }

  /* ---- "open day": expand a day into a temporary listing (mobile-first, used on overflow + empty-cell tap) ---- */
  function openDay(key, invoker) {
    var items = buildModel().mobileByDay[key] || [];
    if (!items.length) return;
    // Reuse the modal surface with a day listing instead of a single event.
    openDayDetail(key, items, invoker);
  }
  function openDayDetail(key, items, invoker) {
    var modal = document.getElementById("detail-modal");
    modal.classList.add("modal--open"); modal.setAttribute("aria-hidden", "false"); modal.innerHTML = "";
    var frag = document.createDocumentFragment();
    var overlay = el("div", { class: "modal__overlay" }); overlay.addEventListener("click", closeDetail);
    var panel = el("div", { class: "modal__panel", role: "document" });
    var close = el("button", { class: "modal__close", type: "button", "aria-label": "Close day list" }); close.appendChild(svgClose());
    close.addEventListener("click", closeDetail);
    panel.appendChild(close);
    var body = el("div", { class: "modal__body" });
    body.appendChild(el("h2", { class: "modal__title", id: "detail-title" }));
    body.firstElementChild.textContent = dayLongTitle(key);
    body.appendChild(el("p", { class: "muted", text: items.length + (items.length === 1 ? " showing" : " showings") }));
    items.forEach(function (it) { body.appendChild(listRowNode(it)); });
    panel.appendChild(body);
    frag.appendChild(overlay); frag.appendChild(panel);
    modal.appendChild(frag);
    state._lastFocus = invoker || document.activeElement;
    document.addEventListener("keydown", onKey);
    close.focus();
    document.body.style.overflow = "hidden";
  }
  function dayLongTitle(key) {
    return AEC.fmt(state.tz, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(dayKeyToInstant(key));
  }

  /* ====================================================================
   * Detail modal (single event) - keyed on event id; same surface as agenda
   * =================================================================== */
  function openDetail(e, fromEl) {
    var modal = document.getElementById("detail-modal");
    // A day-list row lives inside this modal and is wiped by the next line, so
    // only adopt fromEl as the focus target when it is an external trigger (a
    // grid chip or band). Otherwise keep the day list's own invoker.
    if (fromEl && !modal.contains(fromEl)) state._lastFocus = fromEl;
    modal.innerHTML = ""; modal.classList.add("modal--open"); modal.setAttribute("aria-hidden", "false");
    modal.appendChild(buildModal(e));
    document.addEventListener("keydown", onKey);
    var close = modal.querySelector(".modal__close");
    if (close) close.focus();
    document.body.style.overflow = "hidden";
  }
  function closeDetail() {
    var modal = document.getElementById("detail-modal");
    modal.classList.remove("modal--open"); modal.setAttribute("aria-hidden", "true"); modal.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
    if (state._lastFocus && typeof state._lastFocus.focus === "function") state._lastFocus.focus();
    state._lastFocus = null;
  }
  function onKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeDetail(); return; }
    if (ev.key === "Tab") trapFocus(ev);
  }
  function trapFocus(ev) {
    var modal = document.getElementById("detail-modal");
    var f = modal.querySelectorAll('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  function buildModal(e) {
    var frag = document.createDocumentFragment();
    var overlay = el("div", { class: "modal__overlay" }); overlay.addEventListener("click", closeDetail);
    var panel = el("div", { class: "modal__panel", role: "document" });
    var close = el("button", { class: "modal__close", type: "button", "aria-label": "Close event details" }); close.appendChild(svgClose());
    close.addEventListener("click", closeDetail);
    panel.appendChild(close);
    var body = el("div", { class: "modal__body" });
    var titleEl = el("h2", { class: "modal__title", id: "detail-title" }); titleEl.textContent = e.name; body.appendChild(titleEl);
    if (e.subtitle != null) body.appendChild(el("p", { class: "modal__subtitle", text: e.subtitle }));

    var org = state.M.orgs[e.org_id];
    if (org) {
      var orgEl = el("p", { class: "modal__org" });
      if (org.website_url != null) {
        var a = el("a", { href: org.website_url, target: "_blank", rel: "noopener noreferrer" }); a.textContent = org.name;
        orgEl.appendChild(document.createTextNode("Presented by ")); orgEl.appendChild(a);
      } else { orgEl.textContent = "Presented by " + org.name; }
      body.appendChild(orgEl);
    }
    if (e.category_id != null) {
      var cat = state.M.categories[e.category_id];
      if (cat) { body.appendChild(el("p", classTag(cat.name))); }
    }
    body.appendChild(el("p", { class: "muted", text: rangeSentence(e) }));

    body.appendChild(el("div", { class: "modal__section" }, [el("h3", { text: "Showings" })]));
    e.occurrences.forEach(function (o) { body.querySelector(".modal__section").appendChild(occNode(e, o)); });
    panel.appendChild(body);
    frag.appendChild(overlay); frag.appendChild(panel);
    return frag;
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
    var time = el("div", { class: "modal__occ-time" }); time.textContent = occurrenceTimeLabel(o);
    if (o.status === "cancelled") time.style.textDecoration = "line-through";
    div.appendChild(time);

    var meta = el("div", { class: "modal__occ-meta" }); appendBadges(meta, o, e); div.appendChild(meta);

    var vd = AEC.resolveVenueDisplay(e, o, state.M.venues);
    if (vd.line) {
      var vp = el("p", { class: "row__venue" }); vp.appendChild(svgPin()); vp.appendChild(document.createTextNode(" " + vd.line));
      if (vd.hasMap) {
        var mapA = el("a", { href: "https://maps.google.com/?q=" + encodeURIComponent(vd.venue.name + " " + (vd.venue.street || "") + " " + (vd.venue.city || "") + " " + vd.venue.state), target: "_blank", rel: "noopener noreferrer", class: "tickets-link" });
        mapA.textContent = "Open map"; vp.appendChild(document.createTextNode(" ")); vp.appendChild(mapA);
      }
      div.appendChild(vp);
    } else { div.appendChild(el("p", { class: "row__venue", text: "Location TBA" })); }

    var b = AEC.resolveDetailBody(e, o);
    if (b != null) div.appendChild(el("p", { class: "modal__occ-desc" }, b));
    else div.appendChild(el("p", { class: "modal__fallback", text: fallbackLine(e, o, vd) }));

    var t = AEC.resolveTicketUrl(e, o);
    if (t != null) {
      var ta = el("a", { class: "tickets-link", href: t, target: "_blank", rel: "noopener noreferrer" }); ta.appendChild(svgExt()); ta.appendChild(document.createTextNode(" Tickets and info"));
      div.appendChild(ta);
    }
    return div;
  }
  function occurrenceTimeLabel(o) {
    if (o.is_all_day) return allDayRangeLabel(o);
    return AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(o.starts_at * 1000));
  }
  function allDayRangeLabel(o) {
    var days = AEC.enumerateAllDayDays(o, state.tz);
    var fDay = AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric" });
    var first = dayKeyToInstant(days[0]);
    if (days.length <= 1) {
      var fFull = AEC.fmt(state.tz, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      return fFull.format(first);
    }
    return fDay.format(first) + " through " + fDay.format(dayKeyToInstant(days[days.length - 1]));
  }
  function fallbackLine(e, o, vd) {
    var parts = [e.name];
    var cat = e.category_id != null ? state.M.categories[e.category_id] : null;
    if (cat) parts.push(cat.name);
    parts.push(occurrenceTimeLabel(o));
    if (vd.line) parts.push(vd.line);
    return parts.join(", ");
  }

  function appendBadges(parent, o, e) {
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
   * Date helpers (ET string stepping only)
   * =================================================================== */
  function nextDay(k) {
    var p = k.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10);
  }
  function shiftDays(k, n) {
    // shift a YYYY-MM-DD string by n calendar days using UTC date math
    var p = k.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function dayKeyToInstant(key) {
    var p = key.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); // noon UTC -> correct ET day
  }
  function dayKeyToDow(key) {
    var p = key.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  /* ====================================================================
   * Filters (shared shape with agenda)
   * =================================================================== */
  var filterBar = document.getElementById("filters");
  function renderFilters() {
    filterBar.innerHTML = "";
    filterBar.appendChild(field("category", "Category", catOptions(state.data), "cat"));
    filterBar.appendChild(field("org", "Organization", orgOptions(state.data), "org"));
    var spacer = el("div", { class: "filters__spacer" }); filterBar.appendChild(spacer);
    var sw = el("label", { class: "switch" });
    var cb = el("input", { type: "checkbox", id: "free-only" });
    var track = el("span", { class: "switch__track" });
    var thumb = el("span", { class: "switch__thumb" }); track.appendChild(thumb);
    var lbl = el("label", { for: "free-only" }); lbl.textContent = "Free only";
    sw.appendChild(cb); sw.appendChild(track); sw.appendChild(lbl);
    cb.addEventListener("change", function () { state.free = cb.checked; render(); });
    filterBar.appendChild(sw);
    var clear = el("button", { class: "btn btn--ghost", type: "button", "aria-label": "Clear all filters" }); clear.textContent = "Clear filters";
    clear.addEventListener("click", resetFilters);
    filterBar.appendChild(clear);
  }
  function field(id, label, optionsHtml, stateKey) {
    var f = el("label", { class: "field", for: id });
    var l = el("span"); l.className = "field__label"; l.style.cssText = "font-weight:600;font-size:var(--step--1);color:var(--text-soft)"; l.textContent = label;
    var s = el("select", { id: id, name: id }); s.innerHTML = optionsHtml; s.value = state[stateKey];
    s.addEventListener("change", function () { state[stateKey] = s.value; render(); });
    f.appendChild(l); f.appendChild(s);
    return f;
  }
  function catOptions(data) {
    var h = '<option value="all">All categories</option>';
    data.categories.forEach(function (c) { h += '<option value="' + c.id + '">' + AEC.escapeHtml(c.name) + '</option>'; });
    h += '<option value="none">Uncategorized</option>';
    return h;
  }
  function orgOptions(data) {
    var h = '<option value="all">All organizations</option>';
    data.orgs.forEach(function (o) { h += '<option value="' + o.id + '">' + AEC.escapeHtml(o.name) + '</option>'; });
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
   * SVG glyphs
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
    var p2 = document.createElementNS(ns, "polyline"); p2.setAttribute("points", "15 3 21 3 21 9");
    g.appendChild(p2);
    var l = document.createElementNS(ns, "line"); l.setAttribute("x1","10");l.setAttribute("y1","14");
    l.setAttribute("x2","21");l.setAttribute("y2","3"); g.appendChild(l); return g;
  }
  function svgFree() { return svgIcon("M20 6L9 17l-5-5"); }
  // small cancelled cue for chips: crossed circle, shrunk to fit inline
  function svgCancelMini() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("fill","none"); s.setAttribute("stroke","currentColor");
    s.setAttribute("stroke-width","2.4"); s.setAttribute("stroke-linecap","round"); s.setAttribute("stroke-linejoin","round");
    s.setAttribute("aria-hidden","true"); s.setAttribute("width","11"); s.setAttribute("height","11"); s.style.flex="none"; s.style.marginRight="2px"; s.style.verticalAlign="-1px";
    var c = document.createElementNS(ns, "circle"); c.setAttribute("cx","12"); c.setAttribute("cy","12"); c.setAttribute("r","9"); s.appendChild(c);
    [["15","9","9","15"],["9","9","15","15"]].forEach(function (a) {
      var l = document.createElementNS(ns, "line"); var i = 0;
      ["x1","y1","x2","y2"].forEach(function (k) { l.setAttribute(k, a[i++]); }); s.appendChild(l);
    });
    return s;
  }
  function svgCancel() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("fill","none"); s.setAttribute("stroke","currentColor");
    s.setAttribute("stroke-width","2"); s.setAttribute("stroke-linecap","round"); s.setAttribute("stroke-linejoin","round");
    s.setAttribute("aria-hidden","true"); s.setAttribute("width","12"); s.setAttribute("height","12");
    var c = document.createElementNS(ns, "circle"); c.setAttribute("cx","12"); c.setAttribute("cy","12"); c.setAttribute("r","9");
    s.appendChild(c);
    [["15","9","9","15"],["9","9","15","15"]].forEach(function (a) {
      var l = document.createElementNS(ns, "line"); var i = 0;
      ["x1","y1","x2","y2"].forEach(function (k) { l.setAttribute(k, a[i++]); }); s.appendChild(l);
    });
    return s;
  }
  function svgClose() {
    var ns = "http://www.w3.org/2000/svg";
    var s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("fill","none"); s.setAttribute("stroke","currentColor");
    s.setAttribute("stroke-width","2"); s.setAttribute("stroke-linecap","round"); s.setAttribute("stroke-linejoin","round");
    s.setAttribute("aria-hidden","true"); s.setAttribute("width","20"); s.setAttribute("height","20");
    [["18","6","6","18"],["6","6","18","18"]].forEach(function (a) {
      var l = document.createElementNS(ns, "line"); var i = 0;
      ["x1","y1","x2","y2"].forEach(function (k) { l.setAttribute(k, a[i++]); }); s.appendChild(l);
    });
    return s;
  }
  function classTag(name) {
    var tag = el("span", { class: "tag" });
    tag.appendChild(svgIcon("M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"));
    tag.appendChild(document.createTextNode(" " + name));
    return tag;
  }

  /* el() helper */
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
