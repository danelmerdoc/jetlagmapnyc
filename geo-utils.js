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

  function holedMask(region) {
    const f = safePoly(region);
    if (!f) return WORLD;
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
    if (positive) return intersect(base, reg) || turf.feature(turf.polygon([]));
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
  let bisCache = { key: null, bis: null };

  function thermoBisector(q) {
    if (![q.lngA, q.latA, q.lngB, q.latB].every(Number.isFinite)) return null;
    // Elimination asks for this once per station, so keep the last one.
    const key = `${q.lngA},${q.latA},${q.lngB},${q.latB}`;
    if (bisCache.key === key) return bisCache.bis;
    const a = toVec(q.lngA, q.latA);
    const b = toVec(q.lngB, q.latB);
    const pole = unit(mix3(a, 1, b, -1));
    const mid = unit(mix3(a, 1, b, 1));
    const sweep = pole && mid ? unit(cross3(pole, mid)) : null;
    const bis = sweep ? { pole, mid, sweep } : null;
    bisCache = { key, bis };
    return bis;
  }

  /**
   * Miles from the bisector; positive means closer to B, the warm end.
   * P·pole > 0 means P is nearer A, so the sign is flipped.
   */
  function thermometerSignedMiles(q, lng, lat) {
    const bis = thermoBisector(q);
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

  /** Region on the warmer (B) or colder (A) side of the bisector. */
  function thermometerRegion(q, warmer) {
    const bis = thermoBisector(q);
    if (!bis) return WORLD;
    const near = bisectorArc(bis, 500, 96);
    // Arc points are perpendicular to `pole`, so stepping along it by angle t
    // lands exactly t radians off the bisector. Warm side is where P·pole < 0.
    const t = 500 / EARTH_RADIUS_MI;
    const side = warmer ? -1 : 1;
    const far = near
      .map(v => mix3(v, Math.cos(t), bis.pole, side * Math.sin(t)))
      .reverse();
    const ring = near.concat(far).map(toLngLat);
    ring.push(ring[0]);
    return turf.polygon([ring]);
  }

  /** The bisector itself, drawn through the geodesic midpoint. */
  function thermometerBisectorLine(q, lengthMi) {
    const bis = thermoBisector(q);
    if (!bis) return null;
    return turf.lineString(bisectorArc(bis, lengthMi || 60, 64).map(toLngLat));
  }

  /** The A–B geodesic, so the bisector can be read against what it bisects. */
  function thermometerLinkLine(q) {
    const bis = thermoBisector(q);
    if (!bis) return null;
    const a = toVec(q.lngA, q.latA);
    const b = toVec(q.lngB, q.latB);
    const span = Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));
    if (!span) return null;
    const steps = 24;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * span;
      // Rotate from A toward B within their common plane.
      const v = unit(mix3(a, Math.cos(t), unit(mix3(b, 1, a, -dot3(a, b))), Math.sin(t)));
      pts.push(toLngLat(v || a));
    }
    return turf.lineString(pts);
  }

  /** Geodesic midpoint of the two thermometer ends. */
  function thermometerMidpoint(q) {
    const bis = thermoBisector(q);
    if (!bis) return null;
    return toLngLat(bis.mid);
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

  /** Voronoi cell for nearest of points[] containing target point. */
  function voronoiCellContaining(target, points) {
    if (!points.length) return null;
    if (points.length === 1) return WORLD;
    const fc = turf.featureCollection(points.map(p => turf.point([p.lng, p.lat], { id: p.id })));
    const bbox = turf.bbox(fc);
    const pad = 0.15;
    const vor = turf.voronoi(fc, { bbox: [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad] });
    const pt = turf.point([target.lng, target.lat]);
    for (const f of vor.features) {
      if (turf.booleanPointInPolygon(pt, f)) return f;
    }
    return null;
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
    localFrame, flattenRings, minDistanceToRingsMi, MI_PER_DEG_LAT,
    buildSegmentIndex, minDistanceIndexedMi,
    voronoiCellContaining, unionMany, safePoly,
  };
})();
