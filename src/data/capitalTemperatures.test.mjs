// src/data/capitalTemperatures.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findNearestAemetStation,
  buildCapitalTemperatureRecords,
} from './capitalTemperatures.js';

const MADRID = { id: 'madrid', name: 'Madrid', lat: 40.4168, lon: -3.7038 };
const BARCELONA = { id: 'barcelona', name: 'Barcelona', lat: 41.3874, lon: 2.1686 };

test('findNearestAemetStation picks the closer of two stations', () => {
  const near = { id: 'near', lat: 40.42, lon: -3.70, temperatureC: 22 };
  const far = { id: 'far', lat: 41.0, lon: -3.0, temperatureC: 10 };
  const result = findNearestAemetStation(MADRID, [far, near]);
  assert.equal(result.station.id, 'near');
  assert.ok(result.distanceKm < 10);
});

test('findNearestAemetStation returns null with no stations or an invalid capital', () => {
  assert.equal(findNearestAemetStation(MADRID, []), null);
  assert.equal(findNearestAemetStation(MADRID, null), null);
  assert.equal(findNearestAemetStation({ lat: NaN, lon: -3.7 }, [{ lat: 40, lon: -3, temperatureC: 1 }]), null);
});

test('buildCapitalTemperatureRecords returns [] when there are no usable stations', () => {
  assert.deepEqual(buildCapitalTemperatureRecords([MADRID, BARCELONA], []), []);
  assert.deepEqual(
    buildCapitalTemperatureRecords([MADRID], [{ id: 's1', lat: 40.4, lon: -3.7, temperatureC: NaN }]),
    [],
  );
});

test('buildCapitalTemperatureRecords returns [] when there are no capitals', () => {
  assert.deepEqual(
    buildCapitalTemperatureRecords([], [{ id: 's1', lat: 40.4, lon: -3.7, temperatureC: 20 }]),
    [],
  );
});

test('buildCapitalTemperatureRecords pairs each capital with its own nearest station', () => {
  const stations = [
    { id: 'near-madrid', lat: 40.42, lon: -3.70, temperatureC: 22 },
    { id: 'near-barcelona', lat: 41.39, lon: 2.17, temperatureC: 26 },
  ];
  const records = buildCapitalTemperatureRecords([MADRID, BARCELONA], stations);
  assert.equal(records.length, 2);

  const madrid = records.find((r) => r.capitalId === 'madrid');
  assert.equal(madrid.name, 'Madrid');
  assert.equal(madrid.lat, MADRID.lat);
  assert.equal(madrid.lon, MADRID.lon);
  assert.equal(madrid.temperatureC, 22);
  assert.equal(madrid.stationId, 'near-madrid');
  assert.ok(Number.isFinite(madrid.distanceKm));

  const barcelona = records.find((r) => r.capitalId === 'barcelona');
  assert.equal(barcelona.temperatureC, 26);
  assert.equal(barcelona.stationId, 'near-barcelona');
});

test('buildCapitalTemperatureRecords filters out non-finite stations before matching', () => {
  const stations = [
    { id: 'bad-1', lat: NaN, lon: -3.7, temperatureC: 99 },
    { id: 'bad-2', lat: 40.4, lon: -3.7, temperatureC: NaN },
    { id: 'good', lat: 40.42, lon: -3.70, temperatureC: 22 },
  ];
  const records = buildCapitalTemperatureRecords([MADRID], stations);
  assert.equal(records.length, 1);
  assert.equal(records[0].stationId, 'good');
});
