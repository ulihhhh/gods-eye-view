# Plan — Trenes de Suiza "estimados" en la capa Transit (`solo fork`)

Estado: **planificado, sin empezar**. Escrito el 2026-10-16 con datos medidos ese día.
Va **después** de terminar la hoja de ruta de España
(`docs/plans/transit-spain-renfe-fgc.md`, fases 7b en adelante). Es solo para el fork,
como TMB: Suiza no publica posiciones reales y el tiempo real pide clave, así que no
cumple las reglas de admisión de upstream (sin clave y con coordenadas reales). Más
adelante se verá si upstream acepta vehículos estimados.

## Cómo retomar

- **Antes de empezar:**
  1. Que la hoja de ruta de España esté cerrada, o al menos sus fases 7–8.
  2. Que el usuario tenga su clave de opentransportdata.swiss. Se saca en
     `api-manager.opentransportdata.swiss`: registro con email, crear una aplicación y
     suscribirla a "GTFS-RT". El registro lo hace el usuario; Claude no crea cuentas.
- **Relación con la Fase 9 de España** (metro TMB "estimado"): es la misma idea, un
  vehículo interpolado entre paradas a partir de horas previstas. El motor de
  interpolación se diseña **genérico** en la primera de las dos que se haga, y la otra
  lo reutiliza.
- **Entorno:** el de siempre. Node 24 de nvm; gates `npm test`, `npm run format:check`
  y `npm run check:boundaries`; los módulos nuevos van en
  `scripts/package-boundaries.json` y `scripts/format-scope.json`.

## 1. Qué publica Suiza (comprobado el 2026-10-16)

### Posiciones de vehículos: no hay

- opentransportdata.swiss (SBB / SKI+) lo dice literalmente: las Vehicle Positions "will
  not be published on the Open data platform mobility Switzerland" (cookbook de GTFS-RT).
- No hay feeds de posiciones de operadores locales (VBZ, BVB, TPG, Bernmobil), ni Swiss
  en Transitland.
- geOps sí tiene un WebSocket de posiciones, pero con clave, planes de pago para
  producción y también estimadas a partir del horario. Descartado.
- Referencia de lo que se quiere hacer: **transitflow.ch** (mayo de 2026) interpola
  cada viaje del GTFS a la posición esperada en el minuto actual, le suma los retrasos
  del GTFS-RT y lo avisa ("a dot's exact location is an estimate").

### Horario estático (GTFS): libre, sin clave

- **Permalink:**
  `https://data.opentransportdata.swiss/dataset/timetable-2026-gtfs2020/permalink`.
  Redirige dos veces, la última a una URL firmada de Cloudflare R2 que caduca en 60 s.
  - Para el año que viene: `timetable-2027-gtfs2020`. Hay que cambiarlo a mediados de
    diciembre, porque el feed cubre de 2025-12-14 a 2026-12-12.
  - La API CKAN (`/api/3/action/package_show`) da **403**: usar el permalink.
- **Cabeceras:** `ETag`, `Last-Modified` y **`Accept-Ranges`** (responde 206 a una
  petición `Range`). `feed_info.feed_version` = fecha de publicación (`20261014`).
- **Se regenera dos veces por semana**, lunes y jueves de 9 a 10. El GTFS-RT cambia a la
  versión nueva **a las 15:00 de ese día**. Entre versiones pueden cambiar `trip_id` y
  `service_id`.
- **Zip de 290 MB, 4,6 GB descomprimido:**

  | fichero              | descomprimido | comprimido |
  | -------------------- | ------------- | ---------- |
  | `stop_times.txt`     | 3,70 GB       | 200 MB     |
  | `trips.txt`          | 390 MB        | 52 MB      |
  | `calendar_dates.txt` | 294 MB        | 30 MB      |
  | `transfers.txt`      | 160 MB        | 5 MB       |
  | `stops.txt`          | 13,6 MB       | 3 MB       |
  | `calendar.txt`       | 5,5 MB        | 0,4 MB     |
  | `routes.txt`         | 0,2 MB        | —          |
  | `frequencies.txt`    | 0,1 MB        | —          |

  Leer solo los ficheros necesarios por rangos apenas ahorra (`transfers`, 5 MB). Se
  baja el zip entero, pero solo cuando cambia el `ETag`, es decir, dos veces por semana.

- **Sin `shapes.txt`**, a propósito: "we do not currently receive them from the
  supplying systems". Sugieren generarlo con pfaedle sobre OSM.
- **Formato:**
  - Todos los campos van entre comillas.
  - Hay BOM al principio de cada fichero.
  - `stop_times` = `trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type`.
  - `trip_id` del estilo `.ojp-91-10-A.1.TA.101.j26`.
  - `trips` trae `trip_headsign`, `trip_short_name` (número de tren), `original_trip_id`
    (`ch:1:sjyid:…`) y `hints`.
  - `stops` trae `parent_station`, `platform_code`, `didok` (número DiDok de la
    estación) y `stop_id` en forma `ch:1:sloid:3057:0:503972` (de andén).
  - Incluye estaciones de fuera (Praha hl. n., Figueras Vilafant): los trenes
    internacionales salen con sus paradas en el extranjero.
- **Calendario:** hay que aplicar `calendar` **y** `calendar_dates`. El viernes
  2026-10-16 había 7.909 servicios activos: `calendar_dates` añadía 199 y quitaba 34.009.
  Hay horas más allá de las 24:00 (la última llegada es a las **34:20**), así que el
  índice de "hoy" debe incluir también los servicios de ayer.

### Volumen de los trenes de hoy (medido en streaming, 22 s, ~100 MB de memoria)

- `route_type` de tren: 101 alta velocidad, 102 larga distancia, 103 interregional,
  105 nocturno, 106 regional, 107 turístico, 109 S-Bahn, 116 cremallera y 117 especial.
  Son 927 líneas.
- Fuera de la primera versión:
  - 700–715 bus (unas 3.700 líneas)
  - 900 tranvía (51)
  - 1000 barco (103)
  - 1300 teleférico (296)
  - 1400 funicular (53)
- **Viernes 2026-10-16:**

  | concepto                            | valor                        |
  | ----------------------------------- | ---------------------------- |
  | viajes del feed entero              | 2.596.233                    |
  | viajes de hoy (todos los modos)     | 219.377                      |
  | viajes de tren de hoy               | **20.170**                   |
  | filas de `stop_times` (feed entero) | 42.148.014                   |
  | filas de `stop_times` de tren hoy   | **207.345** (17 MB en crudo) |
  | paradas de tren usadas hoy          | 4.674                        |

  Reparto de los viajes de tren de hoy: 9.012 S-Bahn, 8.808 regional, 928 IR, 586 larga
  distancia, 382 cremallera, 348 alta velocidad.

- **Trenes circulando a la vez:**

  | hora  | trenes |
  | ----- | ------ |
  | 05:00 | 154    |
  | 07:30 | 1.077  |
  | 08:00 | 1.036  |
  | 12:00 | 847    |
  | 17:30 | 1.083  |
  | 22:00 | 577    |
  | 00:30 | 233    |

  Son un poco más que Renfe y FGC juntos en hora punta.

### Tiempo real (GTFS-RT TripUpdates): con clave

- `GET https://api.opentransportdata.swiss/la/gtfs-rt`, sin `/` final.
- **Requisitos de la petición:**
  - `Authorization: Bearer <clave>`
  - un `User-Agent` cualquiera
  - `Accept-Encoding: br, gzip, deflate`
  - **seguir redirecciones**: el gestor redirige por caché, y el servicio actual solo
    las sigue dentro del mismo origen, así que hay que revisarlo.
- **Límite:** "a maximum of two queries per minute", ventana deslizante. Si se supera,
  devuelve `{"error": "Rate limit exceeded"}`. Si se supera repetidamente, SBB puede
  pedir contrato de pago o bloquear la clave. Además, una clave revocada no se puede
  volver a crear para la misma API.
- **Caché del lado de SBB:** 30 s. Pedir cada 30 s está justo en el límite, así que
  **35–60 s** (`minIntervalMs`).
- **Qué trae:**
  - solo TripUpdates v1.0, con horizonte de 3 horas y todos los operadores con tiempo
    real;
  - el retraso con precisión de 0,1 min;
  - **solo se vigila la previsión de salida**: si cambia solo la llegada, no hay
    mensaje;
  - un viaje puntual trae retraso 0;
  - el `FeedVersion` de la cabecera dice con qué GTFS estático casa;
  - en festivos no hay actualizaciones.
- **Variante `?format=JSON`:** hasta ~11 MB, "not standardized", solo para pruebas.
- **Avisos:** van aparte en `https://api.opentransportdata.swiss/la/gtfs-sa` (GTFS-RT
  v2.0 Service Alerts), también con clave y también con límite de 2 por minuto.
- **Sin medir todavía** (hace falta la clave): tamaño del `.pb`, cuántos viajes trae y
  qué porcentaje de `trip_id` casan con el estático de hoy.

### Condiciones de uso (opentransportdata.swiss/en/terms-of-use)

- No hay licencia con nombre; son sus propias condiciones, con el texto en alemán como
  vinculante.
- **Se puede** procesar, analizar y publicar, también dentro de una aplicación y en
  forma procesada.
- **Cláusula 5.1:** "The URL opentransportdata.swiss must be cited as the source". Va en
  los créditos.
- **Cláusula 5.2:** "updated regularly and at the same frequency as the underlying raw
  data". Así que no se sirve un horario viejo: si falla la descarga de la versión nueva,
  se avisa.
- **Cláusula 5.3:** lo procesado se publica bajo el nombre del usuario de los datos.
  Encaja con "posición estimada por GEV".
- Los datos de fichero no piden registro; las APIs sí, y SBB puede retirar la clave si
  se incumple la cláusula 5. El mal uso se castiga con bloqueo.

### Geometría de la red: SBB `linie-mit-polygon`

- `https://data.sbb.ch/api/explore/v2.1/catalog/datasets/linie-mit-polygon/exports/geojson`:
  8,8 MB, 3.160 tramos `LineString` entre puntos de explotación.
- Campos: `linienr`, `liniename`, `bp_anfang`/`bp_ende` (abreviatura del punto de
  explotación, por ejemplo `AIG`), `km_agm_von`/`bis` y `spurweite` (N 2.246,
  M 854, S 44, sin dato 16).
- Incluye vía métrica que no es de SBB (Aigle – Le Sépey), pero **no está comprobado que
  cubra RhB, MGB, BLS o zb**.
- Licencia: `https://data.sbb.ch/page/licence` (y `https://data.sbb.ch/conditions`).
  **Leerla antes de usarla.** Publicador: SBB Infrastructure.
- **Pendiente para CH-3:** casar paradas GTFS (`didok`) con puntos de explotación
  (`bp_*`). SBB tiene un dataset de puntos de explotación ("Dienststellen") que debería
  cruzar DiDok con la abreviatura. Alternativa: pfaedle sobre OSM (ODbL, atribución a
  OSM).

## 2. Decisiones

- **`solo fork`**, con clave del usuario (BYOK) como TMB. La variable de entorno se
  pone desde el panel POWER UP, por ejemplo `OPENTRANSPORTDATA_CH_KEY` (el nombre se
  decide al implementar). La clave nunca llega al navegador.
- **Sin clave:** el horario estático es libre, así que se podrían mostrar trenes
  "según horario", sin retrasos. **Decisión pendiente para el usuario:**
  - (a) **recomendada:** sin clave, la fila no se ofrece, igual que TMB;
  - (b) mostrarlos "según horario" con otro aviso en la ficha.
- **Siempre etiquetado como estimado:**
  - icono o estilo propio (por ejemplo, contorno en vez de relleno);
  - la ficha dice "posición estimada (horario + retraso)";
  - las estadísticas lo cuentan aparte;
  - se puede desactivar.
- **Primera versión solo con tren** (`route_type` 101–117). Tranvías, barcos,
  funiculares y teleféricos van en una fase opcional.
- **Trenes internacionales:** se recortan al territorio suizo, o se dibujan solo
  mientras estén dentro del radio. Decidirlo en CH-1 viendo cómo queda.

## 3. Arquitectura propuesta (repasar al empezar contra el código de ese momento)

1. **Índice estático diario**, en el servidor:
   - `zipEntries.js` no sirve: lee cada fichero entero en memoria con un tope, y
     `stop_times` ocupa 3,7 GB.
   - Hace falta un lector **en streaming**: `DecompressionStream('deflate-raw')` sobre
     el cuerpo de cada fichero, partido en líneas y filtrado al vuelo (tren, servicios
     de hoy y de ayer).
   - Se queda en memoria algo compacto, por ejemplo con `Int32Array` de horas:
     - viaje → `{línea, número, destino, operador, modo, paradas[], horas[]}`
     - parada → `{nombre, lat, lon, estación padre}`
   - Del orden de 20.000 viajes y 207.000 paradas.
   - Se descarga solo si cambia el `ETag` (lunes y jueves) y se reconstruye cada día
     para el día de servicio.
   - **El día de publicación** hay que tener las dos versiones y elegir por el
     `FeedVersion` del TU, que cambia a las 15:00.
   - Mirar si el servidor ya tiene una carpeta de caché en disco, para no volver a bajar
     290 MB en cada reinicio.
2. **Tiempo real:** el TU cada 35–60 s se convierte en un mapa `tripId` → retraso por
   parada. Las cancelaciones (`schedule_relationship`) quitan el tren.
3. **Motor de posición** (genérico, compartido con la Fase 9 de TMB):
   - En el instante `t`, cada viaje activo está parado en una estación (entre llegada y
     salida previstas más el retraso) o entre dos paradas.
   - Entre paradas se interpola a lo largo de la geometría del tramo: línea recta en
     CH-1 y el trazado de SBB en CH-3.
   - El rumbo sale del tramo.
   - Se genera el registro normalizado de la capa (`{id, lat, lon, bearing, routeId,
tripId, label, stopId, status}`) con una marca `estimated: true`.
   - Se recalcula en cada consulta del navegador (caché de 15 s), y `movement` lo
     suaviza como con cualquier otro feed.
4. **Enganche en el registro:** el feed no tiene URL de posiciones.
   - **Opción A:** un `format` nuevo (`'ch-estimated'`) cuya `url` es el TU. Pero el
     decodificador de hoy es una función pura del cuerpo y aquí necesita el índice y la
     hora.
   - **Opción B, más limpia:** un enganche `estimate` en el registro, para que
     `transitService` llame a un generador en vez de hacer fetch y decodificar.
   - Decidirlo al empezar, viendo `transitService.js` / `transitProxy.js`.
5. **Ficha y paneles:**
   - La ficha dice, por ejemplo, `IC 1 12812 → St. Gallen · +3 min · posición
estimada`, con las próximas paradas sacadas del índice.
   - Los paneles de estación de la Fase 7 (`/api/transit/arrivals/<feed>/<stop>`) salen
     casi gratis del mismo índice.
6. **Créditos:**
   - "opentransportdata.swiss" (obligatorio), más "SBB" si se usa su geometría.
   - Fila en `DATA_SOURCES.md` marcada como solo fork, que explique que las posiciones
     son estimadas.

## 4. Fases

- **CH-0 — Preparación** (sin código):
  - el usuario consigue la clave;
  - leer la licencia de data.sbb.ch;
  - medir el TU: tamaño, número de viajes, cuántos casan con el estático de hoy y cuánto
    retraso trae;
  - comprobar que el servicio puede seguir la redirección del gestor de APIs.
- **CH-1 — Índice estático y trenes según horario** (línea recta entre paradas),
  detrás de la clave.
  - **Hecho cuando** sobre Zúrich HB se ven los S-Bahn moviéndose de acuerdo con el
    horario, y la ficha dice que son estimados.
- **CH-2 — Retrasos y cancelaciones del TU**, respetando el límite de 2 por minuto.
  - **Hecho cuando** un tren con retraso en el TU aparece desplazado lo que toca, y uno
    cancelado desaparece.
- **CH-3 — Sobre las vías:** se proyecta sobre `linie-mit-polygon` (o sobre pfaedle/OSM
  si SBB no cubre lo bastante). Es la fase más incierta, por el cruce entre paradas y
  puntos de explotación.
- **CH-4 — Ficha enriquecida y paneles de estación** (patrón de la Fase 7).
- **CH-5 — (Opcional):** avisos GTFS-SA (patrón de la Fase 8) y otros modos (barcos de
  los lagos, tranvías, funiculares y teleféricos).

## 5. Riesgos

- **Saltos** cuando cambia el retraso. Suavizarlos en el motor, sin teletransportar.
- **Solo hay previsión de salida:** las llegadas tardías sin cambio de salida no se ven.
- **Cambio de versión a las 15:00** los lunes y jueves: si el índice no casa con el
  `FeedVersion`, se pierden todos los retrasos.
- **El límite de 2 por minuto es por clave:** varias instancias del fork con la misma
  clave se lo reparten.
- **Festivos sin actualizaciones:** todo queda "según horario" ese día.
- **290 MB dos veces por semana** y ~20 s de CPU por reconstrucción: hacerlo en segundo
  plano, sin bloquear el servidor de desarrollo.

## 6. Cómo se midió (para repetirlo)

- `curl -sL -r 0-0 -D - <permalink>` da el tamaño (`Content-Range`) y el `ETag` sin
  bajar el zip.
- Con el zip en una carpeta aparte: `unzip -l` y `unzip -v` para los tamaños, y un
  script de Node que lee con `unzip -p` en streaming (`readline`). El script:
  1. lee `routes` y se queda con los `route_type` de tren;
  2. lee `calendar` y `calendar_dates` para los servicios del día;
  3. lee `trips` para los viajes de tren de hoy;
  4. recorre `stop_times` contando filas y la primera y última hora de cada viaje.
