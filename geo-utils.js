/** Geo elimination helpers (ported from JetLagHideAndSeek operators). */
window.JetLagGeo = (function () {
  const WORLD = turf.polygon([[
    [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85],
  ]]);
  /** Metro-scale frame for the gray overlay. World-sized rings do not fill in Mapbox GL. */
  const MASK_FRAME = turf.bboxPolygon([-75.8, 39.6, -71.4, 42.2]);

  function safeFeature(g) {
    if (!g) return null;
    if (g.type === 'Feature') return g;
    if (g.type === 'FeatureCollection') {
      const f = g.features?.[0];
      return f || null;
    }
    return turf.feature(g);
  }

  function safePoly(g) {
    const f = safeFeature(g);
    if (!f) return null;
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') return f;
    return null;
  }

  function intersect(a, b) {
    const fa = safePoly(a), fb = safePoly(b);
    if (!fa || !fb) return fa || fb;
    try {
      const x = turf.intersect(turf.featureCollection([fa, fb]));
      return x || turf.feature(turf.polygon([]));
    } catch (_) {
      return fa;
    }
  }

  /** Drop interior rings — one outer coast loop, no pier/island hole outlines. */
  function outerRing(region) {
    const f = safePoly(region);
    if (!f) return null;
    const g = f.geometry;
    if (g.type === 'Polygon') return turf.polygon([g.coordinates[0]]);
    if (g.type === 'MultiPolygon') {
      let best = null;
      let bestA = -1;
      for (const p of g.coordinates) {
        const ring = p[0];
        let a = 0;
        try { a = turf.area(turf.polygon([ring])); } catch (_) { a = 0; }
        if (a > bestA) { bestA = a; best = ring; }
      }
      return best ? turf.polygon([best]) : null;
    }
    return null;
  }

  /**
   * Gray overlay: metro frame with the playable outer ring punched as a hole.
   * Built as a two-ring polygon so Mapbox can fill it (unlike world-scale difference).
   */
  function maskOutside(hole, frame) {
    const cutout = outerRing(hole) || safePoly(hole);
    const base = safePoly(frame) || MASK_FRAME;
    if (!cutout) return base;
    try {
      return turf.mask(cutout, base);
    } catch (_) {
      return base;
    }
  }

  function holedMask(region) {
    return maskOutside(region, MASK_FRAME);
  }

  /** LineString border from the outer shell — never traces interior rings. */
  function outerRingLine(region) {
    const shell = outerRing(region);
    if (!shell) return null;
    const ring = shell.geometry.coordinates[0];
    if (!ring?.length) return null;
    return turf.lineString(ring);
  }

  /** positive=true → keep overlap; false → keep outside region */
  function modifyMapData(mapData, region, positive) {
    const base = safePoly(mapData);
    if (!base) return mapData;
    const reg = safePoly(region);
    if (!reg) return base;
    // Every region we build sits well inside WORLD, so clipping against it is a
    // no-op — skipping it avoids an expensive boolean on detailed outlines. The
    // result is wrapped fresh because callers attach properties to it, and the
    // region itself may be a cached borough outline.
    if (positive) {
      if (base === WORLD) return turf.feature(reg.geometry, { ...reg.properties });
      return intersect(base, reg) || turf.feature(turf.polygon([]));
    }
    return intersect(base, holedMask(reg)) || turf.feature(turf.polygon([]));
  }

  function geodesicCircle(lng, lat, radius, unit) {
    return turf.circle([lng, lat], radius, { steps: 96, units: unit });
  }

  const MI_PER_DEG_LAT = 69.0546;

  /**
   * Local equirectangular frame in miles. The mapping is linear, so straight
   * lines in this frame stay straight in lng/lat — required for half-planes.
   */
  function localFrame(lat0, lng0) {
    const kx = MI_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
    return {
      xy: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * MI_PER_DEG_LAT],
      ll: (x, y) => [lng0 + x / kx, lat0 + y / MI_PER_DEG_LAT],
    };
  }

  const EARTH_RADIUS_MI = 3958.7613;
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;

  function toVec(lng, lat) {
    const p = lat * D2R;
    const l = lng * D2R;
    const c = Math.cos(p);
    return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
  }

  function toLngLat(v) {
    const z = Math.max(-1, Math.min(1, v[2]));
    return [Math.atan2(v[1], v[0]) * R2D, Math.asin(z) * R2D];
  }

  function unit(v) {
    const m = Math.hypot(v[0], v[1], v[2]);
    if (!m) return null;
    return [v[0] / m, v[1] / m, v[2] / m];
  }

  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  /** ca*a + cb*b */
  function mix3(a, ca, b, cb) {
    return [a[0] * ca + b[0] * cb, a[1] * ca + b[1] * cb, a[2] * ca + b[2] * cb];
  }

  /**
   * Exact perpendicular bisector of A and B. A point P is equidistant from both
   * exactly when P·(A-B) = 0, so the bisector is the great circle whose normal is
   * `pole`. `mid` is the true geodesic midpoint and lies on that circle, and
   * `sweep` runs along the circle through `mid`. Nothing here approximates the
   * sphere with a flat frame, so the drawn line is the equidistant locus itself.
   */
  function bisectorBetween(a, b) {
    if (![a?.lng, a?.lat, b?.lng, b?.lat].every(Number.isFinite)) return null;
    const va = toVec(a.lng, a.lat);
    const vb = toVec(b.lng, b.lat);
    const pole = unit(mix3(va, 1, vb, -1));
    const mid = unit(mix3(va, 1, vb, 1));
    const sweep = pole && mid ? unit(cross3(pole, mid)) : null;
    return sweep ? { pole, mid, sweep, a: va, b: vb } : null;
  }

  /** Miles from the bisector; positive means closer to B. */
  function bisectorSignedMiles(bis, lng, lat) {
    if (!bis) return 0;
    const s = Math.max(-1, Math.min(1, dot3(bis.pole, toVec(lng, lat))));
    return -Math.asin(s) * EARTH_RADIUS_MI;
  }

  /**
   * Unit vectors along the bisector, from +radiusMi to -radiusMi either side of
   * the midpoint. Densified because Mapbox draws each segment straight.
   */
  function bisectorArc(bis, radiusMi, steps) {
    const max = radiusMi / EARTH_RADIUS_MI;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = (1 - 2 * (i / steps)) * max;
      out.push(mix3(bis.mid, Math.cos(t), bis.sweep, Math.sin(t)));
    }
    return out;
  }

  /** Everything closer to B (or to A) than to the other end. */
  function bisectorHalfPlane(bis, towardB, spanMi, steps) {
    if (!bis) return WORLD;
    const span = spanMi || 500;
    const near = bisectorArc(bis, span, steps || 96);
    // Arc points are perpendicular to `pole`, so stepping along it by angle t
    // lands exactly t radians off the bisector. B's side is where P·pole < 0.
    const t = span / EARTH_RADIUS_MI;
    const side = towardB ? -1 : 1;
    const far = near
      .map(v => mix3(v, Math.cos(t), bis.pole, side * Math.sin(t)))
      .reverse();
    const ring = near.concat(far).map(toLngLat);
    ring.push(ring[0]);
    return turf.polygon([ring]);
  }

  /** The bisector itself, drawn through the geodesic midpoint. */
  function bisectorLine(bis, lengthMi) {
    if (!bis) return null;
    return turf.lineString(bisectorArc(bis, lengthMi || 60, 64).map(toLngLat));
  }

  /** The geodesic from A to B, so a bisector can be read against what it bisects. */
  function geodesicLine(bis, steps) {
    if (!bis) return null;
    const cos = Math.max(-1, Math.min(1, dot3(bis.a, bis.b)));
    const span = Math.acos(cos);
    if (!span) return null;
    // Component of B perpendicular to A, so rotating A toward it stays in-plane.
    const perp = unit(mix3(bis.b, 1, bis.a, -cos));
    if (!perp) return null;
    const n = steps || 24;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * span;
      pts.push(toLngLat(mix3(bis.a, Math.cos(t), perp, Math.sin(t))));
    }
    return turf.lineString(pts);
  }

  let thermoCache = { key: null, bis: null };

  /** Elimination asks for this once per station, so keep the last one. */
  function thermoBisector(q) {
    const key = `${q.lngA},${q.latA},${q.lngB},${q.latB}`;
    if (thermoCache.key === key) return thermoCache.bis;
    const bis = bisectorBetween(
      { lng: q.lngA, lat: q.latA },
      { lng: q.lngB, lat: q.latB },
    );
    thermoCache = { key, bis };
    return bis;
  }

  /** Miles from the bisector; positive means closer to B, the warm end. */
  function thermometerSignedMiles(q, lng, lat) {
    return bisectorSignedMiles(thermoBisector(q), lng, lat);
  }

  /** Region on the warmer (B) or colder (A) side of the bisector. */
  function thermometerRegion(q, warmer) {
    return bisectorHalfPlane(thermoBisector(q), warmer);
  }

  function thermometerBisectorLine(q, lengthMi) {
    return bisectorLine(thermoBisector(q), lengthMi);
  }

  function thermometerLinkLine(q) {
    return geodesicLine(thermoBisector(q));
  }

  /** Geodesic midpoint of the two thermometer ends. */
  function thermometerMidpoint(q) {
    const bis = thermoBisector(q);
    return bis ? toLngLat(bis.mid) : null;
  }

  function nearestIndex(target, points) {
    const v = toVec(target.lng, target.lat);
    let best = -1;
    let bestDot = -Infinity;
    for (let i = 0; i < points.length; i++) {
      // Larger dot product means a smaller angle, so a nearer point.
      const d = dot3(v, toVec(points[i].lng, points[i].lat));
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  function flattenRings(poly) {
    const f = safePoly(poly);
    if (!f) return [];
    const g = f.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    const rings = [];
    for (const p of polys) {
      for (const r of p) if (r && r.length > 1) rings.push(r);
    }
    return rings;
  }

  function segmentDistanceMi(segs, i, lng, lat, kx) {
    const o = i * 4;
    const x1 = (segs[o] - lng) * kx;
    const y1 = (segs[o + 1] - lat) * MI_PER_DEG_LAT;
    const x2 = (segs[o + 2] - lng) * kx;
    const y2 = (segs[o + 3] - lat) * MI_PER_DEG_LAT;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(x1 * dx + y1 * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.sqrt(cx * cx + cy * cy);
  }

  /** Min distance in miles from a point to any ring segment. */
  function minDistanceToRingsMi(lng, lat, rings) {
    const kx = MI_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const segs = [ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]];
        const d = segmentDistanceMi(segs, 0, lng, lat, kx);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /**
   * Uniform grid over ring segments. Distance queries then touch only nearby
   * cells, which turns thousands of coastline/borough lookups into milliseconds.
   */
  function buildSegmentIndex(rings, cellDeg) {
    const cell = cellDeg || 0.02;
    const flat = [];
    const grid = new Map();
    const long = [];
    const push = (gx, gy, i) => {
      const k = `${gx},${gy}`;
      const arr = grid.get(k);
      if (arr) arr.push(i);
      else grid.set(k, [i]);
    };
    for (const ring of rings || []) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1];
        const b = ring[i];
        const id = flat.length / 4;
        flat.push(a[0], a[1], b[0], b[1]);
        const gx0 = Math.floor(Math.min(a[0], b[0]) / cell);
        const gx1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const gy0 = Math.floor(Math.min(a[1], b[1]) / cell);
        const gy1 = Math.floor(Math.max(a[1], b[1]) / cell);
        if ((gx1 - gx0) > 32 || (gy1 - gy0) > 32) { long.push(id); continue; }
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) push(gx, gy, id);
        }
      }
    }
    return { cell, segs: Float64Array.from(flat), grid, long };
  }

  function minDistanceIndexedMi(index, lng, lat) {
    if (!index || !index.segs.length) return Infinity;
    const { cell, segs, grid, long } = index;
    const kx = MI_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
    const gx = Math.floor(lng / cell);
    const gy = Math.floor(lat / cell);
    let best = Infinity;
    for (const i of long) {
      const d = segmentDistanceMi(segs, i, lng, lat, kx);
      if (d < best) best = d;
    }
    // A ring r away is at least this far in miles, so we can stop once best is closer.
    const step = cell * Math.min(kx, MI_PER_DEG_LAT);
    const seen = new Set();
    for (let r = 0; r < 400; r++) {
      if (best <= r * step) break;
      for (let dx = -r; dx <= r; dx++) {
        const edgeX = Math.abs(dx) === r;
        for (let dy = -r; dy <= r; dy++) {
          if (r > 0 && !edgeX && Math.abs(dy) !== r) continue;
          const arr = grid.get(`${gx + dx},${gy + dy}`);
          if (!arr) continue;
          for (const i of arr) {
            if (seen.has(i)) continue;
            seen.add(i);
            const d = segmentDistanceMi(segs, i, lng, lat, kx);
            if (d < best) best = d;
          }
        }
      }
    }
    return best;
  }

  function mapRings(coords, fn) {
    return coords.map(ring => ring.map(pt => fn(pt[0], pt[1])));
  }

  function projectFeature(f, xy) {
    const g = f.geometry;
    if (g.type === 'Polygon') {
      return turf.polygon(mapRings(g.coordinates, xy), f.properties);
    }
    if (g.type === 'MultiPolygon') {
      return turf.multiPolygon(g.coordinates.map(p => mapRings(p, xy)), f.properties);
    }
    return f;
  }

  /**
   * Voronoi cell of whichever point in points[] is nearest to target.
   *
   * The boundary is the geodesic perpendicular bisector against every other
   * site. Intersecting those half-planes in lng/lat collapsed each edge to a
   * couple of chords (one degree of longitude is shorter than one of latitude),
   * so the clip happens in a local mile frame after the arcs are densified.
   */
  function voronoiCellContaining(target, points) {
    if (!points || !points.length) return null;
    if (points.length === 1) return WORLD;
    const i = nearestIndex(target, points);
    if (i < 0) return null;
    const own = points[i];
    const frame = localFrame(own.lat, own.lng);
    let cell = null;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const bis = bisectorBetween(points[j], own);
      if (!bis) continue;
      // 80 mi covers the metro; 160 steps keeps ~0.5 mi between vertices so
      // Mapbox's straight segments still read as the geodesic.
      const half = projectFeature(bisectorHalfPlane(bis, true, 80, 160), frame.xy);
      cell = cell ? intersect(cell, half) : half;
      if (!cell) return null;
    }
    return cell ? projectFeature(cell, frame.ll) : null;
  }

  /**
   * Geodesic Voronoi edges of the cell containing target. Each line is the
   * equidistant locus against one neighbour, clipped where a third site is
   * closer — the same test station elimination uses, so the drawn line and the
   * surviving stations always agree.
   */
  function voronoiBoundaryLines(target, points, spanMi) {
    if (!points || points.length < 2) return [];
    const i = nearestIndex(target, points);
    if (i < 0) return [];
    const own = points[i];
    const span = spanMi || 40;
    const lines = [];
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const bis = bisectorBetween(points[j], own);
      if (!bis) continue;
      const run = [];
      const flush = () => {
        if (run.length >= 2) lines.push(turf.lineString(run.slice()));
        run.length = 0;
      };
      for (const v of bisectorArc(bis, span, 96)) {
        const ll = toLngLat(v);
        let ok = true;
        for (let k = 0; k < points.length; k++) {
          if (k === i || k === j) continue;
          const b3 = bisectorBetween(points[k], own);
          if (b3 && bisectorSignedMiles(b3, ll[0], ll[1]) < -0.02) { ok = false; break; }
        }
        if (ok) run.push(ll);
        else flush();
      }
      flush();
    }
    return lines;
  }

  const AIRPORT_NAME_NEEDLES = {
    skyports: ['skyports', 'seaplane'],
    lga: ['laguardia'],
    jfk: ['kennedy'],
  };

  // Mapbox Standard `airport-label` reads composite source-layer `airport_label`
  // from mapbox-streets-v8-lite (same points as full streets-v8).
  const AIRPORT_LABEL_TILESETS = [
    'mapbox.mapbox-streets-v8-lite',
    'mapbox.mapbox-streets-v8',
  ];
  const AIRPORT_SNAP_MAX_DEG = 0.04; // ~2.7 mi; keeps EWR / Teterboro out

  function airportMakiOk(airport, props) {
    const maki = String(props?.maki || '').toLowerCase();
    if (maki === 'heliport' || maki === 'parking' || maki === 'parking-garage' || maki === 'harbor') {
      return false;
    }
    if (maki === 'airport') return true;
    // Seaplane bases use Maki "airfield" on the airport-label layer.
    return airport.id === 'skyports' && maki === 'airfield';
  }

  function airportNameMatches(airport, name) {
    const n = String(name || '').toLowerCase();
    const needles = AIRPORT_NAME_NEEDLES[airport.id] || [airport.name.toLowerCase()];
    return needles.some(needle => n.includes(needle));
  }

  function featureLngLat(f) {
    const g = f?.geometry;
    if (g?.type === 'Point' && Number.isFinite(g.coordinates?.[0]) && Number.isFinite(g.coordinates?.[1])) {
      return g.coordinates;
    }
    const c = f?.center;
    if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) return c;
    return null;
  }

  function isAirportLabelLayer(layer) {
    if (!layer) return false;
    const sl = String(layer['source-layer'] || '');
    if (sl === 'airport_label') return true;
    const id = String(layer.id || '').toLowerCase();
    return id === 'airport-label' || id === 'airport_label';
  }

  function collectAirportLabelFeatures(map) {
    const out = [];
    const pushAll = (feats) => {
      if (!feats) return;
      for (let i = 0; i < feats.length; i++) out.push(feats[i]);
    };

    const layerIds = [];
    try {
      const layers = map.getStyle()?.layers || [];
      for (const layer of layers) {
        if (isAirportLabelLayer(layer) && layer.id && map.getLayer(layer.id)) {
          layerIds.push(layer.id);
        }
      }
    } catch (_) { /* style not ready */ }
    if (!layerIds.length && map.getLayer?.('airport-label')) layerIds.push('airport-label');

    if (layerIds.length) {
      try { pushAll(map.queryRenderedFeatures({ layers: layerIds })); } catch (_) { /* missing layer */ }
    }
    try { pushAll(map.queryRenderedFeatures()); } catch (_) { /* ignore */ }

    try {
      const seen = new Set();
      for (const layer of (map.getStyle()?.layers || [])) {
        if (!isAirportLabelLayer(layer) || !layer.source) continue;
        const sl = layer['source-layer'] || 'airport_label';
        const key = `${layer.source}\0${sl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try { pushAll(map.querySourceFeatures(layer.source, { sourceLayer: sl })); } catch (_) { /* unloaded */ }
      }
    } catch (_) { /* ignore */ }

    return out;
  }

  function pickAirportIcon(airport, feats) {
    let best = null;
    let bestD = Infinity;
    for (const f of feats) {
      const p = f.properties || {};
      const name = p.name || p.name_en || p.airport_ref || '';
      if (!airportMakiOk(airport, p) || !airportNameMatches(airport, name)) continue;
      const c = featureLngLat(f);
      if (!c) continue;
      const dLng = c[0] - airport.lng;
      const dLat = c[1] - airport.lat;
      if (Math.abs(dLng) > AIRPORT_SNAP_MAX_DEG || Math.abs(dLat) > AIRPORT_SNAP_MAX_DEG) continue;
      const d2 = dLng * dLng + dLat * dLat;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }
    return best;
  }

  /**
   * Snap to Mapbox Standard `airport-label` icons (source-layer airport_label).
   * Matches only LGA / JFK / Skyports by maki + name. Skips parking, marinas,
   * heliports, hotels, terminal shops, and other airports.
   */
  function snapAirportsFromMap(airports, map) {
    if (!map || !airports?.length) return { moved: false, snappedIds: [] };
    const feats = collectAirportLabelFeatures(map);
    let moved = false;
    const snappedIds = [];
    for (const a of airports) {
      const best = pickAirportIcon(a, feats);
      if (!best) continue;
      snappedIds.push(a.id);
      if (Math.abs(best[0] - a.lng) > 1e-7 || Math.abs(best[1] - a.lat) > 1e-7) {
        a.lng = best[0];
        a.lat = best[1];
        moved = true;
      }
    }
    return { moved, snappedIds };
  }

  async function tilequeryAirportLabel(lng, lat, token, tileset) {
    const url = `https://api.mapbox.com/v4/${tileset}/tilequery/${lng},${lat}.json`
      + '?layers=airport_label&radius=8000&limit=20'
      + `&access_token=${encodeURIComponent(token)}`;
    const data = await fetch(url).then(r => r.ok ? r.json() : null);
    return data?.features || [];
  }

  /**
   * Fallback when the live map has not loaded airport-label tiles yet.
   * Queries the same airport_label layer Standard draws — never Search Box
   * or poi_label (those snap to terminal shops / the Skyport garage).
   */
  async function snapAirportsToMapbox(airports, token) {
    if (!token || String(token).indexOf('YOUR_MAPBOX') === 0 || !airports?.length) return airports;
    await Promise.all(airports.map(async (a) => {
      try {
        let feats = [];
        for (const tileset of AIRPORT_LABEL_TILESETS) {
          feats = await tilequeryAirportLabel(a.lng, a.lat, token, tileset);
          if (feats.length) break;
        }
        const c = pickAirportIcon(a, feats);
        if (c) { a.lng = c[0]; a.lat = c[1]; }
      } catch (_) { /* keep the airport-label seed */ }
    }));
    return airports;
  }

  async function snapAirportsViaTilequery(airports, token) {
    return snapAirportsToMapbox(airports, token);
  }

  function unionMany(features) {
    let acc = null;
    for (const f of features) {
      const p = safePoly(f);
      if (!p) continue;
      if (!acc) { acc = p; continue; }
      try {
        acc = turf.union(turf.featureCollection([acc, p])) || acc;
      } catch (_) { /* skip bad union */ }
    }
    return acc || turf.feature(turf.polygon([]));
  }

  return {
    WORLD, MASK_FRAME, intersect, holedMask, maskOutside, outerRing, outerRingLine,
    modifyMapData, geodesicCircle,
    thermometerRegion, thermometerBisectorLine, thermometerSignedMiles,
    thermometerMidpoint, thermometerLinkLine,
    bisectorBetween, bisectorSignedMiles, bisectorHalfPlane, bisectorLine,
    localFrame, flattenRings, minDistanceToRingsMi, MI_PER_DEG_LAT,
    buildSegmentIndex, minDistanceIndexedMi,
    voronoiCellContaining, voronoiBoundaryLines,
    snapAirportsViaTilequery, snapAirportsToMapbox, snapAirportsFromMap, unionMany, safePoly,
  };
})();
