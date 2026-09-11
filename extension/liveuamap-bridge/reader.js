/*
 * Runs in the PAGE's JS context (world: MAIN) on *.liveuamap.com.
 * Liveuamap's own scripts fetch and DECODE the map data into `window.ovens`
 * (and wrap markers in `window.markers`). We just read those and hand them to
 * the isolated relay script via window.postMessage — this world can't talk to
 * the extension directly.
 *
 * `ovens.fields` is NOT the territory polygons — it's an ARRAY of field IDs
 * relevant to the current view (`getfieldbyId` walks it with `.length` /
 * numeric index). The actual polygon geometry — {id: {points, strokecolor,
 * fillcolor, type_id, ...}} — is fetched once per page load and cached by
 * Liveuamap's own code in `localStorage['fields']` on this subdomain. That's
 * what we read for territory.
 *
 * No page data leaves the browser except to the local dev server the relay
 * posts to. Local prototype only.
 */
(function () {
  const TICK_MS = 45000;

  function readFieldsCache() {
    try {
      const raw = localStorage.getItem('fields');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function readState() {
    const ovens = window.ovens && typeof window.ovens === 'object' ? window.ovens : null;
    const markers = Array.isArray(window.markers)
      ? window.markers.map((m) => m && m.v).filter(Boolean)
      : null;
    const fieldsCache = readFieldsCache();
    if (!ovens && (!markers || !markers.length) && !fieldsCache) return null;
    return {
      region: (location.hostname.split('.')[0] || '').toLowerCase(),
      resid: typeof window.resource_id === 'number' ? window.resource_id : null,
      href: location.href,
      ovens: ovens
        ? {
            venues: Array.isArray(ovens.venues) ? ovens.venues : null,
            datac: ovens.datac ?? null,
            datam: ovens.datam ?? null,
            datay: ovens.datay ?? null,
          }
        : null,
      // The real territory/arrow polygon geometry (see header note above) —
      // not `ovens.fields`, which is just an ID list.
      fieldsCache,
      markers,
    };
  }

  function send() {
    const state = readState();
    if (!state) return;
    window.postMessage({ __gevLiveuamapBridge: 1, payload: state }, location.origin);
  }

  // ovens can populate a beat after load; retry a few times, then settle into a slow tick.
  send();
  [3000, 8000, 16000, 25000].forEach((t) => setTimeout(send, t));
  setInterval(send, TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) send();
  });
})();
