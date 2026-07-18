# Money Manager Premium Web Dashboard

Esta es una interfaz mejorada y potente para gestionar tus finanzas de la app de Android desde tu ordenador.

## Características
- **Dashboard Premium**: Visualización moderna con Glassmorphism.
- **Proxy Inteligente**: Conexión directa con tu móvil evitando errores de CORS.
- **Conciliación de Excel**: Sube extractos bancarios y asocia movimientos al móvil de forma supervisada.
- **Sin Errores**: Tú validas cada carga antes de que se guarde en el móvil.

## Requisitos
- Python 3.14 (ya detectado en tu sistema).
- Estar en la misma red WiFi que tu móvil.
- Tener el "PC Manager" activado en la app Money Manager.

## Instalación y Uso

### Opción rápida: lanzador de doble clic
- Windows: doble clic en `launch.bat`.
- macOS: doble clic en `launch.command`.

Ambos activan `venv/` si existe, comprueban la conexión con el móvil (reintentando hasta que
Money Manager esté accesible) y abren el navegador automáticamente en el dashboard.

### Manual
1. Abre una terminal en esta carpeta.
2. Crea el entorno virtual e instala las librerías necesarias:
   ```bash
   python -m venv venv
   venv\Scripts\activate      # Windows
   source venv/bin/activate   # macOS/Linux
   pip install -r requirements.txt
   ```
3. Ejecuta el servidor:
   ```bash
   python app.py
   ```
4. Abre tu navegador en: `http://localhost:5000`

Ver `CLAUDE.md` para la arquitectura completa, la referencia de la API del móvil y las
convenciones del proyecto.

## Notas de Seguridad
- No se envían datos a servidores externos; todo ocurre entre tu PC y tu móvil.
- Se recomienda tener una copia de seguridad en Drive activa, como ya tienes configurado.
