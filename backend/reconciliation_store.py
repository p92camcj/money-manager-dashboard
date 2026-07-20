import hashlib
import json
import os
from datetime import datetime, timezone

from backend.paths import base_dir

STORE_PATH = os.path.join(base_dir(), "data", "reconciliations.json")


def make_key(date_str, amount, description):
    """Clave estable para una línea del extracto bancario.

    No hay ID nativo en el Excel del banco, así que la clave se deriva de
    fecha + importe + descripción normalizada. Dos movimientos distintos con
    fecha/importe/descripción idénticos comparten clave (limitación conocida,
    ver CLAUDE.md).
    """
    norm_desc = ' '.join(str(description).strip().lower().split())
    norm_amount = f"{round(float(amount), 2):.2f}"
    raw = f"{date_str}|{norm_amount}|{norm_desc}"
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def load_store():
    if not os.path.exists(STORE_PATH):
        return {}
    try:
        with open(STORE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_store(store):
    os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
    with open(STORE_PATH, 'w', encoding='utf-8') as f:
        json.dump(store, f, indent=2, ensure_ascii=False)


def get_confirmation(key, store=None):
    store = store if store is not None else load_store()
    return store.get(key)


def confirm(date_str, amount, description, mm_id):
    key = make_key(date_str, amount, description)
    store = load_store()
    store[key] = {
        "mm_id": mm_id,
        "confirmed_at": datetime.now(timezone.utc).isoformat(),
        "status": "confirmed",
        # date/amount/description en claro (Propuesta #14, BACKLOG.md): la clave es un hash
        # irreversible, así que sin esto "Deshacer última conciliación" no podría mostrarle al
        # usuario QUÉ se va a deshacer antes de confirmar. No es un dato nuevo -- ya vive tanto en
        # el Excel del banco del usuario como en Money Manager, y este fichero (data/) ya está
        # fuera de git por ser información personal.
        "date": date_str,
        "amount": amount,
        "description": description,
    }
    save_store(store)
    return key


def get_last_confirmation():
    """Devuelve `(key, entry)` de la conciliación confirmada más reciente por `confirmed_at`
    (nunca por orden de inserción del dict, más robusto si el fichero se ha llegado a editar a
    mano), o `(None, None)` si el almacén está vacío. Entradas guardadas antes de que este fichero
    empezara a persistir date/amount/description (ver `confirm()`) devuelven esos campos como
    `None` -- el llamante decide cómo degradar la información mostrada al usuario en ese caso."""
    store = load_store()
    if not store:
        return None, None
    last_key = max(store, key=lambda k: store[k].get('confirmed_at', ''))
    return last_key, store[last_key]


def undo_last_confirmation():
    """Elimina del almacén la conciliación confirmada más reciente (ver `get_last_confirmation()`)
    y devuelve la entrada eliminada (con su `key` incluida), o `None` si no había nada que
    deshacer. Deliberadamente solo la ÚLTIMA -- no un historial de deshacer con varios pasos, tal
    y como pedía la propuesta; sin rastro de qué se deshizo más allá de esta única operación."""
    key, entry = get_last_confirmation()
    if key is None:
        return None
    store = load_store()
    removed = store.pop(key)
    save_store(store)
    removed = dict(removed)
    removed['key'] = key
    return removed
