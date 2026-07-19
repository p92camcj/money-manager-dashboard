"""Punto de entrada de la distribución "amigable" empaquetada con PyInstaller (ver Propuesta #6
en BACKLOG.md y CLAUDE.md, sección "Distribución con ejecutable de Windows"). NO se usa en la vía
técnica (`python app.py` / `launch.py`) -- esta es una segunda vía de arranque para el .exe, que
convive con la anterior sin sustituirla.

Bloque 1 (empaquetado): arranca Flask en un hilo de fondo (host 127.0.0.1 -- la única visita es
la del propio navegador local, no hace falta exponerlo a la LAN como sí hace `launch.py` con host
0.0.0.0) y abre el navegador por defecto del sistema, igual que `launch.py`. El Bloque 2 sustituye
esto por una ventana propia de escritorio (pywebview) en vez del navegador.
"""
import threading
import time
import webbrowser

from app import app

DASHBOARD_URL = "http://127.0.0.1:5000"


def _run_flask():
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True, use_reloader=False)


def _open_browser_delayed():
    time.sleep(1.5)
    webbrowser.open(DASHBOARD_URL)


def main():
    threading.Thread(target=_open_browser_delayed, daemon=True).start()
    _run_flask()


if __name__ == "__main__":
    main()
