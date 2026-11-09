/* SARITA dashboard - hash router (#map, #lab, #results, #about), API status pill, banners, lightbox. */
(function () {
  'use strict';
  const S = window.SARITA;
  const F = S.fmt, h = S.h, isNum = S.isNum;

  const PAGES = {
    map: function () { return S.mapPage; },
    lab: function () { return S.labPage; },
    results: function () { return S.resultsPage; },
    bandh: function () { return S.bandhPage; },
    about: function () { return S.aboutPage; },
  };
  const started = {};
  const errors = [];

  /* ---------------------------------------------------------------- router */
  function pageFromHash() {
    const m = /^#([a-z]+)/.exec(location.hash || '');
    return m && PAGES[m[1]] ? m[1] : 'map';
  }
  async function show(name) {
    S.$$('.page').forEach(function (p) { p.hidden = p.dataset.page !== name; });
    S.$$('.tabs a').forEach(function (a) { a.classList.toggle('active', a.dataset.page === name); });
    document.title = 'SARITA · ' + ({ map: 'Flood Map, Kosi 2024', lab: 'Model Lab', results: 'Results', bandh: 'Embankment Watch', about: 'About' })[name];
    const mod = PAGES[name]();
    if (!mod) return;
    if (!started[name]) {
      started[name] = Promise.resolve().then(function () { return mod.init(); }).catch(function (err) {
        console.error('[SARITA] page ' + name + ' failed', err);
        reportError('The ' + name + ' page hit an error: ' + (err && err.message ? err.message : err));
      });
    }
    await started[name];
    try { if (mod.onShow) mod.onShow(); } catch (err) { console.error(err); }
  }

  /* ---------------------------------------------------------------- API status */
  async function checkHealth(attempt) {
    const pill = S.$('#apiStatus');
    const txt = pill.querySelector('.txt');
    const state = await S.api.check();
    pill.classList.remove('ok', 'warn', 'off');
    if (state !== 'online') {
      pill.classList.add('off');
      txt.textContent = 'API offline · static mode';
      pill.title = 'Live inference and bulletins need the API: ' + S.api.startCommand;
      return;
    }
    const hl = S.api.health || {};
    if (hl.model_loaded) {
      pill.classList.add('ok');
      txt.textContent = 'Model ' + hl.model + ' · ' + String(hl.device || '').toUpperCase() + ' · ready';
      pill.title = 'Checkpoint ' + (hl.checkpoint || '') + (isNum(hl.load_seconds) ? ', loaded in ' + F.fixed(hl.load_seconds, 1) + ' s' : '');
    } else if (hl.checkpoint_found === false) {
      pill.classList.add('warn');
      txt.textContent = 'API online · no checkpoint';
      pill.title = hl.model_error || ('Checkpoint not found: ' + (hl.checkpoint || ''));
    } else if (hl.model_error) {
      pill.classList.add('warn');
      txt.textContent = 'API online · model error';
      pill.title = hl.model_error;
    } else {
      pill.classList.add('warn');
      txt.textContent = 'API online · model loads on first use';
      pill.title = 'The model is loaded in the background or on the first "Run model live" click.';
      if ((attempt || 0) < 12) setTimeout(function () { checkHealth((attempt || 0) + 1); }, 5000);
    }
  }

  /* ---------------------------------------------------------------- banners */
  const mockFiles = new Set();
  function renderBanner() {
    const b = S.$('#banner');
    const parts = [];
    if (location.protocol === 'file:') {
      parts.push('Opened as a local file, so the browser blocks the data files. Start the server with <code>' + S.escapeHTML(S.api.startCommand) + '</code> and open <code>http://localhost:8000</code>.');
    }
    if (mockFiles.size) {
      parts.push('Showing <strong>synthetic placeholder data</strong> (' + Array.from(mockFiles).map(function (f) { return '<code>' + S.escapeHTML(f.replace(/^data\//, '')) + '</code>'; }).join(', ') +
        '). These numbers are not results. Re-export with <code>python -m sarita.export_web</code>.');
    }
    errors.forEach(function (e) { parts.push(S.escapeHTML(e)); });
    b.hidden = !parts.length;
    b.className = 'banner' + (errors.length || location.protocol === 'file:' ? ' warn' : '');
    b.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  }
  function reportError(text) {
    if (errors.indexOf(text) < 0 && errors.length < 3) errors.push(text);
    renderBanner();
  }
  S.on('mock', function (path) { mockFiles.add(path); renderBanner(); });

  /* ---------------------------------------------------------------- lightbox */
  S.lightbox = function (src, cap) {
    const lb = S.$('#lightbox');
    lb.querySelector('img').src = src;
    lb.querySelector('img').alt = cap || '';
    lb.querySelector('.lightbox-cap').textContent = cap || '';
    lb.hidden = false;
  };
  function closeLightbox() { S.$('#lightbox').hidden = true; }

  /* ---------------------------------------------------------------- About page (numbers filled from the data files) */
  S.aboutPage = {
    init: async function () {
      const res = await Promise.all([S.data('data/results/experiments.json'), S.data('data/bihar/summary.json')]);
      const exp = res[0], sm = res[1];
      const pairs = [];
      if (exp && Array.isArray(exp.rows)) {
        const main = exp.rows.find(function (r) { return r.id === exp.main; }) || exp.rows[0];
        if (main && main.test) pairs.push(['Test water IoU (' + main.method + ')', F.fixed(main.test.iou, 3)]);
        if (main && main.bolivia) pairs.push(['Unseen Bolivia event IoU', F.fixed(main.bolivia.iou, 3)]);
        const otsu = exp.rows.find(function (r) { return r.id === 'otsu_vh'; });
        if (otsu && otsu.test) pairs.push(['Per-chip Otsu thresholding (VH), test IoU', F.fixed(otsu.test.iou, 3)]);
        if (exp.calibration && isNum(exp.calibration.ece_test)) pairs.push(['Expected calibration error, test', F.fixed(exp.calibration.ece_test, 4)]);
      }
      if (sm && sm.dates) {
        const post = Object.keys(sm.dates).filter(function (d) { return isNum(sm.dates[d].flood_km2); }).sort();
        const peak = post.reduce(function (a, b) { return !a || sm.dates[b].flood_km2 > sm.dates[a].flood_km2 ? b : a; }, null);
        if (peak) {
          pairs.push(['Peak flooded area (' + F.dateLong(peak) + ')', F.km2(sm.dates[peak].flood_km2) + ' km²']);
          if (isNum(sm.dates[peak].people_exposed)) pairs.push(['People exposed on that date', F.num(sm.dates[peak].people_exposed)]);
        }
        if (sm.aoi && isNum(sm.aoi.area_km2)) pairs.push(['Study area mapped at 10 m', F.km2(sm.aoi.area_km2) + ' km²']);
        if (sm.mock) pairs.push(['Note', 'case-study numbers above are mock placeholders']);
      }
      const box = S.$('#aboutNumbers');
      S.clear(box);
      if (!pairs.length) { box.appendChild(h('span', { class: 'fine', text: 'Numbers appear here once the results have been exported.' })); return; }
      pairs.forEach(function (p) { box.appendChild(h('span', { class: 'k', text: p[0] })); box.appendChild(h('span', { class: 'v', text: p[1] })); });
      if (sm && sm.sources) {
        S.$('#aboutSources').textContent = 'As recorded by the pipeline: ' + Object.keys(sm.sources).map(function (k) { return sm.sources[k]; }).filter(Boolean).join(' · ');
      }
    },
    onShow: function () {},
  };

  /* ---------------------------------------------------------------- boot */
  window.addEventListener('error', function (e) {
    if (e && e.message && !/ResizeObserver/.test(e.message)) reportError('Unexpected error: ' + e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    reportError('Unexpected error: ' + (r && r.message ? r.message : r));
  });
  document.addEventListener('DOMContentLoaded', function () {
    const lb = S.$('#lightbox');
    lb.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLightbox(); });
    if (typeof window.L === 'undefined') reportError('Leaflet (web/vendor/leaflet/leaflet.js) did not load: the map is unavailable.');
    if (typeof window.Chart === 'undefined') reportError('Chart.js (web/vendor/chartjs/chart.umd.js) did not load: charts are unavailable.');
    renderBanner();
    window.addEventListener('hashchange', function () { show(pageFromHash()); });
    show(pageFromHash());
    checkHealth(0);
  });
})();
