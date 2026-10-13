import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIgnRailPack,
  chainPaths,
  parseRailwayLines,
  parseRailwayLinks,
  parseRailwayTypes,
} from '../../scripts/build-spain-rail-ign.mjs';

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
