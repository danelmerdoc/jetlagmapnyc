/** Citi Bike hide-and-seek — station elimination + question logic. */
(function () {
  const Geo = () => window.JetLagGeo;
  const COLORS = ['#7c4dff', '#2563eb', '#0d9488', '#db2777', '#ea580c', '#4f46e5'];
  const STORAGE_KEY = 'jetlagCitibikeQuestionsV6';
  const BOROUGHS = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island', 'Jersey'];
  const AIRPORTS = [
    { id: 'skyports', code: '6N7', name: 'NY Skyports Seaplane Base', lat: 40.7351534, lng: -73.9729007 },
    { id: 'lga', code: 'LGA', name: 'LaGuardia Airport', lat: 40.7757145, lng: -73.8733640 },
    { id: 'jfk', code: 'JFK', name: 'John F. Kennedy International Airport', lat: 40.6429479, lng: -73.7793734 },
  ];
  const CAST_COST = {
    radius: { draw: 2, pick: 1, name: 'Radar' },
    thermometer: { draw: 2, pick: 1, name: 'Thermometer' },
    matching: { draw: 3, pick: 1, name: 'Matching' },
    measuring: { draw: 3, pick: 1, name: 'Measuring' },
  };
  const MATCH_SUBS = [
    ['borough', 'Borough'],
    ['landmass', 'Land mass'],
    ['airport', 'Closest airport'],
  ];
  const MEASURE_SUBS = [
    ['coastline', 'Coastline'],
    ['airport', 'Nearest airport'],
  ];
  const LAND_MASSES = ['mainland', 'islands', 'longisland'];
  const LAND_MASS_LABEL = {
    mainland: 'Mainland (Bronx / NJ / Marble Hill)',
    islands: 'Manhattan islands',
    longisland: 'Brooklyn / Queens',
  };

  let colorIdx = 0;
  let questions = [];
  let hideRadiusMi = 0.2;
  let stations = [];
  let boroughPolys = {};
  let coastFeature = null;
  let coastSimple = null;
  let coastMask = null;
  let gameArea = null;
  let playablePoly = null;
  let greyStatic = null;
  let playableBorder = null;
  let onChange = null;

  function nextColor() {
    const c = COLORS[colorIdx % COLORS.length];
    colorIdx += 1;
    return c;
  }

  function migrateQuestion(q) {
    if (q.type === 'borough') { q.type = 'matching'; q.subtype = 'borough'; }
    else if (q.type === 'airport') { q.type = 'matching'; q.subtype = 'airport'; }
    else if (q.type === 'coastline') { q.type = 'measuring'; q.subtype = 'coastline'; }
    if (q.type === 'matching' && !q.subtype) q.subtype = 'borough';
    if (q.type === 'measuring' && !q.subtype) q.subtype = 'coastline';
    if (q.open == null) q.open = false;
    if (q.type === 'thermometer') {
      if (!q.colorA) q.colorA = q.color || COLORS[0];
      if (!q.colorB) q.colorB = COLORS[(COLORS.indexOf(q.colorA) + 2) % COLORS.length];
    }
    return q.type === 'radius' || q.type === 'thermometer' || q.type === 'matching' || q.type === 'measuring';
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
        || localStorage.getItem('jetlagCitibikeQuestionsV5')
        || localStorage.getItem('jetlagCitibikeQuestionsV4')
        || localStorage.getItem('jetlagCitibikeQuestionsV3');
      if (raw) questions = JSON.parse(raw);
    } catch (_) { questions = []; }
    questions = questions.filter(migrateQuestion);
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

  function nearestAirport(pt, list) {
    const pool = list || AIRPORTS;
    let best = null, bestD = Infinity;
    for (const a of pool) {
      const d = distMi(pt, a);
      if (d < bestD) { bestD = d; best = a; }
    }
    return { airport: best, miles: bestD };
  }

  function usesCenter(q) {
    return q.type === 'radius' || q.type === 'matching' || q.type === 'measuring';
  }

  function costOf(q) {
    return CAST_COST[q.type] || CAST_COST.radius;
  }

  function costLabel(q) {
    const c = costOf(q);
    return `${c.name} · draw ${c.draw} pick ${c.pick}`;
  }

  function cardsDrawn() {
    return questions.reduce((n, q) => n + (costOf(q).draw || 0), 0);
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

  const boroughLandCache = {};
  /**
   * The city's borough file follows the historic county line along the Brooklyn
   * and Queens low-water marks, so piers built out over the water — the Brooklyn
   * Bridge Park piers among them — are filed under Manhattan. Every such sliver is
   * under eight acres, while the smallest real outlying landmass (Marble Hill) is
   * seventy-five, so dropping small detached parts removes the piers and keeps
   * Governors, Roosevelt, Randall's and Wards islands. No station sits on one.
   */
  const MIN_PART_SQ_M = 40 * 4046.86;

  function boroughLand(name) {
    if (boroughLandCache[name] !== undefined) return boroughLandCache[name];
    const poly = boroughPolys[name] || null;
    if (!poly) return null;
    let land = poly;
    if (poly && poly.geometry.type === 'MultiPolygon') {
      const parts = poly.geometry.coordinates;
      let mainIdx = 0;
      let mainArea = -1;
      const areas = parts.map((p, i) => {
        let a = 0;
        try { a = turf.area(turf.polygon(p)); } catch (_) { a = 0; }
        if (a > mainArea) { mainArea = a; mainIdx = i; }
        return a;
      });
      const keep = parts.filter((p, i) => i === mainIdx || areas[i] >= MIN_PART_SQ_M);
      if (keep.length && keep.length < parts.length) {
        land = turf.multiPolygon(keep, poly.properties);
      }
    }
    boroughLandCache[name] = land;
    return land;
  }

  function boroughAt(lng, lat) {
    if (![lng, lat].every(Number.isFinite)) return null;
    for (const name of BOROUGHS) {
      if (name === 'Jersey') continue;
      const land = boroughLand(name);
      if (land && turf.booleanPointInPolygon([lng, lat], land)) return name;
    }
    // Water (Hudson, East River) is not Jersey. Snap to the nearest land mass.
    let best = 'Jersey';
    let bestD = Infinity;
    for (const name of BOROUGHS) {
      const index = boroughIndex(name);
      if (!index) continue;
      const d = Geo().minDistanceIndexedMi(index, lng, lat);
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  function seekerBorough(q) {
    if (q.lat != null && q.lng != null) return boroughAt(q.lng, q.lat);
    return q.borough || null;
  }

  const boroughMaskCache = {};

  /**
   * Jersey is the NJ box minus the five boroughs — only built when a mask needs it.
   * The 6 m tolerance matches the outline elimination measures against, so the gray
   * edge and the surviving stations come from the same shape. It is fine enough to
   * keep Governors Island recognisable, where the previous 90 m flattened it into a
   * twelve-sided blob.
   */
  function boroughPoly(name) {
    if (name !== 'Jersey') {
      if (boroughMaskCache[name] !== undefined) return boroughMaskCache[name];
      const land = boroughLand(name);
      if (!land) return null;
      let mask = land;
      try {
        mask = turf.simplify(land, { tolerance: 0.00005, highQuality: false });
      } catch (_) { mask = land; }
      boroughMaskCache[name] = mask;
      return mask;
    }
    if (jerseyPoly) return jerseyPoly;
    const njBox = turf.bboxPolygon(NJ_BOX);
    const nycNames = BOROUGHS.filter(b => b !== 'Jersey');
    const lands = nycNames.map(b => boroughLand(b)).filter(Boolean);
    if (lands.length < nycNames.length) return njBox;
    try {
      const coarse = lands.map(p => {
        try { return turf.simplify(p, { tolerance: 0.001, highQuality: false }); } catch (_) { return p; }
      });
      let nyc = Geo().unionMany(coarse);
      // Pull NYC's shore out by more than the max hide radius so the Hudson and
      // East River are not counted as Jersey. Hiders cannot be in the water.
      try { nyc = turf.buffer(nyc, 0.6, { units: 'miles', steps: 8 }); } catch (_) { /* keep unpadded */ }
      jerseyPoly = turf.difference(turf.featureCollection([njBox, nyc])) || njBox;
    } catch (_) {
      jerseyPoly = njBox;
    }
    return jerseyPoly;
  }

  function boroughIndex(name) {
    if (boroughIndexCache[name] !== undefined) return boroughIndexCache[name];
    const poly = name === 'Jersey' ? boroughPoly('Jersey') : boroughLand(name);
    if (!poly) return null;
    const rings = simplifiedRings(poly, 0.00005);
    const index = rings.length ? Geo().buildSegmentIndex(rings, 0.02) : null;
    boroughIndexCache[name] = index;
    return index;
  }

  /**
   * Boroughs a hider at this station could actually be in. Water does not count:
   * the hide circle has to overlap another borough's land, not just the Hudson.
   */
  function possibleBoroughs(st) {
    const h = hideRadiusMi + 1e-9;
    const out = [];
    for (const name of BOROUGHS) {
      if (st.borough === name) {
        out.push(name);
        continue;
      }
      const edges = boroughEdgeDistances(name);
      if (edges && edges[st.idx] <= h) out.push(name);
    }
    return out;
  }

  const otherLandCache = {};

  function landExcept(name) {
    if (otherLandCache[name] !== undefined) return otherLandCache[name];
    const parts = BOROUGHS.filter(b => b !== name).map(b => boroughPoly(b)).filter(Boolean);
    if (parts.length < BOROUGHS.length - 1) return null;
    otherLandCache[name] = Geo().unionMany(parts);
    return otherLandCache[name];
  }

  const landMassPolyCache = {};
  const landMassIndexCache = {};
  const landMassEdgeCache = {};
  const otherLandMassCache = {};

  /**
   * Marble Hill is Manhattan borough but on the Bronx mainland. Roosevelt Island
   * and Governors Island stay with Manhattan island; Brooklyn and Queens are one mass.
   */
  function splitManhattanParts() {
    const man = boroughLand('Manhattan');
    if (!man) return { marbleHill: null, islands: null };
    if (man.geometry.type !== 'MultiPolygon') {
      return { marbleHill: null, islands: man };
    }
    let marbleHill = null;
    const islandParts = [];
    for (const p of man.geometry.coordinates) {
      const c = turf.centroid(turf.polygon(p));
      const [lng, lat] = c.geometry.coordinates;
      if (lat >= 40.862 && lng <= -73.908) marbleHill = p;
      else islandParts.push(p);
    }
    return {
      marbleHill: marbleHill ? turf.polygon(marbleHill) : null,
      islands: islandParts.length ? turf.multiPolygon(islandParts) : null,
    };
  }

  function buildLandMassPolys() {
    if (landMassPolyCache._built) return;
    const { marbleHill, islands } = splitManhattanParts();
    const mainlandParts = [boroughLand('Bronx'), boroughPoly('Jersey'), marbleHill].filter(Boolean);
    const longislandParts = [boroughLand('Brooklyn'), boroughLand('Queens')].filter(Boolean);
    landMassPolyCache.mainland = mainlandParts.length ? Geo().unionMany(mainlandParts) : null;
    landMassPolyCache.islands = islands;
    landMassPolyCache.longisland = longislandParts.length ? Geo().unionMany(longislandParts) : null;
    landMassPolyCache._built = true;
  }

  function landMassPoly(id) {
    buildLandMassPolys();
    return landMassPolyCache[id] || null;
  }

  function landMassIndex(id) {
    if (landMassIndexCache[id] !== undefined) return landMassIndexCache[id];
    const poly = landMassPoly(id);
    if (!poly) return null;
    const rings = simplifiedRings(poly, 0.00005);
    const index = rings.length ? Geo().buildSegmentIndex(rings, 0.02) : null;
    landMassIndexCache[id] = index;
    return index;
  }

  function landMassAt(lng, lat) {
    if (![lng, lat].every(Number.isFinite)) return null;
    for (const id of LAND_MASSES) {
      const poly = landMassPoly(id);
      if (poly && turf.booleanPointInPolygon([lng, lat], poly)) return id;
    }
    let best = LAND_MASSES[0];
    let bestD = Infinity;
    for (const id of LAND_MASSES) {
      const index = landMassIndex(id);
      if (!index) continue;
      const d = Geo().minDistanceIndexedMi(index, lng, lat);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  function seekerLandMass(q) {
    if (q.lat != null && q.lng != null) return landMassAt(q.lng, q.lat);
    return null;
  }

  function possibleLandMasses(st) {
    const h = hideRadiusMi + 1e-9;
    const out = [];
    for (const id of LAND_MASSES) {
      if (st.landMass === id) {
        out.push(id);
        continue;
      }
      const edges = landMassEdgeDistances(id);
      if (edges && edges[st.idx] <= h) out.push(id);
    }
    return out;
  }

  function landExceptMass(name) {
    if (otherLandMassCache[name] !== undefined) return otherLandMassCache[name];
    const parts = LAND_MASSES.filter(m => m !== name).map(m => landMassPoly(m)).filter(Boolean);
    if (parts.length < LAND_MASSES.length - 1) return null;
    otherLandMassCache[name] = Geo().unionMany(parts);
    return otherLandMassCache[name];
  }

  function clearLandMassCaches() {
    for (const k of Object.keys(landMassPolyCache)) delete landMassPolyCache[k];
    for (const k of Object.keys(landMassIndexCache)) delete landMassIndexCache[k];
    for (const k of Object.keys(landMassEdgeCache)) delete landMassEdgeCache[k];
    for (const k of Object.keys(otherLandMassCache)) delete otherLandMassCache[k];
  }

  function clearBoroughCaches() {
    [boroughLandCache, boroughMaskCache, boroughIndexCache, boroughEdgeCache, otherLandCache]
      .forEach(cache => { for (const k of Object.keys(cache)) delete cache[k]; });
    jerseyPoly = null;
    clearLandMassCaches();
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

  function landMassEdgeDistances(id) {
    const cached = landMassEdgeCache[id];
    if (cached && cached.length === stations.length) return cached;
    const index = landMassIndex(id);
    if (!index) return null;
    const out = new Float64Array(stations.length);
    for (let i = 0; i < stations.length; i++) {
      out[i] = Geo().minDistanceIndexedMi(index, stations[i].lng, stations[i].lat);
    }
    landMassEdgeCache[id] = out;
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

  const airportBisectors = new Map();

  function airportBisector(a, b) {
    const key = `${a.id}|${b.id}`;
    let bis = airportBisectors.get(key);
    if (bis === undefined) {
      bis = Geo().bisectorBetween(a, b);
      airportBisectors.set(key, bis);
    }
    return bis;
  }

  /**
   * Airports that could be the nearest one from somewhere in the station's hide
   * zone. An airport is out only when the whole zone sits on the far side of a
   * bisector, which is the same geodesic bisector the cell outline is drawn from,
   * so the map and the elimination always agree.
   */
  function possibleAirportIds(st) {
    const h = hideRadiusMi;
    const out = [];
    for (const a of AIRPORTS) {
      let ok = true;
      for (const b of AIRPORTS) {
        if (a.id === b.id) continue;
        const bis = airportBisector(b, a);
        if (!bis) continue;
        // Positive is toward `a`; the zone reaches its side while within h.
        if (Geo().bisectorSignedMiles(bis, st.lng, st.lat) < -h) { ok = false; break; }
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

    if (q.type === 'matching' && q.subtype === 'borough') {
      const boro = seekerBorough(q);
      if (!boro) return true;
      const possible = possibleBoroughs(st);
      if (q.answer === 'same') return possible.includes(boro);
      return possible.some(b => b !== boro);
    }

    if (q.type === 'matching' && q.subtype === 'airport') {
      if (q.lat == null) return true;
      const seeker = nearestAirport({ lat: q.lat, lng: q.lng }).airport;
      if (!seeker) return true;
      const possible = possibleAirportIds(st);
      if (q.answer === 'same') return possible.includes(seeker.id);
      return possible.some(id => id !== seeker.id);
    }

    if (q.type === 'matching' && q.subtype === 'landmass') {
      const mass = seekerLandMass(q);
      if (!mass) return true;
      const possible = possibleLandMasses(st);
      if (q.answer === 'same') return possible.includes(mass);
      return possible.some(m => m !== mass);
    }

    if (q.type === 'measuring' && q.subtype === 'coastline') {
      if (q.lat == null || !coastFeature) return true;
      const measure = distToCoast(q.lat, q.lng);
      const dists = coastDistances();
      const d = dists ? dists[st.idx] : distToCoast(st.lat, st.lng);
      if (q.answer === 'closer') return d - h <= measure + eps;
      return d + h >= measure - eps;
    }

    if (q.type === 'measuring' && q.subtype === 'airport') {
      if (q.lat == null) return true;
      const measure = nearestAirport({ lat: q.lat, lng: q.lng }).miles;
      const d = nearestAirport(st).miles;
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
        q.id, q.type, q.subtype, q.answer, q.lat, q.lng, q.latA, q.lngA,
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
    if (!qs.length) return gameArea;

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
      } else if (q.type === 'matching' && q.subtype === 'borough') {
        const boro = seekerBorough(q);
        if (q.answer === 'same') {
          const poly = boro && boroughPoly(boro);
          if (poly) area = Geo().modifyMapData(area, poly, true);
        } else if (boro) {
          const other = landExcept(boro);
          if (other) area = Geo().modifyMapData(area, other, true);
        }
      } else if (q.type === 'matching' && q.subtype === 'landmass') {
        const mass = seekerLandMass(q);
        if (q.answer === 'same') {
          const poly = mass && landMassPoly(mass);
          if (poly) area = Geo().modifyMapData(area, poly, true);
        } else if (mass) {
          const other = landExceptMass(mass);
          if (other) area = Geo().modifyMapData(area, other, true);
        }
      } else if (q.type === 'matching' && q.subtype === 'airport' && q.lat != null) {
        const cell = Geo().voronoiCellContaining({ lng: q.lng, lat: q.lat }, AIRPORTS);
        if (cell) area = Geo().modifyMapData(area, cell, q.answer === 'same');
      } else if (q.type === 'measuring' && q.subtype === 'coastline' && q.lat != null && coastFeature) {
        const band = coastBand(distToCoast(q.lat, q.lng));
        if (band) area = Geo().modifyMapData(area, band, q.answer === 'closer');
      } else if (q.type === 'measuring' && q.subtype === 'airport' && q.lat != null) {
        const m = nearestAirport({ lat: q.lat, lng: q.lng }).miles;
        const circles = AIRPORTS.map(a =>
          turf.circle([a.lng, a.lat], m, { steps: 64, units: 'miles' }));
        const band = Geo().unionMany(circles);
        if (band) area = Geo().modifyMapData(area, band, q.answer === 'closer');
      }
    }

    if (playablePoly) area = Geo().intersect(area, playablePoly) || area;

    areaCache = { key, area };
    return area;
  }

  let maskCache = { key: null, mask: null, border: null };

  function boroughQuestions() {
    return questions.filter(q =>
      q.answer != null && q.type === 'matching' && (q.subtype === 'borough' || q.subtype === 'landmass'));
  }

  /** Remaining playable land after borough / land-mass answers. Null = full start polygon. */
  function remainingPlayable() {
    const qs = boroughQuestions();
    if (!qs.length) return null;
    let area = playablePoly;
    if (!area) return null;
    for (const q of qs) {
      if (q.subtype === 'borough') {
        const boro = seekerBorough(q);
        const poly = boro && boroughPoly(boro);
        if (!poly) continue;
        area = Geo().modifyMapData(area, poly, q.answer === 'same');
      } else if (q.subtype === 'landmass') {
        const mass = seekerLandMass(q);
        const poly = mass && landMassPoly(mass);
        if (!poly) continue;
        area = Geo().modifyMapData(area, poly, q.answer === 'same');
      }
    }
    return Geo().safePoly(area);
  }

  function ensureMaskCache() {
    const key = boroughQuestions().map(q => `${q.id}:${q.subtype}:${q.answer}`).join('|') || 'start';
    if (maskCache.key === key) return maskCache;
    const remaining = remainingPlayable();
    if (!remaining) {
      maskCache = {
        key,
        mask: greyStatic || EMPTY_FC,
        border: playableBorder || EMPTY_FC,
      };
      return maskCache;
    }
    let grey = null;
    try { grey = turf.mask(remaining, Geo().MASK_FRAME); } catch (_) { grey = null; }
    const line = Geo().outerRingLine(remaining);
    maskCache = {
      key,
      mask: grey ? { type: 'FeatureCollection', features: [grey] } : (greyStatic || EMPTY_FC),
      border: line ? { type: 'FeatureCollection', features: [line] } : (playableBorder || EMPTY_FC),
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
        const link = Geo().thermometerLinkLine(q);
        if (link) {
          link.properties = { kind: 'thermo-link', id: q.id, color: q.colorA || q.color };
          features.push(link);
        }
        const bisector = Geo().thermometerBisectorLine(q);
        if (bisector) {
          bisector.properties = {
            kind: 'thermo-bisector', id: q.id, color: q.colorB || q.color,
          };
          features.push(bisector);
        }
        const mid = Geo().thermometerMidpoint(q);
        if (mid) {
          features.push(turf.feature(turf.point(mid).geometry, {
            kind: 'thermo-mid', id: q.id, color: q.colorB || q.color,
          }));
        }
      } else if (q.type === 'measuring' && q.subtype === 'coastline' && q.lat != null) {
        features.push(turf.feature(turf.point([q.lng, q.lat]).geometry, {
          kind: 'coast-point', id: q.id, color: q.color,
        }));
      } else if (q.type === 'matching' && q.subtype === 'airport' && q.lat != null) {
        for (const a of AIRPORTS) {
          features.push(turf.feature(turf.point([a.lng, a.lat]).geometry, {
            kind: 'airport', id: q.id, code: a.code, name: a.name, color: q.color,
          }));
        }
        const edges = Geo().voronoiBoundaryLines({ lng: q.lng, lat: q.lat }, AIRPORTS);
        for (const line of edges) {
          line.properties = { kind: 'airport-edge', id: q.id, color: q.color };
          features.push(line);
        }
      } else if (q.type === 'measuring' && q.subtype === 'airport' && q.lat != null) {
        const m = nearestAirport({ lat: q.lat, lng: q.lng }).miles;
        for (const a of AIRPORTS) {
          features.push(turf.feature(turf.point([a.lng, a.lat]).geometry, {
            kind: 'airport', id: q.id, code: a.code, name: a.name, color: q.color,
          }));
          const circle = turf.circle([a.lng, a.lat], m, { steps: 64, units: 'miles' });
          circle.properties = { kind: 'measure-airport-circle', id: q.id, color: q.color };
          features.push(circle);
        }
      }
    }
    return { type: 'FeatureCollection', features };
  }

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
    const n = questions.slice(0, index + 1).filter(x => x.type === q.type).length;
    if (q.type === 'radius') return `Radar ${n}`;
    if (q.type === 'thermometer') return `Thermometer ${n}`;
    if (q.type === 'matching') {
      if (q.subtype === 'airport') return `Matching ${n} · Airport`;
      if (q.subtype === 'landmass') return `Matching ${n} · Land mass`;
      return `Matching ${n} · Borough`;
    }
    if (q.type === 'measuring') {
      return q.subtype === 'airport' ? `Measuring ${n} · Airport` : `Measuring ${n} · Coastline`;
    }
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
    const tot = document.getElementById('cb-cost-total');
    if (tot) tot.textContent = `Cards drawn: ${cardsDrawn()}`;
    if (!questions.length) {
      el.innerHTML = '<p class="game-hint">Add a question, then open it to place pins on the map.</p>';
      return;
    }
    questions.forEach((q, i) => {
      const div = document.createElement('div');
      div.className = 'cb-item' + (q.open ? '' : ' collapsed');
      div.dataset.id = q.id;
      div.innerHTML = `
        <div class="cb-item-head">
          <span class="cb-item-chev">${q.open ? ICON.chevDown : ICON.chevRight}</span>
          <span>${questionTitle(q, i)}</span>
          <span class="q-cost">${costLabel(q)}</span>
        </div>
        <div class="cb-item-body">
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
    if (q.type === 'matching') {
      const sub = MATCH_SUBS.map(([id, label]) =>
        `<option value="${id}"${q.subtype === id ? ' selected' : ''}>${label}</option>`).join('');
      if (q.subtype === 'airport') {
        const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
        return `
          <select class="q-subtype" data-id="${q.id}">${sub}</select>
          ${locCard(q, 'Your location', 'center', q.lat, q.lng)}
          ${near ? `<p class="game-hint">Your nearest airport: <strong>${near.airport.name}</strong> (${near.miles.toFixed(1)} mi)</p>` : ''}
          ${resultRow(q, { ans: 'different', label: 'Different' }, { ans: 'same', label: 'Same as me' })}`;
      }
      if (q.subtype === 'landmass') {
        const mass = seekerLandMass(q);
        return `
          <select class="q-subtype" data-id="${q.id}">${sub}</select>
          ${locCard(q, 'Your location', 'center', q.lat, q.lng)}
          ${mass ? `<p class="game-hint">Your land mass: <strong>${LAND_MASS_LABEL[mass]}</strong></p>` : '<p class="game-hint">Place your pin to detect land mass.</p>'}
          ${resultRow(q, { ans: 'different', label: 'Different' }, { ans: 'same', label: 'Same as me' })}`;
      }
      const boro = seekerBorough(q);
      return `
        <select class="q-subtype" data-id="${q.id}">${sub}</select>
        ${locCard(q, 'Your location', 'center', q.lat, q.lng)}
        ${boro ? `<p class="game-hint">Your borough: <strong>${boro}</strong></p>` : '<p class="game-hint">Place your pin to detect the borough.</p>'}
        ${resultRow(q, { ans: 'different', label: 'Different' }, { ans: 'same', label: 'Same as me' })}`;
    }
    if (q.type === 'measuring') {
      const sub = MEASURE_SUBS.map(([id, label]) =>
        `<option value="${id}"${q.subtype === id ? ' selected' : ''}>${label}</option>`).join('');
      if (q.subtype === 'airport') {
        const near = q.lat != null ? nearestAirport({ lat: q.lat, lng: q.lng }) : null;
        return `
          <select class="q-subtype" data-id="${q.id}">${sub}</select>
          ${locCard(q, 'Your location', 'center', q.lat, q.lng)}
          ${near ? `<p class="game-hint">Nearest airport: <strong>${near.airport.name}</strong> (${near.miles.toFixed(1)} mi)</p>` : ''}
          ${resultRow(q, { ans: 'further', label: 'Hider Further' }, { ans: 'closer', label: 'Hider Closer' })}`;
      }
      const d = q.lat != null ? distToCoast(q.lat, q.lng) : null;
      return `
        <select class="q-subtype" data-id="${q.id}">${sub}</select>
        ${locCard(q, 'Your location', 'center', q.lat, q.lng)}
        ${d != null && isFinite(d) ? `<p class="game-hint">${d.toFixed(2)} mi from coast</p>` : ''}
        ${resultRow(q, { ans: 'further', label: 'Hider Further' }, { ans: 'closer', label: 'Hider Closer' })}`;
    }
    return '';
  }

  function bindQuestionInputs(el) {
    el.querySelectorAll('.q-coord, .q-coord-a, .q-coord-b').forEach(ta => {
      ta.addEventListener('change', () => updateQuestionFromInputs(ta.dataset.id));
      ta.addEventListener('blur', () => updateQuestionFromInputs(ta.dataset.id));
    });
    el.querySelectorAll('.q-radius, .q-unit, .q-subtype').forEach(inp => {
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
    if (q.type === 'radius' || usesCenter(q)) {
      const pt = parseCoord(root.querySelector('.q-coord')?.value);
      if (pt) { q.lat = pt.lat; q.lng = pt.lng; }
      if (q.type === 'radius') {
        q.radius = parseFloat(root.querySelector('.q-radius')?.value) || q.radius;
        q.unit = root.querySelector('.q-unit')?.value || 'miles';
      }
      const sub = root.querySelector('.q-subtype')?.value;
      if (sub) q.subtype = sub;
      if (q.type === 'matching' && q.subtype === 'borough' && q.lat != null) {
        q.borough = boroughAt(q.lng, q.lat);
      }
    } else if (q.type === 'thermometer') {
      const a = parseCoord(root.querySelector('.q-coord-a')?.value);
      const b = parseCoord(root.querySelector('.q-coord-b')?.value);
      if (a) { q.latA = a.lat; q.lngA = a.lng; }
      if (b) { q.latB = b.lat; q.lngB = b.lng; }
    }
    save(); notifyChange(); renderList();
  }

  function setQuestionPoint(id, field, lat, lng) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    if (field === 'center') {
      q.lat = lat; q.lng = lng;
      if (q.type === 'matching' && q.subtype === 'borough') q.borough = boroughAt(lng, lat);
    }
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

  function changeType(id, type, subtype) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    q.type = type;
    q.answer = null;
    if (type === 'matching') q.subtype = subtype || 'borough';
    else if (type === 'measuring') q.subtype = subtype || 'coastline';
    else q.subtype = null;
    if (type === 'radius') {
      if (q.radius == null) q.radius = parseFloat(document.getElementById('cb-radius-val')?.value) || 1;
      if (!q.unit) q.unit = 'miles';
    }
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
    if (usesCenter(q)) {
      if (q.lat == null) {
        q.lat = center.lat;
        q.lng = center.lng;
        changed = true;
      }
      if (q.type === 'matching' && q.subtype === 'borough') {
        q.borough = boroughAt(q.lng, q.lat);
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

  function addQuestion(type, subtype) {
    const base = { id: crypto.randomUUID(), type, color: nextColor(), answer: null, open: true };
    if (type === 'radius') {
      const radius = parseFloat(document.getElementById('cb-radius-val')?.value) || 1;
      const unit = document.getElementById('cb-radius-unit')?.value || 'miles';
      questions.push({ ...base, lat: null, lng: null, radius, unit });
    } else if (type === 'thermometer') {
      const colorA = base.color;
      const colorB = nextColor();
      questions.push({ ...base, colorA, colorB, color: colorA, latA: null, lngA: null, latB: null, lngB: null });
    } else if (type === 'matching') {
      questions.push({ ...base, subtype: subtype || 'borough', lat: null, lng: null, borough: null });
    } else if (type === 'measuring') {
      questions.push({ ...base, subtype: subtype || 'coastline', lat: null, lng: null });
    }
    save(); renderList(); notifyChange();
    const c = window.JetLagCitibikeApp?.mapCenter?.();
    if (c) ensureQuestionCoords(base.id, c);
    notifyChange();
  }

  function notifyChange() {
    if (onChange) onChange();
  }

  function airportsMoved() {
    airportBisectors.clear();
    activeCache = { key: null, list: null };
    areaCache = { key: null, area: null };
    maskCache = { key: null, mask: null, border: null };
    notifyChange();
  }

  async function initStationData(geojson) {
    const [boro, coast, area, playable, grey, border] = await Promise.all([
      fetch('data/nyc_boroughs.geojson').then(r => r.json()).catch(() => null),
      fetch('data/coastline.geojson').then(r => r.json()).catch(() => null),
      fetch('data/game_area.geojson?v=5').then(r => r.json()).catch(() => null),
      fetch('data/playable.geojson?v=5').then(r => r.json()).catch(() => null),
      fetch('data/grey.geojson?v=5').then(r => r.json()).catch(() => null),
      fetch('data/playable_border.geojson?v=5').then(r => r.json()).catch(() => null),
      Geo().snapAirportsViaTilequery(AIRPORTS, window.MAPBOX_TOKEN).catch(() => null),
    ]);
    airportBisectors.clear();
    try {
      if (boro) {
        for (const f of boro.features) boroughPolys[f.properties.BoroName] = f;
      }
    } catch (e) {
      console.warn('borough load failed', e);
    }
    clearBoroughCaches();
    gameArea = area?.features?.[0] || null;
    playablePoly = playable?.features?.[0] || gameArea;
    greyStatic = grey || null;
    playableBorder = border || null;
    maskCache = { key: null, mask: null, border: null };
    areaCache = { key: null, area: null };
    maskCache = { key: null, mask: null, border: null };
    activeCache = { key: null, list: null };
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
    const boroBoxes = BOROUGHS.filter(n => n !== 'Jersey').map(name => {
      const poly = boroughLand(name);
      let hit = poly;
      try { hit = turf.simplify(poly, { tolerance: 0.0002, highQuality: false }); } catch (_) { hit = poly; }
      return { name, poly: hit, box: poly ? turf.bbox(poly) : [0, 0, 0, 0] };
    }).filter(b => b.poly);

    stations = (geojson.features || []).map((f, i) => {
      const [lng, lat] = f.geometry.coordinates;
      let borough = f.properties.borough || 'Jersey';
      if (!f.properties.borough) {
        for (const b of boroBoxes) {
          if (lng < b.box[0] || lng > b.box[2] || lat < b.box[1] || lat > b.box[3]) continue;
          if (turf.booleanPointInPolygon([lng, lat], b.poly)) { borough = b.name; break; }
        }
      }
      const st = {
        idx: i,
        id: f.properties.station_id || `${lng.toFixed(6)}_${lat.toFixed(6)}_${i}`,
        name: f.properties.name || `Station ${i}`,
        lng, lat, borough,
      };
      st.landMass = landMassAt(lng, lat);
      return st;
    });
  }

  function bindUI() {
    const kindBtns = document.querySelectorAll('#cb-q-kind button');
    const subRow = document.getElementById('cb-q-subrow');
    const subSel = document.getElementById('cb-q-subtype');
    const costHint = document.getElementById('cb-q-cost-hint');
    const radiusOpts = document.getElementById('cb-radius-opts');

    function currentKind() {
      return document.querySelector('#cb-q-kind button.active')?.dataset.kind || 'radius';
    }

    function syncKindUI() {
      const kind = currentKind();
      const cost = CAST_COST[kind];
      if (costHint && cost) costHint.textContent = `${cost.name} · draw ${cost.draw} pick ${cost.pick}`;
      if (radiusOpts) radiusOpts.hidden = kind !== 'radius';
      if (subRow) subRow.hidden = kind !== 'matching' && kind !== 'measuring';
      const subLabel = document.getElementById('cb-q-sublabel');
      if (subLabel) {
        subLabel.textContent = kind === 'measuring'
          ? 'Compared to me, closer or further to…'
          : 'Is your … the same as mine?';
      }
      if (subSel && (kind === 'matching' || kind === 'measuring')) {
        const opts = kind === 'matching' ? MATCH_SUBS : MEASURE_SUBS;
        subSel.innerHTML = opts.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
      }
    }

    kindBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        kindBtns.forEach(b => b.classList.toggle('active', b === btn));
        syncKindUI();
      });
    });
    syncKindUI();

    document.getElementById('cb-add-question')?.addEventListener('click', () => {
      const kind = currentKind();
      const subtype = subSel?.value;
      addQuestion(kind, subtype);
    });
    document.getElementById('cb-clear-all')?.addEventListener('click', () => {
      if (!confirm('Remove all questions?')) return;
      questions = []; save(); notifyChange(); renderList();
    });
    let radiusTimer = null;
    document.getElementById('cb-hide-radius')?.addEventListener('input', e => {
      hideRadiusMi = Math.max(0.05, parseFloat(e.target.value) || 0.2);
      const lbl = document.getElementById('cb-hide-radius-label');
      if (lbl) lbl.textContent = `${hideRadiusMi.toFixed(2)} mi`;
      clearTimeout(radiusTimer);
      radiusTimer = setTimeout(notifyChange, 130);
    });
  }

  load();

  window.JetLagCitibikeGame = {
    parseCoord, fmtCoord, bindUI, renderList, initStationData,
    getActiveStations, activeStationFeatures, overlapZonesGeoJSON, mergedZonesGeoJSON,
    questionsGeoJSON, eliminatedMask, possibleAreaGeoJSON, stationCircle, setQuestionPoint,
    ensureQuestionCoords, distMi, usesCenter,
    getQuestions: () => questions,
    get hideRadiusMi() { return hideRadiusMi; },
    get stations() { return stations; },
    set onChange(fn) { onChange = fn; },
    airportsMoved,
    BOROUGHS, AIRPORTS, CAST_COST,
  };
})();
