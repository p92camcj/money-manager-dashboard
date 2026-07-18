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

### Propuesta #4: matching no comparte estado entre ficheros de la misma tanda

- **Estado:** resuelto PARCIALMENTE — solo cuando el usuario asocia una cuenta de Money Manager a
  cada fichero (Propuesta #5). Sigue sin resolver cuando ningún fichero de la tanda tiene cuenta
  asociada.
- **Detectado:** 2026-07-18, durante la implementación de subida múltiple (Propuesta #3).

Al subir varios ficheros a la vez, cada uno se concilia contra Money Manager por separado
(`match_bank_transactions()` se llama una vez por fichero, cada una con su propio estado interno de
"ya emparejado"). Si el mismo movimiento real aparece en dos ficheros distintos a la vez — p. ej.
una transferencia entre dos cuentas propias del usuario, visible tanto en el extracto del banco
origen como en el del banco destino — cada fichero podría proponerlo como "nuevo movimiento" sin
saber que el otro fichero ya lo vio.

**Caso de transferencias resuelto en Propuesta #5** (2026-07-18): cuando cada fichero tiene su
cuenta asociada, `match_bank_transactions()` reconoce que ambas líneas (la negativa del banco
origen, la positiva del banco destino) corresponden a los dos lados de la MISMA transacción de
Money Manager y las resuelve como `exact_match`/`probable_match` en vez de "nuevo" — ver
`CLAUDE.md`, sección "Matching acotado por cuenta y transferencias entre bancos".

**Sigue pendiente**: sin cuenta asociada (uso mínimo del selector, o cualquier otro tipo de
movimiento duplicado entre ficheros que no sea una transferencia con cuentas asociadas), la
limitación original persiste tal cual estaba documentada.

---

## Resueltos

### Propuesta #2: distribución a amigos con un clic y auto-actualización

- **Resuelto:** 2026-07-18, versión `0.7.0.17`. Commits: `3a97788` (marcado en progreso),
  `d7eb8f6` (Bloque 1: config.json fuera de VCS), `9b255df` (Bloque 2: auto-actualización en
  launch.py), `975a588` (Bloque 3: README.md).
- **Anotado:** 2026-07-18.

Idea: que otros usuarios de Money Manager puedan ejecutar este dashboard en su propio PC/WiFi/
móvil (misma arquitectura de siempre — cada uno con su propia instancia local, no un servicio
centralizado), pero reciban las mejoras del proyecto sin tener que reinstalar nada a mano.

**Auditoría de seguridad del historial completo de git, antes de tocar la visibilidad**: único
hallazgo, la IP de WiFi local (`192.168.5.248:8888`) en `config.json`, presente desde el primer
commit del repo (`3502ecf`) y ya subida al remoto (repo privado en ese momento). Sin rastro de
`samples/`, `data/`, `.env`, tokens ni credenciales en ningún commit de todo el historial (se
listaron todos los ficheros que han existido alguna vez con `git log --all --diff-filter=A`, y se
buscaron patrones de IP/secreto en todos los diffs). Decisión tomada con el usuario: no reescribir
el historial con `git filter-repo` — es una IP de LAN no accesible desde fuera de la propia WiFi,
riesgo bajo — y en su lugar dejar de rastrear `config.json` a partir de ahora. Repo cambiado a
público en GitHub tras esta auditoría.

**Bloque 1 — config.json fuera de VCS**: añadido a `.gitignore`, `git rm --cached` (el fichero
local del usuario no se toca), nuevo `config.example.json` como plantilla. `get_config()` en
`app.py` crea `config.json` automáticamente en el primer arranque con un valor de ejemplo
genérico (`192.168.1.100:8888`, ya no la IP real del autor, que también se sustituyó como
fallback hardcodeado en `app.py`/`launch.py`) si no existe.

**Bloque 2 — auto-actualización en `launch.py`**: antes de arrancar Flask, `git fetch` +
comparación con el remoto de seguimiento (`@{u}`), y `git pull --ff-only` si hay commits nuevos.
Nunca bloquea el arranque — sin conexión, sin remoto configurado, o cambios locales que impidan
un fast-forward limpio, avisa por consola y arranca igual con la versión local (nunca fuerza el
pull). Al actualizar con éxito, informa de versión anterior → nueva (`VERSION`) y muestra el
bloque correspondiente de `CHANGELOG.md`. Verificado con un sandbox git aislado (no el repo
real): actualización real disponible, ya al día, conflicto por cambios locales, remoto
inalcanzable, y carpeta sin git — los 5 casos se comportan como se espera.

**Bloque 3 — `README.md`**: sección de instalación reescrita para alguien sin contexto previo del
proyecto — clonar, venv, requirements, requisitos (Python + Git), primer arranque (config.json se
crea solo, configurar IP real desde Ajustes), y cómo funciona la auto-actualización en el uso
diario.

### Propuesta #5: cuenta asociada por fichero y matching de transferencias entre bancos

- **Resuelto:** 2026-07-18, versión `0.6.0.12`.
- **Anotado:** 2026-07-18, ampliación directa de la Propuesta #3 pedida en la misma sesión.

Cada fichero subido en conciliación puede asociarse opcionalmente a una cuenta real de Money
Manager (selector poblado con `assetsData`, junto a la etiqueta ya existente). Con cuenta
asociada, `match_bank_transactions()` filtra estrictamente los candidatos a esa cuenta (menos
falsos positivos entre cuentas con importes parecidos) y, para transferencias
(`inOutType == 'Transferencia'`), reconoce el lado (origen/destino) según el signo del importe
bancario y el `assetId`/`toAssetId`(`targetAssetId`) de la transacción — así una transferencia
real entre dos bancos propios (p. ej. Cajasur → Revolut) se resuelve como match desde AMBOS
extractos sin que el primero en procesarse "se quede" con la transacción. Ver detalle completo en
`CLAUDE.md`, sección "Matching acotado por cuenta y transferencias entre bancos". Resuelve
parcialmente la Propuesta #4 (ver arriba).

Frontend: selector de cuenta (opcional) junto a la etiqueta de cada fichero pendiente de subir;
badge "🔁 Transferencia interna" en las propuestas (y en cada candidato individual) que encajan con
el lado de una transferencia, para distinguirlas visualmente de un duplicado exacto normal.

**Verificado con datos sintéticos** (no con el móvil real ni con extractos reales de `samples/` —
no hay ningún par de extractos reales con una transferencia compartida todavía): script ad-hoc
(no comprometido al repo) que cubre (1) el fichero del banco origen encuentra la transferencia
como `exact_match`/lado origen, (2) el fichero del banco destino encuentra la MISMA transacción
como `exact_match`/lado destino sin colisión, (3) dentro del mismo fichero, dos líneas con igual
importe no pueden reclamar el mismo lado dos veces, (4) el filtro estricto por cuenta evita un
falso positivo con un movimiento de otra cuenta de importe idéntico, (5) sin `account_id` el
comportamiento previo queda intacto. Además, verificado de extremo a extremo vía el test client de
Flask (`/api/analyze-excel` con 2 ficheros + `accountIds` + XML de Money Manager simulado con una
transferencia real). Pendiente de confirmar contra un caso real cuando el usuario tenga una
transferencia entre bancos en extractos reales — en particular, qué campo (`toAssetId` vs
`targetAssetId`) rellena de verdad el XML de `getDataByPeriod` (no verificado en vivo, ver nota en
`CLAUDE.md`).

### Propuesta #3: soporte CSV y subida múltiple con etiqueta por fichero

- **Resuelto:** 2026-07-18, versión `0.5.0.11` (Bloque 1: `5edaafe`, versión `0.4.0.10`; Bloque 2:
  este mismo commit).
- **Anotado:** 2026-07-18.

**Bloque 1 — CSV**: `backend/bank_excel_parser.py` renombrado a `bank_statement_parser.py`
(`parse_bank_statement()`), reutilizando la misma detección de cabecera + mapeo de columnas por
alias que Excel — solo cambia `_read_raw()` según la extensión. CSV leído con `csv.reader` (no
`pandas.read_csv` directo, que no tolera filas de metadatos más cortas que la cabecera). Delimitador
vía `csv.Sniffer`, encoding probado `utf-8-sig` → `cp1252` → `latin-1`. Verificado contra
`samples/revolut.csv` real (3/3 filas).

**Bloque 2 — subida múltiple con etiqueta**: `/api/analyze-excel` acepta `files`+`labels` (mismo
orden, etiqueta vacía → nombre de fichero), calcula el rango de fechas combinado de todos los
ficheros para una única llamada a `getDataByPeriod`, y hace matching independiente por fichero
(ver Propuesta #4 — limitación conocida y aceptada). Respuesta cambiada de array plano a
`{"proposals": [...], "file_errors": [...]}` — si un fichero individual falla, no aborta la tanda
entera. Frontend: selección múltiple con lista previa de etiquetas editables (`#fileLabelsList`),
badge de etiqueta de origen en cada propuesta, filtro por etiqueta (`#proposalsFilterBar`).
Verificado en navegador real (Playwright) con 3 ficheros mezclados (Cajasur Excel + Revolut CSV +
BBVA Excel): 93 propuestas, etiquetas y filtro correctos.

**Bug real encontrado durante las pruebas de este bloque, corregido en el mismo commit**:
`pd.to_datetime(..., dayfirst=True)` interpreta mal fechas ISO en pandas 3.0.3 —
`'2026-07-08'` se convertía en 7 de agosto. Nueva función compartida `parse_bank_date()` en
`backend/bank_statement_parser.py` (ISO8601 primero, `dayfirst=True` como fallback), usada en
`reconciliation.py` y `app.py`. Ver detalle en `CLAUDE.md`, sección "Parseo de extractos bancarios".

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
