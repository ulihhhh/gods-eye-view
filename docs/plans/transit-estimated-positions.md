# Plan — Posiciones estimadas en la capa Transit: metro TMB y trenes suizos (`solo fork`)

Estado: **planificado, sin empezar**. Creado el 2026-10-17 juntando dos ideas que eran la
misma:

- la antigua Fase 9 de `docs/plans/transit-spain-renfe-fgc.md` (metro TMB "estimado");
- el motor de posición de `docs/plans/switzerland-open-data.md` (trenes de Suiza).

Ninguna de las dos fuentes publica posiciones de vehículos. Solo hay horas previstas de
llegada (TMB) u horario más retrasos (Suiza). La posición se **calcula** interpolando
entre paradas, así que todo lo de este plan es `solo fork`: upstream exige coordenadas
reales.

## Cómo retomar

- **Orden recomendado:**
  1. motor genérico + metro TMB, porque la clave de TMB ya funciona y las llegadas de
     iMetro ya están conectadas en el fork (Fase 4b de España);
  2. trenes suizos, en cuanto el usuario tenga la clave de opentransportdata.swiss
     (CH-0 en `docs/plans/switzerland-open-data.md`).
- Lo que se haga primero diseña el motor **genérico**; lo segundo solo añade su fuente.
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

## 3. Fuente E1 — Metro TMB

- **Entrada:** iMetro (`/v1/itransit/metro/estacions?estacions=…`), ya usado por la capa
  `tmb-arrivals` (Fase 4b de España): próximos trenes por estación y vía, con
  `codi_servei` y `temps_arribada`. Cada `codi_servei` se interpola entre estaciones a
  partir de sus llegadas.
- **Geometría:** los tramos de metro (`linies/metro/{l}/trams`), que la Fase 5d de España
  dejó para aquí. Hasta tenerlos, línea recta entre estaciones.
- **Riesgos:**
  - saltos cuando cambia la predicción;
  - `codi_servei` ambiguo entre líneas;
  - lagunas en las terminales;
  - límite de peticiones de la clave de TMB: hay que pedir todas las estaciones de una
    línea en una llamada.

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

- **E-0 —** Decidir el enganche (A o B) contra el código de ese momento.
- **E-1 —** Motor + metro TMB en línea recta, detrás de la clave de TMB.
  - **Hecho cuando** sobre Barcelona se ven los trenes de metro moviéndose entre
    estaciones de acuerdo con iMetro, y la ficha dice que son estimados.
- **E-2 —** Metro TMB sobre los tramos (`trams`), servidos por el servidor como el resto
  de la geometría de TMB (licencia ligada a la aplicación).
- **E-3 —** Trenes suizos: CH-1 en adelante del plan de Suiza, sobre el mismo motor.
- **E-4 — (Opcional)** buses AMB, si se decide (sección 5).
