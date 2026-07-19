"""Resolución de rutas base, común a `python app.py`/`launch.py` (vía técnica) y al .exe de
PyInstaller (vía amigable, ver CLAUDE.md sección "Distribución con ejecutable de Windows").

En un .exe de PyInstaller en modo --onefile, `sys._MEIPASS` es una carpeta temporal NUEVA en
cada arranque -- sirve para leer recursos empaquetados de solo lectura (static/, VERSION), pero
NUNCA para datos que deban persistir entre sesiones (config.json, logs/, data/), que se
perderían en cuanto se cierre la app. Por eso hay dos funciones distintas en vez de una:
- `base_dir()`: datos de usuario que deben sobrevivir entre arranques -> carpeta del propio
  .exe cuando está empaquetado, raíz del repo en desarrollo.
- `resource_dir()`: recursos de solo lectura empaquetados junto con el código -> `sys._MEIPASS`
  cuando está empaquetado, raíz del repo en desarrollo (mismo sitio que antes de este cambio).

En desarrollo (`python app.py`, `python launch.py`) ambas funciones devuelven la raíz del repo,
igual que el código anterior a esto -- el flujo git clone + venv no cambia de comportamiento.
"""
import os
import sys


def _repo_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return _repo_root()


def resource_dir():
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return _repo_root()
