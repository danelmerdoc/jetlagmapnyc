/** Citi Bike hide-and-seek — station elimination + question logic. */
(function () {
  const Geo = () => window.JetLagGeo;
  const COLORS = ['#7c4dff', '#2563eb', '#0d9488', '#db2777', '#ea580c', '#4f46e5'];
  const STORAGE_KEY = 'jetlagCitibikeQuestionsV3';
  const BOROUGHS = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island', 'Jersey'];
  const AIRPORTS = [
    { id: 'skyports', code: '6N7', name: 'NY Skyports Seaplane Base', lat: 40.7348, lng: -73.9726 },
    { id: 'lga', code: 'LGA', name: 'LaGuardia', lat: 40.7769, lng: -73.8740 },
    { id: 'jfk', code: 'JFK', name: 'JFK', lat: 40.6413, lng: -73.7781 },
  ];

  let colorIdx = 0;
  let questions = [];
  let hideRadiusMi = 0.2;
  let stations = [];
  let boroughPolys = {};
  let coastFeature = null;
  let onChange = null;

  function nextColor() {
    const c = COLORS[colorIdx % COLORS.length];
    colorIdx += 1;
    return c;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) questions = JSON.parse(raw);
    } catch (_) { questions = []; }
    questions.forEach(q => {
      if (q.open == null) q.open = false;
      if (q.type === 'thermometer') {
        if (!q.colorA) q.colorA = q.color || COLORS[0];
        if (!q.colorB) q.colorB = COLORS[(COLORS.indexOf(q.colorA) + 2) % COLORS.length];
      }
    });
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(questions));
  }

  function parseCoord(text) {
    const s = (text || '').trim();
    if (!s) return null;
    const atMatch = s.match(/@(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
    if (atMatch) return { lat: +atMatch[1], lng: +atMatch[2] };
    const qMatch = s.match(/[?&]q=(-?\d+\.?\d*)[,\s+]+(-?\d+\.?\d*)/i);
    if (qMatch) return { lat: +qMatch[1], lng: +qMatch[2] };
    const d3d4 = s.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/i);
    if (d3d4) return { lat: +d3d4[1], lng: +d3d4[2] };
    const llMatch = s.match(/ll=(-?\d+\.?\d*)[,%2C\s]+(-?\d+\.?\d*)/i);
    if (llMatch) return { lat: +llMatch[1], lng: +llMatch[2] };
    const nums = s.replace(/[^\d.\-+eE]/g, ' ').trim().split(/\s+/).map(Number).filter(n => !Number.isNaN(n));
    if (nums.length >= 2) {
      let a = nums[0], b = nums[1];
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) return { lat: a, lng: b };
      if (Math.abs(b) <= 90 && Math.abs(a) <= 180 && Math.abs(a) > 90) return { lat: b, lng: a };
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
      return { lat: b, lng: a };
    }
    return null;
  }

  function fmtCoord(lat, lng) {
    return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
  }

  function fmtPretty(lat, lng) {
    if (lat == null || lng == null) return 'Tap locate\nor paste';
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(5)}° ${ns}\n${Math.abs(lng).toFixed(5)}° ${ew}`;
  }

  function distToCoast(lat, lng) {
    if (!coastFeature) return Infinity;
    const pt = turf.point([lng, lat]);
    const g = coastFeature.geometry;
    if (g.type === 'LineString') {
      return turf.pointToLineDistance(pt, coastFeature, { units: 'miles' });
    }
    let best = Infinity;
    for (const coords of g.coordinates || []) {
      try {
        const d = turf.pointToLineDistance(pt, turf.lineString(coords), { units: 'miles' });
        if (d < best) best = d;
      } catch (_) { /* skip */ }
    }
    return best;
  }

  function stationCircle(st) {
    return turf.circle([st.lng, st.lat], hideRadiusMi, { steps: 64, units: 'miles' });
  }

  function distMi(a, b) {
    return turf.distance(turf.point([a.lng, a.lat]), turf.point([b.lng, b.lat]), { units: 'miles' });
  }

  function radiusMiles(q) {
    const r = Number(q.radius) || 0;
    return (q.unit === 'kilometers') ? r / 1.609344 : r;
  }

  function nearestAirport(pt) {
    let best = null, bestD = Infinity;
    for (const a of AIRPORTS) {
      const d = distMi(pt, a);
      if (d < bestD) { bestD = d; best = a; }
    }
    return { airport: best, miles: bestD };
  }

  function circleReachesPoly(st, poly) {
    if (!poly) return false;
    try {
      return turf.booleanIntersects(
        turf.circle([st.lng, st.lat], hideRadiusMi, { steps: 16, units: 'miles' }),
        poly,
      );
    } catch (_) { return false; }
  }

  function circleFullyInsidePoly(st, poly) {
    if (!poly) return false;
    try {
      return turf.booleanContains(
        poly,
        turf.circle([st.lng, st.lat], hideRadiusMi, { steps: 16, units: 'miles' }),
      );
    } catch (_) { return false; }
  }

  function thermoStraddles(st, q) {
    const a = turf.point([q.lngA, q.latA]);
    const b = turf.point([q.lngB, q.latB]);
    const mid = turf.midpoint(a, b);
    const bearing = turf.bearing(a, b);
    const stPt = turf.point([st.lng, st.lat]);
    const distToMid = turf.distance(stPt, mid, { units: 'miles' });
    const bearToSt = turf.bearing(mid, stPt);
    let diff = bearToSt - (bearing + 90);
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return Math.abs(Math.sin(diff * Math.PI / 180) * distToMid) <= hideRadiusMi + 1e-9;
  }

  function possibleAirportIds(st) {
    const h = hideRadiusMi;
    const out = [];
    for (const a of AIRPORTS) {
      const da = distMi(st, a);
      let ok = true;
      for (const b of AIRPORTS) {
        if (a.id === b.id) continue;
        if (da - distMi(st, b) > 2 * h) { ok = false; break; }
      }
      if (ok) out.push(a.id);
    }
    return out;
  }

  function stationPassesQuestion(st, q) {
    if (q.answer == null) return true;
    if (q.type === 'radius') {
      if (q.lat == null || q.lng == null) return true;
      const d = distMi(st, { lat: q.lat, lng: q.lng });
      const r = radiusMiles(q);
      const cutoff = r + hideRadiusMi;
      if (q.answer === 'within') return d <= cutoff + 1e-9;
      return d + hideRadiusMi > r + 1e-9;
    }
    if (q.type === 'thermometer') {
      if (q.latA == null || q.latB == null) return true;
      if (thermoStraddles(st, q)) return true;
      const closerToEnd = distMi(st, { lat: q.latB, lng: q.lngB }) < distMi(st, { lat: q.latA, lng: q.lngA });
      return q.answer === 'warmer' ? closerToEnd : !closerToEnd;
    }
    if (q.type === 'borough') {
      const poly = boroughPolys[q.borough];
      if (q.answer === 'same') {
        if (st.borough === q.borough) return true;
        return circleReachesPoly(st, poly);
      }
      if (st.borough !== q.borough) return true;
      return !circleFullyInsidePoly(st, poly);
    }
    if (q.type === 'airport') {
      if (q.lat == null) return true;
      const seeker = nearestAirport({ lat: q.lat, lng: q.lng }).airport;
      if (!seeker) return true;
      const possible = possibleAirportIds(st);
      if (q.answer === 'same') return possible.includes(seeker.id);
      return possible.some(id => id !== seeker.id);
    }
    if (q.type === 'coastline') {
      if (q.lat == null) return true;
      const measure = distToCoast(q.lat, q.lng);
      const d = st.coastMi != null ? st.coastMi : distToCoast(st.lat, st.lng);
      if (q.answer === 'closer') return d - hideRadiusMi <= measure + 1e-9;
      return d + hideRadiusMi >= measure - 1e-9;
    }
    return true;
  }

  function getActiveStations() {
    const locked = questions.filter(q => q.answer != null);
    if (!locked.length) return stations.slice();
    return stations.filter(st => locked.every(q => stationPassesQuestion(st, q)));
  }

  function activeStationFeatures(activeSet) {
    const meters = hideRadiusMi * 1609.344;
    const mPerPxZ20 = 40075016.686 / (256 * 2 ** 20);
    return activeSet.map(st => ({
      type: 'Feature',
      properties: {
        id: st.id,
        name: st.name,
        borough: st.borough,
        r20: meters / mPerPxZ20 / Math.cos(st.lat * Math.PI / 180),
      },
      geometry: { type: 'Point', coordinates: [st.lng, st.lat] },
    }));
  }

  function mergedZonesGeoJSON(activeStations, bbox) {
    const empty = { type: 'FeatureCollection', features: [] };
    let list = activeStations;
    if (bbox) {
      const pad = hideRadiusMi / 50;
      list = activeStations.filter(s =>
        s.lng >= bbox[0] - pad && s.lat >= bbox[1] - pad &&
        s.lng <= bbox[2] + pad && s.lat <= bbox[3] + pad);
    }
    if (!list.length) return empty;
    const circles = list.map(s => {
      const c = turf.circle([s.lng, s.lat], hideRadiusMi, { steps: 8, units: 'miles' });
      c.properties = { k: 1 };
      return c;
    });
    const fc = turf.featureCollection(circles);
    try {
      if (typeof turf.dissolve === 'function') {
        const d = turf.dissolve(fc, { propertyName: 'k' });
        if (d) return d.type === 'FeatureCollection' ? d : { type: 'FeatureCollection', features: [d] };
      }
    } catch (_) { /* fall through */ }
    try {
      const mp = turf.multiPoint(list.map(s => [s.lng, s.lat]));
      const buf = turf.buffer(mp, hideRadiusMi, { units: 'miles', steps: 8 });
      if (buf) return buf.type === 'FeatureCollection' ? buf : { type: 'FeatureCollection', features: [buf] };
    } catch (_) { /* fall through */ }
    return fc;
  }

  function possibleAreaFromQuestions() {
    const qs = questions.filter(q => q.answer != null);
    if (!qs.length) return null;
    let area = Geo().WORLD;
    for (const q of qs) {
      if (q.type === 'radius' && q.lat != null && q.lng != null) {
        const r = radiusMiles(q);
        if (q.answer === 'within') {
          const c = turf.circle([q.lng, q.lat], r + hideRadiusMi, { steps: 96, units: 'miles' });
          area = Geo().modifyMapData(area, c, true);
        } else {
          const inner = r - hideRadiusMi;
          if (inner > 0.001) {
            const c = turf.circle([q.lng, q.lat], inner, { steps: 96, units: 'miles' });
            area = Geo().modifyMapData(area, c, false);
          }
        }
      } else if (q.type === 'thermometer' && q.latA != null && q.latB != null) {
        area = Geo().modifyMapData(area, Geo().thermometerRegion(q, q.answer === 'warmer'), true);
      } else if (q.type === 'borough') {
        const poly = boroughPolys[q.borough];
        if (poly) {
          try {
            if (q.answer === 'same') {
              const expanded = turf.buffer(poly, hideRadiusMi, { units: 'miles', steps: 16 });
              if (expanded) area = Geo().modifyMapData(area, expanded, true);
            } else {
              const shrunk = turf.buffer(poly, -hideRadiusMi, { units: 'miles', steps: 16 });
              if (shrunk) area = Geo().modifyMapData(area, shrunk, false);
            }
          } catch (_) {
            area = Geo().modifyMapData(area, poly, q.answer === 'same');
          }
        }
      } else if (q.type === 'airport' && q.lat != null) {
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, AIRPORTS);
        if (cell) {
          try {
            if (q.answer === 'same') {
              const expanded = turf.buffer(cell, hideRadiusMi, { units: 'miles', steps: 16 });
              if (expanded) area = Geo().modifyMapData(area, expanded, true);
            } else {
              const shrunk = turf.buffer(cell, -hideRadiusMi, { units: 'miles', steps: 16 });
              if (shrunk) area = Geo().modifyMapData(area, shrunk, false);
            }
          } catch (_) {
            area = Geo().modifyMapData(area, cell, q.answer === 'same');
          }
        }
      } else if (q.type === 'coastline' && q.lat != null && coastFeature) {
        const measure = distToCoast(q.lat, q.lng);
        try {
          if (q.answer === 'closer') {
            const buf = turf.buffer(coastFeature, measure + hideRadiusMi, { units: 'miles', steps: 16 });
            if (buf) area = Geo().modifyMapData(area, buf, true);
          } else {
            const inner = measure - hideRadiusMi;
            if (inner > 0.001) {
              const buf = turf.buffer(coastFeature, inner, { units: 'miles', steps: 16 });
              if (buf) area = Geo().modifyMapData(area, buf, false);
            }
          }
        } catch (_) { /* skip coastline mask */ }
      }
    }
    return area;
  }

  function eliminatedMask() {
    const possible = possibleAreaFromQuestions();
    if (!possible) return { type: 'FeatureCollection', features: [] };
    return Geo().holedMask(possible);
  }

  function possibleAreaGeoJSON() {
    const possible = possibleAreaFromQuestions();
    if (!possible) return { type: 'FeatureCollection', features: [] };
    const f = Geo().safePoly(possible);
    if (!f) return { type: 'FeatureCollection', features: [] };
    return { type: 'FeatureCollection', features: [f] };
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (q.type === 'radius' && q.lat != null) {
        const circle = turf.circle([q.lng, q.lat], radiusMiles(q), { steps: 96, units: 'miles' });
        circle.properties = { kind: 'radius-line', id: q.id, color: q.color };
        features.push(circle);
      } else if (q.type === 'thermometer' && q.latA != null && q.latB != null) {
        const bisector = Geo().thermometerBisectorLine(q);
        bisector.properties = {
          kind: 'thermo-bisector', id: q.id, color: q.colorB || q.color,
        };
        features.push(bisector);
      } else if (q.type === 'coastline' && q.lat != null) {
        features.push(turf.feature(turf.point([q.lng, q.lat]).geometry, {
          kind: 'coast-point', id: q.id, color: q.color,
        }));
      } else if (q.type === 'airport' && q.lat != null) {
        for (const a of AIRPORTS) {
          features.push(turf.feature(turf.point([a.lng, a.lat]).geometry, {
            kind: 'airport', id: q.id, code: a.code, name: a.name, color: q.color,
          }));
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const TYPE_OPTS = [
    ['radius', 'Radius Question'],
    ['thermometer', 'Thermometer Question'],
    ['coastline', 'Coastline Question'],
    ['borough', 'Same Borough'],
    ['airport', 'Same Airport'],
  ];

  const ICON = {
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>',
    locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    paste: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v5M14 11v5"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l-6 6h4v8h4v-8h4z"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19l6-6h-4V5h-4v8H6z"/></svg>',
    chevDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    chevRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  };

  function questionTitle(q, index) {
    if (q.type === 'borough' || q.type === 'airport' || q.type === 'coastline') {
      const n = questions.slice(0, index + 1).filter(x =>
        x.type === 'borough' || x.type === 'airport' || x.type === 'coastline').length;
      return `Measuring ${n}`;
    }
    const n = questions.slice(0, index + 1).filter(x => x.type === q.type).length;
    if (q.type === 'radius') return `Radius ${n}`;
    if (q.type === 'thermometer') return `Thermometer ${n}`;
    return `Question ${n}`;
  }

  function locCard(q, title, field, lat, lng, bgColor) {
    const pretty = fmtPretty(lat, lng).replace('\n', '<br>');
    const bg = bgColor || q.color;
    return `
      <div class="loc-card" style="background:${bg}" data-id="${q.id}" data-field="${field}">
        <div class="loc-top">
          <div class="loc-title">${title}</div>
          <div class="loc-coords">${pretty}</div>
        </div>
        <div class="loc-actions">
          <button type="button" class="q-edit" title="Edit coordinates">${ICON.edit}</button>
          <button type="button" class="q-live" data-id="${q.id}" data-field="${field}" title="Use my location">${ICON.locate}</button>
          <button type="button" class="q-copy" title="Copy">${ICON.copy}</button>
          <button type="button" class="q-paste" title="Paste">${ICON.paste}</button>
        </div>
        <div class="loc-edit" hidden>
          <textarea class="${field === 'A' ? 'q-coord-a' : field === 'B' ? 'q-coord-b' : 'q-coord'}" data-id="${q.id}" rows="2" placeholder="Paste Maps link or lat, lng">${lat != null ? fmtCoord(lat, lng) : ''}</textarea>
        </div>
      </div>`;
  }

  function resultRow(q, left, right) {
    return `
      <div class="result-row q-answer" data-id="${q.id}">
        <span>Result</span>
        <button type="button" data-ans="${left.ans}"${q.answer === left.ans ? ' class="active"' : ''}>${left.label}</button>
        <button type="button" data-ans="${right.ans}"${q.answer === right.ans ? ' class="active"' : ''}>${right.label}</button>
      </div>`;
  }

  function renderList() {
    const el = document.getElementById('cb-game-list');
    if (!el) return;
    el.innerHTML = '';
    if (!questions.length) {
      el.innerHTML = '<p class="game-hint">Add a question, then locate, paste, or drag the pin.</p>';
      return;
    }
    questions.forEach((q, i) => {
      const div = document.createElement('div');
      div.className = 'cb-item' + (q.open ? '' : ' collapsed');
      div.dataset.id = q.id;
      const typeSel = TYPE_OPTS.map(([id, label]) =>
        `<option value="${id}"${q.type === id ? ' selected' : ''}>${label}</option>`).join('');
      div.innerHTML = `
        <div class="cb-item-head">
          <span class="cb-item-chev">${q.open ? ICON.chevDown : ICON.chevRight}</span>
          <span>${questionTitle(q, i)}</span>
        </div>
        <div class="cb-item-body">
          <select class="q-type" data-id="${q.id}">${typeSel}</select>
          ${renderQuestionFields(q)}
          <div class="q-foot">
            <button type="button" class="q-up" data-id="${q.id}" ${i === 0 ? 'disabled' : ''} title="Move up">${ICON.up}</button>
            <button type="button" class="q-down" data-id="${q.id}" ${i === questions.length - 1 ? 'disabled' : ''} title="Move down">${ICON.down}</button>
            <button type="button" class="q-rm" data-id="${q.id}" title="Delete">${ICON.trash}</button>
          </div>
        </div>`;
      el.appendChild(div);
    });
    el.querySelectorAll('.q-rm').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        questions = questions.filter(x => x.id !== btn.dataset.id);
        save(); notifyChange(); renderList();
      });
    });
    el.querySelectorAll('.q-up').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); moveQuestion(btn.dataset.id, -1); });
    });
    el.querySelectorAll('.q-down').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); moveQuestion(btn.dataset.id, 1); });
    });
    el.querySelectorAll('.cb-item-head').forEach(head => {
      head.addEventListener('click', () => {
        const id = head.closest('.cb-item')?.dataset.id;
        const q = questions.find(x => x.id === id);
        if (!q) return;
        q.open = !q.open;
        save(); renderList();
      });
    });
    el.querySelectorAll('.q-type').forEach(sel => {
      sel.addEventListener('change', () => changeType(sel.dataset.id, sel.value));
    });
    bindQuestionInputs(el);
  }

  function renderQuestionFields(q) {
    if (q.type === 'radius') {
      return `
        ${locCard(q, 'Location', 'center', q.lat, q.lng)}
        <div class="game-row">
          <input class="q-radius" data-id="${q.id}" type="number" step="any" inputmode="decimal" value="${q.radius}" min="0.01" />
          <select class="q-unit" data-id="${q.id}">
            <option value="miles"${(q.unit || 'miles') === 'miles' ? ' selected' : ''}>miles</option>
            <option value="kilometers"${q.unit === 'kilometers' ? ' selected' : ''}>km</option>
          </select>
        </div>
        ${resultRow(q, { ans: 'outside', label: 'Hider Outside' }, { ans: 'within', label: 'Hider Inside' })}`;
    }
    if (q.type === 'thermometer') {
      const dist = (q.latA != null && q.latB != null)
        ? distMi({ lat: q.latA, lng: q.lngA }, { lat: q.latB, lng: q.lngB })
        : null;
      return `
        ${locCard(q, 'Start', 'A', q.latA, q.lngA, q.colorA || q.color)}
        ${locCard(q, 'End', 'B', q.latB, q.lngB, q.colorB || '#2563eb')}
        ${dist != null ? `<p class="game-hint">Distance: <strong>${dist.toFixed(3)} Miles</strong></p>` : ''}
        ${resultRow(q, { ans: 'colder', label: 'Colder' }, { ans: 'warmer', label: 'Warmer' })}`;
    }
    if (q.type === 'coastline') {
      const d = q.lat != null ? distToCoast(q.lat, q.lng) : null;
      return `
        ${locCard(q, 'Location', 'center', q.lat, q.lng)}
        ${d != null && isFinite(d) ? `<p class="game-hint">${d.toFixed(2)} mi from coast</p>` : ''}
        ${resultRow(q, { ans: 'further', label: 'Hider Further' }, { ans: 'closer', label: 'Hider Closer' })}`;
    }
    if (q.type === 'borough') {
      const opts = BOROUGHS.map(b =>
        `<option value="${b}"${q.borough === b ? ' selected' : ''}>${b}</option>`).join('');
      return `
        <select class="q-borough" data-id="${q.id}">${opts}</select>
        ${resultRow(q, { ans: 'different', label: 'Different' }, { ans: 'same', label: 'Same borough' })}`;
    }
    if (q.type === 'airport') {
      const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
      return `
        ${locCard(q, 'Location', 'center', q.lat, q.lng)}
        ${near ? `<p class="game-hint">Nearest: ${near.airport.name} (${near.miles.toFixed(1)} mi)</p>` : ''}
        ${resultRow(q, { ans: 'different', label: 'Different' }, { ans: 'same', label: 'Same airport' })}`;
    }
    return '';
  }

  function bindQuestionInputs(el) {
    el.querySelectorAll('.q-coord, .q-coord-a, .q-coord-b').forEach(ta => {
      ta.addEventListener('change', () => updateQuestionFromInputs(ta.dataset.id));
      ta.addEventListener('blur', () => updateQuestionFromInputs(ta.dataset.id));
    });
    el.querySelectorAll('.q-radius, .q-unit, .q-borough').forEach(inp => {
      inp.addEventListener('change', () => updateQuestionFromInputs(inp.dataset.id));
    });
    el.querySelectorAll('.q-answer button').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = questions.find(x => x.id === btn.closest('.q-answer').dataset.id);
        if (!q) return;
        q.answer = btn.dataset.ans;
        save(); notifyChange(); renderList();
      });
    });
    el.querySelectorAll('.q-live').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        window.JetLagCitibikeApp?.fillQuestionFromLocation?.(btn.dataset.id, btn.dataset.field);
      });
    });
    el.querySelectorAll('.q-edit').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const wrap = btn.closest('.loc-card')?.querySelector('.loc-edit');
        if (wrap) wrap.hidden = !wrap.hidden;
      });
    });
    el.querySelectorAll('.q-copy').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const card = btn.closest('.loc-card');
        const ta = card?.querySelector('textarea');
        if (ta?.value) navigator.clipboard?.writeText(ta.value);
      });
    });
    el.querySelectorAll('.q-paste').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const card = btn.closest('.loc-card');
        const ta = card?.querySelector('textarea');
        try {
          const text = await navigator.clipboard.readText();
          if (ta) ta.value = text;
          updateQuestionFromInputs(card.dataset.id);
        } catch (_) {
          const edit = ta?.closest('.loc-edit');
          if (edit) { edit.hidden = false; ta.focus(); }
        }
      });
    });
  }

  function updateQuestionFromInputs(id) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    const root = document.querySelector(`.cb-item[data-id="${id}"]`);
    if (!root) return;
    if (q.type === 'radius' || q.type === 'airport' || q.type === 'coastline') {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
      if (q.type === 'radius') {
        q.radius = parseFloat(root.querySelector('.q-radius')?.value) || q.radius;
        q.unit = root.querySelector('.q-unit')?.value || 'miles';
      }
    } else if (q.type === 'thermometer') {
      const a = parseCoord(root.querySelector('.q-coord-a')?.value);
      const b = parseCoord(root.querySelector('.q-coord-b')?.value);
      if (a) { q.latA = a.lat; q.lngA = a.lng; }
      if (b) { q.latB = b.lat; q.lngB = b.lng; }
    } else if (q.type === 'borough') {
      q.borough = root.querySelector('.q-borough')?.value || q.borough;
    }
    save(); notifyChange();
  }

  function setQuestionPoint(id, field, lat, lng) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    if (field === 'center') { q.lat = lat; q.lng = lng; }
    else if (field === 'A') { q.latA = lat; q.lngA = lng; }
    else if (field === 'B') { q.latB = lat; q.lngB = lng; }
    save(); notifyChange(); renderList();
  }

  function moveQuestion(id, dir) {
    const i = questions.findIndex(q => q.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= questions.length) return;
    const tmp = questions[i];
    questions[i] = questions[j];
    questions[j] = tmp;
    save(); notifyChange(); renderList();
  }

  function changeType(id, type) {
    const q = questions.find(x => x.id === id);
    if (!q || q.type === type) return;
    q.type = type;
    q.answer = null;
    if (type === 'radius') {
      if (q.radius == null) q.radius = parseFloat(document.getElementById('cb-radius-val')?.value) || 1;
      if (!q.unit) q.unit = 'miles';
    }
    if (type === 'borough' && !q.borough) q.borough = 'Manhattan';
    if (type === 'thermometer') {
      if (!q.colorA) q.colorA = q.color || nextColor();
      if (!q.colorB) q.colorB = nextColor();
    }
    save(); notifyChange(); renderList();
  }

  function addQuestion(type) {
    const base = { id: crypto.randomUUID(), type, color: nextColor(), answer: null, open: true };
    if (type === 'radius') {
      const radius = parseFloat(document.getElementById('cb-radius-val')?.value) || 1;
      const unit = document.getElementById('cb-radius-unit')?.value || 'miles';
      questions.push({ ...base, lat: null, lng: null, radius, unit });
    } else if (type === 'thermometer') {
      const colorA = base.color;
      const colorB = nextColor();
      questions.push({ ...base, colorA, colorB, color: colorA, latA: null, lngA: null, latB: null, lngB: null });
    } else if (type === 'borough') {
      questions.push({ ...base, borough: 'Manhattan' });
    } else if (type === 'airport' || type === 'coastline') {
      questions.push({ ...base, lat: null, lng: null });
    }
    save(); renderList(); notifyChange();
  }

  function notifyChange() {
    if (onChange) onChange();
  }

  async function initStationData(geojson) {
    try {
      const boro = await (await fetch('data/nyc_boroughs.geojson')).json();
      for (const f of boro.features) boroughPolys[f.properties.BoroName] = f;
      const union = Geo().unionMany(boro.features);
      const njBox = turf.bboxPolygon([-74.35, 40.55, -73.85, 41.05]);
      try {
        boroughPolys.Jersey = turf.difference(turf.featureCollection([njBox, union])) || njBox;
      } catch (_) {
        boroughPolys.Jersey = njBox;
      }
    } catch (e) {
      console.warn('borough load failed', e);
    }
    try {
      const coast = await (await fetch('data/coastline.geojson')).json();
      coastFeature = coast.features?.[0] || null;
    } catch (e) {
      console.warn('coastline load failed', e);
    }

    stations = (geojson.features || []).map((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      let borough = 'Jersey';
      const pt = turf.point([lng, lat]);
      for (const [name, poly] of Object.entries(boroughPolys)) {
        if (name === 'Jersey') continue;
        if (turf.booleanPointInPolygon(pt, poly)) { borough = name; break; }
      }
      return {
        id: `${lng.toFixed(6)}_${lat.toFixed(6)}_${i}`,
        name: f.properties.name || `Station ${i}`,
        lng, lat, borough,
        coastMi: distToCoast(lat, lng),
      };
    });
  }

  function bindUI() {
    document.getElementById('cb-add-radius')?.addEventListener('click', () => addQuestion('radius'));
    document.getElementById('cb-add-thermo')?.addEventListener('click', () => addQuestion('thermometer'));
    document.getElementById('cb-add-borough')?.addEventListener('click', () => addQuestion('borough'));
    document.getElementById('cb-add-airport')?.addEventListener('click', () => addQuestion('airport'));
    document.getElementById('cb-add-coast')?.addEventListener('click', () => addQuestion('coastline'));
    document.getElementById('cb-clear-all')?.addEventListener('click', () => {
      if (!confirm('Remove all questions?')) return;
      questions = []; save(); notifyChange(); renderList();
    });
    document.getElementById('cb-hide-radius')?.addEventListener('input', e => {
      hideRadiusMi = Math.max(0.05, parseFloat(e.target.value) || 0.2);
      const lbl = document.getElementById('cb-hide-radius-label');
      if (lbl) lbl.textContent = `${hideRadiusMi.toFixed(2)} mi`;
      notifyChange();
    });
  }

  load();

  window.JetLagCitibikeGame = {
    parseCoord, fmtCoord, bindUI, renderList, initStationData,
    getActiveStations, activeStationFeatures, mergedZonesGeoJSON,
    questionsGeoJSON, eliminatedMask, possibleAreaGeoJSON, stationCircle, setQuestionPoint, distMi,
    getQuestions: () => questions,
    get hideRadiusMi() { return hideRadiusMi; },
    get stations() { return stations; },
    set onChange(fn) { onChange = fn; },
    BOROUGHS, AIRPORTS,
  };
})();
