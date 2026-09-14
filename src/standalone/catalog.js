import flightsLayer from '../data/flights.js';
import militaryFlightsLayer from '../data/militaryFlights.js';
import alprCamerasLayer from '../data/alprCameras.js';
import earthquakesLayer from '../data/earthquakes.js';
import satellitesLayer from '../data/satellites.js';
import rocketLaunchesLayer from '../data/rocketLaunches.js';
import trafficLayer from '../data/traffic.js';
import cctvLayer from '../data/cctv.js';
import radioLayer from '../data/radio.js';
import bikeshareLayer from '../data/bikeshare.js';
import aisLiveVesselsLayer from '../data/aisLiveVessels.js';
import militaryInstallationsLayer from '../data/militaryInstallations.js';
import militaryAwarenessLayer from '../data/militaryAwareness.js';
import liveuamapLayer from '../data/liveuamap.js';
import localAdsbLayer from '../data/localAdsb.js';
import aemetStationsLayer from '../data/aemetStations.js';
import aemetWarningsLayer from '../data/aemetWarnings.js';
import aemetWeatherImageryLayer from '../data/aemetWeatherImagery.js';
import aemetUvIndexLayer from '../data/aemetUvIndex.js';
import aemetBeachesLayer from '../data/aemetBeaches.js';
import aemetEnvironmentalLayer from '../data/aemetEnvironmental.js';
import localDataLayers from '../data/localLayers.js';
import { LAYER_STATE_REGISTRY } from '../data/layerState.js';
import { createSurfaceServices } from '../app/surfaceServices.js';
import { createApplicationRequestServices } from '../services/requests.js';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from './layerSources.js';
export { createStandaloneReferenceSources } from './layerSources.js';

/** Create fresh layer instances using the existing standalone source choices. */
export function createStandaloneCatalog({
  signal = new AbortController().signal,
  surface = createSurfaceServices({
    terrainSource: createApplicationRequestServices().terrain,
    signal,
  }),
} = {}) {
  return createApplicationCatalog({
    surface,
    sources: createStandaloneLayerSources(),
    signal,
    vesselOptions: {
      maxRows: import.meta.env?.VITE_AIS_LIVE_MAX_ROWS,
      maxLabels: import.meta.env?.VITE_AIS_LIVE_LABEL_MAX_ROWS,
    },
  });
}

/** Select the existing standalone instances and current persistence schema. */
export function createStandaloneCatalog() {
  return createLayerCatalog(
    [
      flightsLayer,
      militaryFlightsLayer,
      earthquakesLayer,
      alprCamerasLayer,
      satellitesLayer,
      rocketLaunchesLayer,
      trafficLayer,
      cctvLayer,
      radioLayer,
      bikeshareLayer,
      aisLiveVesselsLayer,
      militaryInstallationsLayer,
      militaryAwarenessLayer,
      liveuamapLayer,
      localAdsbLayer,
      aemetStationsLayer,
      aemetWarningsLayer,
      aemetWeatherImageryLayer,
      aemetUvIndexLayer,
      aemetBeachesLayer,
      aemetEnvironmentalLayer,
      ...localDataLayers,
    ],
    LAYER_STATE_REGISTRY,
  );
// Direct compatibility callers share one catalog; application startup supplies its own.
let compatibilityCatalog;
export function getStandaloneCatalog() {
  return (compatibilityCatalog ||= createStandaloneCatalog());
}
