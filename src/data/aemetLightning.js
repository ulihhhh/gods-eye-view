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
 * AEMET OpenData lightning-activity composite (Phase A4) — a single ambient
 * "picture-in-picture" thumbnail over Spain, NOT a polled entity layer like
 * `aemet-stations`/`aemet-warnings`.
 *
 * AEMET's `red/rayos/mapa` exposes no strike coordinate list — only a
 * pre-rendered GIF (confirmed live: `image/gif`, 640×480) with a province-
 * outline map, plotted strikes, and a legend strip baked into the pixels.
 * There is no bounding box anywhere in the API response, so it cannot be
 * draped as a geo-referenced `Cesium.ImageryLayer` the way a real raster
 * (e.g. Phase A3's radar, once unblocked) could be — the only honest
 * placement is a fixed reference anchor over the country it depicts, the
 * same "world-overlay thumbnail" mechanism `cctvCards.js` already uses for
 * camera preview images (`variant: 'thumbnail'`, an `HTMLImageElement`
 * handed to the shared canvas painter via `image: {frame, stamp}`) — reused
 * here directly rather than inventing a second image-thumbnail mechanism.
 *
 * Refreshes only when the underlying image actually changes (AEMET updates
 * it roughly every 6 hours; the proxy caches for exactly that long), not on
 * every poll — `update()` cheaply checks `/api/aemet/lightning/status` and
 * only loads the actual image bytes when its `lastFetch` timestamp moves.
 */

export const AEMET_LIGHTNING_OVERLAY_SOURCE_ID = 'aemet-lightning';
export const AEMET_LIGHTNING_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  // Unlike stations'/warnings' SELECTED sources (capacity 0 — a `protected`
  // entry bypasses the collision budget entirely), this is a normal AMBIENT
  // entry that has to actually claim a collision-avoidance slot to be
  // painted at all. 1 is enough since this source only ever holds one entry.
  collisionCapacity: 1,
  moving: false,
});

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

const STATUS_URL = '/api/aemet/lightning/status';
const IMAGE_URL = '/api/aemet/lightning';

/**
 * Fixed reference point over central Spain — a deliberate placement choice,
 * not a derived one: this composite has no embedded geography to anchor to,
 * so it sits over the country it summarizes, the same way a printed wall
 * map's legend sits over the region it describes rather than at a specific
 * coordinate within it.
 */
const ANCHOR_LON = -3.7;
const ANCHOR_LAT = 40.0;

const THUMBNAIL_WIDTH_PX = 168;
const THUMBNAIL_HEIGHT_PX = 126; // matches the real image's 4:3 aspect ratio
// Clicked/expanded size — close to the real image's native 640×480 (still
// below it, so this is a straight canvas `drawImage` scale-up of already-
// captured pixels, not an upscale past source resolution) so the baked-in
// province labels and legend strip are actually legible, per the ambient
// thumbnail being reported too small to read anything from.
const EXPANDED_WIDTH_PX = 560;
const EXPANDED_HEIGHT_PX = 420;
const ACCENT = 'rgb(255, 214, 61)'; // lightning yellow, distinct from every other layer's palette

/** `Date` diff → a short "Xm ago" / "Xh ago" label, or `null` for no timestamp. */
function relativeAgeLabel(fetchedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(fetchedAtMs)) return null;
  // Floor, not round: a fetch 89s ago must read "1m ago", not round up to "2m"
  // — and anything under a full minute is "just now" rather than "0m ago".
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Build the thumbnail entry — the small always-on ambient card by default,
 * or the large click-to-expand one when `meta.expanded` is set. Pure aside
 * from the caller-supplied `imageSlot` (an `{frame, stamp}` pair, mirroring
 * `cctvCards.js`'s frame-slot shape) — exported for tests.
 * @param {{frame: unknown, stamp: number}} imageSlot
 * @param {{fetchedAtMs: number|null, expanded?: boolean}} meta
 * @param {Cesium.Cartesian3} position
 * @returns {object}
 */
export function createAemetLightningOverlayEntry(imageSlot, meta, position) {
  const age = relativeAgeLabel(meta?.fetchedAtMs);
  const expanded = Boolean(meta?.expanded);
  const ageText = age ? ` · ${age.toUpperCase()}` : '';
  return {
    id: AEMET_LIGHTNING_OVERLAY_SOURCE_ID,
    position,
    variant: 'thumbnail',
    paintLane: 'thumbnail',
    title: `AEMET LIGHTNING${ageText}${expanded ? ' · CLICK TO COLLAPSE' : ''}`,
    details: [],
    image: imageSlot,
    requireImage: true,
    accent: ACCENT,
    // Expanded is a deliberate, user-requested view — `protected: true`
    // guarantees it stays on screen regardless of the collision budget.
    // Deliberately NEVER `selected: true` here, even though stations'/
    // warnings' own protected click-to-inspect cards set it: `variant:
    // 'thumbnail'` and `selected: true` disagreeing sends
    // `measureOverlayEntry` (worldOverlayDraw.js) down the *selected*-card
    // sizing branch instead of the thumbnail one, which never reads
    // `thumbnailWidth`/`thumbnailHeight` at all — the measured rect collapses
    // to title-text size and the image is drawn far outside it. Confirmed
    // live (the expanded card rendered as an empty title bar, no image) and
    // fixed by matching `cctvCards.js`'s own thumbnail entries, which hard-
    // code `selected: false` regardless of active/protected state for
    // exactly this reason.
    priority: expanded ? Number.MAX_SAFE_INTEGER : 500_000,
    selected: false,
    protected: expanded,
    collisionGroup: 'ambient-card',
    // Always clickable: collapsed → expand, expanded → collapse (see
    // `_installClickHandler`'s toggle logic).
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

/** Validate `/api/aemet/lightning/status`'s payload shape. */
export function normalizeAemetLightningStatus(payload) {
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

export function createAemetLightningLayer({
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
      AEMET_LIGHTNING_OVERLAY_SOURCE_ID,
      [createAemetLightningOverlayEntry(_imageSlot, { fetchedAtMs: _loadedFetchedAtMs, expanded: _expanded }, position)],
      AEMET_LIGHTNING_OVERLAY_SOURCE_OPTIONS,
    );
  }

  function _setExpanded(next) {
    if (_expanded === next) return;
    _expanded = next;
    _publish();
  }

  // Real Cesium.ScreenSpaceEventHandler/document listeners need a real
  // browser DOM (throws "document is not defined" under plain Node) — same
  // constraint every other click-to-inspect layer in this app has (see
  // aemetStations.js's hasDom()).
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
        if (pickedId && isOwnedByOtherLayer('aemet-lightning', pickedId)) return;
      }
      const hit = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: AEMET_LIGHTNING_OVERLAY_SOURCE_ID,
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
    id: 'aemet-lightning',
    name: 'AEMET Lightning Activity',
    icon: '⚡',
    source: 'AEMET OpenData · Spain',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _lastError = null;
      _imageSlot = null;
      _loadedFetchedAtMs = null;
      _expanded = false;
      overlayHost.setVisible(AEMET_LIGHTNING_OVERLAY_SOURCE_ID, false);
      console.log('[Data:AemetLightning] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      overlayHost.setVisible(AEMET_LIGHTNING_OVERLAY_SOURCE_ID, true);
      _installClickHandler(viewer || _viewer);
      _publish(); // redisplay instantly if an image was already loaded from a prior enable
    },

    disable() {
      _enabled = false;
      _expanded = false; // a re-enable starts back at the small ambient card
      overlayHost.setVisible(AEMET_LIGHTNING_OVERLAY_SOURCE_ID, false);
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
        const status = normalizeAemetLightningStatus(await response.json());
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
        // yet (status alone never triggers that — only a request to the
        // image route does), not "nothing new": on first boot this must
        // still fall through to a load, or the proxy would never populate.
        // Otherwise, skip only when the proxy's own timestamp hasn't moved.
        const neverLoaded = _loadedFetchedAtMs === null;
        if (!neverLoaded && status.lastFetch === _loadedFetchedAtMs) return true;

        const token = ++_loadToken;
        const cacheBustUrl = `${IMAGE_URL}?ts=${encodeURIComponent(status.lastFetch ?? Date.now())}`;
        const image = await loadImage(cacheBustUrl);
        if (token !== _loadToken) return true; // superseded by a disable or a newer poll
        if (!image) {
          _lastError = 'AEMET lightning image failed to load';
          return false;
        }
        // Bootstrap case: the request above is what MADE the proxy fetch, so
        // `status.lastFetch` (read before that request) is still stale/null —
        // re-read it now that the proxy's cache is actually populated, rather
        // than approximating with our own clock.
        let fetchedAtMs = status.lastFetch;
        if (fetchedAtMs === null) {
          try {
            const refreshed = normalizeAemetLightningStatus(await (await fetch(STATUS_URL)).json());
            fetchedAtMs = refreshed?.lastFetch ?? Date.now();
          } catch {
            fetchedAtMs = Date.now();
          }
        }
        _imageSlot = { frame: image, stamp: Date.now() };
        _loadedFetchedAtMs = fetchedAtMs;
        _publish();
        console.log('[Data:AemetLightning] Updated: new composite loaded');
        return true;
      } catch (e) {
        console.warn('[Data:AemetLightning] Fetch error:', e);
        _lastError = 'AEMET network error';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      _expanded = false;
      _loadToken += 1;
      _removeClickHandler();
      overlayHost.setVisible(AEMET_LIGHTNING_OVERLAY_SOURCE_ID, false);
      overlayHost.clearSource(AEMET_LIGHTNING_OVERLAY_SOURCE_ID);
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
    // plain Node — see hasDom() above), same as every other click-to-inspect
    // layer's own test hooks.
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

const aemetLightningLayer = createAemetLightningLayer();

export default aemetLightningLayer;
