/**
 * Pure normalizers for raw Liveuamap map state (`window.ovens` / `window.markers`).
 *
 * The browser-side bridge extension sends the site's own decoded objects here
 * verbatim; the dev-server ingest endpoint runs these to produce the flat,
 * JSON-safe snapshot the `/api/liveuamap` reader and the map layer consume.
 * No DOM, no Cesium, no network — safe to unit-test and to run server-side.
 *
 * LOCAL PROTOTYPE ONLY. Liveuamap data is a paid, non-redistributable product;
 * see DATA_SOURCES.md.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v) => {
  const t = String(v ?? '').trim();
  return t || null;
};

/** Liveuamap status_id -> a short credibility tag + human line (site's own copy). */
export const LIVEUAMAP_STATUS = Object.freeze({
  1: { tag: 'rumor', label: 'Not confirmed — possible fake or hoax' },
  2: { tag: 'fake', label: 'Confirmed fake' },
  3: { tag: 'verified', label: 'Confirmed and verified' },
  5: { tag: 'ad', label: 'Paid commercial content' },
  6: { tag: 'location-unknown', label: 'Event location is not known' },
  10: { tag: 'outdated', label: 'Old — does not reflect recent events' },
});

/** Attached-video type -> a coarse provider label. */
export function videoKind(videotype) {
  switch (Math.round(Number(videotype) || 0)) {
    case 1:
      return 'youtube';
    case 5:
    case 10:
      return 'iframe';
    case 11:
      return 'facebook';
    case 0:
      return null;
    default:
      return 'other';
  }
}

/** Parse the `otherregions` field (JSON string or array) into [{name, link, id}]. */
export function parseOtherRegions(value) {
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => ({ name: text(r?.name), link: text(r?.link), id: num(r?.id) }))
    .filter((r) => r.name || r.id !== null);
}

/** Extra marker positions for a multi-location event: [{lat,lng}, ...] -> [[lat,lng], ...]. */
export function eventPoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map((p) => [num(p?.lat), num(p?.lng)])
    .filter(([a, b]) => a !== null && b !== null);
}

/** One Liveuamap "venue" (news event) -> flat record. */
export function normalizeEvent(v) {
  if (!v || typeof v !== 'object') return null;
  const lat = num(v.lat);
  const lng = num(v.lng);
  if (lat === null || lng === null) return null;

  const statusId = num(v.status_id);
  const pictures = [];
  if (text(v.picture)) pictures.push(v.picture.trim());
  for (const p of Array.isArray(v.ps) ? v.ps : []) {
    const s = text(p);
    if (s && !pictures.includes(s)) pictures.push(s);
  }

  return {
    id: String(v.id ?? ''),
    name: text(v.name) ?? '',
    source: text(v.source),
    description: text(v.description) ?? text(v.udescription),
    lat,
    lng,
    extraPoints: eventPoints(v.points).filter(
      ([a, b]) => a !== lat || b !== lng,
    ),
    timestamp: num(v.timestamp), // unix seconds
    timeAgo: text(v.time),
    city: text(v.city) ?? text(v.location),
    icon: text(v.picpath),
    iconW: num(v.picw),
    iconH: num(v.pich),
    categoryId: num(v.cat_id),
    sideId: num(v.color_id), // Liveuamap's faction / "reds-vs-blues" colour bucket
    statusId,
    status: statusId != null ? (LIVEUAMAP_STATUS[statusId] ?? null) : null,
    pictures,
    twitpic: text(v.twitpic),
    video: text(v.video),
    videoKind: videoKind(v.videotype),
    otherRegions: parseOtherRegions(v.otherregions),
    langs: text(v.langs)
      ? v.langs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    animatedPath:
      v.runway && typeof v.runway === 'object'
        ? {
            points: v.runway.pt ?? null,
            times: v.runway.tm ?? null,
            angles: v.runway.an ?? null,
          }
        : null,
  };
}

/** Flatten Liveuamap field `points` (several shapes by type_id) into rings of [lat,lng]. */
export function fieldRings(points) {
  if (!Array.isArray(points) || !points.length) return [];
  // shape A: [{lat,lng}, ...]  -> single ring
  if (points[0] && typeof points[0] === 'object' && !Array.isArray(points[0])) {
    const ring = points
      .map((p) => [num(p.lat), num(p.lng)])
      .filter(([a, b]) => a !== null && b !== null);
    return ring.length >= 2 ? [ring] : [];
  }
  // shape B: [[lat,lng,lat,lng,...], [...]]  -> many rings, flat pairs
  if (Array.isArray(points[0])) {
    return points
      .map((flat) => {
        const ring = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const a = num(flat[i]);
          const b = num(flat[i + 1]);
          if (a !== null && b !== null) ring.push([a, b]);
        }
        return ring;
      })
      .filter((r) => r.length >= 2);
  }
  // shape C: flat [lat,lng,lat,lng,...] -> single ring
  const ring = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const a = num(points[i]);
    const b = num(points[i + 1]);
    if (a !== null && b !== null) ring.push([a, b]);
  }
  return ring.length >= 2 ? [ring] : [];
}

/** One Liveuamap "field" (territory polygon / arrow / line / heatmap) -> flat record. */
export function normalizeField(f) {
  if (!f || typeof f !== 'object') return null;
  const rings = fieldRings(f.points);
  if (!rings.length) return null;
  return {
    id: String(f.id ?? ''),
    name: text(f.name),
    description: text(f.description),
    typeId: num(f.type_id), // 3 arrow · 4 polygon · 5 measure line · 6 territory · 24 heatmap
    sideId: num(f.color_id),
    strokeColor: text(f.strokecolor),
    strokeWidth: num(f.strokeweight),
    strokeOpacity: num(f.strokeopacity),
    fillColor: text(f.fillcolor),
    fillOpacity: num(f.fillopacity),
    symbol: text(f.symbolpath),
    rings,
  };
}

/**
 * Raw bridge payload -> the on-disk snapshot shape.
 *
 * Territory geometry comes from `payload.fieldsCache` — Liveuamap's own
 * `localStorage['fields']`, an {id: {points, strokecolor, ...}} map — NOT
 * from `ovens.fields`, which upstream is just an array of field IDs relevant
 * to the current view (see `extension/liveuamap-bridge/reader.js`). A raw
 * `ovens.fields` is still accepted as a defensive fallback, but ONLY when it
 * is a genuine non-array object; an array (the common case) never produces
 * fields, on purpose.
 *
 * @param {{region?:string, resid?:number, href?:string,
 *   ovens?:{venues?:any[], datac?:any, datam?:any, datay?:any}|null,
 *   fieldsCache?:object|null,
 *   markers?:any[]|null}} payload
 */
export function normalizeSnapshot(payload = {}) {
  const region = String(payload.region ?? '')
    .trim()
    .toLowerCase();
  const ovens =
    payload.ovens && typeof payload.ovens === 'object' ? payload.ovens : null;

  const rawEvents =
    (Array.isArray(ovens?.venues) && ovens.venues) ||
    (Array.isArray(payload.markers) && payload.markers) ||
    [];
  const fieldsSource =
    (payload.fieldsCache &&
      typeof payload.fieldsCache === 'object' &&
      !Array.isArray(payload.fieldsCache) &&
      payload.fieldsCache) ||
    (ovens?.fields &&
      typeof ovens.fields === 'object' &&
      !Array.isArray(ovens.fields) &&
      ovens.fields) ||
    null;
  const rawFields = fieldsSource ? Object.values(fieldsSource) : [];

  const events = rawEvents.map(normalizeEvent).filter(Boolean);
  const fields = rawFields.map(normalizeField).filter(Boolean);

  return {
    region,
    resid: num(payload.resid),
    url:
      text(payload.href) ??
      (region ? `https://${region}.liveuamap.com/` : null),
    asOf: ovens
      ? [ovens.datac, ovens.datam, ovens.datay].filter(Boolean).join(' ') ||
        null
      : null,
    fetchedAt: new Date().toISOString(),
    events,
    fields,
  };
}
