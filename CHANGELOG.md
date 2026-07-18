# Changelog

Formato de versión: `X.Y.Z.W` (ver reglas de incremento en `CLAUDE.md`).

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
