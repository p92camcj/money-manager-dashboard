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
                       función, no reintroduzcas esa confusión entre posición e id real. Acepta un
                       `account_id` opcional (el `assetId` de Money Manager asociado al fichero
                       bancario, elegido en el frontend) — ver "Matching acotado por cuenta y
                       transferencias entre bancos" más abajo.
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
                              (opcional, MISMO orden que `files` — el `assetId` de Money Manager
                              que el usuario asoció a ese fichero en el selector del frontend;
                              cadena vacía si no se asoció ninguna). Cada fichero se parsea con
                              backend/bank_statement_parser.py::parse_bank_statement() (ver
                              sección dedicada). Se calcula el rango de fechas COMBINADO de
                              todos los ficheros de la tanda y se hace una única llamada a
                              `getDataByPeriod` — no una por fichero. El matching
                              (`match_bank_transactions`) se hace por SEPARADO para cada fichero
                              contra ese mismo conjunto de transacciones del móvil, pasando el
                              `account_id` de ese fichero si lo tiene (ver "Matching acotado por
                              cuenta y transferencias entre bancos" más abajo). Sin cuenta
                              asociada en ningún fichero de la tanda, dos ficheros siguen sin
                              enterarse el uno del otro (limitación conocida, ver `BACKLOG.md` —
                              un movimiento que aparezca en dos extractos a la vez, p.ej. una
                              transferencia entre cuentas propias, puede proponerse como "nuevo"
                              en ambos). Cada propuesta lleva `source_label` y `source_filename`,
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
  /api/budget-hierarchy    -> pide transacciones + resumen de presupuesto al móvil, llama a BudgetEngine
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

**`create`/`update` aceptan NOMBRES, no IDs, para `payType`, `mbCategory` y `subCategory`** — hay
que mandar el texto exacto tal cual aparece en Money Manager (incluyendo emojis), no un
identificador interno. Ejemplo real verificado (`test_post.py`):

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

**⚠️ Inconsistencia detectada entre `inOutType`/`inOutCode` de lectura y escritura — sin resolver:**

- En **lectura** (XML de `getDataByPeriod`), `inOutType` es `"Ingreso"` / `"Gasto"` / `"Transferencia"`.
- En **escritura** (`static/script.js:submitTransaction`), se traduce a otro vocabulario antes de
  mandarlo:
  ```js
  inOutTypeMap = {'Gasto': 'Egreso', 'Ingreso': 'Ingreso', 'Transferencia': 'Transfer'}
  inOutCodeMap = {'Gasto': '1', 'Ingreso': '2', 'Transferencia': '3'}
  ```
- Pero el propio JS original del móvil (`reference/moneybook.js`) usa códigos distintos al filtrar
  por pestaña: `inOutCode "0"` = Ingreso, `inOutCode "1"` = Gasto, y `"2"/"3"/"4"/"7"/"8"` para
  movimientos de activos/transferencias (varios códigos, no uno solo).
- No hay certeza de cuál mapeo es el correcto para `create`/`update` sin probarlo en vivo contra el
  móvil. Si tocas código de creación/edición de transacciones, **verifica contra el móvil real**
  antes de asumir que el mapeo actual de `script.js` es correcto, y actualiza esta sección con lo
  que confirmes.

`delete` espera `ids` con prefijo `:` — ejemplo: `ids=:<id_transaccion>`.

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

### Matching acotado por cuenta y transferencias entre bancos

Al etiquetar cada fichero subido (ver `/api/analyze-excel` más arriba), el usuario puede además
asociarle **opcionalmente** una cuenta real de Money Manager (`accountIds` en el form-data,
`account_id` en `match_bank_transactions()`) desde un selector poblado con `assetsData` en el
frontend (`flattenAssets()` en `script.js`). Sin cuenta asociada, el comportamiento es exactamente
el de antes (búsqueda sin filtrar por cuenta, una transferencia se consume una sola vez en
conjunto — ver Propuesta #4 en `BACKLOG.md`).

**Con cuenta asociada**, `match_bank_transactions()` **filtra estrictamente** — no solo prioriza —
los candidatos a esa cuenta, para reducir falsos positivos entre cuentas distintas con importes
parecidos:

- **Movimiento normal** (`inOutType` distinto de `Transferencia`): solo se consideran candidatos
  cuyo `assetId` sea `account_id`.
- **Transferencia** (`inOutType == 'Transferencia'`): una transferencia en Money Manager es UNA
  sola transacción con `assetId` = cuenta origen y `toAssetId`/`targetAssetId` = cuenta destino —
  pero en dos extractos bancarios reales (el del banco origen y el del banco destino) aparece como
  DOS líneas distintas (una negativa, una positiva). `account_id` puede coincidir con el origen o
  con el destino de la misma transacción de Money Manager; se usa el signo del importe bancario
  para decidir el lado (negativo → origen, positivo → destino) y no confundirlos. Cada lado se
  marca como "consumido" por separado (`matched_origin` / `matched_destination` en el DataFrame
  interno de `mm_df`, no un único flag `matched` como en el resto del matching) — así, la MISMA
  transacción de Money Manager puede resolverse como match desde el fichero del banco origen Y
  desde el fichero del banco destino, sin que el primero en procesarse "se quede" con ella (cada
  fichero se sigue analizando en una llamada independiente a `match_bank_transactions()`, así que
  esto funciona sin que un fichero necesite saber nada del otro). Dentro de un mismo fichero, un
  lado ya consumido no se puede reclamar dos veces (dos líneas bancarias con igual importe no
  pueden reclamar el mismo lado).
  - **Campo real de la cuenta destino sin verificar en vivo**: el esquema de columnas de PC
    Manager (`reference/all_mm.js`) declara tanto `toAssetId` como `targetAssetId`; no hay
    certeza de cuál rellena realmente el XML de `getDataByPeriod` (ver la inconsistencia ya
    documentada más arriba entre vocabulario de lectura y escritura). `match_bank_transactions()`
    se queda con el que venga relleno de los dos, sin asumir cuál es. Si compruebas contra el
    móvil real cuál es, actualiza esto.
- **Sin cuenta asociada en el fichero**: no se intenta adivinar el lado de una transferencia —
  se comporta como un movimiento normal de consumo único (comportamiento previo intacto).
- Cada propuesta resultante lleva `is_transfer` (bool) y, si aplica, `transfer_role`
  (`'origen'`/`'destino'`/`None`); cada candidato de `candidates[]` lleva su propio `is_transfer`.
  El frontend usa esto para mostrar un badge "🔁 Transferencia interna" en vez de dejar que parezca
  un duplicado exacto sin explicación.
- **Verificado solo con datos sintéticos** (no hay en `samples/` ningún par de extractos reales que
  compartan una transferencia entre bancos todavía) — ver script de verificación usado durante el
  desarrollo, no comprometido al repo. Si aparece un caso real que no encaje, revisar primero el
  campo de cuenta destino (punto anterior) antes de asumir que la lógica de lados está mal.

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
