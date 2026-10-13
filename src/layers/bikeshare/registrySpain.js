/**
 * Spanish bike-share systems, kept apart from the main registry so the
 * fork's rows splice in with one line. Both are listed, keyless, in
 * MobilityData's GBFS systems catalogue (systems.csv).
 *
 * - Bicing (Barcelona, operated for B:SM by PBSC): the operator's public
 *   GBFS. The city's own open-data copy of the same feed is CC BY 4.0 but
 *   token-gated; credit "Bicing · Barcelona City Council".
 * - AMBici (Àrea Metropolitana de Barcelona e-bikes, run by nextbike):
 *   `system_information.license_id` is CC0-1.0.
 *
 * The two overlap only at the city edge; each loads by its own radius.
 */
export const SPAIN_GBFS_SYSTEMS = Object.freeze([
  {
    id: 'barcelona-bicing',
    city: 'Barcelona, ES',
    centerLat: 41.3926,
    centerLon: 2.164,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://barcelona.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    stationStatusUrl:
      'https://barcelona.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
    provider: 'Bicing',
  },
  {
    id: 'barcelona-ambici',
    city: 'Àrea Metropolitana de Barcelona, ES',
    centerLat: 41.37,
    centerLon: 2.07,
    loadRadiusKm: 100,
    stationInformationUrl:
      'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/en/station_information.json',
    stationStatusUrl:
      'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/en/station_status.json',
    provider: 'AMBici',
  },
]);
