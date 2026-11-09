/* SARITA dashboard - Model Lab page (#lab).
 * Gallery of held-out Sen1Floods11 chips (web/data/gallery/index.json), a 5-panel viewer,
 * "Run model live" (GET /api/predict_chip) and GeoTIFF upload (POST /api/predict). */
(function () {
  'use strict';
  const S = window.SARITA;
  const F = S.fmt, h = S.h, isNum = S.isNum;

  const PANELS = [
    { key: 'sar', label: 'SAR (VV)', cls: 'sar' },
    { key: 'label', label: 'Hand label' },
    { key: 'pred', label: 'Prediction' },
    { key: 'unc', label: 'Uncertainty' },
    { key: 'error', label: 'Errors' },
  ];
  const UP_PANELS = [
    { key: 'sar', label: 'SAR (VV)', cls: 'sar' },
    { key: 'prob', label: 'Water probability' },
    { key: 'mask', label: 'Water mask' },
    { key: 'unc', label: 'Uncertainty' },
  ];

  const st = { gallery: null, chips: [], current: null, busy: false, file: null };

  async function init() {
    const g = await S.data('data/gallery/index.json');
    st.gallery = g && Array.isArray(g.chips) ? g : null;
    st.chips = st.gallery ? st.gallery.chips : [];
    const model = st.gallery && st.gallery.model;
    S.$('#labModel').textContent = model ? 'Model: ' + model + (st.gallery.tta ? ', 8-view test-time augmentation' : '') + '.' : '';

    const evSel = S.$('#fEvent');
    const events = (st.gallery && st.gallery.events) || Array.from(new Set(st.chips.map(function (c) { return c.event; }))).sort();
    events.forEach(function (e) { evSel.appendChild(h('option', { value: e, text: e })); });
    ['#fSplit', '#fEvent', '#fSort'].forEach(function (id) { S.$(id).addEventListener('change', renderGallery); });
    const dl = S.$('#chipList');
    st.chips.forEach(function (c) { dl.appendChild(h('option', { value: c.name })); });

    if (!st.gallery) {
      S.msg(S.$('#galleryMsg'), 'warn', null,
        'No chip gallery found (<code>web/data/gallery/index.json</code>). Create it with <code>python -m sarita.export_web gallery</code>. You can still type any chip id under the viewer and run the model live.');
    }
    renderGallery();
    renderLegend();
    S.$('#vLive').addEventListener('click', function () { if (st.current) runLive(st.current.name); });
    S.$('#chipForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = S.$('#chipName').value.trim();
      if (!name) return;
      const c = st.chips.find(function (x) { return x.name.toLowerCase() === name.toLowerCase(); });
      if (c) select(c);
      else showEmpty(name);
      runLive(c ? c.name : name);
    });
    initUpload();
    const first = sorted(filtered())[0];
    if (first) select(first);
    else showEmpty(null);
  }

  /* ---------------------------------------------------------------- gallery */
  function filtered() {
    const sp = S.$('#fSplit').value, ev = S.$('#fEvent').value;
    return st.chips.filter(function (c) { return (!sp || c.split === sp) && (!ev || c.event === ev); });
  }
  function sorted(list) {
    const how = S.$('#fSort').value;
    const v = function (x) { return isNum(x) ? x : -1; };
    return list.slice().sort(function (a, b) {
      if (how === 'iou-asc') return v(a.iou) - v(b.iou);
      if (how === 'water-desc') return v(b.water_fraction) - v(a.water_fraction);
      if (how === 'name') return a.name.localeCompare(b.name);
      return v(b.iou) - v(a.iou);
    });
  }
  function renderGallery() {
    const box = S.$('#gallery');
    S.clear(box);
    const list = sorted(filtered());
    const ious = list.map(function (c) { return c.iou; }).filter(isNum);
    S.$('#galleryCount').textContent = st.chips.length
      ? list.length + ' of ' + st.chips.length + ' chips' + (ious.length ? ' · mean per-chip IoU ' + F.fixed(ious.reduce(function (a, b) { return a + b; }, 0) / ious.length, 3) : '') +
        (st.gallery && st.gallery.metrics_note ? ' · ' + st.gallery.metrics_note : '')
      : '';
    if (!list.length && st.chips.length) box.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' }, text: 'No chip matches these filters.' }));
    list.forEach(function (c) {
      const active = st.current && st.current.name === c.name;
      box.appendChild(h('button', { type: 'button', class: 'chip' + (active ? ' active' : ''), title: c.name + ' (' + c.split + ')', dataset: { name: c.name },
        on: { click: function () { select(c); } } },
        h('img', { src: c.thumb || (c.images && c.images.sar) || '', alt: 'SAR thumbnail of ' + c.name, loading: 'lazy' }),
        h('div', { class: 'c-meta' },
          h('div', { style: { minWidth: 0 } }, h('div', { class: 'c-name', text: c.name.replace(/^[A-Za-z-]+_/, '#') }), h('div', { class: 'c-ev', text: c.event + (c.split === 'bolivia' ? ' · unseen' : '') })),
          h('span', { class: 'iou-badge', style: { background: S.iouColor(c.iou) }, title: 'IoU', text: isNum(c.iou) ? c.iou.toFixed(2) : 'n/a' }))));
    });
  }

  /* ---------------------------------------------------------------- viewer */
  function select(c) {
    st.current = c;
    S.$$('#gallery .chip').forEach(function (b) { b.classList.toggle('active', b.dataset.name === c.name); });
    S.$('#vTitle').textContent = c.name;
    S.$('#vSub').textContent = c.event + ' · ' + (c.split === 'bolivia' ? 'Bolivia (an entire flood event never seen in training)' : c.split + ' split') +
      (isNum(c.labelled_fraction) ? ' · ' + F.pct(100 * c.labelled_fraction, 0) + ' of pixels hand-labelled' : '');
    S.$('#vLive').disabled = false;
    renderPanels(S.$('#vPanels'), PANELS, c.images || {}, false);
    renderMetrics(c, null);
    const status = S.$('#vStatus');
    status.hidden = true;
  }
  function showEmpty(name) {
    st.current = name ? { name: name, images: {} } : null;
    S.$('#vTitle').textContent = name || 'Select a chip';
    S.$('#vSub').textContent = name ? 'Not in the gallery: running the model on it directly.' : (st.chips.length ? '' : 'Type a chip id below to run the model live.');
    S.$('#vLive').disabled = !name;
    renderPanels(S.$('#vPanels'), PANELS, {}, false);
    S.clear(S.$('#vMetrics'));
  }
  function renderPanels(box, defs, images, live) {
    S.clear(box);
    defs.forEach(function (p) {
      const src = images[p.key];
      box.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'p-head' }, h('span', { text: p.label }), live ? h('span', { class: 'live-tag', text: 'LIVE' }) : null),
        h('div', { class: 'p-img ' + (p.cls || '') }, src ? h('img', { src: src, alt: p.label }) : null)));
    });
  }
  function metric(label, value, cmp, live) {
    return h('div', { class: 'metric' + (live ? ' live' : '') },
      h('div', { class: 'm-label', text: label }), h('div', { class: 'm-value', text: value }), cmp ? h('div', { class: 'm-cmp', text: cmp }) : null);
  }
  function renderMetrics(c, live) {
    const box = S.$('#vMetrics');
    S.clear(box);
    const m = live ? live.metrics || {} : c;
    const pre = live && c && isNum(c.iou) ? c : null;
    const cmp = function (k, d) { return pre && isNum(pre[k]) ? 'gallery: ' + pre[k].toFixed(d) : ''; };
    box.appendChild(metric('IoU', F.fixed(m.iou, 3), cmp('iou', 3), !!live));
    box.appendChild(metric('F1', F.fixed(m.f1, 3), cmp('f1', 3), !!live));
    box.appendChild(metric('Precision', F.fixed(m.precision, 3), cmp('precision', 3), !!live));
    box.appendChild(metric('Recall', F.fixed(m.recall, 3), cmp('recall', 3), !!live));
    box.appendChild(metric('Water (label)', isNum(m.water_fraction) ? F.pct(100 * m.water_fraction) : F.DASH, '', !!live));
    box.appendChild(metric('Water (pred.)', isNum(m.pred_water_fraction) ? F.pct(100 * m.pred_water_fraction) : F.DASH, '', !!live));
    box.appendChild(metric('Mean entropy', isNum(m.mean_entropy_bits) ? F.fixed(m.mean_entropy_bits, 3) + ' bit' : F.DASH, '', !!live));
  }
  function renderLegend() {
    const box = S.$('#vLegend');
    S.clear(box);
    const lg = (st.gallery && st.gallery.legend) || {
      label: { Water: '#2B6CB0', 'Not water': '#E9E7DF', 'Not labelled': '#C9CFD6' },
      error: { TP: '#2B6CB0', FP: '#E4572E', FN: '#F2C14E', 'Not labelled': '#C9CFD6' },
      unc: { stops: ['#000004', '#51127C', '#B73779', '#FC8961', '#FCFDBF'], min: '0 bits (certain)', max: '1 bit (p = 0.5)' },
    };
    const names = { TP: 'correct water (TP)', FP: 'false alarm (FP)', FN: 'missed water (FN)' };
    if (lg.label) Object.keys(lg.label).forEach(function (k) { box.appendChild(sw(lg.label[k], k)); });
    if (lg.error) Object.keys(lg.error).forEach(function (k) {
      if (lg.error[k] === 'transparent' || k === 'Not labelled') return;
      box.appendChild(sw(lg.error[k], names[k] || k));
    });
    if (lg.unc && lg.unc.stops) {
      box.appendChild(h('span', { class: 'lg' }, 'Uncertainty ' + (lg.unc.min || ''),
        h('span', { class: 'lg-grad', style: { background: 'linear-gradient(90deg,' + lg.unc.stops.join(',') + ')' } }), lg.unc.max || ''));
    }
    function sw(color, label) { return h('span', { class: 'lg' }, h('span', { class: 'lg-sw', style: { background: color } }), label); }
  }

  /* ---------------------------------------------------------------- live inference */
  async function runLive(name) {
    if (st.busy) return;
    st.busy = true;
    const btn = S.$('#vLive'), status = S.$('#vStatus');
    const tta = S.$('#vTta').checked;
    btn.disabled = true;
    status.hidden = false;
    status.className = 'live-status busy';
    const t0 = performance.now();
    S.clear(status).appendChild(h('span', { class: 'spinner' }));
    const label = h('span', { text: 'Running ' + (S.api.health && S.api.health.model ? S.api.health.model : 'the model') + ' on ' + name + (tta ? ' with 8-view TTA' : '') + '…' });
    status.appendChild(label);
    const timer = setInterval(function () { label.textContent = 'Running the model on ' + name + '… ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s'; }, 200);
    const r = await S.api.predictChip(name, tta);
    clearInterval(timer);
    st.busy = false;
    btn.disabled = !st.current;
    if (!r.ok) {
      status.className = 'live-status error';
      S.clear(status);
      if (S.api.isOffline(r)) status.appendChild(S.api.offlineNotice('Live inference'));
      else {
        status.appendChild(h('span', { text: S.api.describeError(r) }));
        if (r.data && Array.isArray(r.data.examples) && r.data.examples.length) status.appendChild(h('span', { text: ' Examples: ' + r.data.examples.join(', ') + '.' }));
      }
      return;
    }
    const d = r.data;
    if (st.current && st.current.name === d.name) {
      renderPanels(S.$('#vPanels'), PANELS, d.images || {}, true);
      const known = st.chips.find(function (c) { return c.name === d.name; });
      renderMetrics(known || null, d);
      if (!known) S.$('#vSub').textContent = d.event + ' · ' + d.split + ' split (not in the gallery)';
    }
    status.className = 'live-status';
    S.clear(status);
    status.appendChild(h('strong', { text: 'Live inference: ' }));
    status.appendChild(document.createTextNode(
      F.fixed(d.seconds, 2) + ' s on ' + String(d.device || '?').toUpperCase() + ' (' + (d.tta ? '8 views' : 'single view') + ', model ' + (d.model || '?') + ')' +
      (isNum(d.model_load_seconds) ? '. The model was loaded first (' + F.fixed(d.model_load_seconds, 1) + ' s, one time only)' : '') +
      '. Round trip ' + F.fixed((performance.now() - t0) / 1000, 2) + ' s.'));
    S.toast('IoU ' + F.fixed(d.metrics && d.metrics.iou, 3) + ' on ' + d.name);
  }

  /* ---------------------------------------------------------------- upload */
  function initUpload() {
    const input = S.$('#upFile'), drop = S.$('#drop'), go = S.$('#upGo');
    const setFile = function (f) {
      st.file = f || null;
      S.$('#dropText').innerHTML = '';
      if (f) {
        S.$('#dropText').appendChild(h('span', null, h('strong', { text: f.name }), ' · ' + F.num(f.size / 1048576, 1) + ' MB · click to choose another file'));
      } else {
        S.$('#dropText').appendChild(h('span', null, h('strong', { text: 'Choose a file' }), ' or drag it here'));
      }
      go.disabled = !f;
      S.msg(S.$('#upMsg'), null, null);
    };
    input.addEventListener('change', function () { setFile(input.files && input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(f);
    });
    S.$('#uploadForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!st.file) return;
      if (!/\.(tif|tiff)$/i.test(st.file.name)) {
        S.msg(S.$('#upMsg'), 'warn', 'The file does not end in .tif/.tiff. Trying anyway: the API checks the content.');
      }
      go.disabled = true;
      const t0 = performance.now();
      const msg = S.$('#upMsg');
      msg.hidden = false;
      msg.className = 'msg';
      S.clear(msg).appendChild(h('span', { class: 'spinner' }));
      const lbl = h('span', { text: 'Uploading and running the model…' });
      msg.appendChild(lbl);
      const timer = setInterval(function () { lbl.textContent = 'Running the model… ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s'; }, 200);
      const r = await S.api.predictUpload(st.file, S.$('#upTta').checked);
      clearInterval(timer);
      go.disabled = false;
      if (!r.ok) {
        S.$('#upResult').hidden = true;
        if (S.api.isOffline(r)) { msg.className = 'msg'; S.clear(msg).appendChild(S.api.offlineNotice('Upload inference')); }
        else S.msg(msg, 'error', S.api.describeError(r));
        return;
      }
      S.msg(msg, null, null);
      showUpload(r.data, (performance.now() - t0) / 1000);
    });
  }
  function showUpload(d, roundTrip) {
    S.$('#upResult').hidden = false;
    const stats = S.$('#upStats');
    S.clear(stats);
    stats.appendChild(metric('Size', F.num(d.width) + ' × ' + F.num(d.height), d.crs || 'no CRS'));
    stats.appendChild(metric('Water', isNum(d.water_km2) ? F.km2(d.water_km2) + ' km²' : F.num(d.water_pixels) + ' px',
      isNum(d.water_fraction) ? F.pct(100 * d.water_fraction) + ' of valid pixels' : ''));
    stats.appendChild(metric('Inference', F.fixed(d.seconds, 2) + ' s', String(d.device || '').toUpperCase() + (d.tta ? ' · 8 views' : '') + ' · round trip ' + F.fixed(roundTrip, 1) + ' s'));
    stats.appendChild(metric('Input read as', d.input || F.DASH, isNum(d.pixel_area_m2) ? F.num(Math.sqrt(d.pixel_area_m2), 1) + ' m pixels' : 'not georeferenced'));
    renderPanels(S.$('#upPanels'), UP_PANELS, d.images || {}, true);
    const warn = S.$('#upWarn');
    S.clear(warn);
    (d.warnings || []).forEach(function (w) { warn.appendChild(h('li', { text: w })); });
    if (d.preview && d.preview.downsample > 1) warn.appendChild(h('li', { text: 'Preview images are shown at 1/' + d.preview.downsample + ' resolution; statistics use every pixel.' }));
  }

  S.labPage = { init: init, onShow: function () {} };
})();
