/** Overpass API client (browser CORS) for POI / matching questions. */
window.JetLagOverpass = (function () {
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const cache = new Map();

  async function query(ql) {
    const key = ql.trim();
    if (cache.has(key)) return cache.get(key);
    let lastErr;
    for (const base of ENDPOINTS) {
      try {
        const url = base + '?' + new URLSearchParams({ data: ql });
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        cache.set(key, data);
        return data;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass failed');
  }

  function elementsToPoints(data, tagKey) {
    const out = [];
    for (const el of data.elements || []) {
      let lat, lon, name;
      if (el.type === 'node') {
        lat = el.lat; lon = el.lon;
      } else if (el.center) {
        lat = el.center.lat; lon = el.center.lon;
      } else continue;
      name = el.tags?.name || el.tags?.[tagKey] || 'POI';
      out.push({ lat, lng: lon, name, id: String(el.id) });
    }
    return out;
  }

  async function poisAround(lat, lng, filter, radiusM = 25000) {
    const ql = `[out:json][timeout:25];(nwr${filter}(around:${radiusM},${lat},${lng}););out center 200;`;
    const data = await query(ql);
    return elementsToPoints(data);
  }

  return { query, poisAround, elementsToPoints };
})();
