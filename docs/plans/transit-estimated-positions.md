# Plan — Posiciones estimadas en la capa Transit: metro TMB y trenes suizos (`solo fork`)

Estado: **metro TMB hecho (2026-10-17)**: E-0, E-1, E-1b, E-2b y E-2 en `mi-main`. Los
trenes van sobre la vía, rellenos y del color de su línea. Siguiente: E-3 (Suiza, bloqueado
en la clave). Creado el 2026-10-17 juntando dos ideas que eran la misma:

- la antigua Fase 9 de `docs/plans/transit-spain-renfe-fgc.md` (metro TMB "estimado");
- el motor de posición de `docs/plans/switzerland-open-data.md` (trenes de Suiza).

Ninguna de las dos fuentes publica posiciones de vehículos. Solo hay horas previstas de
llegada (TMB) u horario más retrasos (Suiza). La posición se **calcula** interpolando
entre paradas, así que todo lo de este plan es `solo fork`: upstream exige coordenadas
reales.

## Cómo retomar

- **Orden recomendado** (revisado el 2026-10-17, ver sección 7):
  1. motor genérico + metro TMB, porque la clave de TMB ya funciona y las llegadas de
     iMetro ya están conectadas en el fork (Fase 4b de España);
  2. trenes suizos, en cuanto el usuario tenga la clave de opentransportdata.swiss
     (CH-0 en `docs/plans/switzerland-open-data.md`).
- **No hace falta esperar a la parte general de SBB.** Lo de Suiza que no usa el motor
  (índice del GTFS estático, paneles de estación) se puede hacer antes, después o en
  paralelo; no cambia el diseño del motor (sección 7).
- Lo que se haga primero diseña el motor **genérico**; lo segundo solo añade su fuente.
  La condición para que sea genérico de verdad es que su entrada sea una **línea de
  tiempo por vehículo** (sección 2), no las predicciones de TMB tal cual.
- **Entorno:** el de siempre. Node 24 de nvm; gates `npm test`, `npm run format:check`
  y `npm run check:boundaries`; los módulos nuevos van en
  `scripts/package-boundaries.json` y `scripts/format-scope.json`. Los textos de capas
  del fork se quedan en inglés vía `scripts/i18n-fork-untranslated.json`.

## 1. Reglas comunes

- **Siempre etiquetado como estimado:**
  - la ficha dice "posición estimada" y de qué sale (predicciones, o horario + retraso);
  - las estadísticas lo cuentan aparte;
  - se puede desactivar (pastilla ESTIMADOS).
- **El icono es el normal, relleno** (decisión del usuario del 2026-10-17, ver E-2b). El
  icono hueco de E-1 se quita del dibujo; la opción `estimated` de `transitIcon` puede
  quedarse para más adelante.
- **Si algún día se vuelve a dibujar hueco o transparente**, la estela tiene que
  empezar en la cola del tren, no en el centro del icono. Hoy la estela sale de la
  posición del vehículo, que es el centro del sprite. Con el relleno no se ve; con el
  hueco atraviesa el rectángulo.
- **Color de la línea cuando la fuente lo da:** el tren y su estela llevan el color de
  su línea (TMB `color_linia`). Sin color de línea, el del modo, como hasta ahora. Los
  estilos monocromo (NVG, FLIR, noir) mandan sobre el color de línea.
- **Nunca teletransportar:** cuando cambia una predicción, el vehículo se corrige
  suavemente.
- Los registros llevan `estimated: true`; el resto de la capa (selección, ficha, seguir
  con la cámara de la Fase 6c) funciona igual que con un feed real.

## 2. Motor de posición (genérico)

- **Entrada común: una línea de tiempo por vehículo.** Cada fuente la construye con su
  adaptador y el motor no sabe de dónde sale:
  `{id, routeId, tripId, label, stops: [{stopId, lat, lon, arr, dep}]}`, con horas
  absolutas en ms y las paradas en orden de marcha.
  - **Suiza:** horario del GTFS de ese viaje + retraso del TripUpdate en cada parada.
  - **TMB:** las llegadas previstas del tren a las estaciones que tiene delante
    (`arr = dep`), más una parada anterior sintética cuya salida es
    `llegada a la próxima − tiempo de recorrido del tramo` (sección 3).
- **Geometría, también común:** `segmentPath(desde, hasta)` devuelve la polilínea del
  tramo o `null`, y con `null` se usa la línea recta. TMB la saca de `trams`; Suiza, de
  `linie-mit-polygon` o de pfaedle.
- En el instante `t`, cada viaje activo está parado en una parada (entre llegada y salida
  previstas) o entre dos paradas.
- Entre paradas se interpola a lo largo de la geometría del tramo: línea recta en la
  primera versión, y el trazado real cuando lo haya.
- El rumbo sale del tramo.
- Salida: el registro normalizado de la capa (`{id, lat, lon, bearing, routeId, tripId,
label, stopId, status}`) con `estimated: true`.
- Se recalcula en cada consulta del navegador (caché de 15 s), y `movement` lo suaviza
  como con cualquier otro feed.
- **Enganche en el registro** (decidir al empezar, viendo `transitService.js` /
  `transitProxy.js`):
  - **Opción A:** un `format` nuevo cuya `url` son las predicciones. Pero el
    decodificador de hoy es una función pura del cuerpo, y aquí necesita el índice de
    paradas y la hora.
  - **Opción B, más limpia:** un enganche `estimate` en el registro, para que
    `transitService` llame a un generador en vez de hacer fetch y decodificar.
  - **Recomendación (vista el 2026-10-17): B.** En `src/sources/transitService.js` el
    fetch y `buildTransitSnapshot` van seguidos. Un feed con `estimate` saltaría solo el
    fetch y el decodificado, y seguiría por la misma cadena (`applyStopNames`, historial,
    `attachRecent`, caché). El generador lo inyecta el servidor
    (`createTransitService({estimators})` desde `server/providers/transit.js`), así que
    el registro solo lo nombra (`estimate: 'tmb-metro'`), no importa nada de `server/`,
    y la clave de TMB se queda en `server/providers/tmb.js`, que ya la maneja.
    `transitService.js` es de upstream: el cambio tiene que ser lo más pequeño posible
    para no generar conflictos en cada sync.

## 3. Fuente E1 — Metro TMB

- **Entrada:** iMetro (`/v1/itransit/metro/estacions?estacions=…`), ya usado por la capa
  `tmb-arrivals` (Fase 4b de España): próximos trenes por estación y vía, con
  `codi_servei` y `temps_arribada`. Cada `codi_servei` se interpola entre estaciones a
  partir de sus llegadas.
- **Geometría:** los tramos de metro (`linies/metro/{l}/trams`), que la Fase 5d de España
  dejó para aquí. Hasta tenerlos, línea recta entre estaciones.
- **Comprobado en vivo el 2026-10-17** (sábado, 12:12, con la clave del fork):
  - **Una sola llamada da toda la red.** Las 165 estaciones de las 11 líneas (L1–L5,
    L9N/S, L10N/S, L11, FM) en un solo `estacions=…` devuelven 96 KB en ~60 ms, con 88
    trenes. Con la caché de 15 s son 4 peticiones por minuto, vea quien vea el mapa.
  - **`codi_servei` identifica un tren concreto**, no un servicio genérico: el mismo
    código aparece en 6–9 estaciones seguidas con horas de llegada crecientes, es decir,
    la línea de tiempo del tren hacia delante. La clave del tren es
    `línea | vía (codi_via) | codi_servei`. En la terminal el mismo código pasa de una
    vía a la otra, y hay que partirlo por vía.
  - **El tiempo de recorrido sale de la propia respuesta:** la diferencia entre las
    llegadas de un tren a dos estaciones seguidas. En una sola respuesta hay 232 tramos
    medidos (mediana 88 s, p10 73 s, p90 109 s). Así se sabe por dónde va un tren en su
    tramo actual sin horario.
  - **Estabilidad:** entre dos respuestas separadas 69 s, la llegada prevista del mismo
    tren a la misma estación se movió una mediana de +7 s (p95 +38 s). Hay que
    suavizarla, pero no es caótica. Hubo un caso de +873 s: posible tren retenido o
    código reutilizado. Hay que filtrarlo.
  - **Tramos (`/transit/linies/metro/{l}/trams`) disponibles:** para L3 son 27 tramos
    `MultiLineString` con `CODI_ESTACIO_INI` / `CODI_ESTACIO_FI` y `LONGITUD`, así que
    E-2 sirve tal cual para `segmentPath`.
- **Riesgos:**
  - saltos cuando cambia la predicción (medido arriba: suavizar ~40 s);
  - lagunas en las terminales: el tren que espera en la terminal solo tiene llegadas
    en la otra vía;
  - límite de peticiones de la clave de TMB: resuelto con la llamada única de toda la
    red.

## 4. Fuente E2 — Trenes suizos

- Datos, volumen, condiciones de uso y fases (CH-0 … CH-5) en
  `docs/plans/switzerland-open-data.md`: horario GTFS sin clave + GTFS-RT TripUpdates con
  clave (2 peticiones por minuto).
- Lo que este plan les da: el motor (sección 2) y las reglas de etiquetado (sección 1).
  CH-1 (trenes según horario) es la primera fase suiza que lo usa.

## 5. Candidato — buses AMB (sin decidir)

Visto en el repaso de AMB del 2026-10-13 (sección 4 del plan de España): el TripUpdates
de AMB es abierto, sin clave, con id de vehículo real, todas las líneas y `shapes.txt`
en el GTFS estático. Se podría estimar cada bus en el tramo entre su última parada y la
próxima. Es mejor fuente que el metro de TMB, pero no está pedido: decidir si entra
cuando el motor ya funcione.

## 6. Fases

- **E-0 — Hecho (2026-10-17):** opción B.
  - El registro nombra el estimador (`estimate: 'tmb-metro'`).
  - `createTransitService({estimators})` lo llama en vez de hacer fetch, y sigue por
    `snapshotFromDecoded` (separado de `buildTransitSnapshot` en `transitProxy.js`).
  - Sin estimador disponible (sin clave, otro servidor o
    `TRANSIT_ESTIMATED_POSITIONS=off`), la fila no sale en el catálogo y su ruta da 404.
- **E-1 — Hecho (2026-10-17):** motor + metro TMB en línea recta, detrás de la clave.
  - **Módulos:**
    - `src/data/estimatedPositions.js`: motor, suavizado y registros;
    - `src/data/tmbMetroTimelines.js`: iMetro → líneas de tiempo;
    - `createTmbMetroEstimator` en `server/providers/tmb.js`;
    - fila `tmb-metro-estimated` en `src/data/transitFeedsEstimated.js`.
  - **En la capa:**
    - icono hueco (contorno del color del modo);
    - la ficha dice "Estimated position · from arrival predictions", "Estimated N s
      ago" y "Estimated next stop …", y no presenta el rumbo como reportado;
    - `getStats().estimated` cuenta los estimados aparte.
  - **Comprobado en vivo:** 72 trenes (L1 18, L2 9, L3 12, L4 14, L5 18, L11 1). En
    15 s se mueven una mediana de 135 m y como mucho 186 m, sin saltos. Una petición a
    iMetro cada 15 s para toda la red.
  - **iMetro no predice L9, L10 ni el funicular** (listas `propers_trens` vacías en
    todas las respuestas del 2026-10-17): esas líneas no se dibujan.
  - **Pendientes de E-1 — resueltos (2026-10-17):**
    - **Retraso de presentación:** la capa reproduce cada feed con un retraso
      aprendido de cuánto tardan los informes (mínimo 25 s; con las semillas del
      historial salían 47 s). No se puede quitar: hace falta tener ya el siguiente
      punto (un sondeo de 15 s más hasta 15 s de caché del servidor). Pero un
      estimado sí se puede calcular por adelantado:
      - la fila declara `estimateLeadMs: 35_000`;
      - el servidor coloca cada tren 35 s por delante del momento en que estima
        (`estimate({now, leadMs})` → `estimateVehicles(..., t + lead, {madeAt})`); el
        registro guarda la hora en que se hizo y `estimateLeadS: 35`;
      - la capa fija el retraso de ese feed en esos mismos 35 s
        (`transitFeedTiming` → `fixedDelayMs`; no se reaprende ni se siembra), y la
        ficha solo cuenta lo que pase de ahí.
      - **Comprobado en vivo:** 72 trenes, 60 s muestreados cada segundo: siempre
        reproduciendo (nunca parados esperando punto), retraso exacto de 35 s, ficha
        "Estimado hace 7 s · se muestra con 0 s de retraso", velocidad máxima entre
        muestras 28 m/s (sin saltos).
    - **Interruptor en la interfaz:** pastilla ESTIMADOS en la fila de Transporte
      público, visible solo cuando un feed estimado cubre la vista. Apagada, la capa
      deja de sondear esos feeds y quita sus vehículos al momento. Es una opción de
      la capa `transit` en el estado de capas (`lo=j.e.0`; la capa pasa de
      `enabled-only` a `enabled+options`, mismo token `j`, sin token nuevo), así que
      se guarda y viaja en el enlace. Comprobado en vivo: apagar, recargar y volver a
      encender.
    - **Los tres 404:** eran `GET /api/google/tiles-token`, uno por cada carga de la
      página. Es la consulta de upstream que pregunta al servidor si ofrece
      tokens de Google; el servidor de desarrollo no los ofrece y el 404 es la
      respuesta esperada (`src/maps/googleTokens.js`: "any other answer means it
      does not"). No hay nada que arreglar en el fork.
    - **Encontrado de paso (pendiente):** sin clave de TMB o con
      `TRANSIT_ESTIMATED_POSITIONS=off`, la capa sigue sondeando
      `tmb-metro-estimated` (lee el registro empaquetado, no el catálogo
      `/api/transit/feeds`), recibe un 404 cada 15 s y la fila dice que el feed no
      está disponible. Arreglo propuesto: que la capa salte las filas `estimate` que
      el catálogo del servidor no ofrece.
- **Repaso del 2026-10-17 tras E-1:** las posiciones concuerdan con las llegadas (los
  trenes llegan a su hora). Lo que queda para el metro de Barcelona, en el orden
  recomendado:
- **E-1b — Hecho (2026-10-17). Bug: la capa sondeaba la fila estimada aunque el servidor no la ofreciera.** Sin
  clave o con `TRANSIT_ESTIMATED_POSITIONS=off`, 404 cada 15 s, la fila dice "no
  disponible" y la pastilla sigue visible. Arreglo: que la capa se salte las filas
  `estimate` que no estén en `/api/transit/feeds`. Es pequeño y va primero.
  - **Hecho así:** `src/layers/transit/viewport.js` lee `/api/transit/feeds` cuando una
    fila estimada cubre la vista. Lo vuelve a leer cada 5 minutos, o al minuto si
    falló. Solo sondea las filas estimadas que el catálogo lista, y la pastilla solo
    sale para esas. Comprobado en vivo con clave: se lee el catálogo una vez y luego
    la fila responde 200. El caso sin clave está cubierto en
    `src/layers/transit/offeredEstimates.test.mjs`, no probado en vivo.
- **E-2b — Hecho (2026-10-17). Icono relleno y color de línea** (puntos 2 y 3 del
  usuario):
  - **Relleno:** `applySpriteStyle` (`src/layers/transit/rendering.js`) deja de pasar
    `estimated` a `transitIcon`.
  - **Color de línea:** hoy el sprite y la estela se pintan por modo
    (`MODE_CESIUM_COLORS` en `rendering.js`, `MODE_COLOR` en `trails.js`). Hace falta
    un campo genérico del registro de vehículo (por ejemplo `routeColor`, hex de 6
    cifras validado). Lo rellenan:
    - el adaptador de TMB, con `color_linia` de iMetro o, si falta, `COLOR_LINIA` del
      catálogo;
    - la capa, que lo usa en el sprite y en la estela salvo con estilo monocromo.
  - Sirve también para cualquier feed real que traiga color de línea; los demás no
    cambian.
  - **Hecho cuando** sobre Barcelona cada tren se ve relleno y del color de su línea
    (L1 roja, L2 lila, L3 verde, L4 amarilla, L5 azul, L11 verde claro), y la estela
    también.
  - **Hecho así:**
    - el registro lleva `routeColor` (`color_linia` de iMetro);
    - `transitRouteColorCss` (en `policy.js`) lo usan el sprite, la estela del tren
      seleccionado y el acento de la ficha;
    - los estilos NVG/FLIR/noir y CRT siguen mandando;
    - el icono es el relleno.
  - **Comprobado en vivo:** L1 `CE1126`, L2 `93248F`, L3 `1EB53A`, L4 `F7A30E`, L5
    `005A97`, L11 `89B94C`. Los lila claro que se ven cerca son trenes de Rodalies (color
    del modo tren), no metros.
- **E-2 — Hecho (2026-10-17). Seguir el trazado de la vía** (punto 1 del usuario). Tiene dos mitades, y
  hacen falta las dos:
  - **Servidor:** que cada posición estimada caiga sobre la vía. El motor ya acepta
    `segmentPath(desde, hasta)`. Opciones:
    - los tramos `trams` (`/transit/linies/metro/trams`: 181 tramos de estación a
      estación, con `CODI_ESTACIO_INI` / `CODI_ESTACIO_FI`), casados por código de
      estación;
    - o la geometría de línea que el catálogo TMB ya descarga
      (`/transit/linies/metro`, en `/api/tmb/stations` → `lines`), cortada entre las
      dos estaciones con `pathBetween` de `src/data/trackFollow.js`, el mismo que usa
      la capa. Así no hace falta otra descarga.
    - Decidirlo al empezar, midiendo cuántos tramos casan con cada opción.
  - **Navegador:** entre dos posiciones (cada 15 s) la capa dibuja una cuerda recta,
    salvo que el feed tenga `trackGeometry()` (`src/layers/transit/trails.js`, como
    Renfe y FGC). La fila estimada necesita su propio `trackGeometry`, que lea las
    líneas de metro de `/api/tmb/stations`. La geometría de TMB no se empaqueta, por la
    licencia. Cada línea va con `routes: [nombre]`, para que un tren de la L1 no se
    pegue a la vía de la L3.
  - **Hecho cuando** sobre Barcelona los trenes van por las curvas de la vía, también
    entre dos sondeos, y la estela dibuja el trazado.
  - **Decisión: geometría de línea + `pathBetween`.** Medido con los datos del
    2026-10-17:
    - las dos opciones casan los 122 pares de estaciones de L1–L5 y L11;
    - la longitud por la línea coincide con el `LONGITUD` de los `trams` (mediana
      1,000, p10 0,998, p90 1,001);
    - la geometría de línea tiene 720 vértices, frente a 3.888 de los `trams`;
    - no necesita otra descarga, y es la misma geometría que sigue la capa.
  - **Servidor:**
    - el estimador descarga `/transit/linies/metro` (`NOM_LINIA`, `GEOMETRY`) junto a
      las estaciones, una vez al día;
    - `tmbMetroSegmentPaths` (`src/data/tmbMetroTimelines.js`) da al motor el tramo de
      la línea del tren, muestreado cada 20 m y guardado en caché por par;
    - el motor pasa ahora la línea de tiempo a `segmentPath`;
    - si la geometría falla, los trenes van en línea recta, y se reintenta a los 10
      minutos.
  - **Navegador:**
    - la fila tiene `trackGeometry: tmbMetroTrackLines`, que lee
      `/api/tmb/metro-lines`;
    - es una ruta nueva que devuelve solo `{lines: [{name, paths}]}` del catálogo de
      estaciones;
    - cada línea va con `routes: [nombre]`.
  - **Comprobado en vivo:** los 74 trenes quedan a 3 m o menos de la vía de su línea
    (mediana 0 m, p90 2 m), y la capa carga `/api/tmb/metro-lines` (200) sin errores.
    **No comprobado a ojo:** con el panel del navegador oculto, la página iba en
    segundo plano y las capturas no se refrescaban, así que no se vio un tren
    recorriendo una curva.
- **E-3 —** Trenes suizos: CH-1 en adelante del plan de Suiza, sobre el mismo motor.
- **E-4 — (Opcional)** buses AMB, si se decide (sección 5).

## 7. Repaso del 2026-10-17: acceso, motor compartido y orden

- **Acceso:**
  - **TMB:** la clave del fork funciona y iMetro da lo que hace falta (sección 3).
    E-1 no tiene ningún bloqueo.
  - **SBB:** no hay clave de opentransportdata.swiss en `.env`. El horario GTFS no la
    necesita, así que con él se puede validar el motor (CH-1, trenes según horario). La
    clave solo hace falta para los retrasos (CH-2) y para medir el TripUpdate (CH-0).
- **¿Se puede compartir el motor?** Sí, si se comparte a partir de la línea de tiempo
  (sección 2):
  - Común: interpolación sobre la polilínea, rumbo, suavizado sin teletransportes,
    etiquetado como estimado, el enganche `estimate` y la ficha.
  - Propio de cada fuente: el adaptador que construye la línea de tiempo y la geometría
    de los tramos.
  - TMB es un caso degenerado (solo paradas futuras y una salida sintética); Suiza, el
    caso completo (horario entero más retraso). Si el motor acepta el caso completo,
    también acepta el degenerado. Al revés no, y por eso se fija ya la interfaz, aunque
    se empiece por TMB.
- **¿Merece la pena hacer antes la parte general de SBB?** No:
  - La parte general de Suiza (índice en streaming del zip de 290 MB, calendarios,
    cambio de versión de los lunes y jueves, paneles de estación) es grande, solo la
    usa Suiza y no cambia el motor. Lo único que el motor necesita saber de Suiza es la
    forma de sus datos, y eso ya está medido en `docs/plans/switzerland-open-data.md`.
  - Hacerla antes retrasaría la única fuente que está lista (TMB) y no evitaría ningún
    rediseño.
  - Lo que sí conviene: en E-1, un test del motor con una línea de tiempo con forma
    suiza (horario completo, `arr ≠ dep`, horas más allá de las 24:00) para confirmar
    que la interfaz aguanta sin tener el índice. **Hecho:** está en
    `src/data/estimatedPositions.test.mjs`.
