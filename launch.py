"""Lanzador de doble clic para Money Manager Dashboard.

Comprueba actualizaciones del repositorio, comprueba que el servidor "PC Manager" del móvil
esté accesible, y luego arranca Flask y abre el navegador automáticamente en el dashboard.
"""
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser

import requests

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
VERSION_FILE = os.path.join(BASE_DIR, "VERSION")
CHANGELOG_FILE = os.path.join(BASE_DIR, "CHANGELOG.md")
CHECK_TIMEOUT = 3
GIT_TIMEOUT = 15
DASHBOARD_URL = "http://localhost:5000"


def get_local_version():
    try:
        with open(VERSION_FILE, "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return "desconocida"


def print_changelog_entry(version):
    """Imprime el bloque de CHANGELOG.md correspondiente a esta versión, si existe — para que
    el usuario vea qué cambió sin tener que abrir el fichero a mano."""
    try:
        with open(CHANGELOG_FILE, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return
    start = next((i for i, line in enumerate(lines) if line.startswith(f"## {version}")), None)
    if start is None:
        return
    end = start + 1
    while end < len(lines) and not lines[end].startswith("## "):
        end += 1
    print("".join(lines[start:end]).strip())


def _run_git(*args):
    return subprocess.run(
        ["git", "-C", BASE_DIR, *args],
        capture_output=True, text=True, timeout=GIT_TIMEOUT
    )


def check_for_updates():
    """Comprueba si hay una versión nueva en el remoto y la descarga automáticamente. Nunca
    bloquea el arranque: cualquier fallo (sin conexión, git no instalado, no hay remoto
    configurado, cambios locales que impiden un fast-forward...) se avisa por consola y se
    continúa arrancando con lo que haya en local."""
    try:
        if _run_git("rev-parse", "--is-inside-work-tree").returncode != 0:
            print("Esta copia no es un repositorio git — omitiendo comprobación de actualizaciones.")
            return

        old_version = get_local_version()
        print("Comprobando actualizaciones...")

        fetch = _run_git("fetch", "--quiet")
        if fetch.returncode != 0:
            print("No se pudo comprobar actualizaciones (¿sin conexión a internet?). Arrancando con la versión local.")
            return

        local_rev = _run_git("rev-parse", "HEAD")
        remote_rev = _run_git("rev-parse", "@{u}")
        if local_rev.returncode != 0 or remote_rev.returncode != 0:
            print("No hay un remoto de seguimiento configurado — omitiendo actualización automática.")
            return

        old_head = local_rev.stdout.strip()
        if old_head == remote_rev.stdout.strip():
            print(f"Ya tienes la última versión ({old_version}).")
            return

        # HEAD local difiere del remoto -- puede ser que el remoto tenga commits nuevos, o que
        # el local vaya por delante (p.ej. cambios propios sin subir); --ff-only resuelve ambos
        # casos sin riesgo: si el remoto es descendiente del local, avanza; si el local ya
        # contiene al remoto, no hace nada («Already up to date»); si han divergido (alguien
        # tocó ficheros locales a mano), falla limpiamente sin tocar nada.
        pull = _run_git("pull", "--ff-only")
        if pull.returncode != 0:
            print("Hay una actualización disponible pero no se pudo aplicar automáticamente")
            print("(probablemente por cambios locales). Arrancando con la versión actual.")
            return

        new_head = _run_git("rev-parse", "HEAD").stdout.strip()
        if new_head == old_head:
            print(f"Ya tienes la última versión ({old_version}).")
            return

        new_version = get_local_version()
        if new_version != old_version:
            print(f"Actualizado de la versión {old_version} a la {new_version}.")
            print_changelog_entry(new_version)
        else:
            print("Se han descargado cambios nuevos del repositorio.")
    except Exception as e:
        print(f"No se pudo comprobar actualizaciones ({e}). Arrancando con la versión local.")


def get_phone_url():
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        config = {}

    ip = str(config.get("phone_ip", "192.168.1.100:8888"))
    port = str(config.get("phone_port", "8888"))
    if ":" in ip:
        ip, port = ip.split(":", 1)
    return f"http://{ip}:{port}"


def phone_reachable(phone_url):
    try:
        requests.get(f"{phone_url}/moneyBook/getAssetData", timeout=CHECK_TIMEOUT)
        return True
    except requests.exceptions.RequestException:
        return False


def wait_for_phone():
    phone_url = get_phone_url()
    while True:
        print(f"Comprobando conexión con Money Manager en {phone_url} ...")
        if phone_reachable(phone_url):
            print("Conexión establecida.")
            return
        print()
        print("No se detecta Money Manager en el móvil.")
        print("Abre la app, ve a Configuración > PC Manager y actívalo,")
        try:
            input("luego pulsa Enter para reintentar (Ctrl+C para cancelar)... ")
        except KeyboardInterrupt:
            print("\nCancelado por el usuario.")
            sys.exit(1)


def open_browser_delayed():
    time.sleep(1.5)
    webbrowser.open(DASHBOARD_URL)


def main():
    check_for_updates()
    wait_for_phone()

    sys.path.insert(0, BASE_DIR)
    from app import app  # import diferido: solo tras confirmar conexión

    threading.Thread(target=open_browser_delayed, daemon=True).start()

    print(f"Arrancando Flask en {DASHBOARD_URL} ...")
    app.run(host="0.0.0.0", port=5000, debug=False)


if __name__ == "__main__":
    main()
