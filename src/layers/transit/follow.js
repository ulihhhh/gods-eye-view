import * as Cesium from 'cesium';
import {
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  createTransitSelectedOverlayEntry,
} from './policy.js';

/**
 * Follow the selected vehicle with the camera (fork-local; the aircraft
 * layers track with `viewer.trackedEntity`, but Transit draws billboards,
 * not entities).
 *
 * Following works like Cesium's own entity tracking: after a short flight
 * to a chase view, the camera's reference frame is the vehicle's local
 * east-north-up frame, moved to the DRAWN position every frame, so the
 * reader can still orbit, tilt and zoom around the train while it runs. The
 * view also turns, smoothed, with the vehicle's course along the track.
 *
 * It ends when the card closes (click elsewhere, Escape), when T (F is the
 * layer panel's) or the card is pressed again, when something else takes the camera (a flight, aircraft
 * tracking), or when the vehicle leaves the feed — the one case said on the
 * map, because the camera stops for no visible reason.
 */

/** Chase view the follow starts from: range and pitch. */
export const FOLLOW_RANGE_M = 700;
export const FOLLOW_PITCH_RAD = Cesium.Math.toRadians(-35);
const FOLLOW_FLIGHT_S = 1.2;
/** Course smoothing time constant, and the least movement that sets one. */
export const FOLLOW_COURSE_TAU_MS = 2500;
const COURSE_MIN_STEP_M = 2;
/** How long the "stopped following" note stays on the map. */
const NOTICE_MS = 5000;
export const TRANSIT_FOLLOW_NOTICE_SOURCE_ID = 'transit-follow-notice';

/** Shortest signed angle from `from` to `to`, radians in (−π, π]. */
export function angleDelta(from, to) {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Exponentially smoothed course: moves `current` toward `target` by the
 * share of the gap a time constant `tauMs` allows in `dtMs`.
 * @returns {number} radians
 */
export function smoothCourse(
  current,
  target,
  dtMs,
  tauMs = FOLLOW_COURSE_TAU_MS,
) {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target) || !(dtMs > 0)) return current;
  const share = 1 - Math.exp(-dtMs / tauMs);
  return current + angleDelta(current, target) * share;
}

/** Course (radians clockwise from north) of an east/north displacement. */
export function courseOf(east, north) {
  return Math.atan2(east, north);
}

/** The card's line about following. */
export function followCardLine(following) {
  return following
    ? 'Following · click this card or press T to stop'
    : 'Click this card or press T to follow';
}

export function createFollow({ state, services, parts }) {
  /** @type {null|{key: string, phase: 'flying'|'following', transform: Cesium.Matrix4|null, last: Cesium.Cartesian3|null, course: number|null, heading: number|null, at: number, remove: () => void}} */
  let follow = null;
  let noticeTimer = null;
  const scratchEnu = new Cesium.Matrix4();
  const scratchInverse = new Cesium.Matrix4();
  const scratchDelta = new Cesium.Cartesian3();
  const scratchRotation = new Cesium.Matrix3();
  const scratchQuaternion = new Cesium.Quaternion();

  const viewer = () => state._viewer;
  const markerPosition = (entry) => {
    const p = entry?.marker?.show !== false ? entry?.marker?.position : null;
    return p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Number.isFinite(p.z)
      ? p
      : null;
  };

  function isFollowing(key = state._selectedKey) {
    return Boolean(follow && key && follow.key === key);
  }

  function showNotice(position, title) {
    clearTimeout(noticeTimer);
    const card = createTransitSelectedOverlayEntry(
      'follow-notice',
      Cesium.Cartesian3.clone(position),
      { title, details: ['Stopped following: no longer in the feed'] },
      'unknown',
    );
    if (!card) return;
    state._overlayHost.setEntries(
      TRANSIT_FOLLOW_NOTICE_SOURCE_ID,
      [card],
      TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
    );
    noticeTimer = setTimeout(() => {
      state._overlayHost.clearSource(TRANSIT_FOLLOW_NOTICE_SOURCE_ID);
    }, NOTICE_MS);
  }

  /**
   * Stop following. `reason` 'gone' (the vehicle left the feed) leaves a
   * short note where it was; every other reason is silent.
   * @param {'gone'|'closed'|'user'|'camera'} [reason]
   */
  function stop(reason = 'closed') {
    if (!follow) return;
    const ended = follow;
    follow = null;
    ended.remove();
    const v = viewer();
    if (v && !v.isDestroyed()) {
      const camera = v.camera;
      if (ended.phase === 'flying') camera.cancelFlight();
      // Hand the camera back in world coordinates, exactly where it is.
      if (
        ended.transform &&
        Cesium.Matrix4.equals(camera.transform, ended.transform)
      )
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      if (reason === 'gone') {
        const entry = state._vehicles.get(ended.key);
        const at = markerPosition(entry) || ended.last;
        if (at)
          showNotice(
            at,
            entry?.record?.routeId
              ? `Route ${entry.record.routeId}`
              : 'Transit vehicle',
          );
      }
    }
    if (reason !== 'gone' && state._selectedKey === ended.key)
      parts.selection.refreshSelectedCard(true);
    services.render.governorRequestRender('transit-follow');
  }

  function frame() {
    const v = viewer();
    if (!follow || !v || v.isDestroyed()) return;
    if (follow.phase !== 'following') return;
    const camera = v.camera;
    // Something else took the camera: a flight, aircraft tracking, a reset.
    if (
      v.trackedEntity ||
      camera._currentFlight ||
      v.scene.mode !== Cesium.SceneMode.SCENE3D ||
      (follow.transform &&
        !Cesium.Matrix4.equals(camera.transform, follow.transform))
    ) {
      stop('camera');
      return;
    }
    const entry = state._vehicles.get(follow.key);
    if (!entry?.marker) {
      stop('gone');
      return;
    }
    // A marker hidden for a moment (a reset, a height wait) holds the view.
    const p = markerPosition(entry);
    if (!p) return;
    const now = performance.now();
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
      p,
      v.scene.globe.ellipsoid,
      scratchEnu,
    );
    let turn = 0;
    if (follow.last) {
      // Course from the drawn movement, in the vehicle's own frame.
      Cesium.Matrix4.inverseTransformation(enu, scratchInverse);
      Cesium.Cartesian3.subtract(p, follow.last, scratchDelta);
      Cesium.Matrix4.multiplyByPointAsVector(
        scratchInverse,
        scratchDelta,
        scratchDelta,
      );
      if (Math.hypot(scratchDelta.x, scratchDelta.y) >= COURSE_MIN_STEP_M) {
        follow.course = courseOf(scratchDelta.x, scratchDelta.y);
        follow.last = Cesium.Cartesian3.clone(p, follow.last);
      }
      if (Number.isFinite(follow.course)) {
        const next = smoothCourse(
          follow.heading,
          follow.course,
          now - follow.at,
        );
        if (Number.isFinite(follow.heading))
          turn = angleDelta(follow.heading, next);
        follow.heading = next;
      }
    } else {
      follow.last = Cesium.Cartesian3.clone(p);
    }
    follow.at = now;
    if (!follow.transform) {
      // First frame: adopt the pose the flight left, in the vehicle's frame.
      camera.lookAtTransform(enu);
    } else {
      // Keep the camera's pose RELATIVE to the vehicle (what the reader
      // orbited or zoomed to), turned with its course, in the new frame.
      const position = Cesium.Cartesian3.clone(camera.position);
      const direction = Cesium.Cartesian3.clone(camera.direction);
      const up = Cesium.Cartesian3.clone(camera.up);
      if (turn) {
        // Clockwise course change → rotate the view about local up by −turn.
        Cesium.Quaternion.fromAxisAngle(
          Cesium.Cartesian3.UNIT_Z,
          -turn,
          scratchQuaternion,
        );
        Cesium.Matrix3.fromQuaternion(scratchQuaternion, scratchRotation);
        Cesium.Matrix3.multiplyByVector(scratchRotation, position, position);
        Cesium.Matrix3.multiplyByVector(scratchRotation, direction, direction);
        Cesium.Matrix3.multiplyByVector(scratchRotation, up, up);
      }
      camera.lookAtTransform(enu);
      Cesium.Cartesian3.clone(position, camera.position);
      Cesium.Cartesian3.clone(direction, camera.direction);
      Cesium.Cartesian3.clone(up, camera.up);
      Cesium.Cartesian3.cross(direction, up, camera.right);
    }
    follow.transform = Cesium.Matrix4.clone(camera.transform, follow.transform);
  }

  /** Start following the selected vehicle. */
  function start() {
    const v = viewer();
    const key = state._selectedKey;
    const entry = key ? state._vehicles.get(key) : null;
    const p = markerPosition(entry);
    if (!v || !p || v.scene.mode !== Cesium.SceneMode.SCENE3D) return false;
    stop('user');
    if (v.trackedEntity) v.trackedEntity = undefined;
    const remove = v.scene.preUpdate.addEventListener(frame);
    follow = {
      key,
      phase: 'flying',
      transform: null,
      last: null,
      course: null,
      heading: null,
      at: performance.now(),
      remove,
    };
    const mine = follow;
    // Behind the vehicle when its course is known, else as the camera faces.
    const course = Number.isFinite(entry.courseDeg)
      ? Cesium.Math.toRadians(entry.courseDeg)
      : Number.isFinite(entry.record?.bearing)
        ? Cesium.Math.toRadians(entry.record.bearing)
        : v.camera.heading;
    mine.course = course;
    mine.heading = course;
    const begin = () => {
      if (follow !== mine) return;
      mine.phase = 'following';
      mine.at = performance.now();
    };
    v.camera.flyToBoundingSphere(new Cesium.BoundingSphere(p, 20), {
      offset: new Cesium.HeadingPitchRange(
        course,
        FOLLOW_PITCH_RAD,
        FOLLOW_RANGE_M,
      ),
      duration: FOLLOW_FLIGHT_S,
      complete: begin,
      cancel: begin,
    });
    parts.selection.refreshSelectedCard(true);
    services.render.governorRequestRender('transit-follow');
    return true;
  }

  function toggle() {
    if (isFollowing()) {
      stop('user');
      return false;
    }
    return start();
  }

  function destroy() {
    stop('closed');
    clearTimeout(noticeTimer);
    noticeTimer = null;
    state._overlayHost.clearSource(TRANSIT_FOLLOW_NOTICE_SOURCE_ID);
  }

  /**
   * A click on the selected vehicle's card toggles following.
   * @returns {boolean} Whether the click was the card's.
   */
  function handleCardClick(position) {
    if (!state._selectedKey) return false;
    const hit = services.overlays?.hitTestWorldOverlay?.(
      position?.x,
      position?.y,
      { sourceId: TRANSIT_SELECTED_OVERLAY_SOURCE_ID },
    );
    if (!hit) return false;
    toggle();
    return true;
  }

  return {
    isFollowing,
    start,
    stop,
    toggle,
    destroy,
    handleCardClick,
    cardLine: (key) => followCardLine(isFollowing(key)),
  };
}
