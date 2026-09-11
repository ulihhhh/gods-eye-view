# GEV Liveuamap Bridge (unpacked extension)

Relays the map data from **your own** `liveuamap.com` browser tabs to the local
God's Eye View dev server. You stay signed in and pass Cloudflare yourself —
the extension only reads the page's already-decoded map state (`window.ovens`)
and POSTs it to `http://localhost:<devport>/api/liveuamap/ingest`.

**Local prototype only.** Liveuamap data is a paid, non-redistributable product
(see `../../DATA_SOURCES.md`). Don't ship this or the layer that consumes it.

## Install (Chrome / Arc / any Chromium)

1. **Chrome:** open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, choose this folder (`extension/liveuamap-bridge`).
   **Arc:** open `arc://extensions` (same UI), or Chrome's — Arc shares the
   profile — then pin it from the Arc extensions menu.
2. Check `background.js` — `PORTS` and `TOKEN` must match your dev server.
   `npm run dev` prints the token line:
   `➜  Liveuamap bridge: load extension/liveuamap-bridge, token "gev-liveuamap-bridge"`
3. Start the dev server (`npm run dev` / `startgodseye`).

## Use

1. Open the maps you want in normal tabs — `https://yemen.liveuamap.com/`,
   `https://syria.liveuamap.com/`, etc. Pass the Cloudflare check if shown.
2. A small `GEV bridge · …` chip appears bottom-left of each map tab. Green =
   pushed OK (`yemen: 30 events, 2 fields`). Red = dev server unreachable or a
   token mismatch.
3. Each tab re-pushes every ~45 s and whenever you focus it. Leave the tabs
   open (a background tab is fine) for continuous updates.
4. In GEV: **DATA LAYERS → "Liveuamap (conflict)" → on**. Regions appear
   automatically as their tabs push data — no config needed. To restrict which
   regions render, set `VITE_LIVEUAMAP_REGIONS=yemen,syria` in `.env`.

## Files

| File | World | Job |
|---|---|---|
| `reader.js` | page (MAIN) | read `window.ovens` / `window.markers`, `postMessage` it out |
| `relay.js` | isolated | receive it, forward to the worker, draw the status chip |
| `background.js` | service worker | the cross-origin `POST` to the dev server |

Snapshots land in `.gev-cache/liveuamap/<region>.json` (git-ignored).
