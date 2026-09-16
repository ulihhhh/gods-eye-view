import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { WORLD_OVERLAY_STYLE } from '../overlays/worldOverlayTokens.js';
import { isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';

/**
 * AEMET OpenData ambient composite imagery (Phase A16) — one layer sharing
 * a single "picture-in-picture" thumbnail slot between three AEMET products
 * that were originally shipped as three separate layers (`aemet-lightning`
 * Phase A4, `aemet-fire-risk` Phase A5, `aemet-sea-surface-temp` Phase A9):
 * lightning activity, forest-fire risk, and sea-surface temperature.
 *
 * All three are pre-rendered raster composites with no bounding box and no
 * coordinate list to plot against — the same "fixed reference anchor over
 * central Spain" reasoning each original layer documented individually.
 * Enabling more than one of the three at once used to be genuinely flaky:
 * each registered its OWN ambient overlay entry at the identical anchor,
 * same collision group, same priority, so whichever layer's `update()`
 * happened to run last for that frame won the one paintable slot — "one
 * map, or a different one, or none" depending on frame-to-frame ordering
 * that isn't stable across which layers are enabled or refreshed in what
 * sequence. Combining the three into one layer that only ever publishes ONE
 * overlay entry at a time removes the collision at the root instead of
 * papering over it with anchor offsets or priority tie-breaks.
 *
 * All three feeds still poll independently in the background on this
 * layer's own update cadence — switching the active map is instant if that
 * map's image has already loaded, exactly like `aemet-environmental`'s own
 * network-type chip keeps both networks warm underneath one active choice.
 * A three-pill chip row (`getRowControls()`/`setParams()`, the same
 * mechanism `aemet-environmental`'s chip and `satellites.js`'s DENSE chip
 * already use) switches which one is currently shown; `manager.js`'s row
 * renderer already reconciles an arbitrary NUMBER of chips (keyed by each
 * chip's own `id`), so three distinct pills needed no new panel machinery —
 * only three chip descriptors with three different ids.
 */

export const AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID = 'aemet-weather-imagery';
export const AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  // A normal AMBIENT entry — needs a real non-zero collision slot or the
  // solver drops it silently (see the original layers' identical note).
  // Only one entry is ever published at a time now, so this alone already
  // guarantees the old three-way collision cannot recur even without the
  // merge — the merge additionally means there's nothing left to collide.
  collisionCapacity: 1,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

/**
 * Fixed reference point over central Spain — unchanged from the three
 * original layers, which all anchored here independently.
 */
const ANCHOR_LON = -3.7;
const ANCHOR_LAT = 40.0;

const MAP_ORDER = Object.freeze(['lightning', 'fireRisk', 'sst']);

/**
 * Per-map configuration, carrying forward each original layer's own
 * live-verified sizing (tuned to that image's real aspect ratio and, for
 * fire-risk and sea-surface-temp, a placement-fitting fix found via live
 * debugging — see each original phase's notes in the plan doc) and accent.
 */
const MAP_CONFIG = Object.freeze({
  lightning: Object.freeze({
    statusUrl: '/api/aemet/lightning/status',
    imageUrl: '/api/aemet/lightning',
    titleBase: 'AEMET LIGHTNING',
    accent: 'rgb(255, 214, 61)', // lightning yellow
    thumbnailWidth: 168,
    thumbnailHeight: 126, // matches the real image's 4:3 aspect ratio
    expandedWidth: 560,
    expandedHeight: 420,
    chipLabel: '⚡ LIGHTNING',
    chipTitle: 'Nationwide lightning-strike composite (updates ~every 6h)',
    hasSourceField: false,
  }),
  fireRisk: Object.freeze({
    statusUrl: '/api/aemet/fire-risk/status',
    imageUrl: '/api/aemet/fire-risk',
    titleBase: 'AEMET FIRE RISK',
    accent: 'rgb(255, 107, 53)', // wildfire orange
    thumbnailWidth: 168,
    thumbnailHeight: 112, // matches the real image's ~1525:1017 aspect ratio
    expandedWidth: 640,
    expandedHeight: 427,
    chipLabel: '🔥 FIRE RISK',
    chipTitle:
      'Forest-fire meteorological risk forecast (today, or tomorrow if not yet published)',
    hasSourceField: true, // 'estimado'/'previsto-1' → TODAY/TOMORROW
  }),
  sst: Object.freeze({
    statusUrl: '/api/aemet/sea-surface-temp/status',
    imageUrl: '/api/aemet/sea-surface-temp',
    titleBase: 'AEMET SEA SURFACE TEMP',
    accent: 'rgb(64, 200, 224)', // sea-surface cyan
    thumbnailWidth: 168,
    thumbnailHeight: 130, // matches the real image's 1000:773 aspect ratio
    expandedWidth: 560,
    expandedHeight: 433,
    chipLabel: '🌊 SEA TEMP',
    chipTitle:
      'EUMETSAT OSI SAF sea-surface-temperature composite (updates ~once a day)',
    hasSourceField: false,
  }),
});

/** `Date` diff → a short "Xm ago" / "Xh ago" label, or `null` for no timestamp. */
function relativeAgeLabel(fetchedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAtMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** `source` field from fire-risk's `/status` → a short label distinguishing today's map from tomorrow's fallback. */
function sourceLabel(source) {
  if (source === 'estimado') return 'TODAY';
  if (source === 'previsto-1') return 'TOMORROW';
  return null;
}

/**
 * Build the single published overlay entry for whichever map is currently
 * active. Pure aside from the caller-supplied `imageSlot` — exported for
 * tests.
 * @param {string} mapKey One of MAP_ORDER.
 * @param {{frame: unknown, stamp: number}} imageSlot
 * @param {{fetchedAtMs: number|null, source?: string|null, expanded?: boolean}} meta
 * @param {Cesium.Cartesian3} position
 * @returns {object}
 */
export function createAemetWeatherImageryOverlayEntry(
  mapKey,
  imageSlot,
  meta,
  position,
) {
  const config = MAP_CONFIG[mapKey];
  const age = relativeAgeLabel(meta?.fetchedAtMs);
  const day = config.hasSourceField ? sourceLabel(meta?.source) : null;
  const expanded = Boolean(meta?.expanded);
  const dayText = day ? ` · ${day}` : '';
  const ageText = age ? ` · ${age.toUpperCase()}` : '';
  return {
    id: AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID,
    position,
    variant: 'thumbnail',
    paintLane: 'thumbnail',
    title: `${config.titleBase}${dayText}${ageText}${expanded ? ' · CLICK TO COLLAPSE' : ''}`,
    details: [],
    image: imageSlot,
    requireImage: true,
    accent: config.accent,
    // NEVER `selected: true` on a `variant: 'thumbnail'` entry — see the
    // original aemetLightning.js's detailed note on why that breaks
    // `measureOverlayEntry`'s sizing branch. `protected: true` alone keeps
    // the expanded card pinned past the collision budget.
    priority: expanded ? Number.MAX_SAFE_INTEGER : 500_000,
    selected: false,
    protected: expanded,
    collisionGroup: 'ambient-card',
    interactive: true,
    thumbnailWidth: expanded ? config.expandedWidth : config.thumbnailWidth,
    thumbnailHeight: expanded ? config.expandedHeight : config.thumbnailHeight,
    thumbnailPadX: expanded ? 8 : 4,
    thumbnailPadTop: expanded ? 8 : 4,
    thumbnailPadBottom: expanded ? 8 : 4,
    thumbnailTitleHeight: expanded ? 16 : 13,
    thumbnailBackground: WORLD_OVERLAY_STYLE.background,
    thumbnailTitleColor: WORLD_OVERLAY_STYLE.title,
    thumbnailTitleFont: expanded
      ? WORLD_OVERLAY_STYLE.fontSelected
      : WORLD_OVERLAY_STYLE.fontLabel,
    thumbnailLeaderColor: config.accent,
    thumbnailRuleColor: config.accent,
    thumbnailRuleHeight: expanded ? 3 : 2,
    thumbnailRadius: WORLD_OVERLAY_STYLE.radius,
  };
}

/** Validate one map's `/status` payload shape — identical shape across all three feeds. */
export function normalizeAemetWeatherImageryStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    hasKey: Boolean(payload.hasKey),
    lastFetch: Number.isFinite(payload.lastFetch) ? payload.lastFetch : null,
    stale: Boolean(payload.stale),
    source: typeof payload.source === 'string' ? payload.source : null,
  };
}

/** Load an image off-DOM; resolves `null` on failure or when no DOM exists (tests, SSR). */
function defaultLoadImage(url) {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function freshMapState() {
  return {
    imageSlot: null,
    loadedFetchedAtMs: null,
    loadedSource: null,
    lastError: null,
    loadToken: 0,
  };
}

export function createAemetWeatherImageryLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  loadImage = defaultLoadImage,
} = {}) {
  let _enabled = false;
  /** @type {string} one of MAP_ORDER — which map is currently shown. Persists across enable/disable, resets only on init(). */
  let _activeMap = 'lightning';
  /** @type {Record<string, {imageSlot: object|null, loadedFetchedAtMs: number|null, loadedSource: string|null, lastError: string|null, loadToken: number}>} */
  let _perMap = {
    lightning: freshMapState(),
    fireRisk: freshMapState(),
    sst: freshMapState(),
  };
  /** Click-to-expand state — collapsed (small ambient card) by default, shared across whichever map is active. */
  let _expanded = false;
  let _viewer = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  function _publish() {
    const state = _perMap[_activeMap];
    if (!_enabled || !state?.imageSlot) {
      overlayHost.setEntries(
        AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID,
        [],
        AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS,
      );
      return;
    }
    const position = Cesium.Cartesian3.fromDegrees(ANCHOR_LON, ANCHOR_LAT);
    overlayHost.setEntries(
      AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID,
      [
        createAemetWeatherImageryOverlayEntry(
          _activeMap,
          state.imageSlot,
          {
            fetchedAtMs: state.loadedFetchedAtMs,
            source: state.loadedSource,
            expanded: _expanded,
          },
          position,
        ),
      ],
      AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function _setExpanded(next) {
    if (_expanded === next) return;
    _expanded = next;
    _publish();
  }

  function _setActiveMap(next) {
    if (!MAP_ORDER.includes(next) || _activeMap === next) return;
    _activeMap = next;
    _publish();
  }

  const hasDom = () => typeof document !== 'undefined';

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer('aemet-weather-imagery', pickedId))
          return;
      }
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID,
      });
      if (hit) {
        _setExpanded(!_expanded);
        return;
      }
      if (_expanded) _setExpanded(false); // clicking elsewhere collapses an open card
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function _removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  /**
   * Poll and, if the underlying image actually changed, reload ONE map's
   * feed — identical logic each of the three original layers implemented
   * independently, now parametrized by `mapKey`/`config` and isolated by its
   * own try/catch so one map's failure never blocks the other two from
   * refreshing (mirrors the beach layer's own per-item failure isolation).
   * @param {string} mapKey
   */
  async function _updateOneMap(mapKey) {
    const config = MAP_CONFIG[mapKey];
    const state = _perMap[mapKey];
    try {
      const response = await fetch(config.statusUrl);
      if (!response.ok) {
        state.lastError = `AEMET HTTP ${response.status}`;
        return;
      }
      const status = normalizeAemetWeatherImageryStatus(await response.json());
      if (!status) {
        state.lastError = 'Malformed AEMET response';
        return;
      }
      if (!status.hasKey) {
        state.lastError = 'AEMET_API_KEY not configured';
        return;
      }
      state.lastError = status.stale
        ? 'Serving stale AEMET data (upstream unavailable)'
        : null;
      // `lastFetch: null` means the PROXY itself has never fetched anything
      // yet — on first boot this must still fall through to a load. A
      // fire-risk source flip (yesterday's previsto-1 replaced by today's
      // real estimado) also means the bytes may have changed even if the
      // timestamp looks the same-ish.
      const neverLoaded = state.loadedFetchedAtMs === null;
      if (
        !neverLoaded &&
        status.lastFetch === state.loadedFetchedAtMs &&
        status.source === state.loadedSource
      ) {
        return;
      }

      const token = ++state.loadToken;
      const cacheBustUrl = `${config.imageUrl}?ts=${encodeURIComponent(status.lastFetch ?? Date.now())}`;
      const image = await loadImage(cacheBustUrl);
      if (token !== state.loadToken) return; // superseded by a disable or a newer poll
      if (!image) {
        state.lastError = `AEMET ${mapKey} image failed to load`;
        return;
      }
      // Bootstrap case: the request above is what MADE the proxy fetch, so
      // `status.lastFetch` (read before that request) is still stale/null —
      // re-read it now that the proxy's cache is actually populated.
      let fetchedAtMs = status.lastFetch;
      let source = status.source;
      if (fetchedAtMs === null) {
        try {
          const refreshed = normalizeAemetWeatherImageryStatus(
            await (await fetch(config.statusUrl)).json(),
          );
          fetchedAtMs = refreshed?.lastFetch ?? Date.now();
          source = refreshed?.source ?? source;
        } catch {
          fetchedAtMs = Date.now();
        }
      }
      state.imageSlot = { frame: image, stamp: Date.now() };
      state.loadedFetchedAtMs = fetchedAtMs;
      state.loadedSource = source;
      if (mapKey === _activeMap) _publish();
      console.log(
        `[Data:AemetWeatherImagery] Updated: new ${mapKey} composite loaded`,
      );
    } catch (e) {
      console.warn(`[Data:AemetWeatherImagery] ${mapKey} fetch error:`, e);
      state.lastError = 'AEMET network error';
    }
  }

  const layer = {
    id: 'aemet-weather-imagery',
    name: 'AEMET Weather Imagery',
    icon: '🛰️',
    source: 'AEMET OpenData · Spain / EUMETSAT OSI SAF',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _activeMap = 'lightning';
      _perMap = {
        lightning: freshMapState(),
        fireRisk: freshMapState(),
        sst: freshMapState(),
      };
      _expanded = false;
      overlayHost.setVisible(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetWeatherImagery] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      overlayHost.setVisible(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer || _viewer);
      _publish(); // redisplay instantly if the active map's image was already loaded
    },

    disable() {
      _enabled = false;
      _expanded = false; // a re-enable starts back at the small ambient card
      overlayHost.setVisible(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      for (const mapKey of MAP_ORDER) _perMap[mapKey].loadToken += 1; // a still-loading image must not apply after this
    },

    async update() {
      await Promise.all(MAP_ORDER.map((mapKey) => _updateOneMap(mapKey)));
      // Mirrors what each original single-map layer returned: whether ITS
      // OWN feed is currently healthy. A background failure on a map that
      // isn't shown right now doesn't degrade what the user actually sees —
      // `getStats().error` (below) already reflects that per-map distinction
      // for every map, active or not.
      return !_perMap[_activeMap].lastError;
    },

    destroy() {
      _enabled = false;
      _expanded = false;
      for (const mapKey of MAP_ORDER) _perMap[mapKey].loadToken += 1;
      _removeClickHandler();
      overlayHost.setVisible(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID, false);
      overlayHost.clearSource(AEMET_WEATHER_IMAGERY_OVERLAY_SOURCE_ID);
      _perMap = {
        lightning: freshMapState(),
        fireRisk: freshMapState(),
        sst: freshMapState(),
      };
      _viewer = null;
    },

    getStats() {
      const state = _perMap[_activeMap];
      return {
        count: state?.imageSlot ? 1 : 0,
        lastUpdate: state?.loadedFetchedAtMs ?? null,
        error: state?.lastError ?? null,
      };
    },

    /**
     * Three distinct pills, one per map — `manager.js`'s row renderer
     * already reconciles any number of chips, keyed by each chip's own
     * `id`, so this needed no new panel machinery. Clicking a pill calls
     * `setParams({ activeMap })` below.
     */
    getRowControls() {
      return {
        chips: MAP_ORDER.map((mapKey) => {
          const config = MAP_CONFIG[mapKey];
          const active = _activeMap === mapKey;
          return {
            id: mapKey,
            label: config.chipLabel,
            active,
            state: active ? 'active' : 'idle',
            title: config.chipTitle,
            params: { activeMap: mapKey },
          };
        }),
        legend: [],
      };
    },

    setParams(params = {}) {
      if (params.activeMap !== undefined) {
        if (!MAP_ORDER.includes(params.activeMap)) return false;
        _setActiveMap(params.activeMap);
      }
      return true;
    },

    // Test-only hooks: exercise state directly, bypassing
    // Cesium.ScreenSpaceEventHandler/document (unavailable under plain Node
    // — see hasDom() above), same as every other click-to-inspect layer.
    _activeMapForTest() {
      return _activeMap;
    },
    _hasImageForTest(mapKey = _activeMap) {
      return Boolean(_perMap[mapKey]?.imageSlot);
    },
    _loadedFetchedAtForTest(mapKey = _activeMap) {
      return _perMap[mapKey]?.loadedFetchedAtMs ?? null;
    },
    _loadedSourceForTest(mapKey = _activeMap) {
      return _perMap[mapKey]?.loadedSource ?? null;
    },
    _isExpandedForTest() {
      return _expanded;
    },
    _toggleExpandedForTest() {
      _setExpanded(!_expanded);
    },
  };
  return layer;
}

const aemetWeatherImageryLayer = createAemetWeatherImageryLayer();

export default aemetWeatherImageryLayer;
