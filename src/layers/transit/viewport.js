import * as Cesium from 'cesium';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  RANGE_SLACK_KM,
  inflateViewBounds,
} from './policy.js';
import {
  getRegisteredTransitFeed,
  transitFeedsInRange,
} from '../../data/transitFeeds.js';

/** How often the server's catalog is re-read while an estimated row is near. */
export const OFFERED_ESTIMATES_REFRESH_MS = 5 * 60_000;
/** How soon a failed catalog read is retried. */
export const OFFERED_ESTIMATES_RETRY_MS = 60_000;

/**
 * Camera-driven feed activation: only the feeds whose coverage circle contains
 * the look-at point are polled, and only below the altitude gate.
 * @param {object} context
 * @returns {object}
 */
export function createViewport({ state, services, parts, source }) {
  const { governorRequestRender } = services.render;

  /**
   * Fork-only: which estimated feeds the server actually serves. Asked only
   * once an estimated row covers the view, again every
   * OFFERED_ESTIMATES_REFRESH_MS (a key added from POWER UP shows up without
   * a reload), and after OFFERED_ESTIMATES_RETRY_MS when the read failed.
   * Until it answers, estimated rows are not polled: polling one the server
   * does not offer is a 404 every poll and a row saying "unavailable".
   */
  function refreshOfferedEstimates(now = Date.now()) {
    if (state._offeredEstimatesLoading) return;
    if (typeof source?.getFeeds !== 'function') return;
    const wait =
      state._offeredEstimates === null
        ? OFFERED_ESTIMATES_RETRY_MS
        : OFFERED_ESTIMATES_REFRESH_MS;
    if (now - state._offeredEstimatesAt < wait) return;
    state._offeredEstimatesAt = now;
    state._offeredEstimatesLoading = true;
    const generation = state._generation;
    Promise.resolve()
      .then(() => source.getFeeds())
      .then((rows) => {
        state._offeredEstimates = new Set(
          rows
            .map((row) => row?.id)
            .filter((id) => getRegisteredTransitFeed(id)?.estimate),
        );
      })
      .catch(() => {
        // Keep what was known; the next check asks again after the retry wait.
      })
      .finally(() => {
        state._offeredEstimatesLoading = false;
        if (state._enabled && generation === state._generation)
          runProximityCheck();
      });
  }

  /** Whether an estimated feed may be polled now (pill on, server offers it). */
  function estimateServed(feed) {
    return state._offeredEstimates?.has(feed.id) === true;
  }

  function getCameraAltitude(viewer = state._viewer) {
    const carto = viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  function getCameraCenterLatLon(viewer = state._viewer) {
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (rect) {
      const center = Cesium.Rectangle.center(rect);
      return {
        lat: Cesium.Math.toDegrees(center.latitude),
        lon: Cesium.Math.toDegrees(center.longitude),
      };
    }
    const carto = viewer?.camera?.positionCartographic;
    if (carto) {
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      };
    }
    return null;
  }

  function altitudeGateOpen(altitude) {
    if (state._altitudeGateOpen) return altitude <= ACTIVATION_EXIT_ALTITUDE_M;
    return altitude <= ACTIVATION_ENTER_ALTITUDE_M;
  }

  /**
   * Refresh the bounds the per-frame pass uses to decide what is worth
   * animating. Cheap, and only on a settled camera — never per frame.
   */
  function refreshViewBounds() {
    const viewer = state._viewer;
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    state._viewBounds = rect
      ? inflateViewBounds({
          south: Cesium.Math.toDegrees(rect.south),
          north: Cesium.Math.toDegrees(rect.north),
          west: Cesium.Math.toDegrees(rect.west),
          east: Cesium.Math.toDegrees(rect.east),
        })
      : null;
    // The sweep itself is deferred: `marker.show` is a dirty flag, and a drag
    // fires this on every frame, so re-deciding visibility inline would put the
    // whole fleet back into the vertex buffer once a frame — the exact cost
    // this is meant to remove.
    state._visibilityDirty = true;
    state._cameraRevision++;
    parts.rendering.requestVisibility();
  }

  function runProximityCheck() {
    if (
      globalThis.document?.hidden ||
      globalThis.document?.visibilityState === 'hidden'
    )
      return;
    if (!state._enabled || !state._viewer) return;
    refreshViewBounds();
    const altitude = getCameraAltitude();
    state._altitudeGateOpen = altitudeGateOpen(altitude);
    const center = state._altitudeGateOpen ? getCameraCenterLatLon() : null;
    const desired = new Map();
    let estimatedInRange = false;
    if (center) {
      let estimatedNearby = false;
      for (const feed of transitFeedsInRange(center.lat, center.lon)) {
        // Fork-only: estimated feeds follow the row's ESTIMATED pill, and
        // only those the server offers are polled.
        if (feed.estimate) {
          estimatedNearby = true;
          if (!estimateServed(feed)) continue;
          estimatedInRange = true;
          if (!state._showEstimated) continue;
        }
        desired.set(feed.id, feed);
      }
      if (estimatedNearby) refreshOfferedEstimates();
      // Hysteresis: a feed already active stays active a little past its edge.
      for (const feed of transitFeedsInRange(
        center.lat,
        center.lon,
        RANGE_SLACK_KM,
      )) {
        if (!state._activeFeeds.has(feed.id)) continue;
        if (feed.estimate && !estimateServed(feed)) continue;
        if (feed.estimate) estimatedInRange = true;
        if (feed.estimate && !state._showEstimated) continue;
        desired.set(feed.id, feed);
      }
    }
    if (estimatedInRange !== state._estimatedInRange) {
      state._estimatedInRange = estimatedInRange;
      state._dataManager?.refreshLayerStats?.();
    }
    for (const feedId of [...state._activeFeeds.keys()]) {
      if (!desired.has(feedId)) {
        state._inFlight.get(feedId)?.controller.abort();
        state._inFlight.delete(feedId);
        state._activeFeeds.delete(feedId);
        state._feedStatus.delete(feedId);
        parts.ingestion.removeFeedVehicles(feedId);
      }
    }
    for (const [feedId, feed] of desired) {
      if (!state._activeFeeds.has(feedId)) {
        state._activeFeeds.set(feedId, feed);
        void parts.ingestion.pollFeed(feed, state._generation);
      }
    }
    parts.ingestion.sweepAgedVehicles(Date.now());
    parts.rendering.syncRenderHold();
    governorRequestRender('transit-proximity');
  }

  function onCameraChanged() {
    // The bounds update immediately; the feed proximity check stays debounced.
    // A person dragging the globe should not wait a third of a second for the
    // vehicles under the cursor to start moving again.
    refreshViewBounds();
    clearTimeout(state._cameraDebounceTimer);
    state._cameraDebounceTimer = setTimeout(() => {
      state._cameraDebounceTimer = null;
      runProximityCheck();
    }, CAMERA_DEBOUNCE_MS);
  }

  return {
    refreshViewBounds,
    getCameraAltitude,
    getCameraCenterLatLon,
    altitudeGateOpen,
    runProximityCheck,
    onCameraChanged,
  };
}
