# Backlog

Registro centralizado de bugs pendientes y propuestas de mejora, para no dejarlos sueltos en el
historial de conversación con Claude. Complementa a `CLAUDE.md` (arquitectura/convenciones
estables) y `CHANGELOG.md` (qué cambió en cada versión) — este fichero es "qué falta".

**Reglas:**
- Al detectar un bug que no se arregla en el momento, o surgir una idea de mejora, se anota aquí
  con fecha y estado.
- Al resolverse, se marca como **Resuelto** (fecha + commit) y se mueve a la sección de
  "Resueltos" — nunca se borra sin más, sirve de histórico.
- Este fichero sigue la misma disciplina de commit/push que el resto del repo: se actualiza en el
  mismo commit que cierra el bug o introduce la mejora (o en un commit propio si solo se anota).

---

## Bugs pendientes

### Bug #1: un fallo de conexión con el móvil se presenta como resultado válido

- **Estado:** pendiente de resolver.
- **Detectado:** 2026-07-18, diagnosticado con `logs/app.log` real (ver commit `5e24930`, que
  introdujo ese logging).

Cuando `GET /moneyBook/getDataByPeriod` falla (`ConnectionError` — en el caso real que lo destapó,
porque Money Manager se cerró en el móvil sin querer, lo que probablemente mató el servidor PC
Manager en segundo plano), `analyze_excel()` en `app.py` sigue adelante con `real_transactions=[]`
en silencio. El usuario ve "N nuevos" en la UI sin saber que en realidad no hubo conexión real con
el móvil — parece que no hay ningún movimiento duplicado, cuando en realidad no se pudo comprobar.

Pendiente:
- El backend no debe tratar un fallo de conexión como "cero transacciones" válidas — debe
  devolver un error explícito y distinguible (p. ej. un campo `mm_connection_error: true` en la
  respuesta de `/api/analyze-excel`, o un código de estado HTTP distinto de 200).
- Añadir un aviso **visible y persistente** en la interfaz cuando se pierde la conexión con el
  móvil — no solo al fallar el análisis de un Excel puntual — para que el usuario lo note en el
  momento y pueda reabrir Money Manager si hace falta.
  - Ya existe `updateConnectionStatus()` / `#connectionStatus` en `static/script.js`, pero **solo
    se llama desde `loadData()`** (carga inicial/periódica) — no se dispara si un proxy individual
    falla a mitad de sesión (p. ej. durante `/api/analyze-excel` o `/api/budget-hierarchy`).
    Probablemente sea más sencillo extender ese indicador existente para que también reaccione a
    fallos de proxy a mitad de sesión, en vez de crear un aviso nuevo desde cero.

### Bug #2: categoría y subcategoría no se guardan al crear una transacción desde "Pre-rellenar y Añadir"

- **Estado:** pendiente — causa sin confirmar, no arreglar a ciegas.
- **Detectado:** 2026-07-18.

Al crear una transacción a través del flujo de conciliación (botón "📥 Pre-rellenar y Añadir" sobre
un movimiento nuevo del Excel), el resto de campos se guardan correctamente pero `mbCategory` y
`subCategory` no.

Hipótesis sin confirmar: relacionado con la inconsistencia ya documentada en `CLAUDE.md` (sección
"La API real del móvil") entre el `inOutType`/`inOutCode` que `static/script.js:submitTransaction`
envía al crear/editar, y lo que el propio JS del móvil (`reference/moneybook.js`) sugiere que
espera realmente el servidor PC Manager. Pendiente de instrumentar (log del payload real enviado a
`/moneyBook/create` y de la respuesta) antes de tocar código a ciegas.

---

## Propuestas de mejora pendientes

### Propuesta #3: soporte CSV y subida múltiple con etiqueta por fichero

- **Estado:** en progreso desde 2026-07-18.
- **Anotado:** 2026-07-18.

Dos ampliaciones a la conciliación bancaria:
- Soporte para extractos en CSV (empezando por Revolut, `samples/revolut.csv`), reutilizando la
  misma tubería de detección de cabecera + mapeo de columnas por alias de
  `backend/bank_excel_parser.py` (Propuesta #1) — solo cambia cómo se lee el fichero en bruto
  según la extensión, no la lógica de detección.
- Subida de varios ficheros a la vez (Excel y/o CSV mezclados), cada uno con una etiqueta de
  origen editable (p. ej. "Revolut", "Cuenta Sabadell") para poder ver movimientos de varias
  cuentas/bancos a la vez pero distinguidos. Un solo `getDataByPeriod` con el rango combinado de
  todos los ficheros de la tanda, en vez de una llamada al móvil por fichero.

Caso borde identificado por el usuario, no resuelto en esta propuesta: si el mismo movimiento
aparece en dos ficheros distintos a la vez (p. ej. una transferencia entre dos cuentas propias,
visible en ambos extractos), cada fichero se concilia contra Money Manager por separado sin saber
del otro — posible duplicado de "nuevo movimiento" entre ficheros. Pendiente de decidir si merece
la pena resolverlo y cómo.

### Propuesta #2: distribución a amigos con un clic y auto-actualización

- **Estado:** por diseñar — no implementar todavía, solo anotado.
- **Anotado:** 2026-07-18.

Idea: que otros usuarios de Money Manager puedan ejecutar este dashboard en su propio PC/WiFi/
móvil (misma arquitectura de siempre — cada uno con su propia instancia local, no un servicio
centralizado), pero reciban las mejoras del proyecto sin tener que reinstalar nada a mano.

Enfoque propuesto: el lanzador (`launch.py`) hace un `git pull` (o equivalente) contra el repo
antes de arrancar Flask cada vez.

Prerrequisitos identificados antes de poder implementarlo:
- Sacar `config.json` del control de versiones (dejar solo una plantilla
  `config.example.json`), para que un `git pull` no pise la IP/puerto personal de cada usuario.
  Esto cambia la decisión actual documentada en `CLAUDE.md` (`config.json` versionado por
  considerarse no sensible) — revisar esa sección si se implementa.
- Decidir si el repo pasa a público, o si se gestiona con colaboradores privados en GitHub
  (actualmente es privado, un solo usuario).
- Definir qué pasa si el `git pull` falla (sin conexión a internet, conflictos locales) — el
  lanzador no debería bloquear el arranque de la app por esto.

---

## Resueltos

### Propuesta #1: generalizar el parseo de Excel para distintos bancos

- **Resuelto:** 2026-07-18, versión `0.3.0.9`.
- **Anotado:** 2026-07-18.

Implementado `backend/bank_excel_parser.py::parse_bank_excel()`: detecta la fila de cabecera real
sin posición fija, mapea columnas por alias exacto normalizado (no por posición — distingue
`"Fecha"` de `"Fecha valor"`, ver detalle en `CLAUDE.md`, sección "Parseo de extractos bancarios"),
combina cargo/abono en un único importe con signo si el banco los separa, y lanza
`BankExcelFormatError` (→ HTTP 400 con mensaje claro) si no reconoce la estructura en vez de
adivinar. `/api/analyze-excel` en `app.py` reescrito para usarlo — eliminada la asunción posicional
fija (`base_cols`) que solo funcionaba por casualidad con el formato de Cajasur.

Verificado contra los 6 extractos reales de `samples/`: Cajasur (`ejemplo_cajasur.xls`,
`casa_julio_250626-180726.xls`), BBVA (`BBVA.xlsx`), EVO cuenta (`EVO_CC.xlsx`), EVO tarjeta
(`EVO_tarjeta.xls`) y Sabadell (`sabadell.xls`) — cabecera y columnas detectadas correctamente en
los 6, end-to-end a través de `/api/analyze-excel` (Flask test client). El caso cargo/abono
separado solo se verificó con un test sintético — ningún banco de `samples/` lo usa realmente;
si aparece uno real, confirmar que el signo resultante es el esperado.
