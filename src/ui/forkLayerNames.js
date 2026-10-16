/**
 * English module names (`layer.name`) of the fork-only layers, by id. Spread
 * into LAYER_NAME_KEYS (./layerNames.js); translated in src/i18n/fork.
 * @module ui/forkLayerNames
 */
import { msg } from '../i18n/marker.js';

export const FORK_LAYER_NAME_KEYS = Object.freeze({
  'aemet-beaches': msg('AEMET Beach Forecast'),
  'aemet-environmental': msg('AEMET Environmental Networks'),
  'aemet-stations': msg('AEMET Weather Stations'),
  'aemet-uv-index': msg('AEMET UV Index'),
  'aemet-warnings': msg('AEMET Weather Warnings'),
  'aemet-weather-imagery': msg('AEMET Weather Imagery'),
  liveuamap: msg('Liveuamap (conflict)'),
  'spain-rail-network': msg('Rail network (Spain)'),
  'tmb-arrivals': msg('Barcelona Arrivals (TMB · AMB)'),
});
