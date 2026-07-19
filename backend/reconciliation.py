import numpy as np
import pandas as pd
from datetime import timedelta

from backend.bank_statement_parser import parse_bank_date

AMOUNT_TOLERANCE = 0.01  # margen de 1 céntimo para evitar falsos negativos por precisión de punto flotante


def match_bank_transactions(excel_df, mm_transactions, date_col, amount_col, desc_col, window_days=3,
                             account_ids=None):
    """
    Algoritmo de Matching Avanzado para Conciliación Bancaria.
    excel_df: DataFrame con las transacciones del banco.
    mm_transactions: Lista de diccionarios con las transacciones de Money Manager.
    account_ids: lista de `assetId` de Money Manager asociados al fichero bancario que se está
        conciliando (opcional, viene de un selector multi-selección en el frontend — típicamente
        una cuenta MÁS las tarjetas vinculadas a ella vía `linkAssetId`, ver
        flattenAssets()/updatePendingAccounts() en script.js). Si se indica, el matching se hace
        en dos fases:

        FASE 1 (prioritaria): solo se consideran candidatos cuyo `assetId` esté en
        `account_ids` — para movimientos normales, directamente; para transferencias
        (`inOutType == 'Transferencia'`), un `assetId` de `account_ids` puede ser el origen
        (`assetId` de la transacción) o el destino (`toAssetId`/`targetAssetId`), decidido por el
        signo del importe bancario (negativo -> origen, positivo -> destino) para no confundir el
        lado. Cada lado de una transferencia se consume por separado (`matched_origin` /
        `matched_destination`), así que la misma transacción puede resolverse como match desde el
        extracto del banco origen Y desde el del banco destino sin colisión (ver
        CLAUDE.md, "Matching acotado por cuenta y transferencias entre bancos").

        FASE 2 (fallback, solo si la fase 1 no encuentra NINGÚN candidato para una línea
        concreta dentro de la ventana de fechas/importe): repite la búsqueda para esa línea sin
        el filtro de `account_ids`, igual que el comportamiento de antes de introducir el
        filtro por cuenta. Existe porque un extracto bancario de una CUENTA suele mezclar
        movimientos hechos directamente en la cuenta con movimientos hechos con una TARJETA
        vinculada a ella (`linkAssetId`) -- y Money Manager registra unos y otros con `assetId`
        distinto (el de la cuenta, o el de la tarjeta) de forma inconsistente según el propio
        origen del movimiento, no según qué extracto lo contiene. Si el usuario no marcó esa
        tarjeta concreta en el selector (o hay alguna otra cuenta relacionada que no se pensó
        marcar), la fase 2 evita un falso negativo — a cambio, el resultado se marca con
        `account_fallback: True` para que el frontend lo distinga visualmente de un match
        dentro de la cuenta esperada (menos automático, pide más atención al usuario). En la
        fase 2 una transferencia se consume como movimiento normal (un único `matched_origin`,
        sin distinguir lado) porque fuera del contexto de cuenta no hay forma fiable de saber
        a qué lado corresponde.

        Si `account_ids` es `None`/vacío, no hay fase 1: se busca directamente sin filtrar por
        cuenta (comportamiento previo a la Propuesta #5/#6) — ver Propuesta #4 en BACKLOG.md,
        limitación conocida y aceptada cuando ningún fichero de la tanda tiene cuenta asociada.
    """
    account_ids_set = {str(a) for a in account_ids} if account_ids else None

    if not mm_transactions:
        mm_df = pd.DataFrame(columns=['id', 'mbDate', 'mbCash', 'mbContent', 'assetId', 'destAssetId', 'is_transfer'])
    else:
        mm_df = pd.DataFrame(mm_transactions)
        mm_df['mbDate'] = pd.to_datetime(mm_df['mbDate'], errors='coerce')
        mm_df['mbCash'] = pd.to_numeric(mm_df['mbCash'], errors='coerce').fillna(0)
        for col in ('inOutType', 'assetId', 'toAssetId', 'targetAssetId'):
            if col not in mm_df.columns:
                mm_df[col] = ''
        mm_df['assetId'] = mm_df['assetId'].fillna('').astype(str)
        mm_df['inOutType'] = mm_df['inOutType'].fillna('')
        mm_df['is_transfer'] = mm_df['inOutType'].str.strip().str.lower() == 'transferencia'
        # Cuenta destino de una transferencia: el esquema de PC Manager tiene tanto `toAssetId`
        # como `targetAssetId` (ver reference/all_mm.js) — nos quedamos con el que venga relleno,
        # sin asumir cuál usa el servidor real (no verificado en vivo, ver CLAUDE.md).
        to_asset = mm_df['toAssetId'].fillna('').astype(str)
        target_asset = mm_df['targetAssetId'].fillna('').astype(str)
        mm_df['destAssetId'] = to_asset.where(to_asset.str.len() > 0, target_asset)

    mm_df['matched_origin'] = False
    mm_df['matched_destination'] = False

    excel_df[date_col] = parse_bank_date(excel_df[date_col])
    excel_df[amount_col] = pd.to_numeric(excel_df[amount_col], errors='coerce').fillna(0)

    results = []

    for idx, bank_row in excel_df.iterrows():
        bank_date = bank_row[date_col]
        bank_amount = bank_row[amount_col]
        bank_desc = str(bank_row[desc_col])

        if pd.isna(bank_date) or bank_amount == 0:
            continue

        def _side(row):
            """Lado de la transferencia al que corresponde algún assetId de `account_ids` para
            este importe bancario concreto — 'destination' solo si la cuenta asociada es el
            destino de la transferencia Y el importe es positivo (entrada); 'origin' en
            cualquier otro caso. Solo tiene sentido cuando se resolvió dentro de la fase 1."""
            if account_ids_set and row['is_transfer'] and row['destAssetId'] in account_ids_set and bank_amount > 0:
                return 'destination'
            return 'origin'

        def _available(row, restrict):
            if restrict and account_ids_set:
                if row['is_transfer']:
                    if row['assetId'] in account_ids_set and bank_amount < 0:
                        return not row['matched_origin']
                    if row['destAssetId'] in account_ids_set and bank_amount > 0:
                        return not row['matched_destination']
                    return False  # ninguna cuenta/tarjeta asociada participa en esta transferencia, o signo contrario
                return row['assetId'] in account_ids_set and not row['matched_origin']
            # Fase 2 (fallback) o sin account_ids en absoluto: comportamiento previo, consumo
            # único sin distinguir lado de transferencia.
            return not row['matched_origin']

        time_mask = (mm_df['mbDate'] >= bank_date - timedelta(days=window_days)) & \
                    (mm_df['mbDate'] <= bank_date + timedelta(days=window_days))
        amount_mask = np.isclose(mm_df['mbCash'].abs(), abs(bank_amount), atol=AMOUNT_TOLERANCE)
        pool = mm_df[time_mask & amount_mask]

        account_fallback = False
        if account_ids_set:
            avail_mask = pool.apply(lambda r: _available(r, restrict=True), axis=1) if not pool.empty else pd.Series(dtype=bool)
            candidates = pool[avail_mask] if not pool.empty else pool
            if candidates.empty and not pool.empty:
                # Fase 1 no encontró NADA dentro de las cuentas/tarjetas esperadas, pero sí hay
                # transacciones de MM con la misma fecha/importe -- repetir sin el filtro de
                # cuenta antes de rendirse y declarar la línea "nuevo movimiento".
                avail_mask_fb = pool.apply(lambda r: _available(r, restrict=False), axis=1)
                candidates = pool[avail_mask_fb]
                account_fallback = not candidates.empty
        else:
            avail_mask = pool.apply(lambda r: _available(r, restrict=False), axis=1) if not pool.empty else pd.Series(dtype=bool)
            candidates = pool[avail_mask] if not pool.empty else pool

        # Dentro de la fase 1 (con contexto de cuenta fiable) sí distinguimos lado de
        # transferencia; en fallback o sin account_ids, no.
        trust_account_context = bool(account_ids_set) and not account_fallback

        status = 'new'
        match_confidence = 0
        matched_mm_id = None
        candidate_list = []
        is_transfer_result = False
        transfer_role = None

        if not candidates.empty:
            # Buscar coincidencia exacta de fecha
            exact_date = candidates[candidates['mbDate'] == bank_date]

            if not exact_date.empty:
                # Si las fechas coinciden exactamente, alta probabilidad
                best_match = exact_date.iloc[0]
                best_match_pos = exact_date.index[0]  # índice posicional en mm_df, solo para marcar 'matched'
                status = 'exact_match'
                match_confidence = 100
                matched_mm_id = best_match.get('id')  # id real de Money Manager (UUID), no la posición del DataFrame
                is_transfer_result = bool(best_match['is_transfer'])

                # Marcar como emparejado el lado correspondiente para no reutilizarlo — solo ese
                # lado, para que el otro banco de la transferencia lo pueda seguir encontrando.
                if is_transfer_result and trust_account_context:
                    side = _side(best_match)
                    transfer_role = 'destino' if side == 'destination' else 'origen'
                    mm_df.at[best_match_pos, 'matched_destination' if side == 'destination' else 'matched_origin'] = True
                else:
                    mm_df.at[best_match_pos, 'matched_origin'] = True
            else:
                # Comprobar similitud de texto si la fecha difiere
                cands = candidates.copy()
                cands['date_diff'] = (cands['mbDate'] - bank_date).abs()
                cands = cands.sort_values('date_diff').head(3)

                status = 'suggested_match'
                match_confidence = 50

                for idx_cand, row_cand in cands.iterrows():
                    # Tratar heurística simple
                    word_match = any(w.lower() in str(row_cand['mbContent']).lower() for w in bank_desc.split() if len(w) > 3)
                    if word_match:
                        status = 'probable_match'
                        match_confidence = 80

                    cand_is_transfer = bool(row_cand['is_transfer'])
                    if cand_is_transfer:
                        is_transfer_result = True

                    candidate_list.append({
                        'id': row_cand.get('id'),  # id real de Money Manager (UUID), no la posición del DataFrame
                        'date': row_cand['mbDate'].strftime('%Y-%m-%d') if pd.notnull(row_cand['mbDate']) else None,
                        'amount': float(row_cand['mbCash']) if not pd.isna(row_cand['mbCash']) else 0.0,
                        'description': str(row_cand['mbContent']),
                        'asset': str(row_cand.get('assetName', 'Desconocida')),
                        'is_transfer': cand_is_transfer,
                    })

        results.append({
            'source_id': f"bank_{idx}",
            'date': bank_date.strftime('%Y-%m-%d') if pd.notnull(bank_date) else None,
            'amount': float(bank_amount) if not pd.isna(bank_amount) else 0.0,
            'description': bank_desc,
            'status': status,
            'confidence': match_confidence,
            'suggested_mm_ref': matched_mm_id if matched_mm_id is not None and not pd.isna(matched_mm_id) else None,
            'candidates': candidate_list,
            'is_transfer': is_transfer_result,
            'transfer_role': transfer_role,
            'account_fallback': account_fallback,
        })

    return results
