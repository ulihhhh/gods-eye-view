# Plan — Posiciones estimadas en la capa Transit: metro TMB y trenes suizos (`solo fork`)

Estado: **E-0 y E-1 hechos (2026-10-17)**: motor genérico + metro TMB en línea recta, en
`mi-main`. Siguiente: E-2 (tramos) o los pendientes de E-1 (sección 6). Creado el
2026-10-17 juntando dos ideas que eran la misma:

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
  - icono o estilo propio (por ejemplo, contorno en vez de relleno);
  - la ficha dice "posición estimada" y de qué sale (predicciones, o horario + retraso);
  - las estadísticas lo cuentan aparte;
  - se puede desactivar.
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
  - **Pendientes de E-1:**
    - **Retraso de presentación:** la capa reproduce los vehículos con retraso (la
      ficha decía "se muestra con 47 s de retraso"). Para un estimado, ese retraso no
      aporta nada. Se podría calcular la posición en `t + retraso`, o decirle a la
      capa que no lo aplique.
    - **Desactivar desde la interfaz:** hoy solo con `TRANSIT_ESTIMATED_POSITIONS=off`
      o quitando la clave. Falta un interruptor en la capa.
    - **Revisar los 404 de la consola:** se vieron tres en la prueba en el navegador,
      sin identificar. Todas las rutas de Transit y de TMB respondían 200.
- **E-2 —** Metro TMB sobre los tramos (`trams`), servidos por el servidor como el resto
  de la geometría de TMB (licencia ligada a la aplicación).
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
