import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CERCANIAS_NETWORKS,
  SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID,
  SPAIN_RAIL_STATION_MAX_DISTANCE_M,
  buildSpainRailCopy,
  createSpainRailNetworkLayer,
  normalizeSpainRailIgnPaths,
  normalizeSpainRailLines,
  parseSpainRailPickId,
  spainRailLineRgb,
  spainRailNetworkLabel,
  spainRailStationRgb,
  spainRailStationsFromPack,
} from './spainRailNetworkLayer.js';
import { loadBundledJson } from './bundledJson.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const LINES = {
  lines: [
    {
      network: 'renfe-cercanias',
      group: '51',
      line: 'R2',
      color: '26A741',
      mode: 'rail',
      paths: [[2.1, 41.3, 2.2, 41.4]],
    },
    {
      network: 'fgc',
      group: 'fgc',
      line: 'MM',
      color: null,
      mode: 'funicular',
      paths: [[1.8, 41.6, 1.81, 41.61]],
    },
    { network: 'fgc', group: 'fgc', line: 'Bad', paths: [[1, 2, 3]] },
  ],
};
const STATIONS = {
  networks: {
    'renfe-cercanias': { 71801: ['Barcelona-Sants', 41.37918, 2.14036] },
    fgc: { PC: ['Pl. Catalunya', 41.38563, 2.16872], MT: ['Montserrat'] },
    'renfe-ld': { 71801: ['Barcelona-Sants', 41.379, 2.14] },
  },
};

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(source) {
        dataSources.push(source);
        return source;
      },
      remove() {
        return true;
      },
    },
    scene: { groundPrimitives: { add: (p) => p, remove() {} } },
    entities: new Cesium.EntityCollection(),
    _dataSources: dataSources,
  };
}

test('lines keep a name and well-formed flat paths; networks read as a person names them', () => {
  const lines = normalizeSpainRailLines(LINES);
  assert.deepEqual(
    lines.map((l) => l.line),
    ['R2', 'MM'],
  );
  assert.equal(normalizeSpainRailLines({}), null);
  assert.equal(spainRailNetworkLabel(lines[0]), 'Rodalies de Catalunya');
  assert.equal(spainRailNetworkLabel(lines[1]), 'FGC');
  assert.equal(
    spainRailNetworkLabel({ network: 'renfe-cercanias', group: '99' }),
    'Renfe Cercanías',
  );
  assert.deepEqual(spainRailLineRgb(lines[0]), [38, 167, 65]);
  assert.deepEqual(
    spainRailLineRgb(lines[1]),
    [160, 168, 176],
    'no colour → neutral',
  );
  assert.equal(Object.keys(CERCANIAS_NETWORKS).length, 15);
});

test('stations come from the Cercanías and FGC networks, with a point only', () => {
  assert.deepEqual(
    spainRailStationsFromPack(STATIONS).map((s) => s.id),
    ['renfe-cercanias:71801', 'fgc:PC'],
  );
});

test('the national network pack is optional and validated path by path', async () => {
  assert.deepEqual(
    normalizeSpainRailIgnPaths({ paths: [[1, 2, 3, 4], [1, 2, 3], 'x'] }),
    [[1, 2, 3, 4]],
  );
  assert.equal(normalizeSpainRailIgnPaths({}), null);
  const layer = createSpainRailNetworkLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    loadJson: async (url) => {
      if (url.pathname.endsWith('ign_rail.json')) throw new Error('missing');
      return url.pathname.endsWith('lines.json') ? LINES : STATIONS;
    },
  });
  const viewer = fakeViewer();
  try {
    layer.init(viewer);
    assert.equal(await layer.update(), true, 'works without the IGN pack');
    assert.equal(layer.getStats().count, 4);
  } finally {
    layer.destroy(viewer);
  }
});

test('pick ids round-trip; others are left to their owners', () => {
  assert.deepEqual(parseSpainRailPickId('spain-rail-network:ign:12'), {
    kind: 'ign',
    key: '12',
  });
  assert.deepEqual(parseSpainRailPickId('spain-rail-network:line:3'), {
    kind: 'line',
    key: '3',
  });
  assert.deepEqual(parseSpainRailPickId('spain-rail-network:station:fgc:PC'), {
    kind: 'station',
    key: 'fgc:PC',
  });
  assert.equal(parseSpainRailPickId('tmb-arrivals:bus:108'), null);
  assert.equal(parseSpainRailPickId(null), null);
});

test('cards name the line and its network, or the station and its code', () => {
  assert.deepEqual(buildSpainRailCopy('line', LINES.lines[0]), {
    title: '🛤 R2',
    details: [
      'Rodalies de Catalunya · line',
      'Source: Renfe Operadora open data',
    ],
  });
  assert.deepEqual(
    buildSpainRailCopy('station', {
      network: 'fgc',
      code: 'PC',
      name: 'Pl. Catalunya',
    }),
    {
      title: '🚉 Pl. Catalunya',
      details: ['FGC station · PC', 'Source: FGC open data'],
    },
  );
});

test('the layer reads both packs once, draws stations at street scale, and selects by pick id', async () => {
  const calls = [];
  const reads = [];
  const layer = createSpainRailNetworkLayer({
    overlayHost: {
      setEntries: (...args) => calls.push(['entries', ...args]),
      setVisible: (...args) => calls.push(['visible', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
    loadJson: async (url) => {
      const name = url.pathname.split('/').pop();
      reads.push(name);
      if (name === 'ign_rail.json') return { paths: [[-3, 40, -2.9, 40.1]] };
      return name === 'lines.json' ? LINES : STATIONS;
    },
  });
  const viewer = fakeViewer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(await layer.update(), true);
    assert.equal(await layer.update(), true);
    assert.deepEqual(
      reads.sort(),
      ['ign_rail.json', 'lines.json', 'stations.json'],
      'read once',
    );
    const stations = viewer._dataSources[0].entities.values;
    assert.equal(stations.length, 2);
    const far = stations[0].point.distanceDisplayCondition.getValue(
      Cesium.JulianDate.now(),
    ).far;
    assert.equal(far, SPAIN_RAIL_STATION_MAX_DISTANCE_M);
    assert.equal(layer.getStats().count, 5);
    assert.equal(
      isOwnedByOtherLayer('transit', 'spain-rail-network:line:0'),
      true,
    );

    assert.equal(
      layer._selectForTest('spain-rail-network:station:fgc:PC'),
      true,
    );
    const card = calls.filter(([type]) => type === 'entries').at(-1);
    assert.equal(card[1], SPAIN_RAIL_SELECTED_OVERLAY_SOURCE_ID);
    assert.equal(card[2][0].title, '🚉 Pl. Catalunya');
    assert.equal(layer._selectForTest('spain-rail-network:line:0'), true);
    assert.equal(
      calls.filter(([type]) => type === 'entries').at(-1)[2][0].title,
      '🛤 R2',
    );
    assert.equal(layer._selectForTest('spain-rail-network:line:99'), false);
    const at = Cesium.Cartesian3.fromDegrees(-2.95, 40.05);
    assert.equal(layer._selectForTest('spain-rail-network:ign:0', at), true);
    assert.equal(
      calls.filter(([type]) => type === 'entries').at(-1)[2][0].title,
      '🛤 Railway',
    );
    assert.equal(
      layer._selectForTest('spain-rail-network:ign:0'),
      false,
      'needs a click point',
    );
  } finally {
    layer.destroy(viewer);
  }
});

test('the bundled lines pack stays within budget and holds both networks', async () => {
  const pack = await loadBundledJson(
    new URL('./local_data/spain_transit/lines.json', import.meta.url),
  );
  const lines = normalizeSpainRailLines(pack);
  assert.equal(
    lines.length,
    pack.lines.length,
    'every bundled line is well formed',
  );
  assert.ok(
    JSON.stringify(pack).length < 600 * 1024,
    'lines pack under 600 KB',
  );
  const groups = new Set(
    lines.filter((l) => l.network === 'renfe-cercanias').map((l) => l.group),
  );
  assert.ok(groups.size >= 15, `${groups.size} Cercanías networks`);
  for (const group of groups)
    assert.ok(CERCANIAS_NETWORKS[group], `named network ${group}`);
  assert.ok(lines.some((l) => l.network === 'fgc' && l.line === 'L6'));
  assert.ok(lines.some((l) => l.group === '51' && l.line === 'R2'));
});

test('stations take their line colour, white at interchanges, slate on no line', () => {
  const linesPack = {
    lines: [
      { network: 'fgc', line: 'L6', color: '797FBC', paths: [] },
      { network: 'fgc', line: 'S1', color: 'EF7900', paths: [] },
      { network: 'fgc', line: 'L12', color: null, paths: [] },
    ],
    stationLines: { fgc: { PC: [0, 1], TT: [0], X: [2] } },
  };
  const pack = {
    networks: {
      fgc: {
        PC: ['Pl. Catalunya', 41.38, 2.16],
        TT: ['Les Tres Torres', 41.39, 2.13],
        X: ['Sense color', 41.4, 2.1],
        Z: ['Sense línia', 41.41, 2.1],
      },
    },
  };
  const stations = Object.fromEntries(
    spainRailStationsFromPack(pack, linesPack).map((s) => [s.code, s]),
  );
  assert.deepEqual(
    stations.PC.lines.map((l) => l.name),
    ['L6', 'S1'],
  );
  assert.deepEqual(spainRailStationRgb(stations.PC), [235, 235, 235]);
  assert.deepEqual(spainRailStationRgb(stations.TT), [121, 127, 188]);
  assert.deepEqual(spainRailStationRgb(stations.X), [145, 164, 180]);
  assert.deepEqual(spainRailStationRgb(stations.Z), [145, 164, 180]);
  assert.deepEqual(buildSpainRailCopy('station', stations.PC).details, [
    'FGC station · PC',
    'Lines: L6 S1',
    'Source: FGC open data',
  ]);
});
