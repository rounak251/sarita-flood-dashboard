/* SARITA dashboard - Results page (#results), driven by web/data/results/experiments.json
 * (written by python -m sarita.export_web experiments). */
(function () {
  'use strict';
  const S = window.SARITA;
  const F = S.fmt, h = S.h, C = S.COLORS, isNum = S.isNum;

  const GROUPS = [
    { key: 'deep', label: 'Deep learning (U-Net family)', color: C.teal },
    { key: 'ensemble', label: 'Ensembles (probability averaging)', color: '#5B8DB8' },
    { key: 'ml', label: 'Classical machine learning', color: '#C99A1C' },
    { key: 'threshold', label: 'Thresholding', color: '#9AA5B1' },
  ];
  const SERIES = ['#0E7C86', '#E4572E', '#2B6CB0', '#C99A1C', '#7B5EA7', '#5B6B7A'];
  let exp = null;

  async function init() {
    exp = await S.data('data/results/experiments.json');
    if (!exp || !Array.isArray(exp.rows)) {
      S.$('#resBody').hidden = true;
      S.msg(S.$('#resMsg'), 'warn', null, 'No results exported yet (<code>web/data/results/experiments.json</code>). Run <code>python -m sarita.export_web experiments</code> after evaluating the models.');
      return;
    }
    if (exp.protocol) S.$('#resProtocol').textContent = 'Protocol: ' + exp.protocol + '.';
    const safe = function (name, fn) {
      try { fn(); } catch (err) { console.error('[SARITA] results/' + name + ' failed', err); }
    };
    safe('kpis', renderKpis);
    safe('table', renderTable);
    safe('compare', renderCompare);
    safe('ablations', renderAblations);
    safe('calibration', renderCalibration);
    safe('risk', renderRisk);
    safe('training', renderTraining);
    safe('events', renderEvents);
    safe('seeds', renderSeeds);
    safe('figures', renderFigures);
  }

  function rowById(id) { return exp.rows.find(function (r) { return r.id === id; }) || null; }
  function methodName(id) { const r = rowById(id); return r ? r.method : id; }
  function score(r, split, k) { return r && r[split] && isNum(r[split][k]) ? r[split][k] : null; }

  /* ---------------------------------------------------------------- KPIs */
  function kpi(label, value, sub, cls) {
    return h('div', { class: 'kpi ' + (cls || '') }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-value', text: value }), sub ? h('div', { class: 'k-sub', text: sub }) : null);
  }
  function renderKpis() {
    const box = S.$('#resKpis');
    S.clear(box);
    const main = rowById(exp.main) || exp.rows[0];
    const cal = exp.calibration || {};
    const bestBase = exp.rows.filter(function (r) { return (r.group === 'ml' || r.group === 'threshold') && !r.reference_labels && isNum(score(r, 'test', 'iou')); })
      .sort(function (a, b) { return score(b, 'test', 'iou') - score(a, 'test', 'iou'); })[0];
    box.appendChild(kpi('Test IoU', F.fixed(score(main, 'test', 'iou'), 3), (main ? main.method : '') + (isNum(score(main, 'test', 'f1')) ? ' · F1 ' + F.fixed(score(main, 'test', 'f1'), 3) : ''), ''));
    box.appendChild(kpi('Bolivia IoU (unseen event)', F.fixed(score(main, 'bolivia', 'iou'), 3), isNum(score(main, 'bolivia', 'f1')) ? 'F1 ' + F.fixed(score(main, 'bolivia', 'f1'), 3) : '', 'water'));
    box.appendChild(kpi('Calibration error (ECE)', isNum(cal.ece_test) ? F.fixed(cal.ece_test, 4) : F.DASH, isNum(cal.ece_bolivia) ? 'test · Bolivia ' + F.fixed(cal.ece_bolivia, 4) : 'test split', 'amber'));
    box.appendChild(kpi('Error-detection AUROC', isNum(cal.error_auroc_test) ? F.fixed(cal.error_auroc_test, 3) : F.DASH,
      bestBase ? 'best baseline test IoU ' + F.fixed(score(bestBase, 'test', 'iou'), 3) + ' (' + bestBase.method + ')' : 'entropy as an error detector', 'muted'));
  }

  /* ---------------------------------------------------------------- main table */
  function fmtScore(r, split, k) {
    const v = score(r, split, k);
    if (!isNum(v)) return F.DASH;
    const sd = r[split + '_std'] && r[split + '_std'][k];
    return F.fixed(v, 3) + (isNum(sd) ? ' ± ' + F.fixed(sd, 3) : '');
  }
  function renderTable() {
    const t = S.$('#expTable');
    S.clear(t.tHead); S.clear(t.tBodies[0]);
    const cols = [['test', 'iou', 'Test IoU'], ['test', 'f1', 'F1'], ['test', 'precision', 'Precision'], ['test', 'recall', 'Recall'],
      ['bolivia', 'iou', 'Bolivia IoU'], ['bolivia', 'f1', 'Bolivia F1']];
    const best = {};
    cols.forEach(function (c) {
      let b = null;
      exp.rows.forEach(function (r) {
        if (r.reference_labels) return;
        const v = score(r, c[0], c[1]);
        if (isNum(v) && (b === null || v > b)) b = v;
      });
      best[c[0] + c[1]] = b;
    });
    t.tHead.appendChild(h('tr', null, h('th', { class: 'left', text: 'Method' }), h('th', { text: 'Params' }),
      cols.map(function (c) { return h('th', { text: c[2] }); })));
    const known = GROUPS.map(function (g) { return g.key; });
    const groups = GROUPS.concat(Array.from(new Set(exp.rows.map(function (r) { return r.group; }).filter(function (g) { return known.indexOf(g) < 0; })))
      .map(function (g) { return { key: g, label: g, color: '#9AA5B1' }; }));
    let anyRef = false;
    groups.forEach(function (g) {
      const rows = exp.rows.filter(function (r) { return r.group === g.key; });
      if (!rows.length) return;
      t.tBodies[0].appendChild(h('tr', { class: 'group-row' }, h('td', { colspan: 2 + cols.length }, h('span', { class: 'group-dot', style: { background: g.color } }), g.label)));
      rows.forEach(function (r) {
        if (r.reference_labels) anyRef = true;
        t.tBodies[0].appendChild(h('tr', { class: r.main ? 'main-row' : '' },
          h('td', { class: 'left wrap' },
            h('strong', { text: r.method + (r.reference_labels ? ' †' : '') }),
            r.main ? h('span', { class: 'tag', style: { marginLeft: '6px' }, text: 'deployed' }) : null,
            r.note ? h('span', { class: 'sub', text: r.note }) : null),
          h('td', { text: isNum(r.params_m) ? F.num(r.params_m, 1) + ' M' : F.DASH }),
          cols.map(function (c) {
            const v = score(r, c[0], c[1]);
            const isBest = !r.reference_labels && isNum(v) && best[c[0] + c[1]] !== null && Math.abs(v - best[c[0] + c[1]]) < 5e-5;
            return h('td', { class: isBest ? 'best' : '', text: fmtScore(r, c[0], c[1]) });
          })));
      });
    });
    const notes = ['IoU = intersection over union of the water class, pooled over all hand-labelled pixels.'];
    if (anyRef) notes.push('† The weak water labels shipped with Sen1Floods11 (Otsu thresholding of the full Sentinel-1 scene, refined by the dataset authors) are scored as a reference product, not as a method applied to the chips, and are excluded from the “best” highlighting.');
    const ds = exp.dataset && exp.dataset.splits;
    if (ds) notes.push('Chips: ' + Object.keys(ds).map(function (k) { return k + ' ' + ds[k].chips; }).join(', ') + '.');
    S.$('#expNote').textContent = notes.join(' ');
  }

  /* ---------------------------------------------------------------- comparison chart */
  function renderCompare() {
    const rows = exp.rows.filter(function (r) { return isNum(score(r, 'test', 'iou')) || isNum(score(r, 'bolivia', 'iou')); })
      .sort(function (a, b) { return (score(b, 'test', 'iou') || 0) - (score(a, 'test', 'iou') || 0); });
    S.$('#cmpBox').style.height = Math.max(260, 70 + rows.length * 34) + 'px';
    S.chart('chartCompare', {
      type: 'bar',
      data: {
        labels: rows.map(function (r) { return r.method + (r.reference_labels ? ' †' : ''); }),
        datasets: [
          { label: 'Test', data: rows.map(function (r) { return score(r, 'test', 'iou'); }), backgroundColor: rows.map(function (r) { return r.main ? C.teal : S.alpha(C.teal, 0.6); }), borderRadius: 3, barPercentage: 0.9, categoryPercentage: 0.75 },
          { label: 'Bolivia (unseen event)', data: rows.map(function (r) { return score(r, 'bolivia', 'iou'); }), backgroundColor: rows.map(function (r) { return r.main ? C.water : S.alpha(C.water, 0.55); }), borderRadius: 3, barPercentage: 0.9, categoryPercentage: 0.75 },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true,
        scales: { x: { min: 0, max: 1, title: { display: true, text: 'water IoU' } }, y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 11 } } } },
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + F.fixed(c.parsed.x, 3); } } } },
      },
    });
  }

  /* ---------------------------------------------------------------- ablations */
  function delta(v) {
    if (!isNum(v)) return h('td', { text: F.DASH });
    return h('td', { class: v > 0.0005 ? 'pos' : v < -0.0005 ? 'neg' : '', text: F.signed(v, 3) });
  }
  function renderAblations() {
    const t = S.$('#ablTable');
    S.clear(t.tHead); S.clear(t.tBodies[0]);
    const ab = exp.ablations || [];
    S.$('#ablEmpty').hidden = ab.length > 1;
    if (!ab.length) return;
    t.tHead.appendChild(h('tr', null, h('th', { class: 'left', text: 'Variant' }), h('th', { text: 'Test IoU' }), h('th', { text: 'Δ' }), h('th', { text: 'Bolivia IoU' }), h('th', { text: 'Δ' })));
    ab.forEach(function (a) {
      t.tBodies[0].appendChild(h('tr', { class: a.reference ? 'main-row' : '' },
        h('td', { class: 'left wrap' }, h('strong', { text: a.reference ? 'Main model' : a.change }), a.reference ? h('span', { class: 'sub', text: a.change }) : h('span', { class: 'sub', text: a.id })),
        h('td', { text: F.fixed(a.test_iou, 3) }), a.reference ? h('td', { text: '' }) : delta(a.delta_test_iou),
        h('td', { text: F.fixed(a.bolivia_iou, 3) }), a.reference ? h('td', { text: '' }) : delta(a.delta_bolivia_iou)));
    });
  }

  /* ---------------------------------------------------------------- calibration */
  function kv(box, pairs) {
    S.clear(box);
    pairs.forEach(function (p) { if (p[1] == null) return; box.appendChild(h('span', { class: 'k', text: p[0] })); box.appendChild(h('span', { class: 'v', text: p[1] })); });
  }
  function relPoints(rel) {
    return (rel || []).filter(function (b) { return b && b.count > 0 && isNum(b.conf) && isNum(b.acc); }).map(function (b) { return { x: b.conf, y: b.acc, n: b.count }; });
  }
  function renderCalibration() {
    const cal = exp.calibration || {};
    const ds = [
      { type: 'line', label: 'Perfect calibration', data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], borderColor: '#B8C1C9', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.4 },
      { type: 'line', label: 'Test', data: relPoints(cal.reliability), borderColor: C.teal, backgroundColor: C.teal, pointRadius: 3, borderWidth: 2 },
    ];
    if (cal.reliability_bolivia) ds.push({ type: 'line', label: 'Bolivia', data: relPoints(cal.reliability_bolivia), borderColor: C.water, backgroundColor: C.water, pointRadius: 2.5, borderWidth: 1.6, borderDash: [3, 2] });
    S.chart('chartRel', {
      data: { datasets: ds },
      options: {
        responsive: true, parsing: false,
        scales: { x: { type: 'linear', min: 0, max: 1, title: { display: true, text: 'predicted water probability' } }, y: { min: 0, max: 1, title: { display: true, text: 'observed water fraction' } } },
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (c) { const p = c.raw; return c.dataset.label + ': p ' + F.fixed(p.x, 2) + ' → ' + F.fixed(p.y, 2) + (p.n ? ' (' + F.num(p.n) + ' px)' : ''); } } } },
      },
    });
    const wt = cal.water_type_recall && cal.water_type_recall.test;
    kv(S.$('#calNumbers'), [
      ['ECE, test (8-view TTA)', isNum(cal.ece_test) ? F.fixed(cal.ece_test, 4) : null],
      ['ECE after temperature scaling', isNum(cal.ece_test_temperature_scaled) ? F.fixed(cal.ece_test_temperature_scaled, 4) + (isNum(cal.temperature) ? ' (T = ' + F.fixed(cal.temperature, 2) + ')' : '') : null],
      ['ECE, Bolivia', isNum(cal.ece_bolivia) ? F.fixed(cal.ece_bolivia, 4) : null],
      ['Recall of permanent water', wt && isNum(wt.permanent_water_recall) ? F.pct(100 * wt.permanent_water_recall) : null],
      ['Recall of flood water', wt && isNum(wt.flood_water_recall) ? F.pct(100 * wt.flood_water_recall) : null],
      ['Test IoU at the validation-tuned threshold', isNum(cal.test_iou_valid_threshold) ? F.fixed(cal.test_iou_valid_threshold, 3) + (isNum(cal.valid_threshold) ? ' (t = ' + F.fixed(cal.valid_threshold, 3) + ')' : '') : null],
    ]);
  }

  function renderRisk() {
    const cal = exp.calibration || {};
    const pts = function (rc) { return (rc || []).filter(function (p) { return isNum(p.coverage) && isNum(p.error_rate); }).map(function (p) { return { x: 100 * p.coverage, y: 100 * p.error_rate }; }); };
    const ds = [];
    if (cal.risk_coverage) ds.push({ label: 'Test, TTA entropy', data: pts(cal.risk_coverage), borderColor: C.teal, backgroundColor: C.teal, pointRadius: 3, borderWidth: 2 });
    if (cal.mc_dropout_risk_coverage) ds.push({ label: 'Test, MC dropout', data: pts(cal.mc_dropout_risk_coverage), borderColor: C.amber, backgroundColor: C.amber, pointRadius: 2.5, borderWidth: 1.8, borderDash: [4, 3] });
    if (cal.risk_coverage_bolivia) ds.push({ label: 'Bolivia, TTA entropy', data: pts(cal.risk_coverage_bolivia), borderColor: C.water, backgroundColor: C.water, pointRadius: 2.5, borderWidth: 1.8 });
    S.chart('chartRisk', {
      type: 'line',
      data: { datasets: ds },
      options: {
        responsive: true, parsing: false,
        scales: { x: { type: 'linear', reverse: true, title: { display: true, text: 'coverage: % of pixels the model keeps' } }, y: { beginAtZero: true, title: { display: true, text: 'error rate (%)' } } },
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + F.fixed(c.parsed.y, 2) + '% error at ' + F.num(c.parsed.x, 0) + '% coverage'; } } } },
      },
    });
  }

  /* ---------------------------------------------------------------- training */
  function renderTraining() {
    const tr = exp.training || {};
    const ids = exp.rows.map(function (r) { return r.id; }).filter(function (id) { return tr[id]; });
    if (!ids.length) Object.keys(tr).slice(0, 5).forEach(function (id) { ids.push(id); });
    S.chart('chartTrain', {
      type: 'line',
      data: {
        datasets: ids.map(function (id, i) {
          const c = tr[id];
          return { label: methodName(id), data: (c.val_epoch || []).map(function (e, j) { return { x: e, y: c.val_iou[j] }; }),
            borderColor: SERIES[i % SERIES.length], backgroundColor: SERIES[i % SERIES.length], pointRadius: 0, borderWidth: id === exp.main ? 2.4 : 1.5, tension: 0.2 };
        }),
      },
      options: {
        responsive: true, parsing: false,
        scales: { x: { type: 'linear', title: { display: true, text: 'epoch' } }, y: { title: { display: true, text: 'validation IoU' } } },
        plugins: { legend: { position: 'bottom', labels: { font: { size: 10.5 } } }, tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + F.fixed(c.parsed.y, 3) + ' (epoch ' + c.parsed.x + ')'; } } } },
      },
    });
    kv(S.$('#trainNumbers'), ids.map(function (id) {
      const c = tr[id];
      return [methodName(id), (isNum(c.best_val_iou) ? F.fixed(c.best_val_iou, 3) : F.DASH) + (isNum(c.best_epoch) ? ' @ ep ' + c.best_epoch : '') +
        (isNum(c.train_time_s) ? ' · ' + F.num(c.train_time_s / 60, 1) + ' min' : '') + (c.device ? ' · ' + c.device : '')];
    }));
  }

  /* ---------------------------------------------------------------- per-event heat table */
  function renderEvents() {
    const pe = exp.per_event;
    const t = S.$('#eventTable');
    S.clear(t.tHead); S.clear(t.tBodies[0]);
    if (!pe || !pe.events || !pe.iou) return;
    const ids = exp.rows.map(function (r) { return r.id; }).filter(function (id) { return pe.iou[id]; });
    t.tHead.appendChild(h('tr', null, h('th', { class: 'left', text: 'Method' }), pe.events.map(function (e) { return h('th', { text: e === 'Bolivia' ? 'Bolivia*' : e }); })));
    ids.forEach(function (id) {
      const r = rowById(id);
      t.tBodies[0].appendChild(h('tr', { class: r && r.main ? 'main-row' : '' }, h('td', { class: 'left' }, h('strong', { text: methodName(id) + (r && r.reference_labels ? ' †' : '') })),
        pe.events.map(function (e) {
          const v = pe.iou[id][e];
          const col = S.heat(v, 0, 1);
          return h('td', { class: 'cell', style: { background: col.bg, color: col.fg }, text: isNum(v) ? v.toFixed(2) : F.DASH });
        })));
    });
  }

  /* ---------------------------------------------------------------- seeds */
  function renderSeeds() {
    const seeds = exp.seeds || {};
    const keys = Object.keys(seeds);
    S.$('#seedCard').hidden = !keys.length;
    if (!keys.length) return;
    const t = S.$('#seedTable');
    S.clear(t.tHead); S.clear(t.tBodies[0]);
    t.tHead.appendChild(h('tr', null, h('th', { class: 'left', text: 'Model' }), h('th', { text: 'Seeds' }), h('th', { text: 'Test IoU' }), h('th', { text: 'Test F1' }), h('th', { text: 'Bolivia IoU' }), h('th', { text: 'Bolivia F1' })));
    const ms = function (o) { return o && isNum(o.mean) ? F.fixed(o.mean, 3) + (isNum(o.std) ? ' ± ' + F.fixed(o.std, 3) : '') : F.DASH; };
    keys.forEach(function (k) {
      const b = seeds[k];
      t.tBodies[0].appendChild(h('tr', null, h('td', { class: 'left' }, h('strong', { text: b.method || k }), h('span', { class: 'sub', text: (b.runs || []).join(', ') })),
        h('td', { text: String(b.n || (b.runs || []).length) }),
        h('td', { text: ms(b.test && b.test.iou) }), h('td', { text: ms(b.test && b.test.f1) }),
        h('td', { text: ms(b.bolivia && b.bolivia.iou) }), h('td', { text: ms(b.bolivia && b.bolivia.f1) })));
    });
  }

  /* ---------------------------------------------------------------- figures */
  function caption(path) {
    return path.split('/').pop().replace(/\.[a-z]+$/i, '').replace(/^fig_/, '').replace(/[_-]+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }
  function renderFigures() {
    const figs = (exp.figures || []).filter(function (p) { return /\.(png|jpe?g|svg)$/i.test(p); });
    S.$('#figCard').hidden = !figs.length;
    const grid = S.$('#figGrid');
    S.clear(grid);
    figs.forEach(function (p) {
      grid.appendChild(h('button', { type: 'button', class: 'fig', on: { click: function () { S.lightbox(p, caption(p)); } } },
        h('img', { src: p, alt: caption(p), loading: 'lazy' }), h('div', { class: 'f-cap', text: caption(p) })));
    });
  }

  S.resultsPage = { init: init, onShow: function () {} };
})();
