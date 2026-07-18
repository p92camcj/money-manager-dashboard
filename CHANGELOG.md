# Changelog

Formato de versión: `X.Y.Z.W` (ver reglas de incremento en `CLAUDE.md`).

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
