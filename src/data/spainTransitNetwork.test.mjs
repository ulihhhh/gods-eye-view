import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import {
  assignStationLines,
  buildFgcStations,
  buildRenfeStations,
  buildStationsPack,
} from '../../scripts/build-spain-transit-network.mjs';
import { loadBundledJson } from './bundledJson.js';

// Hand-made rows in the operators' layouts; not their data.
const CERCANIAS_STOPS = [
  'stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding   ',
  '18000,Madrid-Atocha Cercanías          ,40.4066188,-3.6894372,1   ',
  '05102,San Xoán  de  Abaixo,43.4945654,-8.2142733,1',
  '99999,Sin punto,,,1',
  'X1,Id raro,40,-3,1',
  '18000,Duplicada,0,0,1',
].join('\n');

test('Renfe stops keep the realtime station code, a clean name and a point', () => {
  assert.deepEqual(buildRenfeStations(CERCANIAS_STOPS), {
    '05102': ['San Xoán de Abaixo', 43.49457, -8.21427],
    18000: ['Madrid-Atocha Cercanías', 40.40662, -3.68944],
  });
});

test('FGC initials take their name, and a point from the matching GTFS stop', () => {
  const codes = [
    { inicials: 'PC', nom_estacio: 'Pl. Catalunya' },
    { inicials: 'EN', nom_estacio: 'Terrassa  Estació del nord' },
    { inicials: 'MT', nom_estacio: 'Montserrat' },
    { inicials: 'PC', nom_estacio: 'Repetida' },
    { inicials: 'bad code', nom_estacio: 'x' },
  ];
  const stops = [
    { stop_id: 'PCbus', stop_coordinates: { lat: 1, lon: 1 } },
    {
      stop_id: 'PC2',
      stop_coordinates: { lat: 41.38563194, lon: 2.168720219 },
    },
    { stop_id: 'EN', stop_coordinates: { lat: 41.570171, lon: 2.015494 } },
  ];
  assert.deepEqual(buildFgcStations(codes, stops), {
    EN: ['Terrassa Estació del nord', 41.57017, 2.01549],
    MT: ['Montserrat'],
    PC: ['Pl. Catalunya', 41.38563, 2.16872],
  });
});

test('the pack holds one dictionary per network the feeds name', () => {
  const pack = buildStationsPack({
    cercaniasStops: CERCANIAS_STOPS,
    ldStops:
      'stop_id,stop_name,stop_lat,stop_lon\n71801,Barcelona-Sants,41.379,2.14',
    fgcCodes: [],
    fgcStops: [],
    generated: '2026-10-13',
  });
  assert.deepEqual(Object.keys(pack.networks), [
    'renfe-cercanias',
    'renfe-ld',
    'fgc',
  ]);
  assert.equal(pack.meta.script, 'scripts/build-spain-transit-network.mjs');
  assert.deepEqual(pack.networks['renfe-ld'], {
    71801: ['Barcelona-Sants', 41.379, 2.14],
  });
});

test('the bundled pack stays small and names the stations seen live', async () => {
  const url = new URL(
    './local_data/spain_transit/stations.json',
    import.meta.url,
  );
  assert.ok(statSync(url).size < 150 * 1024, 'station pack under 150 KB');
  const { networks } = await loadBundledJson(url);
  assert.ok(Object.keys(networks['renfe-cercanias']).length > 1000);
  assert.ok(Object.keys(networks['renfe-ld']).length > 900);
  assert.ok(Object.keys(networks.fgc).length > 100);
  // Ids observed in the live feeds on 2026-10-13.
  assert.equal(
    networks['renfe-cercanias']['18000'][0],
    'Madrid-Atocha Cercanías',
  );
  assert.equal(networks['renfe-cercanias']['51003'][0], 'Sevilla-Santa Justa');
  assert.equal(networks['renfe-ld']['71801'][0], 'Barcelona-Sants');
  assert.equal(networks.fgc.PC[0], 'Pl. Catalunya');
  assert.equal(networks.fgc.TB[0], 'Av.Tibidabo');
});

test('a line serves the stations its track passes within 80 m of', () => {
  const stations = {
    networks: {
      'renfe-cercanias': {
        1: ['On the line', 41.4, 2.15],
        2: ['300 m away', 41.4027, 2.15],
      },
      fgc: { PC: ['Pl. Catalunya', 41.38563, 2.16872], MT: ['Montserrat'] },
    },
  };
  const lines = [
    { network: 'renfe-cercanias', line: 'R2', paths: [[2.1, 41.4, 2.2, 41.4]] },
    { network: 'fgc', line: 'L6', paths: [[2.168, 41.3856, 2.17, 41.3856]] },
  ];
  assert.deepEqual(assignStationLines(stations, lines), {
    'renfe-cercanias': { 1: [0] },
    fgc: { PC: [1] },
  });
});
