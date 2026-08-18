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
  let coastSimple = null;
  let coastMask = null;
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

  function parseDMSPair(s) {
    const re = /(\d+(?:\.\d+)?)\s*[°º]?\s*(\d+(?:\.\d+)?)?\s*['′]?\s*(\d+(?:\.\d+)?)?\s*["″]?\s*([NSEW])/gi;
    const matches = [...s.matchAll(re)];
    if (matches.length < 2) return null;
    let lat = null;
    let lng = null;
    for (const m of matches) {
      const deg = +m[1];
      const min = m[2] != null ? +m[2] : 0;
      const sec = m[3] != null ? +m[3] : 0;
      let val = deg + min / 60 + sec / 3600;
      const dir = m[4].toUpperCase();
      if (dir === 'S' || dir === 'W') val = -val;
      if (dir === 'N' || dir === 'S') lat = val;
      else lng = val;
    }
    if (lat != null && lng != null) return { lat, lng };
    return null;
  }

  function parseCoord(text) {
    const s = (text || '').trim();
    if (!s) return null;
    const dms = parseDMSPair(s);
    if (dms) return dms;
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

  function geometryRings(feature) {
    if (!feature) return [];
    const g = feature.geometry;
    if (!g) return [];
    if (g.type === 'LineString') return [g.coordinates];
    if (g.type === 'MultiLineString' || g.type === 'Polygon') return g.coordinates.slice();
    if (g.type === 'MultiPolygon') {
      const out = [];
      for (const poly of g.coordinates) for (const ring of poly) out.push(ring);
      return out;
    }
    return [];
  }

  let coastIndex = null;

  function coastlineIndex() {
    if (coastIndex) return coastIndex;
    coastIndex = Geo().buildSegmentIndex(geometryRings(coastSimple || coastFeature), 0.02);
    return coastIndex;
  }

  function distToCoast(lat, lng) {
    if (!coastFeature) return Infinity;
    return Geo().minDistanceIndexedMi(coastlineIndex(), lng, lat);
  }

  const MI_PER_DEG = 69.0546;

  /** Equirectangular distance — accurate to well under a foot at city scale. */
  function distMi(a, b) {
    const dLat = (b.lat - a.lat) * MI_PER_DEG;
    const dLng = (b.lng - a.lng) * MI_PER_DEG
      * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    return Math.hypot(dLat, dLng);
  }

  /**
   * Hide-zone ring in the same planar metric used for elimination tests.
   * Vertices sit on the circumscribed circle so the drawn polygon never reads
   * smaller than the real radius, however few steps it uses.
   */
  function circleRing(lng, lat, radiusMi, steps) {
    const kx = MI_PER_DEG * Math.cos(lat * Math.PI / 180);
    const r = radiusMi / Math.cos(Math.PI / steps);
    const ring = [];
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ring.push([
        lng + (r * Math.cos(a)) / kx,
        lat + (r * Math.sin(a)) / MI_PER_DEG,
      ]);
    }
    ring.push(ring[0]);
    return ring;
  }

  function stationCircle(st, steps) {
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [circleRing(st.lng, st.lat, hideRadiusMi, steps || 64)],
      },
    };
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

  const NJ_BOX = [-74.35, 40.55, -73.85, 41.05];
  const NJ_BOX_RING = [
    [NJ_BOX[0], NJ_BOX[1]], [NJ_BOX[2], NJ_BOX[1]], [NJ_BOX[2], NJ_BOX[3]],
    [NJ_BOX[0], NJ_BOX[3]], [NJ_BOX[0], NJ_BOX[1]],
  ];

  const boroughIndexCache = {};
  const boroughEdgeCache = {};
  let jerseyPoly = null;

  function simplifiedRings(poly, tolerance) {
    if (!poly) return [];
    let simple = poly;
    try {
      simple = turf.simplify(poly, { tolerance, highQuality: false });
    } catch (_) { simple = poly; }
    const rings = Geo().flattenRings(simple);
    return rings.length ? rings : Geo().flattenRings(poly);
  }

  const boroughMaskCache = {};

  /**
   * Jersey is the NJ box minus the five boroughs — only built when a mask needs it.
   * Outlines are coarse on purpose: this feeds the gray overlay, while station
   * elimination uses the precise per-station edge distances.
   */
  function boroughPoly(name) {
    if (name !== 'Jersey') {
      if (boroughMaskCache[name] !== undefined) return boroughMaskCache[name];
      const poly = boroughPolys[name] || null;
      let mask = poly;
      if (poly) {
        try { mask = turf.simplify(poly, { tolerance: 0.0008, highQuality: false }); } catch (_) { mask = poly; }
      }
      boroughMaskCache[name] = mask;
      return mask;
    }
    if (jerseyPoly) return jerseyPoly;
    const njBox = turf.bboxPolygon(NJ_BOX);
    const polys = Object.values(boroughPolys);
    if (!polys.length) return njBox;
    try {
      // Coarse outlines keep the union cheap; the mask is only a visual guide.
      const coarse = polys.map(p => {
        try { return turf.simplify(p, { tolerance: 0.001, highQuality: false }); } catch (_) { return p; }
      });
      jerseyPoly = turf.difference(turf.featureCollection([njBox, Geo().unionMany(coarse)])) || njBox;
    } catch (_) {
      jerseyPoly = njBox;
    }
    return jerseyPoly;
  }

  function boroughIndex(name) {
    if (boroughIndexCache[name] !== undefined) return boroughIndexCache[name];
    let rings;
    if (name === 'Jersey') {
      // Jersey's edge is the NJ box plus every borough outline, so skip the union.
      rings = [NJ_BOX_RING];
      for (const poly of Object.values(boroughPolys)) {
        rings = rings.concat(simplifiedRings(poly, 0.00005));
      }
    } else {
      rings = simplifiedRings(boroughPolys[name], 0.00005);
    }
    const index = rings.length ? Geo().buildSegmentIndex(rings, 0.02) : null;
    boroughIndexCache[name] = index;
    return index;
  }

  /**
   * Distance in miles from every station to a borough boundary. Computed once
   * per borough so the per-station tests stay O(1) while panning.
   */
  function boroughEdgeDistances(name) {
    const cached = boroughEdgeCache[name];
    if (cached && cached.length === stations.length) return cached;
    const index = boroughIndex(name);
    if (!index) return null;
    const out = new Float64Array(stations.length);
    for (let i = 0; i < stations.length; i++) {
      out[i] = Geo().minDistanceIndexedMi(index, stations[i].lng, stations[i].lat);
    }
    boroughEdgeCache[name] = out;
    return out;
  }

  let coastDistCache = null;

  /**
   * Coastline distance for every station, built on first use. Precomputing this
   * at load cost ~180 ms even when no coastline question existed.
   */
  function coastDistances() {
    if (coastDistCache && coastDistCache.length === stations.length) return coastDistCache;
    if (!coastFeature || !stations.length) return null;
    const index = coastlineIndex();
    const out = new Float64Array(stations.length);
    for (let i = 0; i < stations.length; i++) {
      out[i] = Geo().minDistanceIndexedMi(index, stations[i].lng, stations[i].lat);
    }
    coastDistCache = out;
    return out;
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

  /**
   * A station survives unless its entire hide zone falls outside the answer's
   * allowed region. Every test is closed-form so 2400 stations stay cheap.
   */
  function stationPassesQuestion(st, q) {
    if (q.answer == null) return true;
    const h = hideRadiusMi;
    const eps = 1e-9;

    if (q.type === 'radius') {
      if (q.lat == null || q.lng == null) return true;
      const r = radiusMiles(q);
      const d = distMi(st, { lat: q.lat, lng: q.lng });
      if (q.answer === 'within') return d - h <= r + eps;
      return d + h > r + eps;
    }

    if (q.type === 'thermometer') {
      if (q.latA == null || q.latB == null) return true;
      const x = Geo().thermometerSignedMiles(q, st.lng, st.lat);
      return q.answer === 'warmer' ? x > -h - eps : x < h + eps;
    }

    if (q.type === 'borough') {
      const edges = boroughEdgeDistances(q.borough);
      if (!edges) return true;
      const inside = st.borough === q.borough;
      const edge = edges[st.idx];
      if (q.answer === 'same') return inside || edge <= h + eps;
      return !inside || edge < h - eps;
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
      if (q.lat == null || !coastFeature) return true;
      const measure = distToCoast(q.lat, q.lng);
      const dists = coastDistances();
      const d = dists ? dists[st.idx] : distToCoast(st.lat, st.lng);
      if (q.answer === 'closer') return d - h <= measure + eps;
      return d + h >= measure - eps;
    }

    return true;
  }

  function answeredKey() {
    const parts = [hideRadiusMi.toFixed(4), stations.length];
    for (const q of questions) {
      if (q.answer == null) continue;
      parts.push([
        q.id, q.type, q.answer, q.lat, q.lng, q.latA, q.lngA,
        q.latB, q.lngB, q.radius, q.unit, q.borough,
      ].join(','));
    }
    return parts.join('|');
  }

  let activeCache = { key: null, list: null };

  function getActiveStations() {
    const key = answeredKey();
    if (activeCache.key === key && activeCache.list) return activeCache.list;
    const locked = questions.filter(q => q.answer != null);
    let list;
    if (!locked.length) {
      list = stations.slice();
    } else {
      list = [];
      for (const st of stations) {
        let ok = true;
        for (const q of locked) {
          if (!stationPassesQuestion(st, q)) { ok = false; break; }
        }
        if (ok) list.push(st);
      }
    }
    activeCache = { key, list };
    return list;
  }

  function activeStationFeatures(activeSet) {
    return activeSet.map(st => ({
      type: 'Feature',
      properties: {
        id: st.id,
        name: st.name,
        borough: st.borough,
      },
      geometry: { type: 'Point', coordinates: [st.lng, st.lat] },
    }));
  }

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  /** Above this many visible zones the union is too slow for phones. */
  const MERGE_LIMIT = 700;

  function visibleStations(list, bbox) {
    if (!bbox || !list) return list || [];
    const padLat = (hideRadiusMi / MI_PER_DEG) * 1.25;
    const padLng = padLat / Math.max(0.2, Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180));
    const out = [];
    for (const s of list) {
      if (s.lng >= bbox[0] - padLng && s.lng <= bbox[2] + padLng
        && s.lat >= bbox[1] - padLat && s.lat <= bbox[3] + padLat) out.push(s);
    }
    return out;
  }

  function zoneSteps(count) {
    if (count > 900) return 10;
    if (count > 400) return 14;
    if (count > 150) return 20;
    return 28;
  }

  function overlapZonesGeoJSON(activeSet, bbox) {
    const list = visibleStations(activeSet, bbox);
    if (!list.length) return EMPTY_FC;
    const steps = zoneSteps(list.length);
    const features = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      features[i] = {
        type: 'Feature',
        properties: { id: st.id, name: st.name },
        geometry: {
          type: 'Polygon',
          coordinates: [circleRing(st.lng, st.lat, hideRadiusMi, steps)],
        },
      };
    }
    return { type: 'FeatureCollection', features };
  }

  let mergedCache = { key: null, data: null };

  function mergedZonesGeoJSON(activeStations, bbox) {
    const list = visibleStations(activeStations, bbox);
    if (!list.length) return EMPTY_FC;

    const key = `${answeredKey()}|${list.length}|${bbox ? bbox.map(v => v.toFixed(3)).join(',') : ''}`;
    if (mergedCache.key === key && mergedCache.data) return mergedCache.data;

    let data = null;
    if (list.length <= MERGE_LIMIT) {
      try {
        const mp = turf.multiPoint(list.map(s => [s.lng, s.lat]));
        const steps = zoneSteps(list.length);
        // buffer() inscribes its arcs, so grow the radius to keep the true circle covered.
        const merged = turf.buffer(mp, hideRadiusMi / Math.cos(Math.PI / (4 * steps)), {
          units: 'miles', steps,
        });
        if (merged?.geometry?.coordinates?.length) {
          merged.properties = { kind: 'merged-zones' };
          data = { type: 'FeatureCollection', features: [merged] };
        }
      } catch (_) { data = null; }
    }
    // Too many zones to union quickly — overlapping circles read the same at this zoom.
    if (!data) data = overlapZonesGeoJSON(list, null);

    mergedCache = { key, data };
    return data;
  }

  let coastBufferCache = { key: null, buf: null };

  function coastBand(measure) {
    const key = measure.toFixed(3);
    if (coastBufferCache.key === key) return coastBufferCache.buf;
    let buf = null;
    try {
      buf = turf.buffer(coastMask || coastFeature, measure, { units: 'miles', steps: 6 });
    } catch (_) { buf = null; }
    coastBufferCache = { key, buf };
    return buf;
  }

  let areaCache = { key: null, area: null };

  function possibleAreaFromQuestions() {
    const qs = questions.filter(q => q.answer != null);
    if (!qs.length) return null;

    const key = answeredKey();
    if (areaCache.key === key) return areaCache.area;

    let area = Geo().WORLD;
    for (const q of qs) {
      if (q.type === 'radius' && q.lat != null && q.lng != null) {
        const r = radiusMiles(q);
        const c = turf.circle([q.lng, q.lat], r, { steps: 48, units: 'miles' });
        area = Geo().modifyMapData(area, c, q.answer === 'within');
      } else if (q.type === 'thermometer' && q.latA != null && q.latB != null) {
        area = Geo().modifyMapData(area, Geo().thermometerRegion(q, q.answer === 'warmer'), true);
      } else if (q.type === 'borough') {
        const poly = boroughPoly(q.borough);
        if (poly) area = Geo().modifyMapData(area, poly, q.answer === 'same');
      } else if (q.type === 'airport' && q.lat != null) {
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, AIRPORTS);
        if (cell) area = Geo().modifyMapData(area, cell, q.answer === 'same');
      } else if (q.type === 'coastline' && q.lat != null && coastFeature) {
        const band = coastBand(distToCoast(q.lat, q.lng));
        if (band) area = Geo().modifyMapData(area, band, q.answer === 'closer');
      }
    }

    areaCache = { key, area };
    return area;
  }

  let maskCache = { key: null, mask: null, border: null };

  function ensureMaskCache() {
    const key = answeredKey();
    if (maskCache.key === key) return maskCache;
    const possible = possibleAreaFromQuestions();
    if (!possible) {
      maskCache = { key, mask: EMPTY_FC, border: EMPTY_FC };
      return maskCache;
    }
    const f = Geo().safePoly(possible);
    maskCache = {
      key,
      mask: Geo().holedMask(possible),
      border: f ? { type: 'FeatureCollection', features: [f] } : EMPTY_FC,
    };
    return maskCache;
  }

  function eliminatedMask() {
    return ensureMaskCache().mask;
  }

  function possibleAreaGeoJSON() {
    return ensureMaskCache().border;
  }

  function questionsGeoJSON() {
    const features = [];
    for (const q of questions) {
      if (!q.open) continue;
      if (q.type === 'radius' && q.lat != null) {
        const circle = turf.circle([q.lng, q.lat], radiusMiles(q), { steps: 64, units: 'miles' });
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
          <textarea class="${field === 'A' ? 'q-coord-a' : field === 'B' ? 'q-coord-b' : 'q-coord'}" data-id="${q.id}" rows="2" placeholder="Paste Maps link, decimal, or DMS coords">${lat != null ? fmtCoord(lat, lng) : ''}</textarea>
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
      el.innerHTML = '<p class="game-hint">Add a question, then open it to place pins on the map.</p>';
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
        if (q.open) {
          const c = window.JetLagCitibikeApp?.mapCenter?.();
          if (c) ensureQuestionCoords(q.id, c);
        }
        save(); notifyChange(); renderList();
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
    save(); notifyChange(); renderList();
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

  function ensureQuestionCoords(id, center) {
    const q = questions.find(x => x.id === id);
    if (!q || !center) return false;
    let changed = false;
    if (q.type === 'radius' || q.type === 'airport' || q.type === 'coastline') {
      if (q.lat == null) {
        q.lat = center.lat;
        q.lng = center.lng;
        changed = true;
      }
    } else if (q.type === 'thermometer') {
      if (q.latA == null) {
        q.latA = center.lat;
        q.lngA = center.lng;
        changed = true;
      }
      if (q.latB == null) {
        q.latB = center.lat;
        q.lngB = center.lng + 0.04;
        changed = true;
      }
    }
    if (changed) save();
    return changed;
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
    const c = window.JetLagCitibikeApp?.mapCenter?.();
    if (c) ensureQuestionCoords(base.id, c);
    notifyChange();
  }

  function notifyChange() {
    if (onChange) onChange();
  }

  async function initStationData(geojson) {
    const [boro, coast] = await Promise.all([
      fetch('data/nyc_boroughs.geojson').then(r => r.json()).catch(() => null),
      fetch('data/coastline.geojson').then(r => r.json()).catch(() => null),
    ]);
    try {
      if (boro) {
        for (const f of boro.features) boroughPolys[f.properties.BoroName] = f;
      }
    } catch (e) {
      console.warn('borough load failed', e);
    }
    try {
      coastFeature = coast?.features?.[0] || null;
      coastIndex = null;
      coastDistCache = null;
      if (coastFeature) {
        try {
          coastSimple = turf.simplify(coastFeature, { tolerance: 0.0003, highQuality: false });
        } catch (_) { coastSimple = coastFeature; }
        // The gray mask only needs a rough band, and buffering full detail is slow.
        try {
          coastMask = turf.simplify(coastFeature, { tolerance: 0.008, highQuality: false });
        } catch (_) { coastMask = coastSimple; }
      }
    } catch (e) {
      console.warn('coastline load failed', e);
    }

    // Bounding boxes let most stations skip the polygon test, and a light simplify
    // makes the remaining tests ~6x cheaper without changing any assignment.
    const boroBoxes = Object.entries(boroughPolys).map(([name, poly]) => {
      let hit = poly;
      try { hit = turf.simplify(poly, { tolerance: 0.0002, highQuality: false }); } catch (_) { hit = poly; }
      return { name, poly: hit, box: turf.bbox(poly) };
    });

    stations = (geojson.features || []).map((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      let borough = f.properties.borough || 'Jersey';
      if (!f.properties.borough) {
        for (const b of boroBoxes) {
          if (lng < b.box[0] || lng > b.box[2] || lat < b.box[1] || lat > b.box[3]) continue;
          if (turf.booleanPointInPolygon([lng, lat], b.poly)) { borough = b.name; break; }
        }
      }
      return {
        idx: i,
        id: f.properties.station_id || `${lng.toFixed(6)}_${lat.toFixed(6)}_${i}`,
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
    document.getElementById('cb-add-coast')?.addEventListener('click', () => addQuestion('coastline'));
    document.getElementById('cb-clear-all')?.addEventListener('click', () => {
      if (!confirm('Remove all questions?')) return;
      questions = []; save(); notifyChange(); renderList();
    });
    let radiusTimer = null;
    document.getElementById('cb-hide-radius')?.addEventListener('input', e => {
      hideRadiusMi = Math.max(0.05, parseFloat(e.target.value) || 0.2);
      const lbl = document.getElementById('cb-hide-radius-label');
      if (lbl) lbl.textContent = `${hideRadiusMi.toFixed(2)} mi`;
      // The radius invalidates every cache, so redraw once the drag settles.
      clearTimeout(radiusTimer);
      radiusTimer = setTimeout(notifyChange, 130);
    });
  }

  load();

  window.JetLagCitibikeGame = {
    parseCoord, fmtCoord, bindUI, renderList, initStationData,
    getActiveStations, activeStationFeatures, overlapZonesGeoJSON, mergedZonesGeoJSON,
    questionsGeoJSON, eliminatedMask, possibleAreaGeoJSON, stationCircle, setQuestionPoint,
    ensureQuestionCoords, distMi,
    getQuestions: () => questions,
    get hideRadiusMi() { return hideRadiusMi; },
    get stations() { return stations; },
    set onChange(fn) { onChange = fn; },
    BOROUGHS, AIRPORTS,
  };
})();
