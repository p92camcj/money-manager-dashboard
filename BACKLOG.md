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

Ninguno abierto ahora mismo — ver "Resueltos" más abajo para el histórico.

---

## Propuestas de mejora pendientes

### Propuesta #7: firmar digitalmente el .exe de la distribución "amigable"

- **Estado:** pendiente, no urgente.
- **Detectado:** 2026-07-19, durante la implementación de la Propuesta #6 (auto-actualización vía
  GitHub Releases).

El `.exe` generado por `build_exe.spec` no está firmado digitalmente (requeriría un certificado de
terceros, con coste). Dos consecuencias observadas y ya documentadas como limitaciones aceptadas,
no bugs:

1. Windows SmartScreen avisa al abrir el `.exe` descargado manualmente por primera vez (ver
   `README_AMIGOS.md`, ya con instrucciones claras de cómo continuar).
2. El auto-actualizador (`updater.py`) puede tardar bastante más de lo esperado -- se ha observado
   hasta varios minutos en pruebas reales -- en el primer arranque del `.exe` recién sustituido,
   con toda probabilidad por el análisis en tiempo real de Windows Defender sobre un ejecutable
   nunca visto antes en esa ruta exacta del disco. Ver detalle completo en `CLAUDE.md`, sección
   "Distribución con ejecutable de Windows". El mecanismo de reemplazo en sí (renombrar + mover +
   relanzar) se verificó correcto y fiable de forma aislada; el retraso ocurre después, fuera del
   control del propio código, durante el primer arranque del proceso ya relanzado.

Firmar el `.exe` (certificado de firma de código, p.ej. vía una entidad como DigiCert/Sectigo, o
las opciones más económicas de firma con reputación acumulada tipo SignPath para proyectos de
código abierto) eliminaría o reduciría mucho ambos problemas. No se ha hecho en esta tarea por ser
un coste/proceso externo al código -- queda anotado para valorar si el proyecto gana tracción.

### Propuesta #9 / Bug a investigar: confirmar una selección entre varias propuestas de match no persiste igual que un match automático

- **Estado:** pendiente de diagnóstico — no asumir que hace falta rediseñar nada antes de
  confirmar la causa.
- **Anotado:** 2026-07-19, a petición del usuario tras usar la conciliación en producción.

Ya existe el almacén de conciliaciones confirmadas (`data/reconciliations.json`, ver
"Persistencia de conciliaciones confirmadas" en `CLAUDE.md`), usado para no repetir la misma
ambigüedad al recargar un Excel que se solape en fechas con uno ya revisado. Pero al confirmar
manualmente UNA opción entre varias propuestas de un registro con dudas
(`suggested_match`/`probable_match`, donde el usuario elige entre varios `candidates`), si se
vuelve a subir el mismo Excel, ese registro vuelve a aparecer con dudas en vez de mostrarse como
`"reconciled"` ("Ya Conciliado") con el botón "Ver Registro Asociado" disponible.

Antes de tocar nada: diagnosticar si el botón de confirmar en ese flujo concreto (candidato
dentro de una lista de `candidates`, no el camino de `exact_match` único) realmente llama a
`POST /api/reconciliations/confirm` igual que el otro camino, o si es un botón distinto que no
llegó a conectarse al mismo endpoint cuando se implementó la persistencia. Probablemente sea un
bug puntual de conexión frontend→backend en ese flujo concreto, no una funcionalidad que falte
desde cero.

### Propuesta #10: "Ver Registro Asociado" como ventana modal con edición, en vez de navegar fuera de Conciliación

- **Estado:** pendiente.
- **Anotado:** 2026-07-19, a petición del usuario tras usar la conciliación en producción.

Actualmente el botón "Ver Registro Asociado" lleva a la pestaña de Transacciones con un filtro
aplicado, perdiendo el contexto de dónde estaba el usuario en su revisión de conciliación
(posición de scroll, filtro de etiqueta activo en `#proposalsFilterBar`). Debe abrir una ventana
modal superpuesta con la información del registro en su lugar, idealmente con opción de editarlo
directamente ahí (reutilizando el modal de edición de transacciones ya existente si encaja sin
fricción), y al cerrarla, el usuario debe quedar exactamente donde estaba en su revisión de
conciliación — misma posición de scroll, mismo filtro de etiqueta activo — para poder continuar
sin perder el sitio.

### Propuesta #11 (gran alcance — no resolver en el mismo commit que las #8-#10): conciliación completa tipo "full outer join" — arqueo de caja

- **Estado:** pendiente, alcance grande.
- **Anotado:** 2026-07-19, a petición del usuario tras usar la conciliación en producción.

Ahora mismo la conciliación solo resuelve un sentido: por cada fila del extracto bancario, busca
su pareja en Money Manager (banco → MM). Falta el sentido contrario: dentro de la cuenta (o
cuentas/tarjetas asociadas) y el rango de fechas del Excel subido, identificar las transacciones
de Money Manager que NO tienen ninguna fila del banco con la que hacer match — movimientos
"huérfanos" por el lado de MM (podrían ser gastos en efectivo, duplicados, errores de
introducción manual, etc.).

Objetivo final del usuario: un arqueo de caja real — descargar el extracto del banco del mes,
elegir la cuenta correspondiente en MM, y que la conciliación muestre TODO: lo que coincide, lo
que solo está en el banco (ya existe hoy), y lo que solo está en MM (no existe hoy), para poder
verificar que fechas, importes y conceptos cuadran de verdad al 100% en ambos sentidos, no solo
desde el punto de vista del banco.

Requiere:
(a) que el fichero tenga cuenta asociada (`account_ids`) para que tenga sentido delimitar el
universo de transacciones de MM a comparar — sin cuenta asociada no hay un universo acotado
contra el que buscar huérfanos;
(b) una consulta a `getDataByPeriod` acotada a esa cuenta+periodo por completo, no solo las
transacciones que ya salieron como candidatas de alguna fila del Excel (probablemente reutilizando
`build_mm_dataframe()`, ver "Matching compartido entre ficheros de la misma tanda" en
`CLAUDE.md`, ya que construye ese DataFrame completo por tanda);
(c) una nueva categoría visual en la interfaz para estos huérfanos de MM, distinta de las
categorías actuales (`exact_match`/`suggested_match`/`probable_match`/`new`), ya que
conceptualmente van en el sentido contrario (MM → banco, no banco → MM).

Es el cambio de mayor alcance de las cuatro propuestas anotadas en esta sesión — no intentar
resolverlo en el mismo commit que las Propuestas #8, #9 o #10.

---

## Resueltos

### Propuesta #8: atenuar visualmente los matches exactos, resaltar los que tienen dudas

- **Resuelto:** 2026-07-19, versión `0.9.1.35`.
- **Anotado:** 2026-07-19, a petición del usuario tras usar la conciliación en producción.

Cambio puramente visual, sin lógica de backend nueva (los estados ya venían tal cual en la
respuesta de `/api/analyze-excel`). `renderProposalsList()` en `static/script.js` asigna ahora
`status-<estado>` más `proposal-resolved` (`exact_match`/`reconciled`) o `proposal-attention`
(`suggested_match`/`probable_match`/`new`) a cada tarjeta, en vez de la clase genérica
`duplicate`/`new` que no tenía ningún CSS asociado. `static/style.css`: `.proposal-resolved`
atenúa (opacidad 0.55, importe sin negrita); `.proposal-attention` se mantiene a plena opacidad y
gana un acento de color a la izquierda a juego con su badge. `reconciled` se atenúa igual que
`exact_match` -- no lo pedía la propuesta literalmente, pero es el mismo caso conceptual (match ya
resuelto, sin necesidad de revisión).

### Bug #1: un fallo de conexión con el móvil se presenta como resultado válido

- **Resuelto:** 2026-07-19, versión `0.8.4.32`.
- **Detectado:** 2026-07-18, diagnosticado con `logs/app.log` real (ver commit `5e24930`, que
  introdujo ese logging).

`analyze_excel()`, `get_budget_hierarchy()` y el proxy genérico ya no tratan un
`ConnectionError`/`Timeout` al hablar con el móvil como "cero transacciones" válidas — devuelven
`{"mm_connection_error": true}` con HTTP 503 (504 en timeout), y `analyze_excel()` aborta ANTES de
generar ninguna propuesta de conciliación en ese caso. `updateConnectionStatus()`/
`#connectionStatus` (ya existente) se extendió, tal y como ya sugería este mismo ítem, para
reaccionar también a un fallo a mitad de sesión (no solo desde `loadData()`) — `fetchAssets`,
`fetchTransactions`, `fetchBudgets`, `fetchCategoryMap` y `confirmUploadFiles()` lo comprueban.
Detalle completo en `CLAUDE.md`, sección "Aviso de conexión perdida con el móvil".

### Propuesta #4: matching no comparte estado entre ficheros de la misma tanda

- **Resuelto en su totalidad:** 2026-07-19, versión `0.8.4.32` (ya estaba resuelto parcialmente
  desde la Propuesta #5, 2026-07-18, para el caso con cuenta asociada).
- **Detectado:** 2026-07-18, durante la implementación de subida múltiple (Propuesta #3).

Nueva `backend/reconciliation.build_mm_dataframe()` construye el DataFrame de transacciones de
Money Manager UNA SOLA VEZ por tanda y se pasa compartido (mismo objeto, mutado en el sitio) a
cada llamada de `match_bank_transactions()` de la tanda, en vez de reconstruirse desde cero por
fichero como antes. Verificado con un caso sintético real (no solo teórico): dos transacciones de
Money Manager con la misma fecha/importe, sin relación entre sí, cada una en un fichero bancario
distinto — antes, ambos ficheros proponían determinísticamente la MISMA transacción (el primer
candidato por fecha exacta, siempre el mismo si el DataFrame de partida es idéntico) y la segunda
quedaba invisible para siempre; con el DataFrame compartido, cada fichero encuentra la
transacción que le corresponde.

**Hallazgo colateral corregido en el mismo commit**: `is_transfer` en `build_mm_dataframe()`
comparaba `inOutType == 'Transferencia'`, un texto que se confirmó (2026-07-19, ver versión
`0.8.3.30`) que NUNCA aparece en datos reales (el texto real es "Dinero gastado") — `is_transfer`
era siempre `False` para transferencias reales, silenciosamente, desde que existe esta función.
Corregido a detectar por `inOutCode` ("3"/"4"). Además, sin cuenta asociada (el caso concreto que
pedía esta propuesta) el consumo por lado de una transferencia (`matched_origin`/
`matched_destination`) ahora también se decide por el signo del importe bancario en vez de
consumir siempre `matched_origin` sin distinguir — necesario para que dos ficheros SIN cuenta
asociada que traigan los dos lados de la MISMA transferencia entre cuentas propias no se
bloqueen entre sí al compartir el DataFrame. Detalle completo con 4 casos sintéticos verificados
en `CLAUDE.md`, secciones "Matching compartido entre ficheros de la misma tanda" y "Matching
acotado por cuenta y transferencias entre bancos".

### Bug #4: las transferencias internas de Money Manager no se distinguían en la tabla de Transacciones, y editarlas las rompía

- **Resuelto:** 2026-07-19, versión `0.8.3.30`.
- **Detectado:** 2026-07-19 (misma sesión de trabajo en la que se resolvió).

`renderTransactions()`/`editTransaction()` en `static/script.js` comparaban
`t.inOutType === 'Transferencia'` para detectar una transferencia, pero se confirmó contra el
móvil real (1556 transferencias históricas reales) que ese texto nunca aparece en lectura — el
valor real es `"Dinero gastado"`. La señal fiable es `inOutCode` (`"3"`/`"4"`), no el texto.
Consecuencia: las transferencias se mostraban en la tabla como si fueran Gasto/Ingreso normales
(coloreadas, con categoría/subcategoría sin sentido), y al editar una se abría el modal
clasificada como Ingreso, sin la cuenta destino.

**Hallazgo más grave, verificado creando/editando/borrando transferencias de prueba reales**: el
dashboard guardaba y editaba transferencias mandándolas a `moneyBook/create`/`update` con
`targetAssetId` — el móvil respondía `{success:true}` pero la cuenta destino se guardaba como
`null`, una transferencia rota de forma silenciosa e indistinguible de un éxito para el usuario.
El mecanismo real, extraído de `reference/all_mm.js` y verificado en vivo, es un endpoint
totalmente distinto: `moneyBook/moveAsset` (crear) / `moneyBook/modifyMoveAsset` (editar), con
campos `fromAssetId`/`toAssetId`/`moveMoney`/`moneyContent` (no `assetId`/`targetAssetId`/
`mbCash`/`mbContent`). Esto significa que cualquier transferencia creada o editada desde este
dashboard antes de este fix pudo perder su vínculo con la cuenta destino, sin ningún aviso.

Detalle completo del mecanismo verificado (incluida la peculiaridad de que el `id` de una
transferencia cambia tras cada edición) en `CLAUDE.md`, sección "Transferencias internas de Money
Manager".

### Bug #2: categoría y subcategoría no se guardan al crear una transacción desde "Pre-rellenar y Añadir"

- **Resuelto:** 2026-07-19, versión `0.8.2.29`.
- **Detectado:** 2026-07-18.

Causa confirmada contra el móvil real (no la hipótesis original sobre `inOutType`/`inOutCode`):
`moneyBook/create`/`update` ignoran `mbCategory`/`subCategory` si no van acompañados del
`mcid`/`mcscid` real de esa categoría/subcategoría (el mismo ID que devuelve
`moneyBook/getInitData`) — sin ellos, el móvil responde `{success:true}` pero guarda `mbCategory`
literalmente como el string `"None"`. Verificado creando y borrando transacciones de prueba reales:
sin `mcid`/`mcscid` se guarda como `"None"`; con `mcid`/`mcscid` junto al nombre (igual que hace el
propio cliente oficial de PC Manager) se guarda correctamente. Detalle completo, incluida la
verificación de que `inOutType` es puramente cosmético y del mapeo correcto de `inOutCode`
(`{'Gasto': '1', 'Ingreso': '0', 'Transferencia': '3'}`), en `CLAUDE.md`, sección "Escritura:
`POST /moneyBook/create`...".

**Hallazgo colateral más grave que el bug original**: el mapeo previo usaba `inOutCode: '2'` para
Ingreso, que se confirmó REALMENTE ROTO (no solo "distinto al de lectura") — una transacción de
prueba con ese código respondió `{success:true}` pero nunca llegó a persistir, ni en
`getDataByPeriod` ni en el balance de la cuenta, en un rango de 10 años completo. Esto implica que
cualquier transacción de tipo Ingreso creada desde este dashboard antes de este fix pudo no haberse
guardado nunca, sin que la UI (que mostraba "Transacción añadida exitosamente") diera ninguna
pista. Corregido en el mismo commit.

### Propuesta #6: distribución "amigable" con ejecutable Windows (segunda vía, no sustituye a la técnica)

- **Resuelto con una limitación conocida sin cerrar (ver Bloque 3 más abajo):** 2026-07-19,
  versión `0.8.0.25`. Commits: `bcec673` (marcado en progreso), `3186b63` (Bloque 1: empaquetado
  PyInstaller), `936e35b` (Bloque 2: ventana nativa pywebview), `82f443c` (Bloque 3: auto-
  actualización vía GitHub Releases, versión inicial), un commit posterior de endurecimiento del
  auto-actualizador tras pruebas reales extensas (mecanismo de reemplazo corregido varias veces;
  ver detalle), `0310d2a` (Bloque 4: GitHub Actions), `51ad95e` (Bloque 5: `README_AMIGOS.md`).
- **Anotado:** 2026-07-19.

Segunda vía de distribución para usuarios sin conocimientos técnicos: un único `.exe` de Windows,
doble clic, sin instalar nada, que se abre en su propia ventana (no un navegador). Convive con la
vía técnica (`git clone` + venv + `git pull`, Propuesta #2) sin sustituirla — ninguna de las dos
reemplaza a la otra.

**Bloque 1 — empaquetado con PyInstaller** (`build_exe.spec`, modo `--onefile`): nuevo punto de
entrada `desktop_app.py`. Problema de diseño central: en un `.exe --onefile`, `sys._MEIPASS` es
una carpeta temporal nueva en cada arranque, así que `config.json`/`logs/`/`data/` no pueden vivir
ahí sin perderse entre sesiones. `backend/paths.py` separa `base_dir()` (datos de usuario que
deben persistir -- carpeta del propio `.exe` cuando `sys.frozen`) de `resource_dir()` (recursos de
solo lectura empaquetados -- `static/`, `VERSION` -- `sys._MEIPASS` cuando `sys.frozen`); en
desarrollo ambas apuntan a la raíz del repo, sin cambio de comportamiento para la vía técnica.
`requirements-desktop.txt` separado de `requirements.txt` (un usuario de la vía técnica no
necesita pyinstaller/pywebview). Verificado compilando el `.exe` de verdad y ejecutándolo: arranca,
crea `config.json`/`logs/` junto al propio `.exe`, sirve `static/`/`VERSION` empaquetados.

**Bloque 2 — ventana nativa con pywebview**: `desktop_app.py` arranca Flask en un hilo de fondo
(host `127.0.0.1`, no expuesto a la LAN) y muestra el dashboard en una ventana propia (WebView2)
en vez de abrir el navegador del sistema. Decisión de diseño: marco por defecto de pywebview (con
título y controles de sistema estándar), no `frameless=True` -- la API pública de pywebview no
ofrece un modo intermedio real de "solo ocultar la barra de título pero conservar los botones de
sistema" (viven dentro de la misma barra a nivel de SO), así que reimplementarlo a mano tendría el
mismo mantenimiento que dibujar los controles a mano en modo frameless completo. El marco por
defecto ya cumple el objetivo real: WebView2 no dibuja barra de direcciones ni pestañas, así que no
parece un navegador. Verificado compilando y ejecutando el `.exe`: ventana sin marco de navegador
(confirmado visualmente), y la subida de un extracto real de `samples/` a `/api/analyze-excel`
produce las mismas propuestas que en modo navegador.

**Bloque 3 — auto-actualización vía GitHub Releases** (`updater.py`): al arrancar el `.exe`
(nunca en modo desarrollo), comprueba `GET /repos/.../releases/latest` y compara el tag con el
`VERSION` empaquetado. Si hay una versión más nueva, descarga el asset `MoneyManagerDashboard.exe`
a `<exe>.new` y se auto-reemplaza. El mecanismo de reemplazo pasó por varias rondas de pruebas
reales end-to-end (compilando y ejecutando el `.exe` de verdad, con una versión antigua simulada
apuntando al Release real ya publicado en el Bloque 4) que fueron encontrando y corrigiendo fallos
reales sucesivos -- no se dio nada por bueno solo porque "debería funcionar": el script auxiliar
pasó de `.bat`/`cmd.exe` a PowerShell (`timeout` sin consola real falla al instante en vez de
esperar, rompiendo los reintentos), el reemplazo pasó de "mover directo" a "renombrar el viejo a
un lado y mover el nuevo al hueco" (Windows no deja sobreescribir el contenido de un `.exe`
mapeado como imagen, aunque sí renombrarlo), y se probaron varias combinaciones de banderas de
creación de proceso hasta encontrar una (`CREATE_NEW_CONSOLE` + auto-ocultación de la consola
desde dentro del propio script) que no dejaba morir ni colgar al ayudante. Detalle completo,
incluidas las combinaciones descartadas y por qué, en `CLAUDE.md`.

**Limitación conocida, sin resolver del todo:** incluso con el mecanismo ya corregido, en pruebas
reales repetidas el primer arranque del `.exe` recién auto-reemplazado tardó en responder mucho
más de lo esperado (varios minutos; en algunas pruebas no llegó a responder dentro de la ventana
de espera usada, hasta ~9 minutos). Aislado con pruebas específicas que aportan bastante certeza
de la causa, pero sin confirmación 100%: NO es un cuelgue del mecanismo de reemplazo en sí (se
verificó que el mismo `Start-Process` sobre un `.exe` que ya llevara un rato en disco arranca en
segundos), sino algo específico de ejecutar por primera vez, en esa ruta exacta, un `.exe` recién
escrito -- con toda probabilidad Windows Defender analizándolo por no tener firma digital y no
haberse visto nunca antes ahí (mismo motivo que el aviso de SmartScreen en la descarga manual, ver
Propuesta #7 más abajo). El caso normal -- arrancar sin que haya actualización pendiente, que será
la inmensa mayoría de los arranques reales -- se verificó rápido y correcto (~4s). Se deja
documentado como limitación conocida en vez de darlo por resuelto sin más porque el entorno de
pruebas (una máquina de desarrollo que ha compilado y ejecutado decenas de variantes de este mismo
`.exe` sin firmar en un rato) puede no ser representativo de la máquina de un usuario real -- si
alguien lo confirma o descarta con datos de uso real, actualizar esta entrada.

**Bloque 4 — GitHub Actions** (`.github/workflows/build-release.yml`): se dispara con el push de
un tag `v*`, compila en `windows-latest` con `requirements-desktop.txt` + `build_exe.spec`, y
publica `dist/MoneyManagerDashboard.exe` como asset de un Release con ese tag. Disparado un ciclo
real (tag `v0.8.0.25`, push) para confirmar que el Action termina en verde y el Release queda
publicado con el `.exe` adjunto.

**Bloque 5 — documentación** (`README_AMIGOS.md`): guía sin terminología técnica -- descargar el
`.exe` desde GitHub Releases, doble clic, y cómo continuar cuando Windows SmartScreen avisa de que
el ejecutable no está firmado ("Más información" -> "Ejecutar de todas formas"). La experiencia se
describe siempre como "se abre la aplicación en su propia ventana", nunca como "se abre el
navegador".

### Bug #3: filtro estricto de una sola cuenta introducía falsos negativos con movimientos de tarjeta

- **Resuelto:** 2026-07-19, versión `0.7.1.18`.
- **Detectado:** 2026-07-19, reportado por el usuario tras usar en producción el filtro por
  cuenta de la Propuesta #5.

**Regresión**: al asociar un fichero a una única cuenta de Money Manager (Propuesta #5) para
acotar el matching, los movimientos hechos con una TARJETA vinculada a esa cuenta (vía
`linkAssetId`) dejaban de encontrarse — el extracto bancario de una cuenta mezcla indistintamente
movimientos hechos en la cuenta y movimientos hechos con la tarjeta, pero Money Manager registra
unos y otros con `assetId` distinto (el de la cuenta, o el de la tarjeta), y el filtro estricto de
un único `assetId` solo veía uno de los dos.

**Diagnóstico confirmado con datos reales** (móvil conectado en esta sesión, ver detalle completo
en `CLAUDE.md`, sección "Matching acotado por cuenta y transferencias entre bancos"):
`getAssetData` confirma que las tarjetas vinculadas a una cuenta tienen su propio `assetId` +
`linkAssetId` apuntando a la cuenta madre; sobre 1165 transacciones reales de 7 meses, 591 usaban
el `assetId` de una cuenta directamente y 218 el de una tarjeta vinculada a otra cuenta —
confirma la inconsistencia exactamente como la reportó el usuario.

**Corrección**:
1. Selector de cuenta por fichero pasa de único a multi-selección (`accountIds` como lista, no
   string). Al marcar una cuenta se auto-marcan sus tarjetas vinculadas (`linkedCardIdsFor()` vía
   `linkAssetId`), editable después — el usuario puede quitarlas o añadir más a mano.
2. `match_bank_transactions()` pasa a dos fases: FASE 1 (prioritaria) filtra estrictamente por
   `account_ids`, igual que antes pero contra una lista, no un único id. FASE 2 (fallback): si una
   línea del banco no encuentra NINGÚN candidato en fase 1 dentro de la ventana de fechas/importe,
   repite la búsqueda sin el filtro de cuenta (comportamiento previo a la Propuesta #5) en vez de
   declararla "nuevo" directamente. El resultado se marca `account_fallback: true` (badge "⚠️
   Fuera de la cuenta esperada" en el frontend) para que el usuario lo revise con más atención.

**Verificación real, antes vs. después** (no solo "debería funcionar"): fichero real de
`samples/` (`casa_julio_250626-180726.xls`, 102 líneas) contra datos reales del móvil obtenidos en
esta sesión, asociando solo la cuenta (sin la tarjeta, reproduciendo el bug):
- **Antes** (código de la Propuesta #5, filtro estricto sin fallback):
  `{'exact_match': 25, 'new': 42, 'suggested_match': 5, 'probable_match': 28}` — 42 falsos "nuevo"
  de 102 líneas.
- **Después** (fase 1 + fase 2 fallback, mismo fichero, misma cuenta sola):
  `{'exact_match': 60, 'new': 4, 'suggested_match': 6, 'probable_match': 30}` — solo 4 "nuevo"
  (los genuinamente nuevos), 38 recuperados por fallback.
- **Después, ideal** (cuenta + tarjeta autosugeridas): mismos totales finales, pero solo 9 de esos
  38 necesitan pasar por fallback (el resto se resuelve directamente en fase 1 al incluir la
  tarjeta).

También verificado: sin regresión en los 7 ficheros de `samples/` (Cajasur, BBVA, EVO cuenta, EVO
tarjeta, Sabadell, Revolut CSV) sin cuenta asociada; regresión de transferencias (Propuesta #5)
sigue funcionando igual con `account_ids` como lista; lógica de autosugerencia de tarjetas
verificada en un sandbox de Node ejecutando `script.js` real. Script de verificación no
comprometido al repo.

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
