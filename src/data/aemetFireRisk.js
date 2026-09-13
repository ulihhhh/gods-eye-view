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
 * AEMET OpenData forest-fire meteorological risk map (Phase A5) — the same
 * "single ambient click-to-expand world-overlay thumbnail" shape
 * `aemetLightning.js` established for Phase A4, mirrored rather than shared
 * (this codebase's convention for per-layer variations on a proven click-
 * to-inspect pattern — see `aemetWarnings.js` mirroring `aemetStations.js`).
 *
 * AEMET's `incendios/mapasriesgo/*` exposes no risk-grid data — only a
 * pre-rendered PNG (confirmed live: 1525×1017) with AEMET's own header,
 * 6-level risk legend (muy bajo/bajo/moderado/alto/muy alto/extremo), and
 * logo baked into the pixels, no bounding box anywhere in the response —
 * same reasoning as lightning for why this is a fixed-anchor thumbnail, not
 * a geo-referenced `Cesium.ImageryLayer`.
 *
 * NOT a `local-firms` (NASA FIRMS) duplicate despite both being "fire" data:
 * FIRMS shows satellite-*detected* fires already burning; this is AEMET's
 * *predictive* meteorological risk index, before anything ignites.
 *
 * The proxy already resolves "today vs. tomorrow" (AEMET's `estimado`
 * product isn't always published yet) and reports which one it served via
 * `/status`'s `source` field — the title reflects that so a user isn't
 * misled into thinking a shown map is for today when it's actually
 * tomorrow's forecast.
 */

export const AEMET_FIRE_RISK_OVERLAY_SOURCE_ID = 'aemet-fire-risk';
export const AEMET_FIRE_RISK_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  // See aemetLightning.js's identical comment: an ordinary ambient entry
  // needs a real non-zero collision slot or the solver drops it silently.
  collisionCapacity: 1,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

const STATUS_URL = '/api/aemet/fire-risk/status';
const IMAGE_URL = '/api/aemet/fire-risk';

/**
 * Fixed reference point over central Spain — same placement reasoning as
 * `aemetLightning.js`: this composite has no embedded geography, so it sits
 * over the country it summarizes. The collision-avoidance solver keeps this
 * from overlapping the lightning thumbnail (also anchored here) — that's
 * exactly the layout job it already does for every other ambient card.
 */
const ANCHOR_LON = -3.7;
const ANCHOR_LAT = 40.0;

const THUMBNAIL_WIDTH_PX = 168;
const THUMBNAIL_HEIGHT_PX = 112; // matches the real image's ~1525:1017 aspect ratio
// Expanded size — see aemetLightning.js's identical reasoning: a canvas
// scale-up of already-captured pixels, still below the source's native
// 1525×1017, so legend/labels stay legible without upscaling past source
// resolution.
const EXPANDED_WIDTH_PX = 640;
const EXPANDED_HEIGHT_PX = 427;
const ACCENT = 'rgb(255, 107, 53)'; // wildfire orange, distinct from lightning's yellow

/** `Date` diff → a short "Xm ago" / "Xh ago" label, or `null` for no timestamp. */
function relativeAgeLabel(fetchedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAtMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** `source` field from `/status` → a short label distinguishing today's map from tomorrow's fallback. */
function sourceLabel(source) {
  if (source === 'estimado') return 'TODAY';
  if (source === 'previsto-1') return 'TOMORROW';
  return null;
}

/**
 * Build the thumbnail entry — the small always-on ambient card by default,
 * or the large click-to-expand one when `meta.expanded` is set. Pure aside
 * from the caller-supplied `imageSlot` (an `{frame, stamp}` pair) — exported
 * for tests.
 * @param {{frame: unknown, stamp: number}} imageSlot
 * @param {{fetchedAtMs: number|null, source: string|null, expanded?: boolean}} meta
 * @param {Cesium.Cartesian3} position
 * @returns {object}
 */
export function createAemetFireRiskOverlayEntry(imageSlot, meta, position) {
  const age = relativeAgeLabel(meta?.fetchedAtMs);
  const day = sourceLabel(meta?.source);
  const expanded = Boolean(meta?.expanded);
  const dayText = day ? ` · ${day}` : '';
  const ageText = age ? ` · ${age.toUpperCase()}` : '';
  return {
    id: AEMET_FIRE_RISK_OVERLAY_SOURCE_ID,
    position,
    variant: 'thumbnail',
    paintLane: 'thumbnail',
    title: `AEMET FIRE RISK${dayText}${ageText}${expanded ? ' · CLICK TO COLLAPSE' : ''}`,
    details: [],
    image: imageSlot,
    requireImage: true,
    accent: ACCENT,
    // NEVER `selected: true` on a `variant: 'thumbnail'` entry — see
    // aemetLightning.js's detailed comment on this exact bug
    // (`measureOverlayEntry` silently ignores `thumbnailWidth`/`Height` when
    // the two disagree). `protected: true` alone keeps the expanded card
    // pinned past the collision budget.
    priority: expanded ? Number.MAX_SAFE_INTEGER : 500_000,
    selected: false,
    protected: expanded,
    collisionGroup: 'ambient-card',
    interactive: true,
    thumbnailWidth: expanded ? EXPANDED_WIDTH_PX : THUMBNAIL_WIDTH_PX,
    thumbnailHeight: expanded ? EXPANDED_HEIGHT_PX : THUMBNAIL_HEIGHT_PX,
    thumbnailPadX: expanded ? 8 : 4,
    thumbnailPadTop: expanded ? 8 : 4,
    thumbnailPadBottom: expanded ? 8 : 4,
    thumbnailTitleHeight: expanded ? 16 : 13,
    thumbnailBackground: WORLD_OVERLAY_STYLE.background,
    thumbnailTitleColor: WORLD_OVERLAY_STYLE.title,
    thumbnailTitleFont: expanded ? WORLD_OVERLAY_STYLE.fontSelected : WORLD_OVERLAY_STYLE.fontLabel,
    thumbnailLeaderColor: ACCENT,
    thumbnailRuleColor: ACCENT,
    thumbnailRuleHeight: expanded ? 3 : 2,
    thumbnailRadius: WORLD_OVERLAY_STYLE.radius,
  };
}

/** Validate `/api/aemet/fire-risk/status`'s payload shape. */
export function normalizeAemetFireRiskStatus(payload) {
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

export function createAemetFireRiskLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  loadImage = defaultLoadImage,
} = {}) {
  let _enabled = false;
  let _lastError = null;
  /** @type {{frame: unknown, stamp: number}|null} */
  let _imageSlot = null;
  /** @type {number|null} the `lastFetch` we've already loaded an image for — re-load only when this moves */
  let _loadedFetchedAtMs = null;
  /** @type {string|null} which product ('estimado'/'previsto-1') the current image is */
  let _loadedSource = null;
  /** Guards a slow image load from applying after a newer poll/disable supersedes it. */
  let _loadToken = 0;
  /** Click-to-expand state — collapsed (small ambient card) by default. */
  let _expanded = false;
  let _viewer = null;
  /** @type {Cesium.ScreenSpaceEventHandler|null} */
  let _clickHandler = null;

  function _publish() {
    if (!_enabled || !_imageSlot) return;
    const position = Cesium.Cartesian3.fromDegrees(ANCHOR_LON, ANCHOR_LAT);
    overlayHost.setEntries(
      AEMET_FIRE_RISK_OVERLAY_SOURCE_ID,
      [createAemetFireRiskOverlayEntry(
        _imageSlot,
        { fetchedAtMs: _loadedFetchedAtMs, source: _loadedSource, expanded: _expanded },
        position,
      )],
      AEMET_FIRE_RISK_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function _setExpanded(next) {
    if (_expanded === next) return;
    _expanded = next;
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
        if (pickedId && isOwnedByOtherLayer('aemet-fire-risk', pickedId)) return;
      }
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: AEMET_FIRE_RISK_OVERLAY_SOURCE_ID,
      });
      if (hit) {
        _setExpanded(!_expanded);
        return;
      }
      if (_expanded) _setExpanded(false);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function _removeClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  const layer = {
    id: 'aemet-fire-risk',
    name: 'AEMET Fire Risk',
    icon: '🔥',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _lastError = null;
      _imageSlot = null;
      _loadedFetchedAtMs = null;
      _loadedSource = null;
      _expanded = false;
      overlayHost.setVisible(AEMET_FIRE_RISK_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetFireRisk] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      overlayHost.setVisible(AEMET_FIRE_RISK_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer || _viewer);
      _publish();
    },

    disable() {
      _enabled = false;
      _expanded = false;
      overlayHost.setVisible(AEMET_FIRE_RISK_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      _loadToken += 1;
    },

    async update() {
      try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) {
          _lastError = `AEMET HTTP ${response.status}`;
          return false;
        }
        const status = normalizeAemetFireRiskStatus(await response.json());
        if (!status) {
          _lastError = 'Malformed AEMET response';
          return false;
        }
        if (!status.hasKey) {
          _lastError = 'AEMET_API_KEY not configured';
          return false;
        }
        _lastError = status.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        // Reload when the underlying fetch timestamp moves OR when the
        // SOURCE flips (e.g. yesterday's fallback "previsto-1" gets replaced
        // by today's real "estimado" once AEMET publishes it) — either one
        // means the image bytes themselves may have changed.
        const neverLoaded = _loadedFetchedAtMs === null;
        if (!neverLoaded && status.lastFetch === _loadedFetchedAtMs && status.source === _loadedSource) return true;

        const token = ++_loadToken;
        const cacheBustUrl = `${IMAGE_URL}?ts=${encodeURIComponent(status.lastFetch ?? Date.now())}`;
        const image = await loadImage(cacheBustUrl);
        if (token !== _loadToken) return true;
        if (!image) {
          _lastError = 'AEMET fire-risk image failed to load';
          return false;
        }
        let fetchedAtMs = status.lastFetch;
        let source = status.source;
        if (fetchedAtMs === null) {
          try {
            const refreshed = normalizeAemetFireRiskStatus(await (await fetch(STATUS_URL)).json());
            fetchedAtMs = refreshed?.lastFetch ?? Date.now();
            source = refreshed?.source ?? source;
          } catch {
            fetchedAtMs = Date.now();
          }
        }
        _imageSlot = { frame: image, stamp: Date.now() };
        _loadedFetchedAtMs = fetchedAtMs;
        _loadedSource = source;
        _publish();
        console.log('[Data:AemetFireRisk] Updated: new risk map loaded');
        return true;
      } catch (e) {
        console.warn('[Data:AemetFireRisk] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      _expanded = false;
      _loadToken += 1;
      _removeClickHandler();
      overlayHost.setVisible(AEMET_FIRE_RISK_OVERLAY_SOURCE_ID, false);
      overlayHost.clearSource(AEMET_FIRE_RISK_OVERLAY_SOURCE_ID);
      _imageSlot = null;
      _loadedFetchedAtMs = null;
      _loadedSource = null;
      _lastError = null;
      _viewer = null;
    },

    getStats() {
      return {
        count: _imageSlot ? 1 : 0,
        lastUpdate: _loadedFetchedAtMs,
        error: _lastError,
      };
    },

    _hasImageForTest() {
      return Boolean(_imageSlot);
    },
    _loadedFetchedAtForTest() {
      return _loadedFetchedAtMs;
    },
    _loadedSourceForTest() {
      return _loadedSource;
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

const aemetFireRiskLayer = createAemetFireRiskLayer();

export default aemetFireRiskLayer;
