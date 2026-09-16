/**
 * Category glyphs for the Liveuamap prototype layer, as SVG data URIs for
 * Cesium billboards — same technique as `aircraftIcons.js`: white fill with a
 * dark hairline stroke, so `billboard.color` tints the whole glyph (faction
 * color) via Cesium's normal multiply pass. No emoji, no font dependency, and
 * — deliberately — none of Liveuamap's own icon artwork; these are simple
 * original line-glyphs, one per event category.
 *
 * `iconUriForCategory` takes the `category` string `liveuamapPresentation.js`
 * derives from the raw `picpath` (e.g. "bomb-7" -> "bomb").
 */

const VIEW = 64;
const C = VIEW / 2; // 32 — glyph centre, all bodies drawn in this frame

const STROKE =
  'stroke="rgba(0,0,0,0.35)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"';
const CUT = 'fill="rgba(0,0,0,0.55)"'; // dark "cut-out" detail on top of a white glyph

// Bodies are drawn in a centred coordinate frame (0,0 = glyph centre).
const BODIES = {
  // 8-point burst — airstrike / explosion.
  bomb: `<polygon points="0,-27 3.8,-9.2 19.1,-19.1 9.2,-3.8 27,0 9.2,3.8 19.1,19.1 3.8,9.2 0,27 -3.8,9.2 -19.1,19.1 -9.2,3.8 -27,0 -9.2,-3.8 -19.1,-19.1 -3.8,-9.2" fill="white" ${STROKE}/>`,

  // 6-point burst, smaller — artillery / shelling (distinct from the bomb burst).
  artillery: `<polygon points="0,-20 4.5,-7.8 17.3,-10 9,0 17.3,10 4.5,7.8 0,20 -4.5,7.8 -17.3,10 -9,0 -17.3,-10 -4.5,-7.8" fill="white" ${STROKE}/>`,

  // Warning triangle with a dark exclamation mark.
  air_alert: `<polygon points="0,-22 24,22 -24,22" fill="white" ${STROKE}/>
    <rect x="-3" y="-10" width="6" height="16" rx="2" ${CUT}/>
    <circle cx="0" cy="12" r="3.4" ${CUT}/>`,

  // Rounded shield — air defense.
  aa: `<polygon points="0,-24 22,-12 18,18 0,26 -18,18 -22,-12" fill="white" ${STROKE}/>`,

  // Crossed lines — small arms / clashes. (Dark backing line + white line on
  // top, not a combined stroke — an element can't carry two `stroke` attrs.)
  ak: `<line x1="-18" y1="-18" x2="18" y2="18" stroke="rgba(0,0,0,0.35)" stroke-width="9" stroke-linecap="round"/>
    <line x1="-18" y1="-18" x2="18" y2="18" stroke="white" stroke-width="6" stroke-linecap="round"/>
    <line x1="18" y1="-18" x2="-18" y2="18" stroke="rgba(0,0,0,0.35)" stroke-width="9" stroke-linecap="round"/>
    <line x1="18" y1="-18" x2="-18" y2="18" stroke="white" stroke-width="6" stroke-linecap="round"/>`,

  // Hull + turret + barrel — armor.
  tank: `<rect x="-20" y="2" width="40" height="16" rx="4" fill="white" ${STROKE}/>
    <circle cx="0" cy="-2" r="11" fill="white" ${STROKE}/>
    <rect x="-2.5" y="-24" width="5" height="24" rx="2" fill="white" ${STROKE}/>`,

  // Quad frame — drone / UAV.
  drone: `<rect x="-18" y="-2" width="36" height="4" rx="2" fill="white" ${STROKE}/>
    <rect x="-2" y="-18" width="4" height="36" rx="2" fill="white" ${STROKE}/>
    <circle cx="-18" cy="0" r="7" fill="white" ${STROKE}/>
    <circle cx="18" cy="0" r="7" fill="white" ${STROKE}/>
    <circle cx="0" cy="-18" r="7" fill="white" ${STROKE}/>
    <circle cx="0" cy="18" r="7" fill="white" ${STROKE}/>`,

  // Dart / delta silhouette — fixed-wing aircraft.
  plane: `<polygon points="0,-24 12,20 0,12 -12,20" fill="white" ${STROKE}/>`,

  // Fuselage + rotor + tail boom — helicopter.
  heli: `<line x1="-22" y1="-14" x2="22" y2="-14" stroke="rgba(0,0,0,0.35)" stroke-width="6" stroke-linecap="round"/>
    <line x1="-22" y1="-14" x2="22" y2="-14" stroke="white" stroke-width="3" stroke-linecap="round"/>
    <rect x="-1.5" y="-14" width="3" height="8" fill="white" ${STROKE}/>
    <ellipse cx="-2" cy="4" rx="14" ry="9" fill="white" ${STROKE}/>
    <rect x="12" y="1" width="16" height="4" rx="2" fill="white" ${STROKE}/>`,

  // Hull + mast + sail — vessel.
  ship: `<polygon points="-22,14 22,14 14,24 -12,24" fill="white" ${STROKE}/>
    <rect x="-1.5" y="-18" width="3" height="32" fill="white" ${STROKE}/>
    <polygon points="1.5,-18 1.5,6 15,-4" fill="white" ${STROKE}/>`,

  // Pole + flag — captured / seized.
  capture: `<rect x="-11" y="-24" width="3" height="44" rx="1.5" fill="white" ${STROKE}/>
    <polygon points="-8,-22 18,-13 -8,-4" fill="white" ${STROKE}/>`,

  // Megaphone — rally / protest.
  rally: `<polygon points="-20,-10 4,-18 4,18 -20,10" fill="white" ${STROKE}/>
    <rect x="-26" y="-6" width="8" height="12" rx="2" fill="white" ${STROKE}/>
    <path d="M12,-10 Q22,0 12,10" fill="none" stroke="white" stroke-width="3.4" stroke-linecap="round"/>
    <path d="M18,-15 Q30,0 18,15" fill="none" stroke="white" stroke-width="3.4" stroke-linecap="round"/>`,

  // Rounded bubble + tail — statement / speech.
  speech: `<rect x="-22" y="-14" width="44" height="26" rx="8" fill="white" ${STROKE}/>
    <polygon points="-10,12 -10,24 2,12" fill="white" ${STROKE}/>`,

  // Flame — fire.
  fire: `<path d="M0,-22 C8,-10 14,-2 14,8 C14,18 8,24 0,24 C-8,24 -14,18 -14,8 C-14,-2 -8,-10 0,-22 Z" fill="white" ${STROKE}/>`,

  // Circle with a dark medical cross — casualty.
  casualty: `<circle cx="0" cy="0" r="22" fill="white" ${STROKE}/>
    <rect x="-5" y="-14" width="10" height="28" ${CUT}/>
    <rect x="-14" y="-5" width="28" height="10" ${CUT}/>`,

  // Bar across two posts — checkpoint.
  checkpoint: `<rect x="-22" y="6" width="6" height="18" rx="2" fill="white" ${STROKE}/>
    <rect x="16" y="6" width="6" height="18" rx="2" fill="white" ${STROKE}/>
    <rect x="-24" y="-8" width="48" height="10" rx="3" fill="white" ${STROKE}/>
    <line x1="-18" y1="-8" x2="-10" y2="2" stroke="rgba(0,0,0,0.4)" stroke-width="3"/>
    <line x1="-2" y1="-8" x2="6" y2="2" stroke="rgba(0,0,0,0.4)" stroke-width="3"/>
    <line x1="14" y1="-8" x2="22" y2="2" stroke="rgba(0,0,0,0.4)" stroke-width="3"/>`,

  // Map pin — default / unrecognized category.
  unknown: `<circle cx="0" cy="-6" r="14" fill="white" ${STROKE}/>
    <polygon points="-12,2 12,2 0,22" fill="white" ${STROKE}/>`,
};

const _cache = new Map();

const _b64 = (s) =>
  typeof btoa === 'function'
    ? btoa(s)
    : Buffer.from(s, 'utf8').toString('base64');

/**
 * Data URI for a category glyph (lazily built, cached per category+size).
 * @param {string|null|undefined} category From `liveuamapPresentation.js`'s
 *   `iconCategory(picpath)` — an unrecognized value falls back to the pin.
 * @param {number} [px=48] Raster size in device pixels.
 * @returns {string} `data:image/svg+xml;base64,...`
 */
export function iconUriForCategory(category, px = 48) {
  const key = BODIES[category] ? category : 'unknown';
  const cacheKey = `${key}@${px}`;
  let uri = _cache.get(cacheKey);
  if (!uri) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${VIEW} ${VIEW}"><g transform="translate(${C},${C})">${BODIES[key]}</g></svg>`;
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _cache.set(cacheKey, uri);
  }
  return uri;
}

export const LIVEUAMAP_ICON_CATEGORIES = Object.freeze(Object.keys(BODIES));
