/**
 * Catmull-Rom spline densification for closed polygon rings — used to smooth
 * the CCAA border polylines (`aemetStations.js`'s `_buildBordersOnce`,
 * source geometry from `spainBoundaries.js`) when the camera is close.
 *
 * The bundled boundary data is accurate but coarse enough (a few hundred
 * vertices for a major ring spanning hundreds of km) that a single straight
 * segment between two distant real vertices reads as a sharp, "zig-zaggy"
 * corner once zoomed in close. Catmull-Rom interpolation passes exactly
 * through every original vertex — nothing invented or moved — while curving
 * smoothly between them, so the rendered line reads as a natural curve
 * instead of a chain of long straight segments. This is a standard
 * cartographic rendering technique for smoothing an already-simplified
 * boundary; it does not add real-world survey detail beyond what the
 * source data already carries.
 *
 * PURE — no Cesium/DOM dependency, node-testable.
 */

/** One point along the Catmull-Rom curve through p1→p2, using p0/p3 as tangent context. */
function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const c0 = -0.5 * t3 + t2 - 0.5 * t;
  const c1 = 1.5 * t3 - 2.5 * t2 + 1;
  const c2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
  const c3 = 0.5 * t3 - 0.5 * t2;
  return [
    c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0],
    c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1],
  ];
}

/**
 * Densify a closed ring (first point === last point, GeoJSON convention) by
 * inserting `subdivisions` Catmull-Rom-interpolated points along each edge.
 * Treats the ring as a closed loop (wraps around) so there's no seam at the
 * closing point. Rings too short to spline meaningfully (fewer than 4
 * distinct points) are returned unchanged.
 *
 * @param {Array<[number,number]>} ring
 * @param {number} [subdivisions=6] points inserted per original edge, incl. the edge's start vertex
 * @returns {Array<[number,number]>} closed, densified ring
 */
export function catmullRomSmoothRing(ring, subdivisions = 6) {
  if (!Array.isArray(ring) || subdivisions < 1) return ring;
  const closed = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  const n = pts.length;
  if (n < 4) return ring;

  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < subdivisions; s++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / subdivisions));
    }
  }
  out.push(out[0]);
  return out;
}
