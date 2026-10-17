/**
 * @module transitFeedsEstimated
 * @description Fork-only rows of the Transit feed registry whose vehicles
 * are ESTIMATED, not reported: the operator publishes times (predicted
 * arrivals, or a timetable and delays) and the server places each vehicle
 * between stops (estimatedPositions.js). They break two admission rules of
 * `transitFeeds.js` on purpose, so they stay in the fork:
 *
 * - the source needs the user's own key (BYOK, set from the POWER UP panel);
 * - there are no real coordinates: every record says `estimated: true`, and
 *   the layer draws and describes it as an estimate.
 *
 * A row here is never fetched: `estimate` names the server-side estimator
 * that computes its snapshot (transitService `estimators`), and `url` is the
 * source it reads, for the documentation only. Without the key the
 * estimator is not available and the row is not offered to the browser.
 *
 * Pure data, like the registry itself: no Cesium, no Node built-ins, and no
 * import from `transitFeeds.js` (which imports this file).
 */

/**
 * Barcelona's metro, from iMetro's predicted arrivals. iMetro predicts L1–L5
 * and L11; the automatic lines (L9, L10) and the Montjuïc funicular come
 * back with empty lists (measured 2026-10-17), so they are not drawn.
 */
const TMB_METRO_ESTIMATED = Object.freeze({
  id: 'tmb-metro-estimated',
  name: 'TMB Metro (estimated)',
  operator: 'Transports Metropolitans de Barcelona',
  region: 'Barcelona metro (estimated positions)',
  center: Object.freeze({ lat: 41.4, lon: 2.16 }),
  loadRadiusKm: 25,
  url: 'https://api.tmb.cat/v1/itransit/metro/estacions',
  estimate: 'tmb-metro',
  license: 'TMB developer licence',
  licenseUrl: 'https://developer.tmb.cat',
  attribution: '© TMB iMetro, positions estimated by GEV',
  defaultEnabled: true,
  terms: Object.freeze({
    note: "TMB's developer licence binds reuse to the application named at registration and asks to cite the source; the key is the user's own and never leaves the server. Positions are not TMB's: they are interpolated from iMetro's predicted arrivals, and every record and card says so.",
  }),
  defaultMode: 'subway',
  routeMode: () => 'subway',
  timeZone: 'Europe/Madrid',
  // Estimates every 15 s are full fixes: the trail and the first sighting
  // can start from where the train was.
  historyRetention: true,
  // The layer plays every feed some seconds behind real time, so it always
  // has the next fix in hand (one poll, plus up to one server cache window).
  // A report cannot be had early; an estimate can: the server places each
  // train this far AHEAD of the moment it estimates, and the layer plays
  // this feed exactly this far behind, so the train is drawn where the
  // estimate puts it now. The record keeps the time it was made.
  estimateLeadMs: 35_000,
  // Between two fixes the layer follows the metro track, not the chord.
  trackGeometry: () => tmbMetroTrackLines(),
});

/**
 * The metro track for the Transit layer to follow between two estimated
 * fixes, from the server (`/api/tmb/metro-lines`): TMB's licence binds its
 * geometry to the application, so it is not bundled. Each line names itself,
 * so an L1 train never snaps to L3 track. Browser only (the layer calls it);
 * the server puts the fixes on the same geometry (tmbMetroSegmentPaths).
 * @returns {Promise<Array<{routes: string[], paths: number[][]}>>}
 */
export async function tmbMetroTrackLines(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/tmb/metro-lines', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`TMB metro lines HTTP ${response.status}`);
  const body = await response.json();
  const lines = (Array.isArray(body?.lines) ? body.lines : []).filter(
    (line) =>
      typeof line?.name === 'string' &&
      line.name &&
      Array.isArray(line.paths) &&
      line.paths.length,
  );
  if (!lines.length) throw new Error('TMB metro lines empty');
  return lines.map((line) => ({ routes: [line.name], paths: line.paths }));
}

/** Estimated rows, in presentation order. */
export const ESTIMATED_TRANSIT_FEEDS = Object.freeze([TMB_METRO_ESTIMATED]);
