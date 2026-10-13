# Hoja de ruta — Transporte en España (Renfe, FGC, TMB) en el fork

Estado: plan de trabajo **solo para el fork** (`mi-main`), reescrito el 2026-10-12 y
reordenado el 2026-10-13 (fases 6–10, tras el reanálisis de datos).
Todo lo técnico se ha comprobado contra los feeds en vivo (incluida una observación de
10 min) y contra el código de `upstream/main` (591f299). No quedan pendientes de
investigación.

## Cómo retomar (estado al cierre del 2026-10-13)

- **Hecho y en `mi-main`** (`e1d2fcf`, subido): fases 1–5e. Todas las ramas
  `feat/transit-es-*` están fusionadas; la siguiente fase sale de `mi-main` en una rama
  nueva.
- **Siguiente: Fase 6a — ficha de FGC** (ver Fase 6). Punto de partida:
  - `src/data/fgcGeotren.js` (`decodeFgcGeotren`): hoy solo lee `lin`, `id`, `ut`,
    `estacionat_a` y la primera de `properes_parades`. Añadir `desti`, `origen`, la lista
    completa de paradas, `en_hora`, `ocupacio_*_percent`, `tipus_unitat` y
    `estacionat_a` como campos genéricos opcionales del registro.
  - Nombres de parada: el diccionario `stopNames` de FGC (`spainTransitStations.js`).
  - Ficha: `buildTransitSelectionCopy` en `src/layers/transit/policy.js`.
  - Horas por parada: el TU de FGC está en
    `https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/trip-updates-gtfs_realtime/files/735985017f62fd33b2fe46e31ce53829`
    (comprobar que el id del fichero no cambia; si cambia, leerlo del endpoint
    `.../records`).
- **Entorno:**
  - Tests con Node 24 de nvm (`source ~/.nvm/nvm.sh && nvm use 24`); el Node 21 del
    sistema cuelga un test.
  - Gates: `npm test`, `npm run format:check`, `npm run check:boundaries`. Los módulos
    nuevos van en `scripts/package-boundaries.json` y `scripts/format-scope.json`.
  - El `npm run dev` del usuario (puerto 4173) sirve la rama que esté activa. Al tocar
    `server/providers/*` o `src/sources/*` se reinicia solo, y una vez dejó un 504
    "Outdated Optimize Dep" que se arregla con `npm run dev -- --force`. Avisar antes de
    tocar código de servidor.
  - El panel de navegador de la app no pasa de "Initializing photorealistic world…":
    para verificar en vivo, un script de Puppeteer con Chrome visible (`headless:
false`; el patrón está en `scripts/qa-transit.mjs`).
  - No meter en el repo respuestas de TMB como fixtures (licencia ligada a la app):
    fixtures mínimos hechos a mano.

## 0. Decisiones de partida

- **Todo se hace y se integra en `mi-main`.** No hay PRs intermedios a upstream.
- **Fases en orden**, cada una en su rama `feat/transit-es-<fase>`. Una fase se fusiona en
  `mi-main` cuando cumple su "hecho cuando", con commit y push.
- **Calidad de PR desde el primer día.** Cada fase sigue la guía de contribución de
  upstream: tests, docs y gates. Así, si en el futuro hay suficientes integraciones de
  datos de España, el PR conjunto a upstream (Fase 10) es una tarea de **montaje**, no de
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
   - **#733** (MBTA rutas y alertas): patrón para el trazado de líneas (Fase 5) y para las incidencias (Fase 8).
5. **Ninguna fase añade capa nueva** (son filas de la capa Transit existente), así que no
   hacen falta tokens de share-link. TMB (Fase 4) sí podría necesitar una capa, y usaría
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
  ver Fase 6.
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

### Fase 2 — Enganches compartidos: `format` e intervalo mínimo por feed — ✅ hecha 2026-10-13

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

**Resultado (2026-10-13, rama `feat/transit-es-hooks`):**

- `TRANSIT_FORMATS` en `transitProxy.js` asocia cada `format` a su `Accept` y su
  decodificador. Por ahora solo hay `gtfs-rt`, que es el valor por defecto.
  - `transitFormatFor` rechaza un formato desconocido como fallo de forma; no cae a protobuf.
  - Compatible con #944: el mismo campo `format`. Si se fusiona, `entur-vehicles` será
    una entrada más de la tabla en lugar de su `if`.
  - No se ha traído `request` (POST) ni `reportedMode` de #944, porque FGC no los necesita.
- `minIntervalMs` por feed, mediante `transitFeedTtlMs`: alarga la ventana de caché, con
  un tope de 10 min. `transitCacheState` y `transitResponseHeaders` reciben el TTL del
  feed. El navegador sigue sondeando cada 15 s y recibe la caché: la capa considera
  viejo un feed a partir de 90 s, así que no hace falta cambiarla.
- `429`: espera lo que pida `Retry-After` (`transitRetryAfterMs`, segundos o fecha), con
  un mínimo de 60 s y un máximo de 15 min, en vez de los primeros escalones del backoff.
- Tests en `src/data/transitFeedHooks.test.mjs`, incluido un servicio que recibe un 429
  y no vuelve a preguntar al operador.
  - La prueba de punta a punta del intervalo mínimo con un feed real queda para la Fase 3.
- Validación: format, boundaries, `npm test` (6499 OK) y build pasan. En vivo, Renfe,
  MBTA y HSL siguen igual (MISS y luego HIT, `max-age=15`).

### Fase 3 — FGC (Geotren) — ✅ hecha 2026-10-13

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

**Resultado (2026-10-13, rama `feat/transit-es-fgc`):**

- Implementado como estaba planeado:
  - `src/data/fgcGeotren.js`: decodificador JSON de la API v1 de Opendatasoft, con
    `geo_point_2d` como `[lat, lon]` y `geometry` de respaldo;
  - `id` = `ut` y `tripId` = `id`;
  - estado y parada desde `estacionat_a` o la primera de `properes_parades`;
  - ocupación del coche más lleno, mapeada al enum GTFS;
  - hora de cabecera desde `record_timestamp`;
  - un JSON malformado da error, no flota vacía.
- Formato `fgc-geotren` en `TRANSIT_FORMATS` y fila `fgc-geotren` en
  `transitFeedsSpain.js`: centro (41.5, 1.95), r = 60 km, `minIntervalMs` 60 s.
- `fgcRouteMode` vive en el módulo del registro, no en el decodificador, para que el
  registro no arrastre `pbf` (fallaba `check:boundaries` en el paquete `tools`).
- **Ajuste que salió al validar: feeds de cadencia lenta.** La reproducción tenía dos
  topes fijos: retraso ≤ 120 s y "NO FIX" a partir de 90 s. Con datos de hasta ~3 min,
  los trenes de FGC se quedaban congelados y marcados "No recent fix".
  - Nuevo campo `reportIntervalMs` (120 s en FGC).
  - Nueva función `transitFeedTiming(feed)` en `policy.js`: para FGC, umbral de 315 s
    y retraso máximo de 225 s.
  - `contactPlayback` lee el tope de la política de cada pista (`maxDelayMs`) y
    `displayMotion` usa el `staleMs` de la pista.
  - Los demás feeds conservan 90 s y 120 s.
- Completada la prueba pendiente de la fase 2: con el reloj simulado, durante 59 s todas
  las peticiones son HIT y Geotren solo recibe 2 peticiones.
- **Validación:**
  - format, boundaries, `doctor`, `npm test` (6508 OK) y build pasan;
  - `test:track`: 109/109;
  - `qa:transit` en Barcelona (Pl. Catalunya) pasa la ficha, DETECT, los sprites y el
    movimiento, con FGC, Cercanías y LD a la vez. Ficha: "🚆 Route S1 · FGC · Last
    report: stopped at stop TT · many seats available · shown 27 s behind".
  - El check de flota (≥ 20 vehículos) falló a las 00:45 por la hora: había 19.
  - Proxy en vivo: MISS y luego HIT con `max-age=60`.
  - Cuota consumida en todo el día de pruebas: ~150 de 5.000.
- **Cierre (2026-10-13, 11:30, `QA_CITIES=barcelona`, Node 24):**
  - Barcelona pasa entero: 431 vehículos (FGC 53, Cercanías 241, AV/LD/MD 137), ficha,
    DETECT (`L6/METRO`), sprites por modo, movimiento y la recarga del histórico.
  - Ficha de metro de día (captura `qa-shots/transit/keyed-barcelona-fgc-l7-card.jpg`):
    "🚇 Route L7 · Subway · FGC … next stop TB · many seats available · Shown at
    street level · depth not in the feed".
  - Fallos fuera de Barcelona, ninguno de la fase: `budgets` y `matrix` (ya fallaban en
    la base) y `trail-visible` (Austin, 300 m). Este último también falla, y de forma
    intermitente, en `6c6a2f8` (mi-main antes de FGC).
  - El "unexercised" de contraste por estilo se debe a pocos sprites aislados en
    pantalla (1–2 de 6), no a un fallo.
- **Pins del fork que cambian:** `transitQa.test.mjs` cuenta 9 filas de Transit en
  DATA_SOURCES (antes 8).

### Fase 4 — TMB: clave y llamadas a la API — `solo fork`

**Por qué es solo para el fork.**

- La licencia obliga a "reutilizar los contenidos única y exclusivamente para la
  aplicación y/o servicio indicado en la solicitud".
- Solo hay predicciones de llegada: no hay coordenadas.

**4a — Clave en POWER UP** (como AEMET) — ✅ hecho 2026-10-13: entrada `tmb` en
`src/keySetupCore.mjs` (las dos variables obligatorias), bloque en `.env.example` y
`/api/tmb/status` (`server/providers/tmb.js`). Este último prueba la pareja con una petición
pequeña a `/v1/transit/linies/metro`, cacheada 10 min, y responde `ok`, `rejected` o
`unavailable` sin devolver nunca la clave. Tiene la guarda contra peticiones de otros
sitios y no sigue redirecciones. Tests en `src/tooling/tmbProvider.test.mjs`. `TMB_APP_ID` y `TMB_APP_KEY` van solo en el
servidor (`.env`) y se ofrecen en el panel POWER UP, con enlace al registro en
developer.tmb.cat. El navegador nunca ve la clave: todas las llamadas pasan por un
proxy propio (`/api/tmb/...`) que solo admite rutas fijas.

**4b — Panel de próximas llegadas** — ✅ hecho 2026-10-13. Al pulsar una estación de metro (iMetro) o una
parada de bus (iBus), bajo demanda y con caché corta (~15 s). Sin clave, la capa dice
claramente que necesita una. Rama `feat/transit-es-tmb-arrivals`.

_Datos comprobados en vivo el 2026-10-13 con la clave del fork:_

| Petición                                                     | Respuesta                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/transit/linies/metro/estacions`                         | 171 estaciones-línea (133 KB, `max-age=10800`), 140 grupos `CODI_GRUP_ESTACIO`. Líneas L1–L5, L9N/S, L10N/S, L11 y FM (funicular). Cada fila: `CODI_ESTACIO`, `NOM_ESTACIO`, `NOM_LINIA`, `COLOR_LINIA`, punto        |
| `/v1/transit/parades`                                        | 2.723 paradas de bus, **1,9 MB** con 19 campos: hay que recortarlas en el servidor a `{codi, nom, lat, lon}`                                                                                                          |
| `/v1/itransit/metro/estacions?estacions=326,126` (Catalunya) | 1,5 KB. `linies[] → estacions[] (codi_via, id_sentit) → linies_trajectes[] (desti_trajecte, color_linia) → propers_trens[] {codi_servei, temps_arribada}` (epoch ms) + `timestamp` de la consulta. Dos trenes por vía |
| `/v1/itransit/bus/parades/108` (Pl. Espanya – FGC)           | 4,8 KB. `parades[] → linies_trajectes[] (nom_linia, desti_trajecte, id_sentit) → propers_busos[] {temps_arribada, id_bus}`. Incluye líneas AMB (L70, X70…)                                                            |

Un grupo de estación (p. ej. Catalunya = L1 `126` + L3 `326`) se consulta en **una sola**
petición iMetro con todos sus `CODI_ESTACIO`.

**Cambios.**

1. **Servidor** — ampliar `server/providers/tmb.js` (sigue siendo `solo fork`):
   - `GET /api/tmb/stations` → `{metro: [{group, name, lat, lon, codes[], lines[{name, color}]}], bus: [{code, name, lat, lon}]}`.
     Une las 171 estaciones-línea por grupo y recorta las paradas. Caché en memoria de
     24 h, single-flight, y se sirve la copia vieja si TMB falla. Sin caché en disco: eso
     queda para la Fase 5.
   - `GET /api/tmb/arrivals/metro/<group>` y `GET /api/tmb/arrivals/bus/<code>`:
     - id validado con `^\d{1,6}$` (404 si no);
     - el grupo debe existir en el catálogo, y el servidor traduce grupo → códigos;
       el navegador nunca elige la URL;
     - caché de 15 s por id, single-flight, y como máximo 30 ids distintos por minuto
       para que un clic repetido o un bucle no gaste la cuota de la app;
     - respuesta normalizada: `{fetchedAt, lines: [{line, color, destination, track, arrivals: [epochMs…]}]}`.
       Nunca se reenvía el cuerpo de TMB.
   - Sin clave → 503 `{error: 'no_key'}`, como AEMET. Con clave rechazada → 502
     `{error: 'rejected'}`. Mismas guardas que `/status`: `sameSiteGated`,
     `redirect: 'error'`, timeout, y la clave nunca en logs ni respuestas.
2. **Decodificador puro** — `src/data/tmbArrivals.js`: `normalizeTmbMetroArrivals`,
   `normalizeTmbBusArrivals` y `buildTmbArrivalsCopy` (título + líneas de la ficha:
   "L3 → Trinitat Nova · 3 min, 6 min"). Sin Cesium, para que se pueda testear y para
   no romper `check:boundaries`.
3. **Capa nueva `tmb-arrivals`** — `src/data/tmbArrivalsLayer.js`, con el patrón de
   `aemetBeaches.js` (puntos, `pickRegistry`, ficha seleccionada en `worldOverlay`):
   - estaciones de metro como puntos con el color de la línea (gris si son varias);
   - paradas de bus solo a escala de calle (umbral de altura de cámara, a fijar al
     validar), para no pintar 2.723 puntos a vista de ciudad;
   - solo carga el catálogo si la cámara está a ≲ 40 km de Barcelona;
   - al pulsar: pide las llegadas y refresca cada 15 s mientras siga seleccionada
     (cuenta atrás local entre refrescos). Escape o clic fuera cierra la ficha;
   - sin clave: aviso "TMB needs a developer key — add it in POWER UP" y ningún
     punto. Clave rechazada: aviso equivalente;
   - créditos: "TMB" con la fecha de consulta, como pide la licencia.
4. **Registro de la capa:**
   - token **`zh`** en `LAYER_STATE_REGISTRY` (bloque `z*` del fork) y en el ledger;
   - `constructCatalog.js`, `layerManifest.js` (alias de voz: "metro arrivals",
     "bus arrivals", "TMB") y `dataCredits.js`;
   - nada en `transitFeeds*.js`: TMB no tiene posiciones.

**Validación.**

- Tests sin red con fixtures recortados de las respuestas de arriba:
  - normalizadores (metro con dos líneas, bus con líneas AMB, listas vacías, JSON roto);
  - proxy: validación de id, caché de 15 s, single-flight, 503 sin clave, 502 si TMB
    rechaza, sin redirecciones, y que la clave no aparezca en ninguna respuesta;
  - catálogo: agrupación por `CODI_GRUP_ESTACIO` y recorte de paradas.
- Gates comunes (§5), con Node 24.
- En vivo: ficha de Catalunya (L1 + L3) y de la parada 108; contar peticiones a TMB en
  5 min con la ficha abierta (≈ 20 para una ficha, no más).

**Pins del fork que cambian:** el ledger pasa de 36 a 37 reservas (`zh`); revisar
también los recuentos del manifiesto de voz y de DATA_SOURCES si los hay.

**Hecho cuando** la clave se guarda desde POWER UP y se valida contra la API, y el panel
muestra las llegadas reales de una estación y una parada.

**Resultado 4b (2026-10-13, rama `feat/transit-es-tmb-arrivals`):**

- Implementado como estaba planeado:
  - `server/providers/tmb.js`: `/api/tmb/stations` y `/api/tmb/arrivals/{metro|bus}/<id>`;
  - `src/data/tmbArrivals.js`: normalizadores y ficha, sin Cesium;
  - `src/data/tmbArrivalsLayer.js`: capa `tmb-arrivals`, token `zh`.
- Catálogo en vivo: 137 estaciones (las 3 "Planificat" fuera) y 2.723 paradas, 229 KB
  servidos. TMB lo da recortado con `propertyName=…,GEOMETRY`: sin `GEOMETRY` llega
  sin coordenadas, y las paradas pasan de 1,9 MB a 646 KB.
- Diferencias con el plan:
  - El catálogo se carga al activar la capa, esté donde esté la cámara: el servidor lo
    guarda 24 h, así que son 2 peticiones a TMB al día.
  - El tope es de **30 peticiones de llegadas a TMB por minuto** en total, no de ids
    distintos. Es más simple y más estricto; una ficha abierta gasta 4.
  - **Los puntos se dibujan sobre el mesh 3D** (`disableDepthTestDistance` igual a su
    distancia máxima: 40 km metro, 3 km bus). En Pl. Catalunya el punto medio de los
    andenes queda bajo el mesh, que lo tapaba y se quedaba el clic. Al no verse a más de
    40 km, no aparecen al otro lado del globo.
- Validación:
  - Tests nuevos: 8 del módulo puro, 7 de la capa y 7 más en `tmbProvider.test.mjs`
    (15 en total). `npm test` da 6.547, 0 fallos. Pasan format, boundaries, `doctor` y
    build.
  - En vivo, con Puppeteer: al pulsar Catalunya sale "L1 → Fondo · 3 min / L3 → Trinitat
    Nova · 2 min, 6 min … Source: TMB iMetro · 12:25". La parada 108 lista 16 líneas,
    AMB incluidas (X86, L95…). Con la ficha abierta hay 3 refrescos en 46 s, y Escape
    la cierra.
  - Rutas: 404 para ids fuera del catálogo y 403 si la petición viene de otro sitio.
- **Pins del fork que cambian:**
  - catálogo de capas 37 → 38 (`constructCatalog.test`, `sourceComposition.test`);
  - `REGISTERED_LAYER_IDS` 36 → 37 (`layerState.test`);
  - ledger 36 → 37 reservas, "38 published" y `l` de 93 caracteres
    (`layerStateTokenLedger.test`);
  - esquema de voz: longitud 30732 más los hashes de `firstRunExperience.test` y
    `actionSchemas.test`.

**4c — (Después de la 4b) Ampliación AMB y bicis compartidas.** Decidido el 2026-10-13:
las paradas AMB no entran en la 4b. Van en una ampliación posterior, junto con AMBici y
Bicing en la capa Bike Share:

- llegadas a paradas AMB desde el TripUpdates (sin clave), en el mismo panel de la 4b;
- AMBici (GBFS, CC0) y Bicing (GBFS, licencia por verificar) como filas de la capa
  Bike Share de upstream;
- datos y licencias en §4, "AMB".

**Resultado 4c (2026-10-13, rama `feat/transit-es-amb`):**

- **AMB en la capa de llegadas.** La capa pasa a llamarse "Barcelona Arrivals (TMB ·
  AMB)" y conserva su id y su token (`tmb-arrivals`, `zh`).
  - `server/providers/amb.js` sirve `/api/amb/stops` y `/api/amb/arrivals/<stop_id>`:
    - el GTFS estático se baja una vez al día y se leen solo `stops`, `routes` y `trips`
      (lector de zip propio, con tope por fichero);
    - `trips.bin` se pide como mucho cada 30 s, revalidado por ETag, y una sola descarga
      sirve a todas las paradas;
    - cada refresco reconstruye el índice de llegadas por parada.
  - `src/data/ambArrivals.js` (puro): CSV, paradas, líneas, cabeceras de viaje,
    decodificador de TripUpdates y el índice por parada.
  - **Paradas:** 4.861 en servicio. 1.417 tienen el mismo código que una de TMB ("000108"
    es la 108), y se dibujan una sola vez, como TMB: iBus ya da allí las líneas AMB. Quedan
    3.444 solo de AMB, en ámbar. Con clave: 6.304 puntos en total.
  - **Sin clave de TMB** se dibujan todas las paradas AMB, y el estado dice "AMB stops
    only — metro and TMB buses need the TMB key (POWER UP)".
  - **En vivo:** al pulsar Eusebi Güell – Joaquim Auger (Sant Boi) salen 4 líneas (X79,
    L78, M75, SB1). El feed trae ~845 viajes y ~2.240 paradas con llegada. Cada viaje
    solo predice sus próximas paradas, así que las paradas lejanas de cualquier bus salen
    vacías ("No arrivals reported right now").
  - El test encontró un fallo antes de llegar a producción: una coordenada vacía en
    `stops.txt` se convertía en (0, 0).
- **Bicis.** Filas `barcelona-bicing` y `barcelona-ambici` en
  `src/layers/bikeshare/registrySpain.js`, empalmadas con una línea en el registro, y
  `gbfs.nextbike.net` en la lista blanca de `gbfsSource.js` (Bicing ya entraba por
  `*.publicbikesystem.net`).
  - En vivo: 544 estaciones de Bicing y 237 de AMBici, 781 en total.
  - **Licencia de Bicing:** el feed GBFS del operador está en `systems.csv` de MobilityData
    sin autenticación, como los sistemas PBSC de EE. UU. que ya usa upstream. La copia
    del Ayuntamiento es CC BY 4.0, pero desde 2024 pide token. Crédito: "Bicing ·
    Barcelona City Council (B:SM)".
  - **Detalle de upstream (sin tocar):** la fila del panel de Bike Share solo se refresca
    en el sondeo de 60 s. Con dos sistemas cargando a la vez muestra "237 LOADING ·
    syncing 2 city feeds" hasta ~1 min, aunque la capa ya pinta las 781.
- **Límites de distancia subidos** tras probarlo el usuario: con 40 km (metro) y 3 km
  (bus) no se veía nada al mirar Barcelona entera. Ahora son **150 km** para el metro
  (137 puntos) y **5 km** para las paradas TMB y AMB. El depth test sigue desactivado
  hasta esa misma distancia; a 150 km el horizonte está mucho más lejos, así que no
  aparecen puntos al otro lado del globo.
- **Validación:** `npm test` da 6.563 tests, 0 fallos. Pasan format, boundaries y build.
  Comprobado en la app con Puppeteer: ficha AMB, estaciones de bici y la carga de los
  feeds a través del proxy.
- **Pins del fork:** ninguno nuevo (el alias de voz "amb buses" no cambia el esquema).

### Fase 5 — Red y estaciones (datos estáticos con script)

**Cuándo.** Cuando Renfe (✅), FGC (Fase 3) y TMB (Fase 4) ya estén conectados. Así una
sola pasada cubre las tres redes, y el diccionario de estaciones sirve a la vez a:

- los ids de parada de Renfe ("18000" → Madrid-Atocha Cercanías);
- las iniciales de Geotren ("PC" → Pl. Catalunya);
- los códigos de estación de TMB.

**Fuentes** (comprobadas el 2026-10-13; todas CC BY 4.0 salvo TMB):

| Red                                                                                                                      | Estaciones                              | Trazado                                                                                                     | Extras                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renfe Cercanías/Rodalies, GTFS `https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip` (14 MB)          | 1.136 en `stops.txt`                    | `shapes.txt`: 15 núcleos y 152 trazados, Rodalies incluido (R1–R17, RG1, RL3/4, RT1/2, en los dos sentidos) | Color oficial por línea en `routes.txt`. El núcleo sale del prefijo del `tripId` en tiempo real ("51…" Barcelona, "10…" Madrid) y distingue la C1 de Madrid de la de Sevilla |
| Renfe AV/LD/MD, GTFS `https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip` (0,9 MB)                          | 1.006                                   | ❌                                                                                                          | Tipo de servicio por ruta (AVE, Alvia, Intercity…)                                                                                                                           |
| FGC (dadesobertes.fgc.cat): `gtfs_stops`, `gtfs_shapes`, `lineas-red-fgc`, `codigo-estaciones`                           | 305 paradas, más los códigos de Geotren | 11.662 puntos                                                                                               | Color por línea                                                                                                                                                              |
| IGN "Redes de transporte de España" (WFS INSPIRE `https://servicios.idee.es/wfs-inspire/transportes`, CC BY 4.0 scne.es) | Áreas y nodos de estación               | Toda la red ferroviaria (enlaces ferroviarios), alta velocidad incluida                                     | Tipo y uso de vía                                                                                                                                                            |
| TMB `/v1/transit` (clave, licencia ligada a la app)                                                                      | Estaciones y accesos de metro           | Líneas y tramos (`trams`)                                                                                   | —                                                                                                                                                                            |

Todos los `stopId` de Renfe en tiempo real que se probaron existen en sus GTFS.

**Cómo:**

1. **Script** `scripts/build-spain-transit-network.mjs`, en la línea de
   `build-spain-boundaries.mjs`:
   - descarga los GTFS de Renfe y los datasets de FGC;
   - extrae estaciones `{id, nombre, lat, lon}`, rutas `{núcleo, línea, color}` y
     trazados simplificados (Douglas–Peucker, ~10 m);
   - escribe JSON compactos en `src/data/local_data/spain_transit/` con un `SOURCE.md`
     de fuentes, fechas y licencias.
   - Se carga con `loadBundledJson` (la regla de upstream prohíbe importar JSON como módulo).
   - Presupuesto orientativo: estaciones ~100 KB, trazados ≤ 600 KB.
   - El script se vuelve a ejecutar cuando cambian los GTFS (mensual, o cuando Renfe
     publique horarios nuevos).
2. **Red de larga distancia:** con la capa ferroviaria del IGN, simplificada con el mismo
   script. Es el paso más pesado; va al final de la fase.
3. **TMB no se empaqueta.** Por clave y licencia, el servidor descarga su geometría con la
   clave del usuario y la guarda en caché local (gitignored).
4. **En la app:**
   - nombres de estación en la ficha ("next stop Madrid-Atocha Cercanías");
   - trazado de líneas con color oficial, siguiendo el patrón del PR #733 (polilíneas
     agrupadas a ras de suelo);
   - marcadores de estación a escala de calle.

**Validación.**

- Tests del script con un GTFS de fixture recortado, y un test de tamaño de los JSON.
- Comprobar que los ids de parada observados en vivo (Renfe, FGC) tienen nombre.
- Capturas de Barcelona y Madrid con red y trenes, y gates comunes.

**Hecho cuando** la ficha nombra las estaciones, se ven las líneas de Cercanías/Rodalies
y FGC con sus colores, y regenerar los datos es ejecutar un solo comando.

**Subfases** (decidido al empezar, 2026-10-13; rama `feat/transit-es-network`):

- **5a — Diccionario de estaciones y nombres en la ficha** — ✅ hecho 2026-10-13.
- **5b —** trazado de Cercanías/Rodalies y FGC con color oficial, y marcadores de
  estación a escala de calle.
- **5c —** red de larga distancia del IGN.
- **5d —** geometría de TMB y AMB, servida por el servidor (TMB, por clave y licencia;
  AMB, porque su licencia no permite alterar el contenido) — ✅ hecho 2026-10-13
  (rama `feat/transit-es-bus-geometry`). Los tramos de metro (`trams`) pasan a la
  Fase 9.

**Resultado 5a:**

- **Script** `scripts/build-spain-transit-network.mjs`: un solo comando, con
  `--from DIR` para usar descargas locales. Escribe
  `src/data/local_data/spain_transit/stations.json` (97 KB) y su `SOURCE.md`:
  - Renfe Cercanías: 1.151 estaciones; Renfe AV/LD/MD: 1.006;
  - FGC: 110 iniciales de Geotren, 98 con coordenadas. Las 12 sin punto son
    funiculares y cremalleras, que el GTFS de FGC no trae.
  - Lee los zips con el `readZipEntries` del proxy AMB. El parser CSV pasa a un módulo
    compartido, `src/data/gtfsCsv.js`.
- **Enganche genérico** `stopNames` en el registro (`() => Promise<{stopId: name}>`):
  - `transitService` carga el diccionario una vez por feed; si falla, sirve sin nombres
    y reintenta al minuto;
  - `buildTransitSnapshot(…, {stopNames})` añade `stopName` con `applyStopNames`
    (máximo 120 caracteres, solo propiedades propias);
  - la ficha dice "stopped at Sarrià" / "next stop Pl. Catalunya". Sin nombre conserva
    "stop SR".
  - Las filas de España usan `spainStationNames(network)`
    (`src/data/spainTransitStations.js`, `loadBundledJson`).
- **En vivo:**
  - Cercanías: 293/293 trenes con nombre. LD: todos los que traen parada. FGC: 61/61.
  - Ficha real: "🚇 Route L6 … Last report: next stop Pl. Catalunya".
  - `qa:transit` (Barcelona, sección de ciudades) pasa.
- **Validación:** `npm test` da 6.571 tests, 0 fallos. Pasan boundaries y build.
- **Resultado 5b (2026-10-13):**
  - El script también escribe `lines.json` (295 KB, por debajo del presupuesto de
    600 KB): 72 líneas de Cercanías/Rodalies en 15 núcleos y 19 de FGC, con 16.569
    puntos tras Douglas–Peucker a 10 m. De Cercanías se dibuja un sentido por línea (se
    descarta `_INV`); FGC sale de `gtfs_routes`, que trae geometría y color.
  - **Capa nueva del fork** "Rail network (Spain)" (`spain-rail-network`, token
    **`zi`**, `src/data/spainRailNetworkLayer.js`). Las vías no van en la capa Transit:
    se pueden ver sin trenes y no toca código de upstream.
    - Líneas: un solo `GroundPolylinePrimitive` con color por instancia (3 px, a ras de
      suelo, `ClassificationType.BOTH`), el mismo primitivo que upstream usa para
      estelas y tráfico.
    - Estaciones: 1.249 puntos (Cercanías y FGC con coordenadas), visibles a ≤ 8 km y
      dibujados sobre el mesh 3D hasta esa misma distancia.
    - Al pulsar una línea o una estación sale una ficha ("🛤 R2 · Rodalies de
      Catalunya · line", "🚉 Barcelona-Sants · Renfe Cercanías station · 71801"). No se
      usan etiquetas de Cesium (upstream las prohíbe por test).
    - Nombres de núcleo por prefijo: 45 Cartagena, 46 Ferrol y 47 León son las redes de
      ancho métrico (deducido por geografía).
  - **Datos de origen tal cual:** FGC publica S9 y L8 con la misma geometría (salen
    fusionadas), el Montserrat (MM) sin color (gris neutro), y la R1 de Rodalies con dos
    colores en `routes.txt` (se queda el más frecuente, `094188`).
  - **En vivo:** Barcelona a 45 km muestra todas las líneas de Rodalies y FGC con su
    color, y la vista de España, todos los núcleos. El clic en Sants abre su ficha. Sin
    errores de página.
  - **Pins del fork:** catálogo 38 → 39; `REGISTERED_LAYER_IDS` 37 → 38; ledger 38
    reservas, "39 published" y `l` de 96; esquema de voz 30819 más sus hashes.
- **Resultado 5c (2026-10-13, rama `feat/transit-es-ign`):**
  - **Script aparte** `scripts/build-spain-rail-ign.mjs`, porque es lento (decenas de
    minutos) y frágil, con `--cache DIR`. Genera `ign_rail.json` (345 KB): 377 de las 378
    líneas de tipo tren, 35.376 tramos encadenados en 2.110 trazados y 21.696 puntos
    (Douglas–Peucker a 50 m, 4 decimales).
  - **El WFS del IGN** (`tn-ra:RailwayType`, `RailwayLine` y `RailwayLink`) tiene tres
    trabas:
    - el proxy corta a los 60 s;
    - las páginas con líneas enormes fallan, así que se parten en mitades hasta llegar a
      elementos sueltos, y lo que nunca responde se salta y queda en `meta.skipped`
      (21 líneas, de las que solo 1 era de tren);
    - la paginación profunda (`startIndex` ≳ 24.000) siempre da timeout, así que los
      tramos se piden por cuadrículas BBOX de 1° en quadtree (las que llegan a 3.000
      se parten en 4; 155 peticiones).
  - Los tramos no traen atributos: el tipo va por línea (`RailwayType` → `RailwayLine`
    → tramos). El ancho de vía (`NominalTrackGauge`) está vacío casi siempre, así que no
    distingue la alta velocidad.
  - **En la capa:** la red IGN se dibuja debajo, en gris fino de 1,5 px; los colores de
    Cercanías y FGC van encima. Al pulsarla: "🛤 Railway · © IGN". La capa sigue
    funcionando si falta el pack.
- **Añadido en la misma rama, a petición del usuario:**
  - **Trazado del metro de TMB** en la capa de llegadas: `/v1/transit/linies/metro`
    (11 líneas, 25 KB, con color oficial) entra en el catálogo de 24 h del servidor, y la
    capa lo dibuja a ras de suelo (4 px, sin selección al pulsar).
  - **Estaciones de Renfe y FGC con el estilo del metro:** 9 px, color de su línea,
    blanco en las de enlace y pizarra si no pasa ninguna línea dibujada. El script asigna
    las líneas a cada estación por geometría (trazado a ≤ 80 m), en
    `lines.json → stationLines`: 936 estaciones. La ficha lista sus líneas.
  - **Distancias de visibilidad:** 75 km para las estaciones de metro (TMB) y de tren
    (Renfe, FGC). Las paradas de bus siguen a 5 km.
  - **Los trenes siguen la vía** (enganche genérico `trackGeometry`, como `stopNames`):
    - `src/data/trackFollow.js` indexa las vías en una rejilla de ~1 km;
      `pathBetween(a, b, línea)` proyecta los dos fixes (≤ 150 m) sobre el mismo trazado
      y devuelve el recorrido por la vía, con los extremos exactamente en los fixes;
    - devuelve null, y se queda la recta, si un fix está lejos, si los dos no comparten
      trazado o si el desvío es absurdo (> 3 × la recta + 500 m);
    - `trails.prepareEntry` (capa Transit) genera con él los puntos de cada tramo a ras
      de suelo, y el icono toma el rumbo de la vía en cada trozo. `contactPlayback`
      (compartido con aviones y barcos) no se toca;
    - vías por feed: Cercanías sus líneas (por nombre), FGC las suyas ("S9 · L8" se
      separa) y LD la red IGN más la de Cercanías.
    - **Medido con fixes reales** de 522 vehículos durante 2,5 min (tramos en
      movimiento): Cercanías 371/376 (99 %), FGC 50/50 y LD 373/382 (98 %; un 31 % sin
      el pack IGN). En vivo, un R2 seleccionado junto a Sants deja su estela sobre la
      vía.
- **Incidencia:** se rompió la caché de dependencias de Vite de un servidor de desarrollo
  (504 "Outdated Optimize Dep" en `cesium.js`), y la app no arrancaba. Se arregla con
  `npm run dev -- --force`. Causa probable: un segundo Vite en un worktree con
  `node_modules` enlazado comparte `node_modules/.vite`.

### Correcciones antes de 5d — movimiento y estilos (2026-10-13, rama `feat/transit-es-polish`)

Comentarios del usuario: los trenes nacen parados y sin rumbo, se paran en sitios
al azar, y la red de alta velocidad no tiene el estilo del resto.

**Medido** con ~10 min de los tres feeds (sondeo cada 15 s; FGC cada 60 s) y
reproducción simulada con el código real de la capa:

- Ningún feed trae rumbo, pero todos traen parada y estado.
- **Repeticiones:** Renfe y FGC repiten la posición de un tren con hora nueva mientras
  sigue avanzando. Leídas como fixes, dibujaban parado/salto, o se rechazaban por
  imposibles (el salto medido desde la última repetición sale a 400+ km/h; desde la
  primera, ~166 km/h). Cercanías tenía el 58 % del tiempo "parado" y 490 rechazos.
- **Estados de Renfe:**
  - Cercanías: `IN_TRANSIT_TO` es la estación que el tren DEJÓ (39/48 se alejan de ella).
    `INCOMING_AT` trae una posición que no es la del tren (69 % a >120 km/h de la
    última fiable, a menudo en la estación siguiente a la de destino), y la capa
    llegaba a aceptarla al verla dos veces. `STOPPED_AT` sí está sobre la estación
    (mediana 19 m).
  - AV/LD/MD: `IN_TRANSIT_TO` es la próxima. `STOPPED_AT` está a 11 km de mediana de
    su estación y se mueve: es la última servida.
- **Arranque:** con un solo fix el tren espera a la segunda posición distinta (Cercanías
  p50 65 s, FGC ~2 min).

**Cambios** (genéricos en el registro y opcionales; los feeds de upstream no cambian):

- `interpretStatus(record)` → `stopRelation` (`at`, `arriving`, `next`, `left`, `last`)
  y `positionUntrusted`. Lo aplica el proxy. La ficha dice "left Sants" / "last stop",
  y la capa y el historial no usan las posiciones no fiables.
- `staleRepeats`: una posición repetida solo es un fix si el tren está parado en su
  parada (`at`). Se compara con la última posición vista, no solo con la aceptada,
  así que un fantasma repetido no reúne los dos votos.
- `historyRetention` en los tres feeds. Cada snapshot lleva `recent` (≤ 8 fixes en
  8 min, del mismo viaje), y un tren nuevo se siembra con ese tramo y empieza
  dentro de él, con el retraso del feed. Hasta medirlo, se usan los 120 s de
  reproducción: arrancar a solo ~30 s hacía que toda la flota esperara a la vez a
  los 20 s.
- `stopPlaces` → `stopLat`/`stopLon`, para dar rumbo a un tren con un solo fix: hacia
  la próxima parada (o desde la que dejó) a lo largo de la vía (`courseAlongTrack`).
- **Red ferroviaria:** el IGN se dibuja a 3 px, como las demás líneas, en un gris
  único (205, 210, 220) para la vía y las estaciones sin color. Se añaden las 354
  estaciones AV/LD/MD que no son de Cercanías.

**Resultado en vivo** (servidor con historial; Madrid, 150 s): AV/LD/MD con el 70–80 %
en marcha desde el primer segundo; Cercanías con el 40–60 % en marcha y ~40 %
parados en estación (Renfe marca `STOPPED_AT` en casi la mitad de sus registros).
Sin olas de espera y sin errores de página. Con el servidor recién arrancado (sin
historial), el arranque sigue necesitando dos posiciones.

**Límite conocido:** un tren de LD parado sin `STOPPED_AT` fiable deja de tener fixes
nuevos, y a los 90 s su ficha dice "No recent fix" aunque Renfe lo siga publicando.

**Resultado 5d (2026-10-13, rama `feat/transit-es-bus-geometry`):**

- **TMB:** `/api/tmb/bus-lines` pide `/v1/transit/linies/bus` una vez al día
  (`propertyName` con `NOM_LINIA`, `DESC_LINIA`, `COLOR_LINIA`, `ORDRE_LINIA` y
  `GEOMETRY`): 114 líneas, ~21.600 puntos, 415 KB. Rojo `DA291C` en las
  convencionales; el color de TMB en las H, V y D. Sin clave → 503 `no_key`, como el
  resto de TMB.
- **AMB:** `/api/amb/lines` sale del mismo GTFS diario que las paradas (ahora también
  lee `shapes.txt`). Por línea y sentido, el trazado que siguen más viajes: 140 líneas,
  263 trazados, 63.630 puntos, 1,2 MB. Los puntos se sirven tal cual (6 decimales),
  sin simplificar, porque la licencia no deja alterar el contenido. Un mismo trazado
  puede servir a varias líneas.
- **En la capa:** las rutas se cargan aparte y nunca retrasan las paradas. Se dibujan a
  2 px, con alfa 170 y por debajo del metro (4 px, encima). Se parten en tramos de
  ~2 km con `DistanceDisplayCondition` hasta 6 km: Cesium mide la distancia al centro
  de cada instancia, y una línea entera desaparecía aunque la cámara estuviera sobre
  uno de sus extremos.
- **En vivo:** Eixample a 3 km y 1,2 km con TMB y AMB, y L'Hospitalet a 2,5 km con
  AMB. A 9 km solo queda el metro. Sin errores de página.

### Fase 5e — Pills de filtro en las dos capas propias — ✅ hecha 2026-10-13

Rama `feat/transit-es-pills`. Pills **multiselección** en la fila de cada capa (el
mecanismo `getRowControls()` / `setParams()` de AEMET y Liveuamap), guardadas en el
estado y en los enlaces (`enabled+options`, opciones booleanas; por defecto todo
encendido, así que un enlace solo lleva lo que se apaga):

| Capa                                 | Pills                              | Qué hace cada una                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail network (Spain), `zi`           | CERCANÍAS · FGC · AV/LD · STATIONS | Una primitiva por red (Cercanías/Rodalies, FGC, red IGN). AV/LD incluye las estaciones solo de LD. STATIONS oculta todos los puntos de las redes encendidas                                     |
| Barcelona Arrivals (TMB · AMB), `zh` | METRO · TMB BUS · AMB BUS · LINES  | Estaciones y paradas por operador. Una parada que sirven los dos se dibuja como TMB y sigue visible con cualquiera de las dos pills. LINES oculta los trazados (metro y bus) y deja las paradas |

- Cerrar una pill cierra la ficha abierta de algo que deja de verse.
- La voz (`getAnalystRecords`) responde sobre lo que se ve.
- **Decisión del usuario:** las pills **solo filtran la red**, no los trenes en vivo de
  la capa Transit (que es de upstream).

### Reanálisis de datos (2026-10-13) — qué hay y qué queremos mostrar

Comprobado en vivo el 2026-10-13 (~19:00). "Ahora" = lo que ya se muestra.

| Fuente                                          | Dato                                                                                                                                      | Cobertura medida                                                   | Ahora                    | Dónde mostrarlo                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------ | -------------------------------------------------- |
| Renfe VP Cercanías                              | línea (`label`), andén, parada + estado (`stopRelation`)                                                                                  | 100 %                                                              | ✅ ficha                 | —                                                  |
| Renfe `trip_updates.pb` (Cercanías)             | retraso del viaje (s) y **hasta 13 paradas siguientes con hora prevista**                                                                 | 320/320 trenes casan por `tripId`; mediana +2 min, 125 con ≥ 5 min | ❌                       | ficha del tren; **panel de llegadas por estación** |
| Renfe `trip_updates_LD.pb`                      | retraso del viaje, 1–2 paradas siguientes                                                                                                 | 176/176; mediana +6 min, 96 con ≥ 5 min                            | ❌                       | ficha del tren                                     |
| Renfe `alerts.pb`                               | 69 avisos en texto (es), por `route_id` del GTFS (1.316 entidades de ruta, 24 de parada)                                                  | solo Cercanías                                                     | ❌                       | ficha de línea y de estación; ficha del tren       |
| Renfe GTFS estático (`routes.txt`, `trips.txt`) | **tipo de servicio** (AVE 33, MD 44, Alvia 20, Regional Exprés 28, Avant 11…), **destino**                                                | 100 % de los `tripId` en vivo están en el GTFS                     | ❌                       | ficha del tren (título)                            |
| FGC Geotren                                     | destino, origen, sentido, **próximas paradas (lista completa)**, en hora (bool), **ocupación por coche**, serie de unidad, `estacionat_a` | ocupación 52/67, estacionados 24/67, fuera de hora 4/67            | ❌ (solo línea y parada) | ficha del tren                                     |
| FGC `trip-updates-gtfs_realtime`                | hora prevista en cada parada restante (sin campo de retraso)                                                                              | 63/67 casan con Geotren por `id`                                   | ❌                       | ficha del tren; panel de llegadas por estación     |
| FGC `alerts-gtfs_realtime`                      | 331 avisos, casi todos por viaje ("Últim cotxe reservat escolar")                                                                         | por `tripId` + parada                                              | ❌                       | ficha del tren                                     |
| TMB `/v1/alerts/{metro,bus}/channels/WEB`       | avisos en ca/es/en con fechas y línea/estación/acceso/parada afectados                                                                    | metro 10, bus 43                                                   | ❌                       | ficha de estación/parada (Barcelona Arrivals)      |
| AMB `alerts.bin`                                | 115 avisos (ca/es): desvíos, paradas anuladas, por parada o línea                                                                         | —                                                                  | ❌                       | ficha de parada AMB                                |
| AMB TripUpdates                                 | llegadas por parada                                                                                                                       | —                                                                  | ✅ ficha de parada       | —                                                  |

**Trampas comprobadas:**

- **Destino de Renfe sin `stop_times`.** El `stop_times.txt` de Cercanías ocupa 247 MB
  descomprimido. No hace falta:
  - LD: los 10 primeros dígitos del `route_id` son los códigos de estación de origen y
    destino (3.000/3.000 coinciden con la primera y la última parada);
  - Cercanías: `route_long_name` es "Origen -Destino" (el separador es espacio + guion;
    "Aeropuerto-T4" lleva guion propio).
- **LD cambia a diario.** Sus `trip_id` llevan la fecha (`0414012026-10-13`), así que el
  GTFS se lee a diario **en el servidor**, como el de AMB; no se empaqueta.
  `trips.txt` de Cercanías ocupa 17,7 MB: hay que subir el tope por entrada del lector
  de zip (16 MB).
- Los retrasos de Renfe pueden ser grandes (hasta 90 min) y hay viajes del día anterior
  aún abiertos.
- Los avisos de Renfe no traen fecha de fin y algunos son de hace días: mostrar la de
  inicio.

### Fase 6 — Ficha del tren enriquecida (servidor + ficha)

**Objetivo.** Que la ficha de un tren diga qué tren es, adónde va, si va con retraso,
por dónde pasará y lo lleno que va. Todo se resuelve **en el servidor** y llega como
**campos genéricos opcionales** del registro normalizado (los feeds de upstream no
cambian):

| Campo            | Renfe Cercanías                 | Renfe AV/LD/MD                   | FGC                                  | En la ficha                            |
| ---------------- | ------------------------------- | -------------------------------- | ------------------------------------ | -------------------------------------- |
| `serviceName`    | línea (ya)                      | `route_short_name` (AVE, Alvia…) | línea (ya)                           | título: "🚆 AVE 03932"                 |
| `destination`    | `route_long_name` → destino     | `route_id` → código → nombre     | `desti` + diccionario                | "→ Barcelona-Sants"                    |
| `delaySec`       | `trip_updates`                  | `trip_updates_LD`                | — (`onTime`)                         | "+4 min" / "En hora"                   |
| `onTime`         | derivado de `delaySec`          | derivado                         | `en_hora`                            | ídem                                   |
| `nextStops[]`    | `trip_updates` (≤ 13, con hora) | 1–2, con hora                    | `properes_parades` + horas de FGC TU | "Próx.: Sants 19:04 · Clot 19:09 · +6" |
| `occupancyPct[]` | —                               | —                                | `ocupacio_*_percent`                 | "Ocupación: 7 % · 1 % · 1 % · 2 %"     |
| `vehicleType`    | —                               | —                                | `tipus_unitat`                       | "Unidad serie 113"                     |
| `parkedAt`       | —                               | —                                | `estacionat_a`                       | "Estacionado en Sarrià"                |

**Subfases:**

- **6a — FGC** (todo llega ya en Geotren, más el TU de FGC para las horas).
- **6b — Renfe**: un servicio diario en el servidor con `routes.txt` y `trips.txt` de los
  dos GTFS (tipo y destino), más los `trip_updates` de Renfe con la caché del proxy de
  Transit (15 s, mismo host). Enganche genérico del registro, como `stopNames`:
  `tripDetails` (estático) y `tripUpdatesUrl` (tiempo real).

**Validación.** Tests de `buildTransitSelectionCopy` con y sin cada campo, fixtures
mínimos hechos a mano, cobertura medida en vivo (% de trenes con cada campo) y
capturas de una ficha de cada operador.

**Hecho cuando** una ficha de FGC muestra destino, próximas paradas, puntualidad y
ocupación, y una de Renfe muestra tipo, destino, retraso y próximas paradas.

### Fase 7 — Paneles de llegadas en las estaciones (Rail network)

**Objetivo.** Pulsar una estación de Cercanías o FGC muestra los próximos trenes, como
la ficha de TMB: "C4 → Parla · 19:04 (+2) · andén 3".

- Se construye en el servidor a partir de los mismos TU de la Fase 6: Cercanías da hasta
  13 paradas por tren, así que cubre bien sus estaciones; FGC da todas las restantes.
- LD solo da 1–2 paradas por tren: en estaciones de AV/LD el panel lo dice ("solo los
  trenes que informan esta parada").
- Ruta `/api/transit/arrivals/<feed>/<stopId>` (sin llamadas nuevas al operador).

**Hecho cuando** Sants, Pl. Catalunya y Atocha muestran sus próximos trenes con retraso.

### Fase 8 — Incidencias

**Objetivo.** Avisos de servicio donde se consultan:

| Avisos                   | Se ligan a                           | Se muestran en                                              |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| Renfe (69)               | `route_id` del GTFS → línea; paradas | ficha de línea y de estación (Rail network), ficha del tren |
| FGC (331, por viaje)     | `tripId` + parada                    | ficha del tren                                              |
| TMB metro (10), bus (43) | línea, estación, acceso, parada      | ficha de estación/parada (Barcelona Arrivals)               |
| AMB (115)                | parada, línea                        | ficha de parada AMB                                         |

- Servidor: una caché por fuente (1–5 min), texto acotado, sin enlaces al navegador
  (patrón de #733).
- Posible pill nueva AVISOS (marcar en el mapa las estaciones y líneas con aviso).

**Hecho cuando** un aviso activo de cada operador aparece en su ficha.

### Fase 9 — (Opcional) Experimento: metro TMB "estimado" — `solo fork`

Necesita la Fase 4 (iMetro) y la geometría de tramos (`linies/metro/{l}/trams`, que la
5d dejó para aquí). Se interpola cada `codi_servei` entre estaciones a partir de sus
llegadas, sobre esos tramos.
Siempre etiquetado como _posición estimada a partir de predicciones_, con estilo propio,
y desactivable. Riesgos: saltos cuando cambia la predicción, ambigüedad del
`codi_servei` entre líneas, y lagunas en las terminales.

### Fase 10 — (Futuro) PR conjunto a upstream con las integraciones de España

Se abre solo cuando haya suficientes integraciones de datos de España terminadas en el fork.

**Candidatos:**

| Integración                                                                                             | ¿Apta para upstream?                                                                                              |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fases 1–3 y 5–8 (Renfe, enganches, FGC, red y estaciones sin TMB, pills, ficha, llegadas e incidencias) | ✅ sin clave, CC BY 4.0, con coordenadas reales                                                                   |
| Capas AEMET (`docs/plans/weather-data-integrations.md`)                                                 | ✅ probablemente: piden clave gratuita, como otras capas de upstream (TomTom, Mapillary). Revisar sus tokens `z*` |
| CCTV Bilbao y extras del pack de Cataluña                                                               | Revisar uno a uno (Andorra da 404)                                                                                |
| Fases 4 y 9 (TMB)                                                                                       | ❌ licencia ligada a la aplicación: se queda en el fork                                                           |

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
  **no trae `routeId`**. `trip-updates` (~23 KB, horas por parada) y `alerts` (~49 KB)
  sí son útiles para las Fases 6–8.
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

- Sin GTFS-RT ni posiciones de vehículos.
- Todo pide `app_id` + `app_key`.
- Licencia gratuita, pero ligada a la aplicación declarada; obliga a citar la fuente y la
  fecha. TMB puede cambiar la API o cortar la licencia sin aviso.

### AMB (ambmobilitat.cat, catálogo amb.cat) — revisado 2026-10-13

Buses metropolitanos **no TMB** (Baixbus, Moventis, Sagalés, Aerobús…). Todo sin clave y
comprobado en vivo:

| Dataset                                                | URL                                                                 | Qué da (hoy)                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GTFS-RT **TripUpdates** ("Servei GTFS Real time")      | `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin`      | 250 KB, cada ~30 s, ETag + Last-Modified. 854 viajes en 91 líneas, **todos** con `VehicleDescriptor` (id y número de coche) y horas absolutas de llegada a las próximas paradas. Los 854 `trip_id` existen en el GTFS estático. **Sin VehiclePositions** |
| GTFS-RT **Alerts**                                     | `https://www.ambmobilitat.cat/transit/alerts/alerts.bin`            | 134 KB, 114 avisos en catalán y castellano (desvíos, paradas cambiadas), con periodo activo                                                                                                                                                              |
| GTFS estático                                          | `https://www.ambmobilitat.cat/OpenData/google_transit.zip`          | 8,9 MB (60 MB descomprimido), diario. 140 rutas con color oficial, 4.970 paradas, `shapes.txt` (9,5 MB), `trip_headsign`. Vigencia corta (`feed_info`: 13–18 oct)                                                                                        |
| AMBici (bici eléctrica metropolitana)                  | `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/gbfs.json`      | GBFS 2.x, 237 estaciones, **CC0-1.0** en `system_information`                                                                                                                                                                                            |
| Bicing (Barcelona, no AMB, enlazado desde el catálogo) | `https://barcelona.publicbikesystem.net/customer/gbfs/v2/gbfs.json` | GBFS 2.3, 543 estaciones (~8.000 bicis). Sin licencia en el feed: **pendiente de verificar** antes de usarlo. El host ya entra en la lista blanca `*.publicbikesystem.net` de upstream                                                                   |

- **Licencia** de los feeds de bus: "Autorització segons Llei 37/2007" (condiciones de uso
  de amb.cat): reutilización libre citando a AMB y la fecha de la última actualización, sin
  alterar ni desvirtuar el contenido. No es CC BY: para la Fase 10, revisar si upstream la
  admite. Los servicios SOAP de AMB (`OpenData.aspx`, incidencias por parada) piden
  formulario: no los usamos.
- **Qué no hay:** posiciones de bus. Ni AMB ni TMB las publican.
- **iBus de TMB ya incluye líneas AMB** en las paradas de TMB (p. ej. L70/X70 en la 108),
  pero no cubre las paradas AMB fuera de la red TMB.
- **Encaje en las fases:**
  - **4c** (después de la 4b): llegadas a paradas AMB, sin clave, desde el TripUpdates,
    en el panel de la 4b.
  - **5:** paradas, trazados y colores de las 140 líneas AMB, con el mismo script.
  - **8:** las alertas AMB entran por el mismo camino que las de Renfe y FGC.
  - **9:** buses AMB "estimados" sobre `shapes.txt`, a partir del tramo entre la última
    parada y la próxima. Es mejor candidato que el metro de TMB: licencia abierta, sin
    clave, con id de vehículo real y todas las líneas.
  - **Bicis (4c):** AMBici (CC0) y, si se confirma la licencia, Bicing, como filas de la
    capa Bike Share de upstream (hoy solo tiene sistemas de EE. UU.). Candidato claro a la
    Fase 10.

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
