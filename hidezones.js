/** Hide zones: vector circles, type-in station search, single-station mode. */
(function () {
  const HIDE_MI = 0.375;
  const Geo = () => window.JetLagGeo;
  let mapRef = null;
  let mode = 'off';
  let station = null;
  let pickMode = false;
  let layersReady = false;
  let allStations = [];
  let circlesGeoJSON = null;

  function setHint(msg) {
    const el = document.getElementById('hide-hint');
    if (el) el.textContent = msg || '';
  }

  function stationZoneGeoJSON() {
    if (!station) return { type: 'FeatureCollection', features: [] };
    const circle = turf.circle([station.lng, station.lat], HIDE_MI, { steps: 96, units: 'miles' });
    circle.properties = { kind: 'hide-station' };
    return {
      type: 'FeatureCollection',
      features: [
        circle,
        turf.feature(turf.point([station.lng, station.lat]).geometry, {
          kind: 'hide-station-center', name: station.name,
        }),
      ],
    };
  }

  function syncVisibility() {
    if (!mapRef || !layersReady) return;
    const allVis = mode === 'all' ? 'visible' : 'none';
    const stVis = mode === 'station' ? 'visible' : 'none';
    ['hide-zones-all-fill', 'hide-zones-all-line'].forEach(id => {
      if (mapRef.getLayer(id)) mapRef.setLayoutProperty(id, 'visibility', allVis);
    });
    ['hide-station-fill', 'hide-station-line', 'hide-station-center'].forEach(id => {
      if (mapRef.getLayer(id)) mapRef.setLayoutProperty(id, 'visibility', stVis);
    });
    const info = document.getElementById('hide-station-info');
    if (info) {
      info.textContent = station
        ? `${station.name} · ${HIDE_MI} mi hide zone`
        : 'Type a station name or tap Pick station, then a dot on the map.';
    }
  }

  function setMode(next) {
    mode = next;
    const allCb = document.getElementById('toggle-zones-all');
    const stCb = document.getElementById('toggle-zones-station');
    if (allCb) allCb.checked = mode === 'all';
    if (stCb) stCb.checked = mode === 'station';
    syncVisibility();
    window.JetLagGame?.recomputeElimination?.();
  }

  function setStation(name, lng, lat) {
    station = { name, lng, lat };
    pickMode = false;
    setHint('');
    const inp = document.getElementById('hide-station-input');
    if (inp) inp.value = name;
    if (mapRef?.getSource('hide-station')) {
      mapRef.getSource('hide-station').setData(stationZoneGeoJSON());
    }
    setMode('station');
  }

  function clearStation() {
    station = null;
    pickMode = false;
    const inp = document.getElementById('hide-station-input');
    if (inp) inp.value = '';
    if (mapRef?.getSource('hide-station')) {
      mapRef.getSource('hide-station').setData({ type: 'FeatureCollection', features: [] });
    }
    setMode('off');
  }

  function startPick() {
    pickMode = true;
    setHint('Tap a station dot on the map.');
    setMode('station');
  }

  function onStationClick(props, lngLat) {
    if (!pickMode) return false;
    setStation(props.name || 'Station', lngLat.lng, lngLat.lat);
    return true;
  }

  function findStationByName(text) {
    const q = (text || '').trim().toLowerCase();
    if (!q) return null;
    const exact = allStations.find(s => s.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = allStations.filter(s => s.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    return partial.find(s => s.name.toLowerCase().startsWith(q)) || null;
  }

  function applyTypedStation() {
    const inp = document.getElementById('hide-station-input');
    const hit = findStationByName(inp?.value);
    if (!hit) {
      setHint('No matching station. Try a different name.');
      return;
    }
    setStation(hit.name, hit.lng, hit.lat);
    if (mapRef) {
      mapRef.flyTo({ center: [hit.lng, hit.lat], zoom: Math.max(mapRef.getZoom(), 13), duration: 800 });
    }
  }

  function populateDatalist() {
    const dl = document.getElementById('hide-station-list');
    if (!dl) return;
    dl.innerHTML = allStations.map(s =>
      `<option value="${s.name.replace(/"/g, '&quot;')}">${s.mode || ''}</option>`,
    ).join('');
  }

  async function install(map) {
    mapRef = map;
    layersReady = false;
    try {
      allStations = await (await fetch('data/all_stations.json')).json();
      populateDatalist();
    } catch (e) {
      console.warn('all_stations.json missing', e);
      allStations = [];
    }

    if (!map.getSource('hide-zones-all')) {
      try {
        const circles = await (await fetch('data/hide_zones_circles.geojson')).json();
        circlesGeoJSON = circles;
        map.addSource('hide-zones-all', { type: 'geojson', data: circles });
      } catch (e) {
        console.warn('hide_zones_circles.geojson missing', e);
        map.addSource('hide-zones-all', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      }
      map.addLayer({
        id: 'hide-zones-all-fill', type: 'fill', source: 'hide-zones-all',
        paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'hide-zones-all-line', type: 'line', source: 'hide-zones-all',
        paint: { 'line-color': '#ffb020', 'line-width': 1.2, 'line-opacity': 0.55 },
      });
    }

    if (!map.getSource('hide-station')) {
      map.addSource('hide-station', { type: 'geojson', data: stationZoneGeoJSON() });
      map.addLayer({
        id: 'hide-station-fill', type: 'fill', source: 'hide-station',
        filter: ['==', ['get', 'kind'], 'hide-station'],
        paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.35 },
      });
      map.addLayer({
        id: 'hide-station-line', type: 'line', source: 'hide-station',
        filter: ['==', ['get', 'kind'], 'hide-station'],
        paint: { 'line-color': '#ffb020', 'line-width': 2.5 },
      });
      map.addLayer({
        id: 'hide-station-center', type: 'circle', source: 'hide-station',
        filter: ['==', ['get', 'kind'], 'hide-station-center'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#ffb020',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
    }
    layersReady = true;
    if (circlesGeoJSON?.features?.length) setMode('all');
    else syncVisibility();
  }

  function getPlayableArea() {
    if (mode === 'station' && station) {
      return turf.circle([station.lng, station.lat], HIDE_MI, { steps: 96, units: 'miles' });
    }
    if (circlesGeoJSON?.features?.length) {
      return Geo().unionMany(circlesGeoJSON.features);
    }
    return null;
  }

  function bindUI() {
    document.getElementById('toggle-zones-all')?.addEventListener('change', e => {
      setMode(e.target.checked ? 'all' : (station ? 'station' : 'off'));
    });
    document.getElementById('toggle-zones-station')?.addEventListener('change', e => {
      if (e.target.checked) {
        if (station) setMode('station');
        else startPick();
      } else if (mode === 'station') {
        setMode('off');
      }
    });
    document.getElementById('hide-pick-station')?.addEventListener('click', startPick);
    document.getElementById('hide-clear-station')?.addEventListener('click', clearStation);
    document.getElementById('hide-station-apply')?.addEventListener('click', applyTypedStation);
    document.getElementById('hide-station-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') applyTypedStation();
    });
  }

  function isPicking() { return pickMode; }

  window.JetLagHideZones = {
    install, bindUI, onStationClick, setStation, clearStation, isPicking,
    getPlayableArea, get mode() { return mode; }, HIDE_MI, allStations: () => allStations,
  };
})();
