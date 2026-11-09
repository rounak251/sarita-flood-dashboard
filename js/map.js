/* SARITA dashboard - Flood Map page (#map).
 * Leaflet image overlays per acquisition date (already in Web Mercator, see sarita/export_web.py),
 * district choropleth with hover statistics, KPI cards, two charts, a sortable district table and
 * the English / Hindi bulletin generator (POST /api/bulletin). Every number comes from
 * web/data/bihar/{layers.json, summary.json, districts.geojson}; nothing is hard-coded. */
(function () {
  'use strict';
  const S = window.SARITA;
  const F = S.fmt, h = S.h, C = S.COLORS, isNum = S.isNum;

  const KINDS = [
    { kind: 'sar', label: 'Radar (VV)', sw: 'linear-gradient(90deg,#000,#fff)' },
    { kind: 'water', label: 'Water', sw: C.water },
    { kind: 'flood', label: 'Flood', sw: C.flood },
    { kind: 'uncertainty', label: 'Uncertainty', sw: 'linear-gradient(90deg,#000004,#51127C,#B73779,#FC8961,#FCFDBF)' },
    { kind: 'duration', label: 'Duration', sw: 'linear-gradient(90deg,#F6C9A8,#E4572E,#7A1F0E)' },
  ];
  const PANES = { sar: 310, choro: 330, water: 340, flood: 350, uncertainty: 360, duration: 370, labels: 380 };
  const CHORO = ['#FDEFE9', '#F8C9B6', '#F19B7C', '#E66B45', '#B83C1A'];
  const DEFAULT_LEGENDS = {
    sar: { type: 'gradient', stops: ['#000000', '#FFFFFF'], min: '-25 dB', max: '0 dB' },
    water: [{ color: C.water, label: 'Water' }],
    flood: [{ color: C.water, label: 'Reference / permanent water' }, { color: C.flood, label: 'Flood (new water)' }],
    uncertainty: { type: 'gradient', stops: ['#000004', '#51127C', '#B73779', '#FC8961', '#FCFDBF'], min: '0 bits (certain)', max: '1 bit (p = 0.5)' },
    duration: { type: 'gradient', stops: ['#F6C9A8', '#E4572E', '#7A1F0E'], min: 'flooded once', max: 'on every date' },
  };
  const LEGEND_TITLES = { sar: 'Radar backscatter', water: 'Water (model)', flood: 'Flood vs reference', uncertainty: 'Uncertainty (entropy)', duration: 'Flood duration' };

  const st = {
    layers: null, summary: null, districts: null,
    dates: [], post: [], ref: null, date: null,
    show: { sar: true, water: false, flood: true, uncertainty: false, duration: false, districts: true, choropleth: true },
    opOverlay: 0.85, opSar: 0.9,
    overlays: {}, failed: {},
    map: null, base: null, distLayer: null, labelLayer: null, legend: null, choroBreaks: null,
    sort: { key: 'flood_km2', dir: -1 }, selDistrict: null, lang: 'en', tileOk: 0, tileErr: 0,
    msgTimer: null,
  };

  /* ================================================================ helpers */
  const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
  const featName = (f) => (f.properties && (f.properties.district || f.properties.shapeName)) || '?';
  function dateStats(d) { return (st.summary && st.summary.dates && st.summary.dates[d]) || null; }
  function hasFloodStats(d) { const s = dateStats(d); return !!(s && isNum(s.flood_km2)); }
  function isPost(d) { return st.post.indexOf(d) >= 0; }
  function layerFor(kind, d) {
    if (!st.layers || !Array.isArray(st.layers.layers)) return null;
    return st.layers.layers.find(function (l) { return l.kind === kind && (kind === 'duration' || l.date === d); }) || null;
  }
  function kindExists(kind) { return !!(st.layers && (st.layers.layers || []).some(function (l) { return l.kind === kind; })); }
  function phaseOf(d) {
    if (st.ref && d === st.ref) return { cls: 'pre', label: 'reference' };
    if (st.ref && d < st.ref) return { cls: 'pre', label: 'pre-event' };
    if (isPost(d)) {
      const n = st.ref ? F.daysBetween(st.ref, d) : null;
      return { cls: 'post', label: n != null ? 'post · +' + n + ' d' : 'post-event' };
    }
    return { cls: '', label: '' };
  }
  function districtRows(d) {
    const out = [];
    const geo = {};
    ((st.districts && st.districts.features) || []).forEach(function (f) { geo[fold(featName(f))] = f.properties || {}; });
    const src = (st.summary && Array.isArray(st.summary.districts) && st.summary.districts.length)
      ? st.summary.districts
      : ((st.districts && st.districts.features) || []).map(function (f) {
        const p = f.properties || {};
        return { district: featName(f), area_km2: p.area_km2, dates: p.stats || {}, inundation_km2: p.inundation_km2 };
      });
    src.forEach(function (r) {
      const s = (r.dates && r.dates[d]) || {};
      const g = geo[fold(r.district)] || {};
      const inund = r.inundation_km2 || g.inundation_km2;
      out.push(Object.assign({ district: r.district, district_hi: g.district_hi || '', area_km2: num(r.area_km2) },
        s, { inundation: inund && isNum(inund[d]) ? inund[d] : null, hasStats: isNum(s.flood_km2) }));
    });
    return out;
  }
  function num(v) { const n = typeof v === 'string' ? Number(v) : v; return isNum(n) ? n : null; }

  /* ================================================================ init */
  async function init() {
    const res = await Promise.all([
      S.data('data/bihar/layers.json'), S.data('data/bihar/summary.json'), S.data('data/bihar/districts.geojson'),
    ]);
    st.layers = res[0] && Array.isArray(res[0].layers) ? res[0] : null;
    st.summary = res[1];
    st.districts = res[2] && Array.isArray(res[2].features) ? res[2] : null;
    if (!st.summary && S.api && S.api.state !== 'offline') {
      const r = await S.api.summary();
      if (r.ok) st.summary = r.data;
    }

    st.ref = (st.summary && st.summary.method && st.summary.method.reference_date) || (st.layers && st.layers.reference_date) || null;
    const ds = new Set();
    if (st.layers) {
      (st.layers.dates || []).forEach(function (d) { ds.add(d); });
      st.layers.layers.forEach(function (l) { if (l.date) ds.add(l.date); });
    }
    if (st.summary && st.summary.dates) Object.keys(st.summary.dates).forEach(function (d) { ds.add(d); });
    st.dates = Array.from(ds).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort();
    if (st.layers && Array.isArray(st.layers.post_dates) && st.layers.post_dates.length) st.post = st.layers.post_dates.slice();
    else if (st.ref) st.post = st.dates.filter(function (d) { return d > st.ref; });
    else st.post = st.dates.filter(hasFloodStats);

    const withStats = st.post.filter(hasFloodStats);
    if (withStats.length) {
      st.date = withStats.reduce(function (a, b) { return dateStats(b).flood_km2 > dateStats(a).flood_km2 ? b : a; });
    } else {
      st.date = st.post[0] || st.dates[st.dates.length - 1] || null;
    }
    computeChoroBreaks();

    if (!st.layers && !st.summary && !st.districts) {
      S.msg(S.$('#tableNote'), null, null);
      S.$('#mapSub').textContent = 'No case-study data found.';
    }

    buildControls();
    try { buildMap(); } catch (err) {
      console.error('[SARITA] map failed', err);
      showMapMsg('The map could not be created (' + (err && err.message ? err.message : err) + '). Statistics below still work.', 0);
    }
    buildBulletin();
    renderAll();
    document.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (location.hash && location.hash.indexOf('#map') !== 0) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = st.dates.indexOf(st.date);
    const j = e.key === 'ArrowLeft' ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < st.dates.length) { e.preventDefault(); setDate(st.dates[j]); }
  }

  /* ================================================================ controls */
  function buildControls() {
    const bar = S.$('#dateBar');
    S.clear(bar);
    if (!st.dates.length) bar.appendChild(h('span', { class: 'fine', text: 'No acquisition dates available.' }));
    st.dates.forEach(function (d) {
      const ph = phaseOf(d);
      bar.appendChild(h('button', {
        type: 'button', class: 'date-btn ' + ph.cls, role: 'tab', dataset: { date: d },
        title: F.dateLong(d) + (ph.label ? ' (' + ph.label + ')' : ''), on: { click: function () { setDate(d); } },
      }, h('span', { class: 'd-main', text: F.dateShort(d) }), h('span', { class: 'd-sub', text: ph.label || ' ' })));
    });
    const op = S.$('#opOverlay'), sar = S.$('#opSar'), base = S.$('#basemap');
    op.addEventListener('input', function () { st.opOverlay = op.value / 100; applyOpacity(); });
    sar.addEventListener('input', function () { st.opSar = sar.value / 100; applyOpacity(); });
    if (navigator.onLine === false) base.value = 'none';
    base.addEventListener('change', function () { setBasemap(base.value); });
  }

  function applyOpacity() {
    Object.keys(st.overlays).forEach(function (id) {
      const o = st.overlays[id];
      o.setOpacity(o._saritaKind === 'sar' ? st.opSar : st.opOverlay);
    });
  }

  function renderToggles() {
    const box = S.$('#layerToggles');
    S.clear(box);
    KINDS.forEach(function (k) {
      if (!kindExists(k.kind)) return;
      const meta = layerFor(k.kind, st.date);
      const avail = !!meta && !st.failed[meta.id];
      let note = '';
      if (!avail) note = k.kind === 'flood' && st.date && !isPost(st.date) ? 'pre-event' : (meta && st.failed[meta.id] ? 'failed to load' : 'not for this date');
      box.appendChild(toggle(k.kind, k.label, k.sw, avail, note));
    });
    if (st.districts) {
      box.appendChild(toggle('districts', 'Districts', '#FFFFFF', true, ''));
      const any = districtRows(st.date).some(function (r) { return r.hasStats; });
      box.appendChild(toggle('choropleth', 'Choropleth', CHORO[3], any, any ? '' : 'post-event only'));
    }
    if (!box.childNodes.length) box.appendChild(h('span', { class: 'fine', text: 'No map layers exported yet.' }));
  }

  function toggle(key, label, sw, avail, note) {
    const id = 'lt-' + key;
    const inp = h('input', { type: 'checkbox', id: id, checked: !!st.show[key] });
    inp.addEventListener('change', function () {
      st.show[key] = inp.checked;
      if (key === 'districts' || key === 'choropleth') { refreshDistricts(); renderLegend(); renderToggles(); }
      else refreshLayers();
    });
    return h('label', { class: 'ltoggle' + (avail ? '' : ' na'), for: id },
      inp, h('span', { class: 'sw', style: { background: sw } }), label,
      note ? h('span', { class: 'na-note', text: '(' + note + ')' }) : null);
  }

  /* ================================================================ map */
  function buildMap() {
    if (typeof window.L === 'undefined') {
      showMapMsg('Leaflet (web/vendor/leaflet) did not load, so the map is unavailable. Statistics below still work.', 0);
      return;
    }
    const L = window.L;
    const map = (st.map = L.map('leafletMap', { zoomControl: true, minZoom: 5, maxZoom: 16, zoomSnap: 0.25, zoomDelta: 0.5 }));
    Object.keys(PANES).forEach(function (k) { map.createPane('p-' + k).style.zIndex = PANES[k]; });
    map.getPane('p-labels').style.pointerEvents = 'none';
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    let bounds = st.layers && st.layers.bounds;
    if (!bounds && st.summary && st.summary.aoi && Array.isArray(st.summary.aoi.bbox_lonlat)) {
      const b = st.summary.aoi.bbox_lonlat;
      bounds = [[b[1], b[0]], [b[3], b[2]]];
    }
    if (!bounds && st.districts) {
      try { bounds = L.geoJSON(st.districts).getBounds(); } catch (e) { bounds = null; }
    }
    if (bounds) {
      map.fitBounds(bounds, { padding: [8, 8] });
      st.bounds = L.latLngBounds(bounds);
      // AOI outline (always visible, also with every layer off)
      L.rectangle(st.bounds, { pane: 'p-labels', color: C.ink, weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(map);
    } else {
      map.setView([26.1, 86.4], 8);
    }

    st.base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    st.base.on('tileload', function () { st.tileOk++; });
    st.base.on('tileerror', function () {
      st.tileErr++;
      if (st.tileErr === 3 && st.tileOk === 0) {
        showMapMsg('Basemap tiles could not be loaded (offline?). The flood layers do not need them.', 7000);
      }
    });
    setBasemap(S.$('#basemap').value);

    // legend
    st.legend = L.control({ position: 'bottomright' });
    st.legend.onAdd = function () {
      const div = L.DomUtil.create('div', 'map-legend');
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    st.legend.addTo(map);

    buildDistricts();
  }

  function setBasemap(v) {
    if (!st.map || !st.base) return;
    if (v === 'osm') { if (!st.map.hasLayer(st.base)) st.base.addTo(st.map); }
    else if (st.map.hasLayer(st.base)) st.map.removeLayer(st.base);
  }

  function showMapMsg(text, ms) {
    const el = S.$('#mapMsg');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(st.msgTimer);
    if (ms) st.msgTimer = setTimeout(function () { el.hidden = true; }, ms);
  }

  function overlayFor(meta) {
    let o = st.overlays[meta.id];
    if (!o) {
      const L = window.L;
      const b = meta.bounds || (st.layers && st.layers.bounds);
      o = L.imageOverlay(meta.url, b, {
        pane: 'p-' + (PANES[meta.kind] ? meta.kind : 'flood'), interactive: false, className: 'ov-' + meta.kind,
        alt: meta.label || meta.kind, attribution: meta.attribution || '',
      });
      o._saritaKind = meta.kind;
      o.on('error', function () {
        if (st.failed[meta.id]) return;
        st.failed[meta.id] = true;
        showMapMsg('Could not load ' + (meta.label || meta.kind) + ' (' + meta.url + ').', 6000);
        refreshLayers();
      });
      st.overlays[meta.id] = o;
    }
    return o;
  }

  function refreshLayers() {
    const want = [];
    const notes = [];
    const d = st.date;
    KINDS.forEach(function (k) {
      if (!st.show[k.kind] || !kindExists(k.kind)) return;
      let meta = layerFor(k.kind, d);
      if (meta && st.failed[meta.id]) meta = null;
      if (!meta && k.kind === 'flood') {
        const w = layerFor('water', d);
        if (w && !st.failed[w.id]) {
          if (!st.show.water) want.push(w);
          notes.push(st.ref && d <= st.ref
            ? F.dateLong(d) + ' is before the flood, so it has no flood layer: flooding is measured against the ' + F.dateLong(st.ref) + ' reference. Showing the water the model detected instead.'
            : 'No flood layer for ' + F.dateLong(d) + '; showing the water the model detected instead.');
        }
        return;
      }
      if (!meta && k.kind === 'uncertainty') {
        const have = st.layers.layers.filter(function (l) { return l.kind === 'uncertainty'; }).map(function (l) { return F.dateLong(l.date); });
        notes.push('The uncertainty layer (8-view TTA entropy) exists for ' + have.join(', ') + ' only.');
        return;
      }
      if (meta) want.push(meta);
    });
    if (st.map) {
      const ids = want.map(function (m) { return m.id; });
      Object.keys(st.overlays).forEach(function (id) {
        if (ids.indexOf(id) < 0 && st.map.hasLayer(st.overlays[id])) st.map.removeLayer(st.overlays[id]);
      });
      want.forEach(function (meta) {
        const o = overlayFor(meta);
        o.setOpacity(meta.kind === 'sar' ? st.opSar : st.opOverlay);
        if (!st.map.hasLayer(o)) o.addTo(st.map);
      });
    }
    st.visible = want;
    const hint = S.$('#mapHint');
    hint.hidden = !notes.length;
    hint.textContent = notes.join(' ');
    renderToggles();
    renderLegend();
  }

  /* ---------------------------------------------------------------- districts */
  function computeChoroBreaks() {
    let max = 0;
    st.post.forEach(function (d) {
      districtRows(d).forEach(function (r) { if (isNum(r.flood_km2) && r.flood_km2 > max) max = r.flood_km2; });
    });
    if (!max) { st.choroBreaks = null; return; }
    const nice = function (v) {
      if (v <= 0) return 0;
      const p = Math.pow(10, Math.floor(Math.log10(v)));
      const m = v / p;
      return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
    };
    const raw = [0.1, 0.25, 0.5, 0.75].map(function (f) { return nice(max * f); });
    st.choroBreaks = raw.filter(function (v, i) { return i === 0 || v > raw[i - 1]; });
  }
  function choroColor(v) {
    if (!st.choroBreaks) return CHORO[2];
    let i = 0;
    while (i < st.choroBreaks.length && v >= st.choroBreaks[i]) i++;
    return CHORO[Math.min(i, CHORO.length - 1)];
  }
  function floodAt(f, d) {
    const s = f.properties && f.properties.stats;
    const v = s && s[d] ? num(s[d].flood_km2) : null;
    if (v != null) return v;
    const r = districtRows(d).find(function (x) { return fold(x.district) === fold(featName(f)); });
    return r && isNum(r.flood_km2) ? r.flood_km2 : null;
  }
  function distStyle(f) {
    const v = floodAt(f, st.date);
    const sel = st.selDistrict && fold(featName(f)) === fold(st.selDistrict);
    const fillOn = st.show.choropleth && isNum(v);
    return {
      color: sel ? C.teal : '#22364A', weight: sel ? 3.2 : 1.1, opacity: st.show.districts ? 0.9 : 0,
      fillColor: fillOn ? choroColor(v) : '#FFFFFF', fillOpacity: fillOn ? 0.45 : 0, fill: true,
    };
  }
  function tipHTML(f) {
    const p = f.properties || {};
    const name = featName(f);
    const row = districtRows(st.date).find(function (r) { return fold(r.district) === fold(name); }) || {};
    const esc = S.escapeHTML;
    let rows;
    if (row.hasStats) {
      rows = [
        ['Flooded', F.km2(row.flood_km2) + ' km²'],
        ['Share of observed area', F.pct(row.flood_pct_of_observed)],
        ['Flooded cropland', F.km2(row.flood_cropland_km2) + ' km²'],
        ['People exposed', F.num(row.people_exposed)],
        ['Satellite coverage', isNum(row.coverage) ? F.pct(100 * row.coverage, 0) : F.DASH],
      ];
    } else {
      rows = [['District area', F.km2(row.area_km2 != null ? row.area_km2 : num(p.area_km2)) + ' km²']];
      if (isNum(row.inundation)) rows.push(['Non-permanent water', F.km2(row.inundation) + ' km²']);
      rows.push(['Flood statistics', st.ref && st.date <= st.ref ? 'pre-event date' : 'none for this date']);
    }
    return '<div class="t-name">' + esc(name) + (p.district_hi ? '<span class="t-hi">' + esc(p.district_hi) + '</span>' : '') + '</div>' +
      '<div class="fine" style="margin:0">' + esc(F.dateLong(st.date)) + '</div><table>' +
      rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
  }
  function buildDistricts() {
    if (!st.map || !st.districts) return;
    const L = window.L;
    const renderer = L.svg({ pane: 'p-choro' });
    st.distLayer = L.geoJSON(st.districts, {
      renderer: renderer, pane: 'p-choro', style: distStyle,
      onEachFeature: function (f, layer) {
        layer.bindTooltip(function () { return tipHTML(f); }, { sticky: true, className: 'dist-tip', direction: 'top', offset: [0, -8], opacity: 1 });
        layer.on('mouseover', function (e) { e.target.setStyle({ weight: 2.6, color: C.ink, opacity: 1 }); });
        layer.on('mouseout', function (e) { st.distLayer.resetStyle(e.target); });
        layer.on('click', function () { selectDistrict(featName(f), false); });
      },
    }).addTo(st.map);
    st.labelLayer = L.layerGroup().addTo(st.map);
    st.distLayer.eachLayer(function (layer) {
      const c = layer.getBounds().getCenter();
      L.tooltip({ permanent: true, direction: 'center', className: 'dist-label', pane: 'p-labels', interactive: false })
        .setLatLng(c).setContent(S.escapeHTML(featName(layer.feature))).addTo(st.labelLayer);
    });
  }
  function refreshDistricts() {
    if (!st.distLayer) return;
    st.distLayer.setStyle(distStyle);
    if (st.labelLayer) {
      if (st.show.districts && !st.map.hasLayer(st.labelLayer)) st.labelLayer.addTo(st.map);
      if (!st.show.districts && st.map.hasLayer(st.labelLayer)) st.map.removeLayer(st.labelLayer);
    }
  }

  /* ---------------------------------------------------------------- legend */
  function legendBlock(title, lg) {
    const block = h('div', { class: 'lg-block' }, h('h4', { text: title }));
    if (Array.isArray(lg)) {
      lg.forEach(function (it) {
        block.appendChild(h('div', { class: 'lg-row' }, h('span', { class: 'lg-sw', style: { background: it.color } }), it.label));
      });
    } else if (lg && lg.type === 'gradient') {
      block.appendChild(h('div', { class: 'lg-grad', style: { background: 'linear-gradient(90deg,' + (lg.stops || []).join(',') + ')' } }));
      block.appendChild(h('div', { class: 'lg-ends' }, h('span', { text: lg.min || '' }), h('span', { text: lg.max || '' })));
    }
    return block;
  }
  function renderLegend() {
    if (!st.legend || !st.legend.getContainer()) return;
    const div = st.legend.getContainer();
    S.clear(div);
    const seen = {};
    (st.visible || []).slice().reverse().forEach(function (meta) {
      if (seen[meta.kind]) return;
      seen[meta.kind] = true;
      div.appendChild(legendBlock(LEGEND_TITLES[meta.kind] || meta.label || meta.kind, meta.legend || DEFAULT_LEGENDS[meta.kind]));
    });
    const anyStats = districtRows(st.date).some(function (r) { return r.hasStats; });
    if (st.distLayer && st.show.choropleth && anyStats && st.choroBreaks) {
      const b = st.choroBreaks;
      const items = [{ color: CHORO[0], label: '< ' + F.num(b[0]) + ' km²' }];
      for (let i = 0; i < b.length; i++) {
        items.push({ color: CHORO[i + 1], label: i + 1 < b.length ? F.num(b[i]) + '–' + F.num(b[i + 1]) + ' km²' : '≥ ' + F.num(b[i]) + ' km²' });
      }
      div.appendChild(legendBlock('District flooded area', items));
    }
    if (!div.childNodes.length) div.appendChild(h('div', { class: 'fine', style: { margin: 0 }, text: 'No layer selected' }));
  }

  /* ================================================================ side panel */
  function kpi(label, value, unit, sub, cls) {
    return h('div', { class: 'kpi ' + (cls || '') },
      h('div', { class: 'k-label', text: label }),
      h('div', { class: 'k-value' }, value, unit ? h('span', { class: 'k-unit', text: unit }) : null),
      sub ? h('div', { class: 'k-sub', text: sub }) : null);
  }
  function renderKpis() {
    const box = S.$('#kpis'), note = S.$('#kpiNote'), tag = S.$('#kpiTag');
    S.clear(box);
    const d = st.date;
    S.$('#kpiTitle').textContent = d ? F.dateLong(d) : 'No date';
    const ph = d ? phaseOf(d) : { label: '' };
    tag.textContent = ph.label || '';
    tag.className = 'tag ' + (ph.cls === 'post' ? 'flood' : 'water');
    tag.hidden = !ph.label;
    const s = d ? dateStats(d) : null;
    note.textContent = '';
    if (!s) {
      box.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1' }, text: st.summary ? 'No statistics for this date.' : 'summary.json not found: run the case study, then python -m sarita.export_web bihar.' }));
      return;
    }
    if (isNum(s.flood_km2)) {
      const obs = num(s.observed_km2);
      box.appendChild(kpi('Flooded area', F.km2(s.flood_km2), 'km²', obs ? F.pct(100 * s.flood_km2 / obs) + ' of ' + F.km2(obs) + ' km² observed' : '', 'flood'));
      const lk = isNum(s.people_exposed) && s.people_exposed >= 1e5 ? '≈ ' + F.lakh(s.people_exposed) + ' · ' : '';
      box.appendChild(kpi('People exposed', F.num(s.people_exposed), '', lk + 'WorldPop 2020', 'amber'));
      box.appendChild(kpi('Flooded cropland', F.km2(s.flood_cropland_km2), 'km²',
        isNum(s.flood_cropland_km2) && s.flood_km2 > 0 ? F.pct(100 * s.flood_cropland_km2 / s.flood_km2, 0) + ' of the flooded area' : '', ''));
      box.appendChild(kpi('Flooded built-up', F.km2(s.flood_builtup_km2), 'km²', 'ESA WorldCover class 50', 'muted'));
      const parts = [];
      if (isNum(s.inundation_km2)) parts.push('All non-permanent water: ' + F.km2(s.inundation_km2) + ' km² (comparable to the NRSC/ISRO “flood-affected area”).');
      parts.push('Flood = water now that was dry on ' + (st.ref ? F.dateLong(st.ref) : 'the reference date') + ' and is not permanent water.');
      note.textContent = parts.join(' ');
    } else {
      box.appendChild(kpi('Water detected', F.km2(s.water_km2), 'km²', 'model, p ≥ ' + methodThreshold(), 'water'));
      box.appendChild(kpi('Permanent water', F.km2(s.permanent_water_km2), 'km²', 'JRC Global Surface Water', 'water'));
      box.appendChild(kpi('Observed area', F.km2(s.observed_km2), 'km²', 'Sentinel-1 coverage of the study area', 'muted'));
      if (isNum(s.inundation_km2)) box.appendChild(kpi('Non-permanent water', F.km2(s.inundation_km2), 'km²', 'water outside JRC permanent water', ''));
      else box.appendChild(kpi('Flood', 'n/a', '', 'pre-event: no flood statistics', 'muted'));
      note.textContent = st.ref && d === st.ref
        ? 'This is the pre-flood reference image: water seen here is not counted as flood on later dates.'
        : 'Pre-event acquisition: used to estimate the false-change rate of the method (noise floor).';
    }
  }
  function methodThreshold() { return (st.summary && st.summary.method && st.summary.method.threshold) || 0.5; }

  function renderSeries() {
    if (!st.summary || !st.dates.length) { S.chart('chartSeries', null); return; }
    const flood = st.dates.map(function (d) { const s = dateStats(d); return s && isNum(s.flood_km2) ? s.flood_km2 : null; });
    const water = st.dates.map(function (d) { const s = dateStats(d); return s && isNum(s.water_km2) ? s.water_km2 : null; });
    const inund = st.dates.map(function (d) { const s = dateStats(d); return s && isNum(s.inundation_km2) ? s.inundation_km2 : null; });
    const datasets = [
      { type: 'bar', label: 'Flood (new water)', data: flood, backgroundColor: barColors(), borderRadius: 4, maxBarThickness: 46, order: 3 },
      { type: 'line', label: 'All water', data: water, borderColor: C.water, backgroundColor: C.water, pointRadius: 3, pointHoverRadius: 5, tension: 0.25, borderWidth: 2, order: 1 },
    ];
    if (inund.some(isNum)) {
      datasets.push({ type: 'line', label: 'Non-permanent water', data: inund, borderColor: C.teal, backgroundColor: C.teal, borderDash: [5, 4], pointRadius: 2, tension: 0.25, borderWidth: 1.6, order: 2 });
    }
    S.chart('chartSeries', {
      data: { labels: st.dates.map(F.dateShort), datasets: datasets },
      options: {
        responsive: true, interaction: { mode: 'index', intersect: false },
        onClick: function (e, els, chart) {
          const pts = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
          if (pts.length) setDate(st.dates[pts[0].index]);
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: 'km²' }, ticks: { callback: function (v) { return F.compact(v); } } },
          x: { grid: { display: false } },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + (isNum(c.parsed.y) ? F.km2(c.parsed.y) + ' km²' : 'n/a'); } } },
        },
      },
    });
  }
  function barColors() { return st.dates.map(function (d) { return d === st.date ? C.flood : S.alpha(C.flood, 0.38); }); }

  function renderTop() {
    const rows = districtRows(st.date).filter(function (r) { return r.hasStats; })
      .sort(function (a, b) { return b.flood_km2 - a.flood_km2; }).slice(0, 8);
    const empty = S.$('#topEmpty'), box = S.$('#chartTop').parentNode;
    S.$('#topTag').textContent = st.date ? F.dateShort(st.date) : '';
    if (!rows.length) {
      S.chart('chartTop', null);
      box.hidden = true;
      empty.hidden = false;
      const post = st.post.filter(hasFloodStats).map(F.dateShort);
      empty.textContent = st.summary
        ? 'District flood statistics exist for post-event dates only' + (post.length ? ' (' + post.join(', ') + ').' : '.')
        : 'No district statistics available.';
      return;
    }
    box.hidden = false;
    empty.hidden = true;
    S.chart('chartTop', {
      type: 'bar',
      data: {
        labels: rows.map(function (r) { return r.district; }),
        datasets: [{ label: 'Flooded km²', data: rows.map(function (r) { return r.flood_km2; }),
          backgroundColor: rows.map(function (r) { return st.selDistrict && fold(r.district) === fold(st.selDistrict) ? C.teal : C.flood; }),
          borderRadius: 4, maxBarThickness: 22 }],
      },
      options: {
        indexAxis: 'y', responsive: true,
        onClick: function (e, els) { if (els.length) selectDistrict(rows[els[0].index].district, true); },
        scales: { x: { beginAtZero: true, title: { display: true, text: 'flooded km²' }, ticks: { callback: function (v) { return F.compact(v); } } }, y: { grid: { display: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) {
            const r = rows[c.dataIndex];
            return [F.km2(r.flood_km2) + ' km² (' + F.pct(r.flood_pct_of_observed) + ' of observed)', 'People exposed: ' + F.num(r.people_exposed)];
          } } },
        },
      },
    });
  }

  /* ---------------------------------------------------------------- table */
  const COLS_POST = [
    { key: 'district', label: 'District', left: true },
    { key: 'coverage', label: 'Coverage', fmt: function (v) { return isNum(v) ? F.pct(100 * v, 0) : F.DASH; } },
    { key: 'flood_km2', label: 'Flood km²', fmt: F.km2, bar: true },
    { key: 'flood_pct_of_observed', label: '% obs.', fmt: function (v) { return F.pct(v); } },
    { key: 'flood_cropland_km2', label: 'Crop km²', fmt: F.km2 },
    { key: 'flood_builtup_km2', label: 'Built-up km²', fmt: F.km2 },
    { key: 'people_exposed', label: 'People', fmt: function (v) { return F.num(v); } },
  ];
  const COLS_PRE = [
    { key: 'district', label: 'District', left: true },
    { key: 'area_km2', label: 'District area km²', fmt: F.km2 },
    { key: 'inundation', label: 'Non-permanent water km²', fmt: F.km2, bar: true },
  ];
  function renderTable() {
    const table = S.$('#distTable');
    const thead = table.tHead, tbody = table.tBodies[0], tfoot = table.tFoot;
    S.clear(thead); S.clear(tbody); S.clear(tfoot);
    const d = st.date;
    let rows = districtRows(d);
    const post = rows.some(function (r) { return r.hasStats; });
    const cols = post ? COLS_POST : COLS_PRE;
    S.$('#tableTag').textContent = d ? F.dateLong(d) : '';
    const note = S.$('#tableNote');
    if (!rows.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: 7, class: 'empty', text: 'No district data available.' })));
      note.textContent = '';
      return;
    }
    if (!cols.some(function (c) { return c.key === st.sort.key; })) st.sort = { key: cols[cols.length - 1].key, dir: -1 };
    const key = st.sort.key, dir = st.sort.dir;
    rows = rows.slice().sort(function (a, b) {
      const va = a[key], vb = b[key];
      if (key === 'district') return dir * String(va).localeCompare(String(vb));
      if (!isNum(va) && !isNum(vb)) return 0;
      if (!isNum(va)) return 1;
      if (!isNum(vb)) return -1;
      return dir * (va - vb);
    });
    const barKey = (cols.find(function (c) { return c.bar; }) || {}).key;
    const barMax = Math.max.apply(null, rows.map(function (r) { return isNum(r[barKey]) ? r[barKey] : 0; }).concat([0]));
    thead.appendChild(h('tr', null, cols.map(function (c) {
      const sorted = c.key === key;
      return h('th', { class: (c.left ? 'left ' : '') + (sorted ? 'sorted' + (dir > 0 ? ' asc' : '') : ''), title: 'Sort by ' + c.label,
        on: { click: function () { st.sort = { key: c.key, dir: sorted ? -dir : (c.key === 'district' ? 1 : -1) }; renderTable(); } } }, c.label);
    })));
    rows.forEach(function (r) {
      const sel = st.selDistrict && fold(r.district) === fold(st.selDistrict);
      tbody.appendChild(h('tr', { class: 'clickable' + (sel ? ' sel' : ''), on: { click: function () { selectDistrict(r.district, true); } } },
        cols.map(function (c) {
          if (c.key === 'district') {
            return h('td', { class: 'left' }, h('strong', { text: r.district }), r.district_hi ? h('span', { class: 'sub', lang: 'hi', text: r.district_hi }) : null);
          }
          const v = r[c.key];
          const cell = h('td', null, c.fmt ? c.fmt(v) : String(v == null ? F.DASH : v));
          if (c.bar && isNum(v) && barMax > 0) cell.appendChild(h('span', { class: 'bar', style: { width: Math.max(2, Math.round(34 * v / barMax)) + 'px' } }));
          return cell;
        })));
    });
    const s = dateStats(d);
    if (post && s) {
      tfoot.appendChild(h('tr', null,
        h('td', { class: 'left', text: 'Whole study area' }),
        h('td', { text: isNum(s.observed_km2) && st.summary.aoi && isNum(st.summary.aoi.area_km2) ? F.pct(100 * s.observed_km2 / st.summary.aoi.area_km2, 0) : F.DASH }),
        h('td', { text: F.km2(s.flood_km2) }),
        h('td', { text: isNum(s.observed_km2) && s.observed_km2 > 0 ? F.pct(100 * s.flood_km2 / s.observed_km2) : F.DASH }),
        h('td', { text: F.km2(s.flood_cropland_km2) }),
        h('td', { text: F.km2(s.flood_builtup_km2) }),
        h('td', { text: F.num(s.people_exposed) })));
      note.textContent = 'Coverage = share of the district inside the satellite image. Statistics refer to the observed part only. The study-area total also includes land outside the listed districts, so district rows need not add up to it. Click a row to zoom to the district.';
    } else if (!post && s) {
      note.textContent = st.ref && d <= st.ref
        ? 'Pre-event date: flood statistics start after the ' + F.dateLong(st.ref) + ' reference. Shown: water outside JRC permanent water.'
        : 'No flood statistics for this date.';
    } else note.textContent = '';
  }

  function selectDistrict(name, zoom) {
    st.selDistrict = name;
    const sel = S.$('#bDistrict');
    const opt = Array.prototype.find.call(sel.options, function (o) { return fold(o.value) === fold(name); });
    if (opt) sel.value = opt.value;
    refreshDistricts();
    renderTable();
    renderTop();
    if (zoom && st.distLayer && st.map) {
      st.distLayer.eachLayer(function (l) {
        if (fold(featName(l.feature)) === fold(name)) st.map.flyToBounds(l.getBounds(), { padding: [30, 30], duration: 0.6 });
      });
    }
  }

  /* ---------------------------------------------------------------- method note */
  function renderMethod() {
    const box = S.$('#methodNote');
    S.clear(box);
    const sm = st.summary;
    if (!sm) { box.appendChild(h('p', { class: 'fine', text: 'Method details appear once results/bihar/summary.json has been exported.' })); return; }
    const m = sm.method || {}, aoi = sm.aoi || {};
    const items = [
      ['Water', 'model probability ≥ ' + (m.threshold != null ? m.threshold : 0.5) + ', objects smaller than ' + (m.mmu_px != null ? m.mmu_px + ' px' : 'the MMU') + (isNum(m.mmu_km2) ? ' (' + F.num(m.mmu_km2 * 1e6, 0) + ' m²)' : '') + ' removed'],
      ['Reference', m.reference_date ? F.dateLong(m.reference_date) + ' (last image before the flood peak) + permanent water' : F.DASH],
      ['Permanent water', m.permanent_water || F.DASH],
      ['Flood', 'water on the date AND NOT reference water'],
      ['Grid', [aoi.crs, aoi.pixel_m ? aoi.pixel_m + ' m' : null, aoi.width && aoi.height ? F.num(aoi.width) + ' × ' + F.num(aoi.height) + ' px' : null, isNum(aoi.area_km2) ? F.km2(aoi.area_km2) + ' km²' : null].filter(Boolean).join(' · ')],
    ];
    box.appendChild(h('dl', null, items.map(function (it) { return [h('dt', { text: it[0] }), h('dd', { text: it[1] })]; })));
    const nf = sm.noise_floor;
    if (nf && isNum(nf.new_water_km2)) {
      box.appendChild(h('p', null, h('strong', { text: 'Noise floor. ' }),
        'Between ' + F.dateLong((nf.pair || [])[0]) + ' and ' + F.dateLong((nf.pair || [])[1]) + ', both before the flood, the same method finds ' +
        F.km2(nf.new_water_km2) + ' km² of “new” water (' + F.pct(nf.new_water_pct_of_observed, 2) + ' of the observed area). This is an upper bound on its false-change rate: flood areas well above it are real change.'));
    }
    const dur = sm.duration_km2;
    if (isNum(sm.max_extent_km2) || dur) {
      const parts = [];
      if (isNum(sm.max_extent_km2)) parts.push('Maximum flood extent over all post-event dates: ' + F.km2(sm.max_extent_km2) + ' km².');
      if (dur) {
        const ks = Object.keys(dur).sort();
        parts.push('Duration: ' + ks.map(function (k) {
          const mm = /on_(\d+)_of_(\d+)/.exec(k);
          return F.km2(dur[k]) + ' km² flooded on ' + (mm ? mm[1] + ' of ' + mm[2] : k) + ' dates';
        }).join(', ') + '.');
      }
      box.appendChild(h('p', { text: parts.join(' ') }));
    }
    if (sm.sources) {
      box.appendChild(h('p', { class: 'fine', text: 'Sources: ' + Object.keys(sm.sources).map(function (k) { return sm.sources[k]; }).filter(Boolean).join(' · ') }));
    }
    if (isNum(sm.runtime_s)) box.appendChild(h('p', { class: 'fine', text: 'Analytics run time: ' + F.num(sm.runtime_s, 0) + ' s.' }));
  }

  /* ---------------------------------------------------------------- bulletin */
  function buildBulletin() {
    const dSel = S.$('#bDistrict'), tSel = S.$('#bDate');
    S.clear(dSel); S.clear(tSel);
    const names = districtRows(st.post[0] || st.date).map(function (r) { return r; })
      .sort(function (a, b) { return a.district.localeCompare(b.district); });
    dSel.appendChild(h('option', { value: 'all', text: 'Whole study area (all districts)' }));
    names.forEach(function (r) {
      dSel.appendChild(h('option', { value: r.district, text: r.district + (r.district_hi ? ' · ' + r.district_hi : '') }));
    });
    const dates = st.post.filter(hasFloodStats);
    dates.forEach(function (d) { tSel.appendChild(h('option', { value: d, text: F.dateLong(d) })); });
    if (!dates.length) tSel.appendChild(h('option', { value: '', text: 'no post-event statistics' }));
    if (st.date && dates.indexOf(st.date) >= 0) tSel.value = st.date;
    S.$$('.seg-btn[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () {
        st.lang = b.dataset.lang;
        S.$$('.seg-btn[data-lang]').forEach(function (x) { x.classList.toggle('active', x === b); });
        if (!S.$('#bulletinOut').hidden) generate();
      });
    });
    S.$('#bulletinForm').addEventListener('submit', function (e) { e.preventDefault(); generate(); });
    S.$('#bCopy').addEventListener('click', async function () {
      const ok = await S.copyText(S.$('#bulletinText').textContent);
      S.toast(ok ? 'Bulletin copied to the clipboard' : 'Copy failed: select the text and copy it manually');
    });
    S.$('#bSave').addEventListener('click', function () {
      const pre = S.$('#bulletinText');
      S.download('SARITA_bulletin_' + (pre.dataset.district || 'area').replace(/\W+/g, '_') + '_' + (pre.dataset.date || '') + '_' + (pre.dataset.lang || 'en') + '.txt', pre.textContent);
    });
    S.$('#bGo').disabled = !dates.length;
  }

  async function generate() {
    const district = S.$('#bDistrict').value, date = S.$('#bDate').value, lang = st.lang;
    const msg = S.$('#bulletinMsg'), out = S.$('#bulletinOut'), btn = S.$('#bGo');
    if (!date) return;
    S.msg(msg, null, null);
    btn.disabled = true;
    btn.textContent = 'Generating…';
    const r = await S.api.bulletin(district, date, lang);
    btn.disabled = false;
    btn.textContent = 'Generate bulletin';
    if (!r.ok) {
      out.hidden = true;
      if (S.api.isOffline(r)) {
        msg.hidden = false;
        msg.className = 'msg';
        S.clear(msg).appendChild(S.api.offlineNotice('The bulletin generator'));
      } else {
        S.msg(msg, 'error', S.api.describeError(r) + (r.data && r.data.available_dates ? ' Available dates: ' + r.data.available_dates.map(F.dateLong).join(', ') + '.' : ''));
      }
      return;
    }
    const pre = S.$('#bulletinText');
    pre.textContent = r.data.text || '';
    pre.lang = r.data.lang || lang;
    pre.dataset.district = r.data.district || district;
    pre.dataset.date = r.data.date || date;
    pre.dataset.lang = r.data.lang || lang;
    out.hidden = false;
  }

  /* ================================================================ date switching */
  function setDate(d) {
    if (!d || d === st.date && st.rendered) return;
    st.date = d;
    renderAll();
  }
  function renderAll() {
    st.rendered = true;
    S.$$('#dateBar .date-btn').forEach(function (b) {
      const on = b.dataset.date === st.date;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const sub = S.$('#mapSub');
    if (st.date) {
      const s = dateStats(st.date);
      sub.textContent = 'Sentinel-1 radar, ' + F.dateLong(st.date) + (s && isNum(s.flood_km2) ? ': ' + F.km2(s.flood_km2) + ' km² of new flood water' : '') + '.';
      sub.title = 'Tip: use the ← → keys to step through the dates.';
    }
    refreshLayers();
    refreshDistricts();
    renderKpis();
    const ch = S.getChart('chartSeries');
    if (ch) { ch.data.datasets[0].backgroundColor = barColors(); ch.update('none'); } else renderSeries();
    renderTop();
    renderTable();
    if (!st.methodDone) { renderMethod(); st.methodDone = true; }
    const tSel = S.$('#bDate');
    if (tSel && Array.prototype.some.call(tSel.options, function (o) { return o.value === st.date; })) tSel.value = st.date;
  }

  S.mapPage = {
    init: init,
    onShow: function () {
      if (st.map) setTimeout(function () { st.map.invalidateSize(); }, 30);
    },
    state: st,
  };
})();
