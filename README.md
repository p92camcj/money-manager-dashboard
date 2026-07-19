# Money Manager Premium Web Dashboard

Esta es una interfaz mejorada y potente para gestionar tus finanzas de la app de Android desde tu ordenador.

Cada persona ejecuta su propia copia de este proyecto en su propio PC, en su propia red WiFi,
contra su propio móvil — no hay ningún servicio centralizado ni cuenta que compartir. Este
`README` está pensado para alguien que clona el repo por primera vez y no ha tocado el proyecto
nunca antes.

> ¿Vas a instalarlo para alguien sin conocimientos técnicos (o para ti mismo, sin usar la
> terminal)? Hay una vía más sencilla con un único ejecutable de Windows, sin `git` ni `python` —
> ver [`README_AMIGOS.md`](README_AMIGOS.md).

## Características
- **Dashboard Premium**: Visualización moderna con Glassmorphism.
- **Proxy Inteligente**: Conexión directa con tu móvil evitando errores de CORS.
- **Conciliación bancaria semisupervisada**: sube extractos bancarios (Excel o CSV, de varios
  bancos a la vez) y asocia movimientos con los ya registrados en Money Manager.
- **Sin errores silenciosos**: tú validas cada propuesta antes de que se guarde en el móvil; nada
  se escribe automáticamente.
- **Auto-actualización**: el lanzador comprueba si hay una versión nueva del proyecto en GitHub
  cada vez que lo abres, y la descarga sola — no hace falta volver a clonar ni reinstalar nada.

## Requisitos
- **Python 3.10+** instalado y accesible como `python` (o `python3`) desde una terminal.
- **Git** instalado (para clonar el proyecto y para que la auto-actualización funcione).
- Tu ordenador y tu móvil en la **misma red WiFi**.
- Tener el **"PC Manager"** activado en la app Money Manager del móvil: `Ajustes > PC Manager`.
  Ahí verás la IP y el puerto que necesitarás en el primer arranque (paso 4 más abajo).

## Instalación (primera vez)

1. Clona el repositorio y entra en la carpeta:
   ```bash
   git clone https://github.com/p92camcj/money-manager-dashboard.git
   cd money-manager-dashboard
   ```
2. Crea el entorno virtual e instala las dependencias:
   ```bash
   python -m venv venv
   venv\Scripts\activate      # Windows
   source venv/bin/activate   # macOS/Linux
   pip install -r requirements.txt
   ```
3. Arranca la app con el lanzador de doble clic:
   - Windows: doble clic en `launch.bat`.
   - macOS: doble clic en `launch.command`.

   (También puedes ejecutarlo desde la terminal con `python launch.py` — hace lo mismo.)
4. **Configura tu móvil (solo la primera vez)**: `config.json` no viene incluido en el repositorio
   — cada persona tiene su propia IP de WiFi, así que el fichero no se comparte ni se sube a git
   (ver `config.example.json` como plantilla de referencia). La primera vez que arrancas la app,
   se crea automáticamente con un valor de ejemplo. Abre el dashboard en el navegador, ve a la
   pestaña **Ajustes**, y pon ahí la IP:puerto que te muestra Money Manager en
   `Ajustes > PC Manager` de tu móvil. Guarda — a partir de ahí ya queda recordado.
5. El lanzador abre el navegador solo en `http://localhost:5000`. Si no se abre automáticamente,
   entra ahí a mano.

### Uso diario (después de la primera vez)

Solo tienes que volver a ejecutar el lanzador (`launch.bat` / `launch.command` / `python
launch.py`). Antes de arrancar, comprueba solo si hay una versión nueva publicada en GitHub y, si
la hay, la descarga automáticamente — verás en la consola de qué versión a qué versión se ha
actualizado y un resumen de qué cambió (del `CHANGELOG.md` del proyecto). Si no tienes conexión a
internet en ese momento, o has tocado ficheros del proyecto a mano de alguna forma que lo impida,
la comprobación se salta con un aviso por consola y la app arranca igualmente con lo que tengas en
local — la actualización automática nunca bloquea el arranque.

### Manual (sin el lanzador)

Si prefieres no usar el lanzador (no comprueba conexión con el móvil ni actualizaciones, solo
arranca el servidor):
```bash
python app.py
```
Y abre `http://localhost:5000` en el navegador.

Ver `CLAUDE.md` para la arquitectura completa, la referencia de la API del móvil y las
convenciones del proyecto.

## Notas de seguridad
- No se envían datos a servidores externos; todo ocurre entre tu PC y tu móvil, dentro de tu
  propia red WiFi local.
- `config.json` (tu IP personal) y `data/`, `samples/`, `logs/` (tus datos financieros y de
  conciliación) nunca se suben a git — quedan solo en tu copia local, ver `.gitignore`.
- Se recomienda tener una copia de seguridad en Drive activa, como ya tienes configurado en Money
  Manager.
