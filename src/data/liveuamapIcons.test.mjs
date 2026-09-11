import test from 'node:test';
import assert from 'node:assert/strict';

import { iconUriForCategory, LIVEUAMAP_ICON_CATEGORIES } from './liveuamapIcons.js';

function decodeSvg(uri) {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const b64 = uri.slice('data:image/svg+xml;base64,'.length);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Every attribute name inside one tag must be unique — SVG/XML forbids a
 * repeated attribute on the same element (a browser silently fails to parse
 * the whole document, so the billboard just shows a broken-image icon). This
 * is exactly the bug the "ak" and "heli" glyphs shipped with once: `stroke=`
 * set once inline and again via the shared ${STROKE} constant on one tag.
 */
function findDuplicateAttrTags(svg) {
  const offenders = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const tag = m[0];
    const attrNames = [...tag.matchAll(/([a-zA-Z-]+)=/g)].map((a) => a[1]);
    const seen = new Set();
    for (const name of attrNames) {
      if (seen.has(name)) {
        offenders.push({ tag, name });
        break;
      }
      seen.add(name);
    }
  }
  return offenders;
}

test('every drawn category produces a well-formed SVG data URI', () => {
  for (const category of LIVEUAMAP_ICON_CATEGORIES) {
    const svg = decodeSvg(iconUriForCategory(category));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.equal((svg.match(/</g) || []).length, (svg.match(/>/g) || []).length);
    assert.deepEqual(findDuplicateAttrTags(svg), [], `${category} has a duplicate-attribute tag`);
  }
});

test('iconUriForCategory falls back to the "unknown" pin for an unrecognized category', () => {
  assert.equal(iconUriForCategory('not-a-real-category'), iconUriForCategory('unknown'));
});

test('iconUriForCategory is cached per category+size', () => {
  assert.equal(iconUriForCategory('bomb', 48), iconUriForCategory('bomb', 48));
  assert.notEqual(iconUriForCategory('bomb', 48), iconUriForCategory('bomb', 64));
});

test('LIVEUAMAP_ICON_CATEGORIES includes "unknown"', () => {
  assert.ok(LIVEUAMAP_ICON_CATEGORIES.includes('unknown'));
});
