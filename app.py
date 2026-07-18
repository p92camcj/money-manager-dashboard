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

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
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

from backend.reconciliation import match_bank_transactions
from backend.reconciliation_store import make_key, get_confirmation, load_store as load_reconciliation_store, confirm as confirm_reconciliation
from backend.bank_excel_parser import parse_bank_excel, BankExcelFormatError
from backend.budget_engine import BudgetEngine

app = Flask(__name__, static_folder='static')
CORS(app)  # Permite acceso desde el frontend en desarrollo

# Configuración persistente
CONFIG_FILE = "config.json"
VERSION_FILE = "VERSION"

def get_app_version():
    try:
        with open(VERSION_FILE, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return "0.0.0.0"

def get_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except:
            pass
    return {"phone_ip": "192.168.5.248:8888", "phone_port": "8888"}

def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f)

def get_phone_url():
    c = get_config()
    ip = str(c.get("phone_ip", "192.168.5.248:8888"))
    port = str(c.get("phone_port", "8888"))
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
        return jsonify({"error": "Timeout", "demo_mode": True}), 504
    except Exception as e:
        logger.error(f"Proxy Error: {e}")
        return jsonify({"error": str(e), "demo_mode": True}), 503

@app.route('/api/analyze-excel', methods=['POST'])
def analyze_excel():
    if 'file' not in request.files:
        return jsonify({"error": "No hay archivo"}), 400

    file = request.files['file']
    account_name = request.form.get('accountName', 'CASA')
    window_days = int(request.form.get('windowDays', 3))
    file_bytes = file.read()

    try:
        # Detección genérica de la estructura del banco (cabecera + columnas por alias,
        # ver backend/bank_excel_parser.py) — lanza BankExcelFormatError si no hay confianza
        # razonable, en vez de asumir algo silenciosamente incorrecto.
        df, header_row_idx, column_map = parse_bank_excel(file_bytes)
        logger.info(f"[analyze-excel] Cabecera detectada en fila {header_row_idx} (0-indexada) | columnas: {column_map}")

        parsed_dates = pd.to_datetime(df['Fecha'], errors='coerce', dayfirst=True)
        valid_rows = parsed_dates.notna() & df['Importe'].notna()
        logger.info(f"[analyze-excel] Filas totales en Excel: {len(df)} | Filas con fecha+importe válidos: {valid_rows.sum()}")
        if valid_rows.any():
            logger.info(f"[analyze-excel] Rango de fechas del Excel: {parsed_dates[valid_rows].min().date()} -> {parsed_dates[valid_rows].max().date()}")

        phone_url = get_phone_url()
        min_date = parsed_dates.min()
        max_date = parsed_dates.max()

        if pd.isna(min_date) or pd.isna(max_date):
            start_str, end_str = "2026-03-01", "2026-03-31"
        else:
            start_str = (min_date - pd.Timedelta(days=15)).strftime('%Y-%m-%d')
            end_str = (max_date + pd.Timedelta(days=15)).strftime('%Y-%m-%d')

        mm_url = f"{phone_url}/moneyBook/getDataByPeriod?startDate={start_str}&endDate={end_str}"
        logger.info(f"[analyze-excel] Consultando Money Manager: {mm_url}")
        try:
            resp = requests.get(mm_url, timeout=10)
            resp.raise_for_status()
            real_transactions = xml_to_dict(resp.content)
            logger.info(f"[analyze-excel] Money Manager respondió {resp.status_code} | {len(real_transactions)} transacciones recibidas")
            for sample in real_transactions[:3]:
                logger.info(f"[analyze-excel]   muestra: { {k: sample.get(k) for k in ('mbDate', 'mbCash', 'mbContent', 'inOutType', 'assetId')} }")
        except Exception as e:
            logger.error(f"[analyze-excel] ERROR consultando Money Manager en {mm_url}: {e}")
            real_transactions = []

        proposals = match_bank_transactions(
            excel_df=df,
            mm_transactions=real_transactions,
            date_col='Fecha',
            amount_col='Importe',
            desc_col='Concepto',
            window_days=window_days
        )

        # Sobreescribir con conciliaciones ya confirmadas en sesiones anteriores: el usuario ya dio
        # la respuesta correcta, no hace falta volver a preguntarle sobre la misma línea.
        reconciled_count = 0
        reconciliations = load_reconciliation_store()
        for p in proposals:
            key = make_key(p['date'], p['amount'], p['description'])
            confirmation = get_confirmation(key, store=reconciliations)
            if confirmation:
                p['status'] = 'reconciled'
                p['confidence'] = 100
                p['suggested_mm_ref'] = confirmation['mm_id']
                p['candidates'] = []
                reconciled_count += 1

        status_counts = Counter(p['status'] for p in proposals)
        logger.info(f"[analyze-excel] Resultado de conciliación ({len(proposals)} filas, {reconciled_count} ya conciliadas antes): {dict(status_counts)}")

        return jsonify(clean_nans(proposals))
    except BankExcelFormatError as e:
        logger.error(f"[analyze-excel] Estructura del Excel no reconocida: {e}")
        return jsonify({"error": str(e)}), 400
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

@app.route('/api/budget-hierarchy', methods=['GET'])
def get_budget_hierarchy():
    phone_url = get_phone_url()
    start_date = request.args.get('startDate', '2026-03-01')
    end_date = request.args.get('endDate', '2026-03-31')
    
    try:
        # Fetch transacciones y presupuestos del móvil en paralelo para este motor
        resp_trans = requests.get(f"{phone_url}/moneyBook/getDataByPeriod?startDate={start_date}&endDate={end_date}", timeout=10)
        transactions = xml_to_dict(resp_trans.content)
        
        resp_budgets = requests.get(f"{phone_url}/moneyBook/getSummaryDataByPeriod?startDate={start_date}&endDate={end_date}", timeout=10)
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
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/version', methods=['GET'])
def get_version():
    return jsonify({"version": get_app_version()})

@app.route('/api/config', methods=['GET', 'POST'])
def handle_config():
    if request.method == 'POST':
        data = request.json
        save_config(data)
        return jsonify({"status": "success"})
    return jsonify(get_config())

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
