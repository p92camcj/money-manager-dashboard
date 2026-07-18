"""Detección genérica de la estructura de un extracto bancario en Excel.

Cada banco exporta con un número distinto de filas de metadatos antes de la
cabecera real, columnas en orden distinto, y a veces nombres de columna
abreviados ("F. Valor" en vez de "Fecha valor"). En vez de asumir una
posición o un orden de columnas fijo, se busca la fila de cabecera real
clasificando cada celda contra listas de alias conocidos por campo, y se
mapean las columnas por lo que dicen sus celdas, no por su posición.

Si no se puede detectar la estructura con confianza razonable, se lanza
BankExcelFormatError en vez de asumir algo silenciosamente incorrecto —
mejor un error explícito para el usuario que una conciliación mal hecha.
"""
import io
import re
import unicodedata

import pandas as pd

# Alias en forma normalizada (sin acentos, minúsculas, sin puntos/barras).
# "fecha_valor" se detecta explícitamente para IGNORARLA — no debe confundirse
# con la fecha de operación real (aparece en Cajasur, BBVA, EVO, Sabadell).
FIELD_ALIASES = {
    'fecha': [
        'fecha', 'f operativa', 'fecha operativa', 'fecha contable',
        'fecha operacion', 'fecha movimiento', 'date',
    ],
    'fecha_valor': [
        'fecha valor', 'f valor', 'valor',
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


class BankExcelFormatError(Exception):
    """El Excel no tiene una estructura de columnas de fecha/concepto/importe reconocible."""


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


def parse_spanish_amount(val):
    """Normaliza importes que pueden venir como texto con formato español
    (punto de miles, coma decimal, p.ej. '1.234,56') en vez de float nativo."""
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


def parse_bank_excel(file_bytes, max_scan=30):
    """Lee los bytes de un Excel bancario y devuelve (df, header_row_idx, column_map).

    df tiene exactamente las columnas 'Fecha', 'Concepto', 'Importe', listas para
    pasar a match_bank_transactions(). Lanza BankExcelFormatError si no se detecta
    la estructura.
    """
    raw_df = pd.read_excel(io.BytesIO(file_bytes), header=None)
    header_row_idx, column_map = detect_bank_columns(raw_df, max_scan=max_scan)

    if header_row_idx is None:
        raise BankExcelFormatError(
            "No se pudo detectar una fila de cabecera con columnas de fecha, concepto e "
            "importe (o cargo/abono) reconocibles en las primeras filas del Excel."
        )

    df = pd.read_excel(io.BytesIO(file_bytes), header=None, skiprows=header_row_idx + 1)

    result_df = pd.DataFrame({
        'Fecha': df.iloc[:, column_map['fecha']],
        'Concepto': df.iloc[:, column_map['concepto']],
        'Importe': build_importe_series(df, column_map),
    })

    return result_df, header_row_idx, column_map
