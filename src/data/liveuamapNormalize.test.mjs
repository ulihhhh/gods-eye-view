import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEvent,
  normalizeField,
  fieldRings,
  normalizeSnapshot,
  parseOtherRegions,
  eventPoints,
  videoKind,
  LIVEUAMAP_STATUS,
} from './liveuamapNormalize.js';

test('normalizeEvent flattens a raw venue and keeps the useful fields', () => {
  const e = normalizeEvent({
    id: 22865915,
    name: "Marib: Saudi's air attacks target the Ragwan Directorate.",
    source: 'https://x.com/Almasirahbrk/status/2097592547560288527',
    lat: '15.8252900',
    lng: '45.0212900',
    timestamp: 1788939960,
    time: '1 day ago',
    picpath: 'bomb-7',
    picw: 39,
    pich: 39,
    cat_id: 27,
    color_id: 7,
    status_id: 3,
    city: 'Marib',
    picture: 'https://pbs.twimg.com/a.jpg',
    ps: ['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg'],
    videotype: 1,
    video: 'dQw4w9WgXcQ',
    otherregions: '[{"name":"Middle East","link":"https://mideast.liveuamap.com","id":7}]',
    langs: 'en,ar,fa',
    points: [{ id: 4, lat: 15.82529, lng: 45.02129 }],
  });
  assert.equal(e.id, '22865915');
  assert.equal(e.lat, 15.82529);
  assert.equal(e.sideId, 7);
  assert.equal(e.categoryId, 27);
  assert.equal(e.icon, 'bomb-7');
  assert.deepEqual(e.status, LIVEUAMAP_STATUS[3]);
  assert.deepEqual(e.pictures, ['https://pbs.twimg.com/a.jpg', 'https://pbs.twimg.com/b.jpg']);
  assert.equal(e.videoKind, 'youtube');
  assert.equal(e.city, 'Marib');
  assert.deepEqual(e.langs, ['en', 'ar', 'fa']);
  assert.equal(e.otherRegions[0].id, 7);
  assert.deepEqual(e.extraPoints, []); // the single point equals lat/lng, so nothing extra
});

test('normalizeEvent drops rows with no coordinates', () => {
  assert.equal(normalizeEvent({ name: 'no coords' }), null);
  assert.equal(normalizeEvent(null), null);
});

test('eventPoints keeps only valid pairs', () => {
  assert.deepEqual(
    eventPoints([{ lat: 1, lng: 2 }, { lat: 'x', lng: 3 }, { lat: 4, lng: 5 }]),
    [[1, 2], [4, 5]],
  );
});

test('parseOtherRegions handles a JSON string or an array', () => {
  assert.equal(parseOtherRegions('not json').length, 0);
  assert.equal(parseOtherRegions([{ name: 'Yemen', link: 'x', id: 53 }])[0].id, 53);
});

test('videoKind maps the known Liveuamap video types', () => {
  assert.equal(videoKind(0), null);
  assert.equal(videoKind(1), 'youtube');
  assert.equal(videoKind(11), 'facebook');
  assert.equal(videoKind(99), 'other');
});

test('fieldRings handles all three point shapes', () => {
  assert.deepEqual(fieldRings([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]), [[[1, 2], [3, 4]]]);
  assert.deepEqual(fieldRings([[49, 39.6, 49.1, 39.7, 49.2, 39.8]]), [[[49, 39.6], [49.1, 39.7], [49.2, 39.8]]]);
  assert.deepEqual(fieldRings([1, 2, 3, 4]), [[[1, 2], [3, 4]]]);
  assert.deepEqual(fieldRings([]), []);
});

test('normalizeField keeps colors, side, type and geometry', () => {
  const f = normalizeField({
    id: 522576076,
    name: 'Russian occupation in Luhansk region',
    description: 'as of today',
    type_id: 6,
    color_id: 1,
    strokecolor: '#FF0000',
    fillcolor: '#FF0000',
    fillopacity: '0.25',
    symbolpath: 'FORWARD_CLOSED_ARROW',
    points: [[49.0, 39.6, 49.1, 39.7, 49.2, 39.8]],
  });
  assert.equal(f.typeId, 6);
  assert.equal(f.sideId, 1);
  assert.equal(f.fillOpacity, 0.25);
  assert.equal(f.symbol, 'FORWARD_CLOSED_ARROW');
  assert.equal(f.rings.length, 1);
});

test('normalizeSnapshot builds the on-disk shape from a raw bridge payload', () => {
  const snap = normalizeSnapshot({
    region: 'Yemen',
    resid: 53,
    href: 'https://yemen.liveuamap.com/',
    ovens: {
      venues: [
        { id: 1, name: 'A', lat: 15, lng: 45, timestamp: 100 },
        { id: 2, name: 'no coords' },
      ],
      datac: '11',
      datam: 'September',
      datay: '2026',
    },
    // The real shape: Liveuamap's own localStorage['fields'] cache, {id: {...}}.
    fieldsCache: { 9: { id: 9, type_id: 4, points: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 1 }] } },
    markers: null,
  });
  assert.equal(snap.region, 'yemen');
  assert.equal(snap.resid, 53);
  assert.equal(snap.asOf, '11 September 2026');
  assert.equal(snap.events.length, 1);
  assert.equal(snap.fields.length, 1);
  assert.ok(snap.fetchedAt);
});

test('normalizeSnapshot falls back to markers when ovens.venues is absent', () => {
  const snap = normalizeSnapshot({
    region: 'yemen',
    ovens: null,
    markers: [{ id: 1, name: 'A', lat: 15, lng: 45 }],
  });
  assert.equal(snap.events.length, 1);
  assert.equal(snap.fields.length, 0);
});

test('normalizeSnapshot ignores ovens.fields when it is an array of IDs (the real upstream shape)', () => {
  // This is exactly what tripped up the original bridge: ovens.fields is a
  // plain array of relevant field IDs, not a map of polygon objects. Feeding
  // it through must yield zero fields, not throw and not fabricate garbage.
  const snap = normalizeSnapshot({
    region: 'ukraine',
    ovens: { venues: [{ id: 1, name: 'A', lat: 15, lng: 45 }], fields: [522576076, 522576080] },
    fieldsCache: null,
    markers: null,
  });
  assert.equal(snap.events.length, 1);
  assert.equal(snap.fields.length, 0);
});

test('normalizeSnapshot prefers fieldsCache over a defensive ovens.fields object fallback', () => {
  const snap = normalizeSnapshot({
    region: 'ukraine',
    ovens: {
      venues: [],
      // A non-array object here is accepted only as a fallback — real traffic
      // never sends this once fieldsCache is populated.
      fields: { 1: { id: 1, type_id: 4, points: [{ lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 1, lng: 1 }] } },
    },
    fieldsCache: { 2: { id: 2, type_id: 4, points: [{ lat: 5, lng: 5 }, { lat: 6, lng: 5 }, { lat: 6, lng: 6 }] } },
    markers: null,
  });
  assert.equal(snap.fields.length, 1);
  assert.equal(snap.fields[0].id, '2');
});
