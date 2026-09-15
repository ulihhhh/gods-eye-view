/**
 * Shared temperature → color gradient. Split out of `aemetStations.js` (its
 * original home) so `temperatureGradientRaster.js` can use the exact same
 * ramp without an import cycle (`aemetStations.js` → gradient raster builder
 * → back into `aemetStations.js` for the color scale). `aemetStations.js`
 * re-exports both names, so nothing importing from there needs to change.
 */

/**
 * Smooth temperature gradient, coldest to hottest. Anchor stops chosen for a
 * readable spread across the temperatures AEMET's Spain network actually
 * reports (roughly -10°C mountain lows to 40°C+ summer highs), linearly
 * interpolated between neighbors — a genuinely continuous gradient rather
 * than the small number of visually-identical stepped bands this started
 * with. Plain RGB bytes, no Cesium, so it's testable without a Cesium.Color
 * round-trip — and usable by both the point layer and the canvas-rasterized
 * gradient overlay.
 */
export const TEMPERATURE_COLOR_STOPS = Object.freeze([
  Object.freeze({ c: -10, rgb: [40, 60, 170] }),
  Object.freeze({ c: 0, rgb: [59, 108, 255] }),
  Object.freeze({ c: 10, rgb: [59, 182, 255] }),
  Object.freeze({ c: 18, rgb: [70, 220, 190] }),
  Object.freeze({ c: 24, rgb: [140, 230, 90] }),
  Object.freeze({ c: 28, rgb: [255, 210, 60] }),
  Object.freeze({ c: 33, rgb: [255, 140, 50] }),
  Object.freeze({ c: 40, rgb: [230, 40, 40] }),
]);

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Interpolate a temperature (°C) to an [r,g,b] byte triple along
 * TEMPERATURE_COLOR_STOPS. Values outside the range clamp to the nearest
 * end stop rather than extrapolating. Returns `null` for a non-finite input
 * — the caller substitutes a neutral "unknown" color, never a guessed one.
 * @param {number} temperatureC
 * @returns {[number, number, number]|null}
 */
export function temperatureColorRgb(temperatureC) {
  if (!Number.isFinite(temperatureC)) return null;
  const stops = TEMPERATURE_COLOR_STOPS;
  if (temperatureC <= stops[0].c) return stops[0].rgb;
  if (temperatureC >= stops[stops.length - 1].c) return stops[stops.length - 1].rgb;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (temperatureC >= a.c && temperatureC <= b.c) {
      const t = (temperatureC - a.c) / (b.c - a.c);
      return [
        Math.round(lerp(a.rgb[0], b.rgb[0], t)),
        Math.round(lerp(a.rgb[1], b.rgb[1], t)),
        Math.round(lerp(a.rgb[2], b.rgb[2], t)),
      ];
    }
  }
  return stops[stops.length - 1].rgb; // unreachable, kept for defensiveness
}
