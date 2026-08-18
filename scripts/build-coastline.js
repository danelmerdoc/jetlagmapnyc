#!/usr/bin/env node
/**
 * Build data/coastline.geojson for measuring questions.
 *
 * Shorelines of Hudson River, East River, New York Bay, and Newark Bay — from
 * OSM natural=coastline / waterway=riverbank, merged with the high-detail NYC
 * source (coastline_src.geojson) while dropping coarse Hudson chords and adding
 * real NJ Hudson waterfront geometry.
 */
const fs = require('fs');
const path = require('path');
const turf = require(process.env.TURF_PATH || '@turf/turf');

const DATA = path.join(__dirname, '../data');
const SRC = path.join(DATA, 'coastline_src.geojson');
const OUT = path.join(DATA, 'coastline.geojson');
const OSM_CACHE = path.join(DATA, '.osm_coast_cache');
const UA = 'JetLagNYC-map/1.0 (citibike hide and seek)';

/** Pre-simplify at build — suitable for distance queries and coastBand overlay. */
const BUILD_SIMPLIFY = 0.00025;

/** OSM supplement bbox — NJ Hudson waterfront only (NYC shores stay in coastline_src). */
const OSM_CHUNKS = [
  [40.68, -74.10, 40.78, -73.98],
];

/** Newton Creek / Newtown Creek between Greenpoint and Long Island City. */
function inNewtonCreek(lng, lat) {
  return lat >= 40.728 && lat <= 40.778 && lng >= -73.965 && lng <= -73.912;
}

/** Harlem River links Hudson to East River north of ~40.805. */
function inHarlemRiver(lng, lat) {
  return lat >= 40.803 && lat <= 40.895 && lng >= -73.948 && lng <= -73.905;
}

function inJamaicaBay(lng, lat) {
  return lat >= 40.558 && lat <= 40.648 && lng >= -73.89 && lng <= -73.78;
}

function inAtlanticRockaway(lng, lat) {
  if (lat < 40.558) return true;
  if (lat < 40.625 && lng > -73.82) return true;
  if (lat < 40.585 && lng < -74.05) return true;
  return false;
}

function inGowanus(lng, lat) {
  return lat >= 40.660 && lat <= 40.690 && lng >= -74.01 && lng <= -73.985;
}

function inHudson(lng, lat) {
  if (lat < 40.675 || lat > 40.895) return false;
  if (lng >= -74.025 && lng <= -73.918) return true;
  if (lng >= -74.18 && lng <= -74.008) return true;
  return false;
}

function inEastRiver(lng, lat) {
  if (lat < 40.692 || lat > 40.803) return false;
  return lng >= -73.975 && lng <= -73.898;
}

function inNYBay(lng, lat) {
  if (lat < 40.558 || lat > 40.675) return false;
  if (lng < -74.12 || lng > -73.82) return false;
  if (inJamaicaBay(lng, lat)) return false;
  return true;
}

function inNewarkBay(lng, lat) {
  return lat >= 40.618 && lat <= 40.718 && lng >= -74.24 && lng <= -74.04;
}

function isExcluded(lng, lat) {
  return inNewtonCreek(lng, lat)
    || inHarlemRiver(lng, lat)
    || inJamaicaBay(lng, lat)
    || inAtlanticRockaway(lng, lat)
    || inGowanus(lng, lat);
}

function isAllowed(lng, lat) {
  if (isExcluded(lng, lat)) return false;
  return inHudson(lng, lat) || inEastRiver(lng, lat) || inNYBay(lng, lat) || inNewarkBay(lng, lat);
}

function segmentAllowed(a, b) {
  if (isExcluded(a[0], a[1]) && isExcluded(b[0], b[1])) return false;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return isAllowed(mid[0], mid[1]);
}

/** Coarse chord across Hudson interior (not real waterfront). */
function isFakeHudsonDiagonal(line) {
  if (line.length < 50) return false;
  let maxGap = 0;
  for (let i = 0; i < line.length - 1; i++) {
    maxGap = Math.max(maxGap, turf.distance(line[i], line[i + 1], { units: 'miles' }));
  }
  if (maxGap < 0.12) return false;
  const lngs = line.map(p => p[0]);
  const lats = line.map(p => p[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  return minLng < -74.02 && maxLng > -74.13 && minLat >= 40.64 && maxLat <= 40.88 && maxLng - minLng < 0.2;
}

/** Keep contiguous runs of allowed segments from each input line. */
function filterLine(coords) {
  const runs = [];
  let run = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (segmentAllowed(a, b)) {
      if (!run.length) run.push(a.slice());
      run.push(b.slice());
    } else if (run.length >= 2) {
      runs.push(run);
      run = [];
    } else {
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function simplifyLine(coords) {
  if (coords.length < 3) return coords;
  try {
    return turf.simplify(turf.lineString(coords), {
      tolerance: BUILD_SIMPLIFY,
      highQuality: true,
    }).geometry.coordinates;
  } catch (_) {
    return coords;
  }
}

function loadSourceLines() {
  const pathUsed = fs.existsSync(SRC) ? SRC : OUT;
  const fc = JSON.parse(fs.readFileSync(pathUsed, 'utf8'));
  const geom = fc.features[0].geometry;
  if (geom.type === 'MultiLineString') return geom.coordinates;
  if (geom.type === 'LineString') return [geom.coordinates];
  throw new Error(`unexpected geometry ${geom.type}`);
}

function chunkCachePath(chunk) {
  const [s, w, n, e] = chunk;
  return path.join(OSM_CACHE, `coast_${s}_${w}_${n}_${e}.json`);
}

async function fetchOverpass(chunk) {
  const [s, w, n, e] = chunk;
  const ql = `[out:json][timeout:90];
(
  way["natural"="coastline"](${s},${w},${n},${e});
  way["waterway"="riverbank"](${s},${w},${n},${e});
  relation["type"="waterway"]["waterway"="riverbank"](${s},${w},${n},${e});
);
out geom;`;
  for (const base of [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ]) {
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
      });
      const text = await res.text();
      if (!res.ok || text.startsWith('<?xml') || text.startsWith('<')) throw new Error(text.slice(0, 120));
      return JSON.parse(text);
    } catch (err) {
      console.warn('  overpass', base.split('/')[2], err.message?.slice(0, 60) || err);
    }
  }
  return null;
}

function osmElementsToLines(data) {
  const lines = [];
  for (const el of data.elements || []) {
    if (el.type === 'way' && el.geometry?.length >= 2) {
      lines.push(el.geometry.map(p => [p.lon, p.lat]));
    } else if (el.type === 'relation') {
      for (const m of el.members || []) {
        if (m.role === 'outer' && m.geometry?.length >= 2) {
          lines.push(m.geometry.map(p => [p.lon, p.lat]));
        }
      }
    }
  }
  return lines;
}

async function loadOsmLines() {
  fs.mkdirSync(OSM_CACHE, { recursive: true });

  // Legacy cache from manual fetch
  const legacyNj = path.join(DATA, '.osm_nj_hudson.json');
  const legacyTarget = chunkCachePath([40.68, -74.10, 40.78, -73.98]);
  if (fs.existsSync(legacyNj) && !fs.existsSync(legacyTarget)) {
    fs.copyFileSync(legacyNj, legacyTarget);
  }

  const lines = [];
  for (const chunk of OSM_CHUNKS) {
    const cachePath = chunkCachePath(chunk);
    let data = null;
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1000) {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } else {
      console.log('  fetch OSM chunk', chunk.join(','));
      data = await fetchOverpass(chunk);
      if (data) fs.writeFileSync(cachePath, JSON.stringify(data));
    }
    if (data?.elements?.length) {
      const chunkLines = osmElementsToLines(data);
      lines.push(...chunkLines);
      console.log('  chunk', chunk.join(','), '→', chunkLines.length, 'ways');
    }
  }
  return lines.map(simplifyLine);
}

function buildFromLines(inputLines) {
  const outLines = [];
  for (const line of inputLines) {
    for (const run of filterLine(line)) {
      if (run.length >= 2) outLines.push(simplifyLine(run));
    }
  }
  return turf.multiLineString(outLines, {
    name: 'NYC/NJ coast (Hudson, East River, NY Bay, Newark Bay)',
  });
}

async function build() {
  if (!fs.existsSync(SRC) && fs.existsSync(OUT)) {
    fs.copyFileSync(OUT, SRC);
    console.log('Initialized coastline_src.geojson from existing coastline.geojson');
  }

  const sourceLines = loadSourceLines().filter(l => !isFakeHudsonDiagonal(l));
  const removed = loadSourceLines().length - sourceLines.length;
  if (removed) console.log('  dropped', removed, 'fake Hudson diagonal(s) from source');

  const osmLines = await loadOsmLines();
  console.log('  OSM input', osmLines.length, 'lines');

  const combined = [...sourceLines, ...osmLines];
  let feature = buildFromLines(combined);

  const lines = feature.geometry.coordinates;
  const pts = lines.reduce((s, l) => s + l.length, 0);
  fs.writeFileSync(OUT, JSON.stringify(turf.featureCollection([feature])));
  console.log('coastline.geojson:', lines.length, 'lines,', pts, 'points');
  return feature;
}

function distCoast(rings, lng, lat) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const d = turf.pointToLineDistance(
        [lng, lat],
        turf.lineString([ring[i - 1], ring[i]]),
        { units: 'miles' },
      );
      if (d < best) best = d;
    }
  }
  return best;
}

function verify(feature) {
  const st = JSON.parse(fs.readFileSync(path.join(DATA, 'citibike_stations.geojson'), 'utf8'));
  const g = feature.geometry;
  const rings = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];

  const samples = [
    '12 St & Sinatra Dr N',
    'South Waterfront Walkway - Sinatra Dr & 1 St',
    'River St & 1 St',
    'Hoboken Terminal - Hudson St & Hudson Pl',
    'Newport Pkwy',
    'Grove St PATH',
    'Little West St & 1 Pl',
    'Murray St & West St',
    'Greenpoint Ave & West St',
    'Pier 40 - Hudson River Park',
  ];
  console.log('\nSample coast distances (mi):');
  for (const name of samples) {
    const f = st.features.find(x => x.properties.name === name);
    if (!f) {
      console.log(' ', name, '(station not found)');
      continue;
    }
    const [lng, lat] = f.geometry.coordinates;
    console.log(' ', name, distCoast(rings, lng, lat).toFixed(3));
  }
}

if (require.main === module) {
  build().then(f => verify(f)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { build, isAllowed, inNewtonCreek };
