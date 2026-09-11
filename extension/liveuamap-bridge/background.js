/*
 * Service worker: the only place allowed to make the cross-origin POST to the
 * local dev server. Receives normalized-ish map state from relay.js and pushes
 * it to /api/liveuamap/ingest.
 *
 * ── EDIT THESE if your dev server differs ──────────────────────────────────
 *   PORTS  — GEV dev server port (npm run dev prints it; default 4173)
 *   TOKEN  — must match LIVEUAMAP_INGEST_TOKEN (the dev server prints it on start)
 */
const PORTS = [4173, 5173];
const TOKEN = 'gev-liveuamap-bridge';

let goodBase = null; // remember which port answered

async function postIngest(payload) {
  const bases = goodBase ? [goodBase] : PORTS.map((p) => `http://localhost:${p}`);
  let lastErr = 'no dev server';
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/liveuamap/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Liveuamap-Token': TOKEN },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = json.error || `HTTP ${res.status}`;
        continue;
      }
      goodBase = base;
      return json;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
  }
  goodBase = null;
  return { error: lastErr };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'gev-liveuamap-ingest') {
    postIngest(msg.payload).then(sendResponse);
    return true; // async response
  }
  return false;
});
