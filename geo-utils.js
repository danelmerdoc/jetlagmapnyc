/** Geo elimination helpers (ported from JetLagHideAndSeek operators). */
window.JetLagGeo = (function () {
  const WORLD = turf.polygon([[
    [-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85],
  ]]);

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

  const WORLD_RING = WORLD.geometry.coordinates[0];

  /**
   * Everything outside `region`, i.e. the gray overlay.
   *
   * When the region's parts are solid and disjoint, that is just the world ring
   * with each part's outline punched out as a hole — exact, and far cheaper than a
   * general boolean against a detailed shoreline. Parts that already carry
   * interior rings would nest holes inside holes, so those fall back to a
   * difference.
   */
  function holedMask(region) {
    const f = safePoly(region);
    if (!f) return WORLD;
    const parts = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates
      : [f.geometry.coordinates];
    if (parts.length && parts.every(p => p.length === 1)) {
      try {
        return turf.polygon([WORLD_RING].concat(parts.map(p => p[0])));
      } catch (_) { /* fall through to the boolean */ }
    }
    try {
      const hole = turf.difference(turf.featureCollection([WORLD, f]));
      return hole || WORLD;
    } catch (_) {
      return WORLD;
    }
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
  function bisectorHalfPlane(bis, towardB, spanMi) {
    if (!bis) return WORLD;
    const span = spanMi || 500;
    const near = bisectorArc(bis, span, 96);
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

  /**
   * Voronoi cell of whichever point in points[] is nearest to target.
   *
   * turf.voronoi treats lng/lat as a flat plane, so its edges are equidistant in
   * degrees rather than miles — around New York that misplaced airport cell edges
   * by up to ten miles. The cell is instead the intersection of the exact
   * bisector half-planes against every other point.
   */
  function voronoiCellContaining(target, points) {
    if (!points || !points.length) return null;
    if (points.length === 1) return WORLD;
    const i = nearestIndex(target, points);
    if (i < 0) return null;
    const own = points[i];
    let cell = null;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const bis = bisectorBetween(points[j], own);
      if (!bis) continue;
      // `own` is B in this bisector, so keep the side toward B.
      const half = bisectorHalfPlane(bis, true);
      cell = cell ? intersect(cell, half) : half;
      if (!cell) return null;
    }
    return cell;
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
    WORLD, intersect, holedMask, modifyMapData, geodesicCircle,
    thermometerRegion, thermometerBisectorLine, thermometerSignedMiles,
    thermometerMidpoint, thermometerLinkLine,
    bisectorBetween, bisectorSignedMiles, bisectorHalfPlane, bisectorLine,
    localFrame, flattenRings, minDistanceToRingsMi, MI_PER_DEG_LAT,
    buildSegmentIndex, minDistanceIndexedMi,
    voronoiCellContaining, unionMany, safePoly,
  };
})();
