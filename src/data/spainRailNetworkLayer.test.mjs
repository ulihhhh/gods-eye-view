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
  normalizeSpainRailIgnShared,
  normalizeSpainRailLines,
  parseSpainRailPickId,
  spainRailLineRgb,
  spainRailNetworkLabel,
  spainRailStationRgb,
  spainRailStationsFromPack,
  spainRailGroup,
  spainRailIgnShown,
  SPAIN_RAIL_DEFAULT_PARAMS,
  SPAIN_RAIL_CARD_REFRESH_MS,
  spainRailArrivalLines,
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
    'renfe-ld': {
      71801: ['Barcelona-Sants', 41.379, 2.14],
      60911: ['Ciudad Real', 38.98, -3.92],
    },
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

test('stations come from Cercanías, FGC and the AV/LD/MD stations Cercanías lacks, with a point only', () => {
  const stations = spainRailStationsFromPack(STATIONS);
  assert.deepEqual(
    stations.map((s) => s.id),
    ['renfe-cercanias:71801', 'fgc:PC', 'renfe-ld:60911'],
  );
  assert.deepEqual(
    spainRailStationRgb(stations[2]),
    [205, 210, 220],
    'no line colour → the national network grey',
  );
  assert.deepEqual(buildSpainRailCopy('station', stations[2]).details, [
    'Renfe AV/LD/MD station · 60911',
    'Source: Renfe Operadora open data',
  ]);
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
    assert.equal(layer.getStats().count, 5);
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
    assert.equal(stations.length, 3);
    const far = stations[0].point.distanceDisplayCondition.getValue(
      Cesium.JulianDate.now(),
    ).far;
    assert.equal(far, SPAIN_RAIL_STATION_MAX_DISTANCE_M);
    assert.equal(layer.getStats().count, 6);
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
  assert.deepEqual(spainRailStationRgb(stations.X), [205, 210, 220]);
  assert.deepEqual(spainRailStationRgb(stations.Z), [205, 210, 220]);
  assert.deepEqual(buildSpainRailCopy('station', stations.PC).details, [
    'FGC station · PC',
    'Lines: L6 S1',
    'Source: FGC open data',
  ]);
});

test('the pills switch Cercanías, FGC, the national network and the stations on their own', async () => {
  assert.equal(spainRailGroup({ network: 'fgc' }), 'fgc');
  assert.equal(spainRailGroup({ network: 'renfe-ld' }), 'national');
  assert.equal(spainRailGroup({ network: 'renfe-cercanias' }), 'cercanias');
  const layer = createSpainRailNetworkLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    loadJson: async (url) => {
      const name = url.pathname.split('/').pop();
      if (name === 'ign_rail.json') return { paths: [[-3, 40, -2.9, 40.1]] };
      return name === 'lines.json' ? LINES : STATIONS;
    },
  });
  const viewer = fakeViewer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(await layer.update(), true);
    const chips = layer.getRowControls().chips;
    assert.deepEqual(
      chips.map((chip) => [chip.label, chip.active]),
      [
        ['CERCANÍAS', true],
        ['FGC', true],
        ['AV/LD', true],
        ['STATIONS', true],
      ],
    );
    const shown = () =>
      viewer._dataSources[0].entities.values
        .filter((entity) => entity.show)
        .map((entity) => entity.id.split(':').slice(2).join(':'))
        .sort();
    assert.deepEqual(shown(), [
      'fgc:PC',
      'renfe-cercanias:71801',
      'renfe-ld:60911',
    ]);
    assert.equal(
      layer._selectForTest('spain-rail-network:station:fgc:PC'),
      true,
    );
    layer.setParams({ fgc: false, national: false });
    assert.deepEqual(shown(), ['renfe-cercanias:71801']);
    assert.equal(layer._selectedKeyForTest(), null, 'the FGC card closed');
    layer.setParams({ stations: false });
    assert.deepEqual(shown(), []);
    assert.deepEqual(layer.getParams(), {
      ...SPAIN_RAIL_DEFAULT_PARAMS,
      fgc: false,
      national: false,
      stations: false,
    });
    assert.deepEqual(layer.getRowControls().chips[3].params, {
      stations: true,
    });
  } finally {
    layer.destroy(viewer);
  }
});

test('national track shared with an operator shows only while that operator is off', async () => {
  assert.deepEqual(
    normalizeSpainRailIgnShared({
      shared: [
        { networks: ['renfe-cercanias'], paths: [[1, 2, 3, 4], [1]] },
        { networks: ['fgc', 'renfe-cercanias'], paths: [[5, 6, 7, 8]] },
        { networks: [], paths: [[1, 2, 3, 4]] },
        { networks: ['fgc'], paths: [] },
      ],
    }),
    [
      { groups: ['cercanias'], paths: [[1, 2, 3, 4]] },
      { groups: ['cercanias', 'fgc'], paths: [[5, 6, 7, 8]] },
    ],
  );
  assert.deepEqual(normalizeSpainRailIgnShared({ paths: [] }), []);
  const all = { ...SPAIN_RAIL_DEFAULT_PARAMS };
  assert.equal(spainRailIgnShown([], all), true, 'IGN-only: AV/LD pill');
  assert.equal(spainRailIgnShown(['cercanias'], all), false, 'drawn once');
  assert.equal(
    spainRailIgnShown(['cercanias'], { ...all, cercanias: false }),
    true,
  );
  assert.equal(
    spainRailIgnShown(['cercanias', 'fgc'], { ...all, cercanias: false }),
    false,
    'FGC still covers it',
  );
  assert.equal(
    spainRailIgnShown(['cercanias'], {
      ...all,
      cercanias: false,
      national: false,
    }),
    false,
  );

  const layer = createSpainRailNetworkLayer({
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    loadJson: async (url) => {
      const name = url.pathname.split('/').pop();
      if (name === 'ign_rail.json')
        return {
          paths: [[-3, 40, -2.9, 40.1]],
          shared: [
            { networks: ['renfe-cercanias'], paths: [[2, 41.3, 2.1, 41.4]] },
          ],
        };
      return name === 'lines.json' ? LINES : STATIONS;
    },
  });
  const viewer = fakeViewer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().count, 7, 'shared track counted');
    layer.setParams({ cercanias: false });
    const at = Cesium.Cartesian3.fromDegrees(2.05, 41.35);
    assert.equal(layer._selectForTest('spain-rail-network:ign:1', at), true);
    layer.setParams({ fgc: false });
    assert.equal(layer._selectedKeyForTest(), 'spain-rail-network:ign:1');
    layer.setParams({ cercanias: true });
    assert.equal(
      layer._selectedKeyForTest(),
      null,
      'Cercanías back on hides the shared grey and its card',
    );
  } finally {
    layer.destroy(viewer);
  }
});

test('the pills of both Spanish layers travel in a share link', async () => {
  const {
    createDefaultLayerState,
    encodeLayerStateParams,
    decodeLayerStateParams,
  } = await import('./layerState.js');
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['spain-rail-network', 'tmb-arrivals'];
  state.options['spain-rail-network'].fgc = false;
  state.options['tmb-arrivals'].lines = false;
  const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  const options = params.get('lo').split('_');
  assert.ok(options.includes('zi.f.0'), params.get('lo'));
  assert.ok(options.includes('zh.l.0'), params.get('lo'));
  assert.equal(
    options.filter((option) => /^z[hi]\./.test(option)).length,
    2,
    'defaults are left out',
  );
  const decoded = decodeLayerStateParams(params);
  assert.equal(decoded.options['spain-rail-network'].fgc, false);
  assert.equal(decoded.options['spain-rail-network'].cercanias, true);
  assert.equal(decoded.options['tmb-arrivals'].lines, false);
});

const BOARD_NOW = Date.parse('2026-10-16T09:40:00Z'); // 11:40 in Barcelona
const at = (m) => BOARD_NOW + m * 60_000;
/** Hand-made station board, the shape /api/transit/arrivals serves. */
const BOARD = {
  feedId: 'fgc-geotren',
  stationId: 'PC',
  fetchedAt: at(-1),
  arrivals: [
    {
      tripId: 'a',
      at: at(0),
      line: 'L7',
      destination: null,
      origin: 'Av. Tibidabo',
      platform: '4',
      delaySec: null,
      onTime: true,
      terminates: true,
      running: true,
    },
    {
      tripId: 'b',
      at: at(3),
      line: 'S1',
      destination: 'Terrassa Nacions Unides',
      origin: null,
      platform: '2',
      delaySec: null,
      onTime: false,
      terminates: false,
      running: true,
    },
    {
      tripId: 'c',
      at: at(12),
      line: null,
      destination: 'Sabadell Parc Nord',
      origin: null,
      platform: null,
      delaySec: 180,
      onTime: null,
      terminates: false,
      running: false,
    },
  ],
};

test('a station card lists its next trains: departures, arrivals and lateness', () => {
  assert.deepEqual(
    spainRailArrivalLines({ status: 'ready', data: BOARD }, BOARD_NOW),
    [
      'L7 from Av. Tibidabo · arr. 11:40 (now) · platform 4',
      'S1 → Terrassa Nacions Unides · 11:43 (3 min) · platform 2 · late',
      'FGC → Sabadell Parc Nord · 11:52 (12 min) · +3 min',
    ],
  );
  assert.deepEqual(
    buildSpainRailCopy(
      'station',
      { network: 'fgc', code: 'PC', name: 'Pl. Catalunya' },
      { status: 'ready', data: BOARD },
      BOARD_NOW,
    ).details.at(-1),
    'Source: FGC open data · 11:39',
  );
});

test('a station card says when it is asking, failing or has nothing', () => {
  assert.deepEqual(spainRailArrivalLines({ status: 'loading' }, BOARD_NOW), [
    'Asking for the next trains…',
  ]);
  assert.deepEqual(
    spainRailArrivalLines(
      { status: 'error', error: 'Network error' },
      BOARD_NOW,
    ),
    ['Network error'],
  );
  assert.deepEqual(
    spainRailArrivalLines(
      { status: 'ready', data: { arrivals: [] } },
      BOARD_NOW,
    ),
    ['No trains reported right now'],
  );
  assert.deepEqual(
    spainRailArrivalLines(
      { status: 'error', error: 'Network error', data: BOARD },
      at(20),
    ),
    ['No trains reported right now', 'Network error · showing last answer'],
    'trains already gone drop off the last answer',
  );
  assert.deepEqual(spainRailArrivalLines(null, BOARD_NOW), []);
});

test('an FGC station card asks for its trains, refreshes while open and stops on close', async () => {
  const entries = [];
  const asked = [];
  const intervals = new Set();
  let clock = BOARD_NOW;
  let tick = null;
  const layer = createSpainRailNetworkLayer({
    overlayHost: {
      setEntries: (_id, list) => entries.push(list),
      setVisible() {},
      clearSource() {},
    },
    loadJson: async (url) => {
      const name = url.pathname.split('/').pop();
      if (name === 'ign_rail.json') return { paths: [] };
      return name === 'lines.json' ? LINES : STATIONS;
    },
    fetchImpl: async (url) => {
      asked.push(url);
      return new Response(JSON.stringify(BOARD), { status: 200 });
    },
    now: () => clock,
    setIntervalImpl: (fn) => {
      tick = fn;
      intervals.add(fn);
      return fn;
    },
    clearIntervalImpl: (handle) => intervals.delete(handle),
  });
  const viewer = fakeViewer();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update();
    layer._selectForTest('spain-rail-network:station:fgc:PC');
    assert.deepEqual(asked, ['/api/transit/arrivals/fgc-geotren/PC']);
    assert.ok(
      entries.at(-1)[0].details.includes('Asking for the next trains…'),
    );
    await settle();
    assert.ok(
      entries
        .at(-1)[0]
        .details.includes(
          'S1 → Terrassa Nacions Unides · 11:43 (3 min) · platform 2 · late',
        ),
    );
    clock += 5_000;
    tick();
    assert.equal(asked.length, 1, 'repaints without asking again');
    clock += SPAIN_RAIL_CARD_REFRESH_MS;
    tick();
    await settle();
    assert.equal(asked.length, 2, 'asks again once the answer is old');

    layer._selectForTest('spain-rail-network:station:renfe-cercanias:71801');
    assert.equal(intervals.size, 0, 'a Renfe station has no board yet');
    assert.equal(asked.length, 2);
    assert.ok(
      !entries.at(-1)[0].details.some((line) => line.startsWith('Asking')),
    );
  } finally {
    layer.destroy(viewer);
  }
  assert.equal(intervals.size, 0);
});
