/**
 * Spain's 52 "capitales de provincia" — the 50 provincial capitals plus the
 * autonomous cities Ceuta and Melilla — used to label the AEMET temperature
 * gradient with per-city numbers (`aemetStations.js`'s gradient view mode)
 * instead of only a color surface.
 *
 * Coordinates are hand-authored city-center points (each city's main
 * square/ayuntamiento or historic center), cross-checked against public
 * reference points (OpenStreetMap/Wikipedia), accurate to roughly street
 * level. That's well within the spacing of AEMET's ~850-station network, so
 * it's sufficient for "nearest station" matching — not survey-grade, and not
 * meant for anything requiring better precision.
 *
 * Plain synchronous data, unlike `spainBoundaries.js`/`naturalEarthRegions.js`
 * (which lazy-load JSON packs to keep multi-MB geometry out of the JS parse
 * path): at ~52 tiny records there's no such payload to justify a loader, and
 * that indirection would only reintroduce the fragile Vite dynamic-JSON-import
 * behavior already found and fixed twice elsewhere in `src/data/`.
 *
 * `spainBoundaries.js`'s bundled pack is now also province-level (Natural
 * Earth's admin-1 layer), so these capitals and those boundary polygons
 * describe the same 52 administrative units — just not cross-referenced by
 * id here, since nothing currently needs that join.
 *
 * PURE data module — no Cesium import, node-testable.
 */

/** @typedef {{id: string, name: string, lat: number, lon: number}} ProvincialCapital */

/** @type {ProvincialCapital[]} */
export const SPAIN_PROVINCIAL_CAPITALS = [
  {
    id: 'vitoria-gasteiz',
    name: 'Vitoria-Gasteiz',
    lat: 42.8467,
    lon: -2.6716,
  },
  { id: 'albacete', name: 'Albacete', lat: 38.9943, lon: -1.8585 },
  { id: 'alicante', name: 'Alicante', lat: 38.3452, lon: -0.481 },
  { id: 'almeria', name: 'Almería', lat: 36.8381, lon: -2.4597 },
  { id: 'oviedo', name: 'Oviedo', lat: 43.3603, lon: -5.8448 },
  { id: 'avila', name: 'Ávila', lat: 40.6566, lon: -4.6818 },
  { id: 'badajoz', name: 'Badajoz', lat: 38.8794, lon: -6.9707 },
  { id: 'palma', name: 'Palma', lat: 39.5696, lon: 2.6502 },
  { id: 'barcelona', name: 'Barcelona', lat: 41.3874, lon: 2.1686 },
  { id: 'burgos', name: 'Burgos', lat: 42.3439, lon: -3.6969 },
  { id: 'caceres', name: 'Cáceres', lat: 39.4753, lon: -6.3724 },
  { id: 'cadiz', name: 'Cádiz', lat: 36.5271, lon: -6.2886 },
  { id: 'santander', name: 'Santander', lat: 43.4623, lon: -3.8099 },
  {
    id: 'castellon-de-la-plana',
    name: 'Castellón de la Plana',
    lat: 39.9864,
    lon: -0.0513,
  },
  { id: 'ciudad-real', name: 'Ciudad Real', lat: 38.9848, lon: -3.9274 },
  { id: 'cordoba', name: 'Córdoba', lat: 37.8882, lon: -4.7794 },
  { id: 'cuenca', name: 'Cuenca', lat: 40.0704, lon: -2.1374 },
  { id: 'girona', name: 'Girona', lat: 41.9794, lon: 2.8214 },
  { id: 'granada', name: 'Granada', lat: 37.1773, lon: -3.5986 },
  { id: 'guadalajara', name: 'Guadalajara', lat: 40.6333, lon: -3.1669 },
  { id: 'san-sebastian', name: 'San Sebastián', lat: 43.3183, lon: -1.9812 },
  { id: 'huelva', name: 'Huelva', lat: 37.2614, lon: -6.9447 },
  { id: 'huesca', name: 'Huesca', lat: 42.1401, lon: -0.4089 },
  { id: 'jaen', name: 'Jaén', lat: 37.7796, lon: -3.7849 },
  { id: 'a-coruna', name: 'A Coruña', lat: 43.3623, lon: -8.4115 },
  { id: 'logrono', name: 'Logroño', lat: 42.4627, lon: -2.4449 },
  {
    id: 'las-palmas-de-gran-canaria',
    name: 'Las Palmas de Gran Canaria',
    lat: 28.1235,
    lon: -15.4363,
  },
  { id: 'leon', name: 'León', lat: 42.5987, lon: -5.5671 },
  { id: 'lleida', name: 'Lleida', lat: 41.6176, lon: 0.62 },
  { id: 'lugo', name: 'Lugo', lat: 43.0121, lon: -7.5559 },
  { id: 'madrid', name: 'Madrid', lat: 40.4168, lon: -3.7038 },
  { id: 'malaga', name: 'Málaga', lat: 36.7213, lon: -4.4214 },
  { id: 'murcia', name: 'Murcia', lat: 37.9922, lon: -1.1307 },
  { id: 'pamplona', name: 'Pamplona', lat: 42.8125, lon: -1.6458 },
  { id: 'ourense', name: 'Ourense', lat: 42.3358, lon: -7.8639 },
  { id: 'palencia', name: 'Palencia', lat: 42.0096, lon: -4.5288 },
  { id: 'pontevedra', name: 'Pontevedra', lat: 42.431, lon: -8.6444 },
  { id: 'salamanca', name: 'Salamanca', lat: 40.9701, lon: -5.6635 },
  {
    id: 'santa-cruz-de-tenerife',
    name: 'Santa Cruz de Tenerife',
    lat: 28.4636,
    lon: -16.2518,
  },
  { id: 'segovia', name: 'Segovia', lat: 40.9429, lon: -4.1088 },
  { id: 'sevilla', name: 'Sevilla', lat: 37.3891, lon: -5.9845 },
  { id: 'soria', name: 'Soria', lat: 41.7666, lon: -2.479 },
  { id: 'tarragona', name: 'Tarragona', lat: 41.1189, lon: 1.2445 },
  { id: 'teruel', name: 'Teruel', lat: 40.3456, lon: -1.1065 },
  { id: 'toledo', name: 'Toledo', lat: 39.8628, lon: -4.0273 },
  { id: 'valencia', name: 'Valencia', lat: 39.4699, lon: -0.3763 },
  { id: 'valladolid', name: 'Valladolid', lat: 41.6523, lon: -4.7245 },
  { id: 'bilbao', name: 'Bilbao', lat: 43.263, lon: -2.935 },
  { id: 'zamora', name: 'Zamora', lat: 41.5033, lon: -5.7446 },
  { id: 'zaragoza', name: 'Zaragoza', lat: 41.6488, lon: -0.8891 },
  { id: 'ceuta', name: 'Ceuta', lat: 35.8894, lon: -5.3213 },
  { id: 'melilla', name: 'Melilla', lat: 35.2923, lon: -2.9381 },
];
