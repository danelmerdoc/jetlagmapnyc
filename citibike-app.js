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

  const STYLES = {
    light: 'mapbox://styles/mapbox/streets-v12',
    dark: 'mapbox://styles/mapbox/dark-v11',
  };

  function setStatus(text) {
    const el = document.getElementById('cb-status');
    if (el) el.textContent = text;
  }

  function stationFeaturesGeoJSON() {
    if (focusStation) return { type: 'FeatureCollection', features: [] };
    const active = Game().getActiveStations();
    setStatus(`${active.length} / ${Game().stations.length} stations possible`);
    return {
      type: 'FeatureCollection',
      features: Game().activeStationFeatures(active),
    };
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

  function scheduleMergedUpdate() {
    clearTimeout(mergeTimer);
    if (zoneMode !== 'merged' || focusStation) {
      if (map?.getSource('cb-merged')) {
        map.getSource('cb-merged').setData({ type: 'FeatureCollection', features: [] });
      }
      return;
    }
    mergeTimer = setTimeout(() => {
      const active = Game().getActiveStations();
      setStatus(`Merging ${active.length} zones…`);
      const data = Game().mergedZonesGeoJSON(active);
      if (map?.getSource('cb-merged')) map.getSource('cb-merged').setData(data);
      setStatus(`${active.length} / ${Game().stations.length} stations possible`);
    }, 280);
  }

  function syncZoneVisibility() {
    if (!map) return;
    const overlap = zoneMode === 'overlap' && !focusStation ? 'visible' : 'none';
    const merged = zoneMode === 'merged' && !focusStation ? 'visible' : 'none';
    if (map.getLayer('cb-zones-overlap')) map.setLayoutProperty('cb-zones-overlap', 'visibility', overlap);
    ['cb-merged-fill', 'cb-merged-line'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', merged);
    });
    const stVis = focusStation ? 'none' : 'visible';
    if (map.getLayer('cb-stations-active')) map.setLayoutProperty('cb-stations-active', 'visibility', stVis);
    const foc = focusStation ? 'visible' : 'none';
    ['cb-focus-outside-fill', 'cb-focus-fill', 'cb-focus-line'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', foc);
    });
  }

  function markerEl(label, color) {
    const el = document.createElement('div');
    el.className = 'marker-label';
    el.style.color = color;
    el.textContent = label;
    return el;
  }

  function clearMarkers() {
    markers.forEach(m => m.remove());
    markers = [];
  }

  function syncMarkers() {
    if (!map) return;
    clearMarkers();
    for (const q of Game().getQuestions()) {
      if ((q.type === 'radius' || q.type === 'airport') && q.lat != null) {
        const m = new mapboxgl.Marker({ element: markerEl(q.type === 'radius' ? 'Radius' : 'You', q.color), draggable: true })
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
          const m = new mapboxgl.Marker({ element: markerEl('Start', q.color), draggable: true })
            .setLngLat([q.lngA, q.latA])
            .addTo(map);
          m.on('dragend', () => {
            const ll = m.getLngLat();
            Game().setQuestionPoint(q.id, 'A', ll.lat, ll.lng);
          });
          markers.push(m);
        }
        if (q.latB != null) {
          const m = new mapboxgl.Marker({ element: markerEl('End', q.color), draggable: true })
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
    if (map.getSource('cb-questions')) map.getSource('cb-questions').setData(Game().questionsGeoJSON());
    if (map.getSource('cb-focus')) map.getSource('cb-focus').setData(focusGeoJSON());
    if (map.getSource('cb-focus-outside')) map.getSource('cb-focus-outside').setData(focusOutsideMask());
    syncZoneVisibility();
    scheduleMergedUpdate();
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
    if (!dl) return;
    dl.innerHTML = Game().stations.map(s =>
      `<option value="${s.name.replace(/"/g, '&quot;')}">${s.borough}</option>`,
    ).join('');
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

  function addParkLayers() {
    if (!map.getSource('composite')) return;
    const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
    const parkColor = theme === 'dark' ? '#3f7a4a' : '#8fd18a';
    const specs = [
      { id: 'cb-parks-landuse', layer: 'landuse', filter: ['match', ['get', 'class'], ['park', 'pitch', 'grass', 'cemetery', 'wood', 'scrub', 'national_park', 'golf_course'], true, false] },
      { id: 'cb-parks-cover', layer: 'landcover', filter: ['match', ['get', 'class'], ['grass', 'scrub', 'wood', 'crop'], true, false] },
      { id: 'cb-parks-park', layer: 'park', filter: null },
    ];
    for (const spec of specs) {
      if (map.getLayer(spec.id)) continue;
      try {
        const layer = {
          id: spec.id, type: 'fill', source: 'composite', 'source-layer': spec.layer,
          paint: { 'fill-color': parkColor, 'fill-opacity': spec.layer === 'landcover' ? 0.22 : 0.42 },
        };
        if (spec.filter) layer.filter = spec.filter;
        if (firstSymbol) map.addLayer(layer, firstSymbol);
        else map.addLayer(layer);
      } catch (_) { /* style without this source-layer */ }
    }
  }

  function addTransitLayer() {
    if (map.getSource('tf-transport')) return;
    map.addSource('tf-transport', {
      type: 'raster',
      tiles: [`https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${TF_KEY}`],
      tileSize: 256,
      attribution: '© Thunderforest, © OSM',
    });
    map.addLayer({
      id: 'tf-transport', type: 'raster', source: 'tf-transport',
      layout: { visibility: showTransit ? 'visible' : 'none' },
      paint: { 'raster-opacity': theme === 'dark' ? 0.38 : 0.32 },
    });
  }

  function addMapLayers() {
    layersReady = false;
    clickBound = false;
    const casing = theme === 'dark' ? '#0b0e13' : '#ffffff';
    const elimColor = theme === 'dark' ? '#0f172a' : '#1e293b';

    addParkLayers();
    addTransitLayer();

    if (!map.getSource('cb-stations')) {
      map.addSource('cb-stations', { type: 'geojson', data: stationFeaturesGeoJSON() });
    }
    if (!map.getSource('cb-merged')) {
      map.addSource('cb-merged', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('cb-focus-outside')) {
      map.addSource('cb-focus-outside', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!map.getSource('cb-focus')) {
      map.addSource('cb-focus', { type: 'geojson', data: focusGeoJSON() });
    }
    if (!map.getSource('cb-questions')) {
      map.addSource('cb-questions', { type: 'geojson', data: Game().questionsGeoJSON() });
    }

    if (!map.getLayer('cb-zones-overlap')) {
      map.addLayer({
        id: 'cb-zones-overlap', type: 'circle', source: 'cb-stations',
        paint: {
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 20, ['get', 'r20']],
          'circle-color': '#ffb020',
          'circle-opacity': 0.16,
          'circle-stroke-color': '#e69500',
          'circle-stroke-opacity': 0.55,
          'circle-stroke-width': 1.1,
          'circle-pitch-alignment': 'map',
        },
      });
    }
    if (!map.getLayer('cb-merged-fill')) {
      map.addLayer({
        id: 'cb-merged-fill', type: 'fill', source: 'cb-merged',
        paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'cb-merged-line', type: 'line', source: 'cb-merged',
        paint: { 'line-color': '#e69500', 'line-width': 1.6 },
      });
    }
    if (!map.getLayer('cb-focus-outside-fill')) {
      map.addLayer({
        id: 'cb-focus-outside-fill', type: 'fill', source: 'cb-focus-outside',
        layout: { visibility: 'none' },
        paint: { 'fill-color': elimColor, 'fill-opacity': 0.52 },
      });
      map.addLayer({
        id: 'cb-focus-fill', type: 'fill', source: 'cb-focus',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: 'cb-focus-line', type: 'line', source: 'cb-focus',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffb020', 'line-width': 3 },
      });
    }
    if (!map.getLayer('cb-questions-thermo')) {
      map.addLayer({
        id: 'cb-questions-thermo', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'thermo-line'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
      });
      map.addLayer({
        id: 'cb-questions-radius-line', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'radius-line'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 2.4, 'line-dasharray': [1.2, 0.8] },
      });
      map.addLayer({
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
      map.addLayer({
        id: 'cb-stations-active', type: 'circle', source: 'cb-stations',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 7],
          'circle-color': '#003DA5',
          'circle-stroke-color': casing,
          'circle-stroke-width': 1.2,
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
      if (map) map.setStyle(STYLES[theme]);
    });

    document.getElementById('cb-zone-mode')?.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.mode) return;
      zoneMode = b.dataset.mode;
      document.querySelectorAll('#cb-zone-mode button').forEach(x => x.classList.toggle('active', x === b));
      refreshMap();
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

    try {
      const raw = await (await fetch('data/citibike_stations.geojson')).json();
      await Game().initStationData(raw);
    } catch (e) {
      setStatus('Could not load Citi Bike stations.');
      console.error(e);
      return;
    }
    populateSearch();
    Game().onChange = refreshMap;
    Game().bindUI();
    Game().renderList();

    map = new mapboxgl.Map({
      container: 'map',
      style: STYLES[theme],
      center: [-73.98, 40.72],
      zoom: 10.4,
      hash: true,
      attributionControl: true,
      antialias: true,
    });
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }), 'top-right');

    map.on('style.load', addMapLayers);
    bindChrome();
  }

  window.JetLagCitibikeApp = { fillQuestionFromLocation };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
