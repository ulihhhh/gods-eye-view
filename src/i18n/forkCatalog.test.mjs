import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { catalogPath, forkCatalogPath } from '../../scripts/i18n.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

for (const locale of ['de', 'es', 'fr', 'it', 'ja', 'pt', 'ru', 'uk']) {
  test(`${locale}: the fork catalog repeats nothing upstream already translates`, () => {
    const upstream = readJson(catalogPath(locale));
    const repeated = Object.keys(readJson(forkCatalogPath(locale))).filter(
      (text) => Object.hasOwn(upstream, text),
    );
    assert.deepEqual(
      repeated,
      [],
      `drop these from src/i18n/fork/${locale}.json: upstream's entry wins`,
    );
  });
}
