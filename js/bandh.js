/* SARITA dashboard - Embankment Watch (#bandh).
 * Embankment stretches on a Leaflet map coloured by the unvalidated risk index, a ranked table, a drill-down panel
 * (features, chainage, feature time series, patrol reports), a breach simulator (POST /api/bandh/simulate), an alert
 * preview in EN / HI / MAI (dry run only), the inspection order download, breach-detector events and the 2024 backtest.
 *
 * Data: every read tries the API first (api/bandh/...) and falls back to the static copies the export writes to
 * web/data/bandh/ when the API is unreachable. A 404 with code "not_computed" means "not computed yet" and is shown
 * as such. Nothing is hard-coded except labels and the honesty wording, which the page always shows. */
(function () {
  'use strict';
  const S = window.SARITA;
  const F = S.fmt, h = S.h, C = S.COLORS, isNum = S.isNum;

  const RAMP = ['#DCE9F7', '#9EC5E8', '#5C8FD0', '#4B3FA8', '#2A1B5E'];     // risk index 0-20 ... 80-100
  const GREY = '#A7B0BA';
  const BAND_COLOURS = ['#08306B', '#2171B5', '#6BAED6', '#9ECAE1', '#DEEBF7']; // arrival: earliest ... latest
  const DETECT_COLOUR = '#F2C14E';          // orbit 121 (frozen detector)
  const DETECT85_COLOUR = '#1B998B';        // orbit 85 (post-hoc corridor run)
  const DETECT_ORBITS = ['121', '85'];
  const KIND_LABEL = { watch: 'Inspection request', warning: 'Warning', breach: 'Breach reported', all_clear: 'All clear' };
  const LANG_LABEL = { en: 'English', hi: 'Hindi (हिन्दी)', mai: 'Maithili (मैथिली)' };
  const CHANNEL_LABEL = { sms: 'SMS', ivr: 'Voice call (IVR)', whatsapp: 'WhatsApp' };
  const STATUS_TEXT = {
    reviewed_builder: 'Checked by the builder. Not a native-speaker review.',
    draft_unreviewed: 'Draft. Not reviewed by a native speaker yet.',
  };
  const SCORE_TEXT = { ok: 'scored', low_coverage: 'low coverage', side_unknown: 'side unknown' };
  const FEATURE_NAMES = {
    F1: 'Landside wetness (radar residual)', F2: 'River proximity and rate', F3: 'Radar texture (not computed)',
    F4: 'Prior (breach history and geometry)', F5: 'Exposure', F7: 'Hydraulic load', F8: 'Crest weakness', F9: 'River attack',
  };
  /* Breach date of the 2024 Bhubhaul event (web/data/bandh/breaches.geojson, KOSI-2024-09-DARBHANGA-BHUBHAUL). */
  const BREACH_DATE = '2024-09-29';
  const PRE_BREACH_FREEZE = '2024-09-27';

  const st = {
    manifest: null, stretches: null, feats: {}, dates: [], date: null, risk: null, riskByStretch: {}, riskState: 'idle',
    backtest: null, detByOrbit: {}, selected: null, drillToken: 0, sim: null, simMode: false,
    map: null, lines: null, detLayer: null, det85Layer: null, fpLayer: null, selMarker: null, simMarker: null, tile: null,
    sortKey: 'rank', sortDir: 1, mock: false, lastVillages: [], lastDate: null, ready: false, bounds: null,
    layers: { stretches: true, detections: true, detections85: true, footprint: true },
  };

  /* ------------------------------------------------------------------ data access */
  /** API first; static copy when the API is unreachable. status: ok | not_computed | offline | error. */
  async function getJSON(apiPath, staticPath) {
    const r = await S.fetchJSON('api/bandh/' + apiPath, { timeout: 15000 });
    if (r.ok) return { data: r.data, status: 'ok', source: 'api' };
    if (r.status === 404 && r.data && r.data.code === 'not_computed') return { data: null, status: 'not_computed', source: 'api' };
    if (r.status === 400 || r.status === 403 || r.status === 503 || r.status === 500) return { data: null, status: 'error', error: r.error, source: 'api' };
    if (staticPath) {
      const s = await S.fetchJSON(staticPath, { timeout: 15000 });
      if (s.ok) return { data: s.data, status: 'ok', source: 'static' };
      if (s.status === 404) return { data: null, status: 'not_computed', source: 'static' };
      return { data: null, status: 'offline', error: s.error, source: 'static' };
    }
    return { data: null, status: r.status === 0 ? 'offline' : 'error', error: r.error, source: 'api' };
  }

  function riskPaths(date) {
    return date ? ['risk?date=' + encodeURIComponent(date), 'data/bandh/risk_' + date + '.json'] : ['risk', 'data/bandh/risk_latest.json'];
  }

  /* ------------------------------------------------------------------ colour and labels */
  function rampColour(v) {
    const i = Math.max(0, Math.min(RAMP.length - 1, Math.floor(v / 20)));
    return RAMP[i];
  }
  function entryFor(id) { return st.riskByStretch[id] || null; }
  function isQA(entry) { return !!entry && (entry.qa_suspicious === true || entry.score_status === 'qa_suspicious'); }
  function colourFor(entry) {
    if (!entry || !isNum(entry.bri)) return GREY;
    if (entry.score_status && entry.score_status !== 'ok') return GREY;
    return rampColour(entry.bri);
  }
  function scoreLabel(entry) {
    if (!st.risk) return 'not computed yet';
    if (!entry) return 'not in ranking';
    if (isQA(entry)) return 'QA check';
    return SCORE_TEXT[entry.score_status] || entry.score_status || 'unknown';
  }
  function briText(entry) {
    if (!st.risk) return F.DASH;
    if (!entry || !isNum(entry.bri)) return F.DASH;
    return F.num(entry.bri, 1);
  }
  function chainageText(p) {
    if (!p || !isNum(p.chainage_start_m)) return F.DASH;
    const a = p.chainage_start_m / 1000, b = isNum(p.chainage_end_m) ? p.chainage_end_m / 1000 : a + 1;
    return F.fixed(a, 1) + '–' + F.fixed(b, 1) + ' km';
  }
  function centroid(feature) {
    const c = feature && feature.geometry && feature.geometry.coordinates;
    if (!c || !c.length) return null;
    const m = c[Math.floor(c.length / 2)];
    return { lat: m[1], lon: m[0] };
  }
  function scoreStatusTag(entry) {
    if (!st.risk) return h('span', { class: 'tag muted', text: 'not computed' });
    if (!entry) return h('span', { class: 'tag muted', text: 'not in ranking' });
    if (isQA(entry)) return h('span', { class: 'tag amber', text: 'QA check' });
    if (entry.score_status === 'ok') return h('span', { class: 'tag water', text: 'scored' });
    return h('span', { class: 'tag muted', text: SCORE_TEXT[entry.score_status] || String(entry.score_status || 'n/a') });
  }

  /* ------------------------------------------------------------------ shell */
  function card(id, title, tag, extraClass) {
    const head = h('div', { class: 'card-head' }, h('h2', { text: title }), tag ? h('span', { class: 'tag muted', text: tag }) : null);
    const body = h('div', { class: 'bandh-body' });
    const box = h('section', { class: 'card bandh-card' + (extraClass ? ' ' + extraClass : ''), id: id, 'aria-labelledby': id + 'Title' }, head, body);
    head.querySelector('h2').id = id + 'Title';
    return { box: box, body: body, tag: head.querySelector('.tag') };
  }

  function buildShell(root) {
    S.clear(root);
    const dateSel = h('select', { id: 'bandhDate', 'aria-label': 'Risk index date' });
    const dateTag = h('span', { class: 'tag muted', id: 'bandhDateTag' });
    root.appendChild(h('header', { class: 'page-head bandh-head' },
      h('div', null,
        h('h1', { class: 'page-title', text: 'Embankment Watch' }),
        h('p', { class: 'page-sub', text: 'Kosi basin embankments ranked by a satellite risk index. It says where to look first; inspection decides.' })),
      h('div', { class: 'bandh-date' }, h('label', { for: 'bandhDate', text: 'Risk date' }), dateSel, dateTag,
        h('a', { class: 'btn primary bandh-patrol-link', href: 'patrol/', text: 'Open the Bandh-Mitra patrol app' }))));
    root.appendChild(h('div', { id: 'bandhAsOf', class: 'bandh-asof', role: 'status', text: 'Loading the risk index…' }));
    root.appendChild(h('div', { class: 'bandh-honest', role: 'note' },
      h('strong', { text: 'Unvalidated risk index. One 2024 event, n = 1.' }),
      h('span', { text: ' The score ranks stretches. It is not a probability of breach and no accuracy has been measured.' })));
    root.appendChild(h('div', { id: 'bandhNotice', class: 'bandh-notice' }));

    const mapTag = h('span', { class: 'tag muted', id: 'bandhMapTag' });
    const tog = (key, label) => {
      st.layers[key] = S.store.get('bandh.' + key) !== '0';
      return h('label', { class: 'ltoggle' },
        h('input', { type: 'checkbox', checked: st.layers[key], dataset: { layer: key }, on: { change: onLayerToggle } }),
        h('span', { text: label }));
    };
    const basemap = h('select', { id: 'bandhBasemap', 'aria-label': 'Basemap', on: { change: onBasemap } },
      h('option', { value: 'plain', text: 'Plain' }), h('option', { value: 'osm', text: 'OpenStreetMap' }));
    const mapCard = card('bandhMapCard', 'Stretches by risk index', null, 'bandh-mapcard');
    mapCard.box.querySelector('.card-head').appendChild(mapTag);
    mapCard.body.appendChild(h('div', { class: 'bandh-toolbar' },
      h('div', { class: 'layer-toggles' }, tog('stretches', 'Stretches'), tog('detections', 'Breach detections, orbit 121'),
        tog('detections85', 'Breach detections, orbit 85'), tog('footprint', 'Simulated footprint')),
      h('label', { class: 'select-inline' }, h('span', { text: 'Basemap' }), basemap)));
    mapCard.body.appendChild(h('div', { id: 'bandhMap', class: 'bandh-map', role: 'region', 'aria-label': 'Embankment stretches map' }));
    mapCard.body.appendChild(h('p', { class: 'fine', text: 'Click a stretch to open its panel. Blue to purple = risk index (0 to 100, unvalidated). Grey = not scored (low coverage, side unknown) or not computed yet. Dashed = flagged for a QA check.' }));

    const tableCard = card('bandhTableCard', 'Ranked stretches', null, 'bandh-tablecard');
    tableCard.box.querySelector('.card-head').appendChild(h('span', { class: 'tag muted', id: 'bandhRankTag' }));
    tableCard.body.appendChild(h('div', { class: 'table-scroll bandh-table' },
      h('table', { class: 'data sortable', id: 'bandhTable' }, h('thead', null), h('tbody', null))));
    tableCard.body.appendChild(h('p', { class: 'fine', id: 'bandhTableNote' }));

    root.appendChild(h('div', { class: 'bandh-main' }, mapCard.box, tableCard.box));

    const grid = h('div', { class: 'bandh-grid' });
    root.appendChild(grid);
    const drill = card('bandhDrill', 'Stretch panel', 'select a stretch');
    const sim = card('bandhSim', 'Breach simulator', 'DEM, 30 m');
    const alert = card('bandhAlert', 'Alert preview', 'dry run only');
    const order = card('bandhOrder', 'Inspection order', 'EN + HI');
    const detect = card('bandhDetect', 'Breach detections, two orbits', 'orbits 121 and 85');
    const backtest = card('bandhBacktest', 'Backtest, 2024 Kosi event', 'n = 1');
    const status = card('bandhStatus', 'Data status', null);
    [drill, sim, alert, order, detect, backtest, status].forEach(function (c) { grid.appendChild(c.box); });
    buildDrillShell(drill.body);
    buildSimShell(sim.body);
    buildAlertShell(alert.body);
    buildOrderShell(order.body);
    buildDetectShell(detect.body);
    buildBacktestShell(backtest.body);
    buildStatusShell(status.body);
  }

  function setTag(id, text) { const el = document.getElementById(id); if (el) el.textContent = text || ''; }

  /* ------------------------------------------------------------------ notices */
  function setNotices() {
    const parts = [];
    if (st.mock) parts.push(S.notice({ kind: 'warn', title: 'Synthetic placeholder data', text: 'Some files on this page are mock placeholders, not results. The file says so in its "mock" flag.' }));
    if (!st.stretches && st.ready) parts.push(S.notice({ kind: 'info', title: 'Stretch layer not built yet', text: 'Run the embankment atlas (python -m sarita.bandh.atlas) and the export, then reload.' }));
    const box = document.getElementById('bandhNotice');
    if (box) S.clear(box).appendChild(h('div', null, parts));
  }

  /* ------------------------------------------------------------------ map */
  function initMap() {
    if (st.map || !window.L) return;
    const map = st.map = L.map('bandhMap', { zoomControl: true, minZoom: 8, maxZoom: 16, preferCanvas: true, attributionControl: true });
    st.lines = L.geoJSON(null, { style: styleStretch, onEachFeature: bindStretch }).addTo(map);
    st.fpLayer = L.geoJSON(null, { style: styleFootprint, interactive: false }).addTo(map);
    st.detLayer = L.layerGroup().addTo(map);
    st.det85Layer = L.layerGroup().addTo(map);
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function () { const d = L.DomUtil.create('div', 'map-legend'); d.id = 'bandhLegend'; return d; };
    legend.addTo(map);
    renderLegend();
    map.on('click', onMapClick);
    map.setView([25.9, 86.4], 9);
    applyBasemap(S.store.get('bandh.basemap') || 'plain');
  }

  function applyBasemap(kind) {
    if (!st.map || !window.L) return;
    if (st.tile) { st.map.removeLayer(st.tile); st.tile = null; }
    document.getElementById('bandhMap').style.background = kind === 'osm' ? '#E9ECE7' : '';
    if (kind === 'osm') {
      st.tile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 16, attribution: '© OpenStreetMap contributors',
      }).addTo(st.map);
      st.tile.bringToBack();
    }
    const sel = document.getElementById('bandhBasemap');
    if (sel) sel.value = kind;
  }
  function onBasemap(e) { S.store.set('bandh.basemap', e.target.value); applyBasemap(e.target.value); }

  function onLayerToggle(e) {
    const key = e.target.dataset.layer;
    st.layers[key] = e.target.checked;
    S.store.set('bandh.' + key, e.target.checked ? '1' : '0');
    applyVisibility();
  }

  /** Adds or removes each layer group so that it matches the toggles. */
  function applyVisibility() {
    if (!st.map) return;
    const groups = { stretches: st.lines, detections: st.detLayer, detections85: st.det85Layer, footprint: st.fpLayer };
    Object.keys(groups).forEach(function (k) {
      const g = groups[k];
      if (!g) return;
      if (st.layers[k] && !st.map.hasLayer(g)) g.addTo(st.map);
      if (!st.layers[k] && st.map.hasLayer(g)) st.map.removeLayer(g);
    });
  }

  function renderLegend() {
    const box = document.getElementById('bandhLegend');
    if (!box) return;
    S.clear(box);
    const ramp = h('div', { class: 'lg-block' }, h('h4', { text: 'Risk index (unvalidated)' }),
      h('div', { class: 'lg-grad', style: { background: 'linear-gradient(90deg,' + RAMP.join(',') + ')' } }),
      h('div', { class: 'lg-ends' }, h('span', { text: '0' }), h('span', { text: '100' })));
    const rows = h('div', { class: 'lg-block' },
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: GREY } }), h('span', { text: 'Not scored / not computed' })),
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: 'transparent', border: '2px dashed #5B6B7A' } }), h('span', { text: 'QA check' })));
    const det = h('div', { class: 'lg-block' }, h('h4', { text: 'Breach detections' }),
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: DETECT_COLOUR, borderRadius: '50%' } }), h('span', { text: 'Orbit 121, 2024 event' })),
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: DETECT85_COLOUR, borderRadius: '50%' } }), h('span', { text: 'Orbit 85, 2024 event (post hoc)' })),
      h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: 'transparent', border: '2px dashed #5B6B7A', borderRadius: '50%' } }), h('span', { text: 'Non-event candidate' })));
    const fp = h('div', { class: 'lg-block' }, h('h4', { text: 'Arrival time (simulated)' }),
      h('div', { class: 'lg-grad', style: { background: 'linear-gradient(90deg,' + BAND_COLOURS.join(',') + ')' } }),
      h('div', { class: 'lg-ends' }, h('span', { text: '0 h' }), h('span', { text: '> 48 h' })));
    S.append(box, [ramp, rows, det, fp]);
  }

  function styleStretch(feature) {
    const entry = entryFor(feature.properties.stretch_id);
    const selected = st.selected === feature.properties.stretch_id;
    return {
      color: colourFor(entry), weight: selected ? 7 : 4, opacity: selected ? 1 : 0.9,
      dashArray: isQA(entry) ? '6 5' : null, lineCap: 'round',
    };
  }
  function styleFootprint(feature) {
    const b = feature.properties && feature.properties.band;
    const c = BAND_COLOURS[Math.max(0, Math.min(BAND_COLOURS.length - 1, isNum(b) ? b : BAND_COLOURS.length - 1))];
    return { color: '#0B1F33', weight: 0.4, fillColor: c, fillOpacity: 0.6, opacity: 0.5 };
  }
  function bindStretch(feature, layer) {
    const id = feature.properties.stretch_id;
    layer.bindTooltip(function () {
      const e = entryFor(id);
      const wrap = h('div', null, h('div', { class: 't-name', text: id }),
        h('div', { text: 'Risk index: ' + (st.risk ? (e && isNum(e.bri) ? F.num(e.bri, 1) : 'not scored') : 'not computed yet') }));
      return wrap;
    }, { sticky: true, className: 'dist-tip' });
    layer.on('click', function () { selectStretch(id, { pan: false }); });
  }

  function drawStretches() {
    if (!st.lines || !st.stretches) return;
    st.lines.clearLayers();
    st.lines.addData(st.stretches);
    if (!st.bounds) {
      const b = st.lines.getBounds();
      if (b && b.isValid()) { st.bounds = b; st.map.fitBounds(b, { padding: [14, 14] }); }
    }
    if (!st.layers.stretches) st.map.removeLayer(st.lines);
    st.lines.setStyle(styleStretch);
  }

  function refreshStyles() {
    if (st.lines) st.lines.setStyle(styleStretch);
    renderLegend();
  }

  /* Detection rows of one orbit, normalised from the GeoJSON features. */
  function detectionRowsFor(orbit) {
    const d = st.detByOrbit[orbit];
    if (!d || !Array.isArray(d.features)) return [];
    return d.features.map(function (f) {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [];
      const pair = Array.isArray(p.pair) ? p.pair : [];
      return {
        orbit: orbit, pair: pair, endDate: pair[1] || '', lon: c[0], lat: c[1],
        isEvent: orbit === '121' ? p.event_match === true : p.on_event_line === true,
        stretch_id: p.stretch_id || null, area_km2: p.area_km2,
        likelyFA: p.status === 'likely_false_alarm',
      };
    });
  }
  function allDetectionRows() {
    return DETECT_ORBITS.reduce(function (acc, o) { return acc.concat(detectionRowsFor(o)); }, [])
      .sort(function (a, b) {
        return (b.isEvent - a.isEvent) || (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0) || (a.orbit < b.orbit ? -1 : 1);
      });
  }
  function dayDiff(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }
  /** "7 days after the breach" for a pair that ends on endDate (breach date 29 Sep 2024). */
  function daysVsBreach(endDate) {
    const n = dayDiff(endDate, BREACH_DATE);
    if (!isNum(n) || isNaN(n)) return 'date unknown';
    if (n === 0) return 'on the breach day';
    return n > 0 ? n + (n === 1 ? ' day' : ' days') + ' after the breach' : (-n) + (n === -1 ? ' day' : ' days') + ' before the breach';
  }
  function pairText(r) { return F.dateShort(r.pair[0]) + ' to ' + F.dateLong(r.pair[1]); }
  function kindText(r) {
    if (r.isEvent) return '2024 Bhubhaul event candidate';
    return r.likelyFA ? 'likely false alarm (river side dry)' : 'non-event candidate (may be real monsoon flooding)';
  }
  function detectionStyle(r) {
    const c = r.orbit === '85' ? DETECT85_COLOUR : DETECT_COLOUR;
    // Orbit 85 event is drawn a little smaller: its point sits 2.35 km from the orbit-121 point.
    return r.isEvent
      ? { radius: r.orbit === '85' ? 6.5 : 9, color: '#0B1F33', weight: 2.5, fillColor: c, fillOpacity: 0.95 }
      : r.likelyFA
        ? { radius: 4, color: '#8A94A0', weight: 1, dashArray: '1 3', fillColor: '#8A94A0', fillOpacity: 0.15 }
        : { radius: 5, color: c, weight: 1.5, dashArray: '2 3', fillColor: c, fillOpacity: 0.3 };
  }
  function detectionTip(r) {
    const post = r.orbit === '85' && r.isEvent ? ' (post-hoc run, not the frozen protocol)' : '';
    return h('div', null,
      h('div', { class: 't-name', text: (r.isEvent ? '2024 Bhubhaul event candidate' : r.likelyFA ? 'Likely false alarm' : 'Non-event candidate') + ', orbit ' + r.orbit + post }),
      h('div', { text: 'Pair ' + pairText(r) + ' (' + daysVsBreach(r.endDate) + ')' }),
      h('div', { text: (r.stretch_id || 'stretch unknown') + (r.isEvent ? '' : r.likelyFA ? ' · river side dry, rule marks it a likely false alarm' : ' · may be real monsoon flooding') }));
  }

  function drawDetections() {
    if (!st.map || !window.L) return;
    DETECT_ORBITS.forEach(function (orbit) {
      const group = orbit === '85' ? st.det85Layer : st.detLayer;
      if (!group) return;
      group.clearLayers();
      detectionRowsFor(orbit).forEach(function (r) {
        if (!isNum(r.lat) || !isNum(r.lon)) return;
        L.circleMarker([r.lat, r.lon], detectionStyle(r))
          .bindTooltip(function () { return detectionTip(r); }, { className: 'dist-tip', sticky: true })
          .on('click', function () { if (r.stretch_id && st.feats[r.stretch_id]) selectStretch(r.stretch_id, { pan: false }); })
          .addTo(group);
      });
    });
    applyVisibility();
  }

  function drawFootprint(fc) {
    if (!st.fpLayer || !st.map) return;
    st.fpLayer.clearLayers();
    if (fc && fc.features) {
      st.fpLayer.addData({ type: 'FeatureCollection', features: fc.features.slice().sort(function (a, b) {
        return (b.properties.band || 0) - (a.properties.band || 0);
      }) });
    }
    if (st.layers.footprint) st.fpLayer.addTo(st.map); else st.map.removeLayer(st.fpLayer);
  }

  function markSelected(id) {
    if (!st.map) return;
    if (st.selMarker) { st.map.removeLayer(st.selMarker); st.selMarker = null; }
    const feat = st.feats[id];
    const c = centroid(feat);
    if (c) st.selMarker = L.circleMarker([c.lat, c.lon], { radius: 9, color: '#0B1F33', weight: 2, fill: false, interactive: false }).addTo(st.map);
  }

  function onMapClick(e) {
    if (!st.simMode) return;
    setSimMode(false);
    runSimulation(e.latlng.lat, e.latlng.lng);
  }

  /* ------------------------------------------------------------------ risk loading and table */
  async function loadRisk(date, preloaded) {
    st.riskState = 'loading';
    renderTable();
    renderAsOf();
    const paths = riskPaths(date);
    const r = preloaded || await getJSON(paths[0], paths[1]);
    st.riskState = r.status;
    st.risk = r.status === 'ok' ? r.data : null;
    st.date = date || riskDateOf(st.risk) || null;
    st.riskByStretch = {};
    if (st.risk && Array.isArray(st.risk.stretches)) {
      st.risk.stretches.forEach(function (s) { st.riskByStretch[s.stretch_id] = s; });
      if (st.risk.mock) st.mock = true;
    }
    refreshStyles();
    syncDateSelect();
    renderTable();
    renderRiskTags();
    if (st.selected) renderDrill(st.selected);
    setNotices();
    renderAlertStretch();
    renderStatus();
  }

  /** The "as of" date of a ranking file: the freeze date (bandh.ranking.v1), else its data date. */
  function riskDateOf(risk) {
    if (!risk) return null;
    if (typeof risk.freeze === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(risk.freeze)) return risk.freeze;
    const dd = Array.isArray(risk.data_dates) ? risk.data_dates : [];
    return dd.length ? dd[dd.length - 1] : null;
  }

  /** Prominent "as of" line. Names the breach only for the 27 Sep 2024 freeze, the one the event is about. */
  function renderAsOf() {
    const box = document.getElementById('bandhAsOf');
    if (!box) return;
    S.clear(box);
    if (!st.risk) {
      box.appendChild(h('span', { text: st.riskState === 'loading' ? 'Loading the risk index…' : 'Risk index not computed yet.' }));
      return;
    }
    const d = st.date;
    const days = d ? F.daysBetween(d, BREACH_DATE) : null;
    const text = d === PRE_BREACH_FREEZE && days !== null
      ? 'as of ' + F.dateLong(d) + ', ' + days + ' days before the Bhubhaul breach'
      : 'as of ' + F.dateLong(d || '') + (d ? '' : ' (date not in the file)');
    box.appendChild(h('strong', { text: 'Risk index ' + text + '.' }));
    box.appendChild(h('span', { class: 'fine', text: ' Computed from radar up to that date only. Each date is a separate file.' }));
  }

  function renderRiskTags() {
    const d = st.date;
    renderAsOf();
    setTag('bandhDateTag', st.risk ? (st.risk.validation_status || 'unvalidated') + ' · ' + (st.risk.method_version || 'index') : (st.riskState === 'loading' ? 'loading' : 'not computed yet'));
    setTag('bandhMapTag', st.risk ? F.dateLong(d) || 'latest' : 'not computed yet');
    setTag('bandhRankTag', st.risk ? (st.risk.stretches || []).length + ' stretches' : 'not computed yet');
  }

  function rankedRows() {
    if (!st.risk || !Array.isArray(st.risk.stretches)) return [];
    const key = st.sortKey, dir = st.sortDir;
    const val = function (s) {
      if (key === 'rank') return isNum(s.rank) ? s.rank : Infinity;
      if (key === 'bri') return isNum(s.bri) ? s.bri : -Infinity;
      if (key === 'coverage') return isNum(s.coverage) ? s.coverage : -Infinity;
      return s.stretch_id;
    };
    return st.risk.stretches.slice().sort(function (a, b) {
      const va = val(a), vb = val(b);
      let cmp = 0;
      if (typeof va === 'string') cmp = va.localeCompare(vb);
      else if (va < vb) cmp = -1;
      else if (va > vb) cmp = 1;
      if (cmp === 0) return String(a.stretch_id).localeCompare(String(b.stretch_id));
      return cmp * dir;
    });
  }

  function renderTable() {
    const table = document.getElementById('bandhTable');
    const note = document.getElementById('bandhTableNote');
    if (!table) return;
    const head = table.tHead || table.createTHead();
    const body = table.tBodies[0] || table.createTBody();
    S.clear(head); S.clear(body);
    const cols = [['rank', '#', ''], ['stretch', 'Stretch', 'left'], ['bri', 'Index', ''], ['coverage', 'Coverage', ''], ['status', 'Status', 'left']];
    const tr = h('tr', null);
    cols.forEach(function (c) {
      const sortable = c[0] !== 'status';
      const sorted = sortable && st.sortKey === c[0];
      const th = h('th', { class: c[2] + (sorted ? ' sorted' + (st.sortDir > 0 ? ' asc' : '') : ''), tabindex: sortable ? '0' : null,
        text: c[1], 'aria-sort': sorted ? (st.sortDir > 0 ? 'ascending' : 'descending') : null });
      if (sortable) {
        th.addEventListener('click', function () { setSort(c[0]); });
        th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort(c[0]); } });
      }
      tr.appendChild(th);
    });
    head.appendChild(tr);
    if (st.riskState === 'loading') {
      body.appendChild(h('tr', null, h('td', { colspan: 5, class: 'empty', text: 'Loading the risk index…' })));
      if (note) note.textContent = '';
      return;
    }
    if (!st.risk) {
      body.appendChild(h('tr', null, h('td', { colspan: 5, class: 'empty', text: 'Risk index not computed yet. Stretches stay grey until it is.' })));
      if (note) note.textContent = 'The table fills when the risk index is computed (python -m sarita.bandh.risk).';
      return;
    }
    const rows = rankedRows();
    rows.forEach(function (s) {
      const row = h('tr', { class: 'clickable' + (st.selected === s.stretch_id ? ' sel' : ''), tabindex: '0', 'data-id': s.stretch_id });
      row.appendChild(h('td', { text: isNum(s.rank) ? String(s.rank) : F.DASH }));
      row.appendChild(h('td', { class: 'left', text: s.stretch_id }));
      row.appendChild(h('td', { text: briText(s), style: { color: isNum(s.bri) && (!s.score_status || s.score_status === 'ok') ? '#0B1F33' : '#5B6B7A', fontWeight: 700 } }));
      row.appendChild(h('td', { text: isNum(s.coverage) ? F.pct(s.coverage * 100, 0) : F.DASH }));
      row.appendChild(h('td', { class: 'left' }, scoreStatusTag(s)));
      row.addEventListener('click', function () { selectStretch(s.stretch_id, { pan: true }); });
      row.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); selectStretch(s.stretch_id, { pan: true }); } });
      body.appendChild(row);
    });
    if (!rows.length) body.appendChild(h('tr', null, h('td', { colspan: 5, class: 'empty', text: 'The risk file has no stretches.' })));
    if (note) note.textContent = 'Index = 0 to 100 from the features in the risk file (unvalidated). Coverage = share of the landside and toe pixels with valid radar. Rank is by the index.';
  }

  function setSort(key) {
    if (st.sortKey === key) st.sortDir = -st.sortDir;
    else { st.sortKey = key; st.sortDir = key === 'bri' || key === 'coverage' ? -1 : 1; }
    renderTable();
  }

  /* ------------------------------------------------------------------ drill-down */
  function buildDrillShell(body) {
    body.appendChild(h('div', { id: 'drillEmpty', class: 'empty', text: 'Click a stretch on the map or in the table.' }));
    body.appendChild(h('div', { id: 'drillBody', hidden: true },
      h('h3', { id: 'drillName', class: 'drill-name' }),
      h('p', { id: 'drillSub', class: 'fine' }),
      h('div', { id: 'drillKV', class: 'kv' }),
      h('div', { class: 'drill-sec' }, h('h3', { text: 'Features' }), h('div', { id: 'drillFeatures', class: 'table-scroll' })),
      h('div', { class: 'drill-sec' }, h('h3', { text: 'Feature time series' }),
        h('div', { id: 'drillSeriesNote', class: 'fine' }),
        h('div', { class: 'chart-box', style: { height: '190px' }, id: 'drillDbBox' }, h('canvas', { id: 'bandhSeriesDb', 'aria-label': 'Radar backscatter over time' })),
        h('div', { class: 'chart-box', style: { height: '170px', marginTop: '10px' }, id: 'drillWaterBox' }, h('canvas', { id: 'bandhSeriesWater', 'aria-label': 'Water distance and rainfall over time' }))),
      h('div', { class: 'drill-sec' }, h('h3', { text: 'Patrol reports here' }),
        h('p', { class: 'fine', text: 'Patrollers report seepage, sand boils, cracks and erosion with a photo and GPS, offline if needed. Their reports are checked by a person.' }),
        h('p', { class: 'fine' }, h('a', { href: 'patrol/', text: 'Open the Bandh-Mitra patrol app' })),
        h('div', { id: 'drillPatrol' }))));
  }

  function renderDrill(id) {
    const feat = st.feats[id];
    const empty = document.getElementById('drillEmpty');
    const bodyEl = document.getElementById('drillBody');
    if (!feat) { empty.hidden = false; bodyEl.hidden = true; return; }
    empty.hidden = true; bodyEl.hidden = false;
    const p = feat.properties || {};
    const entry = entryFor(id);
    document.getElementById('drillName').textContent = id;
    document.getElementById('drillSub').textContent = (p.river || 'river unknown') + ' · ' + (p.embankment_id || '') + ' · ' + (p.side_protected || 'side unknown') + ' side protected';
    const kv = document.getElementById('drillKV');
    S.clear(kv);
    const pairs = [
      ['Chainage', chainageText(p)],
      ['Length', isNum(p.length_m) ? F.num(p.length_m, 0) + ' m' : F.DASH],
      ['Crest, mean / lowest', isNum(p.crest_mean_m) ? F.fixed(p.crest_mean_m, 1) + ' / ' + F.fixed(p.crest_min_m, 1) + ' m' : F.DASH],
      ['Crest height above ground', isNum(p.tophat_height_m) ? F.fixed(p.tophat_height_m, 1) + ' m' : F.DASH],
      ['Geometry status', p.geometry_status || F.DASH],
      ['Index (unvalidated)', st.risk ? briText(entry) + (entry && isNum(entry.bri) ? ' of 100' : '') : 'not computed yet'],
      ['Coverage', entry && isNum(entry.coverage) ? F.pct(entry.coverage * 100, 0) : F.DASH],
      ['Status', scoreLabel(entry)],
      ['Rank', entry && isNum(entry.rank) ? '#' + entry.rank : F.DASH],
    ];
    pairs.forEach(function (pr) { kv.appendChild(h('span', { class: 'k', text: pr[0] })); kv.appendChild(h('span', { class: 'v', text: pr[1] })); });

    const fWrap = document.getElementById('drillFeatures');
    S.clear(fWrap);
    if (!st.risk) {
      fWrap.appendChild(h('div', { class: 'fine', text: 'Feature values appear once the risk index is computed.' }));
    } else if (!entry) {
      fWrap.appendChild(h('div', { class: 'fine', text: 'This stretch is not in the selected risk file.' }));
    } else {
      const feats = entry.features || {};
      const tbl = h('table', { class: 'data compact' }, h('thead', null, h('tr', null, h('th', { text: 'Feature' }), h('th', { text: 'Value' }), h('th', { text: 'Status' }), h('th', { text: 'Pixels' }))));
      const tb = h('tbody', null);
      Object.keys(feats).sort().forEach(function (k) {
        const f = feats[k] || {};
        const status = f.status === 'not_computed' ? 'not computed' : f.status === 'no_baseline' ? 'no baseline' : (f.status || 'n/a');
        tb.appendChild(h('tr', null,
          h('td', { text: k + ' · ' + (FEATURE_NAMES[k] || '') }),
          h('td', { text: isNum(f.value) ? F.fixed(f.value, 2) : F.DASH }),
          h('td', { text: status }),
          h('td', { text: isNum(f.n_px) ? F.num(f.n_px) : F.DASH })));
      });
      if (!Object.keys(feats).length) tb.appendChild(h('tr', null, h('td', { colspan: 4, class: 'empty', text: 'No feature values in the file.' })));
      tbl.appendChild(tb);
      fWrap.appendChild(tbl);
      if (Array.isArray(entry.reasons) && entry.reasons.length) {
        fWrap.appendChild(h('ul', { class: 'bandh-reasons' }, entry.reasons.map(function (r) { return h('li', { text: String(r) }); })));
      }
      if (entry.exposure && typeof entry.exposure === 'object') {
        const ex = entry.exposure;
        fWrap.appendChild(h('div', { class: 'fine', text: 'Exposure: ' + (isNum(ex.population_2020) ? F.num(ex.population_2020) + ' people (WorldPop 2020) in the footprint, ' : '') + (isNum(ex.villages) ? ex.villages + ' villages, ' : '') + (ex.status || 'no footprint') + '.' }));
      }
    }
    drawSeries(id);
    loadPatrol(id);
  }

  async function selectStretch(id, opts) {
    st.selected = id;
    if (st.map) { refreshStyles(); markSelected(id); }
    renderTable();
    renderDrill(id);
    renderAlertStretch();
    if (opts && opts.pan && st.map) {
      const c = centroid(st.feats[id]);
      if (c) st.map.panTo([c.lat, c.lon], { animate: true });
    }
  }

  async function drawSeries(id) {
    const token = ++st.drillToken;
    const note = document.getElementById('drillSeriesNote');
    note.textContent = 'Loading the time series…';
    let series = null;
    const r = await S.fetchJSON('api/bandh/stretch/' + encodeURIComponent(id), { timeout: 15000 });
    if (r.ok && r.data) series = r.data.series || null;
    else if (!(r.data && r.data.code)) {
      // API unreachable, or a plain static server answered: use the static series file if it exists
      const s = await S.fetchJSON('data/bandh/series/' + encodeURIComponent(id) + '.json', { timeout: 15000 });
      if (s.ok && s.data) series = s.data;
    }
    if (token !== st.drillToken) return;
    if (!series || !Array.isArray(series.dates) || !series.dates.length) {
      note.textContent = 'Time series not computed yet for this stretch (the per-stretch radar statistics are written by the series job).';
      S.chart('bandhSeriesDb', null); S.chart('bandhSeriesWater', null);
      return;
    }
    note.textContent = 'Mean radar backscatter inside the landside buffer, and the distance of new water to the river toe. ' +
      'Orbit 121 (solid, circles) and orbit 85 (dashed, triangles) are separate lines: compare dates within one orbit only.';
    drawSeriesCharts(series);
  }

  /* Series: one line per Sentinel-1 orbit (design A7). Labels are the union of all dates, so a calendar date that
     occurs in both orbits sits on one tick with one point per orbit; a repeated date inside one orbit is averaged. */
  const ORBIT_STYLE = { '121': { dash: [], point: 'circle' }, '85': { dash: [6, 4], point: 'triangle' }, unknown: { dash: [2, 3], point: 'rectRot' } };
  function orbitKeys(keys) {
    const rank = function (k) { return k === '121' ? 0 : k === '85' ? 1 : 2; };
    return keys.slice().sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); });
  }
  /** {orbit: {date: mean value}} for one array aligned with series.dates. */
  function seriesByOrbit(series, values) {
    const out = {};
    if (!Array.isArray(values)) return out;
    series.dates.forEach(function (d, i) {
      const v = values[i];
      if (!isNum(v)) return;
      const o = Array.isArray(series.orbit) && isNum(series.orbit[i]) ? String(series.orbit[i]) : 'unknown';
      const cell = (out[o] = out[o] || {});
      const c = (cell[d] = cell[d] || { sum: 0, n: 0 });
      c.sum += v; c.n += 1;
    });
    return out;
  }
  function meanOf(c) { return c ? Math.round((c.sum / c.n) * 100) / 100 : null; }
  function orbitDatasets(series, values, label, colour, labels, showLine) {
    const per = seriesByOrbit(series, values);
    return orbitKeys(Object.keys(per)).map(function (o) {
      const sty = ORBIT_STYLE[o] || ORBIT_STYLE.unknown;
      return {
        label: label + ', orbit ' + (o === 'unknown' ? 'not recorded' : o),
        data: labels.map(function (d) { return meanOf(per[o][d]); }),
        borderColor: colour, backgroundColor: colour, borderDash: sty.dash, pointStyle: sty.point,
        pointRadius: 3.5, pointHoverRadius: 5, borderWidth: 2, tension: 0.2, spanGaps: true, showLine: showLine,
      };
    });
  }
  function drawSeriesCharts(series) {
    const dates = Array.from(new Set(series.dates)).sort();
    const labels = dates.map(F.dateLong);
    const xTicks = { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 };
    const dbSets = orbitDatasets(series, series.vv_mean_db, 'VV (dB)', C.water, dates, true)
      .concat(orbitDatasets(series, series.vh_mean_db, 'VH (dB)', C.teal, dates, true));
    S.chart('bandhSeriesDb', { type: 'line', data: { labels: labels, datasets: dbSets },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } },
        scales: { x: { ticks: xTicks }, y: { title: { display: true, text: 'dB' } } } } });
    const wSets = orbitDatasets(series, series.water_dist_m, 'New water to toe (m)', C.water, dates, false);
    const hasRain = Array.isArray(series.rain7_mm) && series.rain7_mm.some(isNum);
    if (hasRain) {
      const rainBy = {};
      series.dates.forEach(function (d, i) { if (isNum(series.rain7_mm[i])) { const c = (rainBy[d] = rainBy[d] || { sum: 0, n: 0 }); c.sum += series.rain7_mm[i]; c.n += 1; } });
      wSets.push({ type: 'line', label: '7-day rain (mm), all orbits', data: dates.map(function (d) { return meanOf(rainBy[d]); }),
        borderColor: C.amber, backgroundColor: C.amber, pointRadius: 2.5, borderWidth: 1.5, spanGaps: true, tension: 0.2, yAxisID: 'y1' });
    }
    const wScales = { x: { ticks: xTicks }, y: { position: 'left', title: { display: true, text: 'm' } } };
    if (hasRain) wScales.y1 = { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'mm' } };
    S.chart('bandhSeriesWater', { type: 'line', data: { labels: labels, datasets: wSets },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: wScales } });
  }

  async function loadPatrol(id) {
    const token = st.drillToken;
    const box = document.getElementById('drillPatrol');
    S.clear(box);
    box.appendChild(h('div', { class: 'fine', text: 'Loading patrol reports…' }));
    const r = await S.fetchJSON('api/bandh/patrol/reports?stretch_id=' + encodeURIComponent(id) + '&limit=20', { timeout: 10000 });
    if (token !== st.drillToken) return;
    S.clear(box);
    if (!r.ok) {
      box.appendChild(h('div', { class: 'fine', text: S.api && S.api.isOffline(r) ? 'Patrol reports need the SARITA API (start it to see field reports).' : 'Patrol reports could not be loaded: ' + (r.error || 'unknown error') }));
      return;
    }
    const rows = (r.data && r.data.reports) || [];
    if (!rows.length) {
      box.appendChild(h('div', { class: 'fine', text: 'No patrol reports for this stretch yet.' }));
    } else {
      rows.slice().reverse().forEach(function (rep) {
        box.appendChild(h('div', { class: 'patrol-item' },
          h('div', { class: 'patrol-head' },
            h('strong', { text: String(rep.report_type || '').replace(/_/g, ' ') }),
            h('span', { class: 'tag muted', text: 'severity ' + (rep.severity || '-') }),
            h('span', { class: 'fine', text: rep.received_at ? String(rep.received_at).slice(0, 16).replace('T', ' ') + ' UTC' : '' })),
          rep.note ? h('div', { class: 'patrol-note', text: String(rep.note) }) : null,
          /^[0-9a-f]{32}\.(jpg|png|webp)$/.test(rep.photo || '') ? h('img', { class: 'patrol-photo', src: 'api/bandh/patrol/photos/' + rep.photo, alt: 'Patrol photo', loading: 'lazy' }) : null));
      });
    }
    if (r.data && r.data.disclaimer) box.appendChild(h('p', { class: 'fine', text: r.data.disclaimer }));
  }

  /* ------------------------------------------------------------------ simulator */
  function buildSimShell(body) {
    const width = h('input', { type: 'number', id: 'simWidth', min: '10', max: '1000', step: '10', value: '150', 'aria-label': 'Breach width in metres' });
    const hours = h('input', { type: 'number', id: 'simHours', min: '1', max: '72', step: '1', value: '24', 'aria-label': 'Duration in hours' });
    const level = h('input', { type: 'number', id: 'simLevel', min: '0', max: '200', step: '0.1', placeholder: 'crest − 0.5 m', 'aria-label': 'River level in metres, optional' });
    body.appendChild(h('p', { class: 'fine', text: 'Pick a point on the map (or use the selected stretch). The footprint floods the land behind the breach, limited by the volume the breach can pass in the chosen time. A model estimate on a 30 m surface, not a forecast.' }));
    body.appendChild(h('div', { class: 'bandh-form' },
      h('label', null, h('span', { text: 'Width (m)' }), width),
      h('label', null, h('span', { text: 'Hours' }), hours),
      h('label', null, h('span', { text: 'River level (m, optional)' }), level)));
    body.appendChild(h('div', { class: 'bandh-actions' },
      h('button', { type: 'button', class: 'btn primary', id: 'simPick', 'aria-pressed': 'false', text: 'Simulate breach here', on: { click: function () { setSimMode(!st.simMode); } } }),
      h('button', { type: 'button', class: 'btn', id: 'simStretch', text: 'Use selected stretch', on: { click: simSelected } })));
    body.appendChild(h('div', { id: 'simMsg' }));
    body.appendChild(h('div', { id: 'simOut', hidden: true }));
  }

  function setSimMode(on) {
    st.simMode = !!on;
    const b = document.getElementById('simPick');
    if (b) { b.setAttribute('aria-pressed', st.simMode ? 'true' : 'false'); b.textContent = st.simMode ? 'Click the map…' : 'Simulate breach here'; }
    if (st.map) st.map.getContainer().style.cursor = st.simMode ? 'crosshair' : '';
    if (st.simMode) S.msg(document.getElementById('simMsg'), 'info', 'Click the map where the embankment breaks.');
    else if (document.getElementById('simMsg') && !st.sim) S.msg(document.getElementById('simMsg'), null, null);
  }

  function simSelected() {
    const c = st.selected && centroid(st.feats[st.selected]);
    if (!c) { S.msg(document.getElementById('simMsg'), 'warn', 'Select a stretch first, or click the map.'); return; }
    runSimulation(c.lat, c.lon);
  }

  function simParams() {
    const num = function (id) { const v = document.getElementById(id).value; return v === '' ? null : Number(v); };
    const width = num('simWidth'), hours = num('simHours'), level = num('simLevel');
    return { width_m: width, hours: hours, level_m: level };
  }

  function simError(r) {
    if (S.api.isOffline(r)) return 'The breach simulator needs the SARITA API. Start it from the project folder.';
    const code = r.data && r.data.code;
    if (code === 'dem_missing') return 'The terrain model (DEM) is not built yet. Run `.venv/bin/python -m sarita.bandh.dem` once, then try again.';
    if (code === 'busy') return 'Another simulation is running. Try again in a minute.';
    if (code === 'simulation_timeout') return 'The simulation took too long and was stopped. Try a smaller duration.';
    return r.error || 'The simulation failed.';
  }

  async function runSimulation(lat, lon) {
    const msg = document.getElementById('simMsg');
    const p = simParams();
    const body = { lon: lon, lat: lat, with_exposure: true };
    if (isNum(p.width_m)) body.width_m = p.width_m;
    if (isNum(p.hours)) body.hours = p.hours;
    if (isNum(p.level_m)) body.level_m = p.level_m;
    S.msg(msg, 'info', 'Simulating at ' + F.fixed(lat, 4) + ', ' + F.fixed(lon, 4) + '… (up to a minute on first use)');
    if (st.map) {
      if (st.simMarker) st.map.removeLayer(st.simMarker);
      st.simMarker = L.circleMarker([lat, lon], { radius: 6, color: '#0B1F33', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(st.map);
    }
    const r = await S.fetchJSON('api/bandh/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 150000,
    });
    if (!r.ok) {
      S.msg(msg, r.status === 503 || r.status === 0 ? 'warn' : 'error', simError(r));
      document.getElementById('simOut').hidden = true;
      return;
    }
    S.msg(msg, 'ok', r.data.cached ? 'Result from the last identical run.' : 'Done. The footprint is on the map.');
    st.sim = r.data;
    st.lastVillages = (r.data.villages || []).map(function (v) { return typeof v === 'string' ? v : (v.name || v.place || ''); }).filter(Boolean);
    drawFootprint(r.data.footprint);
    renderSim(r.data);
    renderAlertStretch();
  }

  function renderSim(res) {
    const out = document.getElementById('simOut');
    S.clear(out);
    out.hidden = false;
    const s = res.stats || {};
    const kpi = function (label, value, unit, cls) {
      return h('div', { class: 'kpi ' + (cls || '') }, h('div', { class: 'k-label', text: label }),
        h('div', { class: 'k-value' }, value, unit ? h('span', { class: 'k-unit', text: unit }) : null));
    };
    out.appendChild(h('div', { class: 'kpis' },
      kpi('Flooded area', F.km2(s.area_km2), 'km²', 'water'),
      kpi('Deepest', F.fixed(s.max_depth_m, 1), 'm', 'flood'),
      kpi('Water passed', isNum(s.volume_used_m3) ? F.lakh(s.volume_used_m3, 'en') : F.DASH, 'm³', ''),
      kpi('Stage used', F.fixed(s.stage_m, 2), 'm asl', 'muted')));
    const pop = res.population && isNum(res.population.population_2020) ? F.num(res.population.population_2020) : null;
    const pairs = [
      ['Discharge (weir law)', isNum(s.discharge_m3s) ? F.num(s.discharge_m3s, 0) + ' m³/s' : F.DASH],
      ['Volume cap', isNum(s.volume_cap_m3) ? F.lakh(s.volume_cap_m3, 'en') + ' m³' + (s.volume_capped ? ' (reached)' : '') : F.DASH],
      ['Farthest reach', isNum(s.max_reach_km) ? F.fixed(s.max_reach_km, 1) + ' km' : F.DASH],
      ['People, 2020 model', pop ? pop + ' (WorldPop 2020, not a census)' : 'not computed'],
      ['Villages in footprint', String((res.villages || []).length)],
    ];
    const kv = h('div', { class: 'kv' });
    pairs.forEach(function (pr) { kv.appendChild(h('span', { class: 'k', text: pr[0] })); kv.appendChild(h('span', { class: 'v', text: pr[1] })); });
    out.appendChild(kv);
    if (s.bands) {
      const tb = h('tbody', null);
      Object.keys(s.bands).forEach(function (lab, i) {
        tb.appendChild(h('tr', null, h('td', { class: 'left' }, h('span', { class: 'lg-sw bandh-sw', style: { background: BAND_COLOURS[i] || BAND_COLOURS[4] } }), ' ' + lab),
          h('td', { text: F.km2(s.bands[lab].area_km2) + ' km²' })));
      });
      out.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
        h('thead', null, h('tr', null, h('th', { class: 'left', text: 'Arrival after breach' }), h('th', { text: 'Area' }))), tb)));
    }
    if (res.villages && res.villages.length) {
      out.appendChild(h('div', { class: 'fine' }, h('strong', { text: 'Villages: ' }),
        res.villages.map(function (v) { return typeof v === 'string' ? v : (v.name || v.place || '(unnamed)'); }).join(', ')));
    }
    const sp = res.safe_places || {};
    const towns = (sp.towns || []).map(function (t) { return t.name; }).filter(Boolean);
    const hg = sp.high_ground;
    out.appendChild(h('div', { class: 'fine' }, h('strong', { text: 'Higher ground nearby: ' }),
      hg ? (F.fixed(hg.elevation_m, 1) + ' m, ' + F.num(hg.distance_to_footprint_m) + ' m from the edge') : 'none found on the DEM',
      towns.length ? h('span', null, ' · Towns within 3 km: ' + towns.join(', ')) : null));
    if (s.touches_window_edge) out.appendChild(S.notice({ kind: 'warn', title: 'Footprint reaches the edge of the terrain window', text: 'The flood may continue beyond what is shown. Treat the numbers as a lower bound.' }));
    const limits = (s.limits || []);
    if (limits.length) {
      out.appendChild(h('div', { class: 'fine' }, h('strong', { text: 'Limits of this run' }),
        h('ul', { class: 'bandh-reasons' }, limits.map(function (l) { return h('li', { text: String(l) }); }))));
    }
    out.appendChild(h('p', { class: 'fine', text: 'Stage source: ' + (res.stage_source || s.stage_source || (res.request && res.request.level_m != null ? 'operator input' : 'crest minus 0.5 m')) + '. Terrain: ' + (res.dem || 'Copernicus GLO-30 DSM') + '. Not validated against an observed flood extent in this view.' }));
  }

  /* ------------------------------------------------------------------ alerts */
  let alertLang = 'en';
  /* Every preview request takes a new token. A response renders only if its token is still the latest, so the
     tab clicked last wins even when an earlier request (another language) answers after it. */
  let alertToken = 0, alertDone = 0;   // alertDone = token of the last answer that was rendered or failed

  function buildAlertShell(body) {
    const kind = h('select', { id: 'alKind', 'aria-label': 'Message type', on: { change: renderAudioNote } },
      Object.keys(KIND_LABEL).map(function (k) { return h('option', { value: k, text: KIND_LABEL[k] }); }));
    const chan = h('select', { id: 'alChannel', 'aria-label': 'Channel' },
      Object.keys(CHANNEL_LABEL).map(function (k) { return h('option', { value: k, text: CHANNEL_LABEL[k] }); }));
    const tabs = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Language' },
      ['en', 'hi', 'mai'].map(function (l) {
        return h('button', { type: 'button', class: 'seg-btn' + (l === alertLang ? ' active' : ''), 'data-lang': l, lang: l === 'en' ? 'en' : 'hi',
          'aria-pressed': l === alertLang ? 'true' : 'false', text: l === 'en' ? 'English' : l === 'hi' ? 'हिन्दी' : 'मैथिली',
          on: { click: function () { setAlertLang(l); } } });
      }));
    const villages = h('input', { type: 'text', id: 'alVillages', placeholder: 'Bhubhaul, Sonbarsa', 'aria-label': 'Villages, comma separated' });
    const safe = h('input', { type: 'text', id: 'alSafe', placeholder: 'Ucch vidyalaya', 'aria-label': 'Safe place' });
    const hrs = h('input', { type: 'number', id: 'alHours', min: '0', step: '1', placeholder: '6', 'aria-label': 'Hours until water arrives' });
    const date = h('input', { type: 'date', id: 'alDate', 'aria-label': 'Message date' });
    body.appendChild(h('p', { class: 'fine', text: 'Text is filled from fixed templates. Nothing is sent: this page has no live channel in v1. Maithili text is a draft and is not for use until a named reviewer signs it.' }));
    body.appendChild(h('div', { class: 'bandh-form' },
      h('label', null, h('span', { text: 'Message' }), kind),
      h('label', null, h('span', { text: 'Channel' }), chan),
      h('label', null, h('span', { text: 'Date' }), date),
      h('label', null, h('span', { text: 'Hours to arrival' }), hrs),
      h('label', { class: 'bandh-wide' }, h('span', { text: 'Villages' }), villages),
      h('label', { class: 'bandh-wide' }, h('span', { text: 'Safe place' }), safe)));
    body.appendChild(h('div', { class: 'bandh-actions' }, tabs,
      h('button', { type: 'button', class: 'btn primary', id: 'alGo', text: 'Build preview', on: { click: buildPreview } }),
      h('button', { type: 'button', class: 'btn', id: 'alAudio', text: 'Play sample voice', on: { click: playSample } })));
    body.appendChild(h('div', { id: 'alStretch', class: 'fine' }));
    body.appendChild(h('div', { id: 'alMsg' }));
    body.appendChild(h('div', { id: 'alOut', hidden: true },
      h('div', { class: 'alert-meta', id: 'alMeta' }),
      h('pre', { class: 'alert-text', id: 'alText' }),
      h('div', { class: 'fine', id: 'alStatus' })));
    body.appendChild(h('p', { class: 'fine', id: 'alAudioNote' }));
    renderAlertStretch();
  }

  function alertStretchId() {
    if (st.selected) return st.selected;
    const top = st.risk && rankedRows()[0];
    return top ? top.stretch_id : null;
  }

  function renderAlertStretch() {
    const box = document.getElementById('alStretch');
    if (!box) return;
    const id = alertStretchId();
    const date = document.getElementById('alDate');
    if (date && !date.value) date.value = st.date || new Date().toISOString().slice(0, 10);
    const vill = document.getElementById('alVillages');
    if (vill && !vill.value && st.lastVillages.length) vill.value = st.lastVillages.join(', ');
    box.textContent = id ? 'For stretch ' + id + (st.selected ? '' : ' (top ranked)') + '.' : 'Select a stretch or load the risk index first.';
    renderAudioNote();
  }

  function setAlertLang(l) {
    alertLang = l;
    S.$$('#bandhAlert .seg-btn').forEach(function (b) {
      const on = b.dataset.lang === l;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderAudioNote();
    // The API returns only the language asked for, so a tab switch after a preview needs a new request.
    // Also re-request when one is still in flight: its answer is for the previous tab and must not win.
    if ((st.lastAlert && st.lastAlert.lang !== l) || alertToken > alertDone) buildPreview();
  }

  function audioFile() {
    const kind = document.getElementById('alKind').value;
    if (!(kind === 'warning' || kind === 'breach') || !(alertLang === 'hi' || alertLang === 'mai')) return null;
    return kind + '_' + alertLang + '.m4a';
  }

  function renderAudioNote() {
    const note = document.getElementById('alAudioNote');
    const btn = document.getElementById('alAudio');
    if (!note || !btn) return;
    const f = audioFile();
    const available = !!(st.manifest && st.manifest.layers && st.manifest.layers.audio && (st.manifest.layers.audio.files || []).indexOf(f) >= 0);
    btn.disabled = !f || !available;
    if (!f) note.textContent = 'Sample voice exists for warning and breach messages in Hindi and Maithili.';
    else if (!available) note.textContent = 'No sample voice file for this message yet.';
    else note.textContent = 'Sample voice (DEMO message, macOS voice "Lekha", converted to m4a). No human has checked this audio.';
  }

  function playSample() {
    const f = audioFile();
    if (!f) return;
    const a = new Audio('data/bandh/audio/' + f);
    a.play().catch(function () { S.msg(document.getElementById('alMsg'), 'warn', 'The browser would not play the sample audio.'); });
  }

  function alertBody() {
    const id = alertStretchId();
    const date = document.getElementById('alDate').value;
    const body = {
      kind: document.getElementById('alKind').value,
      lang: alertLang,
      channel: document.getElementById('alChannel').value,
      stretch_id: id,
      date: date,
      dry_run: true,
    };
    const vill = document.getElementById('alVillages').value.split(',').map(function (v) { return v.trim(); }).filter(Boolean);
    if (vill.length) body.villages = vill;
    const safe = document.getElementById('alSafe').value.trim();
    if (safe) body.safe_place = safe;
    const hrs = document.getElementById('alHours').value;
    if (hrs !== '') body.arrival_hours = Number(hrs);
    return body;
  }

  async function buildPreview() {
    const msg = document.getElementById('alMsg');
    const token = ++alertToken;
    const current = function () { return token === alertToken; };
    S.msg(msg, null, null);
    const id = alertStretchId();
    if (!id) { S.msg(msg, 'warn', 'Pick a stretch first (click one on the map or in the table).'); return; }
    if (!document.getElementById('alDate').value) { S.msg(msg, 'warn', 'Enter a date.'); return; }
    const body = alertBody();
    const r = await S.fetchJSON('api/bandh/alert/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 15000,
    });
    if (!current()) return;   // a newer tab or button click has started; this answer is stale
    if (!r.ok) {
      if (S.api.isOffline(r)) {
        const fallback = await sampleFallback(body, current);
        if (fallback || !current()) return;
      }
      alertDone = token;
      const missing = r.data && Array.isArray(r.data.missing) && r.data.missing.length ? ' Missing: ' + r.data.missing.join(', ') + '.' : '';
      S.msg(msg, r.status === 403 ? 'error' : 'warn', (S.api.isOffline(r) ? 'The alert preview needs the SARITA API.' : (r.error || 'The preview failed.')) + missing);
      document.getElementById('alOut').hidden = true;
      return;
    }
    alertDone = token;
    st.lastAlert = { record: r.data, kind: body.kind, channel: body.channel, lang: body.lang, live: false };
    renderAlertText(st.lastAlert);
  }

  /** Offline: show the reviewed DEMO sample text for this kind and language, labelled as such. */
  async function sampleFallback(body, current) {
    const r = await S.fetchJSON('data/bandh/alerts_samples.json', { timeout: 8000 });
    if (!current()) return true;   // stale: let the caller stop without rendering anything
    if (!r.ok || !r.data || !Array.isArray(r.data.samples)) return false;
    const hit = r.data.samples.find(function (x) { return x.type === body.kind && x.lang === body.lang; });
    if (!hit) return false;
    const channel = hit[body.channel] || hit.sms || {};
    alertDone = alertToken;
    st.lastAlert = { record: null, sample: hit, text: channel.text || '', kind: body.kind, channel: body.channel, lang: body.lang, live: false };
    renderAlertText(st.lastAlert);
    return true;
  }

  function renderAlertText(a) {
    const out = document.getElementById('alOut');
    out.hidden = false;
    const meta = document.getElementById('alMeta');
    const text = document.getElementById('alText');
    const status = document.getElementById('alStatus');
    S.clear(meta);
    if (a.record) {
      const m = (a.record.messages && a.record.messages[a.lang] && a.record.messages[a.lang][a.channel]) || {};
      text.textContent = m.text || '(no text for this language and channel)';
      text.lang = a.lang === 'en' ? 'en' : 'hi';
      const seg = m.segments;
      meta.appendChild(h('span', { class: 'tag muted', text: KIND_LABEL[a.kind] || a.kind }));
      meta.appendChild(h('span', { class: 'tag muted', text: CHANNEL_LABEL[a.channel] || a.channel }));
      if (seg && seg.segments) meta.appendChild(h('span', { class: 'tag muted', text: seg.encoding + ' · ' + seg.units + ' units · ' + seg.segments + ' segment' + (seg.segments === 1 ? '' : 's') }));
      const ls = m.language_status || a.record.language_status || '';
      meta.appendChild(h('span', { class: 'tag ' + (ls === 'draft_unreviewed' ? 'amber' : 'water'), text: STATUS_TEXT[ls] || ls || 'status unknown' }));
      status.textContent = 'Dry run. Nothing was sent.' + (a.record.helpline ? ' Helpline: ' + a.record.helpline + (a.record.helpline_source ? ' (' + a.record.helpline_source + ')' : '') + '.' : '');
    } else {
      text.textContent = a.text || '(no sample text)';
      text.lang = a.lang === 'en' ? 'en' : 'hi';
      meta.appendChild(h('span', { class: 'tag amber', text: 'DEMO sample, offline' }));
      meta.appendChild(h('span', { class: 'tag muted', text: CHANNEL_LABEL[a.channel] || a.channel }));
      status.textContent = 'The API is offline, so this is the stored DEMO sample, not a preview of the selected stretch.';
    }
    if (a.lang === 'mai') {
      meta.appendChild(h('span', { class: 'tag amber', text: 'Maithili: draft, unreviewed' }));
    }
  }

  /* ------------------------------------------------------------------ inspection order */
  function buildOrderShell(body) {
    const top = h('input', { type: 'number', id: 'ordTop', min: '1', max: '50', step: '1', value: '10', 'aria-label': 'Number of stretches' });
    body.appendChild(h('p', { class: 'fine', text: 'A printable sheet for the chosen date: the top stretches by index, with reasons, a checklist for the inspecting officer and a sign-off box. English and Hindi on separate pages.' }));
    body.appendChild(h('div', { class: 'bandh-form' }, h('label', null, h('span', { text: 'Stretches on the sheet' }), top)));
    body.appendChild(h('div', { class: 'bandh-actions' },
      h('button', { type: 'button', class: 'btn primary', id: 'ordGo', text: 'Download inspection order', on: { click: downloadOrder } }),
      h('a', { id: 'ordSample', href: 'data/bandh/inspection_order_sample.html', target: '_blank', rel: 'noopener', hidden: true, text: 'Open the DEMO sample sheet' })));
    body.appendChild(h('div', { id: 'ordMsg' }));
  }

  async function downloadOrder() {
    const msg = document.getElementById('ordMsg');
    S.msg(msg, 'info', 'Building the order…');
    const top = Number(document.getElementById('ordTop').value) || 10;
    const q = 'inspection-order?top=' + encodeURIComponent(top) + (st.date ? '&date=' + encodeURIComponent(st.date) : '');
    let res;
    try {
      res = await fetch('api/bandh/' + q, { cache: 'no-cache' });
    } catch (err) {
      S.msg(msg, 'warn', 'The order needs the SARITA API. Start it and try again.');
      return;
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error || j.detail || ''; } catch (e) { detail = 'HTTP ' + res.status; }
      S.msg(msg, 'warn', detail || 'The order could not be built.');
      return;
    }
    const text = await res.text();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    S.download(m ? m[1] : 'inspection_order.html', text, 'text/html;charset=utf-8');
    S.msg(msg, 'ok', 'Downloaded. Print it, or open the file in a browser.');
  }

  /* ------------------------------------------------------------------ detections */
  function buildDetectShell(body) {
    body.appendChild(h('p', { class: 'fine', text: 'Two radar orbits, same detector rules. Orbit 121 is the frozen detector. Orbit 85 is a post-hoc corridor run: its thresholds were set on the orbit-121 event pair, and the run was chosen after the event was known. A candidate is a lead for a field check, not a confirmed breach.' }));
    body.appendChild(h('p', { class: 'fine', text: 'On the 2024 Bhubhaul event, orbit 85 flags the flood on its first post-breach pass (pair 24 Sep to 6 Oct, 7 days after the breach). The frozen orbit-121 detector flags it on 27 Sep to 9 Oct (10 days after). Other detections are either non-event candidates (may be real monsoon flooding) or likely false alarms (river side dry). n = 1 event; no accuracy is claimed.' }));
    body.appendChild(h('div', { id: 'detCount', class: 'fine' }));
    body.appendChild(h('div', { class: 'table-scroll', id: 'detTableBox' }));
  }

  function renderDetections() {
    const count = document.getElementById('detCount');
    const box = document.getElementById('detTableBox');
    if (!count || !box) return;
    S.clear(box);
    if (!DETECT_ORBITS.some(function (o) { return !!st.detByOrbit[o]; })) {
      count.textContent = 'Not computed yet. The breach detector has not written its output.';
      return;
    }
    const rows = allDetectionRows();
    const events = rows.filter(function (r) { return r.isEvent; }).length;
    count.textContent = 'Event candidates: ' + events + ' (the 2024 Bhubhaul flood). Non-event candidates: ' + (rows.length - events) + '.';
    if (!rows.length) return;
    const head = h('tr', null, h('th', { class: 'left', text: 'Orbit' }), h('th', { class: 'left', text: 'Pair (2024)' }),
      h('th', { class: 'left', text: 'Stretch' }), h('th', { class: 'left', text: 'Kind' }));
    const tb = h('tbody', null);
    rows.forEach(function (r) {
      const pick = function () { if (r.stretch_id && st.feats[r.stretch_id]) selectStretch(r.stretch_id, { pan: true }); };
      tb.appendChild(h('tr', { class: 'clickable' + (r.isEvent ? ' det-event' : ''), tabindex: '0', on: { click: pick,
        keydown: function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); pick(); } } } },
        h('td', { class: 'left', text: 'Orbit ' + r.orbit }),
        h('td', { class: 'left' }, h('div', { text: pairText(r) }), h('span', { class: 'det-sub', text: daysVsBreach(r.endDate) })),
        h('td', { class: 'left', text: r.stretch_id || 'unknown' }),
        h('td', { class: 'left', text: kindText(r) + (r.orbit === '85' && r.isEvent ? ' (post hoc)' : '') })));
    });
    box.appendChild(h('table', { class: 'data' }, h('thead', null, head), tb));
  }

  const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const ABLATION_LABEL = function (k) { return String(k).replace(/^only_/, 'Only ').replace(/^without_/, 'Without ').replace(/_/g, ' '); };

  function buildBacktestShell(body) {
    body.appendChild(h('div', { class: 'bt-label', role: 'note' }, h('strong', { text: 'n = 1, anecdote, not accuracy' })));
    body.appendChild(h('p', { class: 'fine', text: 'One event: the 29 September 2024 Kosi breach near Bhubhaul (Darbhanga). This shows how the frozen index ranked the target stretch (detector best estimate). It gives no accuracy, precision, recall or AUC, and no lead time for future events.' }));
    body.appendChild(h('div', { id: 'btBody' }));
  }

  function daysWord(n) { return n >= 0 && n <= 10 ? NUM_WORDS[n] + (n === 1 ? ' day' : ' days') : n + ' days'; }

  /** A target result from the file, or null when it was not ranked. */
  function btTarget(t) {
    return t && typeof t === 'object' && t.status === 'ok' && isNum(t.rank) ? t : null;
  }
  function btRankText(t) {
    if (!t) return F.DASH;
    return 'rank ' + F.num(t.rank) + ' of ' + F.num(t.n_ranked) + ' (percentile ' + F.fixed(t.percentile, 1) + ')';
  }
  function btFreezes(b) {
    const f = b && b.freezes && typeof b.freezes === 'object' ? b.freezes : {};
    return Object.keys(f).sort().reverse().map(function (d) { return { date: d, data: f[d] || {} }; });
  }

  /** Plain verdict for one freeze, computed from the target result. */
  function btVerdict(f, t) {
    const days = F.daysBetween(f.date, BREACH_DATE);
    const when = days !== null && days >= 0 ? ' ' + daysWord(days) + ' before' : '';
    const where = ' (rank ' + F.num(t.rank) + ' of ' + F.num(t.n_ranked) + ')';
    if (t.top5pct) return 'Put the target stretch (detector best estimate) in the top 5%' + when + where + '.';
    return 'Did not single out the target stretch (detector best estimate)' + when + where + '.';
  }

  function btBlock(f, isPrimary) {
    const d = f.data;
    const days = F.daysBetween(f.date, BREACH_DATE);
    const T1 = btTarget(d.targets && d.targets.T1), T3 = btTarget(d.targets && d.targets.T3);
    const sub = d.koshi_subset && d.koshi_subset.targets ? btTarget(d.koshi_subset.targets.T1) : null;
    const rnd = d.random_expectation || {};
    const headParts = [isPrimary ? 'Primary freeze' : 'Second freeze', F.dateLong(f.date)];
    if (days !== null && days >= 0) headParts.push(daysWord(days) + ' before the breach');
    if (isNum(d.orbit)) headParts.push('Sentinel-1 orbit ' + d.orbit);
    const block = h('div', { class: 'bt-block' + (isPrimary ? ' primary' : '') });
    block.appendChild(h('h3', { class: 'bt-head', text: headParts.join(' · ') }));
    if (d.status !== 'ok' || !d.targets) {
      block.appendChild(h('p', { class: 'bt-verdict', text: 'This freeze has no ranking in the file (' + (d.status || 'unknown status') + ').' }));
      return block;
    }
    block.appendChild(h('p', { class: 'bt-verdict', text: T1 ? btVerdict(f, T1) : 'The target stretch was not ranked on this date.' }));
    const onlyF1 = d.ablations && d.ablations.only_F1 && d.ablations.only_F1.T1;
    if (onlyF1 && !btTarget(onlyF1)) {
      block.appendChild(h('p', { class: 'fine', text: 'Landside wetness (F1) has no baseline on any stretch at this freeze (no same-orbit dry-season baseline), so this rank uses four features. Read it as a four-feature index.' }));
    }
    const kv = h('div', { class: 'kv' });
    const pairs = [
      ['Target stretch (detector best estimate) ' + (T1 ? T1.best_stretch : (d.targets.T1 && d.targets.T1.targets ? d.targets.T1.targets[0] : '')), btRankText(T1)],
      ['In the top 5%?', T1 ? (T1.top5pct ? 'Yes' : 'No') : F.DASH],
      ['Other target T3 (KOSHI-W-03-012133)', btRankText(T3)],
      ['Within the KOSHI subset', sub ? 'rank ' + F.num(sub.rank) + ' of ' + F.num(sub.n_ranked) : F.DASH],
      ['Chance of top 5% by luck', isNum(rnd.p_top5pct) ? F.fixed(rnd.p_top5pct * 100, 0) + '%' : F.DASH],
    ];
    pairs.forEach(function (pr) { kv.appendChild(h('span', { class: 'k', text: pr[0] })); kv.appendChild(h('span', { class: 'v', text: pr[1] })); });
    block.appendChild(kv);
    return block;
  }

  function btNegative(b) {
    const nc = b.negative_controls && typeof b.negative_controls === 'object' ? b.negative_controls : {};
    const dates = Object.keys(nc).sort();
    if (!dates.length) return null;
    const rows = dates.map(function (d) {
      const t = nc[d] && nc[d].targets ? btTarget(nc[d].targets.T1) : null;
      return { date: d, t: t };
    });
    const ranked = rows.filter(function (r) { return r.t; });
    const notRanked = rows.length - ranked.length;
    const box = h('div', { class: 'bt-block' });
    box.appendChild(h('h3', { class: 'bt-head', text: 'Negative control, 2023 (same stretch; no breach in the catalogue for 2023)' }));
    let text = 'Target stretch ranked on ' + ranked.length + ' of ' + rows.length + ' dates.';
    if (ranked.length) {
      const ranks = ranked.map(function (r) { return r.t.rank; });
      const pcts = ranked.map(function (r) { return r.t.percentile; });
      const ns = ranked.map(function (r) { return r.t.n_ranked; });
      text += ' Rank ' + F.num(Math.min.apply(null, ranks)) + '–' + F.num(Math.max.apply(null, ranks)) +
        ' of ' + F.num(Math.min.apply(null, ns)) + '–' + F.num(Math.max.apply(null, ns)) +
        ' (percentile ' + F.fixed(Math.min.apply(null, pcts), 0) + '–' + F.fixed(Math.max.apply(null, pcts), 0) + ').';
    }
    if (notRanked) text += ' ' + notRanked + ' date' + (notRanked === 1 ? ' was' : 's were') + ' not ranked (too few uncensored dates for the river-approach feature).';
    text += ' Landside wetness (F1) has no baseline on these dates, so the rank uses four features.';
    box.appendChild(h('p', { class: 'bt-verdict', text: text }));
    const tb = h('tbody', null, rows.map(function (r) {
      return h('tr', null, h('td', { class: 'left', text: F.dateLong(r.date) }),
        h('td', { text: r.t ? F.num(r.t.rank) + ' of ' + F.num(r.t.n_ranked) : 'not ranked' }),
        h('td', { text: r.t ? F.fixed(r.t.percentile, 1) : F.DASH }));
    }));
    box.appendChild(h('details', { class: 'bt-more' },
      h('summary', { text: 'Show the negative control dates' }),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
        h('thead', null, h('tr', null, h('th', { class: 'left', text: 'Date' }), h('th', { text: 'Rank' }), h('th', { text: 'Percentile' }))), tb))));
    return box;
  }

  function btPostEvent(b) {
    const pe = b.post_event_context && typeof b.post_event_context === 'object' ? b.post_event_context : {};
    const dates = Object.keys(pe).sort();
    if (!dates.length) return null;
    const box = h('div', { class: 'bt-block' });
    box.appendChild(h('h3', { class: 'bt-head', text: 'After the event (context, not part of the test)' }));
    dates.forEach(function (d) {
      const t = pe[d] && pe[d].targets ? btTarget(pe[d].targets.T1) : null;
      box.appendChild(h('p', { class: 'bt-verdict', text: F.dateLong(d) + ': target stretch ' + (t ? 'rank ' + F.num(t.rank) + ' of ' + F.num(t.n_ranked) : 'not ranked') + '.' }));
    });
    return box;
  }

  function btAblations(f) {
    const ab = f.data.ablations && typeof f.data.ablations === 'object' ? f.data.ablations : {};
    const keys = Object.keys(ab).sort();
    if (!keys.length) return null;
    const tb = h('tbody', null, keys.map(function (k) {
      const t = ab[k] && ab[k].T1 ? btTarget(ab[k].T1) : null;
      return h('tr', null, h('td', { class: 'left', text: ABLATION_LABEL(k) }),
        h('td', { text: t ? F.num(t.rank) + ' of ' + F.num(t.n_ranked) : 'not ranked' }),
        h('td', { text: t ? (t.top5pct ? 'yes' : 'no') : F.DASH }));
    }));
    return h('details', { class: 'bt-more' },
      h('summary', { text: 'Feature ablations on the primary freeze (exploratory, not the result)' }),
      h('div', { class: 'table-scroll' }, h('table', { class: 'data compact' },
        h('thead', null, h('tr', null, h('th', { class: 'left', text: 'Ablation' }), h('th', { text: 'Target stretch rank' }), h('th', { text: 'Top 5%?' }))), tb)));
  }

  function renderBacktest() {
    const box = document.getElementById('btBody');
    if (!box) return;
    S.clear(box);
    const b = st.backtest;
    if (!b) { box.appendChild(h('div', { class: 'empty', text: 'Backtest not computed yet.' })); return; }
    if (b.partial) box.appendChild(S.notice({ kind: 'warn', title: 'Partial backtest', text: 'Some results are missing from the file. Read the numbers below as incomplete.' }));
    const freezes = btFreezes(b);
    if (!freezes.length) { box.appendChild(h('div', { class: 'fine', text: 'The backtest file has no freeze results yet.' })); return; }
    const primary = freezes.filter(function (f) { return f.date === b.latest_risk_date; })[0] || freezes[0];
    box.appendChild(btBlock(primary, true));
    freezes.filter(function (f) { return f !== primary; }).forEach(function (f) { box.appendChild(btBlock(f, false)); });
    [btNegative(b), btPostEvent(b)].forEach(function (el) { if (el) box.appendChild(el); });
    const ab = btAblations(primary);
    if (ab) box.appendChild(ab);
    box.appendChild(h('p', { class: 'fine bt-foot', text: 'Validation: ' + (b.validation_status || 'unknown') + '. Protocol ' + (b.protocol || 'unknown') +
      (b.computed_at ? ', computed ' + String(b.computed_at).slice(0, 10) : '') + '. A miss is reported as a miss.' }));
  }

  /* ------------------------------------------------------------------ status */
  function buildStatusShell(body) {
    body.appendChild(h('div', { id: 'stBody' }));
    body.appendChild(h('p', { class: 'fine', text: 'Honesty: the index is not validated. It has no measured accuracy. Maithili text is a draft. Every number on this page comes from a file in web/data/bandh or from the API.' }));
  }

  function renderStatus() {
    const box = document.getElementById('stBody');
    if (!box) return;
    S.clear(box);
    const m = st.manifest;
    if (!m || !m.layers) {
      box.appendChild(h('div', { class: 'empty', text: 'The layer manifest is not built yet (python -m sarita.bandh.export --manifest).' }));
      return;
    }
    const L_ = m.layers;
    const rows = [
      ['Embankment atlas', L_.embankments && L_.embankments.available ? (L_.embankments.features || '?') + ' lines' : 'not computed'],
      ['Stretches (1 km)', L_.stretches && L_.stretches.available ? (L_.stretches.features || '?') + ' stretches' : 'not computed'],
      ['Risk index', st.dates && st.dates.length ? st.dates.length + ' date' + (st.dates.length === 1 ? '' : 's') + ' (' + st.dates.slice(0, 3).map(F.dateShort).join(', ') + (st.dates.length > 3 ? ', …' : '') + ')' : 'not computed'],
      ['Feature series', L_.series && L_.series.available ? (L_.series.stretch_ids || []).length + ' stretches' : 'not computed'],
      ['Breach detections, orbit 121', L_.detections && L_.detections.available ? 'available' : 'not computed'],
      ['Breach detections, orbit 85', L_.detections_o85 && L_.detections_o85.available ? 'available (post-hoc run)' : 'not computed'],
      ['Backtest (2024)', L_.backtest && L_.backtest.available ? 'available, n = 1' : 'not computed'],
      ['Footprints (saved)', L_.footprints && L_.footprints.available ? L_.footprints.files.length + ' saved' : 'none saved (use the simulator)'],
      ['Sample voice files', L_.audio && L_.audio.available ? L_.audio.files.length + ' DEMO clips' : 'none'],
    ];
    const kv = h('div', { class: 'kv' });
    rows.forEach(function (r) { kv.appendChild(h('span', { class: 'k', text: r[0] })); kv.appendChild(h('span', { class: 'v', text: r[1] })); });
    box.appendChild(kv);
    box.appendChild(h('p', { class: 'fine', text: 'Manifest written ' + (m.generated_at || 'unknown time') + '.' }));
  }

  /* ------------------------------------------------------------------ init */
  async function init() {
    const root = document.getElementById('bandhRoot');
    buildShell(root);
    initMap();
    document.getElementById('bandhDate').addEventListener('change', function (e) { loadRisk(e.target.value || null); });
    const [man, strs, bt, det121, det85] = await Promise.all([
      getJSON('manifest', 'data/bandh/manifest.json'),
      getJSON('stretches', 'data/bandh/stretches.geojson'),
      getJSON('backtest', 'data/bandh/backtest.json'),
      getJSON('detections?orbit=121', 'data/bandh/detections.json'),
      getJSON('detections?orbit=85', 'data/bandh/detections_o85.json'),
    ]);
    st.manifest = man.data;
    st.dates = Array.isArray(man.data && man.data.layers && man.data.layers.risk && man.data.layers.risk.dates)
      ? man.data.layers.risk.dates.slice() : [];
    st.stretches = strs.data;
    st.feats = {};
    if (st.stretches && Array.isArray(st.stretches.features)) {
      st.stretches.features.forEach(function (f) { if (f.properties) st.feats[f.properties.stretch_id] = f; });
      if (st.stretches.mock) st.mock = true;
    }
    st.backtest = bt.data;
    st.detByOrbit = { '121': det121.data, '85': det85.data };
    if (st.backtest && st.backtest.mock) st.mock = true;
    DETECT_ORBITS.forEach(function (o) { if (st.detByOrbit[o] && st.detByOrbit[o].mock) st.mock = true; });
    drawStretches();
    drawDetections();
    renderDetections();
    renderBacktest();
    renderAudioNote();
    // The default view is risk_latest.json (no date parameter). Its freeze date is added to the selector
    // when the manifest does not list it yet (the manifest can be older than the latest ranking file).
    const latest = await getJSON('risk', 'data/bandh/risk_latest.json');
    const latestDate = riskDateOf(latest.data);
    if (latestDate && st.dates.indexOf(latestDate) < 0) st.dates.push(latestDate);
    st.dates.sort().reverse();
    populateDates();
    st.ready = true;
    setNotices();
    document.getElementById('bandhDate').disabled = !st.dates.length;
    await loadRisk(null, latest);
    renderStatus();
    renderAlertStretch();
  }

  function populateDates() {
    const sel = document.getElementById('bandhDate');
    if (!sel) return;
    S.clear(sel);
    if (!st.dates.length) {
      sel.appendChild(h('option', { value: '', text: 'not computed yet' }));
      return;
    }
    st.dates.forEach(function (d) { sel.appendChild(h('option', { value: d, text: F.dateLong(d) })); });
  }

  function syncDateSelect() {
    const sel = document.getElementById('bandhDate');
    if (!sel || !st.date) return;
    if (st.dates.indexOf(st.date) < 0) sel.appendChild(h('option', { value: st.date, text: F.dateLong(st.date) }));
    sel.value = st.date;
  }

  function onShow() {
    if (st.map) { st.map.invalidateSize(); }
    S.resizeCharts();
  }

  S.bandhPage = { init: init, onShow: onShow };
})();
