/*
 * Bandh-Mitra offline outbox. Shared by the page (index.html) and the service worker (sw.js, importScripts).
 *
 * Every report is written to IndexedDB first (status "queued"), then uploaded as multipart/form-data:
 *   field "report" = JSON text of the payload, optional field "photo" = JPEG blob.
 * Statuses: queued | sending | failed (network or 5xx, retried later) | sent | rejected (4xx, kept for the user to see).
 * client_id = local_id, so a retry after a lost response is idempotent on the server (duplicate: true).
 *
 * Exposes global BandhQueue = { API, saveReport, listReports, deleteReport, flush }.
 */
(function (global) {
  "use strict";
  var DB_NAME = "bandh-mitra";
  var STORE = "reports";
  var DB_VERSION = 1;
  // Resolved against this script's own URL, so it works under /patrol/ in the page and in the worker.
  var API = new URL("../api/bandh/patrol/", global.location.href).href;

  var dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var s = db.createObjectStore(STORE, { keyPath: "local_id" });
            s.createIndex("created_at", "created_at");
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  function withStore(mode, work) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var result;
        var req = work(store);
        if (req) req.onsuccess = function () { result = req.result; };
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
      });
    });
  }

  function putReport(rec) { return withStore("readwrite", function (s) { return s.put(rec); }); }

  function listReports() {
    return withStore("readonly", function (s) { return s.getAll(); }).then(function (rows) {
      return (rows || []).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
    });
  }

  function deleteReport(localId) { return withStore("readwrite", function (s) { return s.delete(localId); }); }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  // payload: the JSON object the server validates. photoBlob: optional JPEG Blob.
  function saveReport(payload, photoBlob) {
    var now = new Date().toISOString();
    var localId = uuid();
    payload.client_id = localId;
    var rec = {
      local_id: localId,
      created_at: now,
      status: "queued",
      attempts: 0,
      last_error: null,
      sent_at: null,
      server_id: null,
      payload: payload,
      photo: photoBlob || null
    };
    return putReport(rec).then(function () { return rec; });
  }

  // Returns "sent" | "retry" | "rejected".
  function sendOne(rec) {
    rec.status = "sending";
    rec.attempts = (rec.attempts || 0) + 1;
    return putReport(rec).then(function () {
      var fd = new FormData();
      fd.append("report", JSON.stringify(rec.payload));
      if (rec.photo) fd.append("photo", rec.photo, "photo.jpg");
      return fetch(API + "report", { method: "POST", body: fd, credentials: "same-origin", cache: "no-store" })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.ok) {
              rec.status = "sent";
              rec.sent_at = new Date().toISOString();
              rec.server_id = body.report ? body.report.report_id : null;
              rec.last_error = null;
              return putReport(rec).then(function () { return "sent"; });
            }
            var permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
            rec.status = permanent ? "rejected" : "failed";
            rec.last_error = body.message || ("HTTP " + res.status);
            return putReport(rec).then(function () { return permanent ? "rejected" : "retry"; });
          });
        }, function () {
          rec.status = "failed";
          rec.last_error = "network";
          return putReport(rec).then(function () { return "retry"; });
        });
    });
  }

  var running = null;
  // Uploads every queued or failed report, oldest first. Stops at the first network failure.
  function flush() {
    if (running) return running;
    running = listReports().then(function (rows) {
      var pending = rows.filter(function (r) { return r.status === "queued" || r.status === "failed" || r.status === "sending"; })
        .sort(function (a, b) { return a.created_at.localeCompare(b.created_at); });
      var sent = 0;
      return pending.reduce(function (chain, rec) {
        return chain.then(function (stop) {
          if (stop) return true;
          if (global.navigator && global.navigator.onLine === false) return true;
          return sendOne(rec).then(function (outcome) {
            if (outcome === "sent") sent += 1;
            return outcome === "retry";
          });
        });
      }, Promise.resolve(false)).then(function () { return sent; });
    }).finally(function () { running = null; });
    return running;
  }

  global.BandhQueue = {
    API: API,
    saveReport: saveReport,
    listReports: listReports,
    deleteReport: deleteReport,
    flush: flush
  };
})(self);
