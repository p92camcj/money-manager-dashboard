# Changelog

Formato de versión: `X.Y.Z.W` (ver reglas de incremento en `CLAUDE.md`). Resumen en lenguaje
sencillo para usuarios finales en `NOVEDADES.md` (convención desde la versión `0.8.4.32`).

## 0.13.2.49 - 2026-07-20

Bug (Propuesta #16 del `BACKLOG.md`): en el `.exe` no se podía seleccionar ni copiar texto de la
app (importes, conceptos, referencias) para pegarlo fuera.

**Diagnóstico**: se revisó `static/style.css`/`static/script.js` en busca de `user-select: none`,
`preventDefault()` en `mousedown`/`copy`, o cualquier otro bloqueo de selección propio -- no se
encontró ninguno (confirmado también en vivo con Playwright: `getComputedStyle(...).userSelect`
da `"auto"` y una selección de texto real en la tabla de Transacciones funciona sin problema en la
vía navegador). La causa real es ajena al código de la app: `pywebview.create_window()` tiene
`text_select=False` **de fábrica** (confirmado inspeccionando la firma real de la versión
instalada, `pywebview==6.2.1`) -- pensado para que una ventana "de app" no se comporte como una
página web cualquiera, justo lo contrario de lo que hace falta aquí. `desktop_app.py` nunca lo
sobreescribía.

**Fix**: `text_select=True` en la llamada a `webview.create_window()` de `desktop_app.py`. Sin
relación con CSS/JS -- la vía navegador (`python app.py`) nunca estuvo afectada, esto es exclusivo
de la ventana pywebview del `.exe`.

**Verificación**: se compiló el `.exe` real con este cambio (`pyinstaller build_exe.spec`) para
confirmar que `text_select=True` es un parámetro válido de la versión instalada de pywebview y que
el build no rompe -- abrir la ventana de verdad y arrastrar el ratón para seleccionar texto
requiere una sesión gráfica interactiva que no está disponible en el entorno donde se implementó
este cambio; queda pendiente una comprobación visual la próxima vez que se abra el `.exe` en un
escritorio real.

## 0.13.1.48 - 2026-07-20

Propuesta #15 del `BACKLOG.md`: botón para abrir el modal de edición de un huérfano de Money
Manager directamente desde el modo de enlace manual, ANTES de confirmar el enlace -- pensado para
cuando al revisar el emparejamiento el usuario se da cuenta de que el registro en MM tiene un
error de introducción (fecha, céntimos, categoría, concepto) y quiere corregirlo ahí mismo.

- Botón "✏️" nuevo junto a cada huérfano de MM en `#manualLinkOrphanList` (`editOrphanFromManualLink()`
  en `static/script.js`), que reutiliza tal cual el modal de edición ya existente (mismo mecanismo
  que "Ver Registro Asociado", Propuesta #10) -- `manualLinkEditingOrphanId` es lo único distinto,
  para que `submitTransaction()`/`submitTransfer()` sepan que hay que refrescar ese huérfano
  concreto en `lastOrphans` tras guardar (`refreshEditedOrphan()`, una consulta puntual igual que
  `fetchTransactionById()`) en vez de dejar la fila con el valor antiguo hasta el próximo análisis
  completo del Excel.
- **Fila de huérfano reestructurada** en `renderManualLinkSection()`: pasa de un único `<label
  class="manual-link-row">` a un `<div class="manual-link-row">` con un `<label
  class="manual-link-row-main">` (radio + texto, clic para seleccionar) y el botón "Editar" como
  HERMANO, no anidado dentro del label -- un botón anidado en un `<label>` reactiva también el
  radio asociado al hacer clic (comportamiento estándar del navegador), lo que habría marcado el
  huérfano como seleccionado sin querer al pulsar "editar". Las filas del banco (sin este botón)
  se quedan como estaban.
- Al guardar y cerrar el modal, se vuelve exactamente al modo de enlace manual donde se estaba
  (misma selección, mismo scroll) -- gratis por el mismo motivo que Propuesta #10: el modal es un
  overlay `position: fixed` y el flujo nunca navega de pestaña ni reconstruye el modo manual
  mientras está abierto.
- **Limitación conocida, no un bug**: si el huérfano editado es una transferencia, su `id` CAMBIA
  tras la edición (ver CLAUDE.md, "Transferencias internas de Money Manager") -- `refreshEditedOrphan()`
  ya no encuentra el id viejo y no hace nada, en vez de fallar; esa fila concreta no se refresca
  hasta el próximo análisis completo.

**Verificado en vivo contra el móvil real**: el botón abre el modal con el registro real
correcto, guardar (edición sin cambios, para no alterar datos financieros reales del usuario
solo para la prueba) devuelve a la sección de enlace manual visible, con la selección del huérfano
y el scroll de la pantalla exactamente iguales que antes de abrir el modal.

## 0.13.0.47 - 2026-07-20

Propuesta #14 del `BACKLOG.md`: deshacer la última conciliación confirmada (por "Confirmar Este"
o por el modo de enlace manual, Propuesta #13). Antes no existía ningún mecanismo -- la única
forma de revertir un enlace era editar `data/reconciliations.json` a mano, como se confirmó
durante la propia verificación en vivo de la Propuesta #13 en la sesión anterior.

- `backend/reconciliation_store.py`: `confirm()` guarda ahora también `date`/`amount`/
  `description` en claro (además de `mm_id`/`confirmed_at`/`status`) -- la clave del almacén es un
  hash irreversible, así que sin esto no habría forma de mostrarle al usuario QUÉ se va a deshacer
  antes de confirmar. No es un dato nuevo (ya vive en el Excel del banco y en Money Manager) y
  `data/` ya está fuera de git. `get_last_confirmation()` (la entrada más reciente por
  `confirmed_at`, no por orden de inserción del dict) y `undo_last_confirmation()` (la elimina y
  la devuelve) -- deliberadamente solo la ÚLTIMA, sin historial de varios pasos.
- `GET /api/reconciliations/last` / `POST /api/reconciliations/undo` en `app.py`, sin tocar Money
  Manager en ningún caso (el vínculo era solo local).
- Botón "↩️ Deshacer última conciliación" en Conciliación (`undoLastReconciliation()` en
  `static/script.js`): consulta siempre el backend (nunca se fía solo del estado en memoria) para
  mostrarle al usuario fecha/importe/descripción de lo que se va a deshacer ANTES de pedir
  confirmación (`confirm()` del navegador). Si la conciliación se confirmó en esta misma sesión
  (`lastConfirmedAction`, capturado en `confirmMatch()`/`confirmManualLink()` justo antes de
  sobreescribir el estado), la reversión es instantánea en pantalla (la propuesta vuelve a su
  estado previo, el huérfano se reinserta en `lastOrphans` si lo había) sin tener que re-analizar
  el Excel; si no (sesión anterior, otra pestaña, entrada sin date/amount/description por ser
  previa a este cambio), se degrada avisando que hay que volver a analizar el fichero para verlo
  reflejado.

**Verificado en vivo contra el móvil real**: confirmado un enlace manual real, deshecho al
instante (diálogo de confirmación mostrando fecha/importe/descripción reales, no un mensaje
genérico), y comprobado que el estado local revierte exactamente (`new`+1, `reconciled`-1,
`orphans`+1) sin volver a analizar el Excel. `data/reconciliations.json` quedó con el mismo número
de entradas que antes de la prueba, confirmando que el deshacer no dejó rastro.

## 0.12.2.46 - 2026-07-20

Bug real en el modo de enlace manual (Propuesta #13), detectado por el usuario probándolo en
persona tras la verificación en vivo de la sesión anterior: al elegir un movimiento del banco, un
huérfano de Money Manager que veía perfectamente desaparecía de la lista -- por diseño solo debía
REORDENARSE por cercanía de importe, nunca desaparecer.

**Diagnóstico**: no había ningún filtro (se comprobó a fondo, `renderManualLinkSection()` no
aplica ningún `.filter()` a `orphanItems`) -- el problema era que el ORDEN por cercanía de importe
estaba roto. `mm_orphans[].amount` no lleva un convenio de signo consistente en los datos reales de
Money Manager (algunas filas vienen en positivo, otras en negativo para el mismo tipo de
movimiento -- confirmado contra datos reales, no una suposición), mientras que el importe del
banco siempre lleva el signo real del extracto. Comparar ambos tal cual (`a.amount -
selectedBank.amount`) daba la distancia MÁS GRANDE posible justo para las coincidencias reales
(p.ej. un huérfano de Amazon de +14,70€ contra un cargo de banco de -14,70€, la misma compra),
hundiéndolas en mitad de una lista de 34 huérfanos en vez de arriba -- con un scroll de solo
~6-7 filas visibles a la vez, esto se percibía exactamente como "el huérfano desapareció".

**Fix**: `renderManualLinkSection()` (`static/script.js`) compara ahora por MAGNITUD absoluta en
ambos lados (`Math.abs(Math.abs(a.amount) - Math.abs(selectedBank.amount))`), tanto para el orden
como para el badge "💡 Importe parecido" -- correcto independientemente del convenio de signo de
cada lado.

**Verificado en vivo contra el móvil real** (no solo por trazado de código, tal y como pidió el
usuario): con el mismo extracto real de `samples/` usado en la verificación anterior, se comprobó
que el número de huérfanos visibles (34) y la presencia de "Amazon Chuches Reena" se mantienen
exactamente iguales al seleccionar CUALQUIERA de los movimientos del banco disponibles (antes del
fix esto ya se sospechaba correcto por el propio código -- lo que fallaba era la posición). Tras el
fix, un huérfano con importe real e idéntico en magnitud al del banco seleccionado pasó de la
posición 10 de 34 a la posición 3 de 34 -- dentro del scroll visible sin buscar.

## 0.12.1.44 - 2026-07-20

Propuesta #13 del `BACKLOG.md`: modo de enlace manual banco ↔ Money Manager para casos que el
matching automático no cruza -- p.ej. un cargo de Amazon que en el banco solo trae el número de
pedido como concepto, y en Money Manager se guarda con un concepto distinto y a veces con la fecha
desplazada uno o dos días. Ambos acaban como huérfanos vistos desde lados opuestos (la línea del
banco como `new`, la transacción de MM en `mm_orphans` de la Propuesta #11) sin que el matching
heurístico los cruce nunca.

- Toggle nuevo en Conciliación (`#manualLinkToggleBtn` -> `#manualLinkSection`,
  `toggleManualLinkMode()` en `static/script.js`): dos columnas con selección única (radio
  buttons) -- `lastProposals` con `status: 'new'` a la izquierda, `lastOrphans` a la derecha.
  Deliberadamente sin filtrar por `currentLabelFilter` (a diferencia del resto de la pantalla): el
  caso motivador es justo uno donde banco y MM pueden venir de ficheros/etiquetas distintas.
- `confirmManualLink()` reutiliza `/api/reconciliations/confirm` TAL CUAL, sin endpoint ni almacén
  nuevos -- mismo payload `{date, amount, description, mm_id}` que ya construye `confirmMatch()`.
  Un enlace manual es, en el fondo, un match confirmado por el usuario con menos certeza automática
  que un `exact_match`; nunca escribe en Money Manager.
- Tras confirmar, mismo patrón que el fix del Bug #9 (BACKLOG.md): se actualiza el estado local en
  el sitio (`bankProposal.status = 'reconciled'`, huérfano quitado de `lastOrphans` con `filter()`)
  para que ambos desaparezcan de sus listas y "Ver Registro Asociado" quede disponible de
  inmediato, sin depender de volver a subir el Excel -- necesario porque el backend solo excluiría
  ese id retroactivamente en el PRÓXIMO análisis.
- Mejora de usabilidad: al elegir un movimiento del banco, los huérfanos de MM se reordenan por
  cercanía de importe (en vez de por fecha) y los que coinciden hasta el céntimo ganan un badge
  "💡 Importe parecido" -- para no obligar a buscar a ojo en una lista larga.

**Verificación**: sin móvil/navegador disponibles en la sesión en que se implementó -- verificado
por trazado de código y sintaxis completa (`node --check static/script.js`), y a mano que el
payload de `confirmManualLink()` coincide campo a campo con el que ya acepta
`/api/reconciliations/confirm`. No probado end-to-end con un caso real de Amazon ni en un
navegador real -- pendiente de verificación en vivo.

## 0.12.0.43 - 2026-07-20

Buscador propio estilo "Ctrl+F" que funciona en toda la app, no limitado a una columna concreta.
Motivación: en el `.exe` la app corre dentro de una ventana pywebview sin barra de direcciones, así
que el buscador nativo del navegador puede ni estar accesible ahí -- necesitaba funcionar igual de
bien en esa vía que en la técnica con navegador.

- `document.addEventListener('keydown', ...)` en `static/script.js` intercepta Ctrl+F/Cmd+F con
  `preventDefault()` y abre `#inPageSearchBar` (barra flotante nueva en `static/index.html`,
  arriba a la derecha) en vez de dejar que el navegador/WebView abra el suyo. Escape la cierra;
  vaciar el campo de texto (sin cerrar la barra) vuelve a mostrar todo.
- Filtra por substring, sin distinguir mayúsculas ni tildes (`normalizeForSearch()`: `normalize('NFD')`
  + strip del bloque Unicode de marcas diacríticas), contra el `textContent` completo del ítem --
  no columna a columna. Oculta lo que no coincide (`.search-hidden { display: none !important; }`)
  en vez de solo resaltarlo.
- Granularidad de "un resultado" según la pestaña activa (`getInPageSearchItems()`): fila de
  `#transBody` en Transacciones, tarjeta de `#proposalsList`/`#mmOrphansList` en Conciliación, nodo
  de `#budgetTree` en Presupuestos. Dashboard/Ajustes no tienen una lista que filtrar -- la barra
  se puede abrir igual, simplemente no oculta nada ahí.
- Independiente del filtro de texto que ya existía en Transacciones (`#filterSearch`, que solo
  busca por columnas concretas de esa tabla vía `AnalyticsEngine.applyAdvancedFilters`) -- este
  buscador es genérico y no lo sustituye, ambos pueden estar activos a la vez.
- `reapplyInPageSearch()` se llama al final de `renderTransactions()`, `renderProposalsList()`,
  `renderMmOrphansList()` y `renderBudgets()` (que reconstruyen su lista con `innerHTML` y
  perderían las clases `search-hidden` ya aplicadas) y también tras `switchTab()` (para
  Conciliación, cuyas tarjetas no se reconstruyen solo por cambiar de pestaña) -- así una búsqueda
  activa sobrevive a un refresco de datos, un cambio de filtro/etiqueta o un cambio de pestaña, sin
  tener que rehacerla a mano.

## 0.11.1.42 - 2026-07-20

Minibug: la subcategoría no cargaba la primera vez que se abría el modal de detalle/edición de
una transacción (sí la segunda). Diagnóstico por trazado de código, no por caché de
`fetchCategoryMap()` (hipótesis inicial razonable pero descartada -- ese mapa solo se usa para
`mcid`/`mcscid` al guardar, no para poblar el `<select>` de subcategoría): en
`populateEditFormFromTransaction()` (`static/script.js`), `updateModalCategories()` (que a su vez
llama a `updateModalSubCategories()`) se ejecutaba ANTES de fijar `editCategory.value = t.mbCategory`
-- el `<select>` de subcategoría quedaba poblado para la categoría que hubiera antes (o ninguna,
en la primera apertura de la sesión), no para la de la transacción que se estaba abriendo. Asignar
`editSubCategory.value = t.subCategory` justo después no seleccionaba nada, porque un `<select>`
ignora en silencio un `value` que no coincide con ninguna de sus `<option>` -- ahí queda,
visualmente, la subcategoría en blanco. Que la segunda vez SÍ funcionara era casualidad: al
reabrir el modal, `updateModalCategories()` restaura `prevCat` (la categoría que quedó fijada tras
la apertura anterior, que si era la misma transacción coincidía con la real) y por eso
`updateModalSubCategories()` se ejecutaba ya con la categoría correcta.

Fix: llamar a `updateModalSubCategories()` explícitamente justo después de fijar
`editCategory.value`, antes de asignar `editSubCategory.value` -- válido siempre, no depende de lo
que hubiera seleccionado en una apertura anterior del modal.

## 0.11.0.41 - 2026-07-20

Propuesta #11 del `BACKLOG.md` (arqueo de caja): la conciliación resolvía solo un sentido
(banco → MM). Ahora, para cada fichero subido CON una o varias cuentas/tarjetas asociadas, también
resuelve el sentido contrario -- dentro de esa cuenta y el periodo real de ese fichero, localiza
las transacciones de Money Manager que ninguna fila del banco cubre. Detalle completo del diseño
en `CLAUDE.md`, sección "Arqueo de caja: huérfanos de Money Manager sin equivalente en el
extracto".

- `backend/reconciliation.py::find_mm_orphans(mm_df, file_contexts, excluded_mm_ids)`: se calcula
  DESPUÉS del bucle de matching de TODOS los ficheros de la tanda (para que un huérfano candidato
  de un fichero pueda resolverse por el `exact_match` de otro fichero de la misma tanda), y solo
  cuenta como "consumida" una transacción de MM si (a) quedó `matched_origin`/`matched_destination`
  a `True` tras ese bucle, o (b) su id ya está en `data/reconciliations.json` -- de CUALQUIER
  sesión anterior, no solo de las conciliaciones recalculadas en esta petición, para que una
  transacción conciliada hace tiempo cuyo Excel original no se ha vuelto a subir hoy no reaparezca
  como falso huérfano. Una transferencia con un solo lado presente en la tanda (p.ej. el otro
  banco no se subió) aparece como huérfana por ese lado con `transfer_side` -- no se excluye, es
  información real del arqueo.
- `/api/analyze-excel` añade `mm_orphans` a la respuesta, junto a `proposals`.
- Frontend: nueva sección `#mmOrphansSection` ("Movimientos en Money Manager sin equivalente en el
  extracto"), separada visualmente de `#proposalsList` porque va en el sentido contrario, y una
  barra de resumen `#reconciliationSummaryBar` con cuatro cifras de un vistazo (cuadran / por
  revisar / solo en el banco / solo en Money Manager).

**Verificado contra el móvil real** (no solo con un test sintético): usando la cuenta real
"👬 Cta común casa" + su tarjeta vinculada "💳 👬 Casa" con un extracto real de `samples/`, se
eliminaron a propósito 5 líneas concretas del extracto (en fechas intermedias del periodo, para no
desplazar los límites de fecha del propio fichero) y se subió el fichero truncado contra
`/api/analyze-excel` real. Resultado: 41 huérfanos detectados -- las 5 eliminadas a propósito
(5/5, verificadas por id exacto) más 36 huérfanos reales preexistentes (en su mayoría prorrateos
internos automáticos de Money Manager -- cuotas, seguros, ahorros mensuales -- que nunca tienen
movimiento bancario real). Las 2 conciliaciones ya confirmadas en sesiones anteriores no
reaparecieron como huérfanas. 6 de los huérfanos son transferencias internas con `transfer_side`
correcto, verificado contra `assetId`/`destAssetId` reales, incluido un caso real de transferencia
entrante desde otra cuenta cuyo extracto no se subió en esta tanda.

## 0.10.0.38 - 2026-07-19

Propuesta #10 del `BACKLOG.md`: "Ver Registro Asociado" en Conciliación ya no navega a la pestaña
Transacciones (lo que perdía la posición de scroll y el filtro de etiqueta activo en
`#proposalsFilterBar`) -- abre el registro de Money Manager correspondiente en el mismo modal de
edición ya existente, permitiendo editarlo directamente ahí.

- `viewAssociatedRecord(mmId, proposalDate)` sustituye a `showTransaction()` en este flujo: busca
  primero en `transactionsData` (caché del periodo actual del Dashboard) y, si no está --habitual,
  porque el rango del extracto bancario conciliado no tiene por qué coincidir con ese periodo--,
  hace una consulta puntual a `getDataByPeriod` en una ventana de ±31 días alrededor de la fecha de
  la propuesta, sin tocar la caché de Dashboard/Transacciones.
- El scroll y el filtro se conservan sin código explícito de guardar/restaurar posición: el modal
  es un overlay `position: fixed` y el nuevo flujo nunca navega de pestaña ni vuelve a renderizar
  la lista de propuestas mientras está abierto.
- `modalOpenedFromConciliation` evita que guardar cambios desde este modal navegue a Transacciones
  tras el guardado (comportamiento que sí se mantiene para ediciones iniciadas desde la propia
  pestaña Transacciones o desde "Pre-rellenar y Añadir").

Verificado en navegador real con Playwright: filtro de etiqueta y scroll de `.content` intactos
tras abrir y cerrar el modal sobre una tanda real de 2 ficheros de `samples/`; camino de fallback
(registro fuera del periodo cargado) verificado vaciando `transactionsData` a propósito; camino de
guardado verificado interceptando la escritura real a `/api/proxy/moneyBook/update` (sin tocar
ningún dato real del móvil), confirmando el mensaje correcto y que la pestaña activa no cambia.

**Hallazgo colateral corregido en el mismo commit**: `submitTransaction()`/`submitTransfer()`
leían `currentEditingId` después de `closeModal()` (que ya lo pone a `null`), así que el aviso de
guardado mostraba siempre "añadida exitosamente" incluso al editar un registro ya existente.
Corregido capturando el id en una constante local antes de cerrar el modal.

## 0.9.2.36 - 2026-07-19

Bug #9 del `BACKLOG.md`: confirmar una selección entre varias propuestas de conciliación no se
reflejaba como conciliada al instante, aunque el backend ya la tuviera persistida correctamente.

**Diagnóstico** (antes de tocar nada, per instrucción explícita): se descartaron ambas hipótesis
del backlog sobre el backend con datos reales, no solo en teoría:
- `make_key()` es determinista y consistente: se reprodujo con los DOS valores reales ya
  guardados en `data/reconciliations.json` (fecha/importe/descripción exactos logueados en
  `logs/app.log` al confirmarlos) y el hash coincide byte a byte con la clave ya almacenada.
- La sobreescritura a `'reconciled'` en `analyze_excel()` (`app.py`) se aplica de forma
  incondicional a CUALQUIER propuesta, no solo a las de `exact_match` -- verificado con un caso
  sintético de extremo a extremo vía el test client de Flask: subir un CSV con una fila ambigua
  (2 candidatos), confirmar uno vía `/api/reconciliations/confirm`, y re-subir el mismo CSV
  produce correctamente `{'status': 'reconciled', 'suggested_mm_ref': <mm_id elegido>}`.

**Causa real, en el frontend**: `confirmMatch()` en `static/script.js` solo atenuaba la tarjeta
en el DOM directamente (`opacity` + ocultar la lista de candidatos) tras un confirm con éxito,
sin actualizar el objeto `proposal` correspondiente dentro de `lastProposals`. Verificado en
navegador real (Playwright) contra el código anterior: justo después de pulsar "Confirmar Este",
la tarjeta seguía mostrando el badge "Posible Coincidencia" (solo atenuado visualmente) en vez de
"Ya Conciliado" -- y cualquier re-render posterior en la misma sesión sin volver a pedir datos al
backend (p.ej. cambiar el filtro de etiqueta en `#proposalsFilterBar`) reconstruía la tarjeta
desde ese estado desincronizado, mostrándola de nuevo con dudas y los botones "Confirmar Este"
activos.

**Fix**: `confirmMatch()` ahora actualiza `proposal.status`/`confidence`/`suggested_mm_ref`/
`candidates` con el mismo resultado que calcularía `analyze_excel()` al re-analizar, y llama a
`renderProposalsList()` para reflejarlo. Verificado en navegador real (Playwright) con el mismo
caso sintético: tras confirmar, la tarjeta muestra "Ya Conciliado" de inmediato, y se mantiene
así tras forzar un re-render local -- reproducido primero el fallo contra el código anterior
(`git stash`) y confirmado que desaparece con el fix.

## 0.9.1.35 - 2026-07-19

Propuesta #8 del `BACKLOG.md`: corrección/mejora visual sin lógica nueva, en la lista de
propuestas de conciliación (`renderProposalsList()` en `static/script.js`).

- Cada tarjeta de propuesta pasa de la clase genérica `duplicate`/`new` (sin CSS asociado hasta
  ahora) a `status-<estado>` más `proposal-resolved` (`exact_match`/`reconciled`) o
  `proposal-attention` (`suggested_match`/`probable_match`/`new`).
- `static/style.css`: `.proposal-resolved` atenúa la tarjeta (opacidad 0.55, importe sin negrita)
  -- son un check correcto, ya resuelto, que no necesita atención. `.proposal-attention` se
  mantiene a plena opacidad y gana un acento de color a la izquierda a juego con su badge (verde
  para `new`, amarillo para `suggested_match`/`probable_match`) para destacar frente a las
  atenuadas.
- `reconciled` se atenúa igual que `exact_match` (no solo lo pedía la propuesta original, pero es
  conceptualmente el mismo caso: un match ya resuelto por el usuario, sin necesidad de revisión).

## 0.9.0.33 - 2026-07-19

Nueva funcionalidad visible (Tarea 2 de una sesión de trabajo): aviso de novedades dentro de la
propia ventana tras auto-actualizar, en lenguaje sencillo (no el `CHANGELOG.md` técnico tal
cual). Detalle completo en `CLAUDE.md`, sección "Aviso de novedades tras auto-actualizar".

- **`NOVEDADES.md`** (nuevo, empaquetado como recurso de solo lectura, ver `build_exe.spec`):
  contrapartida legible de `CHANGELOG.md`, misma cabecera `## X.Y.Z.W - YYYY-MM-DD` para poder
  emparejarlas por versión, con bullets en lenguaje llano por debajo. A partir de esta versión,
  toda entrada nueva de `CHANGELOG.md` lleva también su entrada en `NOVEDADES.md`.
- **`GET /api/novedades`** (`app.py::parse_novedades()`) devuelve el histórico completo y las
  versiones más nuevas que la última que el usuario ya vio (`last_seen_version.txt`, dato de
  usuario en `base_dir()`, gitignored -- no confundir con `NOVEDADES.md`, que sí va en git). Un
  usuario nuevo (sin `last_seen_version.txt` previo) no ve ningún aviso -- se marca la versión
  actual como vista en silencio en su primer arranque.
- **`POST /api/novedades/mark-seen`** marca la versión actual como vista, llamado en cuanto se
  decide mostrar el aviso automático (no al cerrarlo) -- el histórico completo sigue disponible
  bajo demanda con el enlace "Ver novedades" del footer aunque el usuario cierre el aviso sin
  leerlo entero.
- Frontend: `checkNovedades()` (automático al arrancar) y `showFullNovedades()` (bajo demanda)
  en `static/script.js`, mismo modal (`#novedadesModal`) y estilo que el resto del dashboard.
- Funciona igual para la vía de `git pull` que para el `.exe` -- ambas comparten `app.py` y
  `base_dir()` ya resuelve a la raíz del repo en modo desarrollo, sin código específico por vía.
- Verificado con la API real (no solo unitario): simulando un `last_seen_version.txt` con una
  versión antigua, `GET /api/novedades` devuelve las entradas nuevas correctas; tras
  `mark-seen`, deja de devolverlas. Corregido en el mismo commit un bug real de parseo
  descubierto durante esta verificación: `parse_novedades()` truncaba cualquier bullet de
  `NOVEDADES.md` envuelto en más de una línea (el resto de los `.md` del proyecto se envuelve
  para legibilidad) -- ahora une las líneas de continuación.

## 0.8.4.32 - 2026-07-19

Corrección de dos ítems del backlog (Tarea 1 de una sesión de trabajo):

- **Bug #1 (conexión silenciosa con el móvil)**: `/api/analyze-excel`, `/api/budget-hierarchy` y
  el proxy genérico `/api/proxy/<endpoint>` ya no tratan un `ConnectionError`/`Timeout` al hablar
  con el móvil como "cero transacciones" válidas — devuelven `{"mm_connection_error": true}` con
  HTTP 503 (504 en timeout), y `analyze_excel()` aborta ANTES de generar ninguna propuesta de
  conciliación en ese caso (antes seguía adelante con una lista vacía, generando un falso "nuevo
  movimiento" por cada línea del Excel). El indicador de conexión del header
  (`updateConnectionStatus()`/`#connectionStatus`) se extendió para reaccionar también a un fallo
  a mitad de sesión, no solo desde la carga inicial — `fetchAssets`, `fetchTransactions`,
  `fetchBudgets`, `fetchCategoryMap` y `confirmUploadFiles()` lo comprueban y actualizan el
  indicador en cualquier dirección (offline al fallar, online al recuperarse).
- **Propuesta #4 (matching no compartía estado entre ficheros de la misma tanda)**: nueva
  `backend/reconciliation.build_mm_dataframe()` construye el DataFrame de transacciones de Money
  Manager UNA SOLA VEZ por tanda de ficheros subidos a la vez, y se pasa compartido a cada
  llamada de `match_bank_transactions()` en vez de reconstruirse desde cero por fichero.
  Verificado con un caso sintético (dos transacciones de Money Manager con la misma fecha e
  importe, sin relación real entre sí, cada una en un fichero bancario distinto de la misma
  tanda): antes, ambos ficheros proponían determinísticamente la MISMA transacción y la segunda
  quedaba invisible para siempre; con el DataFrame compartido, cada fichero obtiene la
  transacción correcta. De paso, se corrigió `is_transfer` en `build_mm_dataframe()`, que
  comparaba `inOutType == 'Transferencia'` (un texto que nunca aparece en datos reales, ver
  versión `0.8.3.30`) — ahora se detecta por `inOutCode` ("3"/"4"), y el consumo por lado
  (`matched_origin`/`matched_destination`) ahora también se aplica sin cuenta asociada, decidido
  por el signo del importe bancario, para que dos ficheros SIN cuenta asociada que traigan los
  dos lados de la misma transferencia entre cuentas propias no se bloqueen entre sí. Detalle
  completo verificado con 4 casos sintéticos en `CLAUDE.md`, secciones "Matching compartido entre
  ficheros de la misma tanda" y "Matching acotado por cuenta y transferencias entre bancos".

## 0.8.3.30 - 2026-07-19

Corrección de bug (Tarea 2 de una sesión de trabajo): las transferencias internas de Money
Manager no se distinguían en la tabla de Transacciones, y editarlas realmente las rompía.
Detalle completo del mecanismo verificado en `CLAUDE.md`, sección "Transferencias internas de
Money Manager".

- **Diagnóstico real contra el móvil**: `inOutType` para una transferencia leída con
  `getDataByPeriod` es literalmente `"Dinero gastado"`, nunca `"Transferencia"` (confirmado sobre
  1556 transferencias históricas reales) -- por eso `renderTransactions()`/`editTransaction()`
  nunca detectaban una transferencia como tal. Ahora se detecta por `inOutCode` (`"3"`/`"4"`), la
  señal fiable.
- **`renderTransactions()`**: una transferencia se muestra con importe en color neutro (se añadió
  la clase `.text-muted` a `style.css`, que no existía) y, en vez de categoría/subcategoría, un
  badge "🔁 Transferencia" y la cuenta destino resuelta con `getAssetName()`.
- **`editTransaction()`**: precargaba mal una transferencia real (cayía en la rama "Ingreso" por
  el mismo motivo de arriba, y nunca rellenaba la cuenta destino). Ahora detecta el tipo por
  `inOutCode` y precarga ambas cuentas correctamente.
- **Hallazgo más grave, verificado con transferencias de prueba reales creadas/editadas/borradas**:
  el dashboard guardaba y editaba transferencias mandándolas a `moneyBook/create`/`update` con
  `targetAssetId` -- el móvil respondía `{success:true}` pero la cuenta destino se guardaba como
  `null`, una transferencia rota de forma silenciosa. El mecanismo real es un endpoint totalmente
  distinto (`moneyBook/moveAsset` para crear, `moneyBook/modifyMoveAsset` para editar, campos
  `fromAssetId`/`toAssetId`/`moveMoney`/`moneyContent`), extraído de `reference/all_mm.js` y
  verificado en vivo. Nueva función `submitTransfer()` en `static/script.js`, a la que
  `submitTransaction()` delega para el tipo Transferencia.

## 0.8.2.29 - 2026-07-19

Corrección de bug (Bug #2 de `BACKLOG.md`), verificada contra el móvil real con transacciones de
prueba creadas y borradas durante la investigación (ver `CLAUDE.md`, sección "Escritura:
`POST /moneyBook/create`..." para el detalle completo del mapeo confirmado):

- **Categoría/subcategoría no se guardaban al crear/editar una transacción desde el dashboard**:
  confirmado que `moneyBook/create`/`update` ignoran `mbCategory`/`subCategory` si no van
  acompañados del `mcid`/`mcscid` real de esa categoría/subcategoría -- sin ellos, el móvil
  respondía `{success:true}` pero guardaba `mbCategory` literalmente como el string `"None"`.
  `static/script.js` añade `fetchCategoryMap()` (nuevo, lee `moneyBook/getInitData` al cargar,
  igual que hace el propio cliente oficial de PC Manager) y `submitTransaction()` ahora adjunta
  `mcid`/`mcscid` resueltos por nombre junto a `mbCategory`/`subCategory`.
- **Las transacciones de Ingreso podían no guardarse nunca, en silencio**: `inOutCode` para
  Ingreso era `'2'` en vez de `'0'` -- verificado con una transacción de prueba real que el móvil
  respondía `{success:true}` pero la transacción no llegaba a persistir en ningún rango de fechas
  (`'2'` se trata internamente como movimiento de activos, no como Ingreso). Corregido el mapeo a
  `{'Gasto': '1', 'Ingreso': '0', 'Transferencia': '3'}`.
- Añadido logging (`logger.info`, prefijo `[write-debug]`) del payload real enviado y la
  respuesta cruda del móvil en `/api/proxy` para `moneyBook/create`/`update`, usado para
  diagnosticar este bug y que queda como diagnóstico permanente para el futuro.

## 0.8.1.26 - 2026-07-19

Corrección interna, sin funcionalidad nueva visible: el Release `v0.8.0.25` ya publicado en
GitHub se compiló con una versión del auto-actualizador (`updater.py`) anterior al endurecimiento
descrito más abajo en la entrada `0.8.0.25` (el propio ciclo de pruebas reales que motivó ese
endurecimiento ocurrió después de publicar ese Release). Esta versión republica el `.exe` con el
`updater.py` ya corregido -- necesario para que la propia auto-actualización, a partir de ahora,
use el mecanismo fiable en vez del original. Ver detalle completo del cambio en la entrada
`0.8.0.25` y en `BACKLOG.md`, Propuesta #6.

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
  auto-reemplaza (script auxiliar de PowerShell que espera a que el proceso actual termine,
  renombra el `.exe` viejo a un lado, mueve el nuevo a ese hueco, y lo relanza). Nunca bloquea el
  arranque si falla la comprobación (sin internet, GitHub no responde...). **Limitación conocida,
  sin resolver del todo** (ver detalle en `BACKLOG.md`, Propuesta #6): en pruebas reales repetidas,
  el primer arranque del `.exe` recién auto-reemplazado tardó bastante más de lo esperado en
  responder por primera vez -- con toda probabilidad Windows Defender analizando un ejecutable sin
  firma nunca visto antes en esa ruta, no un fallo del propio mecanismo (verificado por separado
  que el mecanismo de reemplazo y el relanzamiento son correctos). El arranque normal, sin
  actualización pendiente -- la inmensa mayoría de los casos reales -- es rápido y correcto.
- **GitHub Actions** (`.github/workflows/build-release.yml`): compila el `.exe` en
  `windows-latest` y lo publica como asset de un Release al hacer push de un tag `v*`.
- **`README_AMIGOS.md`**: guía de instalación sin terminología técnica (descargar, doble clic,
  aviso de Windows SmartScreen), sin mencionar en ningún punto "navegador".

Verificado compilando y ejecutando el `.exe` real en cada bloque (no solo que compilara): arranca,
persiste `config.json`/`logs/` junto al propio ejecutable, sirve el dashboard igual que en modo
navegador (probado con un extracto real de `samples/` vía `/api/analyze-excel`), abre en una
ventana sin marco de navegador, y el auto-actualizador se probó de principio a fin contra la API y
el Release reales de GitHub -- encontrando y corrigiendo varios fallos reales del mecanismo de
reemplazo por el camino (ver `BACKLOG.md`) hasta dejar uno documentado como limitación conocida en
vez de sin verificar. Detalle completo en los commits de cada bloque y en `CLAUDE.md`.

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
