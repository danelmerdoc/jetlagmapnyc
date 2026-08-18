#!/usr/bin/env node
/**
 * Precompute Citi Bike map overlays (run once at build / when boundaries change).
 *
 * Outputs:
 *   playable.geojson        — single polygon (display + grey cut-out)
 *   grey.geojson            — metro frame minus playable (static overlay)
 *   playable_border.geojson — LineString outline
 *   game_area.geojson       — detailed land union (station logic only)
 *
 * Playable shell: union of borough/city land borders, merged where they touch.
 * Water crossings are simplified to straight segments across NYC Harbor (south)
 * and the upper Hudson River (north) only — no line down the Hudson interior.
 */
const fs = require('fs');
const path = require('path');
const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const UA = 'JetLagNYC-map/1.0 (citibike hide and seek)';

/** Metro frame — big enough to pan, small enough for Mapbox fill on mobile. */
const FRAME = [-75.8, 39.6, -71.4, 42.2];

/** Buffer used only to connect disconnected land parts before tracing the outer ring. */
const CONNECT_BUFFER_MI = 0.2;
const SIMPLIFY_TOLERANCE = 0.0008;

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

/** Water zones where the outer ring is replaced by straight chords. */
function inHarbor(lng, lat) {
  // The Narrows / Lower Bay west of Bay Ridge — keep Sea Gate, Coney Island, Rockaways.
  return lat < 40.68 && lat > 40.60 && lng > -74.12 && lng < -74.05;
}

function inUpperHudson(lng, lat) {
  return lat > 40.82 && lng > -74.15 && lng < -73.88;
}

function isWaterVertex(lng, lat, landUnion) {
  if (!inHarbor(lng, lat) && !inUpperHudson(lng, lat)) return false;
  return !turf.booleanPointInPolygon([lng, lat], landUnion);
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first.slice());
  return ring;
}

/** Collapse consecutive water vertices into single harbor / upper-Hudson chords. */
function collapseWaterRuns(ring, landUnion) {
  const out = [];
  const n = ring.length - 1;
  let i = 0;
  while (i < n) {
    const p = ring[i];
    if (!isWaterVertex(p[0], p[1], landUnion)) {
      out.push(p.slice());
      i++;
      continue;
    }
    const start = i;
    while (i < n && isWaterVertex(ring[i][0], ring[i][1], landUnion)) i++;
    const end = i - 1;
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== ring[start][0] || prev[1] !== ring[start][1]) {
      out.push(ring[start].slice());
    }
    if (end > start) out.push(ring[end].slice());
  }
  return closeRing(out);
}

/**
 * Trace the outer boundary of merged borough/city land, then simplify harbor
 * and upper-Hudson crossings to straight segments.
 */
function buildPlayableShell(landUnion) {
  const connected = turf.buffer(landUnion, CONNECT_BUFFER_MI, { units: 'miles', steps: 16 });
  if (connected.geometry.type !== 'Polygon') {
    throw new Error(`land union buffer did not yield a single polygon (${connected.geometry.type})`);
  }
  let ring = connected.geometry.coordinates[0];
  ring = turf.simplify(turf.polygon([ring]), {
    tolerance: SIMPLIFY_TOLERANCE,
    highQuality: true,
  }).geometry.coordinates[0];
  ring = collapseWaterRuns(ring, landUnion);
  return ring;
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

  console.log('\nBuild playable shell from land borders…');
  const shellRing = buildPlayableShell(gameArea);
  const playable = turf.polygon([shellRing], { name: 'playable' });
  const frame = turf.bboxPolygon(FRAME);
  const grey = turf.mask(playable, frame);
  grey.properties = { name: 'grey' };
  const border = turf.lineString(shellRing, { name: 'playable-border' });

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
    ['Sea Gate', -74.007, 40.577, false],
    ['Coney Island', -73.981, 40.575, false],
    ['Rockaway Beach', -73.822, 40.585, false],
    ['Breezy Point', -73.926, 40.556, false],
  ];

  console.log('\nplayable shell', shellRing.length, 'pts',
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
