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
 * AEMET OpenData sea-surface-temperature composite (Phase A9) — a single
 * ambient "picture-in-picture" thumbnail, same mechanism as
 * `aemet-lightning`/`aemet-fire-risk`, NOT a polled entity layer.
 *
 * `satelites/producto/sst` exposes no per-pixel value grid or bounding box —
 * only a pre-rendered GIF (confirmed live: `image/gif`, 1000×773) crediting
 * "AEMET / EUMETSAT OSI SAF": AEMET is redistributing a EUMETSAT satellite
 * product, not an AEMET-original observation. The map covers Iberia, the
 * Mediterranean and NW Africa — wider than just Spain — with a baked-in
 * 0-35°C legend strip, so the same fixed-anchor thumbnail treatment applies.
 *
 * Refreshes only when the underlying image actually changes (confirmed
 * `periodicidad: "1 vez al día"`; the proxy caches for 6h regardless) —
 * `update()` cheaply checks `/api/aemet/sea-surface-temp/status` and only
 * loads the actual image bytes when its `lastFetch` timestamp moves.
 */

export const AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID = 'aemet-sea-surface-temp';
export const AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  // A normal AMBIENT entry — needs a real non-zero capacity to claim a
  // collision-avoidance slot at all (see aemetLightning.js's own note).
  collisionCapacity: 1,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

const STATUS_URL = '/api/aemet/sea-surface-temp/status';
const IMAGE_URL = '/api/aemet/sea-surface-temp';

/**
 * Fixed reference point over central Spain — the same deliberate placement
 * convention every other ambient AEMET composite uses (no embedded geography
 * to anchor to, so it sits over the country the product is published for).
 */
const ANCHOR_LON = -3.7;
const ANCHOR_LAT = 40.0;

const THUMBNAIL_WIDTH_PX = 168;
const THUMBNAIL_HEIGHT_PX = 130; // matches the real image's 1000:773 aspect ratio
// Clicked/expanded size — below the real image's native 1000×773 (a scale-up
// of already-captured pixels, not an upscale past source resolution) so the
// baked-in legend and coastline detail are actually legible. Kept closer to
// lightning's/fire-risk's own expanded footprint (rather than matching
// fire-risk's 640 width) because this image's taller 1000:773 aspect ratio
// (vs. fire-risk's wider ~1525:1017) made a 640-wide card tall enough to
// always overlap the bottom-left/bottom-right control panels regardless of
// placement corner — confirmed live via a temporary debug dump of
// `placementVariants`' rejected rects against `_uiOcclusionRects`.
const EXPANDED_WIDTH_PX = 560;
const EXPANDED_HEIGHT_PX = 433;
const ACCENT = 'rgb(64, 200, 224)'; // sea-surface cyan, distinct from lightning's yellow and fire-risk's orange

/** `Date` diff → a short "Xm ago" / "Xh ago" label, or `null` for no timestamp. */
function relativeAgeLabel(fetchedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAtMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Build the thumbnail entry — the small always-on ambient card by default,
 * or the large click-to-expand one when `meta.expanded` is set. Pure aside
 * from the caller-supplied `imageSlot` — exported for tests.
 * @param {{frame: unknown, stamp: number}} imageSlot
 * @param {{fetchedAtMs: number|null, expanded?: boolean}} meta
 * @param {Cesium.Cartesian3} position
 * @returns {object}
 */
export function createAemetSeaSurfaceTempOverlayEntry(imageSlot, meta, position) {
  const age = relativeAgeLabel(meta?.fetchedAtMs);
  const expanded = Boolean(meta?.expanded);
  const ageText = age ? ` · ${age.toUpperCase()}` : '';
  return {
    id: AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID,
    position,
    variant: 'thumbnail',
    paintLane: 'thumbnail',
    title: `AEMET SEA SURFACE TEMP${ageText}${expanded ? ' · CLICK TO COLLAPSE' : ''}`,
    details: [],
    image: imageSlot,
    requireImage: true,
    accent: ACCENT,
    priority: expanded ? Number.MAX_SAFE_INTEGER : 500_000,
    // Deliberately NEVER `selected: true` on a thumbnail variant — see
    // aemetLightning.js's detailed note on why that breaks
    // `measureOverlayEntry`'s sizing branch.
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

/** Validate `/api/aemet/sea-surface-temp/status`'s payload shape. */
export function normalizeAemetSeaSurfaceTempStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    hasKey: Boolean(payload.hasKey),
    lastFetch: Number.isFinite(payload.lastFetch) ? payload.lastFetch : null,
    stale: Boolean(payload.stale),
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

export function createAemetSeaSurfaceTempLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  loadImage = defaultLoadImage,
} = {}) {
  let _enabled = false;
  let _lastError = null;
  /** @type {{frame: unknown, stamp: number}|null} */
  let _imageSlot = null;
  /** @type {number|null} the `lastFetch` we've already loaded an image for — re-load only when this moves */
  let _loadedFetchedAtMs = null;
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
      AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID,
      [createAemetSeaSurfaceTempOverlayEntry(_imageSlot, { fetchedAtMs: _loadedFetchedAtMs, expanded: _expanded }, position)],
      AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function _setExpanded(next) {
    if (_expanded === next) return;
    _expanded = next;
    _publish();
  }

  // Real Cesium.ScreenSpaceEventHandler/document listeners need a real
  // browser DOM (throws "document is not defined" under plain Node) — same
  // constraint every other click-to-inspect layer in this app has.
  const hasDom = () => typeof document !== 'undefined';

  function _installClickHandler(viewer) {
    if (_clickHandler || !hasDom() || !viewer?.scene?.canvas) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      // A real Cesium entity under the click belongs to whichever layer owns
      // it — never steal that click just because our card happens to be
      // nearby on screen (mirrors firmsHeatmap.js's ambient-card pattern).
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer('aemet-sea-surface-temp', pickedId)) return;
      }
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID,
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

  const layer = {
    id: 'aemet-sea-surface-temp',
    name: 'AEMET Sea Surface Temperature',
    icon: '🌊',
    source: 'AEMET OpenData · EUMETSAT OSI SAF',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _lastError = null;
      _imageSlot = null;
      _loadedFetchedAtMs = null;
      _expanded = false;
      overlayHost.setVisible(AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetSeaSurfaceTemp] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      overlayHost.setVisible(AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer || _viewer);
      _publish(); // redisplay instantly if an image was already loaded from a prior enable
    },

    disable() {
      _enabled = false;
      _expanded = false; // a re-enable starts back at the small ambient card
      overlayHost.setVisible(AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID, false);
      _removeClickHandler();
      _loadToken += 1; // a still-loading image must not apply after this
    },

    async update() {
      try {
        const response = await fetch(STATUS_URL);
        if (!response.ok) {
          _lastError = `AEMET HTTP ${response.status}`;
          return false;
        }
        const status = normalizeAemetSeaSurfaceTempStatus(await response.json());
        if (!status) {
          _lastError = 'Malformed AEMET response';
          return false;
        }
        if (!status.hasKey) {
          _lastError = 'AEMET_API_KEY not configured';
          return false;
        }
        _lastError = status.stale ? 'Serving stale AEMET data (upstream unavailable)' : null;
        // `lastFetch: null` means the PROXY itself has never fetched anything
        // yet, not "nothing new" — on first boot this must still fall
        // through to a load. Otherwise skip only when the timestamp hasn't moved.
        const neverLoaded = _loadedFetchedAtMs === null;
        if (!neverLoaded && status.lastFetch === _loadedFetchedAtMs) return true;

        const token = ++_loadToken;
        const cacheBustUrl = `${IMAGE_URL}?ts=${encodeURIComponent(status.lastFetch ?? Date.now())}`;
        const image = await loadImage(cacheBustUrl);
        if (token !== _loadToken) return true; // superseded by a disable or a newer poll
        if (!image) {
          _lastError = 'AEMET sea-surface-temp image failed to load';
          return false;
        }
        // Bootstrap case: the request above is what MADE the proxy fetch, so
        // `status.lastFetch` (read before that request) is still stale/null —
        // re-read it now that the proxy's cache is actually populated.
        let fetchedAtMs = status.lastFetch;
        if (fetchedAtMs === null) {
          try {
            const refreshed = normalizeAemetSeaSurfaceTempStatus(await (await fetch(STATUS_URL)).json());
            fetchedAtMs = refreshed?.lastFetch ?? Date.now();
          } catch {
            fetchedAtMs = Date.now();
          }
        }
        _imageSlot = { frame: image, stamp: Date.now() };
        _loadedFetchedAtMs = fetchedAtMs;
        _publish();
        console.log('[Data:AemetSeaSurfaceTemp] Updated: new composite loaded');
        return true;
      } catch (e) {
        console.warn('[Data:AemetSeaSurfaceTemp] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      _expanded = false;
      _loadToken += 1;
      _removeClickHandler();
      overlayHost.setVisible(AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID, false);
      overlayHost.clearSource(AEMET_SEA_SURFACE_TEMP_OVERLAY_SOURCE_ID);
      _imageSlot = null;
      _loadedFetchedAtMs = null;
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

    // Test-only hooks: exercise the click-to-expand state machine directly,
    // bypassing Cesium.ScreenSpaceEventHandler/document (unavailable under
    // plain Node), same as every other click-to-inspect layer's own hooks.
    _hasImageForTest() {
      return Boolean(_imageSlot);
    },
    _loadedFetchedAtForTest() {
      return _loadedFetchedAtMs;
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

const aemetSeaSurfaceTempLayer = createAemetSeaSurfaceTempLayer();

export default aemetSeaSurfaceTempLayer;
