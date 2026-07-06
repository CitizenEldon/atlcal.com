/*
 * data.js - single source of truth for the Atlanta Event Calendar site.
 *
 * Responsibilities (one place each, per the build contract):
 *   - Fetch events.json ONCE, cache the parsed object.
 *   - Guard fetch failure and schema_version != 1.
 *   - Build id -> row lookup maps for categories, orgs, venues.
 *   - ET date helpers: TZ, dayKey, nextDay, enumerateAllDayDays.
 *   - The three occurrence ?? event fallbacks (venue, ticket, detail body).
 *   - Derived event date range and free/paid summary.
 *   - HTML / attribute escaping.
 *   - FEED_BASE (the ONE place .ics subscribe / copy / download URLs are composed).
 *
 * No DOM work here beyond the error-state hooks the pages wire up. This file
 * is pure data; pages import what they need.
 */

(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Schema
   * ------------------------------------------------------------------ */
  var SUPPORTED_SCHEMA_VERSION = 1;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  var _cache = null;        // parsed events.json, fetched once
  var _fetchPromise = null; // in-flight fetch, so concurrent callers share one request
  var _onError = null;      // page-supplied handler(state) for terminal states

  /* ------------------------------------------------------------------ *
   * Terminal-state hook
   *
   * Pages register a single callback that receives one of:
   *   { kind: "loading" }
   *   { kind: "fetch-error" }
   *   { kind: "schema-changed" }
   * The page decides how to render each. "loading" is fired before the
   * fetch begins; the success path is handled by the page's own then().
   * ------------------------------------------------------------------ */
  function onError(fn) { _onError = fn; }

  function fail(kind) {
    if (typeof _onError === "function") _onError({ kind: kind });
  }

  /* ------------------------------------------------------------------ *
   * Single fetch with schema guard
   * ------------------------------------------------------------------ */
  function load() {
    if (_cache) return Promise.resolve(_cache);
    if (_fetchPromise) return _fetchPromise;

    fail("loading");

    _fetchPromise = fetch("../events.json", { cache: "no-cache" })
      .then(function (resp) {
        if (!resp.ok) throw new Error("http " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!data || data.schema_version !== SUPPORTED_SCHEMA_VERSION) {
          // Not the contract we were built against. Do not render.
          _fetchPromise = null;
          fail("schema-changed");
          return null;
        }
        _cache = data;
        return data;
      })
      .catch(function (err) {
        _fetchPromise = null;
        fail("fetch-error");
        return null;
      });

    return _fetchPromise;
  }

  /* ------------------------------------------------------------------ *
   * id -> row maps, built once per loaded data set
   * ------------------------------------------------------------------ */
  function indexBy(arr, key) {
    var m = {};
    for (var i = 0; i < arr.length; i++) m[arr[i][key]] = arr[i];
    return m;
  }

  function maps(data) {
    return {
      categories: indexBy(data.categories, "id"),
      orgs: indexBy(data.orgs, "id"),
      venues: indexBy(data.venues, "id")
    };
  }

  /* ------------------------------------------------------------------ *
   * ET date helpers (rule 4 / 4a)
   *
   * Times are epoch SECONDS in UTC. Convert with new Date(sec*1000) and
   * format ONLY with Intl, feeding the file's timezone field into every
   * call as TZ. Day spans are enumerated by ET calendar-date STRING
   * stepping, never +86400, so a span crossing the Nov 1 fall-back drops
   * or duplicates no day.
   * ------------------------------------------------------------------ */
  function timezone(data) { return data.timezone || "America/New_York"; }

  // ET YYYY-MM-DD an epoch-seconds instant falls on.
  function dayKey(ep, tz) {
    return new Date(ep * 1000)
      .toLocaleString("en-CA", { timeZone: tz })
      .slice(0, 10);
  }

  // Next ET calendar day of a YYYY-MM-DD string (Date.UTC, so DST-safe).
  function nextDay(key) {
    var p = key.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10);
  }

  // The ET calendar days an all-day occurrence covers: [starts_at, ends_at).
  function enumerateAllDayDays(o, tz) {
    var days = [];
    var endExclusiveKey = dayKey(o.ends_at, tz);
    for (var k = dayKey(o.starts_at, tz); k < endExclusiveKey; k = nextDay(k)) {
      days.push(k);
    }
    return days;
  }

  // An occurrence's effective end epoch (ends_at, else starts_at). Used for
  // past-hiding keyed on the END, never the start, so ongoing exhibitions
  // (Georgia Made) stay visible.
  function effectiveEnd(o) {
    return o.ends_at != null ? o.ends_at : o.starts_at;
  }

  /* Intl formatters, created lazily per tz so the page can reuse them. */
  function fmt(tz, options) {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, options));
  }

  /* ------------------------------------------------------------------ *
   * The three occurrence ?? event fallbacks
   * ------------------------------------------------------------------ */

  // (b) Venue precedence per occurrence = occ.venue_id ?? event.venue_id,
  //     then resolve to the venue record (may be null).
  function resolveVenueId(e, o) {
    return o.venue_id != null ? o.venue_id : e.venue_id;
  }

  // (c) Ticket precedence = occ.ticket_url ?? event.ticket_url.
  function resolveTicketUrl(e, o) {
    return o.ticket_url != null ? o.ticket_url : e.ticket_url;
  }

  // (e) Detail body = occ.description ?? event.description_full.
  function resolveDetailBody(e, o) {
    return o.description != null ? o.description : e.description_full;
  }

  // (d) List-line text = occ.description ?? event.description_short.
  function resolveListLine(e, o) {
    return o.description != null ? o.description : e.description_short;
  }

  /* ------------------------------------------------------------------ *
   * Resolution: venue line + map-link gating
   * ------------------------------------------------------------------ */

  // Returns { name, city, hasMap, line } for a resolved venue, or a TBA marker.
  function resolveVenueDisplay(e, o, vmap) {
    var vid = resolveVenueId(e, o);
    if (vid == null) return { tba: true, line: "Location TBA" };
    var v = vmap[vid];
    if (!v) return { tba: true, line: "Location TBA" };
    var hasMap = v.lat != null && v.lng != null;
    var parts = [];
    if (o.subvenue != null) parts.push(o.subvenue);
    parts.push(v.name);
    if (v.city != null) parts.push(v.city);
    return {
      tba: false,
      venue: v,
      subvenue: o.subvenue,
      hasMap: hasMap,
      line: parts.join(", ")
    };
  }

  /* ------------------------------------------------------------------ *
   * Derived: event date range and free/paid summary
   * ------------------------------------------------------------------ */

  // (f) min(starts_at) .. max(ends_at, falling back to starts_at where null).
  // Epoch pair, used for sorting and past-hiding.
  function eventDateRange(e) {
    var minStart = Infinity, maxEnd = -Infinity;
    for (var i = 0; i < e.occurrences.length; i++) {
      var o = e.occurrences[i];
      if (o.starts_at < minStart) minStart = o.starts_at;
      var end = effectiveEnd(o);
      if (end > maxEnd) maxEnd = end;
    }
    return { start: minStart, end: maxEnd };
  }

  // Inclusive ET display range as day-key strings, for the "Runs X to Y" label.
  // All-day ends_at is the EXCLUSIVE next-midnight, so the last covered day is
  // one day earlier; using the raw epoch would overstate the run by a day.
  function eventDisplayRange(e, tz) {
    var startKey = null, endKey = null;
    for (var i = 0; i < e.occurrences.length; i++) {
      var o = e.occurrences[i];
      var sk = dayKey(o.starts_at, tz);
      if (startKey === null || sk < startKey) startKey = sk;
      var ek;
      if (o.is_all_day) {
        var days = enumerateAllDayDays(o, tz);
        ek = days.length ? days[days.length - 1] : sk;
      } else {
        ek = dayKey(effectiveEnd(o), tz);
      }
      if (endKey === null || ek > endKey) endKey = ek;
    }
    return { startKey: startKey, endKey: endKey };
  }

  // (g) "Free" if all showings free, "Paid" if none free, else "Free and paid".
  function eventFreeSummary(e) {
    var free = 0, total = e.occurrences.length;
    for (var i = 0; i < total; i++) if (e.occurrences[i].is_free) free++;
    if (free === total) return "Free";
    if (free === 0) return "Paid";
    return "Free and paid";
  }

  // True if ANY occurrence is free (card surfaces under the free-only filter).
  function eventHasFreeOccurrence(e) {
    for (var i = 0; i < e.occurrences.length; i++) {
      if (e.occurrences[i].is_free) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Occurrence rendering
   * ------------------------------------------------------------------ */

  // Timed occurrence -> [dayKey(starts_at)]. All-day -> every covered ET day.
  function occurrenceDays(o, tz) {
    if (o.is_all_day) return enumerateAllDayDays(o, tz);
    return [dayKey(o.starts_at, tz)];
  }

  /* ------------------------------------------------------------------ *
   * Escaping (rule 11)
   * ------------------------------------------------------------------ */
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(s) {
    return escapeHtml(s); // same five chars cover attribute values
  }

  /* ------------------------------------------------------------------ *
   * FEED_BASE (rule 6, the ONE place feed URLs are composed)
   *
   * Derived from document.location so it stays correct under the
   * /<repo>/ GitHub Pages prefix and under a custom domain alike.
   * events.json (and the .ics tree) live in the repo root, served
   * alongside events.json. From a page at /<repo>/<page>/ the base is
   * one level up; from the repo root it is the document's own dir.
   * ------------------------------------------------------------------ */
  function feedBase() {
    var path = document.location.pathname.replace(/\/+$/, "");
    // Drop the trailing path segment (the page directory), keep the rest.
    var dir = path.split("/").slice(0, -1).join("/");
    var base = document.location.origin + (dir ? dir + "/" : "/");
    return base;
  }

  function feedUrl(relPath) {
    if (relPath == null) return null;
    return feedBase() + relPath.replace(/^\.\//, "");
  }

  // The one-click subscribe form: the same FEED_BASE http(s) URL with the
  // protocol swapped to webcal:, which calendar apps open as a live, nightly
  // updating subscription rather than a one-time download. Derived from
  // feedUrl so feed-URL composition still lives in exactly one place.
  function feedUrlWebcal(relPath) {
    var u = feedUrl(relPath);
    if (u == null) return null;
    return u.replace(/^https?:/i, "webcal:");
  }

  /* ------------------------------------------------------------------ *
   * Generated-at footer string (rule, plain "Updated {date}")
   * ------------------------------------------------------------------ */
  function updatedString(data, tz) {
    var f = fmt(tz, { dateStyle: "long" });
    return "Updated " + f.format(new Date(data.generated_at * 1000));
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */
  global.AEC = {
    SUPPORTED_SCHEMA_VERSION: SUPPORTED_SCHEMA_VERSION,
    load: load,
    onError: onError,
    maps: maps,
    timezone: timezone,
    dayKey: dayKey,
    nextDay: nextDay,
    enumerateAllDayDays: enumerateAllDayDays,
    effectiveEnd: effectiveEnd,
    occurrenceDays: occurrenceDays,
    fmt: fmt,
    resolveVenueId: resolveVenueId,
    resolveTicketUrl: resolveTicketUrl,
    resolveDetailBody: resolveDetailBody,
    resolveListLine: resolveListLine,
    resolveVenueDisplay: resolveVenueDisplay,
    eventDateRange: eventDateRange,
    eventDisplayRange: eventDisplayRange,
    eventFreeSummary: eventFreeSummary,
    eventHasFreeOccurrence: eventHasFreeOccurrence,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    feedBase: feedBase,
    feedUrl: feedUrl,
    feedUrlWebcal: feedUrlWebcal,
    updatedString: updatedString
  };
})(window);
