# CLAUDE.md

Guía de referencia para trabajar en este repositorio. Léela antes de tocar código.

## Qué es este proyecto

Dashboard web local para **Money Manager** (app Android de finanzas personales, de Realbyte).
La app Android expone un servidor HTTP embebido llamado **"PC Manager"** cuando se activa desde
Ajustes > PC Manager, siempre en la misma red WiFi que el móvil (sin nube, sin cuentas externas).

Este proyecto es una interfaz web propia (Flask + HTML/JS estático) que:
- Actúa como **proxy/backend** hacia ese servidor del móvil, evitando problemas de CORS y dando
  un dashboard más potente que la web nativa de Money Manager.
- Añade **conciliación bancaria semisupervisada**: subes un extracto Excel del banco y el sistema
  propone qué movimientos del banco corresponden a qué transacciones ya registradas en Money
  Manager, o cuáles faltan por registrar.
- Añade un **motor de presupuestos jerárquico** que cruza el presupuesto configurado en la app con
  el gasto real por categoría/subcategoría.

No hay base de datos propia: la fuente de verdad son siempre los datos que vive en el móvil,
consultados en caliente a través del proxy.

## Arquitectura

```
static/           Frontend estático servido directamente por Flask (sin build step)
  index.html       Estructura de la SPA (tabs: Dashboard, Transacciones, Presupuestos, Conciliación, Ajustes)
  script.js        Toda la lógica de UI: fetch a /api/..., render de tablas/gráficas, modal de edición.
                   Sin build step ni framework: sin tipado ni linter que detecte referencias a IDs
                   de elementos que ya no existen en index.html. Ya hubo un caso real (2026-07-18,
                   showTransaction() referenciaba #searchInput y .tab-btn, restos de una iteración
                   anterior de la UI que ya no existían — usa #filterSearch y switchTab()). Si
                   tocas una función que lleva tiempo sin usarse, verifica los IDs/clases contra el
                   index.html actual antes de asumir que siguen vigentes.
  js/analytics.js  Cálculos auxiliares de analítica para el dashboard
  style.css        Estilos (glassmorphism)

backend/
  __init__.py
  reconciliation.py   match_bank_transactions(): matching banco↔Money Manager con pandas
                       (ventana de días + importe con tolerancia de 1 céntimo + heurística de
                       texto). Ver "Convención de conciliación" más abajo — NUNCA escribe en el
                       móvil. `suggested_mm_ref` y `candidates[].id` son el `id` real (UUID) de
                       la transacción en Money Manager, NUNCA el índice posicional del DataFrame
                       interno — un bug detectado el 2026-07-18 usaba `best_match.name` /
                       `idx_cand` (posición) en vez del campo `id`, lo que rompía silenciosamente
                       "Ver Registro Asociado" y `confirmMatch` en el frontend. Si tocas esta
                       función, no reintroduzcas esa confusión entre posición e id real. Acepta
                       `account_ids` opcional (lista de `assetId` de Money Manager asociados al
                       fichero bancario, elegidos en el frontend — normalmente una cuenta más las
                       tarjetas vinculadas a ella) — ver "Matching acotado por cuenta y
                       transferencias entre bancos" más abajo, incluida la fase 2 (fallback) que
                       corrige la regresión de falsos negativos con tarjetas detectada el
                       2026-07-19.
  budget_engine.py    BudgetEngine: construye el árbol jerárquico presupuesto vs. gasto real
                       por categoría/subcategoría, y calcula flujos de caja (ingreso/gasto/
                       transferencias) ignorando transferencias en el cómputo de presupuesto.
  bank_statement_parser.py Detección genérica de la estructura de un extracto bancario, Excel o
                       CSV (parse_bank_statement()). Ver detalle en la sección "Parseo de
                       extractos bancarios (multi-banco)" más abajo.
  reconciliation_store.py Persistencia local de conciliaciones confirmadas. Ver "Persistencia de
                       conciliaciones confirmadas" más abajo.

app.py             Flask app. Sirve static/, y expone:
  /                        -> static/index.html
  /api/proxy/<endpoint>    -> proxy genérico GET/POST hacia http://<phone_ip>:<phone_port>/<endpoint>
                              (p.ej. /api/proxy/moneyBook/getDataByPeriod). Convierte XML a JSON,
                              limpia JSON no estándar del móvil (comillas sueltas, comas finales).
  /api/analyze-excel       -> conciliación: recibe UNO O VARIOS extractos bancarios a la vez
                              (Excel y/o CSV mezclados; el nombre del endpoint es historia, no
                              una limitación). Campos del form-data: `files` (uno o más ficheros),
                              `labels` (una etiqueta por fichero, MISMO orden que `files` — si una
                              etiqueta viene vacía, se usa el nombre de fichero) y `accountIds`
                              (opcional, MISMO orden que `files` — uno o varios `assetId` de Money
                              Manager por fichero SEPARADOS POR COMAS, p.ej. `"ACC1,CARD1"`, que
                              el usuario marcó en el selector multi-selección del frontend; cadena
                              vacía si no se asoció ninguno). Cada fichero se parsea con
                              backend/bank_statement_parser.py::parse_bank_statement() (ver
                              sección dedicada). Se calcula el rango de fechas COMBINADO de
                              todos los ficheros de la tanda y se hace una única llamada a
                              `getDataByPeriod` — no una por fichero. El matching
                              (`match_bank_transactions`) se hace por SEPARADO para cada fichero,
                              pero TODOS los ficheros de la tanda comparten el mismo DataFrame de
                              transacciones del móvil (`build_mm_dataframe()`, ver "Matching
                              compartido entre ficheros de la misma tanda" más abajo), pasando
                              además la lista `account_ids` de ese fichero si la tiene (ver
                              "Matching acotado por cuenta y transferencias entre bancos"). Si el
                              móvil no responde (`ConnectionError`/`Timeout`/error HTTP al
                              consultar `getDataByPeriod`), se aborta ANTES de generar ninguna
                              propuesta con `{"mm_connection_error": true}` y HTTP 503 — nunca se
                              trata un fallo de conexión como "cero transacciones" (Bug #1 en
                              `BACKLOG.md`, resuelto 2026-07-19; ver también "Aviso de conexión
                              perdida" más abajo). Cada propuesta lleva `source_label` y `source_filename`,
                              y `source_id` va prefijado por índice de fichero (`f0_...`,
                              `f1_...`) para que sea único entre ficheros de la misma tanda. Si un
                              fichero individual no tiene estructura reconocible, no aborta toda
                              la tanda: se reporta en `file_errors` y se sigue con el resto.
                              Respuesta: `{"proposals": [...], "file_errors": [...]}` (no un array
                              plano). Emite logs con prefijo "[analyze-excel]" (fila/columnas de
                              cabecera detectadas por fichero + cuenta asociada, filas parseadas,
                              rango de fechas combinado, URL y rango consultado al móvil,
                              éxito/excepción de esa llamada, muestra de transacciones recibidas,
                              y resumen final de resultados por estado: exact_match/
                              probable_match/suggested_match/reconciled/new) — diagnóstico
                              permanente (a consola Y a
                              `logs/app.log`, ver "Logging de diagnóstico" más abajo) para depurar
                              por qué la conciliación no encuentra matches.
  /api/budget-hierarchy    -> pide transacciones + resumen de presupuesto al móvil, llama a
                              BudgetEngine. Mismo criterio que /api/analyze-excel ante un fallo de
                              conexión real con el móvil: `mm_connection_error: true`, HTTP 503,
                              en vez de un 500 genérico indistinguible de cualquier otro error.
  /api/config              -> GET/POST de config.json (IP/puerto del móvil)
  /api/version             -> versión actual de la app (ver "Versionado")

reference/         Código JS del propio Money Manager PC Manager (descargado con
                    reference/download_mm.py desde el servidor del móvil). Es material de
                    referencia para entender la API real, NO código propio del proyecto.
                    No editar como si fuera nuestro.

samples/            Ficheros de ejemplo para pruebas locales. NO están versionados en git
                    (pueden contener datos financieros reales del usuario, ver .gitignore).
```

El frontend nunca llama directamente a la IP del móvil: siempre pasa por `/api/proxy/...` en
Flask, que es quien conoce la IP/puerto (ver siguiente sección).

**Layout de `static/index.html` / `style.css`:** `body` usa `display:flex; flex-direction:column;
justify-content:center; align-items:center` para centrar `.glass-container` (el panel principal) y
apilar el `<footer class="app-footer">` justo debajo, centrado. Si se cambia `flex-direction` de
`body` a `row` (o se quita), el footer deja de aparecer debajo del panel y pasa a colocarse al lado
como si fuera parte del layout lateral — cuidado al tocar el layout raíz.

**Cache-busting de `static/`:** `index.html` referencia `style.css?v=N` y `script.js?v=N`. Sube ese
número cada vez que edites esos ficheros — si no, el navegador puede seguir sirviendo la versión
cacheada y un fix que funciona en el backend puede parecer que "no hace nada" en el frontend.

**Logging de diagnóstico — usa `logger`, no `print()`:** la consola de Windows puede "perder" la
salida de un proceso de larga duración por varios motivos fuera de nuestro control — block-
buffering de stdout, o **QuickEdit Mode de cmd.exe**, que congela toda la salida nueva de la
consola en cuanto el usuario hace clic dentro de la ventana para seleccionar texto (muy fácil que
pase sin querer con `launch.bat`, y el proceso sigue funcionando con normalidad, solo que no se ve
nada nuevo). En vez de perseguir cada motivo posible, `app.py` define un `logger` (
`logging.getLogger("money_manager_dashboard")`) con dos handlers: consola (`sys.stdout`, con
`line_buffering=True` forzado) y un `RotatingFileHandler` que escribe en `logs/app.log` (fuera de
git — puede contener descripciones de transacciones reales). **Usa siempre `logger.info(...)` /
`logger.error(...)` para logging de diagnóstico, nunca `print()`** — así queda garantizado en el
fichero aunque la consola no muestre nada. Si un log parece no aparecer, revisa `logs/app.log`
antes de asumir que el código no se ejecutó.

## Configuración: `config.json`

```json
{"phone_ip": "192.168.1.100:8888", "phone_port": "8888"}
```

- Vive en la raíz, se lee/escribe con `get_config()` / `save_config()` en `app.py`.
- Editable desde la UI (tab Ajustes) vía `GET/POST /api/config`.
- **Nunca hardcodear la IP real de ningún usuario en código.** Todo acceso al móvil pasa por
  `get_phone_url()`, que lee `config.json`. Si necesitas la URL del móvil en un sitio nuevo,
  reutiliza esa función. El único valor de IP que vive en el código es el placeholder genérico
  `DEFAULT_CONFIG` en `app.py` (`192.168.1.100:8888`, replicado en `launch.py` y
  `config.example.json`) — nunca la IP real de nadie.
- **NO está versionado en git** (`.gitignore`) — cada usuario tiene su propia IP de LAN, y desde
  que el repo es público (Propuesta #2 en `BACKLOG.md`, resuelta 2026-07-18) no tiene sentido que
  se comparta entre clones. `config.example.json` es la plantilla versionada, con el mismo
  placeholder que `DEFAULT_CONFIG`. Si `config.json` no existe al arrancar (primer uso, o se
  borró), `get_config()` lo crea automáticamente con `DEFAULT_CONFIG` — el usuario lo sobreescribe
  desde la pestaña Ajustes en su primer arranque, no hace falta crearlo a mano.
  - **Nota histórica**: antes de esto, `config.json` sí estuvo versionado desde el primer commit
    del repo (con la IP real del autor) — se sacó del tracking con `git rm --cached` sin reescribir
    el historial (decisión tomada tras auditar todo el historial de git en busca de datos
    sensibles antes de hacer público el repo; el único hallazgo fue esa IP, considerada de bajo
    riesgo por ser de LAN — ver `BACKLOG.md`, Propuesta #2 resuelta, para el detalle completo de
    la auditoría).

## La API real del móvil (PC Manager) — referencia estable

Esta es la parte más frágil del proyecto: no la controlamos nosotros, es la API interna que
Realbyte expone en el móvil. Lo documentado aquí está verificado contra `reference/moneybook.js`
(JS original del PC Manager) y contra las pruebas reales en `test_post.py` / `check_post.py` /
`static/script.js`. Si cambia el comportamiento observado, actualiza esta sección.

### Lectura: `GET /moneyBook/getDataByPeriod?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Devuelve **XML**, no JSON:

```xml
<dataset>
  <results>158</results>
  <row>
    <id>uuid</id>
    <mbDate>2026-03-26</mbDate>
    <payType><![CDATA[🔴 Nómina Julio]]></payType>
    <inOutType>Gasto</inOutType>
    <mbCategory><![CDATA[❤️‍🩹 SALUD]]></mbCategory>
    <subCategory><![CDATA[...]]></subCategory>
    <mbContent><![CDATA[Amanda sesión 31]]></mbContent>
    <mbCash>60.0</mbCash>
    <assetId>...</assetId>
  </row>
</dataset>
```

`app.py:xml_to_dict()` lo convierte a lista de diccionarios. En **lectura**, `inOutType` viene en
español legible: `"Ingreso"`, `"Gasto"`, `"Transferencia"`.

### Lectura: `GET /moneyBook/getSummaryDataByPeriod?...` y `GET /moneyBook/getAssetData`

Devuelven JSON (a veces no estándar: claves sin comillas, comillas simples — de ahí
`clean_json()` en `app.py`). `getAssetData` da el árbol de cuentas/activos (grupo > cuentas, cada
una con `assetId`, `assetName`, `assetMoney`).

### Escritura: `POST /moneyBook/create`, `POST /moneyBook/update`, `POST /moneyBook/delete`

**`create`/`update` aceptan NOMBRES para `payType`, `mbCategory` y `subCategory`** — hay que mandar
el texto exacto tal cual aparece en Money Manager (incluyendo emojis), no un identificador interno.
Ejemplo real verificado (`test_post.py`):

```
mbDate:      2026-03-27T10:00:00
mbCash:      0.02
inOutType:   Egreso
inOutCode:   1
payType:     👛 Efectivo
mbCategory:  🍴 ALIMENTACIÓN
subCategory: 🍟 Restaurantes
mbContent:   texto libre
assetId:     11
```

`assetId` en cambio sí viaja como **ID real** (numérico o UUID, el mismo `assetId` que devuelve
`getAssetData`) — es la cuenta de origen. `payType` se manda en paralelo como el *nombre* de esa
misma cuenta (ver `getAssetName()` en `script.js`, que resuelve `assetId -> nombre` antes de
construir el payload). Para transferencias se usa además `targetAssetId` (ID de la cuenta destino).

**⚠️ `mbCategory`/`subCategory` por sí solos NO bastan — hace falta `mcid`/`mcscid` (Bug #2 de
`BACKLOG.md`, resuelto 2026-07-19, verificado contra el móvil real):** si `create`/`update` reciben
`mbCategory`/`subCategory` sin ir acompañados de `mcid`/`mcscid` (el ID real de la categoría y
subcategoría, el mismo que devuelve `moneyBook/getInitData` en `category_0`/`category_1` como
`mcid`/`mcname` y `mcsc[].mcscid`/`mcsc[].mcscname`), el móvil responde `{success:true}` pero
**guarda `mbCategory` literalmente como el string `"None"`** y `mcid` como `"-2"` — confirmado
creando una transacción de prueba real y verificando con `getDataByPeriod` que así quedó guardada
(y limpiada después). Enviando `mcid`+`mbCategory` y `mcscid`+`subCategory` juntos (igual que hace
el propio cliente oficial de PC Manager, `reference/all_mm.js`, que resuelve un ID de combo a
nombre antes de mandar AMBOS) la categoría se guarda correctamente — verificado con el mismo
método. `static/script.js` mantiene un mapa nombre→mcid/mcscid (`categoryMapData`, poblado por
`fetchCategoryMap()` desde `moneyBook/getInitData` al cargar) y lo usa en `submitTransaction()`
para adjuntar `mcid`/`mcscid` junto al nombre.

**✅ `inOutType`/`inOutCode` — ambigüedad ya resuelta (verificado contra el móvil real,
2026-07-19):**

- **`inOutCode` es el que determina el comportamiento real; `inOutType` (el texto) es puramente
  cosmético.** Verificado creando dos transacciones idénticas salvo el texto de `inOutType`
  (`"Egreso"` vs. `"Gasto"`, ambas con `inOutCode: "1"`): ambas se guardaron y se leyeron después
  exactamente igual (`inOutType: "Gasto"` en la lectura) — el móvil deriva el `inOutType` de
  lectura a partir de `inOutCode`, no del texto recibido en la escritura.
- **Mapeo de `inOutCode` correcto para `create`/`update`, confirmado por prueba real:**
  `{'Gasto': '1', 'Ingreso': '0', 'Transferencia': '3'}` — coincide con lo que ya sugería
  `reference/moneybook.js` (que usa `inOutCode "0"` para Ingreso y `"1"` para Gasto al filtrar por
  pestaña), no con el mapeo previo de `static/script.js` (`'Ingreso': '2'`).
  - **`inOutCode: '2'` para Ingreso estaba REALMENTE ROTO, no solo "distinto":** se creó una
    transacción de prueba con `inOutCode: '2'` y el móvil respondió `{success:true}`, pero la
    transacción **nunca llegó a persistir** — no aparece en `getDataByPeriod` ni en un rango de
    fechas de 10 años completo, y el balance de la cuenta usada no cambió. `reference/all_mm.js`
    explica por qué: el código `"2"` se trata internamente como un tipo de movimiento de activos
    (`onMove_Asset`), no como Ingreso — al faltarle los campos que ese tipo de movimiento espera
    (`toAssetId`/`targetAssetId`), el móvil lo descarta en silencio. Esto significa que, antes de
    este fix, **cualquier transacción de tipo Ingreso creada desde este dashboard pudo no haberse
    guardado nunca**, aunque la UI mostrara "Transacción añadida exitosamente" — no se detectó
    antes porque no había ningún log que comparara lo enviado con lo realmente persistido.
  - `inOutCode` para Transferencia (`'3'`) se documenta a fondo en "Transferencias internas de
    Money Manager" más abajo — lectura y escritura son un mecanismo totalmente aparte de
    `create`/`update`.

`delete` espera `ids` con prefijo `:` — ejemplo: `ids=:<id_transaccion>`.

### Transferencias internas de Money Manager

Verificado contra el móvil real (2026-07-19, Tarea 2 de una sesión de trabajo) sobre datos reales
del usuario (1556 transferencias históricas reales encontradas en un rango de 10 años) y contra
`reference/all_mm.js`. Sustituye cualquier suposición anterior no verificada sobre este punto.

**Lectura (`getDataByPeriod`) — modelo de una sola fila, `inOutType` NO es `"Transferencia"`:**

- Una transferencia es **una única fila** con `inOutCode: "3"`, `assetId` = cuenta origen,
  `toAssetId` = cuenta destino, `mbCash` **negativo** (importe visto desde la cuenta origen).
  `targetAssetId` sale siempre como el string `"null"` — no se usa nunca en lectura (`toAssetId`
  es el campo real; ver ambigüedad ya resuelta).
- **`inOutType` para una transferencia es literalmente `"Dinero gastado"`, NUNCA
  `"Transferencia"` ni `"Transfer"`** — confirmado sobre 1556 filas reales, cero excepciones. Esto
  es lo que rompía `renderTransactions()`/`editTransaction()` en `static/script.js`: comparaban
  `t.inOutType === 'Transferencia'`, una condición que nunca era cierta con datos reales. La señal
  fiable es **`inOutCode`**, no el texto de `inOutType` (coherente con que `inOutType` ya se
  demostró puramente cosmético en la sección anterior).
- `inOutCode: "4"` (el lado invertido: `assetId` = destino, `toAssetId` = origen, `mbCash`
  positivo) existe en el código del cliente oficial (`reference/moneybook.js`,
  `reference/all_mm.js`) pero **nunca se ha observado en datos reales** (0 de 1556). El código de
  este proyecto lo contempla defensivamente (mirando de qué lado está `assetId`/`toAssetId` según
  el código) pero no se ha podido probar en vivo.
- `mbCategory` se rellena automáticamente (por el propio Money Manager, no por este proyecto) con
  el **nombre de la cuenta destino** como conveniencia — no es una categoría real, `mcid`/`mcscid`
  salen como el string `"null"`. No confiar en este campo para mostrar la cuenta destino; se
  resuelve independientemente con `getAssetName(t.toAssetId)`.

**Escritura — endpoint y campos TOTALMENTE DISTINTOS de `moneyBook/create`/`update`:**

Antes de esta tarea, `static/script.js:submitTransaction()` enviaba las transferencias a
`moneyBook/create`/`update` con `targetAssetId`. Se confirmó contra el móvil real que esto **no
funciona**: la petición responde `{success:true}` pero la transacción resultante guarda
`toAssetId` como el string `"null"` — una transferencia sin cuenta destino, silenciosamente rota,
indistinguible de un éxito para el usuario.

El mecanismo real (extraído de `reference/all_mm.js`, formulario `assetMoveForm`, y verificado
creando/editando/borrando transferencias de prueba reales):

- **Crear**: `POST moneyBook/moveAsset` con `moveDate` (solo fecha, `YYYY-MM-DD`, SIN hora — a
  diferencia de `mbDate` que sí lleva hora), `fromAssetId`, `fromAssetName` (nombre de la cuenta
  origen), `toAssetId`, `toAssetName` (nombre de la cuenta destino), `moveMoney` (importe en
  positivo — el signo negativo de `mbCash` en lectura lo aplica el propio Money Manager), y
  `moneyContent` (⚠️ NO `mbContent` — nombre de campo distinto solo para este endpoint). Opcional:
  `mbDetailContent` (este sí con el mismo nombre que en `create`/`update`).
- **Editar**: `POST moneyBook/modifyMoveAsset`, mismos campos más `id` (el id de la transacción a
  editar). **El `id` de la transacción CAMBIA tras cada edición** — verificado creando una
  transferencia, editándola una vez, y comprobando que el id original ya no existe y aparece uno
  nuevo con los datos editados. Cualquier código que dependa de reutilizar el mismo id después de
  editar una transferencia (p. ej. para reabrir la fila recién guardada) se rompería; por eso
  `submitTransfer()` en `static/script.js` no intenta mostrar la fila recién editada por id
  después de guardar, solo refresca la tabla entera.
- La respuesta de `modifyMoveAsset` puede ser un **cuerpo vacío con HTTP 200** (no
  `{success:true}` como en `create`/`moveAsset`) — sigue siendo éxito, verificado comprobando el
  resultado real con `getDataByPeriod` tras la llamada. El chequeo de éxito ya usado en el
  proyecto (`resp.ok` como condición de respaldo) lo cubre sin cambios.
- `static/script.js` implementa esto en `submitTransfer()`, separado de `submitTransaction()`
  (que ahora solo maneja Gasto/Ingreso) — `submitTransaction()` delega a `submitTransfer()` en
  cuanto detecta `typeStr === 'Transferencia'`.

## Parseo de extractos bancarios (multi-banco)

`backend/bank_statement_parser.py::parse_bank_statement()` detecta la estructura de un extracto
bancario (Excel **o CSV**) sin asumir un banco concreto — verificado contra 7 extractos reales
distintos en `samples/` (Cajasur, BBVA, EVO cuenta, EVO tarjeta, Sabadell, Revolut CSV). La
detección de cabecera y el mapeo de columnas son **exactamente los mismos** independientemente del
formato de fichero; lo único que cambia según la extensión (`_read_raw()`) es cómo se lee el
fichero en bruto a un DataFrame — no hay dos caminos de lógica separados para Excel y CSV. Diseño:

- **Detección de la fila de cabecera**: escanea las primeras filas (hasta `max_scan=30`) buscando
  una que contenga, en alguna de sus celdas, algo clasificable como fecha + concepto + (importe o
  cargo+abono) — nunca una posición fija (`skiprows`), porque cada banco mete un número distinto
  de filas de metadatos (nombre de cuenta, titular, periodo del informe...) antes de la tabla real.
- **Clasificación de celdas por alias exacto, no por posición**: cada celda de la fila candidata se
  normaliza (sin acentos, minúsculas, puntos/barras convertidos a espacio) y se compara por
  **igualdad exacta** contra listas de alias por campo (`FIELD_ALIASES` en ese fichero) — p. ej.
  `"F.Valor"` → `"f valor"` → campo `fecha_valor`; `"F. Operativa"` → `"f operativa"` → campo
  `fecha`. Es igualdad exacta y no "contiene", a propósito: varios bancos tienen a la vez una
  columna de fecha de operación y una de fecha valor (`"Fecha"` + `"Fecha valor"`, `"F. Operativa"`
  + `"F. Valor"`, `"Fecha contable"` + `"Fecha valor"`) — con un simple `contains('fecha')` no se
  pueden distinguir. `fecha_valor` se clasifica aparte explícitamente para ignorarla, no para
  usarla como fecha de la operación.
- **Cargo/abono en columnas separadas**: si el banco no tiene una columna `importe` única pero sí
  `cargo`/`debe`/`salida` y `abono`/`haber`/`entrada`, se combinan en un único importe con signo
  (`abono - abs(cargo)`). Ninguno de los extractos reales de `samples/` usa este formato — cubierto con
  un test sintético, no con datos reales; si aparece un banco real con este formato, verificar que
  el signo resultante es el esperado.
- **Fallo explícito, nunca una suposición silenciosa**: si ninguna fila candidata reúne fecha +
  concepto + importe con confianza, `parse_bank_statement()` lanza `BankStatementFormatError`, y
  `/api/analyze-excel` la traduce a `400` con el mensaje tal cual — mejor que el usuario vea "no
  reconozco este fichero" a que la conciliación se ejecute silenciosamente sobre datos mal
  alineados.
- **CSV — delimitador y encoding detectados, no asumidos**: `csv.Sniffer` detecta el delimitador
  (coma, punto y coma, tabulador...) sobre una muestra del fichero; el encoding se prueba en orden
  `utf-8-sig` → `cp1252` → `latin-1` (este último nunca falla, garantiza un resultado). El CSV se
  lee con `csv.reader` fila a fila y se rellenan con `None` las filas más cortas que el máximo —
  **no** con `pandas.read_csv` directo, que lanza `ParserError` si alguna fila tiene menos campos
  que otras (habitual en CSV con metadatos antes de la cabecera real, igual que en Excel).
- **Para dar soporte a un banco nuevo que falle**: casi seguro que basta con añadir el alias que le
  falta a `FIELD_ALIASES` (revisando qué texto normalizado tiene su cabecera real) — no hace falta
  tocar la lógica de detección en sí.
- **Fechas — usa siempre `parse_bank_date()`, nunca `pd.to_datetime(..., dayfirst=True)` a
  pelo**: confirmado en pandas 3.0.3 que `dayfirst=True` interpreta MAL fechas ISO
  (`YYYY-MM-DD[ HH:MM:SS]`, formato de Revolut) — `'2026-07-08'` se convierte en 7 de agosto en
  vez de 8 de julio, **incluso sin ambigüedad real** en el string. `parse_bank_date()` prueba
  primero `format='ISO8601'` (que rechaza con `NaT` cualquier cosa que no sea `YYYY-MM-DD`, así
  que nunca puede confundir un `DD/MM/YYYY` español) y usa `dayfirst=True` solo como fallback para
  lo que ISO8601 no reconoce. Se usa tanto en `reconciliation.py` (fecha del banco para el
  matching) como en `app.py` (rango de fechas a consultar al móvil) — si añades un tercer sitio
  que parsee fechas de un extracto bancario, usa esta función, no `pd.to_datetime` directo.

## Convención de conciliación bancaria: nunca auto-conciliar

**Regla dura: el backend nunca escribe automáticamente en el móvil como resultado de la
conciliación.** `match_bank_transactions()` solo genera *propuestas* (`status`: `exact_match`,
`probable_match`, `suggested_match`, `new`, con lista de `candidates` cuando hay ambigüedad). El
usuario siempre confirma manualmente en la UI antes de que cualquier cosa llegue a
`/moneyBook/create` o `/moneyBook/update`.

Esto es equivalente a la regla ya usada en GEMA para BGG: cuando hay **2 o más candidatos**
posibles para un mismo movimiento bancario, nunca se elige uno automáticamente — se presentan
todos y decide el usuario. Aquí aplica igual: un match con varios `candidates` no colapsa solo a
uno por mayor `confidence`; se muestran todos para que el usuario elija (o descarte).

Si en el futuro se añade cualquier tipo de "auto-aplicar" (aunque sea solo para `exact_match` con
un único candidato y confidence 100), debe ser explícito, opcional, y nunca el comportamiento por
defecto.

### Persistencia de conciliaciones confirmadas

Confirmar un match (botón "Confirmar Este" sobre un candidato de `suggested_match`/`probable_match`)
**no escribe nada en el móvil** — la transacción ya existe allí; solo vincula visualmente una línea
del Excel del banco con una transacción ya existente en Money Manager. Lo que sí persiste es esa
decisión, localmente, para no volver a presentar la misma ambigüedad si se recarga un Excel que se
solape en fechas con uno ya revisado.

- **Dónde vive**: `data/reconciliations.json`. Fichero plano, igual de sencillo que `config.json`
  (sin ORM ni SQLite: el volumen de datos de un usuario doméstico no lo justifica). `data/` está en
  `.gitignore` — es historial personal de conciliación, no código del proyecto, igual que `samples/`.
- **Clave estable**: no hay ID nativo en el Excel del banco, así que la clave es
  `sha256(f"{fecha_iso}|{importe:.2f}|{descripcion_normalizada}")`, donde `descripcion_normalizada`
  es el texto en minúsculas con espacios colapsados (`backend/reconciliation_store.py:make_key()`).
  Esta misma función se usa tanto al confirmar como al re-analizar un Excel, para que la clave sea
  idéntica en ambos casos.
  - **Limitación conocida y aceptada**: dos movimientos bancarios genuinamente distintos con la
    misma fecha, importe y descripción exacta (p. ej. dos compras idénticas el mismo día en el
    mismo comercio) comparten clave y se tratan como el mismo movimiento. Es una limitación
    inherente a no tener ID nativo en el extracto bancario, no un bug — si se vuelve un problema
    real, la solución sería añadir un índice de ocurrencia dentro del mismo día a la clave.
- **Qué se guarda por clave**: `mm_id` (id real/UUID de la transacción en Money Manager con la que
  se vinculó), `confirmed_at` (ISO 8601 UTC), y `status` (por ahora solo `"confirmed"`; el campo ya
  admite añadir `"dismissed"` en el futuro sin cambiar el formato).
- **Al analizar un Excel**: `POST /api/analyze-excel` calcula las propuestas con
  `match_bank_transactions()` como siempre, y **después** sobreescribe el `status` a `"reconciled"`
  para cualquier propuesta cuya clave ya exista en el almacén, usando el `mm_id` guardado como
  `suggested_mm_ref` — ignora lo que el matching heurístico hubiera calculado, porque el usuario ya
  dio la respuesta correcta antes.
- **Estado visual**: `"reconciled"` es un estado nuevo en el frontend, distinto de "Nuevo
  Movimiento" (`new`) y "Posible Coincidencia" (`suggested_match`/`probable_match`) — badge propio
  ("Ya Conciliado") y botón "Ver Registro Asociado" (igual que `exact_match`), sin acciones de
  confirmación adicionales.
- **Endpoint**: `POST /api/reconciliations/confirm` (nuevo — antes `confirmMatch()` en el frontend
  era solo un `alert()` local sin llamada al backend). Recibe `date`, `amount`, `description`
  (los mismos campos de la propuesta, para recalcular la clave) y `mm_id` (el candidato elegido);
  escribe la entrada en `data/reconciliations.json`.

### Matching compartido entre ficheros de la misma tanda (`build_mm_dataframe()`)

**Resuelto 2026-07-19 (Propuesta #4 de `BACKLOG.md`).** `/api/analyze-excel` construye el
DataFrame de transacciones de Money Manager **una sola vez por tanda** con
`backend/reconciliation.build_mm_dataframe()`, y lo pasa **compartido** (mismo objeto, mutado en
el sitio) a la llamada de `match_bank_transactions()` de CADA fichero de esa tanda, en vez de que
cada fichero reconstruyera su propio DataFrame desde cero como antes.

**Por qué hacía falta esto — bug real, no solo teórico, confirmado con un caso sintético**: sin
compartir estado, si dos transacciones de Money Manager tenían la MISMA fecha e importe (p. ej.
dos compras de 50€ el mismo día, sin relación real entre sí) y cada una aparecía en un fichero
bancario distinto de la misma tanda, **ambos ficheros proponían determinísticamente la MISMA
transacción de Money Manager como `exact_match`** (el primer candidato por fecha exacta,
`exact_date.iloc[0]`, es siempre el mismo si el DataFrame de partida es idéntico) — dejando la
SEGUNDA transacción real de Money Manager invisible para siempre, sin proponérsela a ningún
fichero. Verificado con exactamente ese caso sintético (dos transacciones MM de -50€ el mismo día,
dos ficheros con una línea de -50€ cada uno): con el DataFrame compartido, el segundo fichero ve
que la primera transacción ya está consumida y encuentra correctamente la segunda.

Compartir el DataFrame NO rompe el caso de una transferencia entre dos cuentas propias con cuenta
asociada en cada fichero (ver más abajo): cada lado consume una columna booleana DISTINTA de la
MISMA fila (`matched_origin` / `matched_destination`), así que ambos ficheros siguen resolviendo
la misma fila como match sin colisionar, aunque ahora partan del mismo DataFrame.

### Matching acotado por cuenta y transferencias entre bancos

Al etiquetar cada fichero subido (ver `/api/analyze-excel` más arriba), el usuario puede además
asociarle **opcionalmente** una o varias cuentas/tarjetas reales de Money Manager (`accountIds`
en el form-data, `account_ids` en `match_bank_transactions()`, lista) desde un selector
multi-selección poblado con `assetsData` en el frontend (`flattenAssets()` en `script.js`). Sin
cuentas asociadas, no hay fase 1 (ver más abajo): se busca directamente sin filtrar por cuenta.

**Cuentas y tarjetas — `linkAssetId`**: `getAssetData` devuelve tarjetas vinculadas a una cuenta
(p.ej. una tarjeta de débito) como assets con su **propio `assetId`** (distinto del de la cuenta)
más un campo `linkAssetId` que apunta al `assetId` de la cuenta madre — verificado en vivo el
2026-07-19 contra datos reales: un grupo de tarjetas de débito, cada tarjeta con `linkAssetId` =
`assetId` de su cuenta; el resto de grupos (efectivo, ahorros, préstamos, tarjeta prepago,
Revolut...) no usan `linkAssetId`, es específico de tarjetas vinculadas a una cuenta. El frontend
usa esto en `linkedCardIdsFor()`: al marcar una cuenta en el selector, auto-marca también sus
tarjetas (editable después — el usuario puede quitarlas o añadir más a mano; solo se auto-AÑADE
al marcar una cuenta nueva, nunca se auto-quita nada).

**Por qué hace falta esto — `getDataByPeriod` es inconsistente sobre qué `assetId` usa**: un
extracto bancario de una cuenta mezcla movimientos hechos directamente en la cuenta con
movimientos hechos con una tarjeta vinculada a ella, pero Money Manager no registra ambos con el
mismo `assetId` — verificado en vivo el 2026-07-19 sobre 1165 transacciones reales de un rango de
7 meses: 591 con el `assetId` de una cuenta directamente, 218 con el `assetId` de una tarjeta
vinculada a otra cuenta distinta de esas 591. Si el matching filtrara estrictamente por un único
`assetId` de cuenta (como hacía la versión anterior, Propuesta #5), los movimientos hechos con
tarjeta se declaraban "nuevo" por error — regresión real detectada por el usuario, corregida con
el diseño de dos fases de abajo. Confirmado con un fichero real de `samples/`
(`casa_julio_250626-180726.xls`, 102 líneas) contra datos reales del móvil: la versión con filtro
estricto de una sola cuenta daba 42 falsos "nuevo" de 102 líneas; con las dos fases, solo 4 (los
genuinamente nuevos).

**FASE 1 (prioritaria)**: `match_bank_transactions()` **filtra estrictamente** — no solo
prioriza — los candidatos a `account_ids`, para reducir falsos positivos entre cuentas distintas
con importes parecidos:

- **Movimiento normal** (no transferencia): solo se consideran candidatos cuyo `assetId` esté en
  `account_ids`.
- **Transferencia**: `build_mm_dataframe()` detecta una transferencia por **`inOutCode` ("3" o
  "4"), NUNCA por el texto de `inOutType`** — resuelto 2026-07-19 tras confirmar contra el móvil
  real que una transferencia se lee con `inOutType = "Dinero gastado"`, no `"Transferencia"` (ver
  más abajo, "Tabla de transacciones — transferencias"); comparar contra ese texto (como hacía
  esta función antes de esta fecha) dejaba `is_transfer` siempre en `False` para transferencias
  reales — un bug puramente teórico hasta entonces, nunca antes probado con el `inOutType` real.
  Una transferencia en Money Manager es UNA sola transacción con `assetId` = cuenta origen y
  `toAssetId` = cuenta destino (el campo real, confirmado 2026-07-19 — `targetAssetId` ya no se
  usa, ver más abajo) — pero en dos extractos bancarios reales (el del banco origen y el del
  banco destino) aparece como DOS líneas distintas (una negativa, una positiva). Un elemento de
  `account_ids` puede coincidir con el origen o con el destino de la misma transacción de Money
  Manager; se usa el signo del importe bancario para decidir el lado (negativo → origen, positivo
  → destino) y no confundirlos. Cada lado se marca como "consumido" por separado (`matched_origin`
  / `matched_destination` en el DataFrame de `mm_df`, no un único flag `matched` como en el resto
  del matching) — así, la MISMA transacción de Money Manager puede resolverse como match desde el
  fichero del banco origen Y desde el fichero del banco destino, sin que el primero en procesarse
  "se quede" con ella. Dentro de un mismo fichero, un lado ya consumido no se puede reclamar dos
  veces (dos líneas bancarias con igual importe no pueden reclamar el mismo lado).

**FASE 2 (fallback, y también el camino sin `account_ids` en absoluto)**: si para una línea
concreta del banco la fase 1 no encuentra NINGÚN candidato dentro de la ventana de fechas/importe
(pero sí hay transacciones de Money Manager con esa fecha/importe en general), se repite la
búsqueda para esa línea sin el filtro de `account_ids`. El resultado se marca con
`account_fallback: true` (frontend: badge "⚠️ Fuera de la cuenta esperada") para que el usuario
lo revise con más atención antes de confirmar — no es tan fiable como un match dentro de las
cuentas/tarjetas que él mismo marcó.

- **Sin contexto de cuenta fiable (fase 2, o directamente sin `account_ids` en el fichero) una
  transferencia SÍ distingue lado, por el signo del importe bancario** (resuelto 2026-07-19,
  Propuesta #4): negativo consume `matched_origin`, positivo consume `matched_destination` —
  antes de esta fecha, fuera del contexto de cuenta se consumía siempre `matched_origin` sin
  distinguir signo, lo que rompía el caso de dos ficheros SIN cuenta asociada que trajeran los
  dos lados de la MISMA transferencia entre cuentas propias (el segundo fichero, con el DataFrame
  ya compartido entre ficheros — ver arriba —, se encontraba el lado origen ya consumido por el
  primero y no podía resolver su propio lado destino). El `transfer_role` (`'origen'`/`'destino'`)
  que ve el frontend solo se afirma con contexto de cuenta fiable (fase 1 sin fallback) — en fase
  2 o sin `account_ids`, el consumo por signo ya evita la colisión, pero `transfer_role` se deja
  en `None` porque no hay certeza de cuál extracto es cuál cuenta, solo de qué lado es cada línea.
- Cada propuesta resultante lleva `is_transfer` (bool), `account_fallback` (bool) y, si aplica y
  se resolvió con contexto de cuenta fiable, `transfer_role` (`'origen'`/`'destino'`/`None`);
  cada candidato de `candidates[]` lleva su propio `is_transfer`. El frontend usa esto para
  mostrar badges "🔁 Transferencia interna" y "⚠️ Fuera de la cuenta esperada" en vez de dejar que
  parezcan un duplicado exacto sin explicación.
- **Transferencias entre BANCOS verificadas solo con datos sintéticos** (no hay en `samples/`
  ningún par de extractos reales que compartan una transferencia entre bancos todavía) — ver
  scripts de verificación usados durante el desarrollo, no comprometidos al repo. La detección de
  transferencia en sí (`inOutCode`, campo `toAssetId`) sí está verificada contra el móvil real
  (ver "Tabla de transacciones — transferencias" más abajo); lo que sigue siendo sintético es
  específicamente el escenario de dos EXTRACTOS BANCARIOS reales compartiendo los dos lados.

## Aviso de conexión perdida con el móvil

**Resuelto 2026-07-19 (Bug #1 de `BACKLOG.md`).** Antes, un fallo de conexión con el móvil a
mitad de sesión (el usuario cerró Money Manager sin querer, lo que mata el servidor PC Manager en
segundo plano) se trataba en el backend como "cero transacciones" válidas — `analyze_excel()`
seguía adelante con `real_transactions=[]` en silencio, generando un falso "nuevo movimiento" por
cada línea del Excel, como si de verdad no existieran en Money Manager. El indicador de conexión
del header (`#connectionStatus` / `updateConnectionStatus()` en `static/script.js`) solo se
actualizaba desde `loadData()` (carga inicial/periódica), así que un fallo a mitad de sesión no lo
reflejaba — el usuario podía ver "En Línea" en el header mientras el backend ya no podía hablar
con el móvil.

- **Backend**: `/api/proxy/<endpoint>` (genérico), `/api/analyze-excel` y `/api/budget-hierarchy`
  devuelven `{"mm_connection_error": true}` (además del `demo_mode` ya existente en el proxy
  genérico, por compatibilidad) con un status HTTP distinto de 200 (503, o 504 en timeout) ante
  cualquier `requests.exceptions.RequestException` (`ConnectionError`, `Timeout`, o un status de
  error que `raise_for_status()` convierte en excepción) al hablar con el móvil. `analyze_excel()`
  aborta ANTES de llamar a `match_bank_transactions()` en este caso — nunca genera propuestas
  sobre una lista de transacciones vacía por fallo de conexión.
- **Frontend**: `isMmConnectionError(data)` es el único punto que comprueba ese campo. Todas las
  funciones que dependen del móvil (`fetchAssets`, `fetchTransactions`, `fetchBudgets`,
  `fetchCategoryMap`, y `confirmUploadFiles()` para `/api/analyze-excel`) lo comprueban y llaman a
  `updateConnectionStatus('offline')` — se **extendió** el indicador ya existente para que
  reaccione a cualquier fallo a mitad de sesión, no solo desde `loadData()`, tal y como ya sugería
  `BACKLOG.md` (en vez de crear un aviso nuevo desde cero). Cada una de esas funciones también
  llama a `updateConnectionStatus('online')` en su propio camino de éxito, para que la
  recuperación de conexión se refleje sin esperar al siguiente `loadData()` completo.

## Distribución con ejecutable de Windows (segunda vía, "amigable")

Además de la vía técnica (`git clone` + venv + `launch.py`, ver más abajo "Comandos" y la
Propuesta #2 resuelta en `BACKLOG.md`), existe una segunda vía pensada para un amigo sin
conocimientos técnicos (Propuesta #6 en `BACKLOG.md`): un único `.exe` de Windows, doble clic, sin
instalar nada. **Ninguna vía sustituye a la otra** — conviven, y cualquier cambio en una no debe
romper la otra.

- **Puntos de entrada distintos**: `app.py` (y `launch.py` por encima) siguen siendo el punto de
  entrada de la vía técnica, sin cambios de comportamiento. `desktop_app.py` es el punto de
  entrada nuevo, exclusivo del `.exe` — arranca Flask en un hilo de fondo (`host="127.0.0.1"`, no
  `"0.0.0.0"` como `launch.py`: el único cliente es la propia ventana/navegador local, no hace
  falta exponerlo a la LAN) y muestra el dashboard.
- **`backend/paths.py`**: en un `.exe` de PyInstaller en modo `--onefile`, `sys._MEIPASS` es una
  carpeta temporal **nueva en cada arranque** — sirve para leer recursos empaquetados de solo
  lectura (`static/`, `VERSION`), pero NUNCA para datos que deban persistir entre sesiones
  (`config.json`, `logs/`, `data/`), que se perderían en cuanto se cerrara la app. Por eso hay dos
  funciones: `base_dir()` (datos de usuario que deben sobrevivir — carpeta del propio `.exe`
  cuando `sys.frozen`, raíz del repo en desarrollo) y `resource_dir()` (recursos de solo lectura
  empaquetados — `sys._MEIPASS` cuando `sys.frozen`, raíz del repo en desarrollo). `app.py` y
  `backend/reconciliation_store.py` se actualizaron para usarlas en vez de rutas relativas fijas.
  En desarrollo (`python app.py`/`launch.py`) ambas apuntan a la raíz del repo, exactamente igual
  que antes de introducir este fichero -- verificado que la vía técnica no cambia de
  comportamiento.
- **`build_exe.spec`**: genera el `.exe` en modo `--onefile` (un único fichero) porque el objetivo
  explícito es "un único ejecutable, doble clic, sin instalar nada" -- el arranque algo más lento
  de `--onefile` (autoextracción a una carpeta temporal en cada arranque) es un precio aceptable
  frente a la simplicidad de un solo fichero que descargar y mover. Empaqueta `static/` y
  `VERSION` como datos de solo lectura; `backend/` no hace falta listarlo, PyInstaller sigue
  automáticamente los `import backend.xxx` de `app.py`. `console=False` (sin ventana de consola)
  porque el logging de diagnóstico ya va también a `logs/app.log` (ver "Logging de diagnóstico"
  más arriba) -- no hace falta una consola visible para depurar.
- **`requirements-desktop.txt`**: dependencias extra (`pyinstaller`, `pywebview`) SOLO para
  generar el `.exe`, separadas de `requirements.txt` -- un usuario de la vía técnica no necesita
  instalar WebView2/pywebview para nada. Usado por el workflow de GitHub Actions (ver más abajo).
- **Ventana nativa (pywebview) en vez de navegador — decisión de diseño**: se usa la ventana con
  marco por defecto de pywebview (sin `frameless=True`), no una sin barra de título. La API
  pública de pywebview no ofrece un modo intermedio real de "solo ocultar la barra de título pero
  conservar los botones de sistema" -- min/maximizar/cerrar se dibujan DENTRO de esa misma barra a
  nivel de sistema operativo, así que la única forma de conservarlos sin la barra de título sería
  reimplementar a mano el área no cliente de la ventana con la API de Win32 (`WM_NCHITTEST`,
  DWM...), con una complejidad y un mantenimiento equivalentes a la opción `frameless` completa
  que se quería evitar (habría que dibujar los tres botones a mano de todos modos). El marco por
  defecto ya cumple el objetivo real (que no lo parezca un navegador): WebView2 no dibuja barra de
  direcciones, pestañas ni marcadores -- solo quedan el título y los controles de sistema
  estándar, exactamente como cualquier app nativa de Windows. Verificado visualmente (captura de
  pantalla real durante el desarrollo, no conservada) y por logs: la ventana abre sin marco de
  navegador y el dashboard funciona dentro exactamente igual que en el navegador de la vía técnica
  (mismos `static/`, mismas rutas Flask -- no hay dos caminos de código distintos para servir la
  UI).
- **`updater.py`**: auto-actualización del `.exe` vía la API de GitHub Releases
  (`GET /repos/p92camcj/money-manager-dashboard/releases/latest`), no vía git (no hay repo local
  en la máquina de un amigo). Solo se activa si `sys.frozen` (nunca en modo desarrollo). Compara
  el tag del último Release (`vX.Y.Z.W`) con el `VERSION` empaquetado; si hay uno más nuevo,
  descarga el asset `MoneyManagerDashboard.exe` a `<exe>.new` y se auto-reemplaza. Cualquier fallo
  (sin internet, GitHub no responde, el Release no tiene el asset esperado...) se registra y la
  función retorna sin más -- nunca bloquea el arranque ni lanza una excepción hacia arriba.

  **Patrón de auto-reemplazo en Windows -- script auxiliar de PowerShell, no `.bat`/`cmd.exe`**:
  un proceso no puede sobreescribir su propio `.exe` en ejecución, así que se genera un script
  auxiliar que espera a que el proceso actual termine, mueve el `.exe` nuevo sobre el viejo, lo
  relanza, y se autoborra. Es PowerShell -- no la primera opción probada -- porque varias rondas
  de pruebas reales con `.bat`/`cmd.exe` fallaron de formas no evidentes por escrito: `timeout`
  dentro de un `cmd.exe` sin consola real falla y retorna al instante en vez de esperar de
  verdad (rompe el ritmo de los reintentos), y el `start` de cmd.exe para relanzar el `.exe` final
  se quedaba colgado sin arrancar Flask bajo ciertas combinaciones de banderas de creación de
  proceso. Los cmdlets de PowerShell (`Start-Sleep`, `Move-Item`, `Start-Process`) no tienen esas
  dependencias. Detalles verificados con pruebas reales, ver `_spawn_replace_and_exit()`:
  - Se espera a que desaparezcan TANTO `os.getpid()` como `os.getppid()`: en un `.exe --onefile`
    de PyInstaller, el PID interno (el que ve Python) no es necesariamente el mismo proceso que
    retiene más tiempo el bloqueo del propio fichero -- el bootloader "externo" (padre del
    anterior) también cuenta.
  - El reemplazo es en dos pasos -- renombrar el viejo a un lado (`Move-Item` a `<exe>.old`) y
    luego mover el nuevo al nombre ya vacío -- nunca una sustitución directa del nuevo sobre el
    viejo: Windows permite renombrar un `.exe` en ejecución (se abre con `FILE_SHARE_DELETE`)
    pero no sobreescribir su contenido en el mismo nombre mientras siga mapeado como imagen.
  - El proceso PowerShell se lanza con `CREATE_NEW_CONSOLE` (una consola real, que el propio
    script oculta a sí mismo nada más arrancar con una llamada a `ShowWindow`/`GetConsoleWindow`
    vía P/Invoke) -- ni `DETACHED_PROCESS` ni `CREATE_NO_WINDOW` funcionaron de forma fiable en
    pruebas reales para esta combinación concreta (proceso padre = `.exe` congelado de
    PyInstaller, con `console=False`).
  - **Limitación conocida y aceptada, no un bug**: incluso con lo anterior correcto, el primer
    arranque del `.exe` recién sustituido puede tardar bastante más de lo esperado (se ha
    observado hasta varios minutos en pruebas reales) antes de responder por primera vez --
    verificado que NO es un cuelgue del propio mecanismo (el mismo `Start-Process` sobre un `.exe`
    que ya llevara un rato en disco, sin acabar de escribirse, arranca en segundos) sino, con toda
    probabilidad, el análisis en tiempo real de Windows Defender sobre un ejecutable recién
    escrito en disco, sin firma digital y nunca visto antes en esa ruta -- el mismo motivo por el
    que SmartScreen avisa en la descarga manual (ver `README_AMIGOS.md`). No hay forma de evitarlo
    desde el código sin firmar digitalmente el `.exe` (fuera de alcance de esta tarea, coste de un
    certificado de terceros -- ver propuesta pendiente en `BACKLOG.md`). Por eso los reintentos de
    `Move-Item` usan un presupuesto generoso (hasta 5 minutos) en vez de uno corto.
- **Disparador de GitHub Actions**: push de un tag `v*` (p.ej. `v0.8.0.30`) -- el disparador más
  simple de mantener (no depende de proteger ninguna rama ni de aprobar manualmente un workflow),
  y encaja de forma natural con el propio formato de versión `X.Y.Z.W` ya usado en `VERSION`. El
  workflow compila en `windows-latest` (única plataforma soportada por esta vía) con
  `requirements-desktop.txt` + `build_exe.spec`, y publica `dist/MoneyManagerDashboard.exe` como
  asset de un Release con ese mismo tag -- el asset se llama igual (`MoneyManagerDashboard.exe`)
  en cada Release para que `updater.py` no tenga que descubrir el nombre dinámicamente.

## Versionado

Formato `X.Y.Z.W`, constante `APP_VERSION` expuesta en `app.py` (o fichero `VERSION` en la raíz,
ambos deben coincidir — `app.py` lee `VERSION` como fuente única). Se expone en `GET /api/version`
y se muestra en el footer del frontend.

- **W** (build): nunca se incrementa a mano. Justo antes de un commit que vaya a quedar como
  entrega, ejecuta `git rev-list --count HEAD` y usa ese número literal como W.
- **Z** (patch): corrección o mejora interna sin funcionalidad nueva visible para el usuario.
- **Y** (minor): funcionalidad nueva visible para el usuario. Al subir Y, reinicia Z a 0.
- **X** (major): nunca se sube salvo petición explícita del usuario.
- Ante cualquier duda sobre si un cambio es X/Y/Z, preguntar antes de decidir — no asumir.

Cada tarea cerrada con cambios de código añade una entrada a `CHANGELOG.md` con versión, fecha y
qué cambió, y su propio commit (no se amontonan varias tareas en un commit).

**⚠️ Subir `VERSION` implica SIEMPRE crear y pushear el tag `vX.Y.Z.W` en el mismo cierre de
tarea — no es un paso aparte que haya que pedir por separado.** Detectado el 2026-07-19: dos
commits (`9d44952` v0.8.2.29, `20f3088` v0.8.3.30) subieron `VERSION` y se pushearon sin su tag
correspondiente, y como el workflow de `.github/workflows/build-release.yml` **solo** se dispara
con el push de un tag `v*` (ver "Distribución con ejecutable de Windows" más abajo), ambas
versiones quedaron silenciosamente sin `.exe` publicado — nadie en la vía `.exe` (Propuesta #6)
recibió esos fixes hasta que se detectó el hueco y se crearon los tags a posteriori. El commit en
sí NUNCA dispara la build; solo el tag lo hace. Por tanto, para cualquier cambio que suba
`VERSION` y deba llegar a los usuarios del `.exe`:

1. Commit con el bump de versión (como ya se hacía).
2. `git tag vX.Y.Z.W <commit>` + `git push origin vX.Y.Z.W` — en el mismo cierre de tarea, no
   como seguimiento posterior.
3. Verificar que el workflow terminó en verde y que el Release quedó publicado con el `.exe`
   adjunto (`gh run list` / `gh release list`) — no dar la tarea por cerrada solo porque el push
   del tag no dio error; hay que comprobar que la build realmente completó.

Esto se da por incluido en cualquier cierre de tarea con bump de versión, salvo que el usuario
diga explícitamente lo contrario (p. ej. "commitea esto pero no lo publiques todavía").

## Seguimiento de bugs y propuestas: `BACKLOG.md`

Los bugs detectados que no se arreglan en el momento, y las propuestas de mejora que surgen en
conversación, se anotan en `BACKLOG.md` (raíz del repo) — no deben quedar solo en el historial de
chat. Al resolver algo de ahí, se marca como resuelto (fecha + commit) en el mismo commit que lo
cierra, nunca se borra sin más. Revisa ese fichero al empezar una sesión nueva para tener contexto
de qué queda pendiente.

## Comandos

### Entorno

```bash
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

### Arrancar la app

```bash
python app.py            # arranca Flask en http://localhost:5000, debug=True
```

O usando el lanzador de doble clic (ver `launch.py`, `launch.bat`, `launch.command`): antes de
arrancar Flask, comprueba actualizaciones del repositorio (`check_for_updates()` — `git fetch` +
`git pull --ff-only` si el remoto tiene commits nuevos, nunca bloquea el arranque si falla o hay
cambios locales) y la conexión con el móvil, y abre el navegador automáticamente.

### Scripts de prueba contra el móvil

Requieren que el móvil esté en la misma WiFi con PC Manager activo, y la IP correcta en
`config.json` (o hardcodeada temporalmente en el propio script de prueba, nunca en `app.py`).

```bash
python test_post.py          # crea una transacción de prueba directamente contra el móvil
python check_post.py         # verifica que esa transacción de prueba se guardó
python test_nonexistent.py   # comprueba el comportamiento del servidor ante un endpoint inexistente
python reference/download_mm.py   # re-descarga el JS del PC Manager a reference/all_mm.js
```

Estos scripts pegan a la IP del móvil directamente (no pasan por Flask) — son para depurar la API
real, no para probar el backend propio.
