import * as Cesium from 'cesium';
import { sideColorCss, statusBadge, iconCategory, relativeTime, fieldShapeKind } from './liveuamapPresentation.js';
import { iconUriForCategory } from './liveuamapIcons.js';
import { horizonOccluder } from './iconOrientation.js';
import { governorRequestRender } from '../renderGovernor.js';

/**
 * Liveuamap conflict feed — LOCAL PROTOTYPE layer.
 *
 * Data is PUSHed to `/api/liveuamap` by the unpacked bridge extension
 * (`extension/liveuamap-bridge/`) reading your own open liveuamap.com tabs.
 * Nothing here contacts liveuamap.com, and the data is not redistributable —
 * local exploration only. See DATA_SOURCES.md.
 *
 * Regions are auto-discovered: whatever tabs you have open show up. Set
 * `VITE_LIVEUAMAP_REGIONS=yemen,syria` to restrict rendering to an allowlist.
 *
 * Renders, per region:
 *   - news events -> a glyph billboard (category icon, faction-colored fill,
 *     verification-status ring) + short label, click for a detail card
 *   - territory / arrow "fields" -> polygon or polyline in Liveuamap's own
 *     colors (falling back to a faction color), with a name label
 *
 * Fine-tuning lives in the DATA LAYERS row itself (`getRowControls`): toggle
 * event labels, territory polygons, and a verified-only filter; a legend
 * shows which regions are currently live.
 */

/** Optional allowlist. Empty = render every region the extension has pushed. */
const REGION_ALLOWLIST = String(import.meta.env.VITE_LIVEUAMAP_REGIONS ?? '')
  .split(',')
  .map((r) => r.trim().toLowerCase())
  .filter((r) => /^[a-z0-9-]{1,40}$/.test(r));

const EVENT_LABEL_MAX = 48;
const MAX_EVENT_LABELS = 60;
const ICON_SIZE = 24; // matches the fleet billboard convention (flights.js: 20, tracked 24)
const HORIZON_TICK_MS = 250; // mirrors radio.js's horizon-cull cadence
const HORIZON_MOVE_EPSILON_M = 500;

/** Stable-ish hue per region — used for the legend swatch and as a color fallback. */
function regionColorCss(region) {
  let h = 0;
  for (let i = 0; i < region.length; i += 1) h = (h * 31 + region.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

function cssColor(value, fallbackCss) {
  if (typeof value === 'string' && value.trim()) {
    try {
      const c = Cesium.Color.fromCssColorString(value.trim());
      if (c) return c;
    } catch {
      /* fall through */
    }
  }
  return Cesium.Color.fromCssColorString(fallbackCss);
}

function ringToDegreesArray(ring) {
  const flat = [];
  for (const [lat, lng] of ring) {
    if (Number.isFinite(lat) && Number.isFinite(lng)) flat.push(lng, lat);
  }
  return flat.length >= 6 ? flat : null;
}

function ringCentroid(ring) {
  let sLat = 0;
  let sLng = 0;
  let n = 0;
  for (const [lat, lng] of ring) {
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      sLat += lat;
      sLng += lng;
      n += 1;
    }
  }
  return n ? [sLat / n, sLng / n] : null;
}

/** Shared label graphics for a field-name entity — kept ring/polygon-agnostic. */
function fieldLabelGraphics(text, fillColor) {
  return {
    text,
    font: 'bold 12px sans-serif',
    fillColor,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    translucencyByDistance: new Cesium.NearFarScalar(5.0e5, 1.0, 5.0e6, 0.0),
  };
}

function popupRow(label, value) {
  if (!value) return '';
  return `<div style="display:flex;gap:6px;font:9px/1.4 var(--font-mono)">
    <span style="color:var(--text-dim);min-width:54px;flex-shrink:0">${label}</span>
    <span style="color:var(--text-secondary)">${value}</span>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function createLiveuamapLayer() {
  let _dataSource = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _byRegion = {};
  let _lastRegions = [];
  let _clickHandler = null;
  let _popupEl = null;
  let _params = { showLabels: true, showFields: true, verifiedOnly: false };
  let _viewer = null;
  let _horizonTimer = null;
  let _lastHorizonCameraPos = null;

  async function fetchAllRegions() {
    const res = await fetch('/api/liveuamap');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    let regions = Array.isArray(body?.regions) ? body.regions : [];
    if (REGION_ALLOWLIST.length) {
      regions = regions.filter((r) => REGION_ALLOWLIST.includes(r.region));
    }
    return regions;
  }

  function closePopup() {
    if (_popupEl) _popupEl.remove();
    _popupEl = null;
  }

  function openPopup(ev, region) {
    closePopup();
    const badge = statusBadge(ev.status?.tag);
    const photo = ev.pictures?.[0];
    const el = document.createElement('div');
    // Reuse GEV's own glass-panel chrome (background/border/blur/shadow) —
    // same class the Global Context panel uses — instead of inventing new
    // colors, so this reads as part of the app rather than a bolted-on popup.
    el.className = 'global-context-panel-inner';
    el.style.cssText = [
      'position:fixed', 'top:60px', 'right:12px', 'width:280px', 'max-height:66vh',
      'overflow:auto', 'z-index:9999', 'gap:0',
    ].join(';');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <span class="panel-title">LIVEUAMAP &middot; ${escapeHtml(region.toUpperCase())}</span>
        <button type="button" data-luam-close aria-label="Close"
          style="background:none;border:0;color:var(--accent);cursor:pointer;font:14px/1 var(--font-mono);padding:0 2px">&#10005;</button>
      </div>
      <div style="font:600 12px/1.35 var(--font-mono);letter-spacing:.02em;color:var(--text-primary);margin-top:8px">${escapeHtml(ev.name || '(untitled)')}</div>
      ${badge ? `<div style="display:inline-block;margin-top:6px;padding:2px 7px;border-radius:3px;font:8px/1 var(--font-mono);letter-spacing:.06em;background:${badge.color};color:#0a0a0f">${badge.label}</div>` : ''}
      ${photo ? `<img src="${escapeHtml(photo)}" referrerpolicy="no-referrer" style="width:100%;border-radius:6px;margin-top:8px;display:block;border:1px solid var(--glass-border)" onerror="this.remove()">` : ''}
      <div style="margin-top:8px;display:grid;gap:4px">
        ${popupRow('CITY', escapeHtml(ev.city))}
        ${popupRow('WHEN', escapeHtml(relativeTime(ev.timestamp) || ev.timeAgo))}
        ${popupRow('DESC', escapeHtml(ev.description))}
        ${ev.video ? popupRow('VIDEO', `${escapeHtml(ev.videoKind || 'attached')} &#9654;`) : ''}
        ${(ev.otherRegions || []).length
          ? popupRow('ALSO ON', ev.otherRegions.map((r) => escapeHtml(r.name)).join(', '))
          : ''}
      </div>
      ${ev.source
        ? `<div style="margin-top:8px"><a href="${escapeHtml(ev.source)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font:10px/1 var(--font-mono);letter-spacing:.04em">SOURCE &#8599;</a></div>`
        : ''}
    `;
    el.querySelector('[data-luam-close]')?.addEventListener('click', closePopup);
    document.body.appendChild(el);
    _popupEl = el;
  }

  /** Squared-distance camera-move gate, mirrors radio.js's horizon-cull pacing. */
  function cameraMoved(prev, cur) {
    if (!prev || !cur) return true;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dz = cur.z - prev.z;
    return dx * dx + dy * dy + dz * dz > HORIZON_MOVE_EPSILON_M * HORIZON_MOVE_EPSILON_M;
  }

  /**
   * Hide event glyphs and field-name labels when the planet is between them
   * and the camera. Billboards/labels render with normal Cesium depth
   * testing (no `disableDepthTestDistance`), but nothing here writes far-side
   * depth on its own, so — same as radio.js — visibility is checked by hand
   * against a shared ellipsoidal horizon occluder. Field/territory GEOMETRY
   * (polygon/polyline) is untouched: it is correctly ground-occluded already
   * and is never toggled by this pass (see the comment in drawRegion).
   */
  function cullToHorizon({ force = false } = {}) {
    if (!_enabled || !_viewer || !_dataSource) return;
    const cameraPos = _viewer.camera?.positionWC;
    if (!force && !cameraMoved(_lastHorizonCameraPos, cameraPos)) return;
    _lastHorizonCameraPos = cameraPos ? { x: cameraPos.x, y: cameraPos.y, z: cameraPos.z } : null;
    const occluder = horizonOccluder(_viewer.camera);
    const now = Cesium.JulianDate.now();
    let changed = false;
    for (const entity of _dataSource.entities.values) {
      if (entity.polygon || entity.polyline || !entity.position) continue;
      const pos = entity.position.getValue(now);
      if (!pos) continue;
      const visible = occluder.isPointVisible(pos);
      if (entity.show !== visible) changed = true;
      entity.show = visible;
    }
    if (changed) governorRequestRender('liveuamap-horizon');
  }

  function installClickHandler(viewer) {
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      const entity = picked?.id;
      if (!entity || !_dataSource || !_dataSource.entities.contains(entity)) return;
      const props = entity.properties;
      if (!props || props.kind?.getValue() !== 'event') return;
      const ev = props.event?.getValue();
      const region = props.region?.getValue();
      if (ev) openPopup(ev, region);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function drawRegion(payload, region) {
    const entities = _dataSource.entities;
    let events = 0;
    let fields = 0;

    if (_params.showFields) {
      for (const f of payload.fields ?? []) {
        const fallback = f.sideId != null ? sideColorCss(f.sideId, region) : regionColorCss(region);
        const stroke = cssColor(f.strokeColor, fallback);
        const fill = cssColor(f.fillColor, fallback).withAlpha(
          Number.isFinite(f.fillOpacity) ? Math.min(0.5, Math.max(0.05, f.fillOpacity)) : 0.2,
        );
        const shape = fieldShapeKind(f.typeId);
        // Circles (lat/lng + radius, not a ring) and heatmaps (weighted point
        // clouds) aren't ring-shaped geometry — nothing to draw from `rings`.
        if (shape === 'circle' || shape === 'heatmap') continue;

        const lineWidth = Number.isFinite(f.strokeWidth) && f.strokeWidth > 0 ? f.strokeWidth : 3;

        // The label is its OWN entity, separate from the geometry. Geometry
        // (polygon/polyline, clampToGround) is correctly occluded by Cesium's
        // normal ground-primitive depth test on its own — horizon-culling it
        // by `.show` too would hide a large territory the moment its single
        // sample point (ring[0]/centroid) crosses the horizon, well before
        // the polygon itself actually goes out of view. Only the label needs
        // the manual horizon check (see cullToHorizon), same as event glyphs.
        f.rings.forEach((ring, i) => {
          const id = `liveuamap:${region}:field:${f.id}:${i}`;

          if (shape === 'line' || shape === 'line-dashed') {
            const positions = [];
            for (const [lat, lng] of ring) {
              if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push(lng, lat);
            }
            if (positions.length < 4) return;
            entities.add({
              id,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(positions),
                width: lineWidth,
                material: shape === 'line-dashed'
                  ? new Cesium.PolylineDashMaterialProperty({ color: stroke, dashLength: 16 })
                  : stroke,
                clampToGround: true,
              },
              properties: { source: 'liveuamap', region, kind: 'field', name: f.name ?? null },
            });
            fields += 1;
            if (f.name) {
              entities.add({
                id: `${id}:label`,
                position: Cesium.Cartesian3.fromDegrees(ring[0][1], ring[0][0]),
                label: fieldLabelGraphics(f.name, stroke),
                properties: { source: 'liveuamap', region, kind: 'field-label', name: f.name },
              });
            }
            return;
          }
          const hierarchy = ringToDegreesArray(ring);
          if (!hierarchy) return;
          entities.add({
            id,
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(hierarchy),
              material: fill,
              outline: true,
              outlineColor: stroke,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              classificationType: Cesium.ClassificationType.TERRAIN,
            },
            properties: { source: 'liveuamap', region, kind: 'field', name: f.name ?? null },
          });
          fields += 1;
          const centroid = f.name ? ringCentroid(ring) : null;
          if (centroid) {
            entities.add({
              id: `${id}:label`,
              position: Cesium.Cartesian3.fromDegrees(centroid[1], centroid[0]),
              label: fieldLabelGraphics(f.name, stroke),
              properties: { source: 'liveuamap', region, kind: 'field-label', name: f.name },
            });
          }
        });
      }
    }

    let visibleEvents = payload.events ?? [];
    if (_params.verifiedOnly) {
      visibleEvents = visibleEvents.filter((ev) => ev.status?.tag === 'verified');
    }
    const sorted = [...visibleEvents].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    sorted.forEach((ev, idx) => {
      if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lng)) return;
      const position = Cesium.Cartesian3.fromDegrees(ev.lng, ev.lat);
      const showLabel = _params.showLabels && idx < MAX_EVENT_LABELS;
      const name = String(ev.name ?? '').slice(0, EVENT_LABEL_MAX);
      const { category } = iconCategory(ev.icon);
      const badge = statusBadge(ev.status?.tag);

      // Billboard + label share ONE entity so horizon-culling (cullToHorizon)
      // toggles both together via `.show` — unlike field geometry, a glyph
      // billboard has no depth of its own to be occluded by, so it needs the
      // manual check to stop rendering through the far side of the planet.
      entities.add({
        id: `liveuamap:${region}:event:${ev.id}`,
        position,
        billboard: {
          image: iconUriForCategory(category),
          // White-fill source glyph: Cesium multiplies this tint straight
          // through, same technique as the aircraft fleet icons.
          color: Cesium.Color.fromCssColorString(sideColorCss(ev.sideId, region)),
          width: ICON_SIZE,
          height: ICON_SIZE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        },
        label: showLabel
          ? {
              text: name,
              font: '12px sans-serif',
              // Status, when known, IS the label color — verified reads green,
              // a rumor amber, fake red — instead of a separate ring/badge on
              // the glyph itself (which stays a clean, unbusy faction tint).
              fillColor: badge ? Cesium.Color.fromCssColorString(badge.color) : Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -1 * (ICON_SIZE / 2 + 6)),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              translucencyByDistance: new Cesium.NearFarScalar(3.0e5, 1.0, 3.0e6, 0.0),
            }
          : undefined,
        properties: {
          source: 'liveuamap',
          region,
          kind: 'event',
          name: ev.name ?? null,
          event: ev,
        },
      });
      events += 1;
    });

    return { events, fields };
  }

  /** Redraw from the last-fetched payloads — used after a param change, no network round-trip. */
  function redraw() {
    _dataSource.entities.removeAll();
    const byRegion = {};
    let anyData = false;
    for (const payload of _lastRegions) {
      const region = payload.region;
      const counts = drawRegion(payload, region);
      byRegion[region] = { ...counts, fetchedAt: payload.fetchedAt ?? null, asOf: payload.asOf ?? null };
      if (counts.events || counts.fields) anyData = true;
    }
    _byRegion = byRegion;
    _lastUpdate = Date.now();
    _lastError = anyData
      ? null
      : 'No data yet — open a liveuamap.com tab with the bridge extension loaded';
    console.log('[Data:Liveuamap] Updated:', JSON.stringify(byRegion));
    // Freshly added entities default to `.show = true`; settle horizon
    // visibility immediately rather than waiting for the next 250ms tick.
    _lastHorizonCameraPos = null;
    cullToHorizon({ force: true });
  }

  const layer = {
    id: 'liveuamap',
    name: 'Liveuamap (conflict)',
    icon: '🗞️',
    source: 'Liveuamap (local prototype — not redistributable)',
    updateInterval: 90000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('liveuamap');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
      _byRegion = {};
      _lastRegions = [];
      installClickHandler(viewer);
      console.log(
        `[Data:Liveuamap] Initialized (${
          REGION_ALLOWLIST.length ? `allowlist: ${REGION_ALLOWLIST.join(', ')}` : 'all pushed regions'
        })`,
      );
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      _lastHorizonCameraPos = null;
      cullToHorizon({ force: true });
      if (!_horizonTimer) {
        _horizonTimer = setInterval(() => cullToHorizon({ force: false }), HORIZON_TICK_MS);
      }
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      closePopup();
      if (_horizonTimer) {
        clearInterval(_horizonTimer);
        _horizonTimer = null;
      }
    },

    async update() {
      try {
        const regions = await fetchAllRegions();
        _lastRegions = regions;
        redraw();
        return true;
      } catch (e) {
        console.warn('[Data:Liveuamap] Update error:', e);
        _lastError = 'Liveuamap feed error';
        return false;
      }
    },

    setParams(params = {}, { origin } = {}) {
      void origin;
      let changed = false;
      for (const key of ['showLabels', 'showFields', 'verifiedOnly']) {
        if (params[key] !== undefined) {
          const next = params[key] !== false;
          if (_params[key] !== next) changed = true;
          _params[key] = next;
        }
      }
      if (changed && _dataSource) redraw();
      return true;
    },

    getRowControls() {
      const regions = Object.keys(_byRegion).sort();
      return {
        chips: [
          {
            id: 'labels',
            label: 'LABELS',
            active: _params.showLabels,
            state: _params.showLabels ? 'active' : 'idle',
            title: 'Toggle event name labels',
            params: { showLabels: !_params.showLabels },
          },
          {
            id: 'fields',
            label: 'TERRITORY',
            active: _params.showFields,
            state: _params.showFields ? 'active' : 'idle',
            title: 'Toggle territory / front-line polygons',
            params: { showFields: !_params.showFields },
          },
          {
            id: 'verified',
            label: 'VERIFIED ONLY',
            active: _params.verifiedOnly,
            state: _params.verifiedOnly ? 'active' : 'idle',
            title: 'Show only Liveuamap-verified events',
            params: { verifiedOnly: !_params.verifiedOnly },
          },
        ],
        legend: regions.map((region) => {
          const r = _byRegion[region];
          const age = r.fetchedAt ? relativeTime(new Date(r.fetchedAt).getTime() / 1000) : null;
          return {
            label: region,
            color: regionColorCss(region),
            count: (r.events || 0) + (r.fields || 0),
            blurb: [r.asOf, age ? `pushed ${age}` : null].filter(Boolean).join(' · '),
          };
        }),
      };
    },

    /** Plain-JSON event snapshot for the analyst/voice query engine. */
    getAnalystRecords(maxCount = 500) {
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 500;
      const out = [];
      for (const payload of _lastRegions) {
        for (const ev of payload.events ?? []) {
          if (out.length >= limit) return out;
          out.push({
            id: `${payload.region}:${ev.id}`,
            region: payload.region,
            name: ev.name,
            lat: ev.lat,
            lon: ev.lng,
            timestamp: ev.timestamp,
            status: ev.status?.tag ?? null,
            sideId: ev.sideId,
            categoryId: ev.categoryId,
            city: ev.city,
          });
        }
      }
      return out;
    },

    destroy(viewer) {
      _enabled = false;
      closePopup();
      if (_horizonTimer) {
        clearInterval(_horizonTimer);
        _horizonTimer = null;
      }
      if (_clickHandler) {
        _clickHandler.destroy();
        _clickHandler = null;
      }
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _byRegion = {};
      _lastRegions = [];
      _lastUpdate = null;
      _lastError = null;
      _viewer = null;
      _lastHorizonCameraPos = null;
    },

    getStats() {
      const count = Object.values(_byRegion).reduce(
        (sum, r) => sum + (r.events || 0) + (r.fields || 0),
        0,
      );
      return { count, byRegion: _byRegion, lastUpdate: _lastUpdate, error: _lastError };
    },
  };

  return layer;
}

const liveuamapLayer = createLiveuamapLayer();

export default liveuamapLayer;
