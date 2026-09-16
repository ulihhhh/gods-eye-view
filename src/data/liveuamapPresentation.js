/**
 * Pure presentation helpers for the Liveuamap prototype layer — no Cesium, no
 * DOM, safe to unit-test. `liveuamap.js` turns these into actual Cesium
 * colors/canvases.
 *
 * We deliberately do NOT reproduce Liveuamap's own icon artwork (that's their
 * UI asset, not data) — `glyphForIcon` maps their icon *names* to plain emoji
 * stand-ins instead.
 */

/** Deterministic 0–359 hue from a string. */
function hash360(str) {
  let h = 0;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * Faction ("reds vs blues") color, keyed only by Liveuamap's numeric
 * `sideId` — NOT by region — so the same side reads as the same color on
 * every map it appears on. Falls back to a per-region hue when a row has no
 * side at all.
 * @param {number|null|undefined} sideId
 * @param {string} region Fallback key when sideId is missing.
 * @returns {string} CSS `hsl(...)` color.
 */
export function sideColorCss(sideId, region) {
  const hue = Number.isFinite(sideId)
    ? hash360(`side:${sideId}`)
    : hash360(`region:${region}`);
  return `hsl(${hue}, 68%, 56%)`;
}

/** Liveuamap status_id -> a short badge tag, color, and label (site's own copy, trimmed). */
export const STATUS_BADGE = Object.freeze({
  verified: { color: '#2ecc71', label: 'VERIFIED' },
  rumor: { color: '#f1c40f', label: 'RUMOR' },
  fake: { color: '#e74c3c', label: 'FAKE' },
  outdated: { color: '#8a8f98', label: 'OUTDATED' },
  'location-unknown': { color: '#9b59b6', label: 'LOC. UNKNOWN' },
  ad: { color: '#8e44ad', label: 'SPONSORED' },
});

/** @param {string|null|undefined} statusTag From liveuamapNormalize's `status.tag`. */
export function statusBadge(statusTag) {
  return (statusTag && STATUS_BADGE[statusTag]) || null;
}

// Liveuamap icon NAME prefix -> one of `liveuamapIcons.js`'s drawn categories.
// Several raw prefixes share one drawn glyph (e.g. every gun variant reads as
// "ak") — that's a many-to-one grouping, not a 1:1 name translation.
const ICON_CATEGORIES = Object.freeze([
  [/^bomb/, 'bomb'],
  [/^(missile|rocket)/, 'bomb'],
  [/^artiller/, 'artillery'],
  [/^air_alert/, 'air_alert'],
  [/^aa[-_]?\d*$/, 'aa'],
  [/^(ak|gun|small_arms)/, 'ak'],
  [/^(tank|armor)/, 'tank'],
  [/^(drone|uav)/, 'drone'],
  [/^(plane|air)/, 'plane'],
  [/^heli/, 'heli'],
  [/^ship/, 'ship'],
  [/^(capture|flag)/, 'capture'],
  [/^(rally|protest)/, 'rally'],
  [/^speech/, 'speech'],
  [/^fire/, 'fire'],
  [/^casualty/, 'casualty'],
  [/^checkpoint/, 'checkpoint'],
]);
const DEFAULT_CATEGORY = 'unknown';

/**
 * Map a Liveuamap icon NAME (e.g. "bomb-7", "ak-1") to one of
 * `liveuamapIcons.js`'s drawn categories, grouped by the name's prefix
 * (before the trailing `-<side index>`). We deliberately do NOT reproduce
 * Liveuamap's own icon artwork here — `liveuamapIcons.js` draws small
 * original glyphs keyed by this category.
 * @param {string|null|undefined} icon
 * @returns {{category: string, rawCategory: string}} `category` is always a
 *   key `liveuamapIcons.js` knows how to draw; `rawCategory` is the
 *   unmapped prefix as parsed, kept for display/debugging even when it
 *   didn't match anything (falls back to `category` when the icon is blank).
 */
export function iconCategory(icon) {
  const name = String(icon ?? '')
    .trim()
    .toLowerCase();
  const rawCategory = name.replace(/-\d+$/, '') || DEFAULT_CATEGORY;
  for (const [rx, category] of ICON_CATEGORIES) {
    if (rx.test(rawCategory)) return { category, rawCategory };
  }
  return { category: DEFAULT_CATEGORY, rawCategory };
}

/**
 * Liveuamap field `type_id` -> what shape to draw it as.
 *
 * Traced from the site's own current (Leaflet-based) `drawField()` — NOT the
 * old 2014 Google-Maps codebase, whose type_ids (3 = arrow line, 5 = measure
 * line) no longer match. Getting this wrong is exactly how a real line — the
 * North Crimean Canal front, a Hezbollah supply route — ends up painted as a
 * filled area: `L.polyline`/`antPath` calls (13, 14, 25, 614) render a path;
 * only 4 and 6 call `L.polygon`.
 *
 *   4   L.polygon        simple area
 *   6   L.polygon        multi-ring territory (the "reds vs blues" areas)
 *  13   L.polyline       plain line
 *  14   L.polyline       line, optionally dashed (symbolpath carries the dash spec)
 *  25   L.polyline.antPath  animated dashed line ("marching ants" — active movement)
 * 614   L.polyline       plain line (same rendering as 13/14)
 *  15   L.circle         NOT geometry-compatible with points/rings — unsupported here
 *  24   L.heatLayer      heatmap — unsupported here
 *
 * Anything else falls back to 'polygon': safer than dropping unrecognized
 * territory data outright, and matches the pre-fix behavior for whatever we
 * haven't seen yet.
 * @param {number|null|undefined} typeId
 * @returns {'polygon'|'line'|'line-dashed'|'circle'|'heatmap'}
 */
export function fieldShapeKind(typeId) {
  switch (Math.round(Number(typeId))) {
    case 4:
    case 6:
      return 'polygon';
    case 13:
    case 14:
    case 614:
      return 'line';
    case 25:
      return 'line-dashed';
    case 15:
      return 'circle';
    case 24:
      return 'heatmap';
    default:
      return 'polygon';
  }
}

/** Short "Xm/Xh/Xd ago" from a unix-seconds timestamp, for the click popup. */
export function relativeTime(timestampSec, nowMs = Date.now()) {
  if (!Number.isFinite(timestampSec)) return null;
  const diffS = Math.max(0, Math.round(nowMs / 1000 - timestampSec));
  if (diffS < 60) return 'just now';
  const diffM = Math.round(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.round(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  return `${diffD}d ago`;
}
