import numpy as np
import pandas as pd
from datetime import timedelta

from backend.bank_statement_parser import parse_bank_date

AMOUNT_TOLERANCE = 0.01  # margen de 1 céntimo para evitar falsos negativos por precisión de punto flotante


def build_mm_dataframe(mm_transactions):
    """Construye el DataFrame de transacciones de Money Manager usado por match_bank_transactions(),
    con las columnas de tracking (`matched_origin`/`matched_destination`) inicializadas a `False`.

    Debe construirse UNA SOLA VEZ por tanda de ficheros subida a la vez (`/api/analyze-excel`) y
    pasarse como `mm_df` a la llamada de match_bank_transactions() de CADA fichero de esa tanda —
    así el consumo de una transacción de Money Manager en un fichero es visible para los demás
    ficheros de la misma tanda (Propuesta #4 en BACKLOG.md, resuelta en su totalidad: antes cada
    fichero recibía su propio DataFrame reconstruido desde cero, así que dos ficheros con un
    movimiento ambiguo (misma fecha e importe, sin relación entre sí) podían proponer AMBOS un
    `exact_match` contra la MISMA transacción de Money Manager -- determinista, porque el primer
    candidato por fecha exacta (`exact_date.iloc[0]`) es siempre el mismo si el DataFrame de
    partida es idéntico -- dejando una segunda transacción real de Money Manager con esos mismos
    fecha/importe sin proponer nunca a ningún fichero. Verificado con un caso sintético: dos
    transacciones de Money Manager de -50€ el mismo día, y dos ficheros con una línea de -50€
    cada uno sin relación real entre sí -- antes del fix ambos ficheros proponían la MISMA
    transacción MM1 y MM2 quedaba invisible; con el DataFrame compartido, el segundo fichero ve
    que MM1 ya está consumida por el primero y encuentra MM2 correctamente.

    Compartir este DataFrame NO rompe el caso ya resuelto de una transferencia entre dos cuentas
    propias con cuenta asociada en cada fichero (Propuesta #5): cada lado consume una columna
    booleana DISTINTA de la MISMA fila (`matched_origin` el fichero del banco origen,
    `matched_destination` el del banco destino), así que ambos ficheros siguen pudiendo resolver
    la misma fila de Money Manager como match sin colisionar entre sí, aunque ahora compartan el
    mismo DataFrame de partida."""
    if not mm_transactions:
        return pd.DataFrame(columns=['id', 'mbDate', 'mbCash', 'mbContent', 'assetId', 'destAssetId', 'is_transfer',
                                      'matched_origin', 'matched_destination'])

    mm_df = pd.DataFrame(mm_transactions)
    mm_df['mbDate'] = pd.to_datetime(mm_df['mbDate'], errors='coerce')
    mm_df['mbCash'] = pd.to_numeric(mm_df['mbCash'], errors='coerce').fillna(0)
    for col in ('inOutType', 'inOutCode', 'assetId', 'toAssetId'):
        if col not in mm_df.columns:
            mm_df[col] = ''
    mm_df['assetId'] = mm_df['assetId'].fillna('').astype(str)
    mm_df['inOutType'] = mm_df['inOutType'].fillna('')
    # Una transferencia se detecta por inOutCode ("3"=origen, "4"=lado invertido -- nunca
    # observado en datos reales, ver CLAUDE.md), NUNCA por el texto de inOutType: se confirmó
    # contra el móvil real (2026-07-19) que una transferencia se lee con inOutType = "Dinero
    # gastado", no "Transferencia" -- comparar contra ese texto (como hacía esta función antes)
    # dejaba is_transfer siempre en False para transferencias reales.
    mm_df['is_transfer'] = mm_df['inOutCode'].fillna('').astype(str).isin(['3', '4'])
    # Cuenta destino de una transferencia: `toAssetId` es el campo real (confirmado contra el
    # móvil real, 2026-07-19) -- `targetAssetId`, que también declara el esquema de PC Manager
    # (reference/all_mm.js), sale siempre vacío/null en la práctica, así que ya no se usa como
    # fallback.
    mm_df['destAssetId'] = mm_df['toAssetId'].fillna('').astype(str)

    mm_df['matched_origin'] = False
    mm_df['matched_destination'] = False
    return mm_df


def match_bank_transactions(excel_df, mm_df, date_col, amount_col, desc_col, window_days=3,
                             account_ids=None):
    """
    Algoritmo de Matching Avanzado para Conciliación Bancaria.
    excel_df: DataFrame con las transacciones del banco.
    mm_df: DataFrame de transacciones de Money Manager ya construido por build_mm_dataframe().
        Se muta en el sitio (columnas `matched_origin`/`matched_destination`) según se van
        consumiendo candidatos -- pásalo COMPARTIDO entre todos los ficheros de una misma tanda
        para que el consumo de uno sea visible para los demás (ver build_mm_dataframe()).
    account_ids: lista de `assetId` de Money Manager asociados al fichero bancario que se está
        conciliando (opcional, viene de un selector multi-selección en el frontend — típicamente
        una cuenta MÁS las tarjetas vinculadas a ella vía `linkAssetId`, ver
        flattenAssets()/updatePendingAccounts() en script.js). Si se indica, el matching se hace
        en dos fases:

        FASE 1 (prioritaria): solo se consideran candidatos cuyo `assetId` esté en
        `account_ids` — para movimientos normales, directamente; para transferencias
        (`is_transfer`), un `assetId` de `account_ids` puede ser el origen (`assetId` de la
        transacción) o el destino (`destAssetId`), decidido por el signo del importe bancario
        (negativo -> origen, positivo -> destino) para no confundir el lado. Cada lado de una
        transferencia se consume por separado (`matched_origin` / `matched_destination`), así
        que la misma transacción puede resolverse como match desde el extracto del banco origen
        Y desde el del banco destino sin colisión (ver CLAUDE.md, "Matching acotado por cuenta y
        transferencias entre bancos").

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
        cuenta (comportamiento previo a la Propuesta #5/#6) — el consumo cruzado entre ficheros
        sin cuenta asociada (Propuesta #4) lo da `mm_df` compartido, no este parámetro.
    """
    account_ids_set = {str(a) for a in account_ids} if account_ids else None

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
            # Fase 2 (fallback) o sin account_ids en absoluto. Para una transferencia, aunque no
            # haya contexto de cuenta que confirme qué lado es cada extracto, el SIGNO del
            # importe bancario ya distingue el lado sin ambigüedad (negativo -> origen, positivo
            # -> destino de esa misma fila) -- consumir columnas distintas por lado es lo que
            # permite que dos ficheros SIN cuenta asociada que traigan los dos lados de la MISMA
            # transferencia (Propuesta #4 en BACKLOG.md) no se bloqueen entre sí compartiendo
            # `mm_df`. Para un movimiento normal (no transferencia) se sigue consumiendo una
            # única columna (`matched_origin`), que es lo que permite repartir dos transacciones
            # de Money Manager ambiguas (mismo importe/fecha, sin relación real entre sí) entre
            # los ficheros de la tanda en vez de que ambos propongan la misma.
            if row['is_transfer']:
                return not row['matched_destination'] if bank_amount > 0 else not row['matched_origin']
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
                # Como mm_df se comparte entre todos los ficheros de la tanda (ver
                # build_mm_dataframe()), este marcado también es visible para los ficheros que
                # aún no se han procesado (Propuesta #4). El signo del importe bancario decide
                # la columna a marcar en CUALQUIER caso (con o sin contexto de cuenta fiable) --
                # `transfer_role` (la etiqueta "origen"/"destino" que ve el frontend) solo se
                # afirma cuando hay contexto de cuenta fiable, igual que antes.
                if is_transfer_result:
                    if trust_account_context:
                        side = _side(best_match)
                        transfer_role = 'destino' if side == 'destination' else 'origen'
                    mm_df.at[best_match_pos, 'matched_destination' if bank_amount > 0 else 'matched_origin'] = True
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
