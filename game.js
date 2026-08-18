/** Jet Lag NYC — question logic with map elimination (inspired by JetLagHideAndSeek). */
(function () {
  const Geo = () => window.JetLagGeo;
  const COLORS = ['#ffb020', '#4da3ff', '#6bcb77', '#ff6b9d', '#c084fc', '#f97316', '#14b8a6'];
  const STORAGE_KEY = 'jetlagNycQuestionsV2';
  const PLAY_AIRPORTS = [
    { id: 'lga', code: 'LGA', name: 'LaGuardia Airport', lat: 40.7757145, lng: -73.8733640 },
    { id: 'jfk', code: 'JFK', name: 'John F. Kennedy International Airport', lat: 40.6429479, lng: -73.7793734 },
    { id: 'skyports', code: '6N7', name: 'NY Skyports Seaplane Base', lat: 40.7351534, lng: -73.9729007 },
  ];

  let colorIdx = 0;
  let questions = [];
  let mapRef = null;
  let mapClickBound = false;
  let placeMode = null;
  let boroughArea = null;

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
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(questions));
  }

  function parseCoord(text) {
    const s = (text || '').trim();
    if (!s) return null;
    const parts = s.split(/[,\s]+/).map(Number).filter(n => !Number.isNaN(n));
    if (parts.length < 2) return null;
    let a = parts[0], b = parts[1];
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) return { lat: a, lng: b };
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
    return { lat: a, lng: b };
  }

  function fmtCoord(lat, lng) {
    return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
  }

  function nearestAirport(pt) {
    let best = null, bestD = Infinity;
    for (const a of PLAY_AIRPORTS) {
      const d = turf.distance(turf.point([pt.lng, pt.lat]), turf.point([a.lng, a.lat]), { units: 'miles' });
      if (d < bestD) { bestD = d; best = a; }
    }
    return { airport: best, miles: bestD };
  }

  function getBaseArea() {
    const hz = window.JetLagHideZones?.getPlayableArea?.();
    if (hz) return Geo().safePoly(hz) || hz;
    if (boroughArea) return boroughArea;
    return Geo().WORLD;
  }

  async function loadBoroughFallback() {
    try {
      const b = await (await fetch('data/nyc_boroughs.geojson')).json();
      boroughArea = Geo().unionMany(b.features) || Geo().WORLD;
    } catch (_) { boroughArea = Geo().WORLD; }
  }

  function applyQuestion(mapData, q) {
    if (q.locked === false) return mapData;
    if (q.type === 'radius') {
      if (q.lat == null || q.lng == null || q.answer == null) return mapData;
      const circle = Geo().geodesicCircle(q.lng, q.lat, q.radius, q.unit);
      return Geo().modifyMapData(mapData, circle, q.answer === 'within');
    }
    if (q.type === 'thermometer') {
      if (q.latA == null || q.answer == null) return mapData;
      const region = Geo().thermometerRegion(q, q.answer === 'warmer');
      return Geo().modifyMapData(mapData, region, true);
    }
    if (q.type === 'matching' && q.subtype === 'airport') {
      if (q.lat == null || q.answer == null) return mapData;
      const seeker = { lng: q.lng, lat: q.lat };
      const sCell = Geo().voronoiCellContaining(seeker, PLAY_AIRPORTS);
      if (!sCell) return mapData;
      return Geo().modifyMapData(mapData, sCell, q.answer === 'same');
    }
    return mapData;
  }

  function recomputeElimination() {
    if (!mapRef?.getSource('game-elimination')) return;
    let area = getBaseArea();
    for (const q of questions) {
      area = applyQuestion(area, q);
    }
    const invalid = Geo().holedMask(area);
    mapRef.getSource('game-elimination').setData(invalid);
    syncQuestionLayers();
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (q.type === 'radius' && q.lat != null) {
        const circle = Geo().geodesicCircle(q.lng, q.lat, q.radius, q.unit);
        circle.properties = {
          kind: 'radius-fill', id: q.id, color: q.color,
          answer: q.answer, locked: q.locked,
        };
        features.push(circle);
        features.push(turf.feature(turf.point([q.lng, q.lat]).geometry, {
          kind: 'radius-center', id: q.id, color: q.color,
        }));
      } else if (q.type === 'thermometer' && q.latA != null) {
        features.push(turf.feature(turf.lineString([
          [q.lngA, q.latA], [q.lngB, q.latB],
        ]).geometry, { kind: 'thermo-line', id: q.id, color: q.color }));
        if (q.answer != null) {
          const region = Geo().thermometerRegion(q, q.answer === 'warmer');
          region.properties = { kind: 'thermo-region', id: q.id, color: q.color };
          features.push(region);
        }
        features.push(turf.feature(turf.point([q.lngA, q.latA]).geometry, {
          kind: 'thermo-end', id: q.id, end: 'A', color: q.color,
        }));
        features.push(turf.feature(turf.point([q.lngB, q.latB]).geometry, {
          kind: 'thermo-end', id: q.id, end: 'B', color: q.color,
        }));
      } else if (q.type === 'matching' && q.subtype === 'airport' && q.lat != null) {
        for (const a of PLAY_AIRPORTS) {
          features.push(turf.feature(turf.point([a.lng, a.lat]).geometry, {
            kind: 'airport', id: q.id, code: a.code, name: a.name,
          }));
        }
        const edges = Geo().voronoiBoundaryLines({ lng: q.lng, lat: q.lat }, PLAY_AIRPORTS);
        for (const line of edges) {
          line.properties = { kind: 'airport-edge', id: q.id, color: q.color };
          features.push(line);
        }
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, PLAY_AIRPORTS);
        if (cell) {
          cell.properties = { kind: 'airport-cell', id: q.id, color: q.color };
          features.push(cell);
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  function syncQuestionLayers() {
    if (!mapRef?.getSource('game-questions')) return;
    mapRef.getSource('game-questions').setData(questionsGeoJSON());
  }

  function renderList() {
    const el = document.getElementById('game-list');
    if (!el) return;
    el.innerHTML = '';
    if (!questions.length) {
      el.innerHTML = '<p class="game-hint">Add questions below. Enter your (seeker) coordinates — the hider only answers yes/no.</p>';
      return;
    }
    questions.forEach(q => {
      const div = document.createElement('div');
      div.className = 'game-item';
      div.dataset.id = q.id;
      const title = q.type === 'radius' ? `Radius · ${q.radius} ${q.unit}`
        : q.type === 'thermometer' ? 'Thermometer'
          : 'Matching · nearest airport';
      div.innerHTML = `
        <div class="game-item-head">
          <span class="game-dot" style="background:${q.color}"></span>
          <strong>${title}</strong>
          <button type="button" class="game-rm" data-id="${q.id}">×</button>
        </div>
        <div class="game-item-body">${renderQuestionFields(q)}</div>`;
      el.appendChild(div);
    });
    el.querySelectorAll('.game-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        questions = questions.filter(x => x.id !== btn.dataset.id);
        save(); recomputeElimination(); renderList();
      });
    });
    bindQuestionInputs(el);
  }

  function renderQuestionFields(q) {
    if (q.type === 'radius') {
      return `
        <label>Your coordinates</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="lat, lng">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        <div class="game-row">
          <input class="q-radius" data-id="${q.id}" type="number" step="any" value="${q.radius}" min="0.01" />
          <select class="q-unit" data-id="${q.id}">
            <option value="miles"${q.unit === 'miles' ? ' selected' : ''}>miles</option>
            <option value="kilometers"${q.unit === 'kilometers' ? ' selected' : ''}>km</option>
          </select>
        </div>
        <p class="game-hint">Hider says they are:</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="within"${q.answer === 'within' ? ' class="active"' : ''}>Inside radius</button>
          <button type="button" data-ans="outside"${q.answer === 'outside' ? ' class="active"' : ''}>Outside radius</button>
        </div>`;
    }
    if (q.type === 'thermometer') {
      return `
        <label>Point A (your warm pole)</label>
        <textarea class="q-coord-a" data-id="${q.id}" rows="2" placeholder="lat, lng">${q.latA != null ? fmtCoord(q.latA, q.lngA) : ''}</textarea>
        <label>Point B (cold pole)</label>
        <textarea class="q-coord-b" data-id="${q.id}" rows="2" placeholder="lat, lng">${q.latB != null ? fmtCoord(q.latB, q.lngB) : ''}</textarea>
        <p class="game-hint">Hider says they are:</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="warmer"${q.answer === 'warmer' ? ' class="active"' : ''}>Warmer (closer to A)</button>
          <button type="button" data-ans="colder"${q.answer === 'colder' ? ' class="active"' : ''}>Colder (closer to B)</button>
        </div>`;
    }
    if (q.type === 'matching' && q.subtype === 'airport') {
      const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
      return `
        <label>Your coordinates</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="lat, lng">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        ${near ? `<p class="game-hint">Your nearest: <strong>${near.airport.name}</strong> (${near.miles.toFixed(1)} mi)</p>` : ''}
        <p class="game-hint">Only LGA, JFK, NY Skyports. Hider says:</p>
        <div class="seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="same"${q.answer === 'same' ? ' class="active"' : ''}>Same nearest airport</button>
          <button type="button" data-ans="different"${q.answer === 'different' ? ' class="active"' : ''}>Different airport</button>
        </div>`;
    }
    return '';
  }

  function bindQuestionInputs(el) {
    el.querySelectorAll('.q-coord').forEach(ta => {
      ta.addEventListener('change', () => updateQuestionFromInputs(ta.dataset.id));
      ta.addEventListener('blur', () => updateQuestionFromInputs(ta.dataset.id));
    });
    el.querySelectorAll('.q-coord-a, .q-coord-b').forEach(ta => {
      ta.addEventListener('change', () => updateQuestionFromInputs(ta.dataset.id));
      ta.addEventListener('blur', () => updateQuestionFromInputs(ta.dataset.id));
    });
    el.querySelectorAll('.q-radius, .q-unit').forEach(inp => {
      inp.addEventListener('change', () => updateQuestionFromInputs(inp.dataset.id));
    });
    el.querySelectorAll('.q-answer button').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = questions.find(x => x.id === btn.closest('.q-answer').dataset.id);
        if (!q) return;
        q.answer = btn.dataset.ans;
        q.locked = true;
        save(); recomputeElimination(); renderList();
      });
    });
  }

  function updateQuestionFromInputs(id) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    const root = document.querySelector(`.game-item[data-id="${id}"]`);
    if (!root) return;
    if (q.type === 'radius') {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
      q.radius = parseFloat(root.querySelector('.q-radius')?.value) || q.radius;
      q.unit = root.querySelector('.q-unit')?.value || q.unit;
    } else if (q.type === 'thermometer') {
      const a = parseCoord(root.querySelector('.q-coord-a')?.value);
      const b = parseCoord(root.querySelector('.q-coord-b')?.value);
      if (a) { q.latA = a.lat; q.lngA = a.lng; }
      if (b) { q.latB = b.lat; q.lngB = b.lng; }
    } else if (q.type === 'matching') {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
    }
    save(); recomputeElimination(); syncQuestionLayers();
  }

  function addRadius() {
    const radius = parseFloat(document.getElementById('game-radius-val')?.value) || 1;
    const unit = document.getElementById('game-radius-unit')?.value || 'miles';
    questions.push({
      id: crypto.randomUUID(), type: 'radius', color: nextColor(),
      lat: null, lng: null, radius, unit, answer: null, locked: false,
    });
    save(); renderList(); recomputeElimination();
  }

  function addThermometer() {
    questions.push({
      id: crypto.randomUUID(), type: 'thermometer', color: nextColor(),
      latA: null, lngA: null, latB: null, lngB: null, answer: null, locked: false,
    });
    save(); renderList(); recomputeElimination();
  }

  function addAirportMatch() {
    questions.push({
      id: crypto.randomUUID(), type: 'matching', subtype: 'airport', color: nextColor(),
      lat: null, lng: null, answer: null, locked: false,
    });
    save(); renderList(); recomputeElimination();
  }

  function onMapClick(lngLat) {
    if (window.JetLagHideZones?.isPicking?.()) return;
    if (!placeMode) return;
    const q = questions.find(x => x.id === placeMode.id);
    if (!q) { placeMode = null; return; }
    if (placeMode.field === 'center') {
      q.lat = lngLat.lat; q.lng = lngLat.lng;
    } else if (placeMode.field === 'A') {
      q.latA = lngLat.lat; q.lngA = lngLat.lng;
    } else if (placeMode.field === 'B') {
      q.latB = lngLat.lat; q.lngB = lngLat.lng;
    }
    placeMode = null;
    save(); recomputeElimination(); renderList();
  }

  function installMapLayers(map) {
    mapRef = map;
    Geo().snapAirportsToMapbox(PLAY_AIRPORTS, window.MAPBOX_TOKEN).then(() => {
      if (mapRef) Geo().snapAirportsFromMap(PLAY_AIRPORTS, mapRef);
      recomputeElimination();
      syncQuestionLayers();
    }).catch(() => {});
    if (!map.getSource('game-elimination')) {
      map.addSource('game-elimination', { type: 'geojson', data: Geo().WORLD });
      map.addLayer({
        id: 'game-elimination-fill', type: 'fill', source: 'game-elimination',
        paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.45 },
      });
    }
    if (!map.getSource('game-questions')) {
      map.addSource('game-questions', { type: 'geojson', data: questionsGeoJSON() });
      map.addLayer({
        id: 'game-radius-fill', type: 'fill', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'radius-fill'],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['==', ['get', 'answer'], 'within'], 0.35,
            ['==', ['get', 'answer'], 'outside'], 0.12, 0.22],
        },
      });
      map.addLayer({
        id: 'game-radius-line', type: 'line', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'radius-fill'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
      });
      map.addLayer({
        id: 'game-thermo-line', type: 'line', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'thermo-line'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
      });
      map.addLayer({
        id: 'game-thermo-region', type: 'fill', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'thermo-region'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.2 },
      });
      map.addLayer({
        id: 'game-airport-edge', type: 'line', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'airport-edge'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
      });
      map.addLayer({
        id: 'game-airport-cell', type: 'fill', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'airport-cell'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.15 },
      });
      map.addLayer({
        id: 'game-points', type: 'circle', source: 'game-questions',
        filter: ['in', ['get', 'kind'], ['literal', ['radius-center', 'thermo-end', 'airport']]],
        paint: {
          'circle-radius': ['case', ['==', ['get', 'kind'], 'airport'], 5, 6],
          'circle-color': ['coalesce', ['get', 'color'], '#ffb020'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
    }
    if (!mapClickBound) {
      map.on('click', e => onMapClick(e.lngLat));
      mapClickBound = true;
    }
    recomputeElimination();
  }

  function bindUI() {
    document.getElementById('game-add-radius')?.addEventListener('click', addRadius);
    document.getElementById('game-add-thermo')?.addEventListener('click', addThermometer);
    document.getElementById('game-add-airport')?.addEventListener('click', addAirportMatch);
    document.getElementById('game-clear-all')?.addEventListener('click', () => {
      if (!confirm('Remove all questions?')) return;
      questions = []; save(); recomputeElimination(); renderList();
    });
  }

  load();
  loadBoroughFallback();
  window.JetLagGame = {
    installMapLayers, bindUI, renderList, recomputeElimination, syncQuestionLayers,
  };
})();
