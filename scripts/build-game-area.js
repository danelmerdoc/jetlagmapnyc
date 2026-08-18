#!/usr/bin/env node
/**
 * Precompute Citi Bike map overlays (run once at build / when boundaries change).
 *
 * Outputs:
 *   playable.geojson        — single polygon (display + grey cut-out)
 *   grey.geojson            — metro frame minus playable (static overlay)
 *   playable_border.geojson — LineString outline
 *   game_area.geojson       — detailed land union (station logic only)
 */
const fs = require('fs');
const path = require('path');
const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const UA = 'JetLagNYC-map/1.0 (citibike hide and seek)';

/** Metro frame — big enough to pan, small enough for Mapbox fill on mobile. */
const FRAME = [-75.8, 39.6, -71.4, 42.2];

/**
 * Hand-tuned outer shell matching the Jet Lag reference map:
 * 4 boroughs + Hoboken/Jersey City, Hudson interior (no NY/NJ line),
 * Rockaways in, Staten Island / Elmont / Mount Vernon / Newark out.
 */
const PLAYABLE_SHELL = [
  [-74.018, 40.892],
  [-74.042, 40.878],
  [-74.058, 40.835],
  [-74.118, 40.768],
  [-74.105, 40.698],
  [-74.042, 40.578],
  [-73.795, 40.542],
  [-73.715, 40.605],
  [-73.725, 40.695],
  [-73.735, 40.775],
  [-73.755, 40.855],
  [-73.782, 40.898],
  [-73.833, 40.906],
  [-73.908, 40.914],
  [-74.018, 40.892],
];

function unionAll(parts, label) {
  let area = null;
  for (const part of parts) {
    const name = part.properties?.BoroName || part.properties?.name || 'part';
    if (!area) { area = part; console.log(`  ${label}:`, name); continue; }
    area = turf.union(turf.featureCollection([area, part]));
    if (!area) throw new Error(`union failed at ${name}`);
    console.log('  +', name);
  }
  return area;
}

function hudsonStrip(manhattan, nj) {
  const mb = turf.bbox(manhattan);
  const jb = turf.bbox(nj);
  return turf.bboxPolygon([
    jb[2] - 0.035,
    Math.max(jb[1], 40.69),
    mb[0] + 0.07,
    jb[3],
  ]);
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
  const landParts = [
    byName.Manhattan, byName.Bronx, byName.Brooklyn, byName.Queens,
    hoboken, jerseyCity, hudsonStrip(byName.Manhattan, nj),
  ];

  console.log('\nUnion game_area (station logic)…');
  const gameArea = turf.simplify(unionAll(landParts, 'game_area'), {
    tolerance: 0.0002,
    highQuality: true,
  });
  gameArea.properties = { name: 'Citi Bike playable area' };

  const playable = turf.polygon([PLAYABLE_SHELL], { name: 'playable' });
  const frame = turf.bboxPolygon(FRAME);
  const grey = turf.mask(playable, frame);
  grey.properties = { name: 'grey' };
  const border = turf.lineString(PLAYABLE_SHELL, { name: 'playable-border' });

  fs.writeFileSync(path.join(DATA, 'playable.geojson'), JSON.stringify(turf.featureCollection([playable])));
  fs.writeFileSync(path.join(DATA, 'grey.geojson'), JSON.stringify(turf.featureCollection([grey])));
  fs.writeFileSync(path.join(DATA, 'playable_border.geojson'), JSON.stringify(turf.featureCollection([border])));
  fs.writeFileSync(path.join(DATA, 'game_area.geojson'), JSON.stringify(turf.featureCollection([gameArea])));

  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'citibike_stations.geojson'), 'utf8'));
  let inShell = 0;
  let inArea = 0;
  for (const f of st.features) {
    const c = f.geometry.coordinates;
    if (turf.booleanPointInPolygon(c, playable)) inShell++;
    if (turf.booleanPointInPolygon(c, gameArea)) inArea++;
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

  console.log('\nplayable shell', PLAYABLE_SHELL.length, 'pts',
    '| stations in shell', inShell, '/', st.features.length);
  console.log('game_area stations', inArea, '/', st.features.length);
  console.log('grey rings', grey.geometry.coordinates.length);
  for (const [name, lng, lat, wantGrey] of checks) {
    const g = turf.booleanPointInPolygon([lng, lat], grey);
    const p = turf.booleanPointInPolygon([lng, lat], playable);
    const ok = g === wantGrey && p === !wantGrey;
    console.log(ok ? '  ok ' : '  FAIL ', name);
  }
})().catch(e => { console.error(e); process.exit(1); });
