# Hoja de ruta — Transporte en España (Renfe, FGC, TMB) en el fork

Estado: plan de trabajo **solo para el fork** (`mi-main`), reescrito el 2026-10-12.
Todo lo técnico se ha comprobado contra los feeds en vivo (incluida una observación de
10 min) y contra el código de `upstream/main` (591f299). No quedan pendientes de
investigación.

## 0. Decisiones de partida

- **Todo se hace y se integra en `mi-main`.** No hay PRs intermedios a upstream.
- **Fases en orden**, cada una en su rama `feat/transit-es-<fase>`. Una fase se fusiona en
  `mi-main` cuando cumple su "hecho cuando", con commit y push.
- **Calidad de PR desde el primer día.** Cada fase sigue la guía de contribución de
  upstream: tests, docs y gates. Así, si en el futuro hay suficientes integraciones de
  datos de España, el PR conjunto a upstream (Fase 7) es una tarea de **montaje**, no de
  reescritura.
- **Lo que no puede ir nunca a upstream va marcado como `solo fork`.** Ejemplo: TMB, por
  su licencia ligada a la aplicación.

---

## 1. Reglas de trabajo en el fork

1. **Mínima superficie de conflicto con los syncs diarios de upstream.**
   - Las filas de España van en un módulo propio, `src/data/transitFeedsSpain.js`, que
     `transitFeeds.js` concatena con **una sola línea** (`...SPAIN_TRANSIT_FEEDS`).
   - Los adaptadores van en ficheros nuevos (`src/data/fgcGeotren.js`, …).
   - Los cambios a módulos compartidos (servicio, proxy, ficha) se limitan a enganches
     pequeños y genéricos (Fase 2).
2. **Mensajes de commit sin `#NNN`** ni menciones a cosas solo del fork (regla de
   memoria): GitHub los enlazaría en los PRs de upstream.
3. **Valores fijados en tests y docs.** Si una fase cambia recuentos fijados en tests
   (número de feeds, tamaño del esquema de voz…), se anota en la lista de "pins del fork"
   que se repasa en cada sync.
4. **PRs de upstream en vuelo.** No los esperamos, pero diseñamos compatible con ellos:
   - **#944** (Entur Vehicles): campo `format` por feed más un decodificador JSON propio.
     Nuestra Fase 2 usa **el mismo nombre de campo y la misma forma**. Si #944 se fusiona,
     en el sync nos quedamos con su implementación y adaptamos la nuestra.
   - **#634** (Ontario): modo y nombre de línea por feed. Si se fusiona, nuestro
     `deriveRoute` (Fase 1) pasa a usar su mecanismo.
   - **#733** (MBTA rutas y alertas): patrón para la Fase 5.
5. **Ninguna fase añade capa nueva** (son filas de la capa Transit existente), así que no
   hacen falta tokens de share-link. TMB (Fase 6) sí podría necesitar una capa, y usaría
   el bloque `z*` del fork.

---

## 2. Referencia: cómo funciona hoy la capa Transit

1. **Registro** — `src/data/transitFeeds.js`. Cada fila es un objeto congelado con:
   - `id`, `name`, `operator`, `region`;
   - `center` y `loadRadiusKm` (solo se consulta si la cámara cae dentro del círculo);
   - `url`, opcionalmente `headers`, y `license`, `licenseUrl`, `attribution`;
   - `defaultEnabled` y `terms: {quote, note}` (cita literal de las condiciones);
   - `defaultMode`, opcionalmente `routeMode(routeId)`, y `historyRetention`.

   Reglas de admisión: sin clave, licencia abierta con atribución y coordenadas reales.

2. **Servicio** — `src/sources/transitService.js`.
   - Admisión por feed y global, caché de 15 s **global** y una sola petición en vuelo.
   - Sirve datos viejos hasta 10 min, backoff de 5 s a 5 min.
   - ETag / Last-Modified, y redirecciones solo dentro del mismo origen https.
3. **Proxy** — `src/data/transitProxy.js` (`buildTransitSnapshot`): decodifica, rechaza
   feeds diferenciales y repara la hora con la escalera vehículo → cabecera → fetch.
4. **Decodificador** — `src/data/gtfsRealtime.js`: registro normalizado
   `{id, lat, lon, bearing, speedMps, timestamp, routeId, tripId, directionId, label, stopId, status, occupancy}`,
   deduplicado por `id`.
5. **Capa** — `src/layers/transit/`.
   - `ingestion` asigna el modo con `transitModeFor`.
   - `movement` y `rendering` reproducen con retraso e interpolan.
   - `policy.buildTransitSelectionCopy` monta la ficha.
   - El metro se dibuja a nivel de calle, con un aviso en la ficha.
6. **Créditos** — automáticos (`transitFeedCredit`), a partir de `attribution`.
7. **Rutas** — `/api/transit/feeds` y `/api/transit/vehicles/<id>`.

---

## 3. Fases

### Fase 1 — Renfe: Cercanías/Rodalies y AV/LD/MD — ✅ hecha 2026-10-12

**Objetivo.** Trenes de Renfe en vivo en toda España: Cercanías, incluido Rodalies
(89–222 trenes según la hora), y AV/LD/MD (~110).

**Cambios.**

- `src/data/transitFeedsSpain.js` con dos filas:
  - `renfe-cercanias` → `https://gtfsrt.renfe.com/vehicle_positions.pb`;
  - `renfe-ld` → `https://gtfsrt.renfe.com/vehicle_positions_LD.pb`;
  - ambas con `defaultMode: 'rail'`, centro (40.0, −3.7), r ≈ 650 km (Cercanías) y
    ≈ 750 km (LD).
- Una línea en `transitFeeds.js` para concatenarlas.
- **`deriveRoute(record)` por feed**, en el servidor (`buildTransitSnapshot`):
  - Cercanías: `C4-23631-PLATF.(8)` → `routeId: 'C4'`, `platform: '8'`; si falla, la
    línea se toma del sufijo del `tripId`;
  - LD: `routeId` vacío, y la etiqueta es el número de tren.
- La ficha pasa a mostrar "Línea C4 · andén 8". Es el primer campo genérico opcional;
  ver Fase 4.
- `terms`:
  - quote: _"Las presentes condiciones generales permiten la reutilización de los
    documentos sometidos a ellas para fines comerciales y no comerciales."_
  - attribution: `Renfe Operadora — datos abiertos (CC BY 4.0)`;
  - note: no sugerir respaldo de Renfe; y Lisboa cae dentro del círculo (aceptado, como
    Estocolmo en Entur).

**Validación.**

- Unit tests con fixtures `.pb` recortados de los dos feeds: decodificación,
  `deriveRoute`, cobertura (Madrid, Barcelona, Sevilla, Bilbao y Portbou dentro;
  Helsinki fuera) y `terms` presente.
- Gates comunes (§5), `qa:transit` con Barcelona y Madrid en `LIVE_CITIES`, y la
  observación de 10 min repetida en hora punta.

**Hecho cuando** en Barcelona se ven los Rodalies y en Madrid los Cercanías y los AVE,
con línea y andén en la ficha, todos los gates pasan, y DATA_SOURCES y CURRENT-STATE
están actualizados.

**Resultado (2026-10-12, rama `feat/transit-es-renfe`):**

- Implementado como estaba planeado:
  - `src/data/transitFeedsSpain.js` (2 filas y `renfeCercaniasRoute`);
  - una línea en `transitFeeds.js`;
  - `applyDerivedRoutes` genérico en `transitProxy.js` (campo opcional `deriveRoute`);
  - "platform N" en la ficha.
- **Ajustes que salieron al validar:**
  - **Modo resuelto.** Los dos feeds declaran `routeMode: () => 'rail'`. Con el modo
    "por defecto", la capa aplicaría el tope de velocidad de `unknown` (~200 km/h) y
    rechazaría los saltos de un AVE.
  - **Trenes en los dos feeds.** Los Regionales catalanes (R15, R16, R17…) salen en
    Cercanías y en LD con el mismo número de tren y a 0,4–5,7 km de distancia. Nuevo
    campo genérico `yieldsTo`: `renfe-ld` cede a `renfe-cercanias`, y el servicio quita
    del snapshot de LD los ids del último snapshot de Cercanías. En vivo: 3 trenes
    cedidos y 0 duplicados.
  - **Gate `qa:transit`:**
    - Barcelona y Madrid añadidas a `LIVE_CITIES`.
    - Nueva variable `QA_CITIES=barcelona,madrid`, que fuerza las ciudades a cualquier hora.
    - Nuevo campo `groundM` por ciudad. El gate colocaba la cámara a 600 m sobre el
      elipsoide, y en Madrid (~670 m) eso es bajo el suelo.
- **Validación:**
  - `format:check`, `check:boundaries`, `doctor`, `npm test` (6482 OK la primera
    pasada) y `build`: pasan.
  - `test:track`: 109/109.
  - `qa:transit` con `QA_CITIES=madrid,barcelona`: las dos ciudades pasan todos sus
    checks (8 de 8 en Madrid tras `groundM`).
    - Ficha en Atocha: "🚆 Route C2 · Last report: next stop 18000 · platform 2".
    - DETECT etiqueta "C2/RAIL", "R11/RAIL", etc.
  - Fallos que no son de esta fase:
    - presupuestos de 800/3000 vehículos (`budgets`, que ya fallan en `main` según el PR #944);
    - "matrix" de Boston (harness cerrado);
    - checks de estilo `UNEXERCISED` por haber pocos sprites aislados de noche;
    - "all required sections enabled", que falla por diseño en ejecuciones parciales.
  - Proxy en vivo: Cercanías 60–222 trenes según la hora (con línea en todos y andén en
    ~40 %), y LD ~60–110 con la hora de cabecera.
- **De paso** se arregló en `mi-main` una regresión de `check:boundaries` del sync del
  día (`layerManifest.js` sin dueño en `application-layer-construction`).
- **Pins del fork que cambian:** `transitQa.test.mjs` cuenta 8 filas de Transit en
  DATA_SOURCES (antes 7).

### Fase 2 — Enganches compartidos: `format` e intervalo mínimo por feed

**Objetivo.** Preparar el servicio para fuentes que no son GTFS-RT y para APIs con
cuota. FGC (Fase 3) lo necesita.

**Cambios.**

- **`format` por feed**, compatible con #944: `'gtfs-rt'` por defecto, o un id de
  decodificador. `buildTransitSnapshot` elige el decodificador. Cada decodificador JSON
  produce el mismo registro normalizado, con límites de tamaño, número de registros y
  cadenas, y un JSON malformado es un fallo, nunca un mapa vacío "válido".
- **`minIntervalMs` por feed**: la caché y el sondeo del navegador lo respetan, y un
  `429` es fallo con backoff. Hoy el TTL de 15 s es global.

**Validación.** Tests del selector de decodificador, del intervalo mínimo y del `429`, y
regresión de los 7 feeds de upstream sin cambios.

**Hecho cuando** un feed falso en JSON pasa de punta a punta en los tests y los feeds
existentes se comportan igual.

### Fase 3 — FGC (Geotren)

**Objetivo.** Trenes de FGC en vivo (~26–34): metro (L6, L7, L8, L12) y Rodalies/Regional
(S1–S9, R5/R6, RL…).

**Cambios.**

- Fila `fgc-geotren`:
  - URL fija `https://dadesobertes.fgc.cat/api/records/1.0/search/?dataset=posicionament-dels-trens&rows=200`;
  - `format: 'fgc-geotren'` y `minIntervalMs: 60000`.
- Decodificador `src/data/fgcGeotren.js`:
  - `id` = `ut` (la unidad física, estable entre viajes) y `tripId` = `id` de Geotren;
  - `routeId` = `lin`, y el modo con `routeMode` desde el GTFS de rutas de FGC:
    `route_type` 1 → `subway`; 2 y 7 → `rail`; líneas desconocidas (M1/M2) → `rail`;
  - `status`/`stopId`: con `estacionat_a`, `STOPPED_AT` en esa estación; si no,
    `IN_TRANSIT_TO` la primera de `properes_parades`;
  - `occupancy`: el nivel máximo por coche mapeado al enum GTFS
    (1 → MANY_SEATS, 2 → FEW_SEATS, 3 → STANDING_ROOM);
  - hora: `record_timestamp` del lote como hora de cabecera.

**Validación.** Tests con un fixture de Geotren (líneas conocidas y desconocidas,
parado/en marcha, JSON malformado), los gates comunes, y comprobar en vivo que en
10 min no se pasa de ~10 peticiones a la API de FGC.

**Hecho cuando** en Barcelona se ven a la vez Rodalies (Renfe) y FGC, los L6/L7 aparecen
como metro con el aviso de "a nivel de calle", y la ficha explica que el dato llega cada
~2 min.

### Fase 4 — Ficha enriquecida (datos que llegan y no se muestran)

**Objetivo.** Aprovechar los datos extra con **campos genéricos opcionales** del
registro normalizado, para que cualquier feed pueda rellenarlos:

| Campo genérico   | Renfe            | FGC                                        | En la ficha                            |
| ---------------- | ---------------- | ------------------------------------------ | -------------------------------------- |
| `platform`       | `label` (Fase 1) | —                                          | "andén 8"                              |
| `destination`    | —                | `desti` + `codigo-estaciones`              | "→ Terrassa Nacions Unides"            |
| `nextStops[]`    | —                | `properes_parades`                         | "próx.: Rubí, Les Planes…"             |
| `onTime`         | —                | `en_hora`                                  | "En hora / Fuera de horario"           |
| `occupancyPct[]` | —                | `ocupacio_*_percent`                       | "Ocupación: 15 % · 32 % · 28 % · 15 %" |
| `vehicleType`    | —                | `tipus_unitat`                             | "Unidad serie 112"                     |
| nombre de parada | (fase posterior) | `codigo-estaciones`, pequeño, se empaqueta | "parado en Sarrià" en vez de "stop SR" |

**Validación.** Tests de `buildTransitSelectionCopy` con y sin cada campo (los feeds de
upstream no cambian), y capturas de la ficha.

**Hecho cuando** una ficha de FGC muestra destino, próximas paradas, puntualidad y
ocupación, y una de Renfe muestra línea y andén.

### Fase 5 — Retrasos e incidencias

**Objetivo.** Mostrar si el tren va con retraso y los avisos de servicio.

- Retraso: los `trip_updates` de Renfe (Cercanías y LD) y el `trip-updates` de FGC,
  cruzados por `tripId`, dan "+3 min" en la ficha.
- Incidencias: `alerts` de Renfe y `alerts-gtfs_realtime` de FGC, siguiendo el patrón de
  #733 (`/api/transit/alerts/<feed>`, texto acotado y sin enlaces al navegador).
- Fuera de esta fase: nombres de parada y tipo de servicio (AVE/Alvia/MD) de Renfe, que
  necesitan su GTFS estático (pesado). Se dejan como posible fase posterior.

**Hecho cuando** un tren con retraso lo dice en la ficha y una incidencia activa se ve
en la capa.

### Fase 6 — TMB (metro y bus de Barcelona) — `solo fork`

**Requisito previo:** registrarte en developer.tmb.cat y dar de alta una aplicación.
La clave (`TMB_APP_ID`/`TMB_APP_KEY`) va en el servidor y se ofrece en POWER UP, como
la de AEMET.

**Por qué es solo para el fork.**

- La licencia obliga a "reutilizar los contenidos única y exclusivamente para la
  aplicación y/o servicio indicado en la solicitud".
- Solo hay predicciones de llegada: no hay coordenadas.

**Orden dentro de la fase:**

1. **Panel de próximas llegadas** al pulsar una estación de metro (iMetro) o una parada
   de bus (iBus). Bajo demanda, honesto y barato.
2. **Geometría oficial** de líneas, estaciones y accesos de metro (`/v1/transit`, GeoJSON)
   como contexto.
3. **Experimento: metro "estimado".** Se interpola cada `codi_servei` entre estaciones a
   partir de sus llegadas, sobre `linies/metro/{l}/trams`. Siempre etiquetado como
   _posición estimada a partir de predicciones_, con estilo propio, y desactivable.

**Hecho cuando** (1) y (2) funcionan con la clave del usuario y, sin clave, la capa dice
claramente que necesita una.

### Fase 7 — (Futuro) PR conjunto a upstream con las integraciones de España

Se abre solo cuando haya suficientes integraciones de datos de España terminadas en el fork.

**Candidatos:**

| Integración                                                      | ¿Apta para upstream?                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fases 1–5 (Renfe, enganches, FGC, ficha, retrasos e incidencias) | ✅ sin clave, CC BY 4.0, con coordenadas reales                                                                   |
| Capas AEMET (`docs/plans/weather-data-integrations.md`)          | ✅ probablemente: piden clave gratuita, como otras capas de upstream (TomTom, Mapillary). Revisar sus tokens `z*` |
| CCTV Bilbao y extras del pack de Cataluña                        | Revisar uno a uno (Andorra da 404)                                                                                |
| Fase 6 TMB                                                       | ❌ licencia ligada a la aplicación: se queda en el fork                                                           |

**Cómo montarlo:**

1. Rama nueva desde `upstream/main` de ese momento.
2. Traer el código de cada integración apta: cherry-pick de los commits de fase, o copia
   de ficheros si los syncs lo han mezclado demasiado. Ordenarlo en **commits revisables
   por integración**.
3. Comprobar qué ha pasado con #944, #634 y #733 y adaptarse.
4. Gates completos, y descripción con validación y hosts salientes por integración.

---

## 4. Datos técnicos verificados

### Renfe (data.renfe.com)

- **Licencia:** CC BY 4.0 en la ficha de cada dataset, más las condiciones de
  `https://data.renfe.com/legal` (Ley 37/2007):
  - citar _"Origen de los datos: Renfe Operadora"_;
  - mencionar la fecha de actualización si viene en el documento;
  - no desnaturalizar ni sugerir patrocinio;
  - uso comercial permitido; nada sobre logos ni cuotas.
- **Feeds** (sin clave, https, ETag/Last-Modified, `max-age=30`):
  - `vehicle_positions.pb` (Cercanías);
  - `vehicle_positions_LD.pb` (AV/LD/MD);
  - `trip_updates.pb` y `trip_updates_LD.pb`;
  - `alerts.pb`.

| Campo                         | Cercanías                                                                  | AV/LD/MD                  |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| lat/lon                       | ✅                                                                         | ✅                        |
| hora por vehículo             | ✅ (igual a la cabecera)                                                   | ❌, se usa la de cabecera |
| `routeId`                     | ❌: línea en `label` (formato documentado por Renfe) y sufijo del `tripId` | ❌: `label` = nº de tren  |
| andén                         | `label` → `PLATF.(8)`                                                      | ❌                        |
| `stopId` + `status`           | ✅                                                                         | ✅ (95 %)                 |
| rumbo / velocidad / ocupación | ❌                                                                         | ❌                        |

- **Observación de 10 min (21 sondeos):**
  - cabecera nueva en cada sondeo en los dos feeds, así que actualizan cada ≤ 30 s;
  - Cercanías: 12 de 55 trenes quietos, 9 parados en estación;
  - LD: 5 de 92 quietos, 4 parados;
  - no hay indicios de datos congelados.
- **LD repite el mismo tren** en varias entidades (un viaje por tramo, misma posición):
  el deduplicado por `id` lo resuelve. La fecha del `tripId` es la de servicio, no indica
  dato caducado.

### FGC (dadesobertes.fgc.cat, Opendatasoft)

- **Licencia:** CC BY 4.0 en todos los datasets.
- **Cuota:** 5.000 peticiones al día por IP (`X-RateLimit-*`), que se reinicia a
  medianoche UTC. De ahí `minIntervalMs` de 60 s, que son 1.440 al día.
- **Geotren** (`posicionament-dels-trens`): ~26–34 trenes, se regenera **cada ~2 min**,
  sin ETag. Campos:
  - `id`, `ut`, `lin`, `geo_point_2d`, `dir`, `origen`/`desti`;
  - `properes_parades` (JSON incrustado), `estacionat_a`, `en_hora`, `tipus_unitat`;
  - `ocupacio_{mi,ri,m1,m2}_{percent,tram}`.
  - En 10 min, `ut` se mantuvo estable (26 de 29 en todos los sondeos); `id` cambia en
    cada viaje.
- **GTFS-RT de posiciones de FGC: no sirve como fuente principal.** Es intermitente
  (0 bytes a mediodía, ~2,4 KB por la tarde) y, aunque son los mismos trenes que Geotren,
  **no trae `routeId`**. `trip-updates` (13 KB) y `alerts` (6 KB) sí son útiles para la
  Fase 5.
- **Modo por línea** (GTFS `gtfs_routes`): L6, L7, L8 y L12 son `route_type` 1 (metro);
  S\*, R\* y RL\* son 2; FV, MM y la cremallera de Núria son 7.

### TMB (developer.tmb.cat)

Especificaciones públicas en `/assets/api-docs/v1/<servicio>/swagger.json`.

| Servicio | Base                                       | Qué da                                                                                             |
| -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Transit  | `api.tmb.cat/v1/transit`                   | ~40 endpoints GeoJSON: líneas, recorridos, tramos, estaciones, accesos, paradas, horarios teóricos |
| iMetro   | `/v1/itransit/metro/estacions?estacions=…` | Próximos trenes por estación/vía: `codi_servei`, `temps_arribada` (epoch ms), destino. ≥ 10–15 s   |
| iBus     | `/v1/itransit/bus/parades/{parada}`        | Próximos buses con `id_bus`, precisión de minuto, incluye líneas AMB                               |
| Planner  | `/v1/planner/plan`                         | Rutas (OpenTripPlanner)                                                                            |
| Static   | `/v1/static/datasets/gtfs.zip`             | GTFS estático                                                                                      |

- Sin GTFS-RT ni posiciones de vehículos. El AMB tampoco publica GTFS-RT de buses.
- Todo pide `app_id` + `app_key`.
- Licencia gratuita, pero ligada a la aplicación declarada; obliga a citar la fuente y la
  fecha. TMB puede cambiar la API o cortar la licencia sin aviso.

---

## 5. Validación común (en cada fase)

1. Tests deterministas sin red, con fixtures recortados de los feeds reales.
2. `npm run doctor -- --json`, `format:check`, `check:boundaries`, `npm test` y `npm run build`.
3. `npm run test:track` contra un servidor de la rama, en otro puerto si está corriendo
   tu servidor del 4173.
4. `npm run qa:transit` con las ciudades de la fase. `budgets` y `matrix` ya fallan igual
   en `main`: comparar con la base.
5. Prueba en vivo vía proxy (`/api/transit/vehicles/<id>`), con recuentos y capturas.
6. Resultados anotados en el commit de cierre de la fase y en la sección de la fase de
   este documento.

## 6. Dónde documentar (en cada fase)

| Sitio                                                          | Qué                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/data/transitFeedsSpain.js`                                | filas con `license`, `licenseUrl`, `attribution` y `terms.quote/note`                                                                                           |
| `DATA_SOURCES.md`                                              | fila por operador y el párrafo "Transit (GTFS-Realtime)" (número de regiones, Geotren en JSON, cadencia de ~2 min, cuota y por qué no se usa el GTFS-RT de FGC) |
| `docs/CURRENT-STATE.md`                                        | fila Transit ("7 keyless regions") y la sección del servicio (`format`, `minIntervalMs`)                                                                        |
| `CHANGELOG.md`                                                 | entrada en `[Unreleased]`                                                                                                                                       |
| `README.md`                                                    | fila 🚌 Transit, con ciudades (España)                                                                                                                          |
| `scripts/package-boundaries.json`, `scripts/format-scope.json` | módulos nuevos y sus tests                                                                                                                                      |
| `scripts/qa-transit-controls.mjs`                              | Barcelona y Madrid en `LIVE_CITIES`                                                                                                                             |
| Este documento                                                 | estado de cada fase (✅ fecha y commit) y pins del fork que cambian                                                                                             |
