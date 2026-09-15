/**
 * Shared temperature → color gradient. Split out of `aemetStations.js` (its
 * original home) so `temperatureGradientRaster.js` can use the exact same
 * ramp without an import cycle (`aemetStations.js` → gradient raster builder
 * → back into `aemetStations.js` for the color scale). `aemetStations.js`
 * re-exports both names, so nothing importing from there needs to change.
 */

/**
 * Smooth temperature gradient, coldest to hottest — the standard
 * meteorological "rainbow" progression (violet → blue → cyan → green →
 * yellow → orange → red → magenta) that AEMET, Windy, Ventusky, and most
 * other weather services converge on for absolute-temperature maps: hue
 * itself carries the "how hot" signal, so a reader gets the gist without
 * consulting the legend. Anchors now span -15°C to 45°C, wide enough to
 * keep giving distinct color to Spain's actual station extremes — Pyrenean
 * winter lows and Andalusian heatwave highs (Córdoba hit 47.6°C in Aug
 * 2021) — instead of clipping them to the same shade as an ordinary cold or
 * hot day. The two new end stops (violet at -15, deep magenta/maroon at 45)
 * exist for that "this is exceptional" signal specifically: mid-scale colors
 * repeating at the extremes would flatten heatwave/cold-snap days into
 * whatever their nearest in-range neighbor already looked like.
 *
 * Deliberately NOT the raw-primary "jet" colormap despite the same hue path:
 * jet's saturated primaries create false perceptual banding around its
 * sharp yellow transition (a well-known critique of scientific/climate
 * visualizations — see Ed Hawkins' "which colour scale" writeup), so these
 * stops are softened/desaturated a step from pure RGB primaries, same as
 * this scale's previous version — only the anchor placement and range
 * changed, not that design choice.
 *
 * Stops are linearly interpolated between neighbors — a genuinely
 * continuous gradient rather than a small number of visually-identical
 * stepped bands. Plain RGB bytes, no Cesium, so it's testable without a
 * Cesium.Color round-trip — and usable by both the point layer and the
 * canvas-rasterized gradient overlay.
 */
export const TEMPERATURE_COLOR_STOPS = Object.freeze([
  Object.freeze({ c: -15, rgb: [120, 60, 165] }),
  Object.freeze({ c: -5, rgb: [70, 80, 195] }),
  Object.freeze({ c: 0, rgb: [60, 130, 255] }), // freezing point — kept as its own anchor, not just a point along the blue stretch
  Object.freeze({ c: 8, rgb: [65, 190, 230] }),
  Object.freeze({ c: 15, rgb: [90, 210, 150] }),
  Object.freeze({ c: 21, rgb: [160, 220, 90] }),
  Object.freeze({ c: 27, rgb: [255, 200, 50] }),
  Object.freeze({ c: 33, rgb: [255, 130, 40] }),
  Object.freeze({ c: 39, rgb: [225, 50, 40] }),
  Object.freeze({ c: 45, rgb: [150, 20, 60] }),
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
