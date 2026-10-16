// The fork-only layers' cards in Spanish and Russian, through the merged
// catalogs (src/i18n/fork): one card per layer family is enough to catch a
// builder that stopped passing its text through t().
import assert from 'node:assert/strict';
import test from 'node:test';

import { getLocale, setLocale, t, tn } from './index.js';
import { buildTmbArrivalsCopy } from '../data/tmbArrivals.js';
import { buildSpainRailCopy } from '../data/spainRailNetworkLayer.js';
import { buildAemetStationSelectionCopy } from '../data/aemetStations.js';
import { buildAemetUvIndexSelectionCopy } from '../data/aemetUvIndex.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';
import { layerNameForId } from '../ui/layerNames.js';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    run();
  } finally {
    setLocale('en');
  }
}

const NOW = Date.UTC(2026, 9, 17, 10, 0, 0);

test('es: fork layer names, rail, TMB and AEMET cards read in Spanish', () => {
  inLocale('es', () => {
    assert.equal(
      layerNameForId('spain-rail-network'),
      'Red ferroviaria (España)',
    );
    assert.deepEqual(
      buildSpainRailCopy('station', {
        network: 'fgc',
        code: 'PC',
        name: 'Pl. Catalunya',
      }),
      {
        title: '🚉 Pl. Catalunya',
        details: ['Estación de FGC · PC', 'Fuente: datos abiertos de FGC'],
      },
    );
    const tmb = buildTmbArrivalsCopy(
      {
        kind: 'metro',
        place: { id: '126', name: 'Catalunya', lines: [{ name: 'L1' }] },
        arrivals: {
          fetchedAt: null,
          routes: [
            {
              line: 'L1',
              destination: 'Fondo',
              arrivals: [NOW + 10_000, NOW + 240_000],
            },
          ],
        },
        now: NOW,
      },
      { t, tn, locale: getLocale() },
    );
    assert.deepEqual(tmb.details, [
      'Estación de metro · TMB · L1',
      'L1 → Fondo · ahora, 4 min',
      'Fuente: TMB iMetro',
    ]);
    assert.equal(
      buildAemetUvIndexSelectionCopy({ name: 'Sevilla', uvIndex: 7 })
        .details[0],
      'Índice UV 7 · Alto',
    );
    assert.match(
      buildAemetStationSelectionCopy({ name: 'Retiro', windSpeedMs: 2 })
        .details[1],
      /^Viento 2\.0 m\/s/,
    );
  });
});

test('es/ru: the Transit card keeps its fork lines in the UI language', () => {
  const record = {
    id: '23631',
    routeId: 'C4',
    stopId: '18000',
    stopName: 'Atocha',
    status: 'STOPPED_AT',
    delaySec: 180,
    platform: '3',
  };
  const card = (locale) => {
    let copy;
    inLocale(locale, () => {
      copy = buildTransitSelectionCopy(
        { id: 'test' },
        record,
        'rail',
        NOW,
        null,
        null,
        t,
      );
    });
    return copy.details.join(' | ');
  };
  assert.match(card('es'), /\+3 min de retraso/);
  assert.match(card('es'), /Último informe: detenido en Atocha · vía 3/);
  assert.match(card('ru'), /опаздывает на 3 мин/);
});
