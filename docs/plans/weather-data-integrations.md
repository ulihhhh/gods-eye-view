# Weather data integrations — design plan

Status: **planning, no code yet.** Nothing in this document describes shipped
behavior — for that, see `docs/CURRENT-STATE.md`, which stays the authoritative
runtime reference and only records verified behavior. This file is a design
record for work on branch `feat/weather-layers` (branched from `main`,
following this repo's `<type>/<kebab-description>` convention), kept under
version control so the plan stays reviewable alongside the code that
implements it, and gets folded into the real docs (`docs/CURRENT-STATE.md`,
`DATA_SOURCES.md`, `CHANGELOG.md`, `README.md`) once shipped, per
`CONTRIBUTING.md`.

## Goal

Add real, live weather data to the globe: Spain-specific station/forecast/
warning detail from **AEMET OpenData**, a global numeric fallback from
**Open-Meteo**, and a global near-real-time cloud/satellite visual from
**NASA GIBS**. EUMETSAT was considered and deliberately **excluded** — it
needs OAuth token refresh every hour and ships raw NetCDF/HRIT rather than
map-ready output, the heaviest lift of everything reviewed, worth revisiting
only if GIBS's 3–6 h latency over Europe proves insufficient later.

## What's already there (don't re-build this)

- **NASA FIRMS is already a full live layer** — `server/providers/firms.js`
  (memory + disk cache, `FIRMS_MAP_KEY`), `src/data/firmsCsv.js`,
  `firmsHeatmap.js`, `firmsLabels.js`, `firmsAdapt.js`, registered in
  `layerState.js` as `local-firms` (token `w`). **A NASA GIBS "fire/thermal
  anomaly" tile layer would be pure duplication of this — out of scope,
  don't add it.**
- **Open-Meteo is already integrated, twice, but narrowly.** Both call
  `https://api.open-meteo.com/v1/forecast` with only
  `current=temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility`
  for a single point — no forecast horizon, no marine/air-quality/historical
  APIs, no map layer:
  - `regionalBriefProxy` (`/api/regional-brief`, `server/providers/local.js`)
    → the cockpit "Local Info" current-conditions text.
  - `weatherEffectsProxy` (`/api/weather-effects`, same file) → drives
    `src/cockpitCloudEffects.js`'s real-time cloud/precip visual near the
    camera. Not decorative/procedural as it might look — it's genuinely
    data-driven, just rendered as an atmospheric effect rather than a toggle-
    able layer with map entities.
  - Both share `fetchRegionalWeather()` (`server/providers/local.js:4196`).
    A new map-layer use of Open-Meteo should call the **same function**
    rather than adding a third parallel Open-Meteo client, and its credit in
    `DATA_SOURCES.md`/`dataCredits.js` already exists — extend the "used
    for" description rather than adding a duplicate entry.
- **"Satellite imagery" in GEV means basemap orthophotography**
  (`mapStackController.js`: Bing Aerial, Esri World Imagery, Google
  Photorealistic 3D Tiles) — static ground appearance, not live atmospheric
  imagery. GIBS true-color/IR is a different category (current weather, not
  ground truth) and doesn't compete with these.
- **No existing layer stacks a second raster imagery layer.** Every current
  "layer" in `layerState.js`'s `LAYER_STATE_REGISTRY` is Cesium entities
  (points/polylines/labels). `mapStackController.js` owns exactly **one**
  exclusive base `Cesium.ImageryLayer` (swapped, never stacked — see
  `_imageryLayer`/`_removeImageryLayer`). TomTom traffic flow, the other tile-
  shaped live source, is *not* a stacked imagery layer either. **GIBS is
  therefore the first "translucent overlay imagery layer on top of the base
  map" in this app** — a new capability, not a variation on an existing one.
  See [Architecture — NASA GIBS](#architecture--nasa-gibs) below.

## AEMET OpenData (new)

Spain-specific, nothing else here covers it: live station observations
(temp/wind/humidity/pressure/precip with real lat/lon), municipal forecasts,
and CAP-format province warning polygons (severity-coded).

### Phase A0 — station layer

- `AEMET_API_KEY` (free, requested by email at
  `https://opendata.aemet.es/centrodedescargas/altaUsuario`), server-side
  only, same posture as `FIRMS_MAP_KEY`/`TOMTOM_API_KEY` in `.env.example`.
- New `server/providers/weather/aemet.js`, exporting `aemetStationsProxy()`,
  mirroring `celestrakProxy`/`firmsProxy`: memory + disk cache
  (`.gev-cache/aemet-stations.json`), single-flight `inflight`, TTL sized to
  AEMET's ~50 req/min cap and the fact that station data itself only updates
  every 10–60 min, serve-stale-on-failure.
- AEMET's own API requires a two-step fetch per call (the first response is
  `{descripcion, estado, datos}`, where `datos` is a second URL holding the
  real payload) — this indirection is exactly the kind of upstream quirk this
  proxy layer exists to hide from the browser; the client only ever sees a
  flat `/api/aemet/stations` JSON array.
- Routes: `GET /api/aemet/stations` (all-stations snapshot, from AEMET's
  `observacion/convencional/todas`) and `GET /api/aemet/stations/status`
  (mirrors `/api/firms/status`'s `{hasKey, lastFetch, ...}` shape).
- `server/providers/weather.js` index re-exporting `aemet.js`'s proxy,
  registered into `server/providers/local.js`'s composed list.
- `src/data/weatherProviderRequests.js` (portable, no Node imports — mirrors
  `spaceProviderRequests.js`): pure AEMET URL construction + station-record
  normalization, unit-tested without touching the network, importable by both
  the server provider and its tests.
- `src/data/aemetStations.js`, the frontend layer implementing this app's
  standard `init/enable/disable/update/destroy/getStats` shape (see
  `aisLiveVessels.js`), plotting stations colored/sized by current
  temperature (mirrors the existing marker-coloring approach already used
  elsewhere rather than inventing a new one).
- `layerState.js`: new entry, e.g.
  `{ id: 'aemet-stations', token: 'h', disposition: 'enabled-only' }`
  (`h` is unused; used tokens today: a b c d e f g i m q r s t u w x).
  `REGISTERED_LAYER_IDS` count assertion in `layerState.test.mjs` bumps
  accordingly.
- Registered in `src/main.js` with `DataLayerManager`, same pattern as
  `local-adsb`. No manual panel UI needed — the toggle panel builds itself
  from each registered layer's `icon`/`name`.

### Phase A1 — warnings overlay

- `GET /api/aemet/warnings` — active `avisos` CAP alerts by province, proxied
  the same way, cached on a shorter TTL (warnings can escalate quickly,
  unlike station readings).
- Requires converting AEMET's CAP zone codes to renderable polygons — AEMET
  publishes the avisos zone shapefile/GeoJSON separately from the live feed;
  confirm the exact current download location and license during
  implementation (an open question below, not assumed).
- `src/data/aemetWarnings.js`, its own layer entry (e.g.
  `{ id: 'aemet-warnings', token: 'j', disposition: 'enabled-only' }`),
  polygons tinted by severity (green/yellow/orange/red).

### Phase A2 — forecast tooltip (optional, low priority)

Click a station/municipality to show AEMET's next-hours forecast. Only worth
doing once A0 ships and proves the interaction pattern is worth the extra
call volume against the 50 req/min cap.

## Open-Meteo (extend existing integration)

The two existing single-point call sites stay as-is (cockpit text + cloud
effects). What's missing is a **map layer** — Open-Meteo has no station
network of its own, so "where do the points come from" is a real design
decision, not a given:

- **Option 1 — global fallback for AEMET's layer.** Outside Spain, plot a
  fixed or camera-relative set of sample points using the same marker style
  as `aemetStations.js`, backed by Open-Meteo instead of AEMET. Reuses the
  Phase A0 rendering code, cheapest to build, but "where are the points"
  needs an answer (major cities? a lat/lon grid? viewport-sampled?).
- **Option 2 — on-demand point query.** Generalize the existing cockpit
  current-conditions call so *any* clicked point on the globe (not just
  camera-follow) can show current conditions via Open-Meteo — no new layer
  registry entry, just extending what the cockpit info panel already knows
  how to do.
- Left as an [open question](#open-questions) — pick one before writing
  code, since they lead to different files (a new layer vs. extending
  `cockpitCloudEffects.js`/the regional-brief panel).
- Whichever option: call the existing `fetchRegionalWeather()` (extended with
  more fields, e.g. `precipitation_probability`, if Option 1's marker style
  needs it) rather than adding a parallel client, and keep it on the existing
  `/api/weather-effects`-style cache/rate-limit posture (`common/rate-limit.js`).
- Marine and air-quality Open-Meteo sub-APIs are real future extensions
  (both free, same host, no separate key) but out of scope for this pass —
  not needed until a maritime or pollution layer is actually planned.

## NASA GIBS

Global, keyless WMTS tiles (`https://gibs.earthdata.nasa.gov/wmts/...`),
3–6 h latency. True-color/IR near-real-time cloud imagery, distinct from
FIRMS (already covered) and from the static basemap imagery (see above).

### Architecture — NASA GIBS

This needs a **second, non-exclusive imagery layer stacked on top of the
current base map**, not another entity-based `LAYER_STATE_REGISTRY` toggle
like every other layer here, and not a swap through
`mapStackController.js`'s single `_imageryLayer` slot (that's reserved for
the base map itself — Bing/Esri/Google — and swapping it would replace the
ground texture, not add a translucent weather layer above it).

Concretely:
- `Cesium.WebMapTileServiceImageryProvider` pointed at a GIBS layer id (e.g.
  `MODIS_Terra_CorrectedReflectance_TrueColor`), added via
  `viewer.imageryLayers.add(layer, <higher index than the base>)` — Cesium
  supports multiple stacked imagery layers natively, this app just hasn't
  needed a second one yet.
- A small new controller (e.g. `src/gibsOverlayController.js`, sibling to
  `mapStackController.js` rather than folded into it, since its lifecycle —
  add/remove one extra translucent layer — is simpler than exclusive
  base-map switching) owning: enable/disable, an opacity slider (GIBS tiles
  are meant to sit *over* a basemap, so full opacity would obscure it), and
  which GIBS product is active (true-color vs. IR vs. snow-cover — pick one
  at a time, matching how `satellites.js`'s options work today).
- Still worth a `layerState.js` entry purely for persistence/share-links
  (e.g. `{ id: 'satellite-weather', token: 'n', disposition:
  'enabled+options', optionOwner: 'satellite-weather' }` for the
  opacity/product choice), even though its *rendering* path is imagery, not
  entities — the registry's job is state, not rendering mechanism.
- No API key, no server-side proxy needed (GIBS answers CORS-enabled tile
  requests directly) — this is the cheapest of the three to wire up.

## Testing strategy (no live network required for most of it)

- AEMET: mock the two-step `descripcion/estado/datos` response shape the
  same way `celestrakProxy`'s tests mock CelesTrak — a fake first response
  pointing at a fake second URL, asserting the proxy resolves both.
- Open-Meteo layer/tooltip: mock `fetchRegionalWeather`'s upstream fetch,
  same style as the existing `weatherEffectsProxy` tests (if any exist yet —
  check and follow that pattern, or `firmsProxy.test.mjs`'s style if not).
- GIBS: no server code to test (client-only, no proxy) — cover the
  overlay controller's add/remove/opacity logic against a fake
  `Cesium.ImageryLayerCollection`, matching how `mapStackController.test.mjs`
  (if present) or `aisLiveVessels.test.mjs`-style tests fake a viewer.
- `scripts/qa-*.mjs` headless scripts for each phase once wired into the app,
  matching the existing `scripts/qa-*.mjs` convention (never against real
  upstream hosts).

## Open questions

- **Open-Meteo map-layer shape** (see above): fixed grid, camera-relative
  sampling, or click-to-query? Needs a decision before A1/Open-Meteo Option 1
  code is written.
- **AEMET avisos zone geometry source**: confirm the current official
  download location/format/license for the warning-zone polygons (separate
  from the live CAP feed) before Phase A1.
- **GIBS product choice for v1**: true-color alone, or true-color + IR +
  snow-cover as switchable options from day one? Affects whether
  `optionOwner: 'satellite-weather'` needs an enum from the start.
- **AEMET rate-limit headroom**: 50 req/min shared across stations +
  warnings + (later) forecasts — confirm the cache TTLs proposed above
  actually keep real-world usage well under that cap before shipping A1/A2.
- **AEMET key acquisition**: confirm the current sign-up flow still works
  as described (email-only, no approval wait) — AEMET's process has changed
  before and should be re-verified at implementation time, not assumed from
  this planning pass.

## Docs to update once each phase actually ships

Per `CONTRIBUTING.md`, in the same PR as the implementation (not before):
`docs/CURRENT-STATE.md` (verified runtime behavior), `DATA_SOURCES.md` (new
AEMET entry with its license/attribution terms; extend the existing
Open-Meteo entry's "used for" column rather than duplicating it; new NASA
GIBS entry — check GIBS's current citation requirements), `CHANGELOG.md`,
and the layers table in `README.md`. `dataCredits.js` needs a new `aemet`
and `nasa-gibs` entry (Open-Meteo's existing `open-meteo` credit just needs
its `html` description broadened).
