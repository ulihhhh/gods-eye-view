# Plan — Bicis compartidas en España: packs 1 y 2 (PRs a upstream)

Estado: pack 1 en PR (bilawalsidhu/gods-eye-view#1190, aprobada, falta el merge); pack 2
con plan de implementación desde el 2026-10-17, sin empezar. Escrito el 2026-10-16. Todos
los feeds se han probado en vivo ese día (rutas v2, nº de estaciones, licencia y frescura
< 1 min). Pack 1 revisado a fondo el 2026-10-17 contra los parsers de GEV (sección
"Revisión de los feeds del pack 1").

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
- **`loadRadiusKm`:** cuenta dos veces. Para activar un sistema,
  `computeInRangeCities` usa `max(CITY_RANGE_BASE_KM = 100, loadRadiusKm)`. Pero desde
  7a38727b la ingestión **recorta las estaciones** con el `loadRadiusKm` real
  (`stationsWithinCity`, `src/layers/bikeshare/model.js`), así que el valor sí importa:
  tiene que alcanzar la estación más lejana. #1176 usa 40; seguir con 40. En el pack 1
  la más lejana está a 11,7 km (BiciMAD).
- **No hay tope de sistemas activos a la vez**, así que no pasa nada si se solapan
  (Madrid: BiciMAD + BicinRivas + bibo; Valencia: Valenbisi + BiciMislata + TorrentBici;
  Bizkaia: Bilbao Bizi + Bizkaibizi, y Dbizi entra a ~80 km; A Coruña + Arteixo).
- **Ficheros que toca cada PR** (como #1176): `registry.js`, el test nuevo,
  `src/data/dataCredits.js` (clave `gbfs`), `DATA_SOURCES.md` (una fila por operador o
  grupo), `docs/CURRENT-STATE.md` (fila Bikeshare) y un fragmento en `changelog.d/`
  (desde upstream #787 el `CHANGELOG.md` se monta con `npm run changelog`; ver
  `changelog.d/README.md`). El pack 1 toca además `src/sources/gbfsStations.js` y su test
  (nombres con `_`, ver abajo).
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

### Revisión de los feeds del pack 1 (2026-10-17, 00:54 hora de Madrid)

Feeds descargados en vivo y leídos con los parsers de GEV (`parseStationInformation` /
`parseStationStatus`, `src/sources/gbfsStations.js`). Los 9 sistemas son GBFS 2.3, las
URLs de la tabla responden 200, y cada estación tiene información y estado (ninguna
huérfana).

| Sistema     | Estac. | Bicis | Más lejana | info / status | Rarezas                                                                              |
| ----------- | ------ | ----- | ---------- | ------------- | ------------------------------------------------------------------------------------ |
| BiciMAD     | 678    | 3722  | 11,7 km    | 562 / 290 KB  | 2 `NOT_IN_SERVICE` desde hace 3–4 días                                               |
| Valenbisi   | 277    | 1896  | 5,5 km     | 44 / 75 KB    | Nombres `_GUILLEN_DE_CASTRO`; 2 sin nombre y capacidad 0; 5 sin instalar             |
| Bizi        | 276    | 1500  | 6,2 km     | 167 / 136 KB  | —                                                                                    |
| Sevici      | 245    | 2278  | 6,3 km     | 38 / 67 KB    | Nombres `_GLORIETA OLIMPICA`; 4 sin nombre; `_TALLER` en (0,0); `_LAB MADRID` 399 km |
| BIKI        | 104    | 751   | 8,9 km     | 57 / 51 KB    | —                                                                                    |
| BiciCoruña  | 84     | 491   | 4,0 km     | 44 / 41 KB    | 5 `PLANNED` (3 en (0,0)); 1 en `MAINTENANCE`                                         |
| Dbizi       | 70     | 395   | 4,1 km     | 41 / 36 KB    | 1 `NOT_IN_SERVICE`                                                                   |
| Bilbao Bizi | 67     | 1075  | 3,4 km     | 53 / 35 KB    | Las 67 con `is_renting: false` a las 00:54: probable cierre nocturno                 |
| BicinRivas  | 42     | 331   | 3,7 km     | 20 / 19 KB    | —                                                                                    |

**Resuelto sin código:**

- **Proxy:** nada que cambiar. El feed más grande (BiciMAD, 562 KB) queda muy por debajo
  de `GBFS_MAX_BODY_BYTES` (5 MB). Además, la información de estaciones se pide una
  sola vez por ciudad y el estado cada 60 s (`STATUS_POLL_MS`).
- **(0,0) y `_LAB MADRID`:** los descarta el recorte por `loadRadiusKm` de la ingestión.
  Ya no hace falta el arreglo del parser para (0,0) que se había planeado.
  - Las consultas de voz y MCP (`src/tools/queries/mobility.js`) leen sin ese recorte,
    pero filtran por el área de la consulta (`areaContains`): (0,0) no sale nunca.
  - `_LAB MADRID` solo saldría si una consulta sobre Madrid eligiera Sevici, que está a
    390 km con radio 40. No lo hace.
- **Campos que usa GEV:** id, nombre, lat/lon, capacidad y `is_installed/renting/returning`
  en información; bicis, anclajes, los tres indicadores y `last_reported` en estado.
  Vienen completos en los 9.
  - Las bicis `num_bikes_overflow` de PBSC ya van dentro de `num_bikes_available`.
  - GEV no distingue entre bici eléctrica y mecánica (`vehicle_types_available`). Igual
    que con Bicing.
- **Estaciones fuera de servicio o cerradas:** punto gris y "No alquila" en la tarjeta.
  Es correcto, así que se queda.

**Decisiones (2026-10-17, con el usuario):**

1. **Nombres de JCDecaux España.** Valenbisi y Sevici llevan `_` delante, y Valenbisi
   además `_` en lugar de espacios (`_PLAZA_MUSICO_LOPEZ_CHAVARRI`). Lillestrøm, también
   JCDecaux, no los lleva. Repaso de los 52 sistemas de upstream:
   - **ninguno** tiene `_` en los nombres;
   - las MAYÚSCULAS (Bicing 98 %, Lillestrøm 100 %) y los códigos delante (`123 - …` en
     Brasil, Bogotá, Santiago, Honolulu) se dejan tal cual;
   - GEV no tiene ninguna limpieza común de nombres, solo arreglos locales (Fintraffic
     `_`→espacio en `server/providers/cctv/normalize.js`, mayúsculas de WFIGS a título
     en `src/layers/perimeters/cards.js`).

   **Decisión:** solo quitar los `_`, en `stationName()` de `src/sources/gbfsStations.js`
   (lo usan la capa y las consultas). Se quitan los `_` del principio y del final, cada
   `_` pasa a ser espacio y se juntan los espacios dobles. No afecta a ningún sistema de
   upstream. Lleva test propio y se explica aparte en el PR. Mayúsculas y códigos
   delante se quedan como en el resto.

2. **Estaciones fantasma:** sin instalar con capacidad 0 o sin nombre. Son unas 8:
   Valenbisi 2, Sevici 4 y Coruña 2 dentro del radio. **Se dejan en gris**, como hace
   upstream con las de Bicing. La tarjeta dice "No instalada" y, sin nombre, muestra
   "Estación {id}".
3. **`last_reported` de JCDecaux:** no es la frescura del feed. La mediana es de 16–22 h
   aunque `last_updated` tiene menos de 1 min, y pasa también en Lillestrøm. GEV solo
   lo expone en las consultas de voz y MCP. Se documenta en el PR y no se toca.
4. **URLs de JCDecaux:** `https://api.cyclocity.fr/contracts/<x>/gbfs/station_*.json`,
   como Lillestrøm. El `gbfs.json` anuncia `/gbfs/v2/…`, y las dos formas devuelven lo
   mismo.

5. **Capacidad geovallada de PBSC** (encontrado al probar en la app, 2026-10-17). PBSC
   suma a `capacity` las plazas de la zona geovallada y las publica aparte en
   `geofenced_capacity`, que no es un campo GBFS. Bilbao: 839 = 39 anclajes + 800.
   También BiciMAD (671 de 678 estaciones) y Dbizi (11 de 70). Ninguno de los 52 de
   upstream lo publica por encima de 0. **Arreglo:** `dockCapacity()` en
   `gbfsStations.js` toma `capacity − geofenced_capacity`.

**Estado (2026-10-17):** implementado en la rama `feat/bikeshare-spain-cities`
(worktree `../gev-bikeshare-es`), con 4 commits sobre `upstream/main` 3e5a18f6. El
usuario lo probó en la app en las 9 ciudades. Falta abrir la PR, que necesita su visto
bueno.

**Pendiente (antes de la implementación):**

- ~~Repetir Bilbao Bizi de día~~: confirmado con la FAQ oficial (alquiler de 05:00 a
  00:00 y devolución hasta las 00:30).
- Volver a sondear justo antes de abrir el PR. El script era desechable: bajar
  `gbfs.json` → `system_information` / `station_information` / `station_status` y pasar
  la información y el estado por los parsers de GEV.

### Licencias y atribución (pack 1) — revisadas el 2026-10-17

Ninguna licencia impide reutilizar los feeds en una aplicación de código abierto: **los 9
sistemas se quedan en el pack**. Por sistema:

| Sistema                       | Licencia encontrada                                                                                                                                                                                                                                                                                                                                                   | Atribución                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| BiciMAD                       | La ficha de datos.madrid.es (`dataset/900021-0-bicimad-gbfs`, de la EMT, que apunta a este mismo feed) aplica las [condiciones de EMT](https://mobilitylabs.emtmadrid.es/sip/terms-of-use): reutilización comercial y no comercial (sección 4). Los datos estáticos son libres; la clave solo se pide para los servicios web del portal MobilityLabs, no para el GBFS | **Obligatoria:** "Powered by EMT de Madrid", a ser posible enlazando a `https://www.emtmadrid.es` (sección 5.2) |
| Valenbisi, Sevici             | `license_url` del feed: [Licence Ouverte / Etalab](https://developer.jcdecaux.com/files/Open-Licence-fr.pdf)                                                                                                                                                                                                                                                          | Obligatoria: JCDecaux, Licence Ouverte (como Lillestrøm)                                                        |
| Bilbao Bizi                   | Bilbao Open Data es CC BY 4.0 en conjunto (registro en datos.gob.es), pero no hay dataset de Bizi                                                                                                                                                                                                                                                                     | Al operador: "Bilbao Bizi, Bilbao City Council"                                                                 |
| BiciCoruña                    | El dataset municipal (`datos.coruna.gal/dataset/bicicletas-publicas-bicicoruna`, licencia `RISP_AC`, Ley 37/2007: citar la fuente, no alterar el contenido) es **otra API** (SOFIA, con clave), no el GBFS. El enlace a la licencia redirige a la portada                                                                                                             | Al operador: "BiciCoruña"                                                                                       |
| Bizi, BIKI, Dbizi, BicinRivas | No hay licencia publicada por el operador ni por el ayuntamiento                                                                                                                                                                                                                                                                                                      | Al operador o ayuntamiento                                                                                      |

**Mobility Database** (MobilityData) marca CC BY 4.0 en los 7 PBSC españoles, y también
en Bicing, sin decir de dónde sale. Valenbisi aparece con la Licence Ouverte y la ficha
de Sevici no se encontró. Upstream no lo ha usado como fuente: la fila de Bicing dice
que el feed no publica licencia. Se cita como dato secundario y nada más.

**Para los créditos y `DATA_SOURCES.md`:**

- **Clave `gbfs`** (`dataCredits.js`): añadir el enlace "Powered by EMT de Madrid" →
  `https://www.emtmadrid.es` (BiciMAD); "Bizi Zaragoza; BIKI, AUVASA (Valladolid);
  BiciCoruña; Dbizi (Donostia); Bilbao Bizi, Bilbao City Council; BicinRivas, Rivas
  City Council".
- **Clave `jcdecaux-gbfs`:** "City bikes (Lillestrøm, Valencia, Seville): Bysykkel
  Lillestrøm, Valenbisi, Sevici, JCDecaux — Licence Ouverte".
- **Fila de BiciMAD** en `DATA_SOURCES.md`, aparte, porque tiene licencia propia:
  condiciones de EMT, con atribución "Powered by EMT de Madrid" OBLIGATORIA.
- **Fila conjunta** para Bizi, BIKI, BiciCoruña, Dbizi, Bilbao Bizi y BicinRivas, como
  la de Bike Itaú: "Operator GBFS feeds. No licence is published by the operators;
  MobilityData's catalogue lists CC BY 4.0 without naming a source. Attribution is given
  to the operator."
- **Fila de JCDecaux:** ampliarla con Valencia y Sevilla.
- **Limpieza de los `_` frente a "no alterar el contenido":** las condiciones de EMT y la
  Ley 37/2007 que cita Coruña piden no alterar el contenido. La limpieza solo cambia
  nombres de JCDecaux, y la Licence Ouverte permite modificarlos, así que no choca.

## Pack 1 — Plan de implementación (2026-10-17)

Una sola PR a upstream, `feat(bikeshare): add nine Spanish city bike systems`, con
**tres commits que se leen por separado**. Es el mismo formato que #641, que añadió
Toronto y en la misma PR arregló un fallo genérico que había destapado. Rama
`feat/bikeshare-spain-cities` desde el `upstream/main` del momento, en un worktree aparte
(`../gev-bikeshare-es`) para no tocar la copia de `mi-main` ni su Vite.

### Paso 0 — Antes de escribir código

1. **Bilbao Bizi de día:** confirmar que `is_renting: false` en las 67 estaciones era el
   cierre nocturno. Si sigue así de día, investigar antes de incluirlo.
2. **Volver a sondear los 9 feeds:** número de estaciones, estaciones más lejanas y
   rarezas. Actualizar la lista de estaciones del test si han cambiado.
3. ~~Licencias que faltan por leer~~: ✅ revisadas el 2026-10-17 (sección de licencias
   del pack 1). Ninguna prohíbe reutilizar los feeds. BiciMAD exige "Powered by EMT de
   Madrid".

### Commit 1 — `fix(gbfs): read underscores in station names as spaces`

- `src/sources/gbfsStations.js`: un `tidyStationName(text)` aplicado al nombre elegido
  (después de `stationName()`, tanto para `name` como para el respaldo `short_name`):
  - quita los `_` del principio y del final;
  - cambia cada `_` interior por un espacio;
  - junta los espacios dobles y recorta.

  Lo usan la capa y `get_bike_share` (`src/tools/queries/mobility.js`), así que los dos
  quedan arreglados a la vez.

- Casos nuevos en `src/sources/gbfsStations.test.mjs`:
  - `_GUILLEN_DE_CASTRO` → `GUILLEN DE CASTRO`;
  - `_GLORIETA OLIMPICA` → `GLORIETA OLIMPICA`;
  - `_CAMPAMENTO_81` → `CAMPAMENTO 81`;
  - un nombre que solo es `_` cae al `short_name`, o a vacío si no hay;
  - un nombre localizado de v3 con `_`;
  - los nombres sin `_` no cambian.
- **Prueba en la descripción de la PR:** antes de abrirla, pasar los 52 feeds de upstream
  por el parser con y sin el cambio y comprobar que no cambia ningún nombre. El
  2026-10-17 ninguno tenía `_`.

### Commit 2 — `feat(bikeshare): add nine Spanish city bike systems`

- **`src/layers/bikeshare/registry.js`:** las 9 filas de la tabla del pack 1, justo
  después de `barcelona-ambici`, con `loadRadiusKm: 40`.
  - Las de PBSC, escritas a mano como Bicing:
    `https://<x>.publicbikesystem.net/customer/gbfs/v2/en/station_{information,status}.json`.
  - Las de JCDecaux, como Lillestrøm:
    `https://api.cyclocity.fr/contracts/<valence|seville>/gbfs/station_{information,status}.json`.
- **`src/layers/bikeshare/spainCitiesSystems.test.mjs`**, calcado de
  `barcelonaSystems.test.mjs` y `latamPbscCities.test.mjs`:
  1. Los 9 están registrados, con su `provider` y `hosts`, y el proxy acepta el host y la
     ruta de cada feed.
  2. La cámara sobre cada estación más lejana activa su sistema.
  3. El `loadRadiusKm` de cada sistema alcanza sus estaciones más lejanas.
  4. Una cámara en el centro de Madrid activa BiciMAD y BicinRivas a la vez.
  5. Por el camino real de la ingestión, como el test de depósitos de #1063: Sevici no
     carga `_LAB MADRID` (399 km) ni `_TALLER SEVILLA` (0,0), y BiciCoruña no carga sus
     estaciones en (0,0). Las estaciones válidas de esos mismos datos sí se cargan.
  6. Los nombres de Sevici y Valenbisi llegan sin `_` a la capa.

### Commit 3 — `docs: credit and document the Spanish bike systems`

- **`src/data/dataCredits.js`:**
  - clave `gbfs`: añadir "BiciMAD, EMT Madrid; Bizi Zaragoza; BIKI, AUVASA (Valladolid);
    BiciCoruña; Dbizi (Donostia); Bilbao Bizi; BicinRivas", con el texto definitivo
    según las licencias del paso 0;
  - clave `jcdecaux-gbfs`: pasa a "City bikes (Lillestrøm, Valencia, Seville):
    Bysykkel Lillestrøm, Valenbisi, Sevici, JCDecaux — Licence Ouverte".
- **`DATA_SOURCES.md`:**
  - una fila nueva para los PBSC españoles, como la de Bike Itaú: "no licence is
    published, attribution to the operator", con la nota de BiciMAD si los términos de
    EMT lo piden;
  - ampliar la fila de JCDecaux Cyclocity con Valencia y Sevilla.
- **`docs/CURRENT-STATE.md`:**
  - la fila Bikeshare de la tabla de capas: "Bicing (Barcelona)" pasa a "Bicing and
    seven other Spanish cities", y "JCDecaux NO" a "JCDecaux NO/ES";
  - la sección "GBFS upstream bounds": una línea sobre los `_` de los nombres.

### Después de abrir la PR

- Con el número de la PR, un commit con el fragmento
  `changelog.d/<n>-bikeshare-spain-cities.md`, que acredite a ulihhhh y a la PR (formato
  en `changelog.d/README.md`).
- **Validación**, la misma lista que #1176:
  - `npm run format:check`, `npm run check:boundaries`, `npm run build`, `npm test`
    (Node 24) y `npm run test:track`;
  - comprobación en vivo a través del manejador `/api/gbfs`: 18 feeds con 200,
    `station_information` con `max-age=300`, `station_status` con `no-store`, y cada
    estación con su estado.
- **Descripción de la PR**, con la estructura de #1176:
  - Summary con una tabla de los 9 sistemas: área, plataforma y estaciones (1.843 en
    total el 2026-10-17);
  - Changes, con un apartado por commit;
  - Notes:
    - el `last_reported` de JCDecaux no indica frescura;
    - las estaciones fantasma se dejan en gris como en Bicing;
    - las bicis overflow de PBSC;
    - el cierre nocturno de Bilbao, si se confirma;
  - Testing.

  Sin detalles del fork (Andorra, `mi-main`).

- **Cuando se fusione:** sincronizar `mi-main` con el proceso normal. No llevar estas
  filas al fork antes, porque al fusionar daría `Duplicate GBFS city id`.

## Pack 2 — nextbike (CC0)

**Proxy:** sin cambios. `gbfs.nextbike.net` es host exacto desde #1176, sin prefijo de
ruta, y vale cualquier `/maps/gbfs/v2/nextbike_<xx>/en/station_{information,status}.json`.
Todos los sistemas declaran `license_id: CC0-1.0` en `system_information`. El
`gbfs.json` está un nivel más arriba (`/nextbike_<xx>/gbfs.json`) y anuncia sus idiomas
(`eu/es/en` en Bizkaia, `es/ca/en` en Palma…). `en` responde en los 10.

**Lovesharing se queda fuera** (decidido el 2026-10-17): son 14 estaciones de hotel en
tres islas, y la más lejana está a 130 km del centro.

| id                    | city                              | provider      | xx   | centro (lat, lon) | est. | más alejada (test)                                                |
| --------------------- | --------------------------------- | ------------- | ---- | ----------------- | ---- | ----------------------------------------------------------------- |
| `bizkaia-bizkaibizi`  | Bizkaia, Spain                    | Bizkaibizi    | `bw` | 43.317, -2.9866   | 109  | `-ABANDO` 43.260921, -2.927116 · `-AZKORRI` 43.378208, -3.011364  |
| `palma-bicipalma`     | Palma, Spain                      | BiciPalma     | `ea` | 39.5911, 2.664    | 106  | `109 CAN PASTILLA 88` 39.539412, 2.713285                         |
| `las-palmas-moxsi`    | Las Palmas de Gran Canaria, Spain | moxsi         | `el` | 28.1128, -15.446  | 66   | `El Sebadal (eléc.)` 28.156534, -15.421658                        |
| `leon-nextbike`       | León, Spain                       | nextbike León | `sl` | 42.5984, -5.5762  | 51   | `JUSTINO AZCÁRATE- OLÍMPICO DE LEÓN` 42.63409, -5.60005           |
| `santander-tuebici`   | Santander, Spain                  | TUeBICI       | `ek` | 43.4607, -3.8237  | 42   | `PTCAN 1` 43.452868, -3.871395 · `Magdalena` 43.468583, -3.775917 |
| `boadilla-bibo`       | Boadilla del Monte, Spain         | bibo          | `by` | 40.4219, -3.8925  | 39   | `LOS FRESNOS` 40.4434, -3.8769                                    |
| `logrono-bicilog`     | Logroño, Spain                    | BiciLOG       | `ej` | 42.4625, -2.445   | 35   | `EL ARCO` 42.457194, -2.481917                                    |
| `mislata-bicimislata` | Mislata, Spain                    | BiciMislata   | `ad` | 39.4678, -0.3871  | 21   | `Rectorado UPV` 39.481454, -0.346754                              |
| `torrent-torrentbici` | Torrent, Spain                    | TorrentBici   | `en` | 39.4299, -0.4744  | 20   | `El Vedat - Av. Sant Llorenç` 39.4186, -0.489237                  |
| `arteixo-biciarteixo` | Arteixo, Spain                    | biciArteixo   | `aa` | 43.3211, -8.498   | 15   | `MEICENDE N°229` 43.34808, -8.444225                              |

El centro es el del rectángulo que envuelve las estaciones (sin cambios desde el
2026-10-16). En Santander, `PTCAN 1` (4,0 km) es ahora la más lejana, junto a `Magdalena`.

### Revisión de los feeds del pack 2 (2026-10-17)

Los 10 feeds descargados en vivo y pasados por `parseStationInformation` /
`parseStationStatus`. Todos son GBFS 2.3, todas las URLs responden 200, cada estación
tiene información y estado, y el estado tiene menos de 1 min (`last_reported` también:
mediana 0 h, a diferencia de JCDecaux). Los ficheros son pequeños (el mayor, 36 KB).

| Sistema     | Estac. | Bicis | Más lejana | Virtuales (cap. 0) | Bicis > capacidad | Rarezas                                          |
| ----------- | ------ | ----- | ---------- | ------------------ | ----------------- | ------------------------------------------------ |
| Bizkaibizi  | 109    | 604   | 7,9 km     | 0                  | 11                | **Los 109 nombres empiezan por `-`** (`-ABANDO`) |
| BiciPalma   | 106    | 580   | 7,1 km     | 1                  | 2                 | 1 que no alquila                                 |
| moxsi       | 66     | 277   | 5,4 km     | 42                 | 3                 | —                                                |
| León        | 51     | 377   | 4,4 km     | 0                  | 22                | —                                                |
| TUeBICI     | 42     | 154   | 4,0 km     | 0                  | 1                 | Un nombre con doble espacio                      |
| bibo        | 39     | 97    | 2,7 km     | 27                 | 0                 | Un nombre con doble espacio                      |
| BiciLOG     | 35     | 262   | 3,1 km     | 9                  | 1                 | —                                                |
| BiciMislata | 21     | 32    | 3,8 km     | 3                  | 0                 | Estaciones en Alaquàs y en la UPV (red MiBisi)   |
| TorrentBici | 20     | 67    | 1,8 km     | 8                  | 0                 | —                                                |
| biciArteixo | 15     | 113   | 5,3 km     | 0                  | 0                 | —                                                |

**Resuelto sin código:**

- **Estaciones virtuales** (`is_virtual_station`, sin `capacity`): upstream ya las tiene
  (Skien, 54 de 54) y muchos BCycle/Lyft publican capacidad 0. Se muestran igual.
- **Bicis por encima de la capacidad** (León 22): es la nota P3 de #1190 en
  `dockCapacity`. No se toca.
- **Bicis sueltas** (`free_bike_status` sin `station_id`, como mucho 5 en TorrentBici): la
  capa es de estaciones y no las lee. Igual que AMBici.
- **Dobles espacios** en dos nombres: se dejan, como decidió el pack 1 ("otra separación
  es la del operador").
- **Solapes:** Bizkaibizi y Bilbao Bizi (pack 1); BiciMislata, TorrentBici y Valenbisi;
  bibo, BiciMAD y BicinRivas; biciArteixo y BiciCoruña. No hay tope de sistemas activos.

**Por decidir (propuesta en el plan de implementación):** el `-` delante de los nombres de
Bizkaibizi. En los 52 sistemas de upstream solo hay un nombre así: `- Verkstedet`
(Stavanger, el taller).

### Licencias y atribución (pack 2)

CC0 en los 10 (`system_information.license_id`), así que no hace falta revisar más. CC0 no
exige atribución, pero se da, como en AMBici. Operadores según `system_information.operator`:

| Sistema     | Operador                                                   |
| ----------- | ---------------------------------------------------------- |
| Bizkaibizi  | UTE Bizkaiabizi (Leioa)                                    |
| BiciPalma   | SMAP, Societat Municipal d'Aparcaments i Projectes (Palma) |
| moxsi       | solo dirección (Las Palmas de Gran Canaria)                |
| León        | Leonbici nextbike y Autobuses Urbanos de León, UTE         |
| TUeBICI     | UTE Bicis Santander                                        |
| bibo        | MOVUS, Movilidad Urbana Sostenible                         |
| BiciLOG     | Exterior Plus (Logroño)                                    |
| BiciMislata | MOVUS, Movilidad Urbana Sostenible                         |
| TorrentBici | solo dirección (la de MOVUS en Paterna)                    |
| biciArteixo | SUMARTE (Arteixo)                                          |

## Pack 2 — Plan de implementación (2026-10-17)

Una sola PR a upstream, `feat(bikeshare): add ten Spanish nextbike systems`, con el
mismo formato que #1190. Rama `feat/bikeshare-spain-nextbike` en un worktree aparte
(`../gev-bikeshare-nextbike`, con `node_modules` y `.env` enlazados al repo principal,
como en el pack 1).

### Paso 0 — Antes de escribir código

1. **Esperar a que se fusione #1190** y sacar la rama del `upstream/main` que lo
   contenga. Dos motivos:
   - las filas de los dos packs van al mismo sitio (al final de
     `RAW_GBFS_CITY_REGISTRY`, después de AMBici), así que dos PRs abiertas a la vez
     chocan;
   - el commit 1 amplía `tidyStationName()`, que llega con #1190.

   Si #1190 tarda, la alternativa es apilar la rama sobre `feat/bikeshare-spain-cities`
   y abrir la PR cuando se fusione, rebasando antes.

2. **Volver a sondear los 10 feeds** con un script desechable: `gbfs.json` en
   `/nextbike_<xx>/`, el resto en `/en/`, pasados por los parsers de GEV. Actualizar las estaciones del test si han cambiado.

### Commit 1 — `fix(gbfs): drop leading hyphens from station names`

**Propuesta (a confirmar):** ampliar `tidyStationName()` de `src/sources/gbfsStations.js`
para quitar los guiones del principio (`^\s*-+\s*`), además de los `_`.

- Bizkaibizi pone `-` delante de los 109 nombres (`-ABANDO`, `-METRO LUTXANA-ERANDIO`).
  Sin el arreglo, la tarjeta y `get_bike_share` dicen "-ABANDO".
- Solo se toca el principio del nombre: los guiones interiores (`JUSTINO AZCÁRATE-
OLÍMPICO`, `El Vedat - Av. Sant Llorenç`, `313 - Alaquàs`) se quedan.
- Efecto en upstream: un solo nombre, `- Verkstedet` → `Verkstedet` (Stavanger). Se dice
  en la PR.
- Casos nuevos en `src/sources/gbfsStations.test.mjs`: `-ABANDO` → `ABANDO`,
  `- Verkstedet` → `Verkstedet`, un nombre que es solo `-` cae al `short_name`, y los
  guiones interiores no cambian.
- **Alternativa:** dejar los nombres como vienen. Más simple, pero se lee peor.
- **Prueba en la descripción de la PR:** pasar los feeds del registro por el parser con y
  sin el cambio. El 2026-10-17 solo cambiaba `- Verkstedet`.

### Commit 2 — `feat(bikeshare): add ten Spanish nextbike systems`

- **`src/layers/bikeshare/registry.js`:** las 10 filas de la tabla, después de las del
  pack 1, con `loadRadiusKm: 40` (la más lejana está a 7,9 km).
  - **Propuesta:** un ayudante `nextbikeEntry({ id, city, centerLat, centerLon, domain,
provider, loadRadiusKm = 40 })` que monta
    `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_${domain}/en/station_{information,status}.json`,
    como ya hacen `bcycleEntry`, `urbanSharingEntry` y `enturEntry`. La fila de AMBici
    se queda escrita a mano para no tocar código ajeno.
  - Un comentario corto encima, como el de AMBici: BiciMislata cubre la red MiBisi
    (Alaquàs, la UPV) y Bizkaibizi varios municipios de la margen derecha e izquierda.
- **`src/layers/bikeshare/spainNextbikeSystems.test.mjs`**, calcado de
  `spainCitiesSystems.test.mjs`:
  1. Los 10 están registrados, con su `provider` y `hosts: ['gbfs.nextbike.net']`, y el
     proxy acepta el host y la ruta de cada feed.
  2. La cámara sobre cada estación más lejana activa su sistema.
  3. El `loadRadiusKm` de cada sistema alcanza sus estaciones más lejanas.
  4. Solapes: una cámara en el centro de Valencia activa Valenbisi, BiciMislata y
     TorrentBici; una en Bilbao, Bilbao Bizi y Bizkaibizi.
  5. Los nombres de Bizkaibizi llegan sin `-` a la capa (si se acepta el commit 1).

### Commit 3 — `docs: credit and document the Spanish nextbike systems`

- **`src/data/dataCredits.js`**, clave `gbfs`: después de AMBici, algo como "nextbike
  systems in Spain (Bizkaibizi; BiciPalma, SMAP; moxsi, Las Palmas de Gran Canaria; León;
  TUeBICI, Santander; bibo, Boadilla; BiciLOG, Logroño; BiciMislata; TorrentBici;
  biciArteixo)". Texto final al escribirlo.
- **`DATA_SOURCES.md`:** una fila "nextbike, Spain" (`gbfs.nextbike.net`) como la de
  AMBici: feeds del operador, sin clave, `license_id` CC0-1.0, atribución dada igualmente.
- **`docs/CURRENT-STATE.md`**, fila Bikeshare: "nextbike (AMBici)" pasa a "nextbike
  (AMBici and ten other Spanish systems)".

### Después de abrir la PR

- Commit con `changelog.d/<n>-bikeshare-spain-nextbike.md` (formato de
  `changelog.d/README.md`).
- **Validación**, la misma que #1190: `npm run format:check`, `npm run check:boundaries`,
  `npm run build`, `npm test` (Node 24) y `npm run test:track` (necesita servidor en
  4173), más la comprobación en vivo por `/api/gbfs`: 20 feeds con 200 y cada estación
  con su estado.
- **Prueba en la app** antes de abrir la PR, con la entrada temporal de
  `.claude/launch.json` apuntando al worktree (y revertirla después).
- **Descripción de la PR:** Summary con tabla (sistema, área, estaciones: 504 en total el
  2026-10-17), Changes por commit, Notes (Lovesharing fuera y por qué, estaciones
  virtuales, el `-` de Bizkaibizi y `- Verkstedet`) y Testing. Sin detalles del fork.
- **Cuando se fusione:** sincronizar `mi-main` con el proceso normal.

## Fuera de alcance (por ahora)

- **Pack 3** (necesita un host nuevo en el proxy): Ganxeta Reus
  (`gbfs.ganxeta.cat`, 24 estaciones, sin licencia) y MugiBIKE Vitoria
  (`gbfs.partners.fifteen.eu`, 12 estaciones, **ODbL**).
- **Descartados:**
  - Lovesharing (`nextbike_ls`, 14 estaciones de hotel en Gran Canaria, Fuerteventura y
    Lanzarote, a 130 km del centro). Decidido el 2026-10-17.
  - bizkaibizi 4.0 (`nextbike_bk`, 1 estación)
  - Roquebike (`nextbike_ra`, Roquetas de Mar): el 2026-10-17 tiene 173 bicis en un
    único punto `OUTGOING BIKES`, que parece un almacén antes de abrir. **Volver a
    mirar** más adelante.
  - MálagaBici (`nextbike_xp`, 3 estaciones, una de ellas en Leipzig: es una demo)
  - Dominios nextbike vacíos (0 estaciones, sin GBFS): Bilbaobizi (`bo`, hoy en PBSC,
    pack 1) y BBK Klimabizi (`ey`)
  - Donkey Republic Barcelona (1.522 puntos virtuales para unas 200 bicis)
  - Getaround (coches), Bird (patinetes) y Cooltra (motos), porque la capa es de
    estaciones de bici
- **Sin feed abierto encontrado:** MUyBICI (Murcia), BiCiCas (Castellón, en
  renovación) y la bici eléctrica de Pamplona (Ride-on). Salamanca solo publica un
  listado fijo de estaciones. No se ha buscado a fondo en Gijón, Vigo, Granada ni
  Córdoba.
