/*
 * Bandh-Mitra patrol app (page logic). Plain JS, no build step, no CDN.
 *
 * Flow: home -> new report (stretch, type, severity, optional photo, note) or all-OK check-in -> saved to the
 * IndexedDB outbox (queue.js) -> uploaded at once if online, else retried on "online", on a timer, and by the
 * background sync event (sw.js). "My reports" shows every local record with its sync status.
 *
 * Stretches: loaded from ../data/bandh/stretches.geojson (C2 in the design) when the server has it, cached in
 * localStorage for offline use. Each stretch is reduced to its id and a centroid. If the list is missing, the
 * report is still allowed with GPS only (stretch_id null). The nearest stretch to GPS is pre-selected; the
 * patroller can change it.
 *
 * Photos: taken with the camera (capture=environment), downscaled on a canvas to <= 1280 px on the long side,
 * encoded as JPEG (quality 0.8, then 0.6 if over 3 MB). The server re-checks size and magic bytes.
 *
 * No emoji in the UI. Text is set with textContent, never innerHTML.
 */
(function () {
  "use strict";

  var MAX_PHOTO_BYTES = 3 * 1024 * 1024;
  var MAX_SIDE_PX = 1280;
  var STRETCH_CACHE_KEY = "bandh-stretches-v1";
  var LANG_KEY = "bandh-lang";
  var TYPES = ["seepage", "sand_boil", "crack", "rat_hole", "slope_erosion", "overtopping_risk"];
  var GEO_TIMEOUT_MS = 12000;
  var FLUSH_EVERY_MS = 60000;

  var T = BandhStrings.t;
  var state = {
    lang: "hi",
    mode: "report",          // "report" | "checkin"
    type: null,
    severity: null,
    photo: null,             // Blob (JPEG)
    photoUrl: null,
    gps: null,               // { lat, lon, accuracy }
    gpsDone: false,
    stretches: [],           // [{ id, embankment_id, side, lat, lon }]
    stretchTouched: false,
    busy: false
  };

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function flash(msg, kind) {
    var f = $("flash");
    f.textContent = msg;
    f.className = "flash" + (kind ? " " + kind : "");
    f.hidden = false;
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () { f.hidden = true; }, 6000);
  }

  // ------------------------------------------------------------------ language
  function applyLang() {
    var lang = state.lang;
    document.documentElement.lang = lang === "mai" ? "mai" : lang;
    qsa(".lang-btn").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-lang") === lang ? "true" : "false");
    });
    qsa("[data-i18n]").forEach(function (n) { n.textContent = T(lang, n.getAttribute("data-i18n")); });
    qsa("[data-i18n-placeholder]").forEach(function (n) {
      n.setAttribute("placeholder", T(lang, n.getAttribute("data-i18n-placeholder")));
    });
    $("app-title").textContent = T(lang, "app_title");
    $("app-sub").textContent = T(lang, "app_sub");
    $("offline-banner").textContent = T(lang, "offline");
    renderTypeGrid();
    renderStretchSelect();
    if (state.photo) $("photo-text").textContent = T(lang, "photo_change");
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode: keep going */ }
    if (!$("view-mine").hidden) renderMine();
  }

  // ------------------------------------------------------------------ views
  function show(view) {
    ["home", "form", "mine"].forEach(function (v) { $("view-" + v).hidden = v !== view; });
    window.scrollTo(0, 0);
    if (view === "mine") renderMine();
  }

  // ------------------------------------------------------------------ stretches and GPS
  function centroidOf(geom) {
    var sx = 0, sy = 0, n = 0;
    function addLine(coords) {
      coords.forEach(function (c) { sx += c[0]; sy += c[1]; n += 1; });
    }
    if (!geom) return null;
    if (geom.type === "LineString") addLine(geom.coordinates);
    else if (geom.type === "MultiLineString") geom.coordinates.forEach(addLine);
    if (!n) return null;
    return { lon: sx / n, lat: sy / n };
  }

  function compactStretches(fc) {
    var out = [];
    ((fc && fc.features) || []).forEach(function (f) {
      var p = f.properties || {};
      if (!p.stretch_id || (p.geometry_status && p.geometry_status !== "ok")) return;
      var c = centroidOf(f.geometry);
      if (!c) return;
      out.push({ id: String(p.stretch_id), embankment_id: p.embankment_id || null, side: p.side_protected || null,
                 lat: c.lat, lon: c.lon });
    });
    return out;
  }

  function loadStretches() {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(STRETCH_CACHE_KEY) || "null"); } catch (e) { cached = null; }
    if (cached && cached.length) state.stretches = cached;
    return fetch("../data/bandh/stretches.geojson", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (fc) {
        var list = compactStretches(fc);
        if (list.length) {
          state.stretches = list;
          try { localStorage.setItem(STRETCH_CACHE_KEY, JSON.stringify(list)); } catch (e) { /* quota: keep in memory */ }
        }
      })
      .catch(function () { /* no list on this server or offline: keep cached list or none */ })
      .then(function () { renderStretchSelect(); });
  }

  function distanceM(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLon = (b.lon - a.lon) * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Returns copies with a distance (metres, when GPS is known) so the shared list is never mutated.
  function sortedStretches() {
    var list = state.stretches.map(function (s) {
      return { id: s.id, lat: s.lat, lon: s.lon, d: state.gps ? distanceM(state.gps, s) : undefined };
    });
    if (state.gps) list.sort(function (a, b) { return a.d - b.d; });
    else list.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return list;
  }

  function renderStretchSelect() {
    var sel = $("stretch");
    var keep = sel.value;
    sel.textContent = "";
    sel.appendChild(new Option(T(state.lang, "stretch_none"), ""));
    var list = sortedStretches();
    list.forEach(function (s, i) {
      var label = s.id;
      if (state.gps && s.d !== undefined) {
        label += "  (" + Math.round(s.d) + " m)";
        if (i === 0) label = T(state.lang, "stretch_nearest") + ": " + label;
      }
      sel.appendChild(new Option(label, s.id));
    });
    if (!state.stretchTouched && state.gps && list.length) {
      sel.value = list[0].id;
    } else if (keep && list.some(function (s) { return s.id === keep; })) {
      sel.value = keep;
    }
    $("list-status").textContent = !state.stretches.length ? T(state.lang, "stretch_no_list") : "";
  }

  function locate() {
    var status = $("gps-status");
    if (!navigator.geolocation) {
      state.gpsDone = true;
      status.textContent = T(state.lang, "gps_fail");
      return;
    }
    status.textContent = T(state.lang, "gps_locating");
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy };
      state.gpsDone = true;
      status.textContent = T(state.lang, "gps_ok") + " · " +
        T(state.lang, "gps_accuracy", { m: Math.round(pos.coords.accuracy) });
      renderStretchSelect();
    }, function () {
      state.gps = null;
      state.gpsDone = true;
      status.textContent = T(state.lang, "gps_fail");
    }, { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60000 });
  }

  // ------------------------------------------------------------------ type and severity
  function renderTypeGrid() {
    var grid = $("type-grid");
    grid.textContent = "";
    TYPES.forEach(function (t) {
      var b = el("button", "type-btn", T(state.lang, "type_" + t));
      b.type = "button";
      b.setAttribute("data-type", t);
      b.setAttribute("aria-pressed", state.type === t ? "true" : "false");
      b.addEventListener("click", function () {
        state.type = t;
        $("err-type").hidden = true;
        renderTypeGrid();
      });
      grid.appendChild(b);
    });
  }

  function renderSeverity() {
    qsa("#sev-row .sev").forEach(function (b) {
      b.setAttribute("aria-pressed", Number(b.getAttribute("data-sev")) === state.severity ? "true" : "false");
    });
  }

  function setMode(mode) {
    state.mode = mode;
    var checkin = mode === "checkin";
    $("type-field").hidden = checkin;
    $("sev-field").hidden = checkin;
    $("form-h").textContent = checkin ? T(state.lang, "checkin_title") : T(state.lang, "form_title");
    if (checkin) {
      state.type = "all_ok";
      state.severity = 1;
      $("note").setAttribute("placeholder", T(state.lang, "checkin_note"));
    } else {
      state.type = null;
      state.severity = null;
      $("note").setAttribute("placeholder", T(state.lang, "note_hint"));
    }
    renderTypeGrid();
    renderSeverity();
  }

  // ------------------------------------------------------------------ photo
  function downscale(file, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var s = Math.min(1, MAX_SIDE_PX / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * s));
        c.height = Math.max(1, Math.round(h * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode"));
        }, "image/jpeg", quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function onPhotoPicked(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var status = $("photo-status");
    status.textContent = T(state.lang, "photo_busy");
    downscale(file, 0.8)
      .then(function (blob) {
        if (blob.size > MAX_PHOTO_BYTES) return downscale(file, 0.6);
        return blob;
      })
      .then(function (blob) {
        if (blob.size > MAX_PHOTO_BYTES) {
          status.textContent = T(state.lang, "photo_big");
          ev.target.value = "";
          return;
        }
        setPhoto(blob);
        status.textContent = "";
      })
      .catch(function () {
        status.textContent = T(state.lang, "photo_bad");
        ev.target.value = "";
      });
  }

  function setPhoto(blob) {
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    state.photo = blob;
    state.photoUrl = blob ? URL.createObjectURL(blob) : null;
    $("preview-img").src = state.photoUrl || "";
    $("preview").hidden = !blob;
    $("photo-text").textContent = T(state.lang, blob ? "photo_change" : "photo");
  }

  // ------------------------------------------------------------------ submit
  function resetForm() {
    state.type = null;
    state.severity = null;
    state.stretchTouched = false;
    setPhoto(null);
    $("photo").value = "";
    $("note").value = "";
    $("photo-status").textContent = "";
    $("err-type").hidden = true;
    $("err-sev").hidden = true;
    renderSeverity();
  }

  function buildPayload() {
    var sel = $("stretch").value || null;
    var note = $("note").value.trim();
    var g = state.gps;
    return {
      report_type: state.type,
      severity: state.severity,
      stretch_id: sel,
      note: note || null,
      lat: g ? g.lat : null,
      lon: g ? g.lon : null,
      accuracy_m: g && isFinite(g.accuracy) ? Math.min(100000, Math.max(0, g.accuracy)) : null,
      captured_at: new Date().toISOString()
    };
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    if (state.mode === "report") {
      var bad = false;
      if (!state.type) { $("err-type").textContent = T(state.lang, "err_type"); $("err-type").hidden = false; bad = true; }
      if (!state.severity) { $("err-sev").textContent = T(state.lang, "err_sev"); $("err-sev").hidden = false; bad = true; }
      if (bad) { flash(T(state.lang, state.type ? "err_sev" : "err_type"), "bad"); return; }
    }
    state.busy = true;
    var btn = $("btn-submit");
    btn.disabled = true;
    btn.textContent = T(state.lang, "submitting");
    var payload = buildPayload();
    var photo = state.photo;
    BandhQueue.saveReport(payload, photo)
      .then(function (rec) {
        requestBackgroundSync();
        if (navigator.onLine === false) return rec.local_id;
        // The report is already in the outbox. A flush failure must not look like a failed save,
        // or the form would stay filled and a resubmit would create a second report.
        return BandhQueue.flush().catch(function () { /* stays queued; retried later */ })
          .then(function () { return rec.local_id; });
      })
      .then(function (localId) {
        return BandhQueue.listReports().catch(function () { return []; }).then(function (rows) {
          var row = rows.filter(function (r) { return r.local_id === localId; })[0];
          var sent = row && row.status === "sent";
          resetForm();
          setMode("report");
          show("home");
          flash(T(state.lang, sent ? "saved_online" : "saved_queued"), sent ? "" : "warn");
        });
      })
      .catch(function () {
        // Nothing was stored (IndexedDB refused the write), so the form stays filled in for a retry.
        flash(T(state.lang, "save_failed"), "bad");
      })
      .then(function () {
        state.busy = false;
        btn.disabled = false;
        btn.textContent = T(state.lang, "submit");
      });
  }

  // ------------------------------------------------------------------ my reports
  function fmtTime(iso) {
    try {
      var loc = state.lang === "hi" ? "hi-IN" : "en-IN";
      return new Date(iso).toLocaleString(loc, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return iso; }
  }

  function statusKey(s) {
    return { queued: "status_queued", sending: "status_sending", sent: "status_sent",
             failed: "status_failed", rejected: "status_rejected" }[s] || "status_queued";
  }

  function renderMine() {
    var list = $("mine-list");
    list.textContent = "";
    BandhQueue.listReports().then(function (rows) {
      if (!rows.length) {
        list.appendChild(el("li", "empty", T(state.lang, "mine_empty")));
        return;
      }
      rows.forEach(function (r) {
        var p = r.payload || {};
        var li = el("li", "item");
        var top = el("div", "item-top");
        top.appendChild(el("span", "item-type", T(state.lang, "type_" + p.report_type)));
        top.appendChild(el("span", "badge st-" + r.status, T(state.lang, statusKey(r.status))));
        li.appendChild(top);
        var meta = [
          p.stretch_id || T(state.lang, "no_stretch"),
          "S" + p.severity,
          r.photo ? T(state.lang, "with_photo") : T(state.lang, "no_photo"),
          fmtTime(r.created_at)
        ].filter(Boolean).join(" · ");
        li.appendChild(el("div", "item-meta", meta));
        if (r.status === "rejected" || r.status === "failed") {
          li.appendChild(el("div", "item-err", r.last_error || ""));
        }
        list.appendChild(li);
      });
    });
  }

  function retryAll() {
    var btn = $("btn-retry");
    btn.disabled = true;
    btn.textContent = T(state.lang, "mine_sending");
    BandhQueue.flush().then(function () {
      renderMine();
      btn.textContent = T(state.lang, "mine_retry");
      btn.disabled = false;
    }, function () {
      btn.textContent = T(state.lang, "mine_retry");
      btn.disabled = false;
    });
  }

  // ------------------------------------------------------------------ background sync
  function requestBackgroundSync() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.sync && reg.sync.register) return reg.sync.register("patrol-flush");
    }).catch(function () { /* no sync support: the timer and online event cover it */ });
  }

  function flushQuietly() {
    if (navigator.onLine === false || state.busy) return;
    BandhQueue.flush().then(function (n) {
      if (n > 0 && !$("view-mine").hidden) renderMine();
    }, function () { /* IndexedDB unavailable: report stays in memory only; nothing to do */ });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* https or localhost required */ });
    });
  }

  // ------------------------------------------------------------------ boot
  function bindEvents() {
    qsa(".lang-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        state.lang = b.getAttribute("data-lang");
        applyLang();
      });
    });
    $("btn-new").addEventListener("click", function () {
      setMode("report");
      show("form");
      locate();
    });
    $("btn-ok").addEventListener("click", function () {
      setMode("checkin");
      show("form");
      locate();
    });
    $("btn-mine").addEventListener("click", function () { show("mine"); });
    $("btn-retry").addEventListener("click", retryAll);
    qsa("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () { show(b.getAttribute("data-go")); });
    });
    qsa("#sev-row .sev").forEach(function (b) {
      b.addEventListener("click", function () {
        state.severity = Number(b.getAttribute("data-sev"));
        $("err-sev").hidden = true;
        renderSeverity();
      });
    });
    $("stretch").addEventListener("change", function () { state.stretchTouched = true; });
    $("photo").addEventListener("change", onPhotoPicked);
    $("photo-remove").addEventListener("click", function () {
      setPhoto(null);
      $("photo").value = "";
      $("photo-status").textContent = "";
    });
    $("report-form").addEventListener("submit", onSubmit);

    function updateOnline() { $("offline-banner").hidden = navigator.onLine !== false; }
    window.addEventListener("online", function () { updateOnline(); flushQuietly(); });
    window.addEventListener("offline", updateOnline);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") flushQuietly();
    });
    setInterval(flushQuietly, FLUSH_EVERY_MS);
    updateOnline();
  }

  function init() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) { saved = null; }
    state.lang = BandhStrings.LANGS.indexOf(saved) >= 0 ? saved : "hi";
    bindEvents();
    applyLang();
    setMode("report");
    loadStretches();
    registerServiceWorker();
    flushQuietly();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
