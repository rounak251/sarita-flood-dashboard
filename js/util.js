/* SARITA dashboard - shared helpers: Indian number formatting, dates, DOM building, data loading.
 * Everything hangs off one global namespace, window.SARITA (classic scripts, no build step). */
(function () {
  'use strict';
  const S = (window.SARITA = window.SARITA || {});

  /* ------------------------------------------------------------------ tiny event bus */
  const listeners = {};
  S.on = function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); };
  S.emit = function (evt, payload) {
    (listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (err) { console.error('[SARITA] listener for "' + evt + '" failed', err); }
    });
  };

  /* ------------------------------------------------------------------ numbers (Indian system) */
  const MINUS = '−';
  const DASH = '—';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  S.isNum = isNum;

  /** "1234567" -> "12,34,567" (last three digits, then groups of two). */
  function groupIndian(digits) {
    if (digits.length <= 3) return digits;
    const head = digits.slice(0, -3);
    return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + digits.slice(-3);
  }
  function trimZeros(s) { return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, ''); }

  /** Indian-grouped number with fixed decimals: num(1234567.8, 1) -> "12,34,567.8". */
  function num(v, decimals) {
    if (!isNum(v)) return DASH;
    const d = decimals || 0;
    const fixed = Math.abs(v).toFixed(d);
    const parts = fixed.split('.');
    const out = groupIndian(parts[0]) + (parts[1] ? '.' + parts[1] : '');
    return (v < 0 && Number(fixed) !== 0 ? MINUS : '') + out;
  }
  /** Area in km2 with sensible precision (>=100 -> integer, >=1 -> 1 decimal, else 2). */
  function km2(v) {
    if (!isNum(v)) return DASH;
    if (v === 0) return '0';
    const a = Math.abs(v);
    return num(v, a >= 100 ? 0 : a >= 1 ? 1 : 2);
  }
  const UNITS = { en: { lakh: 'lakh', crore: 'crore' }, hi: { lakh: 'लाख', crore: 'करोड़' } };
  /** People count in lakh / crore: 212345 -> "2.12 lakh", 21234567 -> "2.12 crore", 45000 -> "45,000". */
  function lakh(v, lang) {
    if (!isNum(v)) return DASH;
    const u = UNITS[lang] || UNITS.en;
    const a = Math.abs(v);
    if (a >= 1e7) return trimZeros((v / 1e7).toFixed(a >= 1e8 ? 1 : 2)) + ' ' + u.crore;
    if (a >= 1e5) return trimZeros((v / 1e5).toFixed(a >= 1e6 ? 1 : 2)) + ' ' + u.lakh;
    return num(Math.round(v));
  }
  function pct(v, decimals) { return isNum(v) ? num(v, decimals === undefined ? 1 : decimals) + '%' : DASH; }
  function fixed(v, decimals) { return isNum(v) ? v.toFixed(decimals === undefined ? 3 : decimals) : DASH; }
  /** Signed change with a real minus sign: signed(-3.2, 1) -> "−3.2", signed(1.5) -> "+1.5". */
  function signed(v, decimals) {
    if (!isNum(v)) return DASH;
    const s = Math.abs(v).toFixed(decimals === undefined ? 3 : decimals);
    if (Number(s) === 0) return '±' + s;
    return (v < 0 ? MINUS : '+') + s;
  }
  /** Axis ticks: 0, 500, 1K, 1.5K ... (K for thousand keeps axes narrow). */
  function compact(v) {
    if (!isNum(v)) return '';
    const a = Math.abs(v);
    if (a >= 1e5) return lakh(v);
    if (a >= 1000) return trimZeros((v / 1000).toFixed(1)) + 'K';
    return trimZeros(v.toFixed(a < 10 && a % 1 ? 1 : 0));
  }

  /* ------------------------------------------------------------------ dates (ISO, no timezone drift) */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function dateShort(s) { const p = parseISO(s); return p ? p.d + ' ' + MON[p.m - 1] : String(s == null ? DASH : s); }
  function dateLong(s) { const p = parseISO(s); return p ? p.d + ' ' + MON[p.m - 1] + ' ' + p.y : String(s == null ? DASH : s); }
  function daysBetween(a, b) {
    const pa = parseISO(a), pb = parseISO(b);
    if (!pa || !pb) return null;
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 864e5);
  }

  S.fmt = { num, km2, lakh, pct, fixed, signed, compact, dateShort, dateLong, daysBetween, groupIndian, DASH, MINUS };

  /* ------------------------------------------------------------------ DOM */
  const PROPS = { value: 'value', checked: 'checked', selected: 'selected', disabled: 'disabled', hidden: 'hidden', for: 'htmlFor', tabIndex: 'tabIndex', open: 'open' };
  function append(el, children) {
    children.flat(Infinity).forEach(function (c) {
      if (c === null || c === undefined || c === false || c === '') return;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  /** h('div', {class: 'x', text: 'safe text', on: {click: fn}}, child, ...) - text is always set via textContent. */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'on') Object.keys(v).forEach(function (e) { el.addEventListener(e, v[e]); });
        else if (PROPS[k]) el[PROPS[k]] = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    return append(el, Array.prototype.slice.call(arguments, 2));
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    return append(el, Array.prototype.slice.call(arguments, 2));
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  S.h = h; S.svg = svg; S.clear = clear; S.append = append; S.escapeHTML = escapeHTML;
  S.$ = function (sel, root) { return (root || document).querySelector(sel); };
  S.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  S.cssVar = function (name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback || '';
  };
  /** "#E4572E" + alpha -> "rgba(228,87,46,a)". */
  S.alpha = function (hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  };

  /** Friendly inline message. kind: info | warn | error | offline. */
  S.notice = function (opts) {
    const kind = opts.kind || 'info';
    const icon = { info: 'i', warn: '!', error: '×', offline: '–' }[kind] || 'i';
    return h('div', { class: 'notice notice-' + kind, role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'notice-icon', 'aria-hidden': 'true', text: icon }),
      h('div', { class: 'notice-body' },
        opts.title ? h('strong', { text: opts.title }) : null,
        opts.text ? h('p', { text: opts.text }) : null,
        opts.node || null,
        opts.code ? h('code', { text: opts.code }) : null));
  };
  S.loading = function (text) { return h('div', { class: 'loading' }, h('span', { class: 'spinner dark', 'aria-hidden': 'true' }), text || 'Loading…'); };

  /* ------------------------------------------------------------------ storage (per-viewer conveniences only) */
  S.store = {
    get: function (k) { try { return window.sessionStorage.getItem('sarita:' + k); } catch (e) { return null; } },
    set: function (k, v) { try { window.sessionStorage.setItem('sarita:' + k, v); } catch (e) { /* private mode */ } },
  };

  /* ------------------------------------------------------------------ fetch */
  /** fetch + JSON with timeout. Never throws: resolves {ok, status, data, error}. */
  S.fetchJSON = async function (url, opts) {
    opts = opts || {};
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 10000) : null;
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET', body: opts.body, headers: opts.headers,
        signal: ctrl ? ctrl.signal : undefined, cache: opts.cache || 'no-cache',
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) {
        if (res.ok) return { ok: false, status: res.status, error: 'The server sent something that is not JSON (' + url + ').' };
      }
      if (!res.ok) {
        let msg = data && (data.detail || data.error || data.message);
        if (Array.isArray(msg)) msg = msg.map(function (d) { return d.msg || JSON.stringify(d); }).join('; ');
        if (msg && typeof msg !== 'string') msg = JSON.stringify(msg);
        return { ok: false, status: res.status, data: data, error: msg || ('HTTP ' + res.status + ' ' + (res.statusText || '')).trim() };
      }
      return { ok: true, status: res.status, data: data };
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      return { ok: false, status: 0, error: aborted ? 'The request timed out.' : 'Could not reach the server (' + (err && err.message ? err.message : err) + ').' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** Registry of the static JSON files the page tried to load (shown on the About tab). */
  S.files = {};
  S.loadJSON = async function (path) {
    const r = await S.fetchJSON(path, { timeout: 20000 });
    const isMock = !!(r.ok && r.data && r.data.mock === true);
    S.files[path] = r.ok ? { state: isMock ? 'mock' : 'ok' } : { state: r.status === 404 ? 'missing' : 'error', error: r.error };
    if (isMock) S.emit('mock', path);
    S.emit('file', path);
    return r.ok ? r.data : null;
  };

  /* ------------------------------------------------------------------ misc */
  S.debounce = function (fn, ms) {
    let t = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };
  S.download = function (filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  };
  S.copyText = async function (text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through to the legacy path */ }
    const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  };
  S.params = new URLSearchParams(window.location.search);

  /* ------------------------------------------------------------------ dashboard helpers */
  S.COLORS = {
    ink: '#0B1F33', teal: '#0E7C86', water: '#2B6CB0', flood: '#E4572E', floodDark: '#C2441F',
    muted: '#5B6B7A', amber: '#F2C14E', paper: '#F7F7F4', line: '#E2E5E0', grid: '#EEF0EC',
  };
  /** Memoised loadJSON: every page asks for the same file at most once per page load. */
  const memo = {};
  S.data = function (path) {
    if (!memo[path]) memo[path] = S.loadJSON(path);
    return memo[path];
  };
  /** Show (or hide, with text == null) a .msg box. kind: info | warn | error | ok. `html` allows <code>. */
  S.msg = function (el, kind, text, html) {
    if (!el) return;
    if (text == null && html == null) { el.hidden = true; clear(el); return; }
    el.className = 'msg' + (kind && kind !== 'info' ? ' ' + kind : '');
    if (html != null) el.innerHTML = html; else el.textContent = text;
    el.hidden = false;
  };
  let toastTimer = null;
  S.toast = function (text) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  };
  /** Colour for an IoU in [0, 1]: red (poor) -> amber -> teal (good). */
  S.iouColor = function (v) {
    if (!isNum(v)) return '#9AA5B1';
    if (v >= 0.8) return '#0E7C86';
    if (v >= 0.6) return '#3E9A8F';
    if (v >= 0.4) return '#C99A1C';
    if (v >= 0.2) return '#E07A3C';
    return '#C2441F';
  };
  /** Sequential light -> dark ramp (used for heat-map cells). */
  S.heat = function (v, lo, hi) {
    if (!isNum(v)) return { bg: 'transparent', fg: '#5B6B7A' };
    const t = Math.max(0, Math.min(1, (v - lo) / ((hi - lo) || 1)));
    const a = [247, 247, 244], b = [14, 124, 134];
    const c = a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); });
    return { bg: 'rgb(' + c.join(',') + ')', fg: t > 0.55 ? '#fff' : '#0B1F33' };
  };
  /** Chart.js defaults matching the dashboard (only if Chart.js loaded). */
  S.chartDefaults = function () {
    if (!window.Chart || S._chartDefaultsSet) return;
    S._chartDefaultsSet = true;
    const C = window.Chart;
    C.defaults.font.family = getComputedStyle(document.body).fontFamily;
    C.defaults.font.size = 11.5;
    C.defaults.color = S.COLORS.muted;
    C.defaults.borderColor = S.COLORS.grid;
    C.defaults.plugins.legend.labels.boxWidth = 12;
    C.defaults.plugins.legend.labels.boxHeight = 10;
    C.defaults.plugins.tooltip.backgroundColor = 'rgba(11,31,51,.92)';
    C.defaults.plugins.tooltip.padding = 8;
    C.defaults.animation = { duration: 350 };
    C.defaults.maintainAspectRatio = false;
  };
  /** Create (or replace) a chart on a canvas; returns null when Chart.js is unavailable. */
  const charts = {};
  S.chart = function (canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart) return null;
    S.chartDefaults();
    if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
    if (!config) return null;
    try {
      charts[canvasId] = new window.Chart(canvas, config);
    } catch (err) {
      console.error('[SARITA] chart ' + canvasId + ' failed', err);
      charts[canvasId] = null;
    }
    return charts[canvasId];
  };
  S.getChart = function (canvasId) { return charts[canvasId] || null; };
  S.resizeCharts = function () {
    Object.keys(charts).forEach(function (k) { if (charts[k]) charts[k].resize(); });
  };
})();
