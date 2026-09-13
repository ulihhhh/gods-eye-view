# Weather data integrations — design plan

Status (2026-09-12): **Scope narrowed to AEMET-only, by owner direction.**
This plan now tracks one PR: connect **every** AEMET OpenData dataset to a
GEV layer (or record a deliberate, reasoned exception for the handful that
genuinely don't fit). Phase A0 (Weather Stations), Phase A1 (Weather
Warnings), Phase A2 (forecast tooltip), Phase A4 (lightning activity),
Phase A5 (fire risk), Phase A8 (UV index), and Phase A9 (sea-surface
temperature) are **shipped** on `feat/weather-layers` — see
[Phase A0](#phase-a0--station-layer--shipped-2026-09-12),
[Phase A1](#phase-a1--warnings-overlay-avisos--shipped-2026-09-12),
[Phase A2](#phase-a2--forecast-tooltip--shipped-2026-09-12),
[Phase A4](#phase-a4--lightning-activity--shipped-2026-09-12),
[Phase A5](#phase-a5--forest-fire-risk-forecast--shipped-2026-09-12),
[Phase A8](#phase-a8--uv-index--shipped-2026-09-12), and
[Phase A9](#phase-a9--sea-surface-temperature--shipped-2026-09-12). **Phase
A3 (radar) and Phase A6 (maritime forecast) are blocked**, not skipped —
radar on AEMET's own broken cached endpoint, maritime on a genuinely
unresolved zone-geometry source; see their sections below. Phases A7, A10
through A14 (below) are the complete, concrete criteria for the rest of
this PR — nothing in that list is optional to *decide*, though build order
and effort vary. Open-Meteo's map layer and NASA GIBS — this plan's original
other two providers — are **out of this PR's scope** and relegated to
[Deferred — non-AEMET work](#deferred--non-aemet-work-tracked-not-in-this-pr)
at the end: tracked so the earlier design work isn't lost, revisited only
after the AEMET set is complete. This file stays the design record for work
on branch `feat/weather-layers` (branched from `main`, following this
repo's `<type>/<kebab-description>` convention), kept under version control
so the plan stays reviewable alongside the code that implements it. For
verified *runtime* behavior (not plans), see `docs/CURRENT-STATE.md`, which
is authoritative where the two disagree. Docs get folded into
`docs/CURRENT-STATE.md`, `DATA_SOURCES.md`, `CHANGELOG.md`, `README.md` as
each phase ships, per `CONTRIBUTING.md` — already done for Phase A0 and A1.

## Goal

Every dataset AEMET OpenData exposes becomes reachable from GEV as its own
toggleable layer — stations, warnings, radar, lightning, fire risk,
maritime and beach forecasts, UV index, sea-surface temperature, and the
smaller specialty networks — so that "what does AEMET know" and "what can
GEV show" become the same question. A small number of datasets genuinely
aren't layer-shaped (raw model grids, historical climatology, static
analysis charts); those get a stated reason for exclusion rather than being
silently dropped. Non-AEMET work (a global Open-Meteo fallback layer, a
NASA GIBS cloud-imagery overlay) is real and still wanted eventually, but is
explicitly **not** part of connecting AEMET's own catalog, so it moves to
the end of this document rather than competing for attention here.

## Architecture principles for new AEMET layers

Set once, applies to every phase below, so it doesn't need repeating per
phase:

- **Stack, don't couple.** Every new AEMET layer is its own
  `LAYER_STATE_REGISTRY` entry, its own `DataLayerManager` registration, and
  — for imagery-shaped ones — its own `Cesium.ImageryLayer` instance. None
  of them may reach into another layer's module to render (an
  `aemet-sea-surface-temp` overlay must work identically whether
  `ais-live-vessels` is on, off, or doesn't exist). The concrete test: a
  user enables `ais-live-vessels` and `aemet-sea-surface-temp` together,
  sees both, and can turn either off independently without the other
  reacting. This is *stacking* (independent, simultaneous, layered), not
  *building onto* (one layer's code depending on another's).
- **One `LAYER_STATE_REGISTRY` entry per dataset, for now.** Every phase
  below gets its own token and its own toggle-panel row, even where two
  datasets are related (radar and lightning are both "storm weather" but
  are still two separate toggles). This matches how `aemet-stations` and
  `aemet-warnings` already ship as two independent layers rather than one
  combined one.
- **Chip-based grouping is a later refinement, only where grouping
  genuinely makes sense** — the same `getRowControls` per-layer-options
  mechanism `cctv.js`/`flights.js`/`satellites.js` already use, generalized
  from "which product" to "which sub-network" or "which time horizon."
  Candidates identified so far, **not built now**, listed here so the
  decision isn't lost:
  - `redes-especiales` (ozone / background pollution / solar radiation,
    [Phase A10](#phase-a10--environmental-networks-ozone-pollution-radiation))
    is the one exception where grouping from day one is proposed, not
    deferred — see A10 for why.
  - `red-radares` national vs. regional composite — plausibly one
    `aemet-radar` layer with a coverage-area chip instead of two toggles,
    revisit once A3 ships and the real tile behavior is known.
  - `indices-incendios` estimado (today) vs. previsto (forecast day) — a
    time-horizon chip inside `aemet-fire-risk` rather than two layers.
  - Everything else (`aemet-radar` vs `aemet-lightning` vs `aemet-maritime`
    vs `aemet-beaches` vs `aemet-uv-index` vs `aemet-sea-surface-temp` vs
    `aemet-stations` vs `aemet-warnings`) differs enough in subject matter
    that a user should be able to toggle each on/off independently — these
    stay separate layers, not future chip candidates.

## What's already there (don't re-build this)

- **NASA FIRMS is already a full live layer** — `server/providers/firms.js`
  (memory + disk cache, `FIRMS_MAP_KEY`), `src/data/firmsCsv.js`,
  `firmsHeatmap.js`, `firmsLabels.js`, `firmsAdapt.js`, registered in
  `layerState.js` as `local-firms` (token `w`). AEMET's own fire-risk
  *forecast* ([Phase A5](#phase-a5--forest-fire-risk-forecast--shipped-2026-09-12)) is a
  different signal (predictive index vs. satellite-detected fire) and does
  **not** duplicate this — see A5 for the distinction to keep clear in UI
  copy.
- **Open-Meteo is already integrated, twice, but narrowly**, and
  **"satellite imagery" in GEV means basemap orthophotography**, not live
  atmospheric imagery — both still true, both now only relevant to the
  [Deferred](#deferred--non-aemet-work-tracked-not-in-this-pr) section
  since neither is AEMET.
- **No existing layer stacks a second raster imagery layer — yet.** Every
  current "layer" in `layerState.js`'s `LAYER_STATE_REGISTRY` is Cesium
  entities (points/polylines/labels/polygons). `mapStackController.js` owns
  exactly **one** exclusive base `Cesium.ImageryLayer` (swapped, never
  stacked). Several AEMET phases below (`aemet-radar`, `aemet-fire-risk`,
  `aemet-uv-index`, `aemet-sea-surface-temp`) are the **first** translucent
  overlay imagery layers in this app, stacked *above* the base map — a new
  capability this PR introduces, not a variation on an existing one. Cesium
  supports multiple simultaneously stacked imagery layers natively; this
  app just hasn't needed more than the one base layer before now.

## AEMET layer table — what's shipping and what's next

Every row below is (or will be) `dataManager.register(...)` + one
`LAYER_STATE_REGISTRY` entry — no manual panel UI needed, per
`_renderToggles()` in `src/data/manager.js` (registration site:
`src/standalone/data.js`, confirmed post-refactor). Tokens are tentative —
confirm the live registry immediately before implementing each phase, since
other branches can claim letters in the meantime (this has already happened
twice — see A0's own note below).

| Layer | Shows | Shape | Phase | Token | Status |
|---|---|---|---|---|---|
| `aemet-stations` | Live station pins, temperature-gradient color, full reading on click | points | A0 | `h` | **shipped** |
| `aemet-warnings` | Zone polygons tinted by avisos level, phenomena on click | polygons | A1 | `j` | **shipped** |
| `aemet-forecast` | Next-hours forecast on an existing station/municipio click | click-to-query, no new entities | A2 | *(none — extends A0's click, no new registry row)* | **shipped** |
| `aemet-radar` | National/regional precipitation radar composite | imagery overlay | A3 | `o` | **blocked** — AEMET's own endpoint is currently returning a broken cached link, see phase notes |
| `aemet-lightning` | Nationwide lightning-composite snapshot (ambient thumbnail, not entities) | pre-rendered image, no coordinates | A4 | `p` | **shipped** |
| `aemet-fire-risk` | Meteorological forest-fire risk forecast (ambient click-to-expand thumbnail) | pre-rendered image, no coordinates | A5 | `v` | **shipped** |
| `aemet-maritime` | High-seas + coastal forecast zones | zone polygons + click text | A6 | `k` | **blocked** — endpoint confirmed live, but no geometry source found for its ~30 subzones |
| `aemet-beaches` | Per-beach forecast (UV, sea temp, waves, wind) | points | A7 | `z` | not started |
| `aemet-uv-index` | UV index per provincial-capital city (real points) | points, joined to `maestro/municipios` | A8 | `0` | **shipped** |
| `aemet-sea-surface-temp` | Sea-surface temperature (ambient click-to-expand thumbnail) | pre-rendered image, no coordinates | A9 | `y` | **shipped** — took `y` (this table's original tentative token, `1`, was left unused; `aemet-maritime`'s own tentative token reassigned to `k` here since it's still unimplemented) |
| `aemet-environmental` | Ozone / background pollution / solar radiation, chip-selected | points, with a network-type chip | A10 | `1` | not started |
| *(folds into `aemet-stations`)* | Spain's two Antarctic bases | points | A11 | *(none — extends A0)* | not started |
| `aemet-regional-forecast` | CCAA/provincia forecast text on region click | zone polygons (Natural Earth boundaries) + text | A12 | `3` | not started |

## How each one turns on/off

Every layer here uses the exact mechanisms every existing layer already
uses — nothing new to build for basic on/off:
- **Toggle panel**: one click, per `_renderToggles()`/`setEnabled()` in
  `src/data/manager.js` — automatic once registered, live entity count shown
  next to the button.
- **Share links / persistence**: each gets one `[a-z0-9]` token in
  `LAYER_STATE_REGISTRY`; enabled-state round-trips through
  `layerState.js`'s existing encode/decode exactly like every other layer.
- **Voice**: per `CONTRIBUTING.md`'s pattern for new layers, each eventually
  needs a `GEV_REALTIME_TOOLS` entry + `src/voice/gevActions.js` handler.
  Deliberately **not** part of any individual phase's done-criteria here —
  see [Phase A14](#phase-a14--voice-tool-wiring-for-the-whole-aemet-set), a
  single batched pass across every AEMET layer once A0–A12 exist, instead of
  wiring the same pattern piecemeal ten separate times.
- **`aemet-environmental` only**: gets a per-layer options chip (network
  choice: ozone / pollution / radiation) via `getRowControls`, the same
  mechanism `cctv.js`/`flights.js`/`satellites.js` already implement.

## Which layers pair well (stacking demos)

- **`aemet-stations` + `aemet-warnings`**: the existing default pairing —
  warnings explain *why* a cluster of stations reads extreme.
- **`aemet-radar` + `aemet-lightning` + `aemet-warnings`**: the "storm cell"
  demo — reflectivity, strikes, and the `TO` (tormentas) warning polygon
  all visible together. Motivates building A4 right after A3.
- **`aemet-sea-surface-temp` + `aemet-maritime` + `ais-live-vessels`**: the
  "everything about the water" demo — ship traffic, sea-state/wind
  warnings, and sea temperature for the water those ships are actually in.
  A9 shipped ahead of A6 (still blocked on zone geometry); the pairing
  completes once A6 unblocks.
- **`aemet-fire-risk` + `local-firms`**: deliberately shown as *distinct*
  layers with distinct legends (risk-level palette vs. detection markers) —
  a demo of "here's where risk is elevated" next to "here's what's actually
  burning," not a merge of the two.
- Every pairing above is two or three independently-toggleable layers, per
  the stacking principle above — none of them share rendering code or
  depend on each other being enabled.

## AEMET OpenData — phases

Spain-specific, nothing else covers it. Confirmed against AEMET's own
OpenAPI spec (`https://opendata.aemet.es/opendata/documentation/v2/api-docs?group=AEMET_API`,
151 endpoints across 19 tag groups, pulled live against the real key — not
guessed from marketing pages).

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
- **Voice tools**: deferred to [Phase A14](#phase-a14--voice-tool-wiring-for-the-whole-aemet-set)'s
  batched pass, matching every other layer's own bring-up.
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

### Phase A1 — warnings overlay (avisos) — **shipped 2026-09-12**

Fetched the real endpoint end-to-end with the live key (`node` one-off
scripts, not guessed from docs) specifically to close the one open question
Phase A0 left behind — "where does the zone geometry come from" — and it
turned up a bigger, better answer than assumed: **there is no separate zone
shapefile to source at all.** Every open question this phase used to carry
was resolved before implementation started (below), then implemented and
verified live:

- Shipped: `parseAemetCapTar`/`parseAemetCapAlert`/
  `normalizeAemetWarningsSnapshot`/`filterActiveAemetWarnings`/
  `AEMET_WARNING_LEVEL_RANK` in `src/data/weatherProviderRequests.js` (23
  new tests — a hand-rolled tar reader tested against a built fixture
  archive, CAP XML parsing tested against a real captured Lanzarote alert
  plus synthetic verde/multi-phenomenon fixtures), `aemetWarningsProxy()` in
  `server/providers/weather/aemet.js` (behavioral test in
  `environmentProviders.test.mjs` asserts the UTF-8 decode, verde
  suppression, and stale-on-failure), and `src/data/aemetWarnings.js` (the
  frontend layer, 13 tests) registered as `aemet-warnings` (token `j`,
  `REGISTERED_LAYER_IDS` 17→18) in `layerState.js` and
  `src/standalone/data.js`.
- **Verified live against the real API**: 9 active zones on a normal day
  (all amarillo — naranja/rojo still unobserved live, as flagged below),
  correct UTF-8 decoding ("Almería" rendered correctly), a real multi-ring
  zone (Grazalema-style) highlighting both rings on select, and — the
  specific open question flagged for this phase — **polygon ground-draping
  works correctly with no explicit height/heightReference at all**: verified
  visually over real hill terrain near Cádiz with no z-fighting or clipping,
  unlike points' `CLAMP_TO_GROUND` history in Phase A0. Click-to-inspect,
  multi-phenomenon cards, and clean enable/disable all verified with no
  console errors.
- Still deferred, not blocking: voice-tool wiring (now formally
  [Phase A14](#phase-a14--voice-tool-wiring-for-the-whole-aemet-set)), the
  in-effect-vs-upcoming visual distinction (data already carries `inEffect`
  per phenomenon, just not yet styled differently), and confirming
  naranja/rojo rendering against a real one when a real one occurs.
- **Worth a look, not scheduled**: the catalog has a plain `avisos` tag
  distinct from `avisos-cap` — `/api/avisos/vectorial/ultimoelaborado`
  ("AVISOS georreferenciado"). This might be a pre-georeferenced
  (GeoJSON-like) alternative to the tar/CAP-XML pipeline this phase already
  parses by hand. Not urgent (A1 works and is tested), but worth one live
  pull to see if it could *replace* the tar reader with something simpler,
  or if it's a different/older product. Flagged here so it isn't lost.

#### The real API shape

- `GET https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/esp?api_key=...`
  — same two-step envelope as stations (`{descripcion, estado, datos,
  metadatos}`). `area/esp` is nationwide; AEMET also accepts a CCAA code
  there, not needed for a Spain-wide layer.
- The `datos` URL, THIS time, is not JSON — it's a **plain (not gzipped,
  despite the `.tar.gz` filename — confirmed via magic bytes) POSIX tar
  archive**, `Content-Type: application/x-gtar`, ~3.2 MB, containing ~190
  individual CAP 1.2 XML files, one per (phenomenon × level × zone-group)
  bulletin AEMET currently has elaborated.
- **Encoding gotcha, opposite direction from stations**: the tar's outer
  `Content-Type` header claims `charset=ISO-8859-15` (copy-pasted from the
  same server code as the stations endpoint, evidently) but the individual
  XML files inside are **genuinely UTF-8** (confirmed by decoding real bytes
  both ways — UTF-8 gives correct "Meteorología", latin1 mangles it into
  "MeteorologÃ­a", the reverse of the stations bug). **Do not reuse the
  stations proxy's latin1 decode here** — decode each extracted XML file as
  UTF-8, trust the files' own `<?xml ... encoding="UTF-8"?>` declaration, not
  the tar's HTTP header.
- **Each CAP XML carries its warning geometry inline** — a real example,
  trimmed:
  ```xml
  <info>
    <language>es-ES</language>
    <event>Aviso de temperaturas máximas de nivel amarillo</event>
    <severity>Moderate</severity>
    <urgency>Future</urgency> <certainty>Likely</certainty>
    <eventCode><valueName>AEMET-Meteoalerta fenomeno</valueName><value>AT;Temperaturas máximas</value></eventCode>
    <onset>2026-09-14T11:00:00+01:00</onset>
    <expires>2026-09-14T18:59:59+01:00</expires>
    <headline>Aviso de temperaturas máximas de nivel amarillo. Lanzarote</headline>
    <description>Temperatura máxima: 34 ºC. Afectando principalmente en zonas de interior.</description>
    <instruction>Esté atento. Manténgase informado...</instruction>
    <parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>amarillo</value></parameter>
    <parameter><valueName>AEMET-Meteoalerta probabilidad</valueName><value>40%-70%</value></parameter>
    <area>
      <areaDesc>Lanzarote</areaDesc>
      <polygon>28.85,-13.87 28.89,-13.88 ... 28.85,-13.87</polygon>
      <polygon>29.22,-13.53 29.27,-13.52 ... 29.22,-13.53</polygon>
      <geocode><valueName>AEMET-Meteoalerta zona</valueName><value>659101</value></geocode>
    </area>
  </info>
  <info><language>en-GB</language>...</info>  <!-- same alert, English, always paired -->
  ```
  This IS the render-ready shape: `<polygon>` is `lat,lon lat,lon ...`
  space/comma-delimited, ready for `Cesium.Cartesian3.fromDegrees` after a
  lat/lon swap. **AEMET always ships both `es-ES` and `en-GB` `<info>`
  blocks per alert** — use `es-ES` for consistency with station names
  (`ubi`) already being Spanish, matching Phase A0.
- One XML file's `<info>` can list **many `<area>` blocks** (a "verde"
  bulletin often bundles most/all ~233 zones nationwide into one file, since
  most of the country has no active phenomenon most of the time), and one
  `<area>` can have **multiple `<polygon>` rings** for a non-contiguous zone
  (e.g. Lanzarote + La Graciosa as two separate rings under one geocode).
  Confirmed one level per file (no file mixes "verde" and "amarillo"
  `<info>` blocks) — the level lives in each `<info>`'s `AEMET-Meteoalerta
  nivel` parameter, not something to infer per-area.
- Confirmed vocabulary from a live pull: 4-level scale
  `verde/amarillo/naranja/rojo` (only verde/amarillo were active at pull
  time — naranja/rojo unverified live but are AEMET's documented top two
  tiers, mapping to CAP `severity` Severe/Extreme the same way
  verde→Minor and amarillo→Moderate were confirmed live). 13 phenomenon
  codes seen: `AT` temperaturas máximas, `BT` temperaturas mínimas, `PR`
  lluvias, `TO` tormentas, `VI` vientos, `NE` nevadas, `NI` nieblas, `CO`
  costeros, `GA` galernas, `RI` rissagas, `DH` deshielos, `AL` aludes, `VS`
  polvo en suspensión.
- Confirmed 233 unique zone geocodes nationwide (6-digit AEMET-internal
  codes, e.g. `610401`, `659101` — opaque identifiers, no lookup table
  needed since each alert already carries the zone's `areaDesc` name and
  polygon directly).
- **Verde is the "nothing to see here" baseline, not an alert** — AEMET
  bundles a verde bulletin for essentially the whole country per phenomenon
  as a matter of course. Rendering verde zones as polygons would paint most
  of Spain green at all times for no signal, unlike AEMET's own public
  meteoalerta map (which shows only elevated zones). **Only render
  amarillo/naranja/rojo** — verde entries are parsed (so a zone's status is
  known) but never produce a map polygon.
- `onset`/`expires` mean real things: some warnings are already in effect
  (`onset` in the past relative to `sent`), others are advance notice for
  later the same day or the next (`onset` hours or a day out). v1 renders
  anything with `expires > now` as a solid polygon regardless of `onset`
  (simplest correct behavior — AEMET wouldn't be publishing it if it weren't
  worth knowing about); a later refinement can visually distinguish
  "in effect now" (`onset <= now`) from "starts later" (`onset > now`) via
  outline style once the base layer is proven, without any data-model change
  since both timestamps are already carried per phenomenon.

#### Data model and parsing

- `server/providers/weather/aemet.js` gains a sibling parser (or a new
  `server/providers/weather/aemetWarningsTar.js`, mirroring how
  `weatherProviderRequests.js` splits pure mechanics from the stations
  proxy): a **minimal hand-rolled POSIX tar reader** — no new dependency.
  The format is simple and fixed (512-byte header blocks; filename at offset
  0/length 100; octal file-size at offset 124/length 12; data follows,
  padded to the next 512-byte boundary; archive ends at two zero blocks) and
  entirely AEMET-controlled, the same reasoning this codebase already uses
  for hand-rolling `parseFirmsCsv`/`parseDotenvText` instead of pulling in a
  library for a small, fixed, trusted format.
- CAP XML parsing: also hand-rolled via targeted regex/string extraction
  (`<tag>...</tag>` per known field), not a general XML/DOM parser — the
  schema is fixed and AEMET-controlled (not arbitrary untrusted XML), the
  same "don't reach for a library to parse a shape you fully control"
  reasoning as the tar reader. Pull per `<info language="es-ES">` block:
  `event`, `severity`, `onset`, `expires`, `headline`, `description`,
  `instruction`, the `nivel`/`probabilidad`/`fenomeno` `<parameter>`/
  `<eventCode>` values, and every `<area>`'s `areaDesc`, one-or-more
  `<polygon>`, and `<geocode>` zone id.
- New pure functions in `src/data/weatherProviderRequests.js` (extending
  the existing module, same portable/no-Node-imports contract — tar/XML
  extraction happens server-side in the proxy and hands these functions
  already-decoded UTF-8 strings, not Buffers):
  - `parseAemetCapAlert(xmlString)` → one alert's structured fields (mirrors
    `normalizeAemetStationRecord`'s "one raw thing in, one clean record out"
    shape).
  - `normalizeAemetWarningsSnapshot(alerts)` → aggregate by zone geocode,
    keeping every non-verde phenomenon active at that zone and the zone's
    highest active level (`AEMET_WARNING_LEVEL_RANK = {verde: 0, amarillo:
    1, naranja: 2, rojo: 3}`, same stepped-rank pattern this codebase
    already uses for severity elsewhere), analogous to how
    `normalizeAemetStationsSnapshot` dedups trailing hourly rows down to one
    row per station.
  - `filterActiveAemetWarnings(zones, now)` → drop phenomena with
    `expires <= now` and zones left with no non-verde phenomenon — the
    Phase-A0-equivalent of `filterFreshAemetStations`, re-applied at serve
    time so a cached response still reflects "current" against the caller's
    clock.
- Proxy (`aemetWarningsProxy()` in `server/providers/weather/aemet.js` or
  its own file, registered the same way in `server/providers/weather.js` +
  `local.js`): memory + disk cache
  (`.gev-cache/aemet-warnings.json`), single-flight, serve-stale-on-failure
  — same shape as `aemetStationsProxy`. TTL: **10–15 min**, shorter than
  stations' 20 min since warnings can escalate, still trivial against
  AEMET's ~50 req/min cap (2 requests per refresh — envelope + tar — a few
  times an hour). No new rate-limit risk; the "AEMET rate-limit headroom"
  open question from the first pass is resolved by these concrete numbers.
  Routes: `GET /api/aemet/warnings` (zones with an active non-verde
  phenomenon) and `GET /api/aemet/warnings/status` (mirrors the stations
  proxy's `{hasKey, lastFetch, count, stale, ttlMs}` shape). Keyless → 503
  `{error: 'no_key'}`, same convention.
- Response shape to the browser: `{fetchedAt, stale, ttlMs, count, zones:
  [{geocode, name, level, levelRank, polygons: [[[lat, lon], ...], ...],
  phenomena: [{code, name, event, description, instruction, probability,
  onsetMs, expiresMs, inEffect}]}]}` — one entry per zone with at least one
  active non-verde phenomenon, `polygons` as an array of rings (plural,
  for multi-part zones like Lanzarote/Grazalema), `phenomena` as the full
  list so a zone with, say, both an active wind AND coastal warning shows
  both in its detail card, not just whichever is currently ranked highest.

#### Frontend layer

- `src/data/aemetWarnings.js`, following `aemetStations.js`'s now-proven
  shape closely (same `init/enable/disable/update/destroy/getStats`
  contract, same click-to-inspect pattern): one `Cesium.Entity` per polygon
  RING (not per zone, so a multi-ring zone like Lanzarote renders as two
  independent polygon entities sharing the same zone geocode as their pick-
  id prefix — `aemet-warning:<geocode>`), `polygon` graphics
  (`heightReference` doesn't apply to polygons the way it does points;
  `perPositionHeight: false` + `classificationType: TERRAIN` or a small
  ground-clamped material is the polygon-equivalent of "don't z-fight with
  terrain," worth confirming against Cesium's current polygon-draping
  behavior during implementation rather than assumed here), color/opacity by
  `levelRank` (amarillo/naranja/rojo — a 3-step palette, not a gradient;
  unlike temperature there's no "in-between" a discrete alert level).
- Click-to-inspect reuses the exact `ScreenSpaceEventHandler` +
  `pickRegistry.registerPickOwner('aemet-warnings', ...)` +
  `worldOverlay` `variant: 'selected'` card pattern `aemetStations.js`
  already implements — card title = zone name, details = one line per
  active phenomenon (event name, level, validity window), matching how the
  station card packs multiple readings into compact lines.
- `layerState.js`: `{ id: 'aemet-warnings', token: 'j', disposition:
  'enabled-only' }` — `j` confirmed still free against the current registry
  (`a b c d e f g h i m q r s t u w x` in use as of this pass).
  `REGISTERED_LAYER_IDS` count assertion in `layerState.test.mjs` bumps
  17→18. Registered in `src/standalone/data.js` alongside
  `aemetStationsLayer`, same import-and-register pattern.

#### Testing strategy

- Pure functions (`parseAemetCapAlert`, `normalizeAemetWarningsSnapshot`,
  `filterActiveAemetWarnings`) unit-tested against real trimmed CAP XML
  fixtures captured from this research pass (the Lanzarote example above,
  plus a multi-area verde bulletin and a multi-polygon zone), the same
  "real fixture, not synthetic" discipline that caught the stations
  encoding bug before it shipped.
- Tar reader tested against a small hand-built fixture archive (a couple of
  entries, verifying filename/size/padding handling) rather than shipping
  the real 3.2 MB pull as a test fixture.
- Proxy behavioral test in `src/tooling/environmentProviders.test.mjs`,
  mirroring the AEMET-stations test already there: mocks the envelope +
  tar fetch, asserts UTF-8 decoding (a fixture with an accented name would
  catch a latin1 regression the same way the stations test does for the
  opposite encoding), verde suppression, multi-polygon zones, and
  stale-on-failure.
- Frontend layer test mirroring `aemetStations.test.mjs`: select/clear,
  pick-ownership, multi-ring-zone click resolving to one card, and a
  regression pin if depth-testing/height quirks analogous to Phase A0's
  turn up during implementation (don't assume none will).

### Definition of done (applies to every phase A2 and later)

Established by A0/A1 and now the fixed template so "done" means the same
thing for every remaining phase — nothing ships half-way through this list:

1. **Live-verify the real response first**, same discipline both shipped
   phases followed — every "shape TBD" note in the table above gets
   resolved by an actual pull with the real key before any code is written,
   not guessed from the endpoint's one-line summary.
2. **Pure normalize function(s)** in `src/data/weatherProviderRequests.js`
   (or a sibling module for anything genuinely not portable, e.g. an image-
   decoding step), unit-tested against real captured fixtures, not
   synthetic-only ones — the stations-encoding and warnings-tar bugs were
   both caught this way.
3. **Server proxy** in `server/providers/weather/aemet.js` (or a same-
   pattern sibling file), mirroring `aemetStationsProxy`/`aemetWarningsProxy`
   exactly: memory + disk cache under `.gev-cache/`, single-flight
   `inflight`, serve-stale-on-failure, a TTL sized to the dataset's real
   update cadence, `GET /api/aemet/<name>` + `/status` routes, keyless →
   503 `{error: 'no_key'}`. Covered by a behavioral test in
   `src/tooling/environmentProviders.test.mjs`.
4. **Frontend layer** implementing `init/enable/disable/update/destroy/
   getStats` (+ `getAnalystRecords` where it makes sense), following
   `aemetStations.js`/`aemetWarnings.js`'s proven shape — click-to-inspect
   via the shared `ScreenSpaceEventHandler` + `pickRegistry` +
   `worldOverlay` pattern for entity layers; a small opacity-slider
   controller (sibling to, not shared with, the others) for imagery layers.
5. **Own `LAYER_STATE_REGISTRY` entry**, confirmed-free token, count
   assertion bump in `layerState.test.mjs`, registered in
   `src/standalone/data.js`.
6. **Live-verified in the Browser pane** against the real API: entity/tile
   count, correct rendering (color, draping, occlusion — don't assume
   Phase A0's terrain-height and depth-testing lessons don't apply to a new
   shape; check), click-to-inspect (if applicable), clean toggle on/off with
   no console errors.
7. **Docs updated in the same PR**: `docs/CURRENT-STATE.md`,
   `CHANGELOG.md`, README's layer table. `DATA_SOURCES.md`/`dataCredits.js`
   need **no new entry** — the existing AEMET entry already covers the whole
   connection; extend its "used for" description instead.
8. **Voice-tool wiring is explicitly NOT required per-phase** — deferred by
   design to [Phase A14](#phase-a14--voice-tool-wiring-for-the-whole-aemet-set),
   a single batched pass once A0–A12 exist, rather than repeating the same
   `GEV_REALTIME_TOOLS` wiring pattern piecemeal across many separate PRs.

### Phase A2 — forecast tooltip — **shipped 2026-09-12**

Click a station to show AEMET's "next hours" forecast, appended to the
already-open card once it arrives. No new `LAYER_STATE_REGISTRY` entry —
extends A0's existing click-to-inspect card, per the original design.

- **Live-verified before building**, per this phase's own point 1 of the
  Definition of Done: `maestro/municipios` (~8,100 rows) DOES carry lat/lon
  (`latitud_dec`/`longitud_dec`), so a station click resolves to its nearest
  municipio server-side rather than needing a separate geometry source —
  confirmed live, not assumed. Also confirmed live: the record's `id` field
  (e.g. `"id28079"`) — not its separate `id_old` field, a different legacy
  code — is the value `prediccion/especifica/municipio/horaria/{municipio}`
  actually wants.
- Went with **horaria** (hourly), not **diaria** (daily) — the plan's own
  "next-hours" framing matches hourly granularity, and a live pull confirmed
  `horaria` returns ~today-plus-2-days of per-hour data.
- **Timezone gotcha found and handled**: AEMET's hourly timestamps are naive
  Europe/Madrid civil time with no UTC offset anywhere in the response
  (unlike the CAP warnings feed, which does carry one) — running them
  through `Date.parse` would let the SERVER's own timezone decide what
  "upcoming" means, a wrong-timezone bug invisible in a same-timezone dev
  test but wrong for a real deployment. `madridCivilNow()`
  (`src/data/weatherProviderRequests.js`, via `Intl.DateTimeFormat`) reads
  Madrid's actual civil time regardless of the server process's own
  timezone; tested against both CEST and CET to confirm the DST transition
  itself is handled correctly, not just one arbitrary date.
- **Parsing gotcha found and handled**: one hour's data is split across four
  separately `periodo`-keyed arrays that have to be joined by hour, and
  `vientoAndRachaMax` additionally interleaves two different entry shapes
  at the same `periodo` (a wind entry with `direccion`, a gust entry
  without) — confirmed live; only the wind-shaped entries are used for v1,
  gust deferred rather than guessed at.
- Shipped: `normalizeAemetMunicipioRecord`/`normalizeAemetMunicipiosSnapshot`/
  `findNearestAemetMunicipio`/`normalizeAemetHourlyForecast`/
  `madridCivilNow`/`filterUpcomingAemetForecastHours` in
  `src/data/weatherProviderRequests.js` (14 new tests, real-shaped fixtures);
  `aemetForecastProxy()` in `server/providers/weather/aemet.js` — the one
  proxy in this whole plan that's query-driven rather than a polled
  snapshot: an in-memory-only 24h-TTL municipio table (no disk cache — a
  rarely-changing lookup table has no "serve yesterday's snapshot" story
  worth building) plus a 45-minute-TTL, 300-entry-capped per-municipio
  forecast cache, single-flight per municipio id (1 new behavioral test in
  `environmentProviders.test.mjs`); `aemetStations.js` extended with a
  selection-generation token so a slow forecast for a station the user has
  since deselected is dropped, never misapplied to a newer card (6 new
  tests, including a live-simulated race between two selections).
- **Verified live against the real API**: clicking real stations near
  Madrid showed correct "Next hours" lines (e.g. `17:00 33°C · 18:00 32°C`
  for Arganda del Rey); a forecast request that hit AEMET's rate limit
  during testing returned a clean `502` from the proxy without disturbing
  an already-open card for a different, cached station — confirming the
  "never blocks or corrupts the existing card" design held under a real
  failure, not just a simulated one.
- Voice-tool wiring deferred to [Phase A14](#phase-a14--voice-tool-wiring-for-the-whole-aemet-set), same as every other phase.

### Phase A3 — weather radar composite — **blocked, live-verification incomplete (2026-09-12)**

- **Endpoints**: `red/radar/raster/nacional`, `red/radar/raster/regional`
  (both confirmed georeferenced — "georreferenciado" in their own API
  summaries), plus a plain (non-georeferenced) `red/radar/nacional` PNG.
- **Shape**: imagery overlay — the first AEMET-side stacked
  `Cesium.ImageryLayer`, same underlying mechanism as the (deferred) GIBS
  design, built and owned independently per the stacking principle above.
- **Cadence**: ~10 min refresh per AEMET's own radar update rate — much
  faster than the deferred GIBS layer's 3–6 h, worth a "last updated Xm ago"
  indicator since users will expect radar currency.
- **Blocked on step 1 of the Definition of Done** (live-verify before
  design): a real pull against `raster/nacional` and `raster/regional`
  returns a successful envelope (`estado: 200`) each time, but resolving the
  `datos` short-link (`opendata.aemet.es/opendata/sh/<hash>`) consistently
  fails with a `429`-wrapped-`500` from AEMET's internal redirector. This is
  NOT ordinary per-key rate limiting: across 7 attempts spread over 15+
  minutes with generous spacing, `raster/nacional`'s envelope kept returning
  the exact same `datos`/`metadatos` hash — AEMET is serving a stale cached
  envelope pointing at a broken short-link, not regenerating a fresh one.
  The plain (non-georeferenced) `red/radar/nacional` composite fails even
  earlier, at the envelope step itself (`estado: 404`, "Error al obtener los
  datos"). Read as a genuine, current AEMET-side issue with radar delivery
  specifically — separate from the well-behaved stations/warnings/forecast
  endpoints already shipped — not something more retries will fix.
- **What's confirmed despite the block**: an official AEMET conference
  deck (`Foro de Usuarios — Datos georreferenciados`, 2022, Ángel Silva
  López) describes AEMET's internal radar georeferencing pipeline as
  converting the native OPERA composite (HDF5) and regional radars (IRIS)
  to **GeoTIFF/NetCDF** for georeferenced delivery — a real signal for what
  `raster/nacional`/`raster/regional` likely serve, but NOT a confirmed
  byte-for-byte answer for the public OpenData API specifically (that deck
  describes an exclusive WMS built for ENAIRE, a related but different
  delivery path). GeoTIFF would need a client-side decoding step Cesium
  doesn't handle natively, unlike a plain PNG — a real design fork that
  can't be resolved without an actual successful pull.
- **Owner decision (2026-09-12)**: rather than keep retrying or guess at a
  design against an admittedly-broken resource, work moved to
  [Phase A4](#phase-a4--lightning-activity--shipped-2026-09-12) instead. Revisit this phase once
  a live pull against `raster/nacional` or `raster/regional` actually
  succeeds — do not build the frontend/proxy from the GeoTIFF hypothesis
  above without that confirmation.
- **Corroborating research, same day**: a live pull hours later returned the
  **exact same broken short-link hashes** as the original block — not a
  transient rate limit, something is genuinely stuck server-side.
  Independently, radarspain.es (a commercial Spanish radar/lightning
  viewer) attributes its own rich radar mosaic to **"Radares españoles AEMET
  vía EUMETNET"** — the real per-site ODIM-HDF5 volumes it decodes
  client-side come from the **EUMETNET OPERA** radar-exchange network, not
  AEMET's public OpenData REST API — and its own frame metadata explicitly
  labels a `"Fuente de contingencia AEMET Legacy GIF"` fallback for radars
  it can't reach via EUMETNET, i.e. the exact `red/radar/raster/*` family
  this phase targets; several of those fallback entries carried an
  identical, suspiciously-small byte count at the time of this check —
  external corroboration that this specific AEMET delivery path is
  degraded right now, not something wrong with our own key or request
  pattern. AEMET's official API client repo
  (`gitlab.aemet.es/opendata/API`) separately confirms 429s are a known,
  common issue AEMET's own docs recommend mitigating via RSS/Atom feeds —
  radar has no such feed (confirmed by searching AEMET's own RSS/Atom
  directory), so that mitigation doesn't apply here.
- **Real alternative worth its own future investigation, not started**:
  EUMETNET's OPERA composite is apparently available under a CC BY 4.0
  license per radarspain.es's own credit line — potentially a much richer
  radar source (real per-site reflectivity volumes, not one flattened GIF)
  than anything AEMET's public OpenData API exposes, via a completely
  different host/access mechanism this pass didn't research. Noted here so
  it isn't lost; would need its own live-verification pass before any
  design commitment, same discipline as everything else in this plan.

### Phase A4 — lightning activity — **shipped 2026-09-12**

Built after A3 was blocked (see above) — not the original "verify radar and
lightning together against a real storm" build order, since radar's own
endpoint turned out to be unavailable. Revisit the storm-cell stacking demo
once A3 unblocks.

- **Endpoint confirmed live**: `red/rayos/mapa` ("Mapa con los rayos
  registrados en el período de 12 horas anteriores") returns a real
  `image/gif`, 640×480 — AEMET's own province-outline map with strikes
  plotted on it and a legend strip baked into the pixels. **Not** a strike-
  point list, and **not** georeferenced anywhere in the API response (no
  bounding box in the envelope or the `metadatos` description).
  Periodicity confirmed: "cada seis horas o 00Z, 06Z, 12Z, 18Z."
- **Shape resolved differently than either option this plan originally
  considered**: since it can't be draped as a geo-referenced imagery layer
  (no bounds) and there are no coordinates to plot as points, this shipped
  as a single **ambient world-overlay thumbnail** (`variant: 'thumbnail'`,
  the same mechanism `cctvCards.js` already uses for camera preview images)
  anchored at a fixed reference point over central Spain — a "picture-in-
  picture" of the whole-country composite, not an entity layer at all.
- **One real bug found and fixed via live verification**: the overlay
  source's `collisionCapacity` was copied from `aemet-stations`' *selected*
  card (`0` — meaningful only because that entry is separately marked
  `protected: true`, which bypasses the collision budget). An ordinary
  ambient entry needs a real non-zero capacity (`1`, matching
  `satellites.js`'s own single-entry source) or Cesium's collision-avoidance
  solver silently drops it before painting — confirmed via
  `worldOverlay.js`'s `getWorldOverlayDiagnostics()` showing
  `projectedCount: 1` but `selectedCount: 0`/`paintedCount: 0` before the
  fix, and correct rendering after it.
- **Proxy is a straight binary pass-through** (`aemetLightningProxy()`) —
  nothing to parse. TTL 6h matching AEMET's own cadence, **memory-only**
  cache (deliberately no disk persistence, unlike stations/warnings — an
  image this infrequently updated has no meaningful "survive a restart"
  story beyond a fresh fetch's own cost). Frontend re-fetches the actual
  image only when `/status`'s `lastFetch` timestamp moves, polling cheaply
  on the normal 5-minute layer interval otherwise.
- Shipped: `aemetLightningEnvelopeUrl` in `weatherProviderRequests.js` (1
  test), `aemetLightningProxy()` in `server/providers/weather/aemet.js` (1
  behavioral test), `src/data/aemetLightning.js` (14 tests covering the
  freshness-label formatting, the "null lastFetch means never-fetched, not
  unchanged" bootstrap case, a live-simulated race between a slow image
  load and a `disable()`, and the click-to-expand toggle below).
- **Verified live against the real API**: the actual composite image
  (visible magenta Iberia/Balearics outline, real lightning-strike dots off
  the Mediterranean coast, AEMET's own legend strip) rendered correctly as
  the thumbnail, with a live "AEMET LIGHTNING · 2M AGO"-style freshness
  label; disable/re-enable cycles verified clean (instant redisplay of the
  cached image on re-enable, no redundant fetch); no console errors.
- **Click-to-expand — added same day, in response to the ambient card being
  too small to actually read**: clicking toggles the SAME thumbnail entry
  between the small ambient card (168×126) and a much larger one (560×420 —
  close to but still under the source's native 640×480, so this is a
  canvas scale-up of already-captured pixels, never an upscale past source
  resolution), wired via `ScreenSpaceEventHandler` +
  `overlayHost.hitTest`/`hitTestWorldOverlay` (`firmsHeatmap.js`'s ambient-
  card click pattern — there's no real Cesium entity here for `scene.pick`
  to find, only the overlay hit-test path is needed). **A second real bug
  found and fixed live**: the expanded entry initially copied
  `selected: true` from stations'/warnings' own protected click-to-inspect
  cards — but `variant: 'thumbnail'` combined with `selected: true` sends
  `measureOverlayEntry` (`worldOverlayDraw.js`) down the *selected*-card
  sizing branch instead of the thumbnail one, which never reads
  `thumbnailWidth`/`thumbnailHeight` — the measured rect collapsed to
  title-text size and the image drew far outside it (confirmed live: the
  "expanded" card rendered as an empty title bar, no image visible at all).
  Fixed by matching `cctvCards.js`'s own thumbnail entries, which hard-code
  `selected: false` regardless of active/protected state for exactly this
  reason — `protected: true` alone is what keeps the expanded card pinned
  past the collision budget. Re-verified live after the fix: full 640×480-
  detail readable (header URL, legend counts, strike cluster), clean
  collapse back to the small card on a second click.
- Voice-tool wiring deferred to Phase A14, same as every other phase.

### Phase A5 — forest-fire risk forecast — **shipped 2026-09-12**

- **Endpoint confirmed live**: `incendios/mapasriesgo/estimado/area/{area}`
  and `.../previsto/dia/{dia}/area/{area}` (`area`: p/b/c — Península/
  Baleares/Canarias; `dia`: 1/2/3). `riesgo/raster` (the third endpoint
  originally listed here) was rate-limited on every attempt during this
  pass and remains **unconfirmed** — not used by the shipped implementation.
- **Shape resolved the same way as lightning**: a real pull returned a
  1525×1017 `image/png` with AEMET's own header, **6-level** risk legend
  baked in (muy bajo/bajo/moderado/alto/muy alto/extremo — one more level
  than this plan originally guessed), and logo — no bounding box anywhere in
  the response. Shipped as the same ambient click-to-expand world-overlay
  thumbnail Phase A4 established, not an imagery layer or zone polygons.
- **A real "today vs. tomorrow" gap, found and handled**: `estimado`
  (today) returned `404 "No hay datos que satisfagan esos criterios"` at
  verification time — AEMET doesn't always have "today" published — while
  `previsto/dia/1` (tomorrow) succeeded immediately. The proxy tries
  `estimado` first and falls back to `previsto` day 1 on any failure, and
  reports which one it served so the UI title can say "TODAY" or
  "TOMORROW" rather than silently showing the wrong day as if it were
  current.
- **Not a FIRMS duplicate**: FIRMS (`local-firms`) shows satellite-
  *detected* fires already burning; this is AEMET's *predictive*
  meteorological risk index, before anything ignites — kept as an explicit
  UI distinction, not merged (see [What's already there](#whats-already-there-dont-re-build-this)).
- Shipped: `aemetFireRiskEstimadoEnvelopeUrl`/`aemetFireRiskPrevistoEnvelopeUrl`
  in `weatherProviderRequests.js` (1 test), `aemetFireRiskProxy()` in
  `server/providers/weather/aemet.js` (1 behavioral test covering the
  estimado→previsto fallback and the reverse recovery once estimado exists
  again), `src/data/aemetFireRisk.js` (15 tests) — a deliberate near-copy of
  `aemetLightning.js` (mirrored, not shared, matching this codebase's
  existing convention of per-layer variations on a proven pattern) with its
  own accent color, sizing, and the added `source` ('estimado'/'previsto-1')
  tracked alongside `lastFetch` so a source flip alone (not just a new
  timestamp) correctly triggers a reload.
- **Verified live against the real API**: the actual risk map (color-coded
  Spain, correct legend, AEMET logo, validity date) rendered as the small
  ambient card and, on click, the full 640×427 expanded card with fully
  legible legend and header. **One viewport-dependent placement note, not a
  bug**: at a narrow ~800px browser width the expanded card can fail to
  find a placement and silently doesn't paint that frame (confirmed via
  `worldOverlay.js`'s `getWorldOverlayDiagnostics()`/`getOverlayPaintRect()`
  returning `null` for it); re-verified correct at a realistic 1440×900
  desktop width. Not fixed by shrinking the card — that would defeat the
  point — recorded as a known narrow-viewport constraint.
- v1 fixes `area` to `p` (Península) only.
- **Future chip candidates, not built now**: Baleares/Canarias as an
  area-choice chip, and estimado vs. previsto-N as a time-horizon chip —
  both per this plan's own "chip grouping only where it clearly makes
  sense" principle.
- Voice-tool wiring deferred to Phase A14, same as every other phase.

### Phase A6 — maritime forecast — **blocked on zone geometry (2026-09-12)**

- **Endpoints confirmed live**: `prediccion-maritima/altamar/area/{area}`
  (`area` only accepts `0`, `1`, `2` — the error message itself reveals the
  valid set) and `.../costera/costa/{costa}` (`costa` only accepts `40`
  through `47`, same discovery method). Both return real structured JSON
  (`{origen, aviso, situacion, prediccion: {zona: [{id, nombre, subzona:
  [{id, nombre, texto}]}]}}`), not the coarse regional groupings the
  8-region public names (Costa de Galicia, etc.) might suggest — the
  ACTUAL granularity is ~30 nationwide named subzones like "Aguas costeras
  de Lugo" (numeric id `8112710`), each with its own forecast text.
- **The one real open question in this whole roadmap, now confirmed
  unresolved after an actual search, not just assumed**: these ~30 subzones
  carry no inline geometry anywhere in the API response — confirmed text-
  only, matching this plan's original suspicion. A search for a public
  geometry source came up short: AEMET's own PDF
  (`divulgacion/maritima/informacion_para_zonas_costeras.pdf`) only shows
  the 8 COARSE regional groupings on a province-boundary map — not the
  actual ~30 subzones the API operates at — and no GeoJSON/shapefile for
  the real subzone boundaries was found. Hand-digitizing zone boundaries
  from a map was deliberately NOT attempted — that would be guessing
  geometry, not verifying it, the opposite of this plan's whole discipline.
- **Not abandoned, genuinely paused**: this phase needs either (a) a real
  geometry source found in a future, more thorough search (e.g. contacting
  AEMET directly, or checking Spain's national geographic institute IGN for
  an official maritime-zone layer), or (b) a deliberate scope-down to a
  text-only click target (e.g. a fixed reference point per zone, similar to
  how A4/A5's thumbnails handle "no geometry" — but a zone-per-point
  approximation is a real design compromise, not a default, and shouldn't
  be chosen without discussing the trade-off first). Skipped ahead to
  [Phase A8](#phase-a8--uv-index--shipped-2026-09-12) rather than guessing
  through this one.
- **Pairs with**: `ais-live-vessels` and (once built) A9's sea-surface
  temperature — see [stacking demos](#which-layers-pair-well-stacking-demos).

### Phase A7 — beach forecast

- **Endpoint**: `predicciones-especificas/playa/{playa}`.
- **Shape**: points, one per beach.
- **Open question**: no beach code/coordinate list exists in this API
  (`maestro` only covers municipios) — a nomenclátor (code → name/lat/lon)
  needs an external source before the per-beach endpoint is queryable at
  all. Smaller version of A6's problem (points, not polygons), but real.

### Phase A8 — UV index — **shipped 2026-09-12**

Built after A6 was paused on its geometry problem — the friendliest shape
found anywhere in this whole plan.

- **Endpoint confirmed live**: `prediccion/especifica/uvi/0` (today) returns
  real structured JSON — 59 provincial-capital cities, each keyed by the
  **same 5-digit INE municipio code** `maestro/municipios` already uses for
  Phase A2's forecast tooltip, with a plain numeric UV value. **No image, no
  legend, no missing-geometry problem** — genuinely the cleanest endpoint in
  this entire roadmap.
- **Shape resolved as a real point layer**, not an ambient thumbnail or
  imagery overlay: the proxy (`aemetUvIndexProxy()`) joins each city to its
  lat/lon via the same municipios lookup `aemetForecastProxy()` established,
  and the frontend (`src/data/aemetUvIndex.js`) mirrors `aemetStations.js`'s
  point-layer shape directly — colored points (a continuous WHO-scale
  gradient, Low→Moderate→High→Very High→Extreme, same "gradient not
  stepped bands" lesson as `TEMPERATURE_COLOR_STOPS`) with click-to-inspect,
  applying Phase A0's `RELATIVE_TO_GROUND` + no-`disableDepthTestDistance`
  lessons from the start instead of re-discovering them.
- Shipped: `aemetUvIndexEnvelopeUrl`/`normalizeAemetUvIndexRecord`/
  `normalizeAemetUvIndexSnapshot` in `weatherProviderRequests.js` (6 tests,
  using a real captured two-city fixture — a mainland city and a Canary
  Islands one, confirmed live to share the same `id`/`valor`/`uv`/`canarias`
  shape), `aemetUvIndexProxy()` (1 behavioral test covering the municipio
  join and dropping an unmatched city rather than fabricating its
  position), `src/data/aemetUvIndex.js` (13 tests).
- **Verified live against the real API**: 59 real points rendered across
  Spain (today's real values clustering in the orange "High" band);
  clicking Madrid's point showed "UV index 6 · High" with the matching
  accent color; clean click/clear cycle, no console errors.
- TTL 3h, memory-only cache (same reasoning as A5/A4 — cheap, small, no
  "survive a restart" story worth building for a once-daily product).
- v1 fixes the day offset to `0` (today) — other forecast days are a future
  extension, not built now.
- Voice-tool wiring deferred to Phase A14, same as every other phase.

### Phase A9 — sea-surface temperature — **shipped 2026-09-12**

- **Endpoint confirmed live**: `satelites/producto/sst` (not
  `informacion-satelite/producto/sst` as originally guessed in this plan —
  the real path lives under `satelites/`). Takes no path parameters. Returns
  the standard two-step envelope; `datos` resolves to a real `image/gif`,
  1000×773, confirmed live via the actual bytes — a EUMETSAT-sourced
  sea-surface-temperature composite credited "AEMET / EUMETSAT OSI SAF"
  (AEMET is redistributing a EUMETSAT product here, not publishing an
  AEMET-original observation), covering Iberia, the Mediterranean and NW
  Africa — wider than just Spain — with a baked-in 0–35°C legend strip.
  `metadatos` confirms `periodicidad: "1 vez al día"`. No bounding box
  anywhere in the response, same as Phases A4/A5 — the contingency about a
  possibly-broken `informacion-satelite/*` endpoint never came up, since the
  real, working endpoint lives at a different path than this plan guessed.
- **Shape resolved as the same ambient click-to-expand thumbnail as A4/A5**,
  not a geo-referenced imagery overlay — there's no bounding box to drape it
  with. `src/data/aemetSeaSurfaceTemp.js` is a direct copy of
  `aemetLightning.js`'s thumbnail mechanism, applying both bugs that phase
  already found (thumbnail entries must hard-code `selected: false`
  regardless of expand state, and the ambient source's
  `collisionCapacity` must be a real non-zero value, not `0` copied from a
  *selected* card's options) so neither had to be rediscovered.
- **A third sizing bug found and fixed here**: the source image's aspect
  ratio (1000:773 ≈ 1.29:1) is taller relative to width than fire-risk's
  source image (~1525:1017 ≈ 1.5:1), so an expanded card sized to
  fire-risk's own 640px width (640×495) reliably failed to render at all —
  clicking to expand made the card disappear instead of growing. Confirmed
  via a temporary debug dump of `placementVariants()`'s rejected rects
  (`src/overlays/worldOverlay.js`) that at that size, every one of the four
  candidate placements (above/below/left/right of the anchor) overlapped a
  persistent bottom-control-panel occlusion rect from this particular
  anchor's on-screen position — and confirmed, by reproducing the identical
  failure on fire-risk's own already-shipped expand at a similarly
  cluttered anchor position, that this is a general "large expanded card
  vs. persistent UI chrome" constraint of the shared overlay mechanism, not
  a defect specific to this layer. Fixed by shrinking to 560×433 (same
  aspect ratio, matching lightning's footprint instead of fire-risk's
  wider one) — confirmed live afterward at a clear anchor position.
- Shipped: `AEMET_SEA_SURFACE_TEMP_ENVELOPE_URL`/
  `aemetSeaSurfaceTempEnvelopeUrl` in `weatherProviderRequests.js` (1 test),
  `aemetSeaSurfaceTempProxy()` (1 behavioral test, mirroring the lightning
  proxy test with a real GIF-magic-bytes fixture), `src/data/
  aemetSeaSurfaceTemp.js` (14 tests, mirroring `aemetLightning.test.mjs`'s
  coverage: entry sizing/protected/never-selected, click-to-expand toggle,
  disable-resets-expanded, stale-load-dropped, etc.).
- **Verified live against the real API**: the real EUMETSAT SST composite
  renders as the ambient thumbnail; click-to-expand shows the full legible
  map with legend and AEMET/EUMETSAT OSI SAF branding; click-to-collapse
  returns to the small card; no console errors.
- **Pre-existing interaction, not a regression**: lightning, fire-risk, and
  sea-surface-temp all anchor at the identical fixed reference point over
  central Spain, so only one is ever painted at a time when more than one
  is enabled simultaneously — each remains independently viewable by
  toggling the others off. This collision was already implicit in A4/A5's
  shared anchor design; A9 just makes it a three-way collision instead of
  a two-way one.
- TTL 6h, memory-only cache (same reasoning as A4 — cheap, small, no
  "survive a restart" story worth building for a once-daily product).
- Voice-tool wiring deferred to Phase A14, same as every other phase.

### Phase A10 — environmental networks (ozone, pollution, radiation)

- **Endpoints**: `redes-especiales/ozono`, `.../contaminacionfondo/estacion/{nombre}`,
  `.../radiacion`, `.../perfilozono/estacion/{estacion}`.
- **Shape**: points — small dedicated station networks (a few dozen sites
  each), much smaller footprint than AEMET's ~850 weather stations.
- **The one deliberate exception to "one layer per dataset for now"**: these
  three networks are proposed as a single `aemet-environmental` layer with
  a network-type chip from the start, not three near-empty toggle-panel
  rows. This is exactly the case the architecture principles above call out
  as "grouping genuinely makes sense" — same shape (points), same provider,
  each individually too sparse to be a compelling standalone toggle.

### Phase A11 — Antarctic stations

- **Endpoints**: `antartida/datos/...` (exterior), `antartida_est_int/datos/...`
  (interior).
- **Shape**: points, folded into the existing `aemet-stations` layer rather
  than a new registry entry — only two stations worldwide (Juan Carlos I,
  Gabriel de Castilla).
- **Open item**: `aemet-stations` is currently framed and filtered as
  "Spain only" (bounding-box logic likely exists for the mainland+islands
  extent) — this phase needs that framing explicitly revisited so two
  Antarctic points aren't filtered out as "outside Spain."

### Phase A12 — regional (CCAA/provincia) forecast layer

- **Endpoints**: `predicciones-normalizadas-texto/ccaa/*`, `.../provincia/*`
  (hoy/mañana/medio plazo/tendencia, each with a "today" and "as originally
  published" variant).
- **Shape**: zone polygons (CCAA/provincia administrative boundaries) +
  click-to-inspect text. AEMET provides text only, no boundary geometry —
  reuse the Natural Earth admin-boundary source already credited and used
  elsewhere in this app (`NATURAL_EARTH_CREDIT`) rather than sourcing a new
  one.

### Phase A13 — climatological values (not a toggle layer)

- **Endpoints**: `valores-climatologicos/diarios|horarios|mensualesanuales`,
  `.../normales` (1981–2010), `.../valoresextremos`,
  `.../inventarioestaciones`.
- **Not a `LAYER_STATE_REGISTRY` entry** — this is a query/comparison
  feature ("how does today compare to the historical normal for this
  station"), a genuinely different UI shape (a chart or table triggered
  from an existing station's click-to-inspect card, most likely
  `aemet-stations`') than every toggleable layer above. Still "connects"
  this data to GEV, just not via a new toggle — tracked here so it isn't
  mistaken for an oversight.

### Phase A14 — voice-tool wiring for the whole AEMET set

Once A0–A12 exist, one batched pass adds `GEV_REALTIME_TOOLS` entries +
`src/voice/gevActions.js` handlers for every AEMET layer at once ("turn on
weather radar," "show sea temperature," "any storm warnings near me,"
etc.), rather than the piecemeal per-layer wiring A0 and A1 each
individually deferred. Deliberately sequenced last: doing it once, after
the full layer set's naming and interaction patterns have stabilized, means
writing the tool-registration boilerplate one time instead of revising it
across ten separate additions.

### Deliberately excluded (AEMET side)

Real datasets, reviewed and consciously left out — not oversights:

- **NDVI (`informacion-satelite/producto/nvdi`)** — a vegetation index, not
  weather. Out of scope for *this* plan specifically; a legitimate candidate
  for a separate land/ecology-focused plan someday.
- **Raw numerical model output (`modelos-numericos`,
  `predicciones-georreferenciadas`)** — Harmonie/AESPOL/AEWAM/ECMWF raster
  fields meant for meteorologists, not map-ready output. Heavy to decode and
  render for what it would add, and already substantially covered by
  Open-Meteo's own forecast API for this app's purposes.
- **Analysis / significant-weather charts (`mapas-y-graficos`)** —
  meteorologist chart images (PDF/GIF), not globe-shaped or georeferenced
  the way a WMTS/WMS tile layer is.
- **Text bulletins beyond A12's scope
  (`predicciones-normalizadas-texto/nacional`)** — national-level prose is
  redundant with the CCAA/provincia granularity A12 already covers, and
  with Open-Meteo's existing numeric cockpit panel.

## Testing strategy (no live network required for most of it)

- Mock the two-step `descripcion/estado/datos` response shape the same way
  `celestrakProxy`'s tests mock CelesTrak — a fake first response pointing
  at a fake second URL, asserting the proxy resolves both. Every AEMET proxy
  (shipped and planned) follows this same envelope, so this pattern covers
  all of them.
- Imagery-shaped layers (A3, A5, A8, A9): cover the opacity-slider
  controller's add/remove/opacity logic against a fake
  `Cesium.ImageryLayerCollection`, matching how `aisLiveVessels.test.mjs`-
  style tests fake a viewer — no real tile fetch needed in tests.
- `scripts/qa-*.mjs` headless scripts for each phase once wired into the
  app, matching the existing `scripts/qa-*.mjs` convention (never against
  real upstream hosts).

## Open questions

Resolved, against the real APIs:
- ~~AEMET avisos zone geometry source~~ — **there isn't a separate one.**
  Every CAP alert carries its own zone polygon(s) inline; no shapefile,
  GeoJSON, or extra download to source, license, or keep in sync.
- ~~AEMET rate-limit headroom~~ — concrete TTLs now sized (stations 20 min,
  warnings 10–15 min), a few requests/hour total against a 50/min cap. Not a
  real constraint at this usage level, and nothing in A2–A14 changes that
  math meaningfully (each new dataset is its own low-frequency poll).
- ~~Polygon ground-draping specifics~~ — confirmed live during A1: no
  explicit height/heightReference needed, Cesium drapes correctly on loaded
  terrain.

Still genuinely open:
- **AEMET key acquisition** — unverified whether the current sign-up flow
  still works as described (email-only, no approval wait); confirm at
  implementation time for any NEW key someone requests. Moot for continuing
  on the current key, already working and registered in POWER UP.
- **In-effect vs. upcoming warning styling** (A1) — v1 renders any non-
  expired warning as solid regardless of whether `onset` is already past.
  Worth a visual distinction eventually — deferred by design, not an
  oversight, since both timestamps are already in the data model.
- **naranja/rojo verified only from documentation, not live traffic** (A1)
  — worth a sanity check against a real orange/red day if one comes up.
- Every "shape TBD" / "open question" / "blocker" called out per-phase
  above (A3–A12) — each is a concrete, named unknown to resolve via a live
  pull before that phase's implementation starts, per point 1 of the
  [Definition of done](#definition-of-done-applies-to-every-phase-a2-and-later).

## Docs to update once each phase actually ships

Per `CONTRIBUTING.md`, in the same PR as the implementation (not before):
`docs/CURRENT-STATE.md` (verified runtime behavior), `CHANGELOG.md`, and the
layers table in `README.md`. **`DATA_SOURCES.md`/`dataCredits.js` need no
new entry for any AEMET phase** — the existing AEMET entry already covers
the whole connection (stations and warnings today, everything through A14
eventually); each new phase just extends its "used for" description, the
same way A1 needed no new attribution entry beyond what A0 already
established.

## Deferred — non-AEMET work (tracked, not in this PR)

Everything below predates the 2026-09-12 scoping decision to make this PR
AEMET-only. It's real design work, still wanted eventually, kept here
verbatim as a tracked backlog rather than discarded — revisit only after
the AEMET phases above (A0–A14) are complete.

### Deferred layer summary

| Layer | Shows | Coverage | Disposition |
|---|---|---|---|
| `global-weather` | Same marker style as `aemet-stations`, backed by Open-Meteo instead of a real station network | Everywhere *except* Spain | `enabled-only` |
| `satellite-weather` | Translucent NASA GIBS true-color cloud-cover tiles over the current basemap | Global | `enabled+options` |

- **`aemet-stations` + `global-weather`** (once both exist): designed to
  combine into one continuous worldwide temperature layer — dense/real
  inside Spain, coarse/interpolated everywhere else, non-overlapping by a
  Spain bounding-box exclusion on the Open-Meteo side.
- **`satellite-weather` + anything**: an imagery overlay, not an entity
  layer, so it never competes for toggle state or visual space with any
  entity layer — Cesium renders entities above imagery layers.

### Open-Meteo (extend existing integration)

The two existing single-point call sites stay as-is (cockpit text + cloud
effects). What's missing is a **map layer** — Open-Meteo has no station
network of its own, so "where do the points come from" is a real design
decision, not a given:

- **Option 1 — global fallback for AEMET's layer (recommended).** Outside
  Spain, plot a fixed or camera-relative set of sample points using the
  same marker style as `aemetStations.js`, backed by Open-Meteo instead of
  AEMET. Reuses the Phase A0 rendering code, cheapest to build. Points come
  from Natural Earth's "populated places" dataset — already a credited,
  public-domain source in this app (`NATURAL_EARTH_CREDIT`, used today for
  region boundaries). Filter to capitals + places above a population
  threshold (~200–300 points worldwide keeps Open-Meteo's free-tier call
  volume trivial even polled every 10–15 min) and **exclude anything inside
  Spain's bounding box**, so `aemet-stations` and `global-weather` tile
  together into one seamless worldwide set instead of overlapping.
- **Option 2 — on-demand point query.** Generalize the existing cockpit
  current-conditions call so *any* clicked point on the globe (not just
  camera-follow) can show current conditions via Open-Meteo — no new layer
  registry entry, just extending what the cockpit info panel already knows
  how to do.
- Whichever option: call the existing `fetchRegionalWeather()`
  (`server/providers/local.js:4196`, extended with more fields if Option
  1's marker style needs them) rather than adding a parallel client, and
  keep it on the existing `/api/weather-effects`-style cache/rate-limit
  posture (`common/rate-limit.js`). Its credit in
  `DATA_SOURCES.md`/`dataCredits.js` already exists — extend the "used for"
  description rather than adding a duplicate entry.
- Marine and air-quality Open-Meteo sub-APIs are real future extensions
  (both free, same host, no separate key) but out of scope even for this
  deferred item — not needed until a maritime or pollution layer is
  actually planned on the Open-Meteo side specifically.

### NASA GIBS

Global, keyless WMTS tiles (`https://gibs.earthdata.nasa.gov/wmts/...`),
3–6 h latency. True-color/IR near-real-time cloud imagery, distinct from
FIRMS and from the static basemap imagery. EUMETSAT was considered and
deliberately **excluded** as an alternative — it needs OAuth token refresh
every hour and ships raw NetCDF/HRIT rather than map-ready output, the
heaviest lift of everything reviewed, worth revisiting only if GIBS's 3–6 h
latency over Europe proves insufficient later.

#### Architecture — NASA GIBS

This needs a **second, non-exclusive imagery layer stacked on top of the
current base map**, not another entity-based `LAYER_STATE_REGISTRY` toggle,
and not a swap through `mapStackController.js`'s single `_imageryLayer`
slot (that's reserved for the base map itself — Bing/Esri/Google — and
swapping it would replace the ground texture, not add a translucent weather
layer above it).

Concretely:
- `Cesium.WebMapTileServiceImageryProvider` pointed at a GIBS layer id (e.g.
  `MODIS_Terra_CorrectedReflectance_TrueColor`), added via
  `viewer.imageryLayers.add(layer, <higher index than the base>)` — Cesium
  supports multiple stacked imagery layers natively.
- A small new controller (e.g. `src/gibsOverlayController.js`, sibling to
  `mapStackController.js`) owning: enable/disable, an opacity slider, and
  which GIBS product is active (true-color vs. IR vs. snow-cover — pick one
  at a time, matching how `satellites.js`'s options work today). **v1
  product: true-color only** — IR and snow-cover stay real, just deferred:
  the `enabled+options` disposition and `getRowControls` chip mechanism
  would already be reserved, so adding a product switcher later is a small
  follow-up, not a registry change.
- Still worth a `layerState.js` entry purely for persistence/share-links
  (e.g. `{ id: 'satellite-weather', token: 'k', disposition:
  'enabled+options', optionOwner: 'satellite-weather' }` — `k` picked over
  the originally-proposed `n`, since `n` was claimed by the `liveuamap`
  layer (branch `mi-main`) after this plan was first written; confirm
  against the current registry before implementing).
- No API key, no server-side proxy needed (GIBS answers CORS-enabled tile
  requests directly).
- A NASA GIBS "fire/thermal anomaly" tile layer would be pure duplication
  of `local-firms` (NASA FIRMS) — out of scope, don't add it, regardless of
  when this phase is picked back up.

#### Deferred testing notes

- Mock `fetchRegionalWeather`'s upstream fetch for the Open-Meteo layer,
  same style as the existing `weatherEffectsProxy` tests (if any exist yet
  — check and follow that pattern, or `firmsProxy.test.mjs`'s style if
  not).
- GIBS has no server code to test (client-only, no proxy) — cover the
  overlay controller's add/remove/opacity logic against a fake
  `Cesium.ImageryLayerCollection`.

#### Deferred docs note

NASA GIBS will need its own new `DATA_SOURCES.md`/`dataCredits.js` entry
when that phase starts (check GIBS's current citation requirements then).
Open-Meteo's existing entry just needs its "used for" column broadened once
its map-layer use ships.
