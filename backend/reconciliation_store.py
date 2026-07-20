import hashlib
import json
import os
import uuid
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


def entry_mm_ids(entry):
    """Devuelve la lista de ids reales de Money Manager implicados en una entrada del almacén,
    sea cual sea su formato -- entradas antiguas (anteriores a la Propuesta #16, enlaces 1:1)
    guardan un único `mm_id` (str); entradas nuevas (1:1 o N:M) guardan siempre `mm_ids` (lista),
    incluso cuando solo hay uno. Centraliza esta compatibilidad hacia atrás en un único sitio en
    vez de repetir el `.get('mm_ids') or [...]` en cada llamante (app.py la usa tanto para calcular
    `excluded_mm_ids` del arqueo de caja como para poblar `reconciled_mm_ids` de una propuesta)."""
    if 'mm_ids' in entry:
        return list(entry['mm_ids'])
    if 'mm_id' in entry:
        return [entry['mm_id']]
    return []


def confirm_group(bank_lines, mm_ids, note=None):
    """Enlace manual N:M (Propuesta #16, BACKLOG.md): vincula localmente VARIAS líneas del Excel
    del banco con VARIOS registros ya existentes en Money Manager -- p.ej. tres abonos de
    intereses del banco que en conjunto corresponden a un único registro de "Ingresos por
    intereses" en Money Manager, o al revés. NUNCA escribe en el móvil, igual que confirm().

    `bank_lines`: lista de dicts {date, amount, description} -- una entrada del almacén (indexada
    por `make_key()`) POR CADA línea de banco, para que analyze_excel() pueda seguir buscando la
    conciliación de una línea concreta por su propia clave, exactamente igual que con un enlace
    1:1. Todas comparten el mismo `group_id` (nuevo, generado aquí) y el mismo `mm_ids` completo
    (la lista entera de registros de MM del grupo, no uno por línea) -- así, tanto si el grupo es
    N:1, 1:M o N:M, CUALQUIER línea de banco del grupo resuelve el enlace completo, y el arqueo de
    caja (`excluded_mm_ids` en app.py) excluye TODOS los `mm_ids` del grupo con solo mirar
    cualquiera de sus entradas.

    `note` (opcional): texto libre que describe la correspondencia (p.ej. qué líneas de banco
    representa la suma) -- se persiste tal cual para que el frontend pueda ofrecer añadirlo como
    observación a los registros de MM implicados; este módulo NUNCA escribe esa nota en el móvil,
    solo la guarda localmente junto al resto del grupo.

    Devuelve `(group_id, keys)` con `keys` en el mismo orden que `bank_lines`, para que el llamante
    pueda reportar qué clave correspondió a cada línea si hace falta."""
    group_id = str(uuid.uuid4())
    confirmed_at = datetime.now(timezone.utc).isoformat()
    store = load_store()
    keys = []
    for line in bank_lines:
        key = make_key(line['date'], line['amount'], line['description'])
        store[key] = {
            "mm_ids": list(mm_ids),
            "confirmed_at": confirmed_at,
            "status": "confirmed",
            "group_id": group_id,
            "date": line['date'],
            "amount": line['amount'],
            "description": line['description'],
        }
        if note:
            store[key]["note"] = note
        keys.append(key)
    save_store(store)
    return group_id, keys


def get_last_confirmation_group():
    """Devuelve `(keys, entries)` -- listas paralelas, en el mismo orden -- de la conciliación
    confirmada más reciente por `confirmed_at` (nunca por orden de inserción del dict, más
    robusto si el fichero se ha llegado a editar a mano), o `([], [])` si el almacén está vacío.

    Si la entrada más reciente pertenece a un grupo N:M (`group_id`, Propuesta #16), devuelve
    TODAS las entradas de ese grupo -- para que "Deshacer" pueda tratar un enlace N:M como una
    única unidad (todas las líneas de banco del grupo a la vez), no solo la primera. Entradas
    antiguas sin `group_id` (enlaces 1:1 de antes de esta propuesta) se comportan igual que antes:
    un grupo de una sola entrada."""
    store = load_store()
    if not store:
        return [], []
    last_key = max(store, key=lambda k: store[k].get('confirmed_at', ''))
    group_id = store[last_key].get('group_id')
    if not group_id:
        return [last_key], [store[last_key]]
    keys = [k for k, v in store.items() if v.get('group_id') == group_id]
    return keys, [store[k] for k in keys]


def undo_last_confirmation_group():
    """Elimina del almacén TODAS las entradas del grupo devuelto por
    `get_last_confirmation_group()` y las devuelve (cada una con su `key` incluida), o `None` si
    no había nada que deshacer. Sigue siendo "solo la última" a nivel de grupo -- no un historial
    de deshacer con varios pasos -- pero ahora una unidad puede ser varias líneas de banco a la
    vez si el grupo era N:M."""
    keys, entries = get_last_confirmation_group()
    if not keys:
        return None
    store = load_store()
    removed = []
    for key in keys:
        entry = store.pop(key, None)
        if entry is not None:
            entry = dict(entry)
            entry['key'] = key
            removed.append(entry)
    save_store(store)
    return removed
