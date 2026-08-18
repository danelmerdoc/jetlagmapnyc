#!/usr/bin/env node
/**
 * Build the playable game area: the five boroughs plus the New Jersey side that
 * has Citi Bike docks (Hudson County — Jersey City, Hoboken, Bayonne, and the
 * towns above them).
 *
 * The union of detailed municipal outlines takes several seconds, so it is done
 * here and committed to data/game_area.geojson. The web app loads the result and
 * grays out everything outside it.
 *
 * Borough outlines come from data/nyc_boroughs.geojson; the New Jersey boundary
 * comes from OpenStreetMap via Nominatim, cached in data/nj_hudson.geojson.
 *
 * Usage: TURF_PATH=/path/to/@turf/turf node scripts/build-game-area.js
 */
const fs = require('fs');
const path = require('path');

const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const BOROUGHS = path.join(DATA, 'nyc_boroughs.geojson');
const NJ_CACHE = path.join(DATA, 'nj_hudson.geojson');
const OUT = path.join(DATA, 'game_area.geojson');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
  + '?county=Hudson%20County&state=New%20Jersey&country=USA'
  + '&format=json&polygon_geojson=1&limit=1';

/** ~20 m. Fine enough that shorelines still read as shorelines when zoomed in. */
const SIMPLIFY_TOLERANCE = 0.0002;

async function loadNewJersey() {
  if (fs.existsSync(NJ_CACHE)) {
    return JSON.parse(fs.readFileSync(NJ_CACHE, 'utf8'));
  }
  const res = await fetch(NOMINATIM, {
    headers: { 'User-Agent': 'JetLagNYC-map/1.0 (citibike hide and seek)' },
  });
  const hits = await res.json();
  if (!hits.length || !hits[0].geojson) throw new Error('Nominatim returned no polygon');
  const f = turf.feature(hits[0].geojson, { name: 'Hudson County', source: 'OpenStreetMap' });
  const fc = turf.featureCollection([f]);
  fs.writeFileSync(NJ_CACHE, JSON.stringify(fc));
  console.log('cached', path.relative(process.cwd(), NJ_CACHE));
  return fc;
}

(async () => {
  const boroughs = JSON.parse(fs.readFileSync(BOROUGHS, 'utf8'));
  const nj = await loadNewJersey();

  const parts = boroughs.features.concat(nj.features);
  console.log('unioning', parts.length, 'outlines…');

  let area = null;
  for (const part of parts) {
    const name = part.properties.BoroName || part.properties.name || 'part';
    if (!area) { area = part; continue; }
    const next = turf.union(turf.featureCollection([area, part]));
    if (!next) throw new Error(`union failed at ${name}`);
    area = next;
    console.log('  +', name);
  }

  const simple = turf.simplify(area, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true });
  simple.properties = { name: 'Citi Bike game area' };

  fs.writeFileSync(OUT, JSON.stringify(turf.featureCollection([simple])));

  const sqMi = turf.area(simple) / 2589988;
  console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  geometry   ${simple.geometry.type}, ${simple.geometry.coordinates.length} part(s)`);
  console.log(`  area       ${sqMi.toFixed(1)} sq mi`);
  console.log(`  bbox       ${turf.bbox(simple).map(v => v.toFixed(4)).join(', ')}`);
  console.log(`  file size  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
})().catch(e => { console.error(e.message); process.exit(1); });
