"""Detección genérica de la estructura de un extracto bancario (Excel o CSV).

Cada banco exporta con un número distinto de filas de metadatos antes de la
cabecera real, columnas en orden distinto, y a veces nombres de columna
abreviados ("F. Valor" en vez de "Fecha valor"). En vez de asumir una
posición o un orden de columnas fijo, se busca la fila de cabecera real
clasificando cada celda contra listas de alias conocidos por campo, y se
mapean las columnas por lo que dicen sus celdas, no por su posición. Esta
detección es la misma independientemente del formato de fichero — lo único
que cambia según la extensión es cómo se lee el fichero en bruto a un
DataFrame (_read_raw).

Si no se puede detectar la estructura con confianza razonable, se lanza
BankStatementFormatError en vez de asumir algo silenciosamente incorrecto —
mejor un error explícito para el usuario que una conciliación mal hecha.
"""
import csv
import io
import re
import unicodedata

import pandas as pd

# Alias en forma normalizada (sin acentos, minúsculas, sin puntos/barras).
# "fecha_valor" se detecta explícitamente para IGNORARLA — no debe confundirse
# con la fecha de operación real (aparece en Cajasur, BBVA, EVO, Sabadell, Revolut).
FIELD_ALIASES = {
    'fecha': [
        'fecha', 'f operativa', 'fecha operativa', 'fecha contable',
        'fecha operacion', 'fecha movimiento', 'fecha de inicio', 'date',
    ],
    'fecha_valor': [
        'fecha valor', 'f valor', 'valor', 'fecha de finalizacion',
    ],
    'concepto': [
        'concepto', 'descripcion', 'comercio cajero', 'comercio',
        'detalle', 'concepto descripcion',
    ],
    'importe': [
        'importe', 'importe eur',
    ],
    'cargo': [
        'cargo', 'debe', 'salida',
    ],
    'abono': [
        'abono', 'haber', 'entrada',
    ],
}

CSV_EXTENSIONS = {'csv'}


class BankStatementFormatError(Exception):
    """El extracto no tiene una estructura de columnas de fecha/concepto/importe reconocible."""


def normalize_header_cell(text):
    """'F.Valor' -> 'f valor', 'COMERCIO/CAJERO' -> 'comercio cajero', 'Descripción' -> 'descripcion'."""
    text = str(text)
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')
    text = text.lower().replace('.', ' ').replace('/', ' ')
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def classify_header_cell(normalized_text):
    """Devuelve el nombre de campo (p.ej. 'fecha') cuya lista de alias contiene esta celda
    normalizada de forma exacta, o None si no coincide con ningún campo conocido."""
    if not normalized_text:
        return None
    for field, aliases in FIELD_ALIASES.items():
        if normalized_text in aliases:
            return field
    return None


def detect_bank_columns(raw_df, max_scan=30):
    """Busca la fila de cabecera real y mapea sus columnas a campos conocidos.

    Devuelve (header_row_idx, column_map) donde column_map es un dict
    {'fecha': col_idx, 'concepto': col_idx, 'importe': col_idx} (o 'cargo'/
    'abono' en vez de 'importe' si el banco los separa), o (None, None) si no
    se encuentra ninguna fila que reúna fecha + concepto + (importe o
    cargo+abono) con confianza razonable.
    """
    for idx in range(min(max_scan, len(raw_df))):
        row = raw_df.iloc[idx]
        found = {}
        for col_idx, cell in enumerate(row):
            field = classify_header_cell(normalize_header_cell(cell))
            if field and field not in found:
                found[field] = col_idx

        has_amount = 'importe' in found or ('cargo' in found and 'abono' in found)
        if 'fecha' in found and 'concepto' in found and has_amount:
            return idx, found

    return None, None


def parse_bank_date(series):
    """Parsea una columna de fechas que puede venir en formato español (DD/MM/YYYY, p.ej.
    Cajasur/BBVA/Sabadell) o ISO (YYYY-MM-DD[ HH:MM:SS], p.ej. Revolut).

    OJO: `pd.to_datetime(..., dayfirst=True)` interpreta MAL fechas ISO en pandas 3.x — p.ej.
    '2026-07-08' se convierte en 7 de agosto en vez de 8 de julio, aunque el formato no sea
    ambiguo (confirmado en pandas 3.0.3). Por eso se prueba primero como ISO8601 estricto (que
    rechaza con NaT cualquier cosa que no sea YYYY-MM-DD, así que nunca confunde un DD/MM/YYYY
    español), y solo se usa dayfirst=True como fallback para las fechas que ISO8601 no reconoce.
    """
    iso_parsed = pd.to_datetime(series, format='ISO8601', errors='coerce')
    dayfirst_parsed = pd.to_datetime(series, errors='coerce', dayfirst=True)
    return iso_parsed.combine_first(dayfirst_parsed)


def parse_spanish_amount(val):
    """Normaliza importes que pueden venir como texto con formato español
    (punto de miles, coma decimal, p.ej. '1.234,56') o ya firmados con punto
    decimal (p.ej. Revolut, '-21.78') en vez de float nativo."""
    if pd.isna(val):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = re.sub(r'[€$\s]', '', str(val).strip())
    if ',' in s and '.' in s:
        s = s.replace('.', '').replace(',', '.')
    elif ',' in s:
        s = s.replace(',', '.')
    try:
        return float(s)
    except ValueError:
        return None


def build_importe_series(df, column_map):
    """Construye la columna de importe con signo, combinando cargo/abono en una sola
    columna si el banco los separa, o usando la columna de importe directa si no."""
    if 'importe' in column_map:
        return df.iloc[:, column_map['importe']].apply(parse_spanish_amount)

    cargo = df.iloc[:, column_map['cargo']].apply(parse_spanish_amount).fillna(0).abs()
    abono = df.iloc[:, column_map['abono']].apply(parse_spanish_amount).fillna(0).abs()
    return abono - cargo


def _file_extension(filename):
    if not filename or '.' not in filename:
        return ''
    return filename.rsplit('.', 1)[-1].lower()


def _decode_csv_bytes(file_bytes):
    """Prueba encodings en orden hasta que uno decodifique sin errores. latin-1 nunca
    falla (mapea 1 byte -> 1 carácter), así que siempre hay un resultado."""
    for encoding in ('utf-8-sig', 'cp1252'):
        try:
            return file_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return file_bytes.decode('latin-1')


def _sniff_csv_delimiter(text_sample):
    try:
        return csv.Sniffer().sniff(text_sample, delimiters=',;\t|').delimiter
    except csv.Error:
        return ','


def _read_csv_grid(file_bytes, skiprows=0):
    """Lee un CSV a una rejilla uniforme tolerante a filas de ancho irregular.

    pandas.read_csv exige el mismo número de columnas en todas las filas (lanza
    ParserError si no); pero igual que los Excel bancarios, algunos CSV meten filas de
    metadatos más cortas antes de la cabecera real ("Titular: Juan Perez" es 1 campo,
    la fila de datos siguiente son 5). csv.reader no tiene ese problema — cada fila es
    simplemente una lista de la longitud que tenga — así que se lee así y se rellenan
    las filas cortas con None hasta el ancho máximo, imitando la rejilla dispersa que
    read_excel ya da de forma nativa.
    """
    text = _decode_csv_bytes(file_bytes)
    delimiter = _sniff_csv_delimiter(text[:4096])
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    if skiprows:
        rows = rows[skiprows:]
    max_cols = max((len(r) for r in rows), default=0)
    padded_rows = [r + [None] * (max_cols - len(r)) for r in rows]
    return pd.DataFrame(padded_rows)


def _read_raw(file_bytes, filename, skiprows=0):
    """Lee el fichero (Excel o CSV, según la extensión) a un DataFrame sin cabecera —
    misma forma de salida en ambos casos, para que detect_bank_columns() y el resto de
    la tubería no necesiten saber de qué formato vino."""
    if _file_extension(filename) in CSV_EXTENSIONS:
        return _read_csv_grid(file_bytes, skiprows=skiprows)
    return pd.read_excel(io.BytesIO(file_bytes), header=None, skiprows=skiprows)


def parse_bank_statement(file_bytes, filename, max_scan=30):
    """Lee los bytes de un extracto bancario (Excel o CSV) y devuelve
    (df, header_row_idx, column_map).

    df tiene exactamente las columnas 'Fecha', 'Concepto', 'Importe', listas para
    pasar a match_bank_transactions(). Lanza BankStatementFormatError si no se
    detecta la estructura.
    """
    raw_df = _read_raw(file_bytes, filename)
    header_row_idx, column_map = detect_bank_columns(raw_df, max_scan=max_scan)

    if header_row_idx is None:
        raise BankStatementFormatError(
            "No se pudo detectar una fila de cabecera con columnas de fecha, concepto e "
            "importe (o cargo/abono) reconocibles en las primeras filas del fichero."
        )

    df = _read_raw(file_bytes, filename, skiprows=header_row_idx + 1)

    result_df = pd.DataFrame({
        'Fecha': df.iloc[:, column_map['fecha']],
        'Concepto': df.iloc[:, column_map['concepto']],
        'Importe': build_importe_series(df, column_map),
    })

    return result_df, header_row_idx, column_map
