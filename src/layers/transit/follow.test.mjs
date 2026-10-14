import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  FOLLOW_RANGE_M,
  TRANSIT_FOLLOW_NOTICE_SOURCE_ID,
  angleDelta,
  courseOf,
  createFollow,
  followCardLine,
  smoothCourse,
} from './follow.js';
import { TRANSIT_SELECTED_OVERLAY_SOURCE_ID } from './policy.js';

test('angles wrap the short way and the course smooths toward its target', () => {
  assert.ok(Math.abs(angleDelta(Math.PI - 0.1, -Math.PI + 0.1) - 0.2) < 1e-9);
  assert.ok(Math.abs(angleDelta(0.1, -0.1) + 0.2) < 1e-9);
  assert.equal(smoothCourse(null, 1, 16), 1, 'first course is taken as is');
  const half = smoothCourse(0, 1, 2500 * Math.LN2);
  assert.ok(Math.abs(half - 0.5) < 1e-9, `${half}`);
  assert.equal(smoothCourse(0.3, 1, 0), 0.3);
  assert.ok(Math.abs(courseOf(1, 0) - Math.PI / 2) < 1e-9, 'east');
  assert.equal(courseOf(0, 1), 0, 'north');
  assert.match(followCardLine(false), /press T to follow/);
  assert.match(followCardLine(true), /Following/);
});

/**
 * A camera that keeps Cesium's contract for what follow.js uses: a
 * reference frame (`transform`), local position/direction/up/right, and
 * `lookAtTransform(m)` keeping the world pose. Flights are recorded and
 * finished by the test.
 */
function fakeCamera() {
  const camera = {
    transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    position: new Cesium.Cartesian3(),
    direction: new Cesium.Cartesian3(),
    up: new Cesium.Cartesian3(),
    right: new Cesium.Cartesian3(),
    heading: 0,
    flights: [],
    _currentFlight: undefined,
    world() {
      return Cesium.Matrix4.multiplyByPoint(
        camera.transform,
        camera.position,
        new Cesium.Cartesian3(),
      );
    },
    lookAtTransform(m) {
      const world = camera.world();
      const dir = Cesium.Matrix4.multiplyByPointAsVector(
        camera.transform,
        camera.direction,
        new Cesium.Cartesian3(),
      );
      const up = Cesium.Matrix4.multiplyByPointAsVector(
        camera.transform,
        camera.up,
        new Cesium.Cartesian3(),
      );
      camera.transform = Cesium.Matrix4.clone(m);
      const inv = Cesium.Matrix4.inverseTransformation(m, new Cesium.Matrix4());
      Cesium.Matrix4.multiplyByPoint(inv, world, camera.position);
      Cesium.Matrix4.multiplyByPointAsVector(inv, dir, camera.direction);
      Cesium.Matrix4.multiplyByPointAsVector(inv, up, camera.up);
    },
    flyToBoundingSphere(sphere, options) {
      camera.flights.push({ sphere, options });
      // Land at the requested chase offset, in world coordinates.
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(sphere.center);
      const { heading, pitch, range } = options.offset;
      const local = new Cesium.Cartesian3(
        -Math.sin(heading) * Math.cos(pitch) * range,
        -Math.cos(heading) * Math.cos(pitch) * range,
        -Math.sin(pitch) * range,
      );
      camera.transform = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
      Cesium.Matrix4.multiplyByPoint(enu, local, camera.position);
      const toTarget = Cesium.Cartesian3.subtract(
        sphere.center,
        camera.position,
        new Cesium.Cartesian3(),
      );
      Cesium.Cartesian3.normalize(toTarget, camera.direction);
      Cesium.Cartesian3.normalize(sphere.center, camera.up);
    },
    cancelFlight() {},
  };
  return camera;
}

function harness() {
  const camera = fakeCamera();
  const preUpdate = new Cesium.Event();
  const overlays = new Map();
  const refreshes = [];
  let cardHit = false;
  const start = Cesium.Cartesian3.fromDegrees(2.15, 41.4, 30);
  const entry = {
    key: 'fgc:1',
    record: { routeId: 'S1', bearing: 90 },
    marker: { show: true, position: Cesium.Cartesian3.clone(start) },
  };
  const state = {
    _viewer: {
      camera,
      trackedEntity: undefined,
      isDestroyed: () => false,
      scene: {
        mode: Cesium.SceneMode.SCENE3D,
        preUpdate,
        globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      },
    },
    _selectedKey: 'fgc:1',
    _vehicles: new Map([['fgc:1', entry]]),
    _overlayHost: {
      setEntries: (id, entries) => overlays.set(id, entries),
      clearSource: (id) => overlays.delete(id),
    },
  };
  const follow = createFollow({
    state,
    services: {
      render: { governorRequestRender() {} },
      overlays: {
        hitTestWorldOverlay: (x, y, { sourceId }) =>
          cardHit && sourceId === TRANSIT_SELECTED_OVERLAY_SOURCE_ID
            ? { sourceId }
            : null,
      },
    },
    parts: { selection: { refreshSelectedCard: (f) => refreshes.push(f) } },
  });
  /** Move the drawn marker `metres` east and/or north, then run a frame. */
  const move = (east, north) => {
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
      entry.marker.position,
    );
    Cesium.Matrix4.multiplyByPoint(
      enu,
      new Cesium.Cartesian3(east, north, 0),
      entry.marker.position,
    );
    preUpdate.raiseEvent();
  };
  return {
    camera,
    entry,
    state,
    follow,
    overlays,
    refreshes,
    move,
    frame: () => preUpdate.raiseEvent(),
    hitCard: (hit) => (cardHit = hit),
    preUpdate,
  };
}

const distance = (a, b) => Cesium.Cartesian3.distance(a, b);

test('following flies to a chase view, then carries the camera with the train', () => {
  const app = harness();
  assert.equal(app.follow.start(), true);
  assert.equal(app.follow.isFollowing(), true);
  assert.equal(app.camera.flights.length, 1);
  const { offset } = app.camera.flights[0].options;
  assert.equal(offset.range, FOLLOW_RANGE_M);
  assert.ok(Math.abs(offset.heading - Math.PI / 2) < 1e-9, 'behind, eastbound');
  app.camera.flights[0].options.complete();

  app.frame(); // adopts the vehicle's frame
  const range = distance(app.camera.world(), app.entry.marker.position);
  assert.ok(Math.abs(range - FOLLOW_RANGE_M) < 1, `${range}`);
  for (let i = 0; i < 20; i += 1) app.move(10, 0); // 200 m east
  const after = distance(app.camera.world(), app.entry.marker.position);
  assert.ok(Math.abs(after - FOLLOW_RANGE_M) < 1, `range kept: ${after}`);
  assert.equal(app.refreshes.length >= 1, true, 'card says Following');
});

test('a curve turns the view smoothly, never in one jump', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock += 100)); // 10 fps
  const app = harness();
  app.follow.start();
  app.camera.flights[0].options.complete();
  app.frame();
  const bearingOfCamera = () => {
    // The camera's horizontal direction in the vehicle's frame.
    const d = app.camera.direction;
    return Math.atan2(d.x, d.y);
  };
  const before = bearingOfCamera();
  let largest = 0;
  let previous = before;
  for (let i = 0; i < 100; i += 1) {
    app.move(0, 10); // the train now runs north
    const now = bearingOfCamera();
    largest = Math.max(largest, Math.abs(angleDelta(previous, now)));
    previous = now;
  }
  assert.ok(Math.abs(angleDelta(before, 0)) > 1, 'started facing east');
  assert.ok(Math.abs(angleDelta(previous, 0)) < 0.1, 'ends facing north');
  assert.ok(largest < 0.1, `largest step ${largest} rad`);
});

test('following ends on T, on another camera owner, and on the card', () => {
  const app = harness();
  app.follow.start();
  app.camera.flights[0].options.complete();
  app.frame();
  assert.equal(app.follow.toggle(), false);
  assert.equal(app.follow.isFollowing(), false);
  assert.ok(
    Cesium.Matrix4.equals(app.camera.transform, Cesium.Matrix4.IDENTITY),
    'camera handed back in world coordinates',
  );

  app.follow.start();
  app.camera.flights[1].options.complete();
  app.frame();
  app.state._viewer.trackedEntity = {}; // aircraft tracking took over
  app.frame();
  assert.equal(app.follow.isFollowing(), false);
  app.state._viewer.trackedEntity = undefined;

  app.hitCard(true);
  assert.equal(app.follow.handleCardClick({ x: 1, y: 1 }), true);
  assert.equal(app.follow.isFollowing(), true, 'the card starts it');
  assert.equal(app.follow.handleCardClick({ x: 1, y: 1 }), true);
  assert.equal(app.follow.isFollowing(), false, 'and stops it');
  app.hitCard(false);
  assert.equal(app.follow.handleCardClick({ x: 1, y: 1 }), false);
});

test('a train that leaves the feed ends the follow and says so', () => {
  const app = harness();
  app.follow.start();
  app.camera.flights[0].options.complete();
  app.frame();
  app.entry.marker.show = false;
  app.frame();
  assert.equal(app.follow.isFollowing(), true, 'a hidden marker holds');
  app.entry.marker.show = true;
  app.follow.stop('gone');
  const notice = app.overlays.get(TRANSIT_FOLLOW_NOTICE_SOURCE_ID);
  assert.equal(notice?.[0]?.title, 'Route S1');
  assert.match(notice[0].details[0], /no longer in the feed/);
  app.follow.destroy();
  assert.equal(app.overlays.has(TRANSIT_FOLLOW_NOTICE_SOURCE_ID), false);
});
