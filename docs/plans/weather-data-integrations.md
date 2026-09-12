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

## Layer summary — what's actually shipping

Four toggleable things, each independent, each gets the standard toggle-panel
button for free (`dataManager.register(...)` + a `LAYER_STATE_REGISTRY`
entry — no manual panel UI, per `_renderToggles()` in `src/data/manager.js`,
confirmed still true post-refactor: `src/standalone/data.js` is the actual
registration site now, not `main.js`).

| Layer | Shows | Coverage | Disposition | Toggle |
|---|---|---|---|---|
| `aemet-stations` | Live station pins, colored by current temperature; click for wind/humidity/pressure | Spain only (~250 AEMET stations) | `enabled-only` | Single click, on/off |
| `aemet-warnings` | Province/zone polygons tinted by avisos severity (green/yellow/orange/red) | Spain only | `enabled-only` | Single click, on/off |
| `global-weather` | Same marker style as `aemet-stations`, backed by Open-Meteo instead of a real station network | Everywhere *except* Spain (resolves the Option-1/2 question below) | `enabled-only` | Single click, on/off |
| `satellite-weather` | Translucent NASA GIBS true-color cloud-cover tiles over the current basemap | Global | `enabled+options` | Single click on/off; product choice (v1: true-color only) via the same chip mechanism CCTV/flights/satellites already use |

**Resolving the two open design questions from the first pass**, so this is
buildable rather than still-undecided:

- **Open-Meteo point source → Option 1, world-cities grid, not click-to-query.**
  A toggleable layer fits this app's existing mental model (every other
  source is a panel button, not a special interaction), and reusing
  `aemet-stations`' rendering code is cheap. Points come from Natural Earth's
  "populated places" dataset — already a credited, public-domain source in
  this app (`NATURAL_EARTH_CREDIT`, used today for region boundaries), so
  adding its points layer is a licensing non-event, not a new source to
  vet. Filter to capitals + places above a population threshold (~200–300
  points worldwide keeps Open-Meteo's free-tier call volume trivial even
  polled every 10–15 min) and **exclude anything inside Spain's bounding
  box**, so `aemet-stations` and `global-weather` never show two markers for
  the same city — they tile together into one seamless worldwide set instead
  of overlapping.
- **GIBS v1 product → true-color only.** IR and snow-cover stay real, just
  deferred: the `enabled+options` disposition and `getRowControls` chip
  mechanism are already reserved, so adding a product switcher later is a
  small follow-up, not a registry change.

## How each one turns on/off

Every layer here uses the exact mechanisms every existing layer already
uses — nothing new to build for basic on/off:
- **Toggle panel**: one click, per `_renderToggles()`/`setEnabled()` in
  `src/data/manager.js` — automatic once registered, live entity count shown
  next to the button.
- **Share links / persistence**: each gets one `[a-z0-9]` token in
  `LAYER_STATE_REGISTRY`; enabled-state round-trips through
  `layerState.js`'s existing encode/decode exactly like every other layer.
- **Voice**: per `CONTRIBUTING.md`'s pattern for new layers (and the still-
  open item in `local-usb-sdr.md`'s own plan), each needs a
  `GEV_REALTIME_TOOLS` entry + `src/voice/gevActions.js` handler — "turn on
  Spanish weather stations," "show cloud cover," etc. Not needed for A0 to
  be usable, but expected before the layer is considered done, matching how
  every existing layer is voice-controllable.
- **`satellite-weather` only**: also gets a per-layer options chip (product
  choice) via `getRowControls`, the same row-control mechanism `cctv.js`/
  `flights.js`/`satellites.js` already implement — no new panel plumbing.

## Which ones make sense together

- **`aemet-stations` + `aemet-warnings`**: the intended default pairing —
  warnings explain *why* a cluster of stations reads extreme. Both Spain-
  only, both cheap, no reason to ship one without eventually shipping the
  other.
- **`aemet-stations` + `global-weather`**: designed to combine into one
  continuous worldwide temperature layer — dense/real inside Spain, coarse/
  interpolated everywhere else, non-overlapping by the Spain bounding-box
  exclusion above. This is the pairing worth demoing first.
- **`satellite-weather` + anything**: it's an imagery overlay, not an entity
  layer, so it never competes for toggle state or visual space with the
  other three (or with FIRMS, flights, military, etc.) — Cesium renders
  entities above imagery layers, so warning polygons and station pins stay
  legible on top of it. The natural flagship demo is Esri/Bing basemap +
  `satellite-weather` true-color clouds + `aemet-stations` pins, i.e. "real
  current weather, in 3D, over Spain."
- **Nothing here conflicts with FIRMS** (`local-firms`) — confirmed out of
  scope for GIBS specifically to avoid duplicating it (see above), and nothing
  about these four layers touches fire data.

## AEMET OpenData (new)

Spain-specific, nothing else here covers it: live station observations
(temp/wind/humidity/pressure/precip with real lat/lon), municipal forecasts,
and CAP-format province warning polygons (severity-coded).

### Phase A0 — station layer — **shipped 2026-09-12**

- `AEMET_API_KEY` (free, requested by email at
  `https://opendata.aemet.es/centrodedescargas/altaUsuario`), server-side
  only, same posture as `FIRMS_MAP_KEY`/`TOMTOM_API_KEY` in `.env.example`.
  Registered in the "POWER UP" panel's key registry (`src/keySetupCore.mjs`,
  `id: 'aemet'`, `tier: 'free'`) and documented in `.env.example`.
  Additionally gained a `validityDays: 90` field and an expiry
  countdown/expired badge in the panel (`keySetupKeyExpiry`,
  `KEY_SETUP_EXPIRY_WARNING_DAYS`) — AEMET keys lapse on a fixed cycle with no
  provider-side warning, unlike every other key here, and a save now records
  an issue date (`.gev-cache/key-setup-meta.json`, names+timestamps only, no
  secrets) so the panel can show it. One real bug found and fixed along the
  way: a dev server process already running when the `aemet` registry entry
  was added had memoized its "which keys are external" snapshot BEFORE that
  entry existed, so a pasted AEMET key was misclassified as externally-managed
  (read-only, no replace/remove) until the process restarted — inherent to
  `globalThis.__GEV_PROVIDER_ENV_AT_BOOT`'s per-process memoization, not a
  logic bug, but worth knowing: **adding a new key to the registry needs a
  process restart, not just a page reload, before it's replaceable.**
- **Real API verified live** (with the user's actual key) rather than
  guessed from docs, which corrected several assumptions in this plan's first
  draft:
  - **~850 unique stations, not ~250** — `observacion/convencional/todas`
    returns ~9.8k rows (up to ~12 trailing hourly readings per station), not
    one row per station. Deduplicated to the most recent `fint` per `idema`.
  - **The `datos` response is `ISO-8859-15`, not UTF-8** (confirmed via the
    real `Content-Type` header) — decoding it as UTF-8 silently mangles
    accented station names ("VANDELLÓS" → "VANDELL�S"). The proxy fetches it
    as a Buffer and decodes with Node's built-in `latin1`.
  - Confirmed field names directly: `idema, lon, lat, alt, ubi, fint, ta, hr,
    pres, vv, dv, vmax, prec` (plus a few unused: `dmax, stdvv, stddv, tamin,
    tamax, tpr, pres_nmar`).
  - Confirmed the failure shape: an invalid key returns `{estado: 401,
    descripcion: "JWT strings must contain exactly 2 period characters..."}`
    with no `datos` field — AEMET keys are JWTs.
- Shipped: `src/data/weatherProviderRequests.js` (pure request/normalize,
  10 tests, one real bug caught by the tests before shipping —
  `Number(null) === 0` was silently turning a missing sensor reading into a
  fake zero), `server/providers/weather/aemet.js` + `server/providers/weather.js`
  index (mirrors `firmsProxy` exactly: memory+disk cache, single-flight,
  serve-stale, `.gev-cache/aemet-stations.json`, TTL 20 min), registered in
  `server/providers/local.js`'s `localProviderPlugins()` and covered by a
  behavioral test in `src/tooling/environmentProviders.test.mjs` (asserts the
  encoding fix, the dedup, caching, and stale-on-failure — would have failed
  had the encoding been done as UTF-8).
- `src/data/aemetStations.js`, the frontend layer (7 tests), registered in
  `src/data/layerState.js` as `aemet-stations` (token `h`,
  `REGISTERED_LAYER_IDS` 16→17) and in `src/standalone/data.js` — confirmed
  live in the Browser pane against the real API: 757 fresh stations (after
  the 3-hour staleness filter) rendered as temperature-colored points across
  Spain, toggle on/off both verified to work cleanly with no console errors.
- **Click-to-inspect, color gradient, and globe occlusion — fixed 2026-09-12.**
  Three follow-up issues found via live use, all resolved:
  - **Click-to-inspect**: `entity.description` was inert (this app runs
    Cesium with `infoBox: false`, `src/app/viewer.js:18`). Replaced with this
    app's actual click-to-inspect pattern, copied from `bikeshare.js`: a
    `Cesium.ScreenSpaceEventHandler` picks a station (via
    `pickRegistry.resolvePickId`), hides its base point, adds one enlarged
    highlight point, and publishes a floating in-world card through the
    shared `worldOverlay` host (`variant: 'selected'`) — the same mechanism
    bikeshare's station selection and earthquakes' magnitude labels already
    use. Registers/unregisters pick ownership on enable/disable so other
    layers' click handlers recognize an AEMET pick isn't empty space. A
    refresh (every 5 min) re-resolves an open selection against the fresh
    station data rather than dropping it or pointing at a destroyed entity.
    Verified live: clicking a station shows name, temp, humidity, wind,
    pressure, precipitation, and altitude in a card anchored above it.
  - **Color gradient**: replaced the 6-band stepped palette with a
    continuous linear interpolation across 8 temperature stops
    (`TEMPERATURE_COLOR_STOPS`, -10°C to 40°C) — two nearby temperatures
    (e.g. 24.0°C and 24.4°C) that used to render identically now render
    visibly different colors. Verified live: the scatter across Spain shows
    a smooth cyan→green→yellow→orange gradient rather than a few flat bands.
  - **Globe occlusion**: the real bug was `disableDepthTestDistance:
    Number.POSITIVE_INFINITY` applied to EVERY station point, which
    explicitly disables depth testing — that's what made stations render
    through the far side of the globe. Removed from the per-station points
    (normal depth testing against the globe now correctly occludes them);
    kept ONLY on the one enlarged selection-highlight marker, matching
    `bikeshare.js`'s exact convention (a selected marker staying legible is a
    deliberate one-marker exception, not the default for hundreds of
    points). Verified live: flying the camera to New Zealand (Spain's
    antipode) shows zero stations on screen despite the layer still holding
    766 of them.
  - 7 new tests covering the gradient, selection copy/overlay-entry shape,
    the full select/clear/refresh-persistence flow, pick-ownership
    registration, and a source-text regression pin asserting exactly one
    `disableDepthTestDistance:` usage in the file (so a future edit can't
    silently reintroduce it on the per-station points).
- **Terrain height — two more rounds, fixed 2026-09-12.** The globe-occlusion
  fix above removed `disableDepthTestDistance` but left `heightReference:
  CLAMP_TO_GROUND` in place, which turned out to visibly sink points into
  sloped terrain once real elevation data (not the ellipsoid) loaded and the
  camera got close. First fix: copy `bikeshare.js`'s approach exactly — a
  one-time `viewer.scene.sampleHeight()` per station, baked into a static
  position. This introduced a NEW bug reported from live use: points showed
  at "inexact positions" and drifted as the camera moved. Root cause:
  `sampleHeight` only succeeds against terrain tiles already loaded near
  wherever the camera currently is — fine for bikeshare, which only samples
  for stations near an already-close camera (per-city proximity gating), but
  wrong for ~850 stations spread across all of Spain regardless of camera
  position. Most samples silently failed and fell back to a flat
  ellipsoid height; WHICH stations succeeded vs. fell back changed between
  the 5-minute polls depending on where the camera had been, which is
  exactly what looked like drifting. **Final fix**: `heightReference:
  Cesium.HeightReference.RELATIVE_TO_GROUND` with a fixed 2 m offset,
  applied to both the base points and the selection highlight. This has
  Cesium re-clamp continuously against whatever terrain is actually loaded
  at render time — the same mechanism `CLAMP_TO_GROUND` already uses, just
  with real clearance — so there is no one-time snapshot left to go stale.
  The `_stationPosition`/`sampleHeight` machinery was removed entirely; the
  position is now just `Cartesian3.fromDegrees(lon, lat, 2.0)`, with
  `heightReference` doing all the real work. One test rewritten to pin the
  configuration (`heightReference` on both markers) rather than a fake
  `sampleHeight` snapshot, since there's no snapshot left to fake.
- **AEMET field coverage — completed 2026-09-12.** Reviewed every field the
  raw AEMET record carries against what was shown; added the four gaps: dew
  point (`tpr`), gust direction (`dmax`), sea-level-corrected pressure
  (`pres_nmar`), and trailing-hour min/max temperature plus wind std-dev
  (`tamin`/`tamax`/`stdvv`/`stddv`) — extended into
  `normalizeAemetStationRecord`, the click-to-inspect card, the HTML
  description, and `getAnalystRecords()`. Nothing from the raw feed is
  withheld now.
- **Also deferred, matching every other layer's own bring-up**: voice-tool
  wiring (`GEV_REALTIME_TOOLS` / `src/voice/gevActions.js`).
- Docs updated in this same pass per `CONTRIBUTING.md`:
  `docs/CURRENT-STATE.md`, `DATA_SOURCES.md`, `dataCredits.js`, `CHANGELOG.md`,
  README's layer table (13→14 layers).
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
  (`h` is unused; used tokens today: a b c d e f g i l m n q r s t u w x —
  `l` and `n` claimed by `local-adsb`/`liveuamap` since this plan was
  written, not yet on `main`; confirm the current registry before picking a
  letter, since other branches may have claimed more since).
  `REGISTERED_LAYER_IDS` count assertion in `layerState.test.mjs` bumps
  accordingly.
- Registered in `src/standalone/data.js` (`createStandaloneData`) with
  `DataLayerManager`, same pattern as `local-adsb` — post-refactor, layer
  registration no longer lives in `src/main.js` (see `docs/APPLICATION.md`).
  No manual panel UI needed — the toggle panel builds itself from each
  registered layer's `icon`/`name`.

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
  (e.g. `{ id: 'satellite-weather', token: 'k', disposition:
  'enabled+options', optionOwner: 'satellite-weather' }` — `k` picked over
  the originally-proposed `n`, since `n` was claimed by the `liveuamap`
  layer (branch `mi-main`) after this plan was first written; confirm
  against the current registry before implementing — for the
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

Resolved as part of this pass, see [Layer summary](#layer-summary--whats-actually-shipping):
Open-Meteo's point source (world-cities grid via Natural Earth, Spain
excluded) and GIBS's v1 product (true-color only). Still genuinely open:

- **AEMET avisos zone geometry source**: confirm the current official
  download location/format/license for the warning-zone polygons (separate
  from the live CAP feed) before Phase A1.
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
