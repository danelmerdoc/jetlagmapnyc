/** Citi Bike hide-and-seek — station elimination + question logic. */
(function () {
  const Geo = () => window.JetLagGeo;
  const COLORS = ['#ffb020', '#4da3ff', '#6bcb77', '#ff6b9d', '#c084fc', '#f97316', '#14b8a6'];
  const STORAGE_KEY = 'jetlagCitibikeQuestionsV2';
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

  function mergedZonesGeoJSON(activeStations) {
    const empty = { type: 'FeatureCollection', features: [] };
    if (!activeStations.length) return empty;
    const latCell = Math.max(hideRadiusMi / 34.5, 0.004);
    const lngCell = Math.max(hideRadiusMi / 26, 0.004);
    const groups = new Map();
    for (const s of activeStations) {
      const key = `${Math.floor(s.lat / latCell)}_${Math.floor(s.lng / lngCell)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const features = [];
    for (const group of groups.values()) {
      let acc = null;
      for (const s of group) {
        const c = turf.circle([s.lng, s.lat], hideRadiusMi, { steps: 10, units: 'miles' });
        if (!acc) { acc = c; continue; }
        try {
          acc = turf.union(turf.featureCollection([acc, c])) || acc;
        } catch (_) { features.push(c); }
      }
      if (acc) features.push(acc);
    }
    return { type: 'FeatureCollection', features };
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
        if (poly) area = Geo().modifyMapData(area, poly, q.answer === 'same');
      } else if (q.type === 'airport' && q.lat != null) {
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, AIRPORTS);
        if (cell) area = Geo().modifyMapData(area, cell, q.answer === 'same');
      }
    }
    return area;
  }

  function eliminatedMask() {
    const possible = possibleAreaFromQuestions();
    if (!possible) return { type: 'FeatureCollection', features: [] };
    return Geo().holedMask(possible);
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (q.type === 'radius' && q.lat != null) {
        const circle = turf.circle([q.lng, q.lat], radiusMiles(q), { steps: 96, units: 'miles' });
        circle.properties = { kind: 'radius-line', id: q.id, color: q.color };
        features.push(circle);
      } else if (q.type === 'thermometer' && q.latA != null && q.latB != null) {
        features.push(turf.feature(turf.lineString([
          [q.lngA, q.latA], [q.lngB, q.latB],
        ]).geometry, { kind: 'thermo-line', id: q.id, color: q.color }));
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

  function questionTitle(q) {
    if (q.type === 'radius') return `Radius · ${q.radius} ${q.unit || 'miles'}`;
    if (q.type === 'thermometer') return 'Thermometer';
    if (q.type === 'borough') return `Borough · ${q.borough || '?'}`;
    return 'Nearest airport';
  }

  function liveBtn(id, field) {
    return `<button type="button" class="game-btn small secondary q-live" data-id="${id}" data-field="${field}">Use my location</button>`;
  }

  function renderList() {
    const el = document.getElementById('cb-game-list');
    if (!el) return;
    el.innerHTML = '';
    if (!questions.length) {
      el.innerHTML = '<p class="game-hint">Add a question, then paste coords, use live location, or drag the pin.</p>';
      return;
    }
    questions.forEach((q, i) => {
      const div = document.createElement('div');
      div.className = 'cb-item' + (q.open ? '' : ' collapsed');
      div.dataset.id = q.id;
      div.innerHTML = `
        <div class="cb-item-head">
          <span class="cb-dot" style="background:${q.color}"></span>
          <strong>${questionTitle(q)}</strong>
          <button type="button" class="icon-btn q-up" data-id="${q.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="icon-btn q-down" data-id="${q.id}" ${i === questions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" class="icon-btn q-toggle" data-id="${q.id}" aria-label="Collapse">${q.open ? '▾' : '▸'}</button>
          <button type="button" class="icon-btn q-rm" data-id="${q.id}" aria-label="Remove">×</button>
        </div>
        <div class="cb-item-body">${renderQuestionFields(q)}</div>`;
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
      head.addEventListener('click', e => {
        if (e.target.closest('.q-rm, .q-up, .q-down')) return;
        const id = head.closest('.cb-item')?.dataset.id;
        const q = questions.find(x => x.id === id);
        if (!q) return;
        q.open = !q.open;
        save(); renderList();
      });
    });
    bindQuestionInputs(el);
  }

  function renderQuestionFields(q) {
    if (q.type === 'radius') {
      return `
        <label>Center</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="Paste Maps link or lat, lng">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        <div class="q-tools">${liveBtn(q.id, 'center')}</div>
        <div class="game-row">
          <input class="q-radius" data-id="${q.id}" type="number" step="any" inputmode="decimal" value="${q.radius}" min="0.01" />
          <select class="q-unit" data-id="${q.id}">
            <option value="miles"${(q.unit || 'miles') === 'miles' ? ' selected' : ''}>miles</option>
            <option value="kilometers"${q.unit === 'kilometers' ? ' selected' : ''}>km</option>
          </select>
        </div>
        <p class="game-hint">Hider is inside or outside this radius. Drag the map pin to move the center.</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="within"${q.answer === 'within' ? ' class="active"' : ''}>Inside</button>
          <button type="button" data-ans="outside"${q.answer === 'outside' ? ' class="active"' : ''}>Outside</button>
        </div>`;
    }
    if (q.type === 'thermometer') {
      return `
        <label>Start</label>
        <textarea class="q-coord-a" data-id="${q.id}" rows="2" placeholder="Paste start location">${q.latA != null ? fmtCoord(q.latA, q.lngA) : ''}</textarea>
        <div class="q-tools">${liveBtn(q.id, 'A')}</div>
        <label>End</label>
        <textarea class="q-coord-b" data-id="${q.id}" rows="2" placeholder="Paste end location">${q.latB != null ? fmtCoord(q.latB, q.lngB) : ''}</textarea>
        <div class="q-tools">${liveBtn(q.id, 'B')}</div>
        <p class="game-hint">If warmer at the end, stations closer to start drop unless their hide circle straddles both sides. Drag the Start/End pins.</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="warmer"${q.answer === 'warmer' ? ' class="active"' : ''}>Warmer at end</button>
          <button type="button" data-ans="colder"${q.answer === 'colder' ? ' class="active"' : ''}>Warmer at start</button>
        </div>`;
    }
    if (q.type === 'borough') {
      const opts = BOROUGHS.map(b =>
        `<option value="${b}"${q.borough === b ? ' selected' : ''}>${b}</option>`,
      ).join('');
      return `
        <label>Your borough</label>
        <select class="q-borough" data-id="${q.id}">${opts}</select>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="same"${q.answer === 'same' ? ' class="active"' : ''}>Same</button>
          <button type="button" data-ans="different"${q.answer === 'different' ? ' class="active"' : ''}>Different</button>
        </div>`;
    }
    if (q.type === 'airport') {
      const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
      return `
        <label>Your location</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="Paste Maps link or coords">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        <div class="q-tools">${liveBtn(q.id, 'center')}</div>
        ${near ? `<p class="game-hint">Nearest: <strong>${near.airport.name}</strong> (${near.miles.toFixed(1)} mi)</p>` : ''}
        <p class="game-hint">Skyports · LaGuardia · JFK</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="same"${q.answer === 'same' ? ' class="active"' : ''}>Same</button>
          <button type="button" data-ans="different"${q.answer === 'different' ? ' class="active"' : ''}>Different</button>
        </div>`;
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
      btn.addEventListener('click', () => {
        if (window.JetLagCitibikeApp?.fillQuestionFromLocation) {
          window.JetLagCitibikeApp.fillQuestionFromLocation(btn.dataset.id, btn.dataset.field);
        }
      });
    });
  }

  function updateQuestionFromInputs(id) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    const root = document.querySelector(`.cb-item[data-id="${id}"]`);
    if (!root) return;
    if (q.type === 'radius' || q.type === 'airport') {
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

  function addQuestion(type) {
    const base = { id: crypto.randomUUID(), type, color: nextColor(), answer: null, open: true };
    if (type === 'radius') {
      const radius = parseFloat(document.getElementById('cb-radius-val')?.value) || 1;
      const unit = document.getElementById('cb-radius-unit')?.value || 'miles';
      questions.push({ ...base, lat: null, lng: null, radius, unit });
    } else if (type === 'thermometer') {
      questions.push({ ...base, latA: null, lngA: null, latB: null, lngB: null });
    } else if (type === 'borough') {
      questions.push({ ...base, borough: 'Manhattan' });
    } else if (type === 'airport') {
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
      };
    });
  }

  function bindUI() {
    document.getElementById('cb-add-radius')?.addEventListener('click', () => addQuestion('radius'));
    document.getElementById('cb-add-thermo')?.addEventListener('click', () => addQuestion('thermometer'));
    document.getElementById('cb-add-borough')?.addEventListener('click', () => addQuestion('borough'));
    document.getElementById('cb-add-airport')?.addEventListener('click', () => addQuestion('airport'));
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
    questionsGeoJSON, eliminatedMask, stationCircle, setQuestionPoint, distMi,
    getQuestions: () => questions,
    get hideRadiusMi() { return hideRadiusMi; },
    get stations() { return stations; },
    set onChange(fn) { onChange = fn; },
    BOROUGHS, AIRPORTS,
  };
})();
