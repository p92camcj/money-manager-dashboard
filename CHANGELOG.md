# Changelog

Formato de versión: `X.Y.Z.W` (ver reglas de incremento en `CLAUDE.md`).

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
