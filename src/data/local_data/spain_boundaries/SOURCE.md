# Bundled Spain province boundaries — provenance & license

`provinces.json` gives the temperature-gradient overlay (`src/data/spainBoundaries.js`) real
provincial boundary polygons, used to (1) clip the interpolated temperature raster to Spain's
outline and (2) draw province border reference lines on top of it (`src/data/aemetStations.js`'s
`_buildBordersOnce`). Same "bundled offline pack, lazy-loaded + cached" pattern as
`natural_earth/regions.json` and `neighborhoods/*.json`.

## Provenance

| File | Source | License | Retrieved |
|---|---|---|---|
| `provinces.json` | [`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector) — `geojson/ne_10m_admin_1_states_provinces.geojson`, filtered to `admin=Spain` | **Public domain** | 2026-09-16 |

- **Downloaded from:** `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson`
  (HTTP 200, 40,726,851 bytes — whole-world admin-1 file — retrieved 2026-09-16; commit
  `117488dc884bad03366ff727eca013e434615127`, 2022-05-05, per that path's GitHub commit history).
- **License:** public domain (https://www.naturalearthdata.com/about/terms-of-use/). No
  attribution legally required — same source family already used for
  `local_data/natural_earth/{regions,marine}.json` (see that directory's README.md).
- **Content:** 52 features filtered to `properties.admin === 'Spain'` — Natural Earth's admin-1
  layer treats Spain's 50 provinces (`properties.type_en: "Autonomous Community"`, Natural
  Earth's own label for the tier — the real administrative level is province) plus Ceuta and
  Melilla (`"Autonomous City"`) as its units. Each feature's `properties.region` names its
  parent comunidad autónoma (e.g. `Cádiz → "Andalucía"`, `Navarra → "Foral de Navarra"`),
  carried through as `ccaaId`/`ccaaName`.
- **Why this replaced the previous `ccaa.json` (click_that_hood, 19 comunidad-autónoma
  features):** that source's raw geometry was already almost fully preserved even at its
  0.006°/~650m simplification tolerance (major boundary rings kept ~96% of their raw vertices)
  — there was no more real detail left to extract from it. This dataset's real (≥100-point)
  rings carry roughly 3.8x the vertex density (13,512 vs. 3,510), genuinely finer real boundary
  detail, not interpolation, and at province level it now lines up with the provincial-capital
  labels already bundled in `spainCapitals.js`.
- **Transform:** outer rings only (holes dropped — none of these boundaries meaningfully have
  any), Douglas-Peucker simplified per ring at 0.001° tolerance (~100 m — light cleanup of
  redundant collinear points, not a resolution cut), coordinates rounded to 4 decimals (~11 m).
  A ring that simplifies down to fewer than 4 points is dropped (same noise-filtering call the
  previous pack made). 14,357 → 12,150 vertices; ~590 KB raw (Spain-filtered) → 215 KB bundled.
  Feature `id`/`ccaaId` are slugified (lowercase, diacritics stripped, non-alphanumerics → `-`).
  Reproducible via `scripts/build-spain-boundaries.mjs`.

## File format

```
{
  meta: { source, description, epsilonDeg, featureCount },
  features: [ { id, name, ccaaId, ccaaName, rings: [ [ [lon, lat], ... ], ... ] }, ... ]
}
```

`rings` is one array per outer ring (a province can be multi-part — e.g. Baleares, Las Palmas,
Santa Cruz de Tenerife, and Galicia's coastal provinces each contribute their own ring);
coordinates are `[lon, lat]`, same convention as `natural_earth/regions.json`.
