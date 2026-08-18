/** Citi Bike hide-and-seek map — same Mapbox setup as the GitHub Pages transit map. */
(function () {
  const Game = () => window.JetLagCitibikeGame;
  const Geo = () => window.JetLagGeo;

  let map = null;
  let theme = 'light';
  let showZones = true;
  let focusStation = null;
  let clickBound = false;
  let layersReady = false;

  const STYLES = {
    light: 'mapbox://styles/mapbox/light-v11',
    dark: 'mapbox://styles/mapbox/dark-v11',
  };

  function setStatus(text) {
    const el = document.getElementById('cb-status');
    if (el) el.textContent = text;
  }

  function stationFeaturesGeoJSON() {
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
    return {
      type: 'FeatureCollection',
      features: [
        circle,
        turf.feature(turf.point([focusStation.lng, focusStation.lat]).geometry, {
          kind: 'focus-center', name: focusStation.name,
        }),
      ],
    };
  }

  function focusOutsideMask() {
    if (!focusStation) return { type: 'FeatureCollection', features: [] };
    return Geo().holedMask(Game().stationCircle(focusStation));
  }

  function refreshMap() {
    if (!map || !layersReady) return;
    if (map.getSource('cb-stations')) {
      map.getSource('cb-stations').setData(stationFeaturesGeoJSON());
    }
    if (map.getSource('cb-questions')) {
      map.getSource('cb-questions').setData(Game().questionsGeoJSON());
    }
    if (map.getSource('cb-focus')) {
      map.getSource('cb-focus').setData(focusGeoJSON());
    }
    if (map.getSource('cb-focus-outside')) {
      map.getSource('cb-focus-outside').setData(focusOutsideMask());
    }
    const vis = focusStation ? 'visible' : 'none';
    ['cb-focus-outside-fill', 'cb-focus-fill', 'cb-focus-line', 'cb-focus-center'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  }

  function setFocusStation(st) {
    focusStation = st;
    const info = document.getElementById('cb-focus-info');
    if (info) {
      info.textContent = st
        ? `${st.name} · outside this hide zone is tinted`
        : 'Tap a station pin to focus its hide zone.';
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
    if (props.active === 0 || props.active === '0' || props.active === false || props.active === 'false') {
      new mapboxgl.Popup({ offset: 8, closeOnClick: true })
        .setLngLat(lngLat)
        .setHTML(`<div><strong>${st.name}</strong><br><span style="opacity:.7">Eliminated</span></div>`)
        .addTo(map);
      return;
    }
    setFocusStation(st);
    map.flyTo({ center: [st.lng, st.lat], zoom: Math.max(map.getZoom(), 14), duration: 700 });
  }

  function addMapLayers() {
    layersReady = false;
    clickBound = false;
    const casing = theme === 'dark' ? '#0b0e13' : '#ffffff';
    const elimColor = theme === 'dark' ? '#0f172a' : '#1e293b';

    if (!map.getSource('cb-stations')) {
      map.addSource('cb-stations', { type: 'geojson', data: stationFeaturesGeoJSON() });
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

    if (!map.getLayer('cb-zones-fill')) {
      map.addLayer({
        id: 'cb-zones-fill', type: 'circle', source: 'cb-stations',
        filter: ['==', ['get', 'active'], 1],
        layout: { visibility: showZones ? 'visible' : 'none' },
        paint: {
          'circle-radius': [
            'interpolate', ['exponential', 2], ['zoom'],
            0, 0,
            20, ['get', 'r20'],
          ],
          'circle-color': '#ffb020',
          'circle-opacity': 0.18,
          'circle-stroke-color': '#ffb020',
          'circle-stroke-opacity': 0.45,
          'circle-stroke-width': 1,
          'circle-pitch-alignment': 'map',
        },
      });
    }

    if (!map.getLayer('cb-focus-outside-fill')) {
      map.addLayer({
        id: 'cb-focus-outside-fill', type: 'fill', source: 'cb-focus-outside',
        layout: { visibility: 'none' },
        paint: { 'fill-color': elimColor, 'fill-opacity': 0.5 },
      });
      map.addLayer({
        id: 'cb-focus-fill', type: 'fill', source: 'cb-focus',
        filter: ['==', ['get', 'kind'], 'focus-zone'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.28 },
      });
      map.addLayer({
        id: 'cb-focus-line', type: 'line', source: 'cb-focus',
        filter: ['==', ['get', 'kind'], 'focus-zone'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffb020', 'line-width': 2.5 },
      });
    }

    if (!map.getLayer('cb-questions-thermo')) {
      map.addLayer({
        id: 'cb-questions-thermo', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'thermo-line'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
      });
      map.addLayer({
        id: 'cb-questions-region', type: 'fill', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'thermo-region'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'cb-questions-radius', type: 'fill', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'radius-fill'],
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['==', ['get', 'answer'], 'within'], 0.28, 0.1],
        },
      });
      map.addLayer({
        id: 'cb-questions-radius-line', type: 'line', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'radius-fill'],
        paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
      });
      map.addLayer({
        id: 'cb-questions-airport', type: 'fill', source: 'cb-questions',
        filter: ['==', ['get', 'kind'], 'airport-cell'],
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'cb-questions-points', type: 'circle', source: 'cb-questions',
        filter: ['in', ['get', 'kind'], ['literal', ['radius-center', 'thermo-end', 'airport']]],
        paint: {
          'circle-radius': 5,
          'circle-color': ['coalesce', ['get', 'color'], '#ffb020'],
          'circle-stroke-color': casing, 'circle-stroke-width': 1.5,
        },
      });
    }

    if (!map.getLayer('cb-stations-inactive')) {
      map.addLayer({
        id: 'cb-stations-inactive', type: 'circle', source: 'cb-stations',
        filter: ['==', ['get', 'active'], 0],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 4],
          'circle-color': theme === 'dark' ? '#475569' : '#94a3b8',
          'circle-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'cb-stations-active', type: 'circle', source: 'cb-stations',
        filter: ['==', ['get', 'active'], 1],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 7],
          'circle-color': '#003DA5',
          'circle-stroke-color': casing,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 14, 1.5],
        },
      });
      map.addLayer({
        id: 'cb-focus-center', type: 'circle', source: 'cb-focus',
        filter: ['==', ['get', 'kind'], 'focus-center'],
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 8,
          'circle-color': '#ffb020',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      });
    }

    if (!clickBound) {
      ['cb-stations-active', 'cb-stations-inactive'].forEach(layer => {
        map.on('click', layer, e => {
          if (!e.features?.length) return;
          onStationClick(e.features[0].properties, e.lngLat);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      });
      clickBound = true;
    }

    layersReady = true;
    refreshMap();
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

    document.getElementById('cb-toggle-zones')?.addEventListener('change', e => {
      showZones = e.target.checked;
      if (map?.getLayer('cb-zones-fill')) {
        map.setLayoutProperty('cb-zones-fill', 'visibility', showZones ? 'visible' : 'none');
      }
    });

    document.getElementById('cb-clear-focus')?.addEventListener('click', () => setFocusStation(null));

    document.getElementById('cb-find-station')?.addEventListener('click', () => {
      const hit = findStation(document.getElementById('cb-station-search')?.value);
      if (!hit) {
        setStatus('No matching station.');
        return;
      }
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
    document.getElementById('panel-head')?.addEventListener('click', e => {
      if (e.target.closest('a')) return;
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
      document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Missing <code>config.js</code> Mapbox token. Copy <code>config.example.js</code> or open the GitHub Pages site.</p>';
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

    let longPressTimer = null;
    map.on('touchstart', e => {
      if (e.points.length !== 1) return;
      longPressTimer = setTimeout(() => {
        const ll = e.lngLat;
        navigator.clipboard?.writeText(`${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`);
        new mapboxgl.Popup({ offset: 8 }).setLngLat(ll)
          .setHTML(`Copied ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`).addTo(map);
      }, 550);
    });
    map.on('touchend', () => clearTimeout(longPressTimer));
    map.on('touchmove', () => clearTimeout(longPressTimer));
    map.on('contextmenu', e => {
      e.preventDefault();
      const ll = e.lngLat;
      navigator.clipboard?.writeText(`${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
