import re
import json
import os
import logging
from logging.handlers import RotatingFileHandler
from collections import Counter
import requests
import pandas as pd
import xml.etree.ElementTree as ET
from flask import Flask, request, jsonify, send_from_directory, Response
from flask_cors import CORS

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# La consola de Windows puede "perder" los print() de diagnóstico por varios
# motivos fuera de nuestro control (block-buffering de stdout, QuickEdit Mode
# de cmd.exe congelando la salida al hacer clic en la ventana, etc). En vez de
# perseguir cada motivo posible, los logs de diagnóstico ([analyze-excel],
# Proxying..., [reconciliations]) van también a un fichero rotado en logs/
# app.log — siempre disponible aunque la consola no muestre nada nuevo.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

from backend.paths import base_dir, resource_dir

# logs/, config.json y data/ deben persistir entre arranques -> base_dir() (carpeta del propio
# .exe cuando está empaquetado con PyInstaller, raíz del repo en desarrollo). Ver backend/paths.py.
LOG_DIR = os.path.join(base_dir(), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logger = logging.getLogger("money_manager_dashboard")
logger.setLevel(logging.INFO)
_log_formatter = logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S")

_console_handler = logging.StreamHandler(sys.stdout)
_console_handler.setFormatter(_log_formatter)
logger.addHandler(_console_handler)

_file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, "app.log"), maxBytes=2_000_000, backupCount=3, encoding="utf-8"
)
_file_handler.setFormatter(_log_formatter)
logger.addHandler(_file_handler)

from backend.reconciliation import match_bank_transactions, build_mm_dataframe, find_mm_orphans
from backend.reconciliation_store import (
    make_key, get_confirmation, load_store as load_reconciliation_store, confirm as confirm_reconciliation,
    entry_mm_ids, confirm_group, get_last_confirmation_group, undo_last_confirmation_group,
)
from backend.bank_statement_parser import parse_bank_statement, parse_bank_date, BankStatementFormatError
from backend.budget_engine import BudgetEngine

app = Flask(__name__, static_folder=os.path.join(resource_dir(), 'static'))
CORS(app)  # Permite acceso desde el frontend en desarrollo

# Configuración persistente. CONFIG_FILE vive junto al .exe (o en la raíz del repo en
# desarrollo) porque debe sobrevivir entre arranques -- ver backend/paths.py. VERSION_FILE y
# NOVEDADES_FILE son recursos de solo lectura empaquetados junto con el código, por eso usan
# resource_dir(). LAST_SEEN_VERSION_FILE en cambio es dato de usuario (qué versión ya vio el
# aviso de novedades) y debe persistir entre arranques del .exe, por eso usa base_dir() -- ver
# CLAUDE.md, "Aviso de novedades tras auto-actualizar".
CONFIG_FILE = os.path.join(base_dir(), "config.json")
VERSION_FILE = os.path.join(resource_dir(), "VERSION")
NOVEDADES_FILE = os.path.join(resource_dir(), "NOVEDADES.md")
LAST_SEEN_VERSION_FILE = os.path.join(base_dir(), "last_seen_version.txt")
# config.json no está versionado (cada usuario tiene su propia IP de LAN, ver
# config.example.json) — este valor de ejemplo es el único que vive en el código, y se usa
# tanto como fallback en memoria como para crear config.json en el primer arranque.
DEFAULT_CONFIG = {"phone_ip": "192.168.1.100:8888", "phone_port": "8888"}

def get_app_version():
    try:
        with open(VERSION_FILE, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return "0.0.0.0"

def _version_tuple(v):
    """Convierte 'X.Y.Z.W' (o 'vX.Y.Z.W') en una tupla comparable. Cualquier versión que no siga
    ese formato se trata como la más antigua posible, para no romper la comparación."""
    try:
        return tuple(int(p) for p in v.strip().lstrip('v').split('.'))
    except (ValueError, AttributeError):
        return (0,)

def parse_novedades():
    """Parsea NOVEDADES.md (convención documentada en CLAUDE.md) a una lista de entradas
    {version, date, summary: [linea, ...]}, en el mismo orden en que aparecen en el fichero (más
    reciente primero, igual que CHANGELOG.md). Si el fichero no existe (p.ej. un .exe antiguo sin
    empaquetar todavía, o se borró a mano), devuelve una lista vacía -- nunca lanza."""
    entries = []
    try:
        with open(NOVEDADES_FILE, 'r', encoding='utf-8') as f:
            content = f.read()
    except (FileNotFoundError, OSError):
        return entries

    current = None
    for line in content.splitlines():
        stripped = line.strip()
        header_match = re.match(r'^##\s+([\d.]+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$', stripped)
        if header_match:
            if current:
                entries.append(current)
            current = {'version': header_match.group(1), 'date': header_match.group(2), 'summary': []}
            continue
        if current is None:
            continue
        bullet_match = re.match(r'^-\s+(.+)$', stripped)
        if bullet_match:
            current['summary'].append(bullet_match.group(1))
        elif stripped and current['summary']:
            # Línea de continuación de un bullet envuelto en varias líneas (el resto de los .md
            # del proyecto se envuelve a ~90-100 caracteres por legibilidad, ver CHANGELOG.md/
            # BACKLOG.md) -- se une con un espacio a la última línea del resumen en vez de
            # descartarla silenciosamente (confirmado con un caso real: sin esto, dos bullets de
            # NOVEDADES.md quedaban truncados a mitad de frase).
            current['summary'][-1] = f"{current['summary'][-1]} {stripped}"
    if current:
        entries.append(current)
    return entries

def get_last_seen_version():
    if os.path.exists(LAST_SEEN_VERSION_FILE):
        try:
            with open(LAST_SEEN_VERSION_FILE, 'r') as f:
                text = f.read().strip()
                return text or None
        except OSError:
            pass
    return None

def save_last_seen_version(version):
    with open(LAST_SEEN_VERSION_FILE, 'w') as f:
        f.write(version)

def get_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except:
            pass
    # Primer arranque (o config.json corrupto/ausente): se crea con el valor de ejemplo para
    # que el usuario lo edite desde la pestaña Ajustes (POST /api/config) sin tener que tocar
    # el fichero a mano.
    save_config(DEFAULT_CONFIG)
    return DEFAULT_CONFIG

def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f)

def get_phone_url():
    c = get_config()
    ip = str(c.get("phone_ip", DEFAULT_CONFIG["phone_ip"]))
    port = str(c.get("phone_port", DEFAULT_CONFIG["phone_port"]))
    # Limpieza de IP por si el usuario metió el puerto en el campo IP
    if ":" in ip:
        parts = ip.split(":")
        base_ip = parts[0]
        base_port = parts[1]
        return f"http://{base_ip}:{base_port}"
    return f"http://{ip}:{port}"

def clean_json(text):
    """Limpia JSON no estándar de forma segura para Unicode/Emojis."""
    try:
        # 1. Asegurar comillas en claves (word:) sin tocar emojis
        text = re.sub(r'(\w+)\s*:', r'"\1":', text)
        # 2. Convertir comillas simples a dobles en valores : '...'
        text = re.sub(r":\s*'([^']*)'", r': "\1"', text)
        # 2b. Igual que 2, pero para valores DENTRO de un array literal (p.ej.
        # `getInitData` real devuelve "inOutText":[['Gasto'],['Ingreso']] -- sin ':' inmediatamente
        # antes, la regla 2 no los tocaba y json.loads() fallaba para TODO el documento, dejando
        # `fetchCategoryMap()` silenciosamente sin datos (por tanto sin mcid/mcscid -- Bug #2 volvía
        # a manifestarse aunque su fix seguía en su sitio). Cubre un valor de cadena precedido
        # directamente por '[' o ',' (apertura de array o siguiente elemento), no solo por ':'.
        text = re.sub(r"([\[,]\s*)'([^']*)'", r'\1"\2"', text)
        # 3. Eliminar comas finales
        text = re.sub(r',\s*([\]}])', r'\1', text)
        return text
    except:
        return text

def clean_nans(obj):
    import math
    if isinstance(obj, float) and math.isnan(obj):
        return None
    if isinstance(obj, dict):
        return {k: clean_nans(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_nans(x) for x in obj]
    return obj

def xml_to_dict(xml_data):
    """Convierte el XML de transacciones de Money Manager a una lista de diccionarios JSON."""
    try:
        if isinstance(xml_data, bytes):
            xml_data = xml_data.decode('utf-8', errors='ignore')
        root = ET.fromstring(xml_data)
        transactions = []
        for row in root.findall('row'):
            transaction = {}
            for child in row:
                text = child.text if child.text else ""
                transaction[child.tag] = text
            transactions.append(transaction)
        return transactions
    except Exception as e:
        logger.error(f"Error parsing XML: {e}")
        return []

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/static/<path:path>')
def serve_static_dir(path):
    return send_from_directory(app.static_folder, path)

@app.route('/<path:path>')
def serve_root(path):
    if os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return jsonify({"error": "No encontrado"}), 404

@app.route('/api/proxy/<path:endpoint>', methods=['GET', 'POST'])
def proxy(endpoint):
    """Proxy robusto para redireccionar peticiones al móvil."""
    phone_url = get_phone_url()
    url = f"{phone_url}/{endpoint}"
    params = request.args.to_dict()
    
    # Diagnóstico temporal del Bug #2 (BACKLOG.md): loguear el payload real enviado a
    # create/update y la respuesta cruda del móvil, para confirmar contra datos reales si el
    # problema es el mapeo inOutType/inOutCode o la falta de mcid/mcscid en el payload.
    is_write_endpoint = endpoint in ('moneyBook/create', 'moneyBook/update')
    if is_write_endpoint:
        logger.info(f"[write-debug] {endpoint} payload enviado: {request.form.to_dict()}")

    try:
        logger.info(f"Proxying {request.method} to: {url} (Timeout: 15s)")
        if request.method == 'GET':
            resp = requests.get(url, params=params, timeout=15)
        else:
            resp = requests.post(url, data=request.form, timeout=15)

        resp.raise_for_status()

        # Forzar decodificación UTF-8 en la respuesta en crudo para evitar corrupción
        resp.encoding = 'utf-8'
        text = resp.text
        content_type = resp.headers.get('Content-Type', '').lower()

        if is_write_endpoint:
            logger.info(f"[write-debug] {endpoint} respuesta cruda del móvil ({resp.status_code}): {text[:500]!r}")

        if 'xml' in content_type or '<dataset>' in text:
            return jsonify(xml_to_dict(text))
        
        if text.strip().startswith(('[', '{')):
            try:
                return jsonify(resp.json())
            except:
                try:
                    cleaned = clean_json(text)
                    return jsonify(json.loads(cleaned))
                except Exception as e:
                    # Si falla el parseo tras limpieza, devolver como texto con encoding correcto
                    return Response(text, status=200, mimetype='application/json', content_type='application/json; charset=utf-8')
        
        return Response(text, status=resp.status_code, mimetype='application/json', content_type='application/json; charset=utf-8')
            
    except requests.exceptions.Timeout:
        # mm_connection_error, además del ya existente demo_mode (Bug #1, BACKLOG.md): campo
        # único que el frontend comprueba en todos los endpoints que dependen del móvil, para
        # que un fallo a mitad de sesión (no solo en la carga inicial) actualice el indicador de
        # conexión -- ver updateConnectionStatus()/reportMmConnection() en static/script.js.
        return jsonify({"error": "Timeout", "demo_mode": True, "mm_connection_error": True}), 504
    except Exception as e:
        logger.error(f"Proxy Error: {e}")
        return jsonify({"error": str(e), "demo_mode": True, "mm_connection_error": True}), 503

@app.route('/api/analyze-excel', methods=['POST'])
def analyze_excel():
    """Analiza uno o varios extractos bancarios (Excel o CSV) a la vez, cada uno con su propia
    etiqueta de origen y, opcionalmente, una o varias cuentas/tarjetas de Money Manager
    asociadas. Una sola consulta a Money Manager cubriendo el rango de fechas combinado de todos
    los ficheros, y el matching se hace por separado para cada fichero. Cuando un fichero tiene
    cuentas asociadas, el matching se hace en dos fases (ver `match_bank_transactions`): acotado
    a esas cuentas/tarjetas primero, y solo si una línea concreta no encuentra NINGÚN candidato
    así, una segunda pasada sin el filtro (`account_fallback: true` en el resultado) — un
    extracto de una cuenta mezcla movimientos hechos directamente en la cuenta con movimientos
    hechos con tarjetas vinculadas a ella (`linkAssetId`), y Money Manager no es consistente
    sobre cuál `assetId` usa para cada uno. El filtro por cuenta además permite que una
    transferencia entre dos cuentas propias (p.ej. Cajasur -> Revolut) se resuelva como match
    tanto desde el extracto del banco origen como desde el del banco destino, sin que uno
    "consuma" el lado del otro. El DataFrame de transacciones de Money Manager
    (`build_mm_dataframe()`) se construye UNA SOLA VEZ para toda la tanda y se pasa COMPARTIDO a
    cada fichero (Propuesta #4 en BACKLOG.md, resuelta) -- así, si dos ficheros de la misma tanda
    contienen el mismo movimiento real (con o sin cuenta asociada), el primero que lo consuma
    dentro de la tanda no se lo "queda" para el segundo: el segundo ve que ya está consumido y, o
    bien no lo repite como el mismo `exact_match` (evitando dejar una segunda transacción real de
    Money Manager con la misma fecha/importe invisible para siempre), o bien lo resuelve como el
    lado opuesto de una transferencia si aplica."""
    uploaded_files = request.files.getlist('files')
    labels = request.form.getlist('labels')
    account_ids_raw = request.form.getlist('accountIds')  # uno por fichero, ids separados por comas
    window_days = int(request.form.get('windowDays', 3))

    if not uploaded_files:
        return jsonify({"error": "No hay archivos"}), 400

    try:
        parsed_files = []  # [{label, filename, df, account_ids}]
        file_errors = []  # [{label, filename, error}]
        for idx, file in enumerate(uploaded_files):
            label = (labels[idx].strip() if idx < len(labels) and labels[idx].strip() else file.filename)
            raw_field = account_ids_raw[idx].strip() if idx < len(account_ids_raw) else ''
            account_ids = [a.strip() for a in raw_field.split(',') if a.strip()] or None
            file_bytes = file.read()
            try:
                df, header_row_idx, column_map = parse_bank_statement(file_bytes, file.filename)
                logger.info(f"[analyze-excel] '{file.filename}' ({label}): cabecera detectada en fila {header_row_idx} (0-indexada) | columnas: {column_map} | cuentas asociadas: {account_ids or '(ninguna)'}")
                parsed_files.append({'label': label, 'filename': file.filename, 'df': df, 'account_ids': account_ids})
            except BankStatementFormatError as e:
                logger.error(f"[analyze-excel] '{file.filename}' ({label}): estructura no reconocida: {e}")
                file_errors.append({'label': label, 'filename': file.filename, 'error': str(e)})

        if not parsed_files:
            return jsonify({"error": "Ningún fichero reconocible", "file_errors": file_errors}), 400

        # Rango de fechas combinado de TODOS los ficheros — una sola consulta al móvil
        all_dates = pd.concat([parse_bank_date(pf['df']['Fecha']) for pf in parsed_files])
        valid_dates = all_dates.dropna()
        for pf in parsed_files:
            pf_dates = parse_bank_date(pf['df']['Fecha'])
            pf_valid = pf_dates.notna() & pf['df']['Importe'].notna()
            logger.info(f"[analyze-excel] '{pf['filename']}' ({pf['label']}): {len(pf['df'])} filas totales | {pf_valid.sum()} válidas")

        phone_url = get_phone_url()
        if valid_dates.empty:
            start_str, end_str = "2026-03-01", "2026-03-31"
        else:
            start_str = (valid_dates.min() - pd.Timedelta(days=15)).strftime('%Y-%m-%d')
            end_str = (valid_dates.max() + pd.Timedelta(days=15)).strftime('%Y-%m-%d')

        mm_url = f"{phone_url}/moneyBook/getDataByPeriod?startDate={start_str}&endDate={end_str}"
        logger.info(f"[analyze-excel] Consultando Money Manager (rango combinado de {len(parsed_files)} fichero(s)): {mm_url}")
        try:
            resp = requests.get(mm_url, timeout=10)
            resp.raise_for_status()
            real_transactions = xml_to_dict(resp.content)
            logger.info(f"[analyze-excel] Money Manager respondió {resp.status_code} | {len(real_transactions)} transacciones recibidas")
            for sample in real_transactions[:3]:
                logger.info(f"[analyze-excel]   muestra: { {k: sample.get(k) for k in ('mbDate', 'mbCash', 'mbContent', 'inOutType', 'assetId')} }")
        except requests.exceptions.RequestException as e:
            # Bug #1 (BACKLOG.md): un fallo de conexión real con el móvil (ConnectionError,
            # Timeout, o un status de error que raise_for_status() convierte en excepción) NO
            # debe tratarse como "cero transacciones" -- seguir adelante con real_transactions=[]
            # generaría un "nuevo movimiento" falso por cada línea del/de los Excel(s), como si de
            # verdad no existieran en Money Manager, cuando en realidad no se pudo comprobar.
            # Se aborta aquí con un error explícito y distinguible (`mm_connection_error: true`,
            # HTTP 503) en vez de continuar con el matching.
            logger.error(f"[analyze-excel] ERROR DE CONEXIÓN consultando Money Manager en {mm_url}: {e}")
            return jsonify({
                "error": "No se pudo conectar con Money Manager en el móvil -- comprueba que la app esté abierta y PC Manager activo, y vuelve a intentarlo.",
                "mm_connection_error": True,
                "file_errors": file_errors,
            }), 503

        # Matching por fichero, compartiendo el mismo DataFrame de Money Manager (ver
        # build_mm_dataframe() y Propuesta #4 en BACKLOG.md) para que el consumo de una
        # transacción en un fichero sea visible para los demás ficheros de la misma tanda.
        mm_df = build_mm_dataframe(real_transactions)
        reconciliations = load_reconciliation_store()
        all_proposals = []
        reconciled_count = 0
        for file_idx, pf in enumerate(parsed_files):
            proposals = match_bank_transactions(
                excel_df=pf['df'],
                mm_df=mm_df,
                date_col='Fecha',
                amount_col='Importe',
                desc_col='Concepto',
                window_days=window_days,
                account_ids=pf.get('account_ids')
            )
            for p in proposals:
                p['source_id'] = f"f{file_idx}_{p['source_id']}"
                p['source_label'] = pf['label']
                p['source_filename'] = pf['filename']

                # Sobreescribir con conciliaciones ya confirmadas en sesiones anteriores: el
                # usuario ya dio la respuesta correcta, no hace falta volver a preguntarle sobre
                # la misma línea. La clave NO incluye la etiqueta — identifica el movimiento
                # bancario en sí, no de qué fichero vino.
                key = make_key(p['date'], p['amount'], p['description'])
                confirmation = get_confirmation(key, store=reconciliations)
                if confirmation:
                    p['status'] = 'reconciled'
                    p['confidence'] = 100
                    # entry_mm_ids() cubre tanto enlaces 1:1 antiguos (`mm_id` suelto) como enlaces
                    # N:M nuevos (Propuesta #16, `mm_ids` lista) -- suggested_mm_ref se queda con
                    # el primero para no romper "Ver Registro Asociado" (un único registro, ya
                    # verificado), reconciled_mm_ids lleva la lista completa para que el frontend
                    # pueda distinguir un enlace N:M de uno simple si quiere mostrar los demás.
                    ids = entry_mm_ids(confirmation)
                    p['suggested_mm_ref'] = ids[0] if ids else None
                    p['reconciled_mm_ids'] = ids
                    p['candidates'] = []
                    reconciled_count += 1

                all_proposals.append(p)

        status_counts = Counter(p['status'] for p in all_proposals)
        logger.info(f"[analyze-excel] Resultado de conciliación ({len(all_proposals)} filas de {len(parsed_files)} fichero(s), {reconciled_count} ya conciliadas antes): {dict(status_counts)}")

        # Arqueo de caja (Propuesta #11 en BACKLOG.md, ver diseño completo en CLAUDE.md): sentido
        # contrario al de arriba (MM -> banco). Solo participan los ficheros con account_ids (sin
        # cuenta asociada no hay un universo delimitado de MM contra el que buscar huérfanos), y
        # se calcula DESPUÉS de que el bucle anterior haya terminado de mutar `mm_df` para TODOS
        # los ficheros de la tanda -- un huérfano candidato de un fichero puede resolverse por el
        # exact_match de OTRO fichero de la misma tanda (p.ej. las dos caras de una transferencia
        # entre bancos propios). `pf['df']['Fecha']` ya quedó parseada a datetime in situ por
        # match_bank_transactions() durante ese bucle, así que su min/max ya es directamente
        # utilizable sin volver a parsear.
        file_contexts = []
        for pf in parsed_files:
            if not pf.get('account_ids'):
                continue
            file_dates = pf['df']['Fecha'].dropna()
            if file_dates.empty:
                continue
            file_contexts.append({
                'label': pf['label'],
                'filename': pf['filename'],
                'account_ids': pf['account_ids'],
                'start_date': file_dates.min(),
                'end_date': file_dates.max(),
            })
        # TODOS los mm_id ya conciliados en el store, no solo los de esta tanda -- una transacción
        # conciliada hace tiempo cuyo Excel original no se ha vuelto a subir hoy no debe reaparecer
        # como falso huérfano. entry_mm_ids() cubre tanto `mm_id` (enlaces 1:1 antiguos) como
        # `mm_ids` (Propuesta #16, enlaces N:M) -- un enlace N:M debe excluir TODOS los registros
        # de MM del grupo, no solo el primero.
        excluded_mm_ids = {mid for v in reconciliations.values() for mid in entry_mm_ids(v)}
        mm_orphans = find_mm_orphans(mm_df, file_contexts, excluded_mm_ids)
        logger.info(f"[analyze-excel] Arqueo de caja: {len(mm_orphans)} huérfano(s) de Money Manager en {len(file_contexts)} fichero(s) con cuenta asociada")

        return jsonify({
            'proposals': clean_nans(all_proposals),
            'mm_orphans': clean_nans(mm_orphans),
            'file_errors': file_errors,
        })
    except Exception as e:
        logger.error(f"[analyze-excel] ERROR inesperado: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/reconciliations/confirm', methods=['POST'])
def confirm_reconciliation_endpoint():
    """Vincula localmente una línea del Excel del banco con una transacción ya existente en
    Money Manager. NUNCA escribe en el móvil — la transacción ya existe allí, esto solo evita
    volver a presentar la misma ambigüedad si se recarga un Excel que se solape en fechas."""
    data = request.json or {}
    date_str = data.get('date')
    amount = data.get('amount')
    description = data.get('description')
    mm_id = data.get('mm_id')

    if not date_str or amount is None or not description or not mm_id:
        return jsonify({"error": "Faltan campos: date, amount, description, mm_id"}), 400

    try:
        key = confirm_reconciliation(date_str, amount, description, mm_id)
        logger.info(f"[reconciliations] Confirmado {date_str} | {amount} | {description[:40]!r} -> mm_id={mm_id}")
        return jsonify({"status": "success", "key": key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/reconciliations/confirm-group', methods=['POST'])
def confirm_reconciliation_group_endpoint():
    """Propuesta #16 (BACKLOG.md): enlace manual N:M -- varias líneas del Excel del banco con
    varios registros ya existentes en Money Manager (p.ej. tres abonos de intereses del banco que
    en conjunto son un único "Ingresos por intereses" en MM, o al revés). NUNCA escribe en el
    móvil, igual que /api/reconciliations/confirm -- ver confirm_group() en reconciliation_store.py
    para el formato de persistencia (una entrada por línea de banco, todas comparten group_id).

    Body: `bank_lines` (lista de {date, amount, description}, al menos 1) y `mm_ids` (lista de ids
    reales de Money Manager, al menos 1) -- se acepta 1 elemento en cualquiera de los dos lados
    (un enlace "N:M" con N=1 o M=1 es simplemente un enlace 1:1 con metadatos de grupo, sigue
    funcionando igual). `note` opcional (texto libre, p.ej. detalle de qué líneas de banco
    representa la suma) -- se persiste tal cual, nunca se escribe en el móvil desde aquí."""
    data = request.json or {}
    bank_lines = data.get('bank_lines') or []
    mm_ids = data.get('mm_ids') or []
    note = data.get('note')

    if not bank_lines or not mm_ids:
        return jsonify({"error": "Faltan bank_lines y/o mm_ids (al menos uno de cada)."}), 400
    for line in bank_lines:
        if not line.get('date') or line.get('amount') is None or not line.get('description'):
            return jsonify({"error": "Cada elemento de bank_lines necesita date, amount y description."}), 400

    try:
        group_id, keys = confirm_group(bank_lines, mm_ids, note=note)
        logger.info(f"[reconciliations] Confirmado grupo {group_id} | {len(bank_lines)} línea(s) de banco <-> {len(mm_ids)} registro(s) de MM {mm_ids}")
        return jsonify({"status": "success", "group_id": group_id, "keys": keys})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/reconciliations/last', methods=['GET'])
def get_last_reconciliation_endpoint():
    """Propuesta #14 (BACKLOG.md), deshacer: info de la conciliación confirmada más reciente
    (por 'confirmar match'/'confirmar candidato' o por el modo de enlace manual -- ambos escriben
    aquí igual, ver /api/reconciliations/confirm), para que el frontend pueda mostrarle al usuario
    QUÉ se va a deshacer antes de pedir confirmación. `{last: null}` si el almacén está vacío.

    Propuesta #16: si la confirmación más reciente pertenece a un grupo N:M,
    `get_last_confirmation_group()` devuelve TODAS sus entradas -- el contrato de esta respuesta
    se unifica para siempre devolver listas (`bank_lines`, `mm_ids`), incluso para un enlace 1:1
    de toda la vida (listas de un solo elemento), así el frontend tiene un único formato que
    mostrar en el diálogo de confirmación de deshacer."""
    keys, entries = get_last_confirmation_group()
    if not keys:
        return jsonify({"last": None})
    bank_lines = [{"date": e.get("date"), "amount": e.get("amount"), "description": e.get("description")} for e in entries]
    mm_ids = sorted({mid for e in entries for mid in entry_mm_ids(e)})
    return jsonify({"last": {
        "keys": keys,
        "bank_lines": bank_lines,
        "mm_ids": mm_ids,
        "note": entries[0].get("note"),
        "confirmed_at": entries[0].get("confirmed_at"),
    }})

@app.route('/api/reconciliations/undo', methods=['POST'])
def undo_last_reconciliation_endpoint():
    """Deshace la última conciliación confirmada (la que devolvería GET /api/reconciliations/last
    en ese momento) -- solo la última, no un historial de deshacer con varios pasos. NUNCA toca
    Money Manager: el vínculo era solo local, así que deshacerlo tampoco escribe nada allí.

    Propuesta #16: si era un grupo N:M, deshace TODAS sus entradas (todas las líneas de banco del
    grupo) como una única unidad -- ver undo_last_confirmation_group(). `removed` es siempre una
    lista, incluso para un enlace 1:1 de toda la vida (lista de un solo elemento), mismo criterio
    de unificación de contrato que GET /api/reconciliations/last."""
    removed = undo_last_confirmation_group()
    if removed is None:
        return jsonify({"error": "No hay ninguna conciliación que deshacer."}), 404
    for entry in removed:
        logger.info(f"[reconciliations] Deshecho {entry.get('date')} | {entry.get('amount')} | "
                    f"{str(entry.get('description'))[:40]!r} -> mm_ids={entry_mm_ids(entry)}")
    return jsonify({"status": "success", "removed": removed})

@app.route('/api/budget-hierarchy', methods=['GET'])
def get_budget_hierarchy():
    phone_url = get_phone_url()
    start_date = request.args.get('startDate', '2026-03-01')
    end_date = request.args.get('endDate', '2026-03-31')

    try:
        # Fetch transacciones y presupuestos del móvil en paralelo para este motor
        resp_trans = requests.get(f"{phone_url}/moneyBook/getDataByPeriod?startDate={start_date}&endDate={end_date}", timeout=10)
        resp_trans.raise_for_status()
        transactions = xml_to_dict(resp_trans.content)

        resp_budgets = requests.get(f"{phone_url}/moneyBook/getSummaryDataByPeriod?startDate={start_date}&endDate={end_date}", timeout=10)
        resp_budgets.raise_for_status()
        # Forzar decodificación UTF-8 para evitar caracteres extraños ("ð¤ AHORRO")
        resp_text = resp_budgets.content.decode('utf-8', errors='ignore')

        # Parse budgets JSON using clean_json
        try:
            budgets = json.loads(resp_text)
        except:
            cleaned = clean_json(resp_text)
            budgets = json.loads(cleaned)

        engine = BudgetEngine(base_currency='EUR')
        hierarchy = engine.process_hierarchy(transactions, budgets)
        flows = engine.calculate_transfers_and_balances(transactions)

        return jsonify({
            'hierarchy': hierarchy,
            'cashflows': flows
        })
    except requests.exceptions.RequestException as e:
        # Bug #1 (BACKLOG.md): mismo criterio que analyze_excel() -- un fallo de conexión real
        # con el móvil no debe confundirse con "presupuesto vacío", error explícito y
        # distinguible en vez de dejar que un JSONDecodeError posterior sobre una respuesta
        # vacía/HTML de error se devuelva como un 500 genérico indistinguible de cualquier otro.
        logger.error(f"[budget-hierarchy] ERROR DE CONEXIÓN con Money Manager: {e}")
        return jsonify({
            "error": "No se pudo conectar con Money Manager en el móvil -- comprueba que la app esté abierta y PC Manager activo.",
            "mm_connection_error": True,
        }), 503
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/version', methods=['GET'])
def get_version():
    return jsonify({"version": get_app_version()})

@app.route('/api/novedades', methods=['GET'])
def get_novedades():
    """Novedades legibles para el usuario final tras auto-actualizar (ver CLAUDE.md, "Aviso de
    novedades tras auto-actualizar"). `entries` es el histórico completo (para el enlace "Ver
    novedades" bajo demanda); `new_entries` son solo las versiones más nuevas que la última que
    el usuario ya vio (para el aviso automático al arrancar)."""
    current_version = get_app_version()
    last_seen = get_last_seen_version()
    entries = parse_novedades()

    # Primer arranque real (nunca se ha marcado nada como visto): no hay "novedades" que
    # mostrar -- un usuario nuevo no ha usado ninguna versión anterior. Se marca la actual como
    # vista en silencio; el histórico completo sigue disponible bajo demanda.
    first_run = last_seen is None
    if first_run:
        save_last_seen_version(current_version)
        last_seen = current_version

    new_entries = [e for e in entries if _version_tuple(e['version']) > _version_tuple(last_seen)]

    return jsonify({
        'current_version': current_version,
        'last_seen_version': last_seen,
        'entries': entries,
        'new_entries': new_entries,
        'first_run': first_run,
    })

@app.route('/api/novedades/mark-seen', methods=['POST'])
def mark_novedades_seen():
    save_last_seen_version(get_app_version())
    return jsonify({"status": "success"})

@app.route('/api/config', methods=['GET', 'POST'])
def handle_config():
    if request.method == 'POST':
        data = request.json
        save_config(data)
        return jsonify({"status": "success"})
    return jsonify(get_config())

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
