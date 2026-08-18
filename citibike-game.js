/** Citi Bike hide-and-seek — station elimination + question logic. */
(function () {
  const Geo = () => window.JetLagGeo;
  const COLORS = ['#ffb020', '#4da3ff', '#6bcb77', '#ff6b9d', '#c084fc', '#f97316', '#14b8a6'];
  const STORAGE_KEY = 'jetlagCitibikeQuestionsV1';
  const BOROUGHS = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island', 'Jersey'];
  const AIRPORTS = [
    { id: 'skyports', code: '6N7', name: 'NY Skyports Seaplane Base', lat: 40.735772, lng: -73.972222 },
    { id: 'lga', code: 'LGA', name: 'LaGuardia', lat: 40.7769, lng: -73.8740 },
    { id: 'ewr', code: 'EWR', name: 'Newark', lat: 40.6895, lng: -74.1745 },
  ];

  let colorIdx = 0;
  let questions = [];
  let hideRadiusMi = 0.2;
  let stations = [];
  let boroughPolys = {};
  let boroughUnion = null;
  let jerseyPoly = null;
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
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(questions));
  }

  /** Accept lat,lng, lng lat, Google/Apple Maps URLs, DMS-ish strings. */
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

    const labelMatch = s.match(/(-?\d+\.\d+)\s*°?\s*[NSns]\s*,?\s*(-?\d+\.\d+)\s*°?\s*[EWew]/);
    if (labelMatch) {
      let lat = +labelMatch[1], lng = +labelMatch[2];
      if (/[Ss]/.test(s.split(',')[0])) lat = -Math.abs(lat);
      if (/[Ww]/.test(s)) lng = -Math.abs(lng);
      return { lat, lng };
    }

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
    return turf.circle([st.lng, st.lat], hideRadiusMi, { steps: 48, units: 'miles' });
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
    } catch (_) {
      return false;
    }
  }

  function circleFullyInsidePoly(st, poly) {
    if (!poly) return false;
    try {
      return turf.booleanContains(
        poly,
        turf.circle([st.lng, st.lat], hideRadiusMi, { steps: 16, units: 'miles' }),
      );
    } catch (_) {
      return false;
    }
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
    const distToLine = Math.abs(Math.sin(diff * Math.PI / 180) * distToMid);
    return distToLine <= hideRadiusMi + 1e-6;
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
    if (q.locked === false || q.answer == null) return true;
    if (q.type === 'radius') {
      if (q.lat == null) return true;
      const d = distMi(st, { lat: q.lat, lng: q.lng });
      const r = radiusMiles(q);
      if (q.answer === 'within') return d <= r + hideRadiusMi;
      return d + hideRadiusMi > r;
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
    const locked = questions.filter(q => q.locked !== false && q.answer != null);
    if (!locked.length) return stations.slice();
    return stations.filter(st => locked.every(q => stationPassesQuestion(st, q)));
  }

  function activeStationFeatures(activeSet) {
    const ids = activeSet ? new Set(activeSet.map(s => s.id)) : null;
    const meters = hideRadiusMi * 1609.344;
    const mPerPxZ20 = 40075016.686 / (256 * 2 ** 20);
    return stations.map(st => ({
      type: 'Feature',
      properties: {
        id: st.id,
        name: st.name,
        borough: st.borough,
        active: ids ? (ids.has(st.id) ? 1 : 0) : 1,
        r20: meters / mPerPxZ20 / Math.cos(st.lat * Math.PI / 180),
      },
      geometry: { type: 'Point', coordinates: [st.lng, st.lat] },
    }));
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (q.type === 'radius' && q.lat != null) {
        const circle = Geo().geodesicCircle(q.lng, q.lat, q.radius, q.unit || 'miles');
        circle.properties = { kind: 'radius-fill', id: q.id, color: q.color, answer: q.answer };
        features.push(circle);
        features.push(turf.feature(turf.point([q.lng, q.lat]).geometry, {
          kind: 'radius-center', id: q.id, color: q.color,
        }));
      } else if (q.type === 'thermometer' && q.latA != null && q.latB != null) {
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
      } else if (q.type === 'airport' && q.lat != null) {
        for (const a of AIRPORTS) {
          features.push(turf.feature(turf.point([a.lng, a.lat]).geometry, {
            kind: 'airport', id: q.id, code: a.code, name: a.name, color: q.color,
          }));
        }
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, AIRPORTS);
        if (cell) {
          cell.properties = { kind: 'airport-cell', id: q.id, color: q.color };
          features.push(cell);
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

  function renderList() {
    const el = document.getElementById('cb-game-list');
    if (!el) return;
    el.innerHTML = '';
    if (!questions.length) {
      el.innerHTML = '<p class="cb-hint">Add questions below. Paste coords from Google or Apple Maps.</p>';
      return;
    }
    questions.forEach(q => {
      const div = document.createElement('div');
      div.className = 'cb-item';
      div.dataset.id = q.id;
      const title = q.type === 'radius' ? `Radius · ${q.radius} ${q.unit || 'miles'}`
        : q.type === 'thermometer' ? 'Thermometer'
          : q.type === 'borough' ? `Same borough · ${q.borough || '?'}`
            : 'Same commercial airport';
      div.innerHTML = `
        <div class="cb-item-head">
          <span class="cb-dot" style="background:${q.color}"></span>
          <strong>${title}</strong>
          <button type="button" class="cb-rm" data-id="${q.id}" aria-label="Remove">×</button>
        </div>
        <div class="cb-item-body">${renderQuestionFields(q)}</div>`;
      el.appendChild(div);
    });
    el.querySelectorAll('.cb-rm').forEach(btn => {
      btn.addEventListener('click', () => {
        questions = questions.filter(x => x.id !== btn.dataset.id);
        save(); notifyChange(); renderList();
      });
    });
    bindQuestionInputs(el);
  }

  function renderQuestionFields(q) {
    if (q.type === 'radius') {
      return `
        <label>Center (paste maps link or coords)</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="40.73, -73.99 or maps URL">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        <div class="cb-row">
          <input class="q-radius" data-id="${q.id}" type="number" step="any" inputmode="decimal" value="${q.radius}" min="0.01" />
          <select class="q-unit" data-id="${q.id}">
            <option value="miles"${(q.unit || 'miles') === 'miles' ? ' selected' : ''}>miles</option>
            <option value="kilometers"${q.unit === 'kilometers' ? ' selected' : ''}>km</option>
          </select>
        </div>
        <p class="cb-hint">Hider is:</p>
        <div class="cb-seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="within"${q.answer === 'within' ? ' class="active"' : ''}>Inside</button>
          <button type="button" data-ans="outside"${q.answer === 'outside' ? ' class="active"' : ''}>Outside</button>
        </div>`;
    }
    if (q.type === 'thermometer') {
      return `
        <label>Start (cold pole)</label>
        <textarea class="q-coord-a" data-id="${q.id}" rows="2" placeholder="Paste start location">${q.latA != null ? fmtCoord(q.latA, q.lngA) : ''}</textarea>
        <label>End (warm pole)</label>
        <textarea class="q-coord-b" data-id="${q.id}" rows="2" placeholder="Paste end location">${q.latB != null ? fmtCoord(q.latB, q.lngB) : ''}</textarea>
        <p class="cb-hint">Hider is warmer at:</p>
        <div class="cb-seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="warmer"${q.answer === 'warmer' ? ' class="active"' : ''}>End</button>
          <button type="button" data-ans="colder"${q.answer === 'colder' ? ' class="active"' : ''}>Start</button>
        </div>`;
    }
    if (q.type === 'borough') {
      const opts = BOROUGHS.map(b =>
        `<option value="${b}"${q.borough === b ? ' selected' : ''}>${b}</option>`,
      ).join('');
      return `
        <label>Your borough</label>
        <select class="q-borough" data-id="${q.id}">${opts}</select>
        <p class="cb-hint">Hider is in the:</p>
        <div class="cb-seg q-answer" data-id="${q.id}">
          <button type="button" data-ans="same"${q.answer === 'same' ? ' class="active"' : ''}>Same borough</button>
          <button type="button" data-ans="different"${q.answer === 'different' ? ' class="active"' : ''}>Different</button>
        </div>`;
    }
    if (q.type === 'airport') {
      const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
      return `
        <label>Your location</label>
        <textarea class="q-coord" data-id="${q.id}" rows="2" placeholder="Paste maps link or coords">${q.lat != null ? fmtCoord(q.lat, q.lng) : ''}</textarea>
        ${near ? `<p class="cb-hint">Your nearest: <strong>${near.airport.name}</strong> (${near.miles.toFixed(1)} mi)</p>` : ''}
        <p class="cb-hint">Skyports · LaGuardia · Newark. Hider shares nearest airport:</p>
        <div class="cb-seg q-answer" data-id="${q.id}">
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
        q.locked = true;
        save(); notifyChange(); renderList();
      });
    });
  }

  function updateQuestionFromInputs(id) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    const root = document.querySelector(`.cb-item[data-id="${id}"]`);
    if (!root) return;
    if (q.type === 'radius') {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
      q.radius = parseFloat(root.querySelector('.q-radius')?.value) || q.radius;
      q.unit = root.querySelector('.q-unit')?.value || 'miles';
    } else if (q.type === 'thermometer') {
      const a = parseCoord(root.querySelector('.q-coord-a')?.value);
      const b = parseCoord(root.querySelector('.q-coord-b')?.value);
      if (a) { q.latA = a.lat; q.lngA = a.lng; }
      if (b) { q.latB = b.lat; q.lngB = b.lng; }
    } else if (q.type === 'borough') {
      q.borough = root.querySelector('.q-borough')?.value || q.borough;
    } else if (q.type === 'airport') {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
    }
    save(); notifyChange();
  }

  function addQuestion(type) {
    const base = { id: crypto.randomUUID(), type, color: nextColor(), answer: null, locked: false };
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
      for (const f of boro.features) {
        boroughPolys[f.properties.BoroName] = f;
      }
      boroughUnion = Geo().unionMany(boro.features);
      const njBox = turf.bboxPolygon([-74.35, 40.55, -73.85, 41.05]);
      try {
        jerseyPoly = turf.difference(turf.featureCollection([njBox, boroughUnion])) || njBox;
      } catch (_) {
        jerseyPoly = njBox;
      }
      boroughPolys.Jersey = jerseyPoly;
    } catch (e) {
      console.warn('borough load failed', e);
    }

    stations = (geojson.features || []).map((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      let borough = 'Jersey';
      const pt = turf.point([lng, lat]);
      for (const [name, poly] of Object.entries(boroughPolys)) {
        if (name === 'Jersey') continue;
        if (turf.booleanPointInPolygon(pt, poly)) {
          borough = name;
          break;
        }
      }
      return {
        id: f.properties.station_id || String(i),
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
    getActiveStations, activeStationFeatures,
    questionsGeoJSON, stationCircle,
    get hideRadiusMi() { return hideRadiusMi; },
    set hideRadiusMi(v) { hideRadiusMi = v; notifyChange(); },
    get stations() { return stations; },
    set onChange(fn) { onChange = fn; },
    BOROUGHS, AIRPORTS,
  };
})();
