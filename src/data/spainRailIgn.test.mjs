import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIgnRailPack,
  chainPaths,
  parseRailwayLines,
  parseRailwayLinks,
  parseRailwayTypes,
} from '../../scripts/build-spain-rail-ign.mjs';
import {
  ignPackTrack,
  splitSharedTrack,
} from '../../scripts/split-spain-rail-shared.mjs';
import { loadBundledJson } from './bundledJson.js';
import { spainTrackLines } from './spainTrackGeometry.js';

// Hand-made WFS answers in the IGN's shape (trimmed); not IGN data.
const href = (id) =>
  `https://servicios.idee.es/wfs-inspire/transportes?SERVICE=WFS&amp;ID=${id}#${id}`;
const page = (members) =>
  `<wfs:FeatureCollection numberReturned="${members.length}">${members
    .map((m) => `<wfs:member>${m}</wfs:member>`)
    .join('')}</wfs:FeatureCollection>`;
const typeMember = (line, type) =>
  `<tn-ra:RailwayType gml:id="T_${line}"><net:networkRef><net:LinkReference><net:element xlink:href="${href(line)}"/></net:LinkReference></net:networkRef><tn-ra:type xlink:href="https://inspire.ec.europa.eu/codelist/RailwayTypeValue/${type}"/></tn-ra:RailwayType>`;
const lineMember = (line, links) =>
  `<tn-ra:RailwayLine gml:id="${line}">${links
    .map((l) => `<net:link xlink:href="${href(l)}"/>`)
    .join('')}</tn-ra:RailwayLine>`;
// posList is lat lon (EPSG:4258 axis order).
const linkMember = (link, latLon) =>
  `<tn-ra:RailwayLink gml:id="${link}"><gml:LineString><gml:posList>${latLon.join(' ')}</gml:posList></gml:LineString></tn-ra:RailwayLink>`;

const TYPES = page([typeMember('L1', 'train'), typeMember('L2', 'tramway')]);
const LINES = page([
  lineMember('L1', ['A', 'B', 'C']),
  lineMember('L2', ['T']),
]);
const LINKS = page([
  linkMember('A', [40, -3, 40, -2.9]),
  linkMember('B', [40, -2.8, 40, -2.9]), // stored backwards
  linkMember('C', [40, -2.8, 40.1, -2.8]),
  linkMember('T', [41, 2, 41.1, 2]),
  linkMember('SIDING', [42, 1, 42.1, 1]),
]);

test('types, lines and links parse from WFS members, links in lon/lat order', () => {
  assert.deepEqual(
    [...parseRailwayTypes([TYPES])],
    [
      ['L1', 'train'],
      ['L2', 'tramway'],
    ],
  );
  assert.deepEqual(parseRailwayLines([LINES]).get('L1'), ['A', 'B', 'C']);
  const links = parseRailwayLinks([LINKS], new Set(['A']));
  assert.deepEqual(
    [...links],
    [
      [
        'A',
        [
          [-3, 40],
          [-2.9, 40],
        ],
      ],
    ],
  );
});

test('links meeting end to end chain into one path, whatever their direction', () => {
  const chains = chainPaths([
    [
      [-3, 40],
      [-2.9, 40],
    ],
    [
      [-2.8, 40],
      [-2.9, 40],
    ],
    [
      [-2.8, 40],
      [-2.8, 40.1],
    ],
  ]);
  assert.equal(chains.length, 1);
  const [chain] = chains;
  const ends = [chain[0], chain.at(-1)].map((p) => p.join(',')).sort();
  assert.deepEqual(ends, ['-2.8,40.1', '-3,40']);
  assert.equal(chain.length, 4);
});

test('a junction ends chains instead of folding a branch in', () => {
  const chains = chainPaths([
    [
      [0, 0],
      [1, 0],
    ],
    [
      [1, 0],
      [2, 0],
    ],
    [
      [1, 0],
      [1, 1],
    ],
  ]);
  assert.equal(chains.length, 3);
});

test('the pack keeps train lines only and drops sidings', () => {
  const pack = buildIgnRailPack({
    typePages: [TYPES],
    linePages: [LINES],
    linkPages: [LINKS],
    generated: '2026-10-13',
  });
  assert.equal(pack.meta.trainLines, 1);
  assert.equal(pack.meta.links, 3);
  assert.equal(pack.paths.length, 1);
  assert.equal(pack.paths[0].length % 2, 0);
  assert.match(pack.meta.licence, /Instituto Geográfico Nacional/);
});

// ~0.0009° of longitude ≈ 76 m at 40° N; 0.0003° of latitude ≈ 33 m.
const IGN_EAST = [-3.05, 40, -3, 40, -2.95, 40]; // two 4.3 km segments
const cercanias = (paths) => [{ network: 'renfe-cercanias', paths }];

test('IGN track beside an operator line for a sustained run is split off as shared', () => {
  // A Cercanías line 33 m north of the IGN track, from -3.02 to -2.98.
  const { paths, shared, stats } = splitSharedTrack(
    [IGN_EAST],
    cercanias([[-3.02, 40.0003, -2.98, 40.0003]]),
  );
  assert.equal(paths.length, 2, 'IGN-only track on both sides');
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].networks, ['renfe-cercanias']);
  assert.equal(shared[0].paths.length, 1);
  const piece = shared[0].paths[0];
  assert.ok(Math.abs(piece[0] - -3.02) < 0.0015, `starts ~-3.02: ${piece[0]}`);
  assert.ok(Math.abs(piece.at(-2) - -2.98) < 0.0015, `ends ~-2.98`);
  assert.ok(piece.includes(-3), 'keeps the original vertex inside it');
  // Pieces meet: the IGN-only paths end where the shared one starts.
  const ends = paths.flatMap((p) => [p.slice(0, 2), p.slice(-2)]).map(String);
  assert.ok(ends.includes(String(piece.slice(0, 2))));
  assert.ok(ends.includes(String(piece.slice(-2))));
  assert.ok(Math.abs(stats.sharedKm - 3) <= 1, `${stats.sharedKm} km shared`);
});

test('crossings, far lines and brief brushes stay IGN-only; short gaps close', () => {
  const crossing = splitSharedTrack(
    [IGN_EAST],
    cercanias([[-3, 39.95, -3, 40.05]]),
  );
  assert.deepEqual(crossing.shared, [], 'a crossing is not shared track');
  assert.deepEqual(crossing.paths, [IGN_EAST]);
  const far = splitSharedTrack(
    [IGN_EAST],
    cercanias([[-3.02, 40.0009, -2.98, 40.0009]]), // ~100 m away
  );
  assert.deepEqual(far.shared, []);
  // Two shared runs with an 80 m gap: one shared piece.
  const gap = splitSharedTrack(
    [IGN_EAST],
    cercanias([
      [-3.02, 40.0003, -3.0005, 40.0003],
      [-2.9995, 40.0003, -2.98, 40.0003],
    ]),
  );
  assert.equal(gap.shared[0].paths.length, 1, 'the gap closed');
  // An FGC line along a short part of a Cercanías stretch only.
  const both = splitSharedTrack(
    [IGN_EAST],
    [
      ...cercanias([[-3.02, 40.0003, -2.98, 40.0003]]),
      { network: 'fgc', paths: [[-3.0003, 39.9997, -2.9998, 39.9997]] },
    ],
  );
  assert.deepEqual(
    both.shared.map((group) => group.networks),
    [['renfe-cercanias']],
    'a brief brush with FGC does not tie the stretch to its pill',
  );
});

test('a split pack chains back into whole track for a rerun', () => {
  const bend = [-3.05, 40, -3, 40, -3, 40.05];
  const { paths, shared } = splitSharedTrack(
    [bend],
    cercanias([[-3.02, 40.0003, -3.0003, 40.0003, -3.0003, 40.02]]),
  );
  assert.equal(shared[0].paths.length, 1);
  const track = ignPackTrack({ paths, shared });
  assert.equal(track.length, 1);
  assert.deepEqual(track[0], bend, 'cut points simplified away again');
});

test('the bundled IGN pack carries shared track, and long-distance trains still follow it', async () => {
  const pack = await loadBundledJson(
    new URL('./local_data/spain_transit/ign_rail.json', import.meta.url),
  );
  assert.ok(pack.shared.length > 0);
  for (const group of pack.shared)
    for (const network of group.networks)
      assert.ok(['renfe-cercanias', 'fgc'].includes(network), network);
  const sharedPaths = pack.shared.reduce((n, g) => n + g.paths.length, 0);
  assert.ok(pack.meta.shared.sharedKm > 1000, `${pack.meta.shared.sharedKm}`);
  assert.ok(JSON.stringify(pack).length < 450 * 1024, 'IGN pack under 450 KB');
  const ld = await spainTrackLines('renfe-ld');
  assert.equal(ld[0].routes, null);
  assert.equal(ld[0].paths.length, pack.paths.length + sharedPaths);
});
