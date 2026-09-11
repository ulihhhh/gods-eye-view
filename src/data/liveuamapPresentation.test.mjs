import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sideColorCss,
  statusBadge,
  iconCategory,
  relativeTime,
  fieldShapeKind,
  STATUS_BADGE,
} from './liveuamapPresentation.js';
import { iconUriForCategory, LIVEUAMAP_ICON_CATEGORIES } from './liveuamapIcons.js';

test('sideColorCss is stable per sideId, independent of region', () => {
  const a = sideColorCss(7, 'yemen');
  const b = sideColorCss(7, 'syria');
  assert.equal(a, b);
  assert.match(a, /^hsl\(\d+, 68%, 56%\)$/);
});

test('sideColorCss falls back to a per-region color when sideId is missing', () => {
  const a = sideColorCss(null, 'yemen');
  const b = sideColorCss(null, 'syria');
  assert.notEqual(a, b);
});

test('statusBadge resolves known tags and rejects unknown/missing ones', () => {
  assert.deepEqual(statusBadge('verified'), STATUS_BADGE.verified);
  assert.equal(statusBadge('nope'), null);
  assert.equal(statusBadge(null), null);
});

test('iconCategory groups by category prefix, ignoring the trailing side index', () => {
  assert.equal(iconCategory('bomb-7').category, 'bomb');
  assert.equal(iconCategory('bomb-1').rawCategory, 'bomb');
  assert.equal(iconCategory('ak-6').category, 'ak');
  assert.equal(iconCategory('gun-3').category, 'ak'); // grouped: every small-arms variant reads as "ak"
  assert.equal(iconCategory('speech-7').category, 'speech');
  assert.equal(iconCategory('totally-unknown-9').category, 'unknown');
  assert.equal(iconCategory('totally-unknown-9').rawCategory, 'totally-unknown'); // kept even though unmapped
  assert.equal(iconCategory(null).category, 'unknown');
});

test('every iconCategory output has a matching drawn glyph in liveuamapIcons.js', () => {
  for (const [raw] of [
    ['bomb-7'], ['missile-1'], ['artillery-2'], ['air_alert-1'], ['aa-3'],
    ['ak-1'], ['tank-1'], ['drone-1'], ['plane-1'], ['heli-1'], ['ship-1'],
    ['capture-1'], ['flag-1'], ['rally-1'], ['speech-1'], ['fire-1'],
    ['casualty-1'], ['checkpoint-1'], ['nonsense-9'],
  ]) {
    const { category } = iconCategory(raw);
    assert.ok(LIVEUAMAP_ICON_CATEGORIES.includes(category), `${raw} -> ${category}`);
    assert.match(iconUriForCategory(category), /^data:image\/svg\+xml;base64,/);
  }
});

test('fieldShapeKind matches the CURRENT (Leaflet) drawField switch, not the legacy Google-Maps one', () => {
  // Regression guard for the "line drawn as an area" bug: the old codebase
  // used type_id 3/5 for lines. The live site does not — verify 3 and 5 are
  // NOT lines here, and that the real line/polygon split is correct.
  assert.equal(fieldShapeKind(3), 'polygon'); // legacy "arrow line" id — must NOT be treated as a line
  assert.equal(fieldShapeKind(5), 'polygon'); // legacy "measure line" id — same

  assert.equal(fieldShapeKind(4), 'polygon');
  assert.equal(fieldShapeKind(6), 'polygon'); // territory (reds vs blues)

  assert.equal(fieldShapeKind(13), 'line');
  assert.equal(fieldShapeKind(14), 'line');
  assert.equal(fieldShapeKind(614), 'line');
  assert.equal(fieldShapeKind(25), 'line-dashed'); // antPath

  assert.equal(fieldShapeKind(15), 'circle');
  assert.equal(fieldShapeKind(24), 'heatmap');

  assert.equal(fieldShapeKind(9999), 'polygon'); // unknown -> safe fallback
  assert.equal(fieldShapeKind(null), 'polygon');
});

test('relativeTime buckets a unix-seconds timestamp against now', () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now / 1000 - 30, now), 'just now');
  assert.equal(relativeTime(now / 1000 - 300, now), '5m ago');
  assert.equal(relativeTime(now / 1000 - 7200, now), '2h ago');
  assert.equal(relativeTime(now / 1000 - 172800, now), '2d ago');
  assert.equal(relativeTime(null, now), null);
});
