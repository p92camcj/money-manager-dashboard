import pandas as pd
from datetime import timedelta

def match_bank_transactions(excel_df, mm_transactions, date_col, amount_col, desc_col, window_days=3):
    """
    Algoritmo de Matching Avanzado para Conciliación Bancaria.
    excel_df: DataFrame con las transacciones del banco.
    mm_transactions: Lista de diccionarios con las transacciones de Money Manager.
    """
    # Preparar datos de Money Manager en DataFrame para cruce rápido
    if not mm_transactions:
        mm_df = pd.DataFrame(columns=['mbDate', 'mbCash', 'mbContent', 'matched'])
    else:
        mm_df = pd.DataFrame(mm_transactions)
        mm_df['mbDate'] = pd.to_datetime(mm_df['mbDate'], errors='coerce')
        mm_df['mbCash'] = pd.to_numeric(mm_df['mbCash'], errors='coerce').fillna(0)
        mm_df['matched'] = False

    excel_df[date_col] = pd.to_datetime(excel_df[date_col], errors='coerce', dayfirst=True)
    excel_df[amount_col] = pd.to_numeric(excel_df[amount_col], errors='coerce').fillna(0)
    
    results = []
    
    for idx, bank_row in excel_df.iterrows():
        bank_date = bank_row[date_col]
        bank_amount = bank_row[amount_col]
        bank_desc = str(bank_row[desc_col])
        
        if pd.isna(bank_date) or bank_amount == 0:
            continue
            
        # Filtro 1: Ventana de tiempo y mismo importe absoluto (considerando posibles inversiones de signo)
        time_mask = (mm_df['mbDate'] >= bank_date - timedelta(days=window_days)) & \
                    (mm_df['mbDate'] <= bank_date + timedelta(days=window_days))
        amount_mask = (abs(mm_df['mbCash']) == abs(bank_amount))
        unmatched_mask = (~mm_df['matched'])
        
        candidates = mm_df[time_mask & amount_mask & unmatched_mask]
        
        status = 'new'
        match_confidence = 0
        matched_mm_id = None
        candidate_list = []
        
        if not candidates.empty:
            # Buscar coincidencia exacta de fecha
            exact_date = candidates[candidates['mbDate'] == bank_date]
            
            if not exact_date.empty:
                # Si las fechas coinciden exactamente, alta probabilidad
                best_match = exact_date.iloc[0]
                status = 'exact_match'
                match_confidence = 100
                matched_mm_id = best_match.name
                
                # Marcar como emparejado para no reutilizar
                if matched_mm_id is not None and not pd.isna(matched_mm_id):
                    mm_df.at[matched_mm_id, 'matched'] = True
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
                        
                    candidate_list.append({
                        'id': int(idx_cand),
                        'date': row_cand['mbDate'].strftime('%Y-%m-%d') if pd.notnull(row_cand['mbDate']) else None,
                        'amount': float(row_cand['mbCash']) if not pd.isna(row_cand['mbCash']) else 0.0,
                        'description': str(row_cand['mbContent']),
                        'asset': str(row_cand.get('assetName', 'Desconocida'))
                    })
                
        results.append({
            'source_id': f"bank_{idx}",
            'date': bank_date.strftime('%Y-%m-%d') if pd.notnull(bank_date) else None,
            'amount': float(bank_amount) if not pd.isna(bank_amount) else 0.0,
            'description': bank_desc,
            'status': status,
            'confidence': match_confidence,
            'suggested_mm_ref': int(matched_mm_id) if matched_mm_id is not None and not pd.isna(matched_mm_id) else None,
            'candidates': candidate_list
        })
        
    return results
