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
    }
    save_store(store)
    return key
