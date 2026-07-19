# Changelog

Formato de versión: `X.Y.Z.W` (ver reglas de incremento en `CLAUDE.md`).

## 0.8.0.25 - 2026-07-19

Nueva funcionalidad visible (Propuesta #6, resuelta en `BACKLOG.md`): segunda vía de
distribución con un único ejecutable de Windows, pensada para alguien sin conocimientos
técnicos. Convive con la vía técnica (git clone + venv, Propuesta #2) sin sustituirla.

- **Empaquetado con PyInstaller** (`build_exe.spec`, modo `--onefile`): nuevo punto de entrada
  `desktop_app.py`. `backend/paths.py` separa `base_dir()` (datos que deben persistir entre
  arranques -- `config.json`, `logs/`, `data/` -- carpeta del propio `.exe` cuando está
  empaquetado) de `resource_dir()` (recursos de solo lectura empaquetados -- `static/`,
  `VERSION`); `sys._MEIPASS` de un `.exe --onefile` es una carpeta temporal nueva en cada
  arranque, así que los datos de usuario no podían vivir ahí. Sin cambio de comportamiento para
  la vía técnica. `requirements-desktop.txt` separado de `requirements.txt`.
- **Ventana nativa con pywebview** en vez de navegador: `desktop_app.py` arranca Flask en un hilo
  de fondo y muestra el dashboard en una ventana propia (WebView2), sin barra de direcciones ni
  pestañas de navegador. Se usa el marco por defecto de pywebview (con título y controles de
  sistema estándar) en vez de `frameless=True` -- la API pública de pywebview no ofrece un modo
  intermedio real de "solo ocultar la barra de título pero conservar los botones de sistema", y
  reimplementarlo a mano (Win32/DWM) tendría el mismo mantenimiento que dibujar los controles a
  mano en modo frameless. Detalle en `CLAUDE.md`.
- **Auto-actualización vía GitHub Releases** (`updater.py`): al arrancar el `.exe`, comprueba la
  última release publicada y, si es más nueva que el `VERSION` empaquetado, se descarga y
  auto-reemplaza (patrón de script `.bat` auxiliar que espera a que el proceso actual termine,
  mueve el `.exe` nuevo sobre el viejo, y lo relanza). Nunca bloquea el arranque si falla la
  comprobación (sin internet, GitHub no responde...).
- **GitHub Actions** (`.github/workflows/build-release.yml`): compila el `.exe` en
  `windows-latest` y lo publica como asset de un Release al hacer push de un tag `v*`.
- **`README_AMIGOS.md`**: guía de instalación sin terminología técnica (descargar, doble clic,
  aviso de Windows SmartScreen), sin mencionar en ningún punto "navegador".

Verificado compilando y ejecutando el `.exe` real en cada bloque (no solo que compilara): arranca,
persiste `config.json`/`logs/` junto al propio ejecutable, sirve el dashboard igual que en modo
navegador (probado con un extracto real de `samples/` vía `/api/analyze-excel`), abre en una
ventana sin marco de navegador, y el auto-actualizador se probó tanto contra la API real de
GitHub (sin conexión / sin releases publicados) como con una actualización simulada de principio
a fin. Detalle completo de cada verificación en los commits de cada bloque y en `CLAUDE.md`.

## 0.7.1.18 - 2026-07-19

Fix: filtro estricto de una sola cuenta introducía falsos negativos con movimientos de tarjeta
(Bug #3, regresión sobre la Propuesta #5).

- **Diagnóstico confirmado con datos reales** (móvil conectado en esta sesión): las tarjetas
  vinculadas a una cuenta (p.ej. una tarjeta de débito) tienen su propio `assetId` + un campo
  `linkAssetId` que apunta al `assetId` de la cuenta madre. Sobre 1165 transacciones reales de 7
  meses, 591 usaban el `assetId` de una cuenta directamente y 218 el de una tarjeta vinculada a
  otra cuenta — Money Manager no es consistente sobre cuál usa para cada movimiento, así que un
  extracto bancario de una cuenta que mezcla ambos tipos rompía el filtro estricto de una sola
  cuenta introducido en la Propuesta #5.
- **Selector de cuenta por fichero, de único a multi-selección**: al marcar una cuenta se
  auto-marcan sus tarjetas vinculadas (vía `linkAssetId`), editable después. `accountIds` pasa de
  un valor por fichero a una lista (separada por comas en el form-data).
- **Matching en dos fases** en `match_bank_transactions()`: fase 1 (prioritaria) filtra
  estrictamente por las cuentas/tarjetas seleccionadas, igual que antes; fase 2 (fallback), solo
  si una línea del banco no encuentra NINGÚN candidato en fase 1, repite la búsqueda sin el
  filtro de cuenta en vez de declararla "nuevo" directamente. El resultado se marca
  `account_fallback: true` — badge "⚠️ Fuera de la cuenta esperada" en el frontend, distinto de
  un match normal, para que el usuario lo revise con más atención antes de confirmar.
- **Verificado con datos reales, antes vs. después** (no solo "debería funcionar"): fichero real
  de `samples/` (`casa_julio_250626-180726.xls`, 102 líneas) contra datos reales del móvil,
  asociando solo la cuenta (reproduciendo el bug) — antes: 42 falsos "nuevo" de 102 líneas
  (`{'exact_match': 25, 'new': 42, 'suggested_match': 5, 'probable_match': 28}`); después: solo 4
  "nuevo" genuinos (`{'exact_match': 60, 'new': 4, 'suggested_match': 6, 'probable_match': 30}`,
  38 recuperados por fallback). Con cuenta + tarjeta autosugeridas, solo 9 de esos 38 necesitan
  fallback (el resto se resuelve directamente en fase 1). Sin regresión en los 7 ficheros de
  `samples/` sin cuenta asociada, ni en el matching de transferencias (Propuesta #5) con
  `account_ids` como lista. Detalle completo en `CLAUDE.md` y `BACKLOG.md` (Bug #3, resuelto).

## 0.7.0.17 - 2026-07-18

Preparación del proyecto para distribución pública (Propuesta #2): repo público, config.json
fuera de git, y auto-actualización en el lanzador.

- **Auditoría de seguridad del historial completo de git** antes de cambiar la visibilidad:
  único hallazgo, la IP de WiFi local (`192.168.5.248:8888`) en `config.json`, presente desde el
  primer commit del repo. Sin rastro de `samples/`, `data/`, `.env`, tokens ni credenciales en
  ningún commit del historial. Decisión (con el usuario): no reescribir el historial —
  es una IP de LAN no accesible desde fuera de la propia WiFi, no un secreto real — y en su lugar
  dejar de rastrear `config.json` a partir de ahora (ver siguiente punto).
- **Repositorio de GitHub cambiado a público** (`p92camcj/money-manager-dashboard`), tras
  completar la auditoría.
- **`config.json` fuera del control de versiones**: añadido a `.gitignore`, `git rm --cached`
  (el fichero local no se toca), nuevo `config.example.json` como plantilla. `get_config()` en
  `app.py` crea `config.json` automáticamente en el primer arranque con un valor de ejemplo
  genérico (`192.168.1.100:8888`, ya no la IP real del autor) si no existe, para que un usuario
  nuevo no tenga que crearlo a mano antes de configurar su IP real desde la pestaña Ajustes.
  `launch.py` usa el mismo placeholder genérico.
- **Auto-actualización en `launch.py`**: antes de arrancar Flask, comprueba si hay commits
  nuevos en el remoto (`git fetch` + comparación con `@{u}`) y los descarga (`git pull
  --ff-only`) si los hay. Nunca bloquea el arranque: sin conexión, sin remoto configurado, o
  cambios locales que impidan un fast-forward limpio, avisa por consola y arranca igual con la
  versión local. Al actualizar, informa de la versión anterior y la nueva y muestra el bloque
  correspondiente de `CHANGELOG.md`. Verificado con un sandbox git aislado cubriendo los 5 casos
  (actualización real, ya al día, conflicto local, remoto inalcanzable, carpeta sin git).
- **`README.md`** reescrito con una sección de instalación completa para alguien sin contexto
  previo del proyecto (clonar, venv, requirements, primer arranque, configurar IP desde Ajustes,
  cómo funciona la auto-actualización en el uso diario).
- `BACKLOG.md`: Propuesta #2 marcada como resuelta.

## 0.6.0.12 - 2026-07-18

Conciliación bancaria: cuenta asociada por fichero y matching de transferencias entre bancos
(Propuesta #5, ampliación de la Propuesta #3).

- Cada fichero subido puede asociarse opcionalmente a una cuenta real de Money Manager (nuevo
  selector junto a la etiqueta, poblado con `assetsData`). `/api/analyze-excel` acepta `accountIds`
  en el form-data (mismo orden que `files`, vacío si no se asocia ninguna).
- `match_bank_transactions()` (`backend/reconciliation.py`) acepta un `account_id` opcional: con
  cuenta asociada, filtra estrictamente los candidatos a esa cuenta (menos falsos positivos entre
  cuentas con importes parecidos).
- **Transferencias entre cuentas propias reconocidas desde los dos extractos a la vez**: una
  transferencia en Money Manager es una sola transacción (`assetId` origen, `toAssetId`/
  `targetAssetId` destino), pero en dos bancos reales aparece como dos líneas (negativa en el
  origen, positiva en el destino). Con cuenta asociada en ambos ficheros, cada lado se resuelve y
  se consume por separado (`matched_origin`/`matched_destination`), así que el extracto del banco
  origen y el del banco destino encuentran la MISMA transacción de Money Manager como match, sin
  que el primero en procesarse se la "quede" — resuelve parcialmente la Propuesta #4 del
  `BACKLOG.md` (matching entre ficheros de la misma tanda) para este caso concreto.
  - Campo de cuenta destino en el XML de lectura sin verificar en vivo contra el móvil real
    (`toAssetId` vs `targetAssetId`, ambos existen en el esquema de PC Manager) — el código se
    queda con el que venga relleno; ver nota en `CLAUDE.md`.
- Cada propuesta lleva ahora `is_transfer` y `transfer_role` (`'origen'`/`'destino'`); cada
  candidato de `candidates[]` lleva su propio `is_transfer`. Frontend: badge "🔁 Transferencia
  interna" en las propuestas y candidatos afectados, para distinguirlos de un duplicado exacto
  normal.
- Verificado con datos sintéticos (script ad-hoc, no comprometido al repo) — matching por lados,
  no reutilización del mismo lado dentro de un fichero, filtro estricto por cuenta, y comportamiento
  previo intacto sin `account_id` — y de extremo a extremo con el test client de Flask simulando
  una respuesta XML de Money Manager con una transferencia real. No hay en `samples/` ningún par
  de extractos reales que compartan una transferencia todavía; pendiente de confirmar con un caso
  real cuando aparezca.
- `BACKLOG.md`: Propuesta #4 marcada como resuelta parcialmente; nueva Propuesta #5 (resuelta).

## 0.5.0.11 - 2026-07-18

Conciliación bancaria: subida múltiple con etiqueta por fichero (Bloque 2 de Propuesta #3).

- `/api/analyze-excel` acepta varios ficheros a la vez (`files`+`labels`, mismo orden; etiqueta
  vacía → nombre de fichero). Un solo `getDataByPeriod` con el rango de fechas combinado de todos
  los ficheros de la tanda, en vez de una llamada al móvil por fichero.
- Matching independiente por fichero (limitación conocida documentada en `BACKLOG.md`, Propuesta
  #4: un movimiento que aparezca en dos extractos a la vez, p.ej. una transferencia entre cuentas
  propias, puede proponerse como "nuevo" en ambos — no resuelto en este cambio).
- Respuesta cambiada de array plano a `{"proposals": [...], "file_errors": [...]}`: si un fichero
  de la tanda no tiene estructura reconocible, se reporta y se sigue con el resto en vez de abortar
  toda la subida.
- Frontend: selección múltiple de ficheros con lista previa de etiquetas editables antes de
  confirmar la subida, badge de etiqueta de origen en cada propuesta, filtro por etiqueta.
- **Bug real encontrado en las pruebas y corregido en este mismo commit**: `pd.to_datetime(...,
  dayfirst=True)` interpreta mal fechas ISO en pandas 3.0.3 (`'2026-07-08'` → 7 de agosto en vez
  de 8 de julio, sin ambigüedad real en el string). Nueva `parse_bank_date()` compartida
  (ISO8601 primero, `dayfirst=True` como fallback), usada en `reconciliation.py` y `app.py`.
- Verificado en navegador real (Playwright) con 3 ficheros mezclados (Cajasur Excel + Revolut CSV
  + BBVA Excel): 93 propuestas, etiquetas y filtro correctos, fechas correctas tras el fix.
- `BACKLOG.md`: Propuesta #3 marcada como resuelta; nueva Propuesta #4 (matching cross-fichero)
  anotada como pendiente.

## 0.4.0.10 - 2026-07-18

Conciliación bancaria: soporte CSV (Bloque 1 de Propuesta #3).

- `backend/bank_excel_parser.py` renombrado a `backend/bank_statement_parser.py`
  (`parse_bank_excel()` → `parse_bank_statement()`, `BankExcelFormatError` →
  `BankStatementFormatError`) — ya no es solo para Excel.
- Misma detección de cabecera y mapeo de columnas por alias que Excel, reutilizada tal cual; solo
  cambia cómo se lee el fichero en bruto según la extensión (`_read_raw()`).
- CSV leído con `csv.reader` (no `pandas.read_csv` directo) para tolerar filas de metadatos con
  menos columnas que la cabecera real, igual que ya se toleraba en Excel — encontrado con un test
  sintético antes de llegar a producción. Delimitador detectado con `csv.Sniffer` (coma, punto y
  coma, tabulador...), encoding probado en orden `utf-8-sig` → `cp1252` → `latin-1`.
- Nuevos alias para Revolut: `"fecha de inicio"` → fecha, `"fecha de finalización"` → fecha_valor
  (ignorada, ya existía el campo).
- Verificado end-to-end contra los 6 Excel de `samples/` + `revolut.csv` real (3/3 filas válidas) —
  los 7 correctos vía `/api/analyze-excel` (Flask test client, sin conexión al móvil).

## 0.3.0.9 - 2026-07-18

Conciliación bancaria multi-banco: ya no asume el formato de Cajasur.

- Nuevo `backend/bank_excel_parser.py`: detecta la fila de cabecera real y mapea columnas por
  alias normalizado (fecha/concepto/importe/cargo/abono) en vez de por posición fija — distingue
  fecha de operación de fecha valor cuando ambas existen. Combina cargo/abono en un único importe
  con signo si el banco los separa en dos columnas.
  - Si no reconoce la estructura del Excel, `analyze_excel()` responde `400` con un mensaje claro
    (`BankExcelFormatError`) en vez de asumir algo silenciosamente incorrecto.
- `app.py::analyze_excel()` reescrito para usar el nuevo parser — eliminados `detect_header_row()`
  y el mapeo posicional fijo (`base_cols`) que solo funcionaba por casualidad para Cajasur.
- Añadido `openpyxl` a `requirements.txt` (necesario para leer `.xlsx`, no solo `.xls`).
- Verificado contra los 6 extractos reales de `samples/`: Cajasur (x2), BBVA, EVO cuenta, EVO
  tarjeta y Sabadell — los 6 detectados correctamente end-to-end vía `/api/analyze-excel`. El caso
  cargo/abono separado solo se probó con un test sintético (ningún banco de `samples/` lo usa).
- `BACKLOG.md`: Propuesta #1 marcada como resuelta.

## 0.2.2.8 - 2026-07-18

Nuevo `BACKLOG.md`: seguimiento centralizado de bugs pendientes y propuestas de mejora.

- Se buscó a fondo (historial completo de git, árbol de trabajo con ficheros gitignorados,
  carpeta `Documents/GitHub`) un `.md` de propuestas anteriores que se creía existente; no se
  encontró ninguno — el documento se crea desde cero.
- Recoge Bug #1 (fallo de conexión con el móvil tratado como "cero transacciones" válidas), Bug #2
  (categoría/subcategoría no se guardan al crear desde "Pre-rellenar y Añadir"), Propuesta #1
  (generalizar parseo de Excel a otros bancos) y Propuesta #2 (distribución a amigos con
  auto-actualización vía `git pull`) — ninguno implementado en este commit, solo documentado.
- `CLAUDE.md` referencia el nuevo fichero para que quede visible al empezar sesiones futuras.

## 0.2.1.7 - 2026-07-18

Logging a fichero (causa real de que no se viera nada en terminal) y fix de "Ver Registro Asociado".

- El fix anterior de `sys.stdout.reconfigure` no fue suficiente: la consola de Windows puede
  congelar toda la salida nueva por QuickEdit Mode (al hacer clic dentro de la ventana), entre
  otros motivos fuera de nuestro control. Sustituidos todos los `print()` de diagnóstico por un
  `logger` con dos salidas: consola y `logs/app.log` (rotado, gitignorado) — el fichero siempre
  tiene el historial aunque la consola no muestre nada nuevo.
- **Bug real encontrado**: `showTransaction()` referenciaba `#searchInput` y `.tab-btn`, IDs/clases
  que ya no existen en `index.html` (restos de una iteración anterior de la UI) — reventaba con
  `TypeError` en cuanto se pulsaba "Ver Registro Asociado", exista o no la transacción. Corregido
  a `#filterSearch` y `switchTab('transactions')`. Verificado en navegador real contra datos reales.
- Cache-busting `script.js` v10→v11.

## 0.2.0.6 - 2026-07-18

Nueva funcionalidad: persistencia local de conciliaciones confirmadas.

- Confirmar un match ("Confirmar Este" sobre un candidato ambiguo) ahora escribe en
  `data/reconciliations.json` (local, gitignorado, fuera del proyecto versionado) — sigue sin
  escribir nada en Money Manager, solo recuerda la decisión del usuario.
- `backend/reconciliation_store.py`: clave estable por hash de fecha+importe+descripción
  normalizada (`make_key`), y helpers de lectura/escritura del almacén.
- Nuevo endpoint `POST /api/reconciliations/confirm`. `confirmMatch()` en el frontend pasó de ser
  un `alert()` local a llamar de verdad al backend.
- `/api/analyze-excel` sobreescribe el resultado del matching heurístico con un nuevo estado
  `reconciled` para cualquier línea que ya tenga una confirmación guardada — así no se vuelve a
  presentar la misma ambigüedad al recargar un Excel que se solape en fechas con uno ya revisado.
  Nuevo badge "Ya Conciliado" en el frontend, distinto de "Nuevo Movimiento" y "Posible Coincidencia".
- Diseño documentado en `CLAUDE.md` antes de implementar, incluida la limitación conocida: dos
  movimientos con fecha+importe+descripción idénticos comparten clave (no hay ID nativo en el
  extracto bancario).
- De paso, definidas en CSS las clases `.badge-danger/warning/success/info` que ya se usaban en
  JS pero nunca tuvieron estilo propio.

## 0.1.4.5 - 2026-07-18

Investigaciones de diagnóstico de la conciliación: logging no visible y "Ver Registro Asociado"
sin efecto.

- **stdout con buffering por bloques**: confirmado que el proyecto no usa `app.logger` en
  ningún sitio (descartada la hipótesis de nivel WARNING en modo no-debug); el problema real es
  que `sys.stdout` puede quedar en block-buffering cuando Flask se lanza vía `launch.py` en vez
  de una terminal interactiva, reteniendo los `print()` de diagnóstico indefinidamente en un
  servidor de larga duración. `app.py` y `launch.py` fuerzan ahora
  `sys.stdout.reconfigure(line_buffering=True)` al arrancar.
- **Cache-busting**: subido `style.css?v=8→9` y `script.js?v=8→9` en `index.html` para que el
  navegador no sirva versiones cacheadas de los fixes de la conciliación de este mismo día.
- Cierra también el bug de `skiprows` hardcodeado en `/api/analyze-excel` (sustituido por
  detección dinámica de cabecera) y el parseo robusto de importes con coma decimal española,
  ya verificados con datos reales en una sesión anterior pero pendientes de commit hasta ahora.

## 0.1.3.4 - 2026-07-18

Dos bugs reales en `backend/reconciliation.py` detectados al investigar por qué la conciliación
no reconocía movimientos.

- **Tolerancia de importes**: la comparación de importes usaba igualdad exacta de float
  (`abs(a) == abs(b)`), lo que producía falsos negativos por precisión de punto flotante. Ahora
  usa `np.isclose(..., atol=0.01)` (tolerancia de 1 céntimo).
- **ID real de Money Manager en vez de posición de DataFrame**: `suggested_mm_ref` y
  `candidates[].id` devolvían el índice posicional interno de pandas en vez del `id` (UUID) real
  de la transacción, rompiendo silenciosamente "Ver Registro Asociado" y `confirmMatch` en el
  frontend. `static/script.js` actualizado para tratar esos IDs como strings (UUID con guiones,
  no enteros) en los `onclick`.

## 0.1.2.3 - 2026-07-18

Estética del scrollbar acorde al glassmorphism.

- `scrollbar-width`/`scrollbar-color` (Firefox) y `::-webkit-scrollbar` (Chrome/Edge/Safari) con
  esquinas redondeadas y degradado azul/violeta acorde a la paleta del resto del dashboard.

## 0.1.1.2 - 2026-07-18

Corrige la posición del footer con la versión.

- `body` pasa a `flex-direction: column`, así `.app-footer` queda apilado y centrado debajo del
  panel principal en vez de aparecer como un elemento lateral roto por el layout en fila.

## 0.1.0.1 - 2026-07-18

Formalización inicial del proyecto.

- Añadido `CLAUDE.md` con arquitectura, referencia de la API del móvil (endpoints
  `moneyBook/...`, formato XML/JSON, mapeo de `payType`/`mbCategory`/`subCategory`/`assetId`,
  inconsistencia detectada entre `inOutCode` de lectura y escritura) y convención de conciliación
  manual (nunca auto-conciliar con candidatos ambiguos).
- Añadido versionado: fichero `VERSION`, endpoint `GET /api/version`, versión visible en el
  footer del frontend.
- Añadido `CHANGELOG.md` (este fichero).
- Inicializado repositorio git, `.gitignore` para Python (`venv/`, `__pycache__/`, `*.pyc`,
  `.env`, `samples/`), y repo privado en GitHub.
- Creado entorno virtual `venv/` con las dependencias de `requirements.txt`.
- Añadido lanzador de doble clic (`launch.py`, `launch.bat`, `launch.command`) que comprueba
  conexión con el móvil antes de arrancar Flask y abre el navegador automáticamente.
