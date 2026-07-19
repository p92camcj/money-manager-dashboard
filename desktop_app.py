"""Punto de entrada de la distribución "amigable" empaquetada con PyInstaller (ver Propuesta #6
en BACKLOG.md y CLAUDE.md, sección "Distribución con ejecutable de Windows"). NO se usa en la vía
técnica (`python app.py` / `launch.py`) -- esta es una segunda vía de arranque para el .exe, que
convive con la anterior sin sustituirla.

Bloque 2 (ventana nativa): arranca Flask en un hilo de fondo (host 127.0.0.1 -- el único cliente
es la propia ventana local, no hace falta exponerlo a la LAN como sí hace `launch.py` con host
0.0.0.0) y muestra el dashboard en una ventana propia de escritorio con pywebview (motor WebView2,
de serie en Windows 10/11) en vez de abrir el navegador por defecto del sistema (Bloque 1).

Bloque 3 (auto-actualización): antes de arrancar Flask, comprueba si hay una versión más nueva
publicada en GitHub Releases (ver updater.py) y, si la hay, se auto-reemplaza y reinicia -- nunca
bloquea el arranque ni interrumpe con ventanas modales si la comprobación falla.
"""
import threading
import time

import requests
import webview

from app import app, get_app_version, logger
from updater import check_for_update_and_restart

DASHBOARD_URL = "http://127.0.0.1:5000"
SERVER_READY_TIMEOUT = 15


def _run_flask():
    # threaded=True: la UI hace varias peticiones a la vez (carga inicial, proxy al móvil,
    # conciliación...) y el servidor de desarrollo de Flask solo atiende una a la vez si no.
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True, use_reloader=False)


def _wait_for_server(timeout=SERVER_READY_TIMEOUT):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            requests.get(DASHBOARD_URL, timeout=1)
            return True
        except requests.exceptions.RequestException:
            time.sleep(0.2)
    return False


def main():
    # Nunca bloquea ni lanza excepciones -- ver updater.py. Si hay actualización, esta llamada no
    # vuelve (el proceso termina y se relanza ya actualizado).
    check_for_update_and_restart(get_app_version(), logger=logger)

    threading.Thread(target=_run_flask, daemon=True).start()
    if not _wait_for_server():
        logger.error("Flask no respondió a tiempo tras arrancar -- se abre la ventana igualmente.")

    # Decisión de diseño (ver CLAUDE.md): ventana con el marco por defecto de pywebview (sin
    # frameless=True) -- pywebview no ofrece en su API pública un modo intermedio real de "solo
    # ocultar la barra de título pero conservar los botones de sistema", y el marco por defecto ya
    # cumple el objetivo real (que no lo parezca un navegador): WebView2 no dibuja barra de
    # direcciones, pestañas ni marcadores.
    webview.create_window(
        "Money Manager Dashboard",
        DASHBOARD_URL,
        width=1280,
        height=860,
        min_size=(900, 600),
    )
    webview.start()


if __name__ == "__main__":
    main()
