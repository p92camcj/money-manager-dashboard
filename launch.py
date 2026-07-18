"""Lanzador de doble clic para Money Manager Dashboard.

Comprueba que el servidor "PC Manager" del móvil esté accesible antes de
arrancar Flask, y abre el navegador automáticamente en el dashboard.
"""
import json
import os
import sys
import threading
import time
import webbrowser

import requests

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
CHECK_TIMEOUT = 3
DASHBOARD_URL = "http://localhost:5000"


def get_phone_url():
    try:
        with open(CONFIG_FILE, "r") as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        config = {}

    ip = str(config.get("phone_ip", "192.168.5.248:8888"))
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
    wait_for_phone()

    sys.path.insert(0, BASE_DIR)
    from app import app  # import diferido: solo tras confirmar conexión

    threading.Thread(target=open_browser_delayed, daemon=True).start()

    print(f"Arrancando Flask en {DASHBOARD_URL} ...")
    app.run(host="0.0.0.0", port=5000, debug=False)


if __name__ == "__main__":
    main()
