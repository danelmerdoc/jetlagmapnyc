#!/usr/bin/env node
/**
 * Build Citi Bike playable polygons and the grey overlay.
 *
 * playable.geojson  — ONE polygon: Manhattan, Bronx, Brooklyn, Queens,
 *                     Hoboken, Jersey City, plus a Hudson strip so NY/NJ
 *                     are a single region. Outer ring only.
 * grey.geojson      — metro rectangle minus that polygon (precomputed).
 * game_area.geojson — same union, used to filter stations.
 *
 * Usage: node scripts/build-game-area.js
 */
const fs = require('fs');
const path = require('path');
const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const UA = 'JetLagNYC-map/1.0 (citibike hide and seek)';

/** Tight metro frame — large enough to cover panning, small enough for Mapbox fill. */
const FRAME = [-75.8, 39.6, -71.4, 42.2];

function unionAll(parts, label) {
  let area = null;
  for (const part of parts) {
    const name = part.properties?.BoroName || part.properties?.name || 'part';
    if (!area) { area = part; console.log(`  ${label}:`, name); continue; }
    const next = turf.union(turf.featureCollection([area, part]));
    if (!next) throw new Error(`union failed at ${name}`);
    area = next;
    console.log('  +', name);
  }
  return area;
}

function outerPolygon(feature) {
  const g = feature.geometry;
  let ring;
  if (g.type === 'Polygon') {
    ring = g.coordinates[0];
  } else {
    let best = g.coordinates[0][0];
    let bestA = -1;
    for (const poly of g.coordinates) {
      let a = 0;
      try { a = turf.area(turf.polygon([poly[0]])); } catch (_) { a = 0; }
      if (a > bestA) { bestA = a; best = poly[0]; }
    }
    ring = best;
  }
  return turf.polygon([ring]);
}

function hudsonStrip(manhattan, nj) {
  const mb = turf.bbox(manhattan);
  const jb = turf.bbox(nj);
  return turf.bboxPolygon([
    jb[2] - 0.035,
    Math.max(jb[1], 40.69),
    mb[0] + 0.07,
    jb[3],
  ], { name: 'Hudson strip' });
}

async function nominatim(query, cacheFile) {
  const cachePath = path.join(DATA, cacheFile);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')).features[0];
  }
  const url = 'https://nominatim.openstreetmap.org/search'
    + `?${query}&format=json&polygon_geojson=1&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const hits = await res.json();
  if (!hits.length || !hits[0].geojson) throw new Error(`Nominatim miss: ${query}`);
  const f = turf.feature(hits[0].geojson, { name: hits[0].display_name.split(',')[0] });
  fs.writeFileSync(cachePath, JSON.stringify(turf.featureCollection([f])));
  console.log('  cached', cacheFile);
  return f;
}

(async () => {
  const boroughs = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc_boroughs.geojson'), 'utf8'));
  const byName = {};
  for (const f of boroughs.features) byName[f.properties.BoroName] = f;

  console.log('NJ outlines…');
  const hoboken = await nominatim(
    'city=Hoboken&county=Hudson+County&state=New+Jersey&country=USA',
    'nj_hoboken.geojson',
  );
  const jerseyCity = await nominatim(
    'city=Jersey+City&county=Hudson+County&state=New+Jersey&country=USA',
    'nj_jersey_city.geojson',
  );

  const nj = turf.union(turf.featureCollection([hoboken, jerseyCity]));
  nj.properties = { name: 'Hoboken + Jersey City' };

  const parts = [
    byName.Manhattan, byName.Bronx, byName.Brooklyn, byName.Queens,
    hoboken, jerseyCity, hudsonStrip(byName.Manhattan, nj),
  ];

  console.log('\nUnion playable…');
  const merged = unionAll(parts, 'playable');

  console.log('\nOne display polygon (concave hull)…');
  const sample = [];
  const rings = merged.geometry.type === 'MultiPolygon'
    ? merged.geometry.coordinates.map(p => p[0])
    : [merged.geometry.coordinates[0]];
  for (const ring of rings) {
    const step = Math.max(1, Math.floor(ring.length / 80));
    for (let i = 0; i < ring.length; i += step) sample.push(turf.point(ring[i]));
  }
  let playable = turf.concave(turf.featureCollection(sample), {
    maxEdge: 12,
    units: 'kilometers',
  });
  playable = outerPolygon(playable);
  playable.properties = { name: 'playable' };

  const frame = turf.bboxPolygon(FRAME);
  const grey = turf.mask(playable, frame);
  grey.properties = { name: 'grey' };

  const border = turf.lineString(playable.geometry.coordinates[0]);
  border.properties = { name: 'playable-border' };

  const area = turf.simplify(outerPolygon(merged), { tolerance: 0.0002, highQuality: true });
  area.properties = { name: 'Citi Bike playable area' };

  fs.writeFileSync(path.join(DATA, 'playable.geojson'), JSON.stringify(turf.featureCollection([playable])));
  fs.writeFileSync(path.join(DATA, 'grey.geojson'), JSON.stringify(turf.featureCollection([grey])));
  fs.writeFileSync(path.join(DATA, 'playable_border.geojson'), JSON.stringify(turf.featureCollection([border])));
  fs.writeFileSync(path.join(DATA, 'game_area.geojson'), JSON.stringify(turf.featureCollection([area])));

  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'citibike_stations.geojson'), 'utf8'));
  let inside = 0;
  for (const f of st.features) {
    if (turf.booleanPointInPolygon(f.geometry.coordinates, playable)) inside++;
  }

  const checks = [
    ['Manhattan', -73.98, 40.75, false],
    ['Hoboken', -74.032, 40.745, false],
    ['Hudson', -74.02, 40.74, false],
    ['Elmont', -73.703, 40.701, true],
    ['Mount Vernon', -73.837, 40.912, true],
    ['Staten Island', -74.15, 40.58, true],
    ['Newark', -74.172, 40.736, true],
  ];
  console.log('\nplayable', (turf.area(playable) / 2589988).toFixed(1), 'sq mi',
    '| stations', inside, '/', st.features.length,
    '| rings', playable.geometry.coordinates.length,
    '| pts', playable.geometry.coordinates[0].length);
  console.log('grey rings', grey.geometry.coordinates.length);
  for (const [name, lng, lat, wantGrey] of checks) {
    const g = turf.booleanPointInPolygon([lng, lat], grey);
    const p = turf.booleanPointInPolygon([lng, lat], playable);
    const ok = g === wantGrey && p === !wantGrey;
    console.log(ok ? '  ok ' : '  FAIL ', name, 'grey=' + g, 'playable=' + p);
  }
})().catch(e => { console.error(e); process.exit(1); });
