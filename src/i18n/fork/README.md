# Fork-only translations

Spanish, Russian, German, French, Italian, Japanese, Brazilian Portuguese, Ukrainian, Simplified and Traditional Chinese text of the fork's own layers (AEMET, Liveuamap, Rail network,
Barcelona Arrivals, the Transit card's Spanish-feed lines). Upstream's catalogs in
`src/i18n/locales/` stay untouched, so syncs don't conflict on them.

- `<locale>.json` (one per upstream locale: `de`, `es`, `fr`, `it`, `ja`, `pt`, `ru`, `uk`, `zh-CN`, `zh-Hant`): merged over upstream's catalogs at load (`src/i18n/index.js`) and
  by `npm run i18n` (`scripts/i18n.mjs`, `readCatalog`).
- `same-as-english.json`: fork entries that read the same as the English on purpose
  (`METRO`, `{minutes} min`), merged with upstream's list.
- `src/i18n/forkCatalog.test.mjs` fails when an entry here duplicates one upstream already
  has. After a sync, delete the duplicate here and keep upstream's.
- `src/i18n/forkLayers.test.mjs` renders some of the cards in Spanish and Russian.

Workflow for new fork text: mark it with `t()`, `tn()` or `msg()` (see `docs/I18N.md`).
Then run `npm run i18n -- --missing <locale>` for every locale above, and add the
entries **here**, not in `src/i18n/locales/`. Like upstream, `zh-Hant.json` is
`zh-CN.json` converted with OpenCC s2tw (plus upstream's fixes: 年歷史, 下游, 併道, 發布, 公布).

Card builders that the server or AI tools also import must not load the catalogs. They
take `{t, tn, locale}` from the caller instead, with the English defaults in
`src/data/englishText.js`.
