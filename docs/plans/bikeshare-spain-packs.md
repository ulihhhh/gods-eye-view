# Plan — Bicis compartidas en España: packs 1 y 2 (PRs a upstream)

Estado: **planificado, sin empezar**. Escrito el 2026-10-16. Todos los feeds se han
probado en vivo ese día (rutas v2, nº de estaciones, licencia y frescura < 1 min).

## Cómo retomar

- **Condición para empezar: cumplida.** El PR de Bicing + AMBici
  (bilawalsidhu/gods-eye-view#1176) se fusionó en upstream el 2026-10-16. Añadió
  `gbfs.nextbike.net` a la lista de hosts permitidos, que el pack 2 necesita, y fijó el
  patrón que copian los dos packs.
- **Orden:** pack 1 primero y pack 2 después, cada uno en su rama y su PR, ambos desde
  `upstream/main` ya con #1176 dentro:
  - `feat/bikeshare-spain-cities` (pack 1)
  - `feat/bikeshare-spain-nextbike` (pack 2)
- **Antes de escribir código**, volver a probar los feeds (pueden cambiar estaciones,
  coordenadas o rutas). Basta con un `curl` al `station_information.json` de cada fila
  de las tablas, o rehacer el script de sondeo (bajar `systems.csv` de MobilityData,
  filtrar `^ES,`, leer `gbfs.json` → `station_information`/`station_status`/
  `system_information`).
- **Entorno:** tests con Node 24 de nvm (`source ~/.nvm/nvm.sh && nvm use 24`). Gates:
  `npm test`, `npm run format:check`, `npm run check:boundaries`.

## Decisiones comunes

- **Mismo patrón que #1176:** las filas van **inline en
  `src/layers/bikeshare/registry.js`**, justo después de `barcelona-ambici`, no en un
  fichero aparte. Cada pack trae su propio test (`spainCitiesSystems.test.mjs` y
  `spainNextbikeSystems.test.mjs`), calcado de `barcelonaSystems.test.mjs`: registro y
  `provider`, `hosts`, host y ruta permitidos por el proxy, y que la cámara sobre la
  estación más alejada del centro activa el sistema. El runner (`scripts/run-unit-tests.mjs`)
  descubre los tests solo.
- **Rutas GBFS v2**, como Bicing (`/customer/gbfs/v2/en/…` en PBSC,
  `/contracts/<x>/gbfs/…` en JCDecaux, `/maps/gbfs/v2/nextbike_xx/en/…` en nextbike).
  Las v2 responden en todos y el registro exige que la ruta acabe en
  `station_information(.json)` / `station_status(.json)`. PBSC sirve con y sin `.json`
  (Bicing usa `.json`, así que se usa `.json`).
- **Nombre de ciudad** con el formato de upstream: `"Madrid, Spain"`, etc.
- **`loadRadiusKm`:** `computeInRangeCities` aplica `max(CITY_RANGE_BASE_KM = 100,
loadRadiusKm)`, así que cualquier valor ≤ 100 equivale a 100. #1176 usa 40; seguir con
  40 por coherencia. Ningún sistema de estas tablas pasa de 12 km de su centro, salvo
  Lovesharing (ver pack 2).
- **No hay tope de sistemas activos a la vez**, así que no pasa nada si se solapan
  (Madrid: BiciMAD + BicinRivas + bibo; Valencia: Valenbisi + BiciMislata + TorrentBici;
  Bizkaia: Bilbao Bizi + Bizkaibizi, y Dbizi entra a ~80 km; A Coruña + Arteixo).
- **Ficheros que toca cada PR** (como #1176): `registry.js`, el test nuevo,
  `src/data/dataCredits.js` (clave `gbfs`), `DATA_SOURCES.md` (una fila por operador o
  grupo), `docs/CURRENT-STATE.md` (fila Bikeshare) y `CHANGELOG.md`.
- **Fork (`mi-main`):** no meter estos sistemas en `registrySpain.js` mientras tanto,
  porque al mergear upstream saltaría `Duplicate GBFS city id`. Llegan a `mi-main` con
  la sincronización normal. En los mensajes de commit de `mi-main` no se citan números
  de PR.

## Pack 1 — Grandes ciudades (PBSC + JCDecaux)

**Proxy:** sin cambios. `*.publicbikesystem.net` ya está permitido como comodín y
`api.cyclocity.fr` ya está permitido con el prefijo `/contracts/`.

| id                    | city                          | provider      | centro (lat, lon) | base de las URLs                                                 | est. |
| --------------------- | ----------------------------- | ------------- | ----------------- | ---------------------------------------------------------------- | ---- |
| `madrid-bicimad`      | Madrid, Spain                 | BiciMAD       | 40.4241, -3.6825  | `https://madrid.publicbikesystem.net/customer/gbfs/v2/en/`       | 678  |
| `valencia-valenbisi`  | Valencia, Spain               | Valenbisi     | 39.4706, -0.3749  | `https://api.cyclocity.fr/contracts/valence/gbfs/`               | 277  |
| `zaragoza-bizi`       | Zaragoza, Spain               | Bizi Zaragoza | 41.6481, -0.8927  | `https://zaragoza.publicbikesystem.net/customer/gbfs/v2/en/`     | 276  |
| `sevilla-sevici`      | Seville, Spain                | Sevici        | 37.3726, -5.9607  | `https://api.cyclocity.fr/contracts/seville/gbfs/`               | 244  |
| `valladolid-biki`     | Valladolid, Spain             | BIKI          | 41.6233, -4.7382  | `https://valladolid.publicbikesystem.net/customer/gbfs/v2/en/`   | 104  |
| `a-coruna-bicicoruna` | A Coruña, Spain               | BiciCoruña    | 43.3534, -8.4156  | `https://acoruna.publicbikesystem.net/customer/gbfs/v2/en/`      | 84   |
| `donostia-dbizi`      | Donostia-San Sebastián, Spain | Dbizi         | 43.3075, -1.9696  | `https://sansebastian.publicbikesystem.net/customer/gbfs/v2/en/` | 70   |
| `bilbao-bilbaobizi`   | Bilbao, Spain                 | Bilbao Bizi   | 43.2624, -2.9367  | `https://bilbao.publicbikesystem.net/customer/gbfs/v2/en/`       | 67   |
| `rivas-bicinrivas`    | Rivas-Vaciamadrid, Spain      | BicinRivas    | 40.3535, -3.5319  | `https://rivas.publicbikesystem.net/customer/gbfs/v2/en/`        | 42   |

El centro es el del rectángulo que envuelve las estaciones válidas. El de Valenbisi
deja Mislata y Torrent dentro de los 100 km.

**Estaciones más alejadas** (para el test de rango, del 2026-10-16):

- BiciMAD: `627 - Alcalde Andrés Madrid Dávila, 92` (40.398303, -3.548534) y
  `672 - Estación de tren de El Barrial-Pozuelo` (40.464908, -3.807764)
- Valenbisi: `_CAMPAMENTO_81` (39.499875, -0.426354)
- Bizi: `231- Heroínas Sitios: Gómara` (41.627549, -0.962297) y
  `263- Avda. Real Zaragoza` (41.666994, -0.823078)
- Sevici: `_ESTADIO OLIMPICO` (37.415898, -6.005849) y `_CALLE NAVARRA` (37.424799, -5.985008)
- BIKI: `1002 Puente Duero` (41.55413, -4.79122) y `1005 Santovenia Centro Civico`
  (41.692504, -4.688387)
- BiciCoruña: `Novo Mesoiro III` (43.323367, -8.443926)
- Dbizi: `59 - BUENAVISTA` (43.321211, -1.922239)
- Bilbao Bizi: `ZORROTZAKO KIROLDEGIA` (43.2778696, -2.9735575)
- BicinRivas: `Polideportivo Parque Sureste` (40.3236695, -3.5127191)

### Problemas de datos que el pack 1 tiene que resolver

> **Actualización 2026-10-17:** upstream ya filtra las estaciones de la **capa** por
> distancia (commit 7a38727b, "drop stations outside a city's load radius", del PR de
> Bogotá y Santiago). La ingestión (`src/layers/bikeshare/ingestion.js`) pasa ahora por
> `stationsWithinCity(city, …)` con el `loadRadiusKm` de cada sistema: es la opción (a) de abajo, y también quita las
> estaciones en (0,0) de la capa. Queda por mirar al empezar:
>
> - `src/tools/queries/mobility.js` (voz y MCP) sigue usando `parseStationInformation`
>   sin ese filtro, aunque recorta por el área de la consulta (`areaContains`), así que
>   (0,0) no sale; `_LAB MADRID` solo saldría si una consulta sobre Madrid alcanzara a
>   Sevici.
> - Si aun así conviene descartar (0,0) en el parser, como arreglo genérico aparte.
> - Que el `loadRadiusKm` de cada fila nueva alcance sus estaciones más lejanas (el
>   test de Barcelona de #1176 ya lo comprueba para sus dos sistemas; copiarlo).

1. **Estaciones en (0,0).** `parseStationInformation` (`src/sources/gbfsStations.js`)
   solo descarta coordenadas no finitas, así que `lat: 0, lon: 0` pasa y se pinta en el
   golfo de Guinea. Lo usan la capa y `src/tools/queries/mobility.js` (consultas de voz
   y MCP), así que las estaciones fantasma también saldrían en las respuestas. Casos
   vistos:
   - BiciCoruña: `Playa de Oza` (24), `Campus Elviña 2` (37), `Campus Zapateira` (38)
   - Sevici: `_TALLER SEVILLA` (el taller)

   **Arreglo:** descartar `lat === 0 && lon === 0` en el parser y añadir un caso a su
   test. Es un bug genérico, así que se explica aparte en el PR.

2. **Sevici `_LAB MADRID`** (station_id 298, 40.448779 / -3.584983, capacity 2,
   address "Aprox."): estación de laboratorio de JCDecaux en Madrid. Solo se pinta
   cuando Sevici está activo (cámara a ≤ 100 km de Sevilla), pero aparecería sobre
   Madrid al alejar la cámara y en las consultas. Opciones:
   - (a) **Recomendada:** en `loadCityStationInfo` (`src/layers/bikeshare/ingestion.js`)
     descartar estaciones a más de `max(CITY_RANGE_BASE_KM, loadRadiusKm)` del centro
     del sistema. Es genérico, ningún sistema actual tiene estaciones tan lejos (hay que
     comprobarlo en el test con el registro entero) y también cubriría el caso (0,0).
     Pero `mobility.js` llama al parser por su cuenta, así que allí habría que aplicar
     el mismo filtro.
   - (b) Dejarlo y documentarlo en `docs/KNOWN-ISSUES.md`.
   - Decidirlo al empezar, después de ver cómo `mobility.js` elige los sistemas.

### Licencias y atribución (pack 1)

- **Valenbisi, Sevici (JCDecaux):** `license_url` =
  [Licence Ouverte / Etalab](https://developer.jcdecaux.com/files/Open-Licence-fr.pdf),
  atribución obligatoria. Ampliar la fila de JCDecaux Cyclocity en `DATA_SOURCES.md`
  (hoy solo menciona Lillestrøm).
- **PBSC (BiciMAD, Bizi, BIKI, BiciCoruña, Dbizi, Bilbao Bizi, BicinRivas):** los feeds
  no declaran licencia (`system_information` sin `license_url`). Se trata igual que
  Bicing, Toronto y Bike Itaú: "no licence is published, attribution to the operator".
  Lo encontrado sobre cada uno:
  - **BiciMAD:** el catálogo oficial del Ayuntamiento publica este mismo feed
    (`https://datos.madrid.es/egob/catalogo/900021-0-bicimad-GBFS.json`, que apunta a
    `madrid.publicbikesystem.net/customer/gbfs/v2/en/…`). La ficha en datos.gob.es
    (`l01280796-bicimad-gbfs-general-bikeshare-feed-specification`) deja la licencia en
    blanco y remite a los
    [términos de EMT MobilityLabs](https://mobilitylabs.emtmadrid.es/sip/terms-of-use):
    leerlos antes del PR. Atribución: "BiciMAD, EMT Madrid (Ayuntamiento de Madrid)".
  - **Bilbao Bizi:** Bilbao Open Data es CC BY 4.0 en general, pero no hay dataset de
    Bizi confirmado. Atribución: "Bilbao Bizi, Bilbao City Council".
  - **BiciCoruña:** existe el dataset `datos.coruna.gal/dataset/bicicletas-publicas-bicicoruna`,
    sin licencia visible. Comprobarla.
  - **Zaragoza, Valladolid (AUVASA), Donostia, Rivas:** no se ha encontrado licencia.
    Atribución al operador o ayuntamiento.
- Créditos propuestos (clave `gbfs`): "BiciMAD, EMT Madrid; Bizi Zaragoza; BIKI,
  AUVASA (Valladolid); BiciCoruña; Dbizi (Donostia); Bilbao Bizi; BicinRivas", más una
  clave o texto para JCDecaux España ("Valenbisi, Sevici: JCDecaux, Licence Ouverte").

## Pack 2 — nextbike (CC0)

**Proxy:** sin cambios una vez mergeado #1176 (`gbfs.nextbike.net` como host exacto,
con test). Todos los sistemas declaran `license_id: CC0-1.0` en `system_information`.
Base de las URLs: `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_<xx>/en/`.

| id                     | city                              | provider      | xx   | centro (lat, lon) | est. | más alejada (test)                                               |
| ---------------------- | --------------------------------- | ------------- | ---- | ----------------- | ---- | ---------------------------------------------------------------- |
| `bizkaia-bizkaibizi`   | Bizkaia, Spain                    | Bizkaibizi    | `bw` | 43.317, -2.9866   | 109  | `-ABANDO` 43.260921, -2.927116 · `-AZKORRI` 43.378208, -3.011364 |
| `palma-bicipalma`      | Palma, Spain                      | BiciPalma     | `ea` | 39.5911, 2.664    | 106  | `109 CAN PASTILLA 88` 39.539412, 2.713285                        |
| `las-palmas-moxsi`     | Las Palmas de Gran Canaria, Spain | moxsi         | `el` | 28.1128, -15.446  | 66   | `El Sebadal (eléc.)` 28.156534, -15.421658                       |
| `leon-nextbike`        | León, Spain                       | nextbike León | `sl` | 42.5984, -5.5762  | 51   | `JUSTINO AZCÁRATE- OLÍMPICO DE LEÓN` 42.63409, -5.60005          |
| `santander-tuebici`    | Santander, Spain                  | TUeBICI       | `ek` | 43.4607, -3.8237  | 42   | `Magdalena` 43.468583, -3.775917                                 |
| `boadilla-bibo`        | Boadilla del Monte, Spain         | bibo          | `by` | 40.4219, -3.8925  | 39   | `LOS FRESNOS` 40.4434, -3.8769                                   |
| `logrono-bicilog`      | Logroño, Spain                    | BiciLOG       | `ej` | 42.4625, -2.445   | 35   | `EL ARCO` 42.457194, -2.481917                                   |
| `mislata-bicimislata`  | Mislata, Spain                    | BiciMislata   | `ad` | 39.4678, -0.3871  | 21   | `Rectorado UPV` 39.481454, -0.346754                             |
| `torrent-torrentbici`  | Torrent, Spain                    | TorrentBici   | `en` | 39.4299, -0.4744  | 20   | `El Vedat - Av. Sant Llorenç` 39.4186, -0.489237                 |
| `arteixo-biciarteixo`  | Arteixo, Spain                    | biciArteixo   | `aa` | 43.3211, -8.498   | 15   | `MEICENDE N°229` 43.34808, -8.444225                             |
| `canarias-lovesharing` | Canary Islands, Spain             | Lovesharing   | `ls` | ver abajo         | 14   | —                                                                |

Notas:

- **Lovesharing:** son 14 estaciones en hoteles (Lopesan, Barceló, R2…) repartidas por
  Gran Canaria (sur), Fuerteventura y Lanzarote. Desde el centro del rectángulo
  (28.36, -14.63, en el mar) la más lejana está a 130 km, por encima del suelo de
  100 km. Opciones:
  - (a) **Recomendada:** dejarlo fuera del pack. Es un servicio de hotel, aporta poco
    y obliga a un caso especial.
  - (b) Ponerle `loadRadiusKm: 150`.
- **BiciMislata** incluye estaciones fuera de Mislata (`Rectorado UPV`, `313 - Alaquàs`).
  Es la red MiBisi del área de Valencia, y está bien.
- Créditos: el operador de cada sistema viene en `system_information.operator` (por
  ejemplo, BiciPalma: SMAP, Ayuntamiento de Palma; TUeBICI: UTE Bicis Santander;
  León: Leonbici nextbike y Autobuses Urbanos de León). CC0 no exige atribución, pero se
  da igual que en AMBici. Una sola fila en `DATA_SOURCES.md` del tipo
  "nextbike España (CC0)" con la lista de sistemas.

## Fuera de alcance (por ahora)

- **Pack 3** (necesita un host nuevo en el proxy): Ganxeta Reus
  (`gbfs.ganxeta.cat`, 24 estaciones, sin licencia) y MugiBIKE Vitoria
  (`gbfs.partners.fifteen.eu`, 12 estaciones, **ODbL**).
- **Descartados:**
  - bizkaibizi 4.0 (`nextbike_bk`, 1 estación) y Roquebike (`nextbike_ra`, 1 estación)
  - MálagaBici (`nextbike_xp`, 4 estaciones, fuera del catálogo de MobilityData)
  - Donkey Republic Barcelona (1.522 puntos virtuales para unas 200 bicis)
  - Getaround (coches), Bird (patinetes) y Cooltra (motos), porque la capa es de
    estaciones de bici
- **Sin feed abierto encontrado:** MUyBICI (Murcia), BiCiCas (Castellón, en
  renovación) y la bici eléctrica de Pamplona (Ride-on). Salamanca solo publica un
  listado fijo de estaciones. No se ha buscado a fondo en Gijón, Vigo, Granada ni
  Córdoba.
