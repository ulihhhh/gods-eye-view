# Bundled Spain CCAA boundaries — provenance & license

`ccaa.json` gives the temperature-gradient overlay (`src/data/spainBoundaries.js`) real
comunidad-autónoma / ciudad-autónoma boundary polygons, used to (1) clip the interpolated
temperature raster to Spain's outline and (2) draw the CCAA borders as reference lines on
top of it. Same "bundled offline pack, lazy-loaded + cached" pattern as
`natural_earth/regions.json` and `neighborhoods/*.json`.

## Provenance

| File | Source | License | Retrieved |
|---|---|---|---|
| `ccaa.json` | [`codeforamerica/click_that_hood`](https://github.com/codeforamerica/click_that_hood) — `public/data/spain-communities.geojson` | **MIT** (repo-level license, confirmed via GitHub API) | 2026-09-15 |

- **Downloaded from:** `https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/spain-communities.geojson`
  (HTTP 200, 1,267,461 bytes, retrieved 2026-09-15).
- **License evidence:** `https://api.github.com/repos/codeforamerica/click_that_hood` reports
  `"license": {"key": "mit", "name": "MIT License", ...}`.
- **Content:** 19 features — the 17 comunidades autónomas plus the 2 ciudades autónomas
  (Ceuta, Melilla).
- **Transform:** outer rings only (holes dropped — none of these boundaries meaningfully
  have any), Douglas-Peucker simplified per ring at 0.006° tolerance (~650 m), coordinates
  rounded to 4 decimals (~11 m). A ring that simplifies down to fewer than 4 points (a tiny
  islet/rock indistinguishable from noise at this tolerance) is dropped rather than kept as
  a degenerate 2-point "polygon" — 3,811 of ~3,869 raw rings were exactly that; every named
  island of any real size (Mallorca, Menorca, Ibiza, Formentera, Cabrera, all 8 Canary
  Islands, …) survives with its own ring. 23,179 → 3,997 vertices; 1.21 MB raw → 70 KB
  bundled. Feature `id` is a slugified version of the source `name` property (lowercase,
  diacritics stripped, non-alphanumerics → `-`).

## File format

```
{
  meta: { source, description, epsilonDeg, featureCount },
  features: [ { id, name, rings: [ [ [lon, lat], ... ], ... ] }, ... ]
}
```

`rings` is one array per outer ring (a CCAA can be multi-part — e.g. Canarias, Baleares,
and Galicia's many coastal islets each contribute their own ring); coordinates are
`[lon, lat]`, same convention as `natural_earth/regions.json`.
