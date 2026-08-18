#!/usr/bin/env node
/**
 * Build static Citi Bike station GeoJSON with Mapbox map POI coordinates.
 *
 * Station names/IDs come from GBFS; lon/lat come from Mapbox Streets poi_label
 * (same layer that renders Citi Bike icons on Mapbox Standard maps).
 * Output is committed to data/citibike_stations.geojson — the web app loads
 * it directly with no runtime Mapbox lookups.
 *
 * Usage: MAPBOX_TOKEN=pk... node scripts/build-citibike-stations.js
 */
const fs = require('fs');
const path = require('path');

const GBFS_INFO = 'https://gbfs.citibikenyc.com/gbfs/en/station_information.json';
const GBFS_STATUS = 'https://gbfs.citibikenyc.com/gbfs/en/station_status.json';
const TILEQUERY = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery';
const OUT = path.join(__dirname, '../data/citibike_stations.geojson');
const TOKEN = process.env.MAPBOX_TOKEN || '';
const CONCURRENCY = 5;
const DELAY_MS = 50;
const QUERY_RADIUS_M = 200;
const QUERY_LIMIT = 50;
const RETRIES = 3;

function normalizeName(n) {
  return (n || '').toLowerCase()
    .replace(/citi\s*bike/g, '')
    .replace(/[–—:-]+/g, ' ')
    .replace(/\bstation\b/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

function mapboxPoiLabel(props) {
  return (props?.name || '').replace(/^citi\s*bike\s*[–—:-]+\s*/i, '').trim();
}

function isCitibikePoi(props) {
  if (!props) return false;
  if (props.brand === 'Citi Bike') return true;
  if (props.maki === 'bicycle' && /citi\s*bike/i.test(props.name || '')) return true;
  return /citi\s*bike/i.test(props.name || '');
}

function tokenOverlap(a, b) {
  const ta = new Set(normalizeName(a).split(' ').filter(Boolean));
  const tb = normalizeName(b).split(' ').filter(Boolean);
  if (!ta.size || !tb.length) return 0;
  return tb.filter(t => ta.has(t)).length;
}

function scorePoi(gbfsName, poiProps, distanceM) {
  const poiName = mapboxPoiLabel(poiProps);
  const gn = normalizeName(gbfsName);
  const pn = normalizeName(poiName);
  let score = tokenOverlap(gbfsName, poiName) * 20;
  if (gn === pn) score += 100;
  else if (gn.includes(pn) || pn.includes(gn)) score += 60;
  score -= distanceM * 0.08;
  return score;
}

function pickCitibikePoi(station, features) {
  const citibikes = (features || [])
    .filter(f => isCitibikePoi(f.properties))
    .map(f => ({
      feature: f,
      distanceM: f.properties?.tilequery?.distance ?? Infinity,
      score: scorePoi(station.name, f.properties, f.properties?.tilequery?.distance ?? Infinity),
    }))
    .filter(c => c.distanceM <= QUERY_RADIUS_M)
    .sort((a, b) => b.score - a.score);

  if (!citibikes.length) return null;
  if (citibikes[0].score >= 25) return citibikes[0];
  // One Citi Bike POI nearby — use it (GBFS names often differ, e.g. W 19 vs W 20).
  if (citibikes.length === 1 && citibikes[0].distanceM <= 120) return citibikes[0];
  // Nearest Citi Bike POI within ~1 block when name match is weak.
  const nearest = [...citibikes].sort((a, b) => a.distanceM - b.distanceM)[0];
  if (nearest.distanceM <= 95) return nearest;
  return null;
}

async function mapboxTilequery(station) {
  const url = `${TILEQUERY}/${station.lon},${station.lat}.json`
    + `?layers=poi_label&radius=${QUERY_RADIUS_M}&limit=${QUERY_LIMIT}`
    + `&access_token=${encodeURIComponent(TOKEN)}`;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const hit = pickCitibikePoi(station, data.features);
      if (!hit) return null;
      const [lng, lat] = hit.feature.geometry.coordinates;
      return {
        lng,
        lat,
        mapbox_name: hit.feature.properties?.name || station.name,
        distance_m: hit.distanceM,
        score: hit.score,
      };
    } catch (_) {
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

async function poolMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function loadGbfsStations() {
  const [infoRes, statusRes] = await Promise.all([
    fetch(GBFS_INFO),
    fetch(GBFS_STATUS),
  ]);
  if (!infoRes.ok) throw new Error(`GBFS info fetch failed: ${infoRes.status}`);
  if (!statusRes.ok) throw new Error(`GBFS status fetch failed: ${statusRes.status}`);

  const info = await infoRes.json();
  const status = await statusRes.json();
  const statusById = new Map((status.data?.stations || []).map(s => [s.station_id, s]));

  return (info.data?.stations || [])
    .map(s => ({
      station_id: s.station_id,
      name: s.name,
      lon: +s.lon,
      lat: +s.lat,
      region_id: s.region_id,
      is_installed: statusById.get(s.station_id)?.is_installed ?? 0,
    }))
    .filter(s => s.is_installed === 1);
}

async function main() {
  if (!TOKEN || TOKEN.includes('YOUR_')) {
    console.error('Set MAPBOX_TOKEN to build Mapbox-aligned station coordinates.');
    process.exit(1);
  }

  const stations = await loadGbfsStations();
  console.log(`GBFS installed stations: ${stations.length}`);
  console.log(`Querying Mapbox poi_label tileset (${CONCURRENCY} workers)…`);

  let done = 0;
  const mapboxHits = await poolMap(stations, async (station) => {
    const hit = await mapboxTilequery(station);
    done += 1;
    if (done % 200 === 0 || done === stations.length) {
      console.log(`  ${done}/${stations.length}`);
    }
    return hit;
  }, CONCURRENCY);

  let matched = 0;
  let fallback = 0;
  let features = stations.map((s, i) => {
    const hit = mapboxHits[i];
    const lng = hit ? hit.lng : s.lon;
    const lat = hit ? hit.lat : s.lat;
    if (hit) matched += 1;
    else fallback += 1;
    return {
      type: 'Feature',
      properties: {
        name: s.name,
        station_id: s.station_id,
        mode: 'CitiBike',
        region_id: s.region_id,
        coord_source: hit ? 'mapbox' : 'gbfs',
        mapbox_name: hit?.mapbox_name,
      },
      geometry: { type: 'Point', coordinates: [lng, lat] },
    };
  });

  if (fallback) {
    console.log(`Retrying ${fallback} unmatched stations…`);
    const retryIdx = features
      .map((f, i) => (f.properties.coord_source === 'gbfs' ? i : -1))
      .filter(i => i >= 0);
    let retryMatched = 0;
    for (const i of retryIdx) {
      const hit = await mapboxTilequery(stations[i]);
      if (!hit) continue;
      features[i].geometry.coordinates = [hit.lng, hit.lat];
      features[i].properties.coord_source = 'mapbox';
      features[i].properties.mapbox_name = hit.mapbox_name;
      matched += 1;
      fallback -= 1;
      retryMatched += 1;
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    console.log(`Retry matched: ${retryMatched}`);
  }

  features.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

  console.log(`Mapbox matched: ${matched}/${features.length}`);
  if (fallback) console.warn(`GBFS fallback (no Mapbox POI): ${fallback}`);

  const w19 = features.find(f => /W 19 St & 11 Ave/i.test(f.properties.name));
  if (w19) {
    console.log(`W 19 St & 11 Ave → [${w19.geometry.coordinates.join(', ')}]`);
    console.log(`  mapbox_name: ${w19.properties.mapbox_name}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`Wrote ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
