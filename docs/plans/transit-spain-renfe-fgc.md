# Plan — Transit: Renfe (Cercanías/Rodalies + AV/LD/MD) y FGC

Estado: plan cerrado, sin pendientes de investigación (2026-10-12). Destino: PR(s) a
`bilawalsidhu/gods-eye-view`. Todo se ha comprobado contra los feeds en vivo (incluida una
observación de 10 min, 21 sondeos cada 30 s) y contra el código de `upstream/main` (591f299).

---

## 1. Qué queremos implementar y cómo validarlo

### Objetivo

Que la capa **Transit** muestre en España, con posiciones GPS reales y sin clave:

| Feed | Qué es | Vehículos (12-oct, ~13:20) |
| --- | --- | --- |
| Renfe Cercanías | Todos los núcleos de Cercanías, **incluido Rodalies de Catalunya** (R1, R2N, R2S, R3, R4, R7, R8, R11, R15, R16, RL4…) | 222 (51 en el área de Barcelona) |
| Renfe AV/LD/MD | Alta Velocidad, Larga y Media Distancia, en todo el país | 121 |
| FGC (Geotren) | Barcelona‑Vallès y Llobregat‑Anoia: L6, L7, L8, L12, S1–S9, R5/R6, RL… | 34 |

### Reparto en PRs (recomendado)

- **PR A — Renfe.** Dos filas de registro GTFS‑RT más un pequeño enganche para
  deducir la línea de la etiqueta. Sin fontanería nueva: riesgo bajo y revisión rápida.
- **PR B — FGC.** Necesita un adaptador JSON para Geotren (su GTFS‑RT no trae la línea
  y a ratos llega vacío; ver §5) que sigue el patrón `format` del PR abierto #944. Además
  necesita un intervalo mínimo por feed por la cuota de la API. Va después de #944 o
  encima de él.

Separarlos evita que FGC, que depende de #944, bloquee a Renfe, que es inmediato.

### Validación (según CONTRIBUTING y MAINTAINER_WORKFLOW actuales)

1. **Unit tests deterministas y sin red**, con fixtures recortados de los feeds reales:
   - Registro: sin clave, https, licencia, `terms` con cita (lo hace cumplir `transitFeeds.test.mjs`).
   - Cobertura: Madrid, Barcelona, Sevilla, Bilbao y Portbou dentro; Helsinki fuera.
   - Modo y línea: `C4-23631-PLATF.(8)` → línea `C4`, andén `8`, modo `rail`.
     Para FGC, `L6` → `subway`, `S1` → `rail`.
   - Decodificador FGC: coordenadas, línea, parada, ocupación, `en_hora`, línea desconocida (`M1`).
     Rechaza respuestas malformadas o truncadas y aplica los límites de tamaño.
2. `npm run doctor -- --json`, `format:check`, `check:boundaries`, `npm test` y `npm run build`.
3. `npm run test:track` contra un servidor de la rama: 109/109.
4. **Gate de la funcionalidad:** `npm run qa:transit`, añadiendo Barcelona (y Madrid
   para Renfe) a `LIVE_CITIES` en `scripts/qa-transit-controls.mjs`.
   Hay que anotar que `budgets` y `matrix` ya fallan igual en `main` (lo cuenta el PR #944).
5. **Prueba en vivo vía proxy**, con recuento por feed en `/api/transit/vehicles/<id>`
   y capturas en Barcelona (Rodalies y FGC juntos) y Madrid.
6. **Observación de 10 minutos ✅ (hecha 2026-10-12; resultados en §4 y §5).** Repetirla
   en el PR con la rama corriendo, en hora punta, y adjuntar los números.

---

## 2. Cómo están hechas las regiones actuales (referencia)

Cadena completa (7 feeds hoy: MBTA, CapMetro, Metro Transit, HSL, OVapi, Entur y TransLink):

1. **Registro** — `src/data/transitFeeds.js`. Cada fila es un objeto congelado con:
   - `id`, `name`, `operator`, `region`;
   - `center` y `loadRadiusKm` (solo se consulta si la cámara cae dentro del círculo);
   - `url`, opcionalmente `headers`, y `license`, `licenseUrl`, `attribution`;
   - `defaultEnabled` y `terms: {quote, note}` (cita literal de las condiciones);
   - `defaultMode`, opcionalmente `routeMode(routeId)`, y `historyRetention` (solo MBTA).

   Reglas de admisión: sin clave, licencia abierta con atribución y coordenadas reales.
2. **Servicio** — `src/sources/transitService.js`.
   - Admisión por feed y global, caché de 15 s y una sola petición en vuelo por feed.
   - Sirve datos viejos hasta 10 min si falla el origen, y retrocede 5 s → 5 min tras fallos.
   - Peticiones condicionales (ETag / Last-Modified) y redirecciones solo dentro del mismo origen https.
3. **Proxy puro** — `src/data/transitProxy.js` (`buildTransitSnapshot`): decodifica,
   rechaza feeds diferenciales y repara la hora con la escalera vehículo → cabecera → fetch.
4. **Decodificador** — `src/data/gtfsRealtime.js` (`decodeVehiclePositions`).
   - Registro normalizado `{id, lat, lon, bearing, speedMps, timestamp, routeId, tripId, directionId, label, stopId, status, occupancy}`.
   - Deduplica por `id` y se queda con el más reciente.
5. **Capa** — `src/layers/transit/`. `ingestion` asigna el modo con `transitModeFor`;
   `movement` y `rendering` reproducen con retraso entre reportes; `selection` y
   `policy.buildTransitSelectionCopy` montan la ficha; `queries` sirve detección y analista.
6. **Créditos** — automáticos: `transitFeedCredit(feed)` en `src/data/dataCredits.js`
   usa `attribution` del registro la primera vez que se pinta un vehículo del feed.
7. **Rutas HTTP** — `/api/transit/feeds` (catálogo público, sin URL) y `/api/transit/vehicles/<id>`.

---

## 3. PRs abiertos de transit (hay que coordinarse)

| PR | Qué hace | Cómo nos afecta |
| --- | --- | --- |
| #944 Entur Vehicles API (MERGEABLE) | Añade `format` por feed, petición fija (POST), un decodificador JSON propio (`enturVehicles.js`) y `reportedMode` por vehículo que manda sobre `routeMode` | **Es exactamente el patrón que necesita FGC.** PR B se construye encima: `format: 'fgc-geotren'` |
| #634 Nueve feeds de Ontario (CONFLICTING) | Modo y nombre de línea por feed ("vocabulario", `vocabulary.test.mjs`) | Solapa con el enganche de línea de Renfe. Mirar su API antes de inventar la nuestra |
| #733 MBTA líneas y alertas (CONFLICTING) | `/api/transit/routes` y `/api/transit/alerts`, fichas de línea | Patrón para una fase 2 con alertas de Renfe/FGC y trazados |
| #635 Live Trains (Amtrak) | Capa aparte `trains/`, no Transit | Sin conflicto directo |

Puntos de conflicto seguros: `transitFeeds.js` (filas nuevas), la fila de Transit en
`docs/CURRENT-STATE.md` ("7 keyless regions"), el párrafo de DATA_SOURCES ("All seven
registered regions") y los tests que cuentan feeds.

---

## 4. Renfe: traer los datos y adaptarlos

**Fuentes.** CC BY 4.0, sin clave, https, con `ETag`/`Last-Modified` y `Cache-Control: max-age=30`.

| Dataset (data.renfe.com) | URL |
| --- | --- |
| `ubicacion-vehiculos` (Cercanías) | `https://gtfsrt.renfe.com/vehicle_positions.pb` (19 KB) |
| `posicion-vehiculos-av-ld-md` | `https://gtfsrt.renfe.com/vehicle_positions_LD.pb` |
| extras: `horarios-viaje-cercanias`, `…-alta-velocidad…`, `incidencias-avisos` | `trip_updates(.pb/_LD.pb)`, `alerts.pb` |

**Qué trae el GTFS-RT**, pasado por nuestro propio decodificador:

| Campo | Cercanías | AV/LD/MD |
| --- | --- | --- |
| lat/lon | ✅ 222/222 | ✅ 121/121 |
| hora por vehículo | ✅ (igual a la cabecera) | ❌ → se usa la de cabecera; la ficha dice "(feed time)" |
| `routeId` | ❌ | ❌ |
| línea | dentro de `label`: `C4-23631-PLATF.(8)`, y sufijo del `tripId` `…C4` | ❌ (`label` = nº de tren `02101`) |
| andén | en `label`: `PLATF.(8)` | ❌ |
| `stopId` + `status` | ✅ (INCOMING_AT/STOPPED_AT/IN_TRANSIT_TO) | ✅ 115/121 |
| rumbo / velocidad / ocupación | ❌ | ❌ |

**Ajustes:**

1. Dos filas de registro: `renfe-cercanias` y `renfe-ld`, ambas con `defaultMode: 'rail'`.
   - Cobertura: centro aprox. (40.0, −3.7) y r ≈ 650 km para Cercanías (Portbou está a unos 610 km).
   - Para LD el mismo centro con r ≈ 750 km: los trenes que van a Francia se siguen
     pintando mientras el feed esté activo.
   - **Lisboa ✅ decidido:** queda dentro de cualquier círculo que alcance Portbou y
     A Coruña desde el centro peninsular, y se acepta. Solo supone consultar un feed de
     unos 20 KB sin trenes en pantalla, y en Portugal no hay otro feed con el que solaparse.
     Hay que documentarlo en la fila del registro, como hace Entur con Estocolmo.
2. **Línea y andén.** Una función por feed (p. ej. `deriveRoute(record)`) que, en el
   servidor, rellena `routeId = 'C4'` desde la etiqueta (y si falla, desde el sufijo del
   `tripId`) y separa el andén. Encajarlo con el "vocabulario" de #634 si se fusiona antes.
3. **Observación de 10 min ✅** (21 sondeos, 30 s):
   - **Cercanías:** cabecera y ETag nuevos en **cada** sondeo, así que actualiza cada
     ≤ 30 s (la ficha dice 20 s). La flota bajó de 183 a 89 al cerrar el servicio de la
     noche. De los 55 trenes presentes los 10 min, 12 no se movieron, 9 de ellos en
     `STOPPED_AT`: trenes parados, no datos congelados.
   - **AV/LD/MD:** también cabecera nueva en cada sondeo y flota estable (104–112). Solo
     5 de 92 no se movieron, 4 en `STOPPED_AT`. No hay indicios de posiciones caducadas a
     pesar de no tener hora por vehículo; basta con la hora de cabecera (`timestampSource: 'header'`).
4. **Duplicados en LD.** Un mismo tren aparece en varias entidades (un viaje por tramo,
   misma posición), y el deduplicado por `id` existente lo resuelve. 102 de 157 viajes
   llevan fecha de ayer y también se mueven: es la fecha de servicio, no un dato caducado.
5. **Términos ✅ (resuelto 2026-10-12).**
   - Las fichas de los datasets declaran `license_id: CC-BY-4.0`.
   - La página de condiciones (`https://data.renfe.com/legal`) añade las condiciones
     generales de reutilización del sector público (Ley 37/2007). Cita para
     `terms.quote`: *"Las presentes condiciones generales permiten la reutilización de
     los documentos sometidos a ellas para fines comerciales y no comerciales."*
   - Obligaciones:
     - citar la fuente (la página sugiere *"Origen de los datos: Renfe Operadora"*);
     - mencionar la fecha de última actualización si viene en el documento: en GTFS-RT es
       el timestamp de cabecera, que la ficha ya muestra como antigüedad del reporte;
     - no desnaturalizar los datos;
     - no sugerir que Renfe "participa, patrocina o apoya" la reutilización.
   - No hay nada sobre logos ni límites de peticiones. No piden nombrar Rodalies de Catalunya.
   - Propuesta: `attribution: 'Renfe Operadora — datos abiertos (CC BY 4.0)'`, y en
     `terms.note` la regla de no sugerir respaldo (como TransLink).
   - La ficha del dataset documenta el andén en `label` (*"La información del andén
     (Platform) … se informa dentro del atributo label"*) y que *"se actualiza cada 20
     segundos"*. Así que extraer línea y andén de `label` se apoya en un formato
     documentado, no en uno deducido.

---

## 5. FGC: traer los datos y adaptarlos

**El GTFS-RT de posiciones de FGC no sirve como fuente principal ✅ (comprobado 2026-10-12).**
`vehicle-positions-gtfs_realtime` (CC BY 4.0) sirve `vehicleposition.pb` por una URL de
fichero de id estable.
- **Es intermitente:** dio 0 bytes en 7 intentos seguidos a mediodía, y por la tarde,
  durante los 10 min de observación, 2,3–2,5 KB.
- **Cuando trae datos, son los mismos trenes que Geotren:** su `vehicle.id` es la `ut`
  de Geotren y su `tripId` es el `id` de Geotren. Trae `stopId`, `status` y `occupancy`
  (enum GTFS), pero **ningún `routeId`**: no se puede saber la línea ni separar metro
  (L6/L7/L8/L12) de tren.
- La cabecera llegaba con unos 133 s de antigüedad: el mismo lote que Geotren.

Conclusión: fuente principal Geotren. El GTFS-RT queda anotado en DATA_SOURCES por si FGC
le añade el `routeId` y lo estabiliza; se podría avisar a FGC de las dos cosas.

**Fuente real: Geotren** (`posicionament-dels-trens`, CC BY 4.0, sin clave). ~34 trenes con GPS real.

- URL fija recomendada: API v1 de Opendatasoft,
  `https://dadesobertes.fgc.cat/api/records/1.0/search/?dataset=posicionament-dels-trens&rows=200`.
  Se prefiere a la v2.1 porque trae `record_timestamp` (hora de proceso del lote, unos
  30 s de retraso), que hace de hora de cabecera.
- Sin `ETag` ni `Last-Modified` (`no-cache`), así que las peticiones condicionales no sirven.
- **Cadencia ✅:** `record_timestamp` cambió 6 veces en 10 min, así que Geotren se
  regenera **cada ~2 min**. Hay que tenerlo en cuenta en la reproducción:
  - entre reportes la capa interpola, pero el tren "va por detrás" hasta unos 2 min;
  - la ficha ya dice "shown N s behind", y el PR lo tiene que explicar en DATA_SOURCES.
- **Cuota ✅ (resuelto 2026-10-12).** Las cabeceras de la API dicen
  `X-RateLimit-Limit: 5000` y `X-RateLimit-Reset: <medianoche UTC>`: **5.000 peticiones
  al día por IP**, en anónimo. Con la caché global de 15 s, un proceso consultando sin
  parar haría 5.760 al día y agotaría la cuota por la tarde. Por eso hace falta un **TTL
  por feed** (`minIntervalMs`, que el registro hoy no tiene):
  - con 60 s salen 1.440 al día, margen de sobra para varias pestañas y recargas. Más
    rápido no aporta nada, porque Geotren se regenera cada ~2 min. Medido: 77 peticiones
    gastadas en los 10 min de observación (4 por sondeo entre las dos APIs), sin tocar el límite;
  - el servicio debe tratar un `429` como fallo con backoff y servir el último snapshot
    marcado como viejo.

**Campos:**

| Campo | Significado |
| --- | --- |
| `id` | id del tren |
| `ut` | unidad (hash) |
| `lin` | línea |
| `geo_point_2d` | posición |
| `dir` | dirección (A–D) |
| `origen` / `desti` | códigos de estación |
| `properes_parades` | próximas paradas, como JSON incrustado |
| `estacionat_a` | estación donde está parado |
| `en_hora` | si va dentro del horario (booleano) |
| `tipus_unitat` | serie del tren (112, 113…) |
| `ocupacio_{mi,ri,m1,m2}_{percent,tram}` | ocupación por coche, en % y en nivel 1/2/3 |

**Adaptador** — siguiendo #944, `format: 'fgc-geotren'` y `src/data/fgcGeotren.js`:

- **Identificador ✅:** `id` de vehículo = **`ut`** (la unidad física) y `tripId` = `id` de Geotren.
  - En 10 min hubo 34 `id` distintos (22 presentes en todos los sondeos) frente a 29 `ut`
    (26 presentes en todos).
  - 4 unidades cambiaron de `id`: empezaron un viaje nuevo. Solo 1 cambió de línea.
  - Ningún duplicado dentro de un mismo lote.
  - Usar `ut` mantiene la interpolación y el rastro de cada tren al pasar de un viaje al
    siguiente. Coincide con lo que hace el propio GTFS-RT de FGC.
- `routeId = lin`, con modo desde el GTFS de rutas de FGC:
  - `route_type` 1 (L6, L7, L8, L12) → `subway`;
  - 2 (S*, R*, RL*) → `rail`;
  - 7 (FV, MM, cremallera de Núria) → `rail` (no hay modo funicular);
  - líneas desconocidas (`M1`, `M2`) → `rail` por defecto.
- `status`/`stopId`: si hay `estacionat_a`, `STOPPED_AT` en esa estación; si no,
  `IN_TRANSIT_TO` la primera de `properes_parades`.
- `occupancy`: el nivel máximo por coche mapeado al enum GTFS (1 → MANY_SEATS_AVAILABLE,
  2 → FEW_SEATS_AVAILABLE, 3 → STANDING_ROOM_ONLY).
- Límites: tamaño de la respuesta, número de registros y cadenas, como hace `enturVehicles.js`.
  Un JSON malformado es un fallo, nunca un mapa vacío "válido".

---

## 6. Funciones compartidas y forma de mostrar los datos

**Se reutiliza sin tocar:**
- admisión, caché, backoff y redirecciones;
- reproducción con retraso y suavizado (`movement`);
- marcadores por modo;
- metro dibujado a nivel de calle, con el aviso en la ficha (aplica a L6, L7, L8 y L12);
- créditos automáticos y catálogo público;
- registros para el analista.

Varios feeds a la vez en Barcelona (Rodalies, LD y FGC) ya está soportado:
`transitFeedsInRange` devuelve todos los feeds en rango.

**Hay que tocar:**
1. Enganche de línea por feed (Renfe). Opción mínima: normalizar en el servidor dentro de `buildTransitSnapshot`.
2. `format` y decodificador alternativo (FGC), reutilizando #944.
3. Opcionalmente `reportedMode` por vehículo (#944), si FGC necesita un modo distinto por tren.
   No hace falta: el modo sale de `lin`, vía `routeMode`.
4. **Intervalo mínimo por feed** (`minIntervalMs` en el registro, 60 s para FGC). Lo
   respetan la caché del servicio y el sondeo del navegador. Un `429` cuenta como fallo
   con backoff. Hoy el TTL de 15 s es global.
5. **Ficha.** Hoy muestra `stop 51003` (id crudo) y "Route C4" en vez de "Línea C4".
   - Los nombres de parada necesitan el GTFS estático: FGC tiene el dataset
     `codigo-estaciones`, pequeño y empaquetable; el de Renfe tiene miles de paradas.
   - Propuesta para v1: nombres solo para FGC; Renfe con el id, o fase 2.

---

## 7. Dónde documentar

| Sitio | Qué |
| --- | --- |
| `src/data/transitFeeds.js` | filas con `license`, `licenseUrl`, `attribution` y `terms.quote/note` |
| `DATA_SOURCES.md` | una fila por operador en la tabla, y el párrafo "Transit (GTFS-Realtime)" ("All seven registered regions" → nueve). Notas: Geotren en JSON, cadencia de ~2 min, cuota de 5.000/día con intervalo mínimo de 60 s, y por qué no se usa el GTFS-RT de FGC (intermitente y sin línea) |
| `docs/CURRENT-STATE.md` | fila Transit (≈l. 3148, "7 keyless regions") y la sección del servicio si cambia `format` |
| `CHANGELOG.md` | entrada en `[Unreleased]` |
| `README.md` | fila 🚌 Transit, lista de ciudades (+ España / Barcelona) |
| `scripts/package-boundaries.json`, `scripts/format-scope.json` | módulo nuevo (`fgcGeotren.js`) y sus tests |
| `scripts/qa-transit-controls.mjs` | Barcelona y Madrid en `LIVE_CITIES` |
| Descripción del PR | gates ejecutados, hosts salientes (`gtfsrt.renfe.com`, `dadesobertes.fgc.cat`) y limitaciones |

Los créditos dentro de la app no requieren cambios.

---

## 8. Datos que llegan y no se muestran: propuestas

**Ya decodificados pero no mostrados (todas las regiones):** `directionId`, `tripId`,
`startTime` y `licensePlate`. `stopId` se muestra crudo.

| Dato extra | Fuente | Propuesta | Fase |
| --- | --- | --- | --- |
| Línea y andén (`C4`, `PLATF.(8)`) | Renfe `label` | "Línea C4 · andén 8" en la ficha | PR A |
| Ocupación por coche en % y nivel | FGC | Nivel GTFS en el campo existente, más una línea "Ocupación: 15 % · 32 % · …" | PR B |
| Va en hora | FGC `en_hora` | "En hora / Fuera de horario" | PR B |
| Destino y próximas paradas | FGC `desti`, `properes_parades` + `codigo-estaciones` | "→ Terrassa Nacions Unides · próx.: Rubí, …" | PR B |
| Serie del tren | FGC `tipus_unitat` | "Unidad serie 112" | PR B |
| Retraso por viaje | Renfe `trip_updates(.pb/_LD.pb)`, FGC `trip-updates` | "+3 min" por cruce con `tripId` | fase 2 |
| Avisos e incidencias | Renfe `alerts`, FGC `alerts-gtfs_realtime` | patrón de #733 | fase 2 |
| Tipo de servicio (AVE/Alvia/MD) y nombres de parada Renfe | GTFS estático de Renfe | Join estático (pesado) | fase 2 |
| Color oficial de línea | GTFS de rutas | Hoy se colorea por modo; cambiarlo es una decisión de producto | discutir |

Para PR A y PR B, lo nuevo en la ficha debería salir de campos genéricos opcionales
del registro normalizado (p. ej. `platform`, `destination`, `onTime`, `occupancyPct[]`),
no de código específico por operador. Así otros feeds los pueden rellenar.

---

## 9. TMB (metro y bus de Barcelona) — revisión de APIs (2026-10-12)

Fuente: portal `developer.tmb.cat`, leído en navegador porque es una SPA. Las
especificaciones Swagger son públicas en `https://developer.tmb.cat/assets/api-docs/v1/<servicio>/swagger.json`.

| Servicio | Base | Qué da | ¿Tiempo real? |
| --- | --- | --- | --- |
| Transit | `api.tmb.cat/v1/transit` | ~40 endpoints GeoJSON: líneas de metro y bus, recorridos (`recs`), tramos entre estaciones (`trams`), estaciones, accesos, paradas, intercambiadores, mobiliario, horarios teóricos, correspondencias | No (estático) |
| iMetro | `api.tmb.cat/v1/itransit/metro/estacions?estacions=…` | Por estación, vía y sentido: próximos trenes con `codi_servei` (el número del frontal del tren) y `temps_arribada` (epoch ms), `desti_trajecte` y `color_linia`. Actualización ≥ 10–15 s | Sí: **predicción de llegada** |
| iBus | `api.tmb.cat/v1/itransit/bus/parades/{codi_parada}` | Por parada: próximos buses con `id_bus` y `temps_arribada`, precisión de minuto. Incluye líneas AMB de otros operadores (`transit_namespace`) | Sí: **predicción de llegada** |
| Planner | `api.tmb.cat/v1/planner/plan` | Rutas (OpenTripPlanner) | — |
| Static | `api.tmb.cat/v1/static/datasets/gtfs.zip` | GTFS estático (semanal) | No |

**No existe** GTFS-Realtime ni posiciones de vehículos (ni de metro ni de bus).
El AMB tampoco publica GTFS-RT de autobuses: solo GTFS estático
(Mobility Database `mdb-892`) y AMBtempsbus, que da minutos a parada.

**Autenticación y licencia.** Todo, incluido el GTFS estático, pide
`app_id` + `app_key` (registro en el portal y alta de una "aplicación").
Condiciones (`/docs/terms-conditions`):
- licencia gratuita, no exclusiva, mundial e indefinida, que permite "la reproducción, la
  distribución y la comunicación pública, así como la creación y la explotación de obras
  derivadas", sobre GTFS y tiempo real;
- obliga a citar la fuente y la fecha de última actualización y a no desnaturalizar;
- y a **"reutilizar los contenidos única y exclusivamente para la aplicación y/o servicio
  indicado en la solicitud"**.

TMB puede cambiar la API o cortar la licencia sin aviso. No hay límites de peticiones publicados.

**Encaje con upstream: no.** Incumple las tres reglas de admisión de la capa Transit:
- pide clave;
- la licencia va ligada a una aplicación concreta;
- solo hay predicciones de llegada, no coordenadas. El caso es exactamente el de NYCT
  subway, que el registro excluye a propósito.

**Opciones solo para nuestro fork** (clave del usuario en POWER UP, como AEMET):

1. **Metro "estimado".** Una llamada a iMetro con todas las estaciones devuelve, por cada
   `codi_servei`, sus próximas llegadas en cada estación. Entre la última estación
   pasada y la siguiente se interpola sobre la geometría de `linies/metro/{l}/trams`.
   - Marcado siempre como *posición estimada a partir de predicciones de llegada*, con su
     propio modo y estilo, nunca como GPS.
   - Riesgos: trenes que "saltan" cuando cambia la predicción, ambigüedad del
     `codi_servei` entre líneas, y lagunas en terminales.
   - Coste: una petición cada 15–30 s.
2. **Panel de llegadas por estación/parada** al hacer clic en una estación de metro o
   parada de bus (iMetro/iBus bajo demanda). Es honesto, barato y útil, sin animación.
3. **Geometría oficial** (líneas, estaciones y accesos de metro en GeoJSON) como capa
   estática de contexto. Hay que valorar si compensa frente a OSM.

Recomendación: empezar por (2) y (3) en el fork. (1) solo como experimento y siempre
etiquetado como estimación. Requiere que el usuario se registre en developer.tmb.cat.
