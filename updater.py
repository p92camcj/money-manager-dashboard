"""Auto-actualización del .exe empaquetado, vía GitHub Releases (ver Propuesta #6 en
BACKLOG.md). Solo se usa desde `desktop_app.py` -- la vía técnica (`git clone` + `launch.py`) se
actualiza con `git pull` (ver `check_for_updates()` en launch.py) y nunca pasa por aquí: no hay
repo git local en la máquina de un amigo, así que la fuente de verdad aquí es la API de GitHub
Releases, no el historial de git.

Patrón de auto-reemplazo en Windows: un proceso no puede sobreescribir su propio .exe mientras
se está ejecutando. La solución estándar (la que se usa aquí, sin dependencias de terceros ni un
segundo ejecutable compilado) es un script .bat auxiliar que:
  1. espera (sondeando `tasklist` por PID) a que el proceso actual termine,
  2. mueve el .exe nuevo -- ya descargado a un fichero `.new` junto al viejo -- sobre el .exe
     original,
  3. relanza el .exe (ya actualizado),
  4. se borra a sí mismo.

Cualquier fallo (sin internet, GitHub no responde, el Release no tiene el asset esperado...) se
registra y la función simplemente retorna -- nunca debe bloquear ni impedir el arranque normal
con la versión local.
"""
import os
import subprocess
import sys
import tempfile

import requests

GITHUB_REPO = "p92camcj/money-manager-dashboard"
RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
ASSET_NAME = "MoneyManagerDashboard.exe"
REQUEST_TIMEOUT = 5
DOWNLOAD_TIMEOUT = 60


def _version_tuple(v):
    return tuple(int(p) for p in v.strip().lstrip("v").split("."))


def check_for_update_and_restart(current_version, logger=None):
    """Si hay una versión más nueva publicada en GitHub Releases, la descarga y reinicia la app
    ya actualizada (la llamada no vuelve -- el proceso termina con sys.exit). Si no hay
    actualización, o la comprobación falla por cualquier motivo, retorna normalmente sin más.
    No hace nada si no se está ejecutando como .exe empaquetado (modo desarrollo)."""
    log_info = logger.info if logger else print
    log_error = logger.error if logger else print

    if not getattr(sys, "frozen", False):
        return  # `python desktop_app.py` en desarrollo -- no hay .exe que auto-reemplazar

    try:
        resp = requests.get(RELEASES_API_URL, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        release = resp.json()
        latest_version = str(release.get("tag_name", "")).lstrip("v")

        if not latest_version or _version_tuple(latest_version) <= _version_tuple(current_version):
            log_info(f"[updater] Versión al día ({current_version}).")
            return

        asset = next((a for a in release.get("assets", []) if a.get("name") == ASSET_NAME), None)
        if not asset:
            log_error(
                f"[updater] Hay una versión nueva ({latest_version}) pero el Release no tiene "
                f"el asset '{ASSET_NAME}' -- se omite la actualización."
            )
            return

        log_info(f"[updater] Descargando actualización {current_version} -> {latest_version} ...")
        current_exe = sys.executable
        new_exe_path = current_exe + ".new"
        with requests.get(asset["browser_download_url"], timeout=DOWNLOAD_TIMEOUT, stream=True) as dl_resp:
            dl_resp.raise_for_status()
            with open(new_exe_path, "wb") as f:
                for chunk in dl_resp.iter_content(chunk_size=1024 * 256):
                    f.write(chunk)

        log_info(f"[updater] Descarga completa. Reiniciando con la versión {latest_version}...")
        _spawn_replace_and_exit(current_exe, new_exe_path)
    except Exception as e:
        log_error(f"[updater] No se pudo comprobar/aplicar la actualización ({e}). Arrancando con la versión local.")


def _spawn_replace_and_exit(current_exe, new_exe_path):
    pid = os.getpid()
    bat_path = os.path.join(tempfile.gettempdir(), "mm_dashboard_update.bat")
    bat_contents = (
        "@echo off\r\n"
        ":waitloop\r\n"
        f'tasklist /fi "PID eq {pid}" | find "{pid}" >nul\r\n'
        "if not errorlevel 1 (\r\n"
        "    timeout /t 1 /nobreak >nul\r\n"
        "    goto waitloop\r\n"
        ")\r\n"
        f'move /y "{new_exe_path}" "{current_exe}"\r\n'
        f'start "" "{current_exe}"\r\n'
        'del "%~f0"\r\n'
    )
    with open(bat_path, "w") as f:
        f.write(bat_contents)

    subprocess.Popen(["cmd", "/c", bat_path], creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
    sys.exit(0)
