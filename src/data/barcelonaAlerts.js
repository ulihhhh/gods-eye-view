/**
 * @module barcelonaAlerts
 * @description Service alerts for the Barcelona Arrivals cards (fork-local):
 * TMB's metro and bus alerts (`/v1/alerts/{metro,bus}/channels/WEB`, JSON,
 * keyed) normalised, and the alerts that concern one metro station, TMB bus
 * stop or AMB bus stop picked out of TMB's lists and AMB's GTFS-Realtime
 * Alerts (src/data/gtfsAlerts.js).
 *
 * Every alert is reduced to `{id, header: {en?, es?, ca?}, start, end, …}`:
 * plain bounded text (no links, never HTML) and its period in epoch ms.
 * Pure: no Cesium, no Node built-ins.
 */
import { alertActive, alertText } from './gtfsAlerts.js';

/** Alerts kept from one TMB list, and attached to one card. */
export const BARCELONA_ALERTS_MAX = 500;
export const BARCELONA_CARD_ALERTS_MAX = 5;
const MAX_TEXT_CHARS = 300;
const MAX_CODE_CHARS = 16;

const code = (value) => {
  const text = String(value ?? '').trim();
  return text && text.length <= MAX_CODE_CHARS ? text : null;
};
const epoch = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

function texts(source) {
  const header = {};
  for (const [language, field] of [
    ['en', 'textEn'],
    ['es', 'textEs'],
    ['ca', 'textCa'],
  ]) {
    const text = alertText(source?.[field], MAX_TEXT_CHARS);
    if (text) header[language] = text;
  }
  return header;
}

function listOf(body) {
  const data = body?.data?.alerts ?? body?.data;
  return Array.isArray(data) ? data.slice(0, BARCELONA_ALERTS_MAX) : [];
}

/**
 * TMB metro alerts: per entity a line, a station and sometimes one of its
 * entrances; the text of the first publication, its period.
 * @param {unknown} body
 * @returns {Array<{id: string, header: object, periods: object[],
 *   lines: string[], stations: string[], entrances: string[]}>}
 */
export function normalizeTmbMetroAlerts(body) {
  const alerts = [];
  for (const raw of listOf(body)) {
    const publication = Array.isArray(raw?.publications)
      ? raw.publications[0]
      : null;
    const header = texts(publication);
    if (!Object.keys(header).length) continue;
    const entities = Array.isArray(raw?.entities) ? raw.entities : [];
    alerts.push({
      id: code(raw?.id) ?? `tmb-metro-${alerts.length + 1}`,
      header,
      periods: [
        {
          start: epoch(publication?.begin_date),
          end: epoch(publication?.end_date),
        },
      ],
      lines: [
        ...new Set(entities.map((e) => code(e?.line_name)).filter(Boolean)),
      ],
      stations: [
        ...new Set(entities.map((e) => code(e?.station_code)).filter(Boolean)),
      ],
      entrances: [
        ...new Set(entities.map((e) => code(e?.entrance_code)).filter(Boolean)),
      ],
    });
  }
  return alerts;
}

/**
 * TMB bus alerts: per affected line its ways and their stops; the text and
 * the publication window of `channelInfoTO`.
 * @param {unknown} body
 * @returns {Array<{id: string, header: object, periods: object[],
 *   lines: string[], stops: string[], allStops: boolean}>}
 */
export function normalizeTmbBusAlerts(body) {
  const alerts = [];
  for (const raw of listOf(body)) {
    const info = raw?.channelInfoTO;
    if (info?.publish === false) continue;
    const header = texts(info);
    if (!Object.keys(header).length) continue;
    const lines = new Set();
    const stops = new Set();
    for (const line of Array.isArray(raw?.linesAffected)
      ? raw.linesAffected
      : []) {
      const name = code(line?.commercialLineId ?? line?.lineId);
      if (name) lines.add(name);
      for (const way of Array.isArray(line?.ways) ? line.ways : [])
        for (const stop of Array.isArray(way?.stops) ? way.stops : []) {
          const id = code(stop?.stopId);
          if (id) stops.add(id);
        }
    }
    alerts.push({
      id: code(raw?.id) ?? `tmb-bus-${alerts.length + 1}`,
      header,
      periods: [{ start: epoch(info?.begin), end: epoch(info?.end) }],
      lines: [...lines],
      stops: [...stops],
      allStops: info?.allStops === true,
    });
  }
  return alerts;
}

/** What a card carries of an alert: its text. */
function forCard(list) {
  const seen = new Set();
  const out = [];
  for (const alert of list) {
    const key = JSON.stringify(alert.header);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ header: alert.header }));
    if (out.length >= BARCELONA_CARD_ALERTS_MAX) break;
  }
  return out;
}

/**
 * The active alerts of one metro station group: those naming one of its
 * station codes, then line-wide ones (no station) on a line serving it.
 * @param {object[]} alerts normalizeTmbMetroAlerts
 * @param {{codes: Array<number|string>, lines?: Array<{name: string}>}} station
 * @param {number} now
 */
export function tmbMetroStationAlerts(alerts, station, now) {
  const codes = new Set((station?.codes || []).map(String));
  const lines = new Set((station?.lines || []).map((line) => line?.name));
  const active = (alerts || []).filter((alert) => alertActive(alert, now));
  return forCard([
    ...active.filter((alert) => alert.stations.some((s) => codes.has(s))),
    ...active.filter(
      (alert) =>
        !alert.stations.length && alert.lines.some((l) => lines.has(l)),
    ),
  ]);
}

/**
 * The active alerts of one TMB bus stop: those naming it, then line-wide
 * ones (every stop, or none named) on a line that serves it (`lines` from
 * its arrivals).
 * @param {object[]} alerts normalizeTmbBusAlerts
 * @param {string} stopCode
 * @param {string[]} lines
 * @param {number} now
 */
export function tmbBusStopAlerts(alerts, stopCode, lines, now) {
  const served = new Set(lines || []);
  const active = (alerts || []).filter((alert) => alertActive(alert, now));
  return forCard([
    ...active.filter((alert) => alert.stops.includes(String(stopCode))),
    ...active.filter(
      (alert) =>
        (alert.allStops || !alert.stops.length) &&
        alert.lines.some((l) => served.has(l)),
    ),
  ]);
}

/**
 * The active AMB alerts of one stop: those naming it, then those on a route
 * that serves it and name no stop at all.
 * @param {object[]} alerts decodeAlerts
 * @param {string} stopId
 * @param {string[]} routeIds GTFS routes serving the stop
 * @param {number} now
 */
export function ambStopAlerts(alerts, stopId, routeIds, now) {
  const served = new Set(routeIds || []);
  const active = (alerts || []).filter((alert) => alertActive(alert, now));
  return forCard([
    ...active.filter((alert) => alert.stops.includes(stopId)),
    ...active.filter(
      (alert) => !alert.stops.length && alert.routes.some((r) => served.has(r)),
    ),
  ]);
}

/**
 * What Barcelona Arrivals' ALERTS pill marks from TMB's lists: the metro
 * station groups with an alert of their own, the bus stops one names, and
 * the metro lines with a line-wide alert (no station).
 * @param {{metro?: object[]|null, bus?: object[]|null,
 *   stations: Array<{id: string, codes: Array<number|string>}>,
 *   stops: Array<{id: string}>, now: number}} options
 * @returns {{metro: string[], bus: string[], lines: string[]}}
 */
export function tmbAlertMarks({ metro, bus, stations, stops, now }) {
  const metroActive = (metro || []).filter((a) => alertActive(a, now));
  const busActive = (bus || []).filter((a) => alertActive(a, now));
  const codes = new Set(metroActive.flatMap((alert) => alert.stations));
  const named = new Set(busActive.flatMap((alert) => alert.stops));
  return {
    metro: (stations || [])
      .filter((station) =>
        (station.codes || []).some((c) => codes.has(String(c))),
      )
      .map((station) => station.id),
    bus: (stops || [])
      .filter((stop) => named.has(String(stop.id)))
      .map((stop) => stop.id),
    lines: [
      ...new Set(
        metroActive
          .filter((alert) => !alert.stations.length)
          .flatMap((alert) => alert.lines),
      ),
    ],
  };
}

/**
 * The AMB stops with an active alert naming them.
 * @param {object[]|null} alerts decodeAlerts
 * @param {Set<string>} stopIds the stops AMB serves
 * @param {number} now
 * @returns {string[]}
 */
export function ambAlertMarks(alerts, stopIds, now) {
  const marked = new Set();
  for (const alert of alerts || []) {
    if (!alertActive(alert, now)) continue;
    for (const stop of alert.stops) if (stopIds.has(stop)) marked.add(stop);
  }
  return [...marked].sort();
}
