/** Citi Bike hide-and-seek map — Mapbox, focus mode, live location, draggable pins. */
(function () {
  const Game = () => window.JetLagCitibikeGame;
  const Geo = () => window.JetLagGeo;
  const TF_KEY = (window.THUNDERFOREST_KEY && window.THUNDERFOREST_KEY.indexOf('YOUR_') !== 0)
    ? window.THUNDERFOREST_KEY
    : 'f0288cb73dd840f5a6aca1cce00d7357';

  let map = null;
  let theme = 'light';
  let zoneMode = 'overlap';
  let showTransit = false;
  let focusStation = null;
  let clickBound = false;
  let layersReady = false;
  let mergeTimer = null;
  let markers = [];
  let liveWatchId = null;
  let liveMarker = null;
  let liveLngLat = null;
  let lastTap = { t: 0, lng: 0, lat: 0 };

  const STYLE = 'mapbox://styles/mapbox/standard';
  /** Mapbox simplifies GeoJSON by default (~0.375px), which shrinks thousands of hide circles. */
  const ZONE_GEOJSON_OPTS = { tolerance: 0 };
  const STATION_DOT_RADIUS = ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5, 14, 4];
  const STATION_DOT_STROKE = 0.9;

  function elimStyle() {
    if (theme === 'dark') {
      return { fill: '#c09a50', fillOpacity: 0.38, border: '#d4af37', borderWidth: 2.6 };
    }
    return { fill: '#3b82f6', fillOpacity: 0.32, border: '#2563eb', borderWidth: 2.4 };
  }

  function zoneStyle() {
    if (theme === 'dark') {
      return {
        fill: '#22d3ee',
        fillOpacity: 0.36,
        stroke: '#67e8f9',
        strokeOpacity: 0.92,
        strokeWidth: 2.6,
        focusStroke: '#a5f3fc',
        focusFillOpacity: 0.44,
        haloFill: '#06b6d4',
        haloOpacity: 0.18,
        emissive: 0.45,
      };
    }
    return {
      fill: '#22d3ee',
      fillOpacity: 0.2,
      stroke: '#0891b2',
      strokeOpacity: 0.85,
      strokeWidth: 2,
      focusStroke: '#06b6d4',
      focusFillOpacity: 0.26,
      haloFill: '#22d3ee',
      haloOpacity: 0,
      emissive: 0,
    };
  }

  function applyZonePaint(zones) {
    if (!map) return;
    const set = (id, prop, val) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, val); };
    const mergedOpacity = zones.fillOpacity + (theme === 'dark' ? 0.12 : 0.06);
    set('cb-zones-overlap-fill', 'fill-color', zones.fill);
    set('cb-zones-overlap-fill', 'fill-opacity', zones.fillOpacity);
    set('cb-zones-overlap-fill', 'fill-emissive-strength', zones.emissive);
    set('cb-zones-overlap-line', 'line-color', zones.stroke);
    set('cb-zones-overlap-line', 'line-opacity', zones.strokeOpacity);
    set('cb-zones-overlap-line', 'line-width', zones.strokeWidth);
    set('cb-merged-fill', 'fill-color', zones.fill);
    set('cb-merged-fill', 'fill-opacity', mergedOpacity);
    set('cb-merged-fill', 'fill-emissive-strength', zones.emissive);
    set('cb-merged-line', 'line-color', zones.stroke);
    set('cb-merged-line', 'line-opacity', zones.strokeOpacity);
    set('cb-merged-line', 'line-width', zones.strokeWidth);
    set('cb-focus-fill', 'fill-color', zones.fill);
    set('cb-focus-fill', 'fill-opacity', zones.focusFillOpacity);
    set('cb-focus-fill', 'fill-emissive-strength', zones.emissive);
    set('cb-focus-line', 'line-color', zones.focusStroke);
    set('cb-focus-line', 'line-width', theme === 'dark' ? 4 : 3.2);
  }

  function applyBasemap() {
    if (!map) return;
    try {
      map.setConfigProperty('basemap', 'lightPreset', theme === 'dark' ? 'night' : 'day');
      map.setConfigProperty('basemap', 'show3dObjects', false);
      map.setConfigProperty('basemap', 'show3dBuildings', false);
      map.setConfigProperty('basemap', 'show3dLandmarks', false);
      map.setConfigProperty('basemap', 'show3dTrees', false);
      map.setConfigProperty('basemap', 'show3dFacades', false);
    } catch (_) { /* classic styles */ }
    if (map.getPitch() !== 0) map.setPitch(0);
  }

  function setStatus(text) {
    const el = document.getElementById('cb-status');
    if (el) el.textContent = text;
  }

  function stationFeaturesGeoJSON() {
    if (focusStation) return { type: 'FeatureCollection', features: [] };
    const total = Game().stations.length;
    if (!total) return { type: 'FeatureCollection', features: [] };
    const active = Game().getActiveStations();
    setStatus(`${active.length} / ${total} stations possible`);
    return {
      type: 'FeatureCollection',
      features: Game().activeStationFeatures(active),
    };
  }

  function overlapZonesGeoJSON() {
    if (focusStation) return { type: 'FeatureCollection', features: [] };
    return Game().overlapZonesGeoJSON(Game().getActiveStations());
  }

  function focusGeoJSON() {
    if (!focusStation) return { type: 'FeatureCollection', features: [] };
    const circle = Game().stationCircle(focusStation);
    circle.properties = { kind: 'focus-zone' };
    return { type: 'FeatureCollection', features: [circle] };
  }

  function focusOutsideMask() {
    if (!focusStation) return { type: 'FeatureCollection', features: [] };
    return Geo().holedMask(Game().stationCircle(focusStation));
  }

  function updateMergedZones() {
    if (!map?.getSource('cb-merged')) return;
    if (zoneMode !== 'merged' || focusStation) {
      map.getSource('cb-merged').setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const active = Game().getActiveStations();
    const b = map.getBounds();
    const bbox = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
    const data = Game().mergedZonesGeoJSON(active, bbox);
    map.getSource('cb-merged').setData(data);
    setStatus(`${active.length} / ${Game().stations.length} stations possible`);
  }

  function scheduleMergedUpdate() {
    clearTimeout(mergeTimer);
    if (zoneMode !== 'merged' || focusStation) {
      if (map?.getSource('cb-merged')) {
        map.getSource('cb-merged').setData({ type: 'FeatureCollection', features: [] });
      }
      return;
    }
    mergeTimer = setTimeout(updateMergedZones, 120);
  }

  function syncZoneVisibility() {
    if (!map) return;
    const overlap = zoneMode === 'overlap' && !focusStation ? 'visible' : 'none';
    const merged = zoneMode === 'merged' && !focusStation ? 'visible' : 'none';
    if (map.getLayer('cb-zones-overlap-fill')) map.setLayoutProperty('cb-zones-overlap-fill', 'visibility', overlap);
    if (map.getLayer('cb-zones-overlap-line')) map.setLayoutProperty('cb-zones-overlap-line', 'visibility', overlap);
    ['cb-merged-fill', 'cb-merged-line'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', merged);
    });
    const stVis = focusStation ? 'none' : 'visible';
    if (map.getLayer('cb-stations-active')) map.setLayoutProperty('cb-stations-active', 'visibility', stVis);
    const foc = focusStation ? 'visible' : 'none';
    ['cb-focus-outside-fill', 'cb-focus-fill', 'cb-focus-line'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', foc);
    });
    const elimVis = !focusStation && Game().getQuestions().some(q => q.answer != null) ? 'visible' : 'none';
    if (map.getLayer('cb-elim-fill')) map.setLayoutProperty('cb-elim-fill', 'visibility', elimVis);
    if (map.getLayer('cb-possible-border')) map.setLayoutProperty('cb-possible-border', 'visibility', elimVis);
  }

  function pinEl(color) {
    const el = document.createElement('div');
    el.className = 'map-pin';
    el.innerHTML = `<svg viewBox="0 0 24 36" width="26" height="39" aria-hidden="true">
      <path fill="${color}" stroke="rgba(255,255,255,.85)" stroke-width="1.2"
        d="M12 1C7.03 1 3 5.03 3 10c0 7.25 9 24 9 24s9-16.75 9-24c0-4.97-4.03-9-9-9z"/>
      <circle cx="12" cy="10" r="3.2" fill="#fff"/>
    </svg>`;
    return el;
  }

  function clearMarkers() {
    markers.forEach(m => m.remove());
    markers = [];
  }

  function syncMarkers() {
    if (!map) return;
    clearMarkers();
    const c = map.getCenter();
    const center = { lat: c.lat, lng: c.lng };
    for (const q of Game().getQuestions()) {
      if (!q.open) continue;
      Game().ensureQuestionCoords(q.id, center);
      if ((q.type === 'radius' || q.type === 'airport' || q.type === 'coastline') && q.lat != null) {
        const m = new mapboxgl.Marker({ element: pinEl(q.color), draggable: true, anchor: 'bottom' })
          .setLngLat([q.lng, q.lat])
          .addTo(map);
        m.on('dragend', () => {
          const ll = m.getLngLat();
          Game().setQuestionPoint(q.id, 'center', ll.lat, ll.lng);
        });
        markers.push(m);
      }
      if (q.type === 'thermometer') {
        if (q.latA != null) {
          const m = new mapboxgl.Marker({ element: pinEl(q.colorA || q.color), draggable: true, anchor: 'bottom' })
            .setLngLat([q.lngA, q.latA])
            .addTo(map);
          m.on('dragend', () => {
            const ll = m.getLngLat();
            Game().setQuestionPoint(q.id, 'A', ll.lat, ll.lng);
          });
          markers.push(m);
        }
        if (q.latB != null) {
          const m = new mapboxgl.Marker({ element: pinEl(q.colorB || '#2563eb'), draggable: true, anchor: 'bottom' })
            .setLngLat([q.lngB, q.latB])
            .addTo(map);
          m.on('dragend', () => {
            const ll = m.getLngLat();
            Game().setQuestionPoint(q.id, 'B', ll.lat, ll.lng);
          });
          markers.push(m);
        }
      }
    }
  }

  function refreshMap() {
    if (!map || !layersReady) return;
    if (map.getSource('cb-stations')) map.getSource('cb-stations').setData(stationFeaturesGeoJSON());
    if (map.getSource('cb-zones-overlap')) map.getSource('cb-zones-overlap').setData(overlapZonesGeoJSON());
    if (map.getSource('cb-questions')) map.getSource('cb-questions').setData(Game().questionsGeoJSON());
    if (map.getSource('cb-focus')) map.getSource('cb-focus').setData(focusGeoJSON());
    if (map.getSource('cb-focus-outside')) map.getSource('cb-focus-outside').setData(focusOutsideMask());
    if (map.getSource('cb-elim')) {
      map.getSource('cb-elim').setData(focusStation ? { type: 'FeatureCollection', features: [] } : Game().eliminatedMask());
    }
    if (map.getSource('cb-possible')) {
      map.getSource('cb-possible').setData(
        focusStation ? { type: 'FeatureCollection', features: [] } : Game().possibleAreaGeoJSON(),
      );
    }
    syncZoneVisibility();
    if (zoneMode === 'merged' && !focusStation) updateMergedZones();
    else scheduleMergedUpdate();
    syncMarkers();
    updateLiveBanner();
    if (map.doubleClickZoom) {
      if (focusStation) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    }
  }

  function setFocusStation(st) {
    focusStation = st;
    const info = document.getElementById('cb-focus-info');
    if (info) {
      info.textContent = st
        ? `${st.name} · double-tap outside the circle to unselect`
        : 'Tap a station to isolate its hide circle. Double-tap outside that circle to unselect.';
    }
    refreshMap();
  }

  function populateSearch() {
    const dl = document.getElementById('cb-station-list');
    if (!dl || !Game().stations.length) return;
    const run = () => {
      dl.innerHTML = Game().stations.map(s =>
        `<option value="${s.name.replace(/"/g, '&quot;')}">${s.borough}</option>`,
      ).join('');
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
    else setTimeout(run, 50);
  }

  function mapCenter() {
    if (!map) return { lat: 40.75, lng: -73.98 };
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  async function loadStationData() {
    try {
      const raw = await (await fetch('data/citibike_stations.geojson')).json();
      await Game().initStationData(raw);
      populateSearch();
      refreshMap();
    } catch (e) {
      setStatus('Could not load Citi Bike stations.');
      console.error(e);
    }
  }

  function findStation(text) {
    const q = (text || '').trim().toLowerCase();
    if (!q) return null;
    const all = Game().stations;
    const exact = all.find(s => s.name.toLowerCase() === q);
    if (exact) return exact;
    const partial = all.filter(s => s.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0];
    return partial.find(s => s.name.toLowerCase().startsWith(q)) || null;
  }

  function onStationClick(props, lngLat) {
    const st = Game().stations.find(s => s.id === String(props.id));
    if (!st) return;
    setFocusStation(st);
    map.flyTo({ center: [st.lng, st.lat], zoom: Math.max(map.getZoom(), 14.2), duration: 700 });
  }

  function maybeUnselectFromTap(lngLat) {
    if (!focusStation) return;
    const d = Game().distMi(
      { lat: lngLat.lat, lng: lngLat.lng },
      { lat: focusStation.lat, lng: focusStation.lng },
    );
    if (d <= Game().hideRadiusMi) return;
    const now = Date.now();
    const close = Math.abs(lngLat.lng - lastTap.lng) < 0.002 && Math.abs(lngLat.lat - lastTap.lat) < 0.002;
    if (now - lastTap.t < 420 && close) setFocusStation(null);
    lastTap = { t: now, lng: lngLat.lng, lat: lngLat.lat };
  }

  function updateThemePaint() {
    if (!map || !layersReady) return;
    const casing = theme === 'dark' ? '#0b0e13' : '#ffffff';
    const elim = elimStyle();
    const zones = zoneStyle();
    const stationFill = theme === 'dark' ? '#8ec5ff' : '#003DA5';
    const set = (id, prop, val) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, val); };
    set('cb-elim-fill', 'fill-color', elim.fill);
    set('cb-elim-fill', 'fill-opacity', elim.fillOpacity);
    set('cb-possible-border', 'line-color', elim.border);
    set('cb-possible-border', 'line-width', elim.borderWidth);
    set('cb-focus-outside-fill', 'fill-color', elim.fill);
    set('cb-focus-outside-fill', 'fill-opacity', elim.fillOpacity + 0.08);
    applyZonePaint(zones);
    set('cb-stations-active', 'circle-radius', STATION_DOT_RADIUS);
    set('cb-stations-active', 'circle-color', stationFill);
    set('cb-stations-active', 'circle-stroke-color', casing);
    set('cb-stations-active', 'circle-stroke-width', STATION_DOT_STROKE);
    set('cb-questions-airports', 'circle-stroke-color', casing);
    set('cb-questions-thermo', 'line-opacity', theme === 'dark' ? 0.95 : 0.88);
    set('cb-questions-radius-line', 'line-width', theme === 'dark' ? 2.8 : 2.4);
    set('cb-questions-radius-line', 'line-opacity', theme === 'dark' ? 0.95 : 0.9);
    if (map.getLayer('tf-transport')) {
      map.setPaintProperty('tf-transport', 'raster-opacity', theme === 'dark' ? 0.28 : 0.3);
    }
  }

  function addLayer(layer) {
    if (!layer.slot) layer.slot = 'top';
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }

  function addParkLayers() { /* Mapbox Standard already styles parks */ }

  function addTransitLayer() {
    if (map.getSource('tf-transport')) return;
    map.addSource('tf-transport', {
      type: 'raster',
      tiles: [`https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${TF_KEY}`],
      tileSize: 256,
      attribution: '© Thunderforest, © OSM',
    });
    addLayer({
      id: 'tf-transport', type: 'raster', source: 'tf-transport', slot: 'top',
      layout: { visibility: showTransit ? 'visible' : 'none' },
      paint: { 'raster-opacity': theme === 'dark' ? 0.28 : 0.3 },
    });
  }

  function addMapLayers() {
    layersReady = false;
    clickBound = false;
    const casing = theme === 'dark' ? '#0b0e13' : '#ffffff';
    const elim = elimStyle();
    const zones = zoneStyle();

    addParkLayers();
    addTransitLayer();

    if (!map.getSource('cb-stations')) {
      map.addSource('cb-stations', { type: 'geojson', data: stationFeaturesGeoJSON() });
    }
    if (!map.getSource('cb-zones-overlap')) {
      map.addSource('cb-zones-overlap', {
        type: 'geojson', data: overlapZonesGeoJSON(), ...ZONE_GEOJSON_OPTS,
      });
    }
    if (!map.getSource('cb-merged')) {
      map.addSource('cb-merged', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] }, ...ZONE_GEOJSON_OPTS,
      });
    }
    if (!map.getSource('cb-focus-outside')) {
      map.addSource('cb-focus-outside', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] }, ...ZONE_GEOJSON_OPTS,
      });
    }
    if (!map.getSource('cb-focus')) {
      map.addSource('cb-focus', { type: 'geojson', data: focusGeoJSON(), ...ZONE_GEOJSON_OPTS });
    }
    if (!map.getSource('cb-questions')) {
      map.addSource('cb-questions', { type: 'geojson', data: Game().questionsGeoJSON() });
    }
    if (!map.getSource('cb-elim')) {
      map.addSource('cb-elim', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] }, ...ZONE_GEOJSON_OPTS,
      });
    }
    if (!map.getSource('cb-possible')) {
      map.addSource('cb-possible', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] }, ...ZONE_GEOJSON_OPTS,
      });
    }

    ['cb-zones-overlap', 'cb-zones-halo'].forEach(id => {
      if (map.getLayer(id)) map.removeLayer(id);
    });

    if (!map.getLayer('cb-elim-fill')) {
      addLayer({
        id: 'cb-elim-fill', type: 'fill', source: 'cb-elim',
        layout: { visibility: 'none' },
        paint: { 'fill-color': elim.fill, 'fill-opacity': elim.fillOpacity },
      });
    }
    if (!map.getLayer('cb-possible-border')) {
      addLayer({
        id: 'cb-possible-border', type: 'line', source: 'cb-possible',
        layout: { visibility: 'none' },
        paint: {
          'line-color': elim.border,
          'line-width': elim.borderWidth,
          'line-opacity': 0.95,
        },
      });
    }
    if (!map.getLayer('cb-zones-overlap-fill')) {
      addLayer({
        id: 'cb-zones-overlap-fill', type: 'fill', source: 'cb-zones-overlap',
        paint: {
          'fill-color': zones.fill,
          'fill-opacity': zones.fillOpacity,
          'fill-emissive-strength': zones.emissive,
        },
      });
      addLayer({
        id: 'cb-zones-overlap-line', type: 'line', source: 'cb-zones-overlap',
        paint: {
          'line-color': zones.stroke,
          'line-width': zones.strokeWidth,
          'line-opacity': zones.strokeOpacity,
        },
      });
    }
    if (!map.getLayer('cb-merged-fill')) {
      addLayer({
        id: 'cb-merged-fill', type: 'fill', source: 'cb-merged',
        paint: {
          'fill-color': zones.fill,
          'fill-opacity': zones.fillOpacity + (theme === 'dark' ? 0.12 : 0.06),
          'fill-emissive-strength': zones.emissive,
        },
      });
      addLayer({
        id: 'cb-merged-line', type: 'line', source: 'cb-merged',
        paint: {
          'line-color': zones.stroke,
          'line-width': zones.strokeWidth,
          'line-opacity': zones.strokeOpacity,
        },
      });
    }
    if (!map.getLayer('cb-focus-outside-fill')) {
      addLayer({
        id: 'cb-focus-outside-fill', type: 'fill', source: 'cb-focus-outside',
        layout: { visibility: 'none' },
        paint: { 'fill-color': elim.fill, 'fill-opacity': elim.fillOpacity + 0.08 },
      });
      addLayer({
        id: 'cb-focus-fill', type: 'fill', source: 'cb-focus',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': zones.fill,
          'fill-opacity': zones.focusFillOpacity,
          'fill-emissive-strength': zones.emissive,
        },
      });
      addLayer({
        id: 'cb-focus-line', type: 'line', source: 'cb-focus',
        layout: { visibility: 'none' },
        paint: {
          'line-color': zones.focusStroke,
          'line-width': theme === 'dark' ? 4 : 3.2,
        },
      });
    }
    if (!map.getLayer('cb-questions-thermo')) {
      addLayer({
        id: 'cb-questions-thermo', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'thermo-bisector'],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.8,
          'line-opacity': theme === 'dark' ? 0.95 : 0.88,
        },
      });
      addLayer({
        id: 'cb-questions-radius-line', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'radius-line'],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': theme === 'dark' ? 2.8 : 2.4,
          'line-opacity': theme === 'dark' ? 0.95 : 0.9,
        },
      });
      addLayer({
        id: 'cb-questions-airports', type: 'circle', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'airport'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['coalesce', ['get', 'color'], '#ffb020'],
          'circle-stroke-color': casing, 'circle-stroke-width': 1.5,
        },
      });
    }
    if (!map.getLayer('cb-stations-active')) {
      addLayer({
        id: 'cb-stations-active', type: 'circle', source: 'cb-stations',
        paint: {
          'circle-radius': STATION_DOT_RADIUS,
          'circle-color': '#003DA5',
          'circle-stroke-color': casing,
          'circle-stroke-width': STATION_DOT_STROKE,
        },
      });
    }

    if (!clickBound) {
      map.on('click', 'cb-stations-active', e => {
        if (!e.features?.length) return;
        e.preventDefault();
        onStationClick(e.features[0].properties, e.lngLat);
      });
      map.on('mouseenter', 'cb-stations-active', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'cb-stations-active', () => { map.getCanvas().style.cursor = ''; });
      map.on('click', e => {
        if (e.defaultPrevented) return;
        maybeUnselectFromTap(e.lngLat);
      });
      map.on('dblclick', e => {
        if (!focusStation) return;
        const d = Game().distMi(
          { lat: e.lngLat.lat, lng: e.lngLat.lng },
          { lat: focusStation.lat, lng: focusStation.lng },
        );
        if (d > Game().hideRadiusMi) {
          e.preventDefault();
          setFocusStation(null);
        }
      });
      clickBound = true;
    }

    layersReady = true;
    applyBasemap();
    updateThemePaint();
    refreshMap();
  }

  function getLocation(cb, err) {
    if (!navigator.geolocation) {
      setStatus('Location not available on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => cb({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => { setStatus('Location permission denied.'); if (err) err(); },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  }

  function fillQuestionFromLocation(id, field) {
    getLocation(pt => Game().setQuestionPoint(id, field, pt.lat, pt.lng));
  }

  function updateLiveBanner() {
    const banner = document.getElementById('cb-live-banner');
    if (!banner) return;
    if (!liveLngLat || !document.getElementById('cb-live-endgame')?.checked) {
      banner.classList.remove('show', 'in', 'out');
      return;
    }
    if (!focusStation) {
      banner.classList.add('show');
      banner.classList.remove('in', 'out');
      banner.textContent = 'Live · select a station to check the hide zone';
      return;
    }
    const d = Game().distMi(liveLngLat, focusStation);
    const r = Game().hideRadiusMi;
    const inside = d <= r;
    banner.classList.add('show', inside ? 'in' : 'out');
    banner.classList.remove(inside ? 'out' : 'in');
    const edge = Math.abs(r - d);
    banner.textContent = inside
      ? `Inside zone · ${edge.toFixed(2)} mi to edge`
      : `Outside zone · ${edge.toFixed(2)} mi outside`;
  }

  function setLiveMarker(pt) {
    liveLngLat = pt;
    if (!map) return;
    if (!liveMarker) {
      liveMarker = new mapboxgl.Marker({ color: '#e11d48' }).setLngLat([pt.lng, pt.lat]).addTo(map);
    } else {
      liveMarker.setLngLat([pt.lng, pt.lat]);
    }
    updateLiveBanner();
  }

  function startLiveEndgame() {
    if (!navigator.geolocation) { setStatus('Location not available.'); return; }
    getLocation(pt => {
      setLiveMarker(pt);
      map?.flyTo({ center: [pt.lng, pt.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
    });
    liveWatchId = navigator.geolocation.watchPosition(
      pos => setLiveMarker({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setStatus('Lost live location.'),
      { enableHighAccuracy: true, maximumAge: 2000 },
    );
  }

  function stopLiveEndgame() {
    if (liveWatchId != null) navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = null;
    liveLngLat = null;
    liveMarker?.remove();
    liveMarker = null;
    updateLiveBanner();
  }

  function bindChrome() {
    document.getElementById('cb-theme')?.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.style) return;
      theme = b.dataset.style;
      document.querySelectorAll('#cb-theme button').forEach(x => x.classList.toggle('active', x === b));
      document.body.classList.toggle('dark', theme === 'dark');
      applyBasemap();
      updateThemePaint();
    });

    document.getElementById('cb-zone-mode')?.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.mode) return;
      zoneMode = b.dataset.mode;
      document.querySelectorAll('#cb-zone-mode button').forEach(x => x.classList.toggle('active', x === b));
      refreshMap();
      if (zoneMode === 'merged') updateMergedZones();
    });

    document.getElementById('cb-toggle-transit')?.addEventListener('change', e => {
      showTransit = e.target.checked;
      if (map?.getLayer('tf-transport')) {
        map.setLayoutProperty('tf-transport', 'visibility', showTransit ? 'visible' : 'none');
      }
    });

    document.getElementById('cb-live-endgame')?.addEventListener('change', e => {
      if (e.target.checked) startLiveEndgame();
      else stopLiveEndgame();
    });

    document.getElementById('cb-clear-focus')?.addEventListener('click', () => setFocusStation(null));
    document.getElementById('cb-find-station')?.addEventListener('click', () => {
      const hit = findStation(document.getElementById('cb-station-search')?.value);
      if (!hit) { setStatus('No matching station.'); return; }
      setFocusStation(hit);
      map?.flyTo({ center: [hit.lng, hit.lat], zoom: 15, duration: 800 });
    });
    document.getElementById('cb-station-search')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('cb-find-station')?.click();
    });

    const panel = document.getElementById('panel');
    const toggle = document.getElementById('panel-toggle');
    function syncToggle() {
      if (toggle) toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    }
    document.getElementById('panel-head')?.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      syncToggle();
      setTimeout(() => map?.resize(), 220);
    });
    if (window.innerWidth <= 768) {
      panel.classList.add('collapsed');
      syncToggle();
    }
  }

  async function init() {
    if (!window.MAPBOX_TOKEN || window.MAPBOX_TOKEN.indexOf('YOUR_MAPBOX') === 0) {
      document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Missing Mapbox token. Open the GitHub Pages site.</p>';
      return;
    }
    mapboxgl.accessToken = window.MAPBOX_TOKEN;
    setStatus('Loading map…');

    Game().onChange = refreshMap;
    Game().bindUI();
    Game().renderList();
    bindChrome();

    map = new mapboxgl.Map({
      container: 'map',
      style: STYLE,
      center: [-73.98, 40.75],
      zoom: 12.2,
      pitch: 0,
      bearing: 0,
      hash: true,
      fadeDuration: 0,
      attributionControl: true,
      config: {
        basemap: {
          show3dObjects: false,
          show3dBuildings: false,
          show3dLandmarks: false,
          show3dTrees: false,
          show3dFacades: false,
        },
      },
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }), 'top-right');

    map.on('style.load', () => {
      applyBasemap();
      addMapLayers();
      loadStationData();
    });
    map.once('idle', () => {
      applyBasemap();
      map.jumpTo({ pitch: 0, bearing: 0 });
    });
    map.on('moveend', () => {
      if (zoneMode === 'merged') scheduleMergedUpdate();
    });
  }

  window.JetLagCitibikeApp = { fillQuestionFromLocation, mapCenter };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
