#!/usr/bin/env node
/**
 * Build Citi Bike playable + land-mask polygons.
 *
 * Playable (game_area.geojson): Manhattan, Bronx, Brooklyn, Queens, Hoboken,
 * and Jersey City — no Staten Island, no other NJ.
 *
 * Land mask (land_mask.geojson): all five NYC boroughs plus Hudson County NJ.
 * Gray overlay = land_mask minus the current possible area, so waterways stay
 * clear and Staten Island / the rest of NJ show as eliminated land.
 *
 * Usage: TURF_PATH=/path/to/@turf/turf node scripts/build-game-area.js
 */
const fs = require('fs');
const path = require('path');

const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const BOROUGHS = path.join(DATA, 'nyc_boroughs.geojson');
const OUT_AREA = path.join(DATA, 'game_area.geojson');
const OUT_LAND = path.join(DATA, 'land_mask.geojson');

const SIMPLIFY = 0.0002;
const UA = 'JetLagNYC-map/1.0 (citibike hide and seek)';

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

function unionAll(parts, label) {
  let area = null;
  for (const part of parts) {
    const name = part.properties.BoroName || part.properties.name || 'part';
    if (!area) { area = part; console.log(`  ${label}:`, name); continue; }
    const next = turf.union(turf.featureCollection([area, part]));
    if (!next) throw new Error(`union failed at ${name}`);
    area = next;
    console.log('  +', name);
  }
  return area;
}

(async () => {
  const boroughs = JSON.parse(fs.readFileSync(BOROUGHS, 'utf8'));
  const byName = {};
  for (const f of boroughs.features) byName[f.properties.BoroName] = f;

  console.log('Fetching NJ outlines…');
  const hoboken = await nominatim(
    'city=Hoboken&county=Hudson+County&state=New+Jersey&country=USA',
    'nj_hoboken.geojson',
  );
  const jerseyCity = await nominatim(
    'city=Jersey+City&county=Hudson+County&state=New+Jersey&country=USA',
    'nj_jersey_city.geojson',
  );
  const hudson = await nominatim(
    'county=Hudson+County&state=New+Jersey&country=USA',
    'nj_hudson.geojson',
  );
  const essex = await nominatim(
    'county=Essex+County&state=New+Jersey&country=USA',
    'nj_essex.geojson',
  );
  const bergen = await nominatim(
    'county=Bergen+County&state=New+Jersey&country=USA',
    'nj_bergen.geojson',
  );

  const playableParts = [
    byName.Manhattan, byName.Bronx, byName.Brooklyn, byName.Queens,
    hoboken, jerseyCity,
  ].filter(Boolean);

  console.log('\nUnion playable area…');
  const playable = turf.simplify(
    unionAll(playableParts, 'playable'),
    { tolerance: SIMPLIFY, highQuality: true },
  );
  playable.properties = { name: 'Citi Bike playable area' };

  const landParts = boroughs.features.concat(hudson, essex, bergen);
  console.log('\nUnion land mask…');
  const land = turf.simplify(
    unionAll(landParts, 'land'),
    { tolerance: SIMPLIFY, highQuality: true },
  );
  land.properties = { name: 'Citi Bike land mask' };

  fs.writeFileSync(OUT_AREA, JSON.stringify(turf.featureCollection([playable])));
  fs.writeFileSync(OUT_LAND, JSON.stringify(turf.featureCollection([land])));

  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'citibike_stations.geojson'), 'utf8'));
  let inside = 0;
  for (const f of st.features) {
    if (turf.booleanPointInPolygon(f.geometry.coordinates, playable)) inside++;
  }

  console.log(`\nwrote ${path.relative(process.cwd(), OUT_AREA)}`);
  console.log('  playable', (turf.area(playable) / 2589988).toFixed(1), 'sq mi',
    '| stations inside', inside, '/', st.features.length);
  console.log('wrote', path.relative(process.cwd(), OUT_LAND));
  console.log('  land mask', (turf.area(land) / 2589988).toFixed(1), 'sq mi');
})().catch(e => { console.error(e.message); process.exit(1); });
