/** Jet Lag Hide & Seek — radius + thermometer tools (inspired by JetLagHideAndSeek). */
(function () {
  const COLORS = ['#ffb020', '#4da3ff', '#6bcb77', '#ff6b9d', '#c084fc', '#f97316'];
  let colorIdx = 0;
  let questions = [];
  let hider = null; // { lat, lng }
  let placeMode = null; // { type, id, step, temp? }
  let mapRef = null;

  const STORAGE_KEY = 'jetlagNycQuestions';

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
    // lat,lon if first value looks like latitude
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && Math.abs(b) > 90) {
      return { lat: a, lng: b };
    }
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
      return { lat: b, lng: a };
    }
    return { lat: a, lng: b };
  }

  function fmtCoord(lat, lng) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  function dist(a, b, units) {
    return turf.distance(turf.point([a.lng, a.lat]), turf.point([b.lng, b.lat]), { units });
  }

  function sideOfThermometer(q, pt) {
    const scoreA = turf.distance(turf.point([q.lngA, q.latA]), turf.point([pt.lng, pt.lat]));
    const scoreB = turf.distance(turf.point([q.lngB, q.latB]), turf.point([pt.lng, pt.lat]));
    return scoreA <= scoreB;
  }

  function bisectorGeo(q) {
    const a = turf.point([q.lngA, q.latA]);
    const b = turf.point([q.lngB, q.latB]);
    const mid = turf.midpoint(a, b);
    const bearing = turf.bearing(a, b);
    const left = turf.destination(mid, 80, bearing + 90, { units: 'kilometers' });
    const right = turf.destination(mid, 80, bearing - 90, { units: 'kilometers' });
    return turf.lineString([left.geometry.coordinates, right.geometry.coordinates]);
  }

  function applyHider() {
    if (!hider) return;
    for (const q of questions) {
      if (q.type === 'radius') {
        q.within = dist(hider, { lat: q.lat, lng: q.lng }, q.unit) <= q.radius;
      } else if (q.type === 'thermometer') {
        q.warmer = sideOfThermometer(q, hider);
      }
    }
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (q.type === 'radius') {
        const circle = turf.circle([q.lng, q.lat], q.radius, { steps: 64, units: q.unit });
        circle.properties = {
          kind: 'radius-fill', id: q.id, color: q.color,
          within: q.within, label: `Radius ${q.radius} ${q.unit}`,
        };
        features.push(circle);
        features.push(turf.feature(turf.point([q.lng, q.lat]).geometry, {
          kind: 'radius-center', id: q.id, color: q.color,
        }));
      } else if (q.type === 'thermometer') {
        features.push(turf.feature(turf.lineString([
          [q.lngA, q.latA], [q.lngB, q.latB],
        ]).geometry, { kind: 'thermo-line', id: q.id, color: q.color }));
        features.push(turf.feature(bisectorGeo(q).geometry, {
          kind: 'thermo-bisector', id: q.id, color: q.color, warmer: q.warmer,
        }));
        features.push(turf.feature(turf.point([q.lngA, q.latA]).geometry, {
          kind: 'thermo-end', id: q.id, end: 'A', color: q.color, label: 'A (warm pole)',
        }));
        features.push(turf.feature(turf.point([q.lngB, q.latB]).geometry, {
          kind: 'thermo-end', id: q.id, end: 'B', color: q.color, label: 'B (cold pole)',
        }));
      }
    }
    return { type: 'FeatureCollection', features };
  }

  function syncMapLayers() {
    if (!mapRef || !mapRef.getSource('game-questions')) return;
    mapRef.getSource('game-questions').setData(questionsGeoJSON());
  }

  function renderList() {
    const el = document.getElementById('game-list');
    if (!el) return;
    el.innerHTML = '';
    if (!questions.length) {
      el.innerHTML = '<p class="game-hint">No questions yet. Add a radius or thermometer, then click the map to place points.</p>';
      return;
    }
    questions.forEach(q => {
      const div = document.createElement('div');
      div.className = 'game-item';
      const title = q.type === 'radius'
        ? `Radius · ${q.radius} ${q.unit}`
        : 'Thermometer';
      let status = '';
      if (hider) {
        if (q.type === 'radius') status = q.within ? '✓ Hider INSIDE' : '✗ Hider OUTSIDE';
        else status = q.warmer ? '✓ Hider on A side (warmer)' : '✗ Hider on B side (colder)';
      }
      div.innerHTML = `
        <div class="game-item-head">
          <span class="game-dot" style="background:${q.color}"></span>
          <strong>${title}</strong>
          <button type="button" class="game-rm" data-id="${q.id}">×</button>
        </div>
        <div class="game-item-body">${describe(q)}</div>
        ${status ? `<div class="game-status">${status}</div>` : ''}`;
      el.appendChild(div);
    });
    el.querySelectorAll('.game-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        questions = questions.filter(x => x.id !== btn.dataset.id);
        save(); applyHider(); syncMapLayers(); renderList();
      });
    });
  }

  function describe(q) {
    if (q.type === 'radius') {
      return `Center ${fmtCoord(q.lat, q.lng)}`;
    }
    return `A ${fmtCoord(q.latA, q.lngA)} · B ${fmtCoord(q.latB, q.lngB)}`;
  }

  function setPlaceHint(msg) {
    const el = document.getElementById('game-hint');
    if (el) el.textContent = msg || '';
  }

  function addRadius() {
    const radius = parseFloat(document.getElementById('game-radius-val').value) || 1;
    const unit = document.getElementById('game-radius-unit').value || 'miles';
    const q = {
      id: crypto.randomUUID(), type: 'radius', color: nextColor(),
      lat: 40.75, lng: -73.98, radius, unit, within: null,
    };
    questions.push(q);
    save();
    placeMode = { type: 'radius', id: q.id, step: 'center' };
    setPlaceHint('Click map to set radius center.');
    renderList();
    syncMapLayers();
  }

  function addThermometer() {
    const q = {
      id: crypto.randomUUID(), type: 'thermometer', color: nextColor(),
      latA: 40.76, lngA: -73.99, latB: 40.74, lngB: -73.97, warmer: null,
    };
    questions.push(q);
    save();
    placeMode = { type: 'thermometer', id: q.id, step: 'A' };
    setPlaceHint('Click map for thermometer point A (warm pole).');
    renderList();
    syncMapLayers();
  }

  function onMapClick(lngLat) {
    if (!placeMode) return;
    const q = questions.find(x => x.id === placeMode.id);
    if (!q) { placeMode = null; return; }
    if (placeMode.type === 'radius' && placeMode.step === 'center') {
      q.lat = lngLat.lat; q.lng = lngLat.lng;
      placeMode = null;
      setPlaceHint('');
    } else if (placeMode.type === 'thermometer') {
      if (placeMode.step === 'A') {
        q.latA = lngLat.lat; q.lngA = lngLat.lng;
        placeMode.step = 'B';
        setPlaceHint('Click map for thermometer point B (cold pole).');
      } else {
        q.latB = lngLat.lat; q.lngB = lngLat.lng;
        placeMode = null;
        setPlaceHint('');
      }
    }
    save(); applyHider(); syncMapLayers(); renderList();
  }

  function setHiderFromInputs() {
    const paste = document.getElementById('game-coord-paste').value;
    const lat = parseFloat(document.getElementById('game-lat').value);
    const lng = parseFloat(document.getElementById('game-lng').value);
    let pt = parseCoord(paste);
    if (!pt && !Number.isNaN(lat) && !Number.isNaN(lng)) pt = { lat, lng };
    if (!pt) return;
    hider = pt;
    document.getElementById('game-lat').value = pt.lat.toFixed(5);
    document.getElementById('game-lng').value = pt.lng.toFixed(5);
    applyHider();
    syncMapLayers();
    renderList();
  }

  function copyCoord(lngLat) {
    const text = fmtCoord(lngLat.lat, lngLat.lng);
    navigator.clipboard?.writeText(text);
    setPlaceHint(`Copied ${text}`);
  }

  let mapClickBound = false;

  function installMapLayers(map) {
    mapRef = map;
    if (!map.getSource('game-questions')) {
      map.addSource('game-questions', { type: 'geojson', data: questionsGeoJSON() });
      map.addLayer({
        id: 'game-radius-fill', type: 'fill', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'radius-fill'],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['==', ['get', 'within'], true], 0.35,
            ['==', ['get', 'within'], false], 0.08, 0.18],
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
        id: 'game-thermo-bisector', type: 'line', source: 'game-questions',
        filter: ['==', ['get', 'kind'], 'thermo-bisector'],
        paint: {
          'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [4, 3],
        },
      });
      map.addLayer({
        id: 'game-points', type: 'circle', source: 'game-questions',
        filter: ['in', ['get', 'kind'], ['literal', ['radius-center', 'thermo-end']]],
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
    } else {
      syncMapLayers();
    }
    if (!mapClickBound) {
      map.on('click', e => onMapClick(e.lngLat));
      map.on('contextmenu', e => {
        e.preventDefault();
        copyCoord(e.lngLat);
      });
      mapClickBound = true;
    }
  }

  function bindUI() {
    document.getElementById('game-add-radius')?.addEventListener('click', addRadius);
    document.getElementById('game-add-thermo')?.addEventListener('click', addThermometer);
    document.getElementById('game-set-hider')?.addEventListener('click', setHiderFromInputs);
    document.getElementById('game-clear-hider')?.addEventListener('click', () => {
      hider = null;
      for (const q of questions) {
        if (q.type === 'radius') q.within = null;
        else q.warmer = null;
      }
      renderList(); syncMapLayers();
    });
    document.getElementById('game-clear-all')?.addEventListener('click', () => {
      if (!confirm('Remove all radius / thermometer questions?')) return;
      questions = []; placeMode = null; save(); syncMapLayers(); renderList();
    });
    document.getElementById('game-coord-paste')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') setHiderFromInputs();
    });
  }

  load();
  window.JetLagGame = { installMapLayers, bindUI, renderList, syncMapLayers };
})();
