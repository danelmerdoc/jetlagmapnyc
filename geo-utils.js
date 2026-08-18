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

  /** Half-plane on the warmer (B) or colder (A) side of the perpendicular bisector. */
  function thermometerRegion(q, warmer) {
    const a = turf.point([q.lngA, q.latA]);
    const b = turf.point([q.lngB, q.latB]);
    const mid = turf.midpoint(a, b);
    const abBearing = turf.bearing(a, b);
    const perp = abBearing + 90;
    const keep = warmer ? abBearing : abBearing + 180;
    // Short bisector segment — long chords bend in lat/lng and put A and B on the same side.
    const bisKm = 80;
    const extKm = 2000;
    const b1 = turf.destination(mid, bisKm, perp, { units: 'kilometers' });
    const b2 = turf.destination(mid, bisKm, perp + 180, { units: 'kilometers' });
    const f1 = turf.destination(b1, extKm, keep, { units: 'kilometers' });
    const f2 = turf.destination(b2, extKm, keep, { units: 'kilometers' });
    return turf.polygon([[
      b1.geometry.coordinates,
      b2.geometry.coordinates,
      f2.geometry.coordinates,
      f1.geometry.coordinates,
      b1.geometry.coordinates,
    ]]);
  }

  /** Long segment through the midpoint, perpendicular to A–B. */
  function thermometerBisectorLine(q, lengthKm) {
    const a = turf.point([q.lngA, q.latA]);
    const b = turf.point([q.lngB, q.latB]);
    const mid = turf.midpoint(a, b);
    const perp = turf.bearing(a, b) + 90;
    const len = lengthKm || 80;
    const p1 = turf.destination(mid, len, perp, { units: 'kilometers' });
    const p2 = turf.destination(mid, len, perp + 180, { units: 'kilometers' });
    return turf.lineString([p1.geometry.coordinates, p2.geometry.coordinates]);
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
    thermometerRegion, thermometerBisectorLine, voronoiCellContaining, unionMany, safePoly,
  };
})();
