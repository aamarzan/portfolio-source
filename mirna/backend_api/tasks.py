import os
import time
import logging
import numpy as np
import pandas as pd
from typing import List, Tuple, Optional, Dict

# Shared state and constants (moved out of app.py to avoid circular import)
from app import (
    jobs, model, scaler, send_ga_event,
    convert_aa_to_nt, trim_mature_sequence,
    BATCH_SIZE, MATURE_TRIM_WINDOW,
    process_molecule_universal,
    extract_seq_from_structure,
    validate_structure_matches_sequence,
    one_hot_encode_sequence,
    extract_structure_vector_from_file,
    structure_vector_from_processed_json,
    choose_mature_window
)

def process_job(
    job_id: str,
    primary_records: List[Tuple[str, str]],
    target_tuple: Tuple[str, str],
    competitor_tuple: Tuple[str, str],
    target_3d_path: Optional[str],
    competitor_3d_path: Optional[str],
    mirna_3d_index: Dict[str, Tuple[Optional[str], str, str]],
    tmp_paths_to_cleanup: List[str],
    convert_aa_to_nt_flag: bool,
    mature_trim_flag: bool
):
    try:
        # Mark job as running when worker picks it up
        if job_id in jobs:
            jobs[job_id]["status"] = "running"

        if model is None or scaler is None:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "Model or scaler not loaded on server."
            return

        # Wrap to ensure dict with expected keys
        def ensure_dict(data):
            if isinstance(data, tuple):
                # expect like ((id, seq), meta, label) from your processor usage
                return {
                    "sequence": data[1] if len(data) > 1 else "",
                    "gc_content": 0.5,
                    "dg": 0.0,
                    "conservation": 0.0,
                    "structure_vector": "[]",
                    "adjacency_matrix": "[]"
                }
            return data

        # Prepare Target
        target_id, target_str = target_tuple
        target_processed = ensure_dict(
            process_molecule_universal(((target_id, target_str), {}, 'target_molecule'))
        )

        # Prepare Competitor (optional)
        competitor_id, competitor_str = competitor_tuple
        competitor_processed = {'sequence': ''}
        if competitor_str.strip():
            competitor_processed = ensure_dict(
                process_molecule_universal(((competitor_id, competitor_str), {}, 'competitor_molecule'))
            )

        # Validate 3D vs FASTA for target/competitor if files provided
        if target_3d_path and target_processed.get('sequence', ''):
            kind, seq = extract_seq_from_structure(target_3d_path)
            ok, msg = validate_structure_matches_sequence(
                kind, seq, target_processed.get('sequence', ''), "Target"
            )
            if not ok:
                jobs[job_id]["status"] = "error"
                jobs[job_id]["error"] = msg
                return

        if competitor_3d_path and competitor_processed.get('sequence', ''):
            kind, seq = extract_seq_from_structure(competitor_3d_path)
            ok, msg = validate_structure_matches_sequence(
                kind, seq, competitor_processed.get('sequence', ''), "Competitor"
            )
            if not ok:
                jobs[job_id]["status"] = "error"
                jobs[job_id]["error"] = msg
                return

        # Prepare inputs per model signatures
        model_inputs = {inp.name: inp.shape for inp in model.inputs}
        max_primary_len = model_inputs['primary_sequence_input'][1]
        max_target_len = model_inputs['target_sequence_input'][1]
        max_competitor_len = model_inputs['competitor_sequence_input'][1]

        # Pre-encode common target/competitor sequences
        target_seq_enc = one_hot_encode_sequence(
            target_processed.get('sequence', ''), max_target_len
        )
        empty_comp_enc = one_hot_encode_sequence('', max_competitor_len)

        comp_seq_enc = None
        if competitor_processed.get('sequence', '').strip():
            comp_seq_enc = one_hot_encode_sequence(
                competitor_processed.get('sequence', ''), max_competitor_len
            )

        # Build structural inputs for target/competitor if the model expects them
        target_struct_input = None
        competitor_struct_input = None

        if 'target_structure_input' in model_inputs:
            vec = None
            if target_3d_path:
                vec = extract_structure_vector_from_file(target_3d_path, max_target_len)
            if vec is None:
                vec = structure_vector_from_processed_json(
                    target_processed.get('structure_vector', '[]'), max_target_len
                )
            target_struct_input = vec

        if 'competitor_structure_input' in model_inputs:
            vec = None
            if competitor_3d_path:
                vec = extract_structure_vector_from_file(competitor_3d_path, max_competitor_len)
            if vec is None:
                if competitor_processed.get('sequence', '').strip():
                    vec = structure_vector_from_processed_json(
                        competitor_processed.get('structure_vector', '[]'), max_competitor_len
                    )
                else:
                    vec = np.zeros((max_competitor_len, 1), dtype=np.float32)
            competitor_struct_input = vec

        # Batch over primaries
        for start in range(0, len(primary_records), BATCH_SIZE):
            batch_records = primary_records[start:start + BATCH_SIZE]
            prim_seq_list, num_feat_list, prim_struct_list = [], [], []

            # Prepare primary (miRNA) batch
            for pri_id, pri_seq in batch_records:
                pdata = ensure_dict(
                    process_molecule_universal(((pri_id, pri_seq), {}, 'primary_molecule'))
                )

                # Optionally trim miRNAs longer than 30 nt to mature-like window
                seq = pdata.get('sequence', '')
                if mature_trim_flag and len(seq) > 30:
                    seq = choose_mature_window(seq, window=MATURE_TRIM_WINDOW)
                    pdata['sequence'] = seq

                prim_seq_list.append(one_hot_encode_sequence(seq, max_primary_len))
                nf = [
                    pdata.get('gc_content', 0.5),
                    pdata.get('dg', 0.0),
                    pdata.get('conservation', 0.0)
                ]
                if hasattr(scaler, 'n_features_in_') and len(nf) < scaler.n_features_in_:
                    nf += [0.0] * (scaler.n_features_in_ - len(nf))
                num_feat_list.append(nf)

                # If a 3D file for this miRNA exists, validate match
                if pri_id in mirna_3d_index:
                    kind, seq3d, path3d = mirna_3d_index[pri_id]
                    ok, msg = validate_structure_matches_sequence(
                        kind, seq3d, pdata.get('sequence', ''), f"miRNA {pri_id}"
                    )
                    if not ok:
                        jobs[job_id]["status"] = "error"
                        jobs[job_id]["error"] = msg
                        return

                # Build primary structure input
                if 'primary_structure_input' in model_inputs:
                    sp = None
                    if pri_id in mirna_3d_index:
                        _kind, _seq3d, path3d = mirna_3d_index[pri_id]
                        sp = extract_structure_vector_from_file(path3d, max_primary_len)
                    if sp is None:
                        sp = structure_vector_from_processed_json(
                            pdata.get('structure_vector', '[]'), max_primary_len
                        )
                    prim_struct_list.append(sp)

            # Scale numeric features
            if hasattr(scaler, 'feature_names_in_'):
                df_features = pd.DataFrame(num_feat_list, columns=scaler.feature_names_in_)
                scaled_num = scaler.transform(df_features)
            else:
                scaled_num = scaler.transform(num_feat_list)

            batch_size = len(batch_records)
            common_inputs = {
                'primary_sequence_input': np.stack(prim_seq_list),
                'target_sequence_input': np.repeat(target_seq_enc[np.newaxis, ...], batch_size, axis=0),
                'numerical_features_input': scaled_num
            }
            if 'primary_structure_input' in model_inputs:
                common_inputs['primary_structure_input'] = (
                    np.stack(prim_struct_list)
                    if prim_struct_list
                    else np.zeros((batch_size, max_primary_len, 1), dtype=np.float32)
                )

            if 'target_structure_input' in model_inputs and target_struct_input is not None:
                common_inputs['target_structure_input'] = np.repeat(
                    target_struct_input[np.newaxis, ...], batch_size, axis=0
                )
            if 'competitor_structure_input' in model_inputs and competitor_struct_input is not None:
                common_inputs['competitor_structure_input'] = np.repeat(
                    competitor_struct_input[np.newaxis, ...], batch_size, axis=0
            )

            # Prepare competitor present/absent inputs
            with_comp = dict(common_inputs)
            if comp_seq_enc is not None:
                with_comp['competitor_sequence_input'] = np.repeat(
                    comp_seq_enc[np.newaxis, ...], batch_size, axis=0
                )
            else:
                with_comp['competitor_sequence_input'] = np.repeat(
                    empty_comp_enc[np.newaxis, ...], batch_size, axis=0
                )

            no_comp = dict(common_inputs)
            no_comp['competitor_sequence_input'] = np.repeat(
                empty_comp_enc[np.newaxis, ...], batch_size, axis=0
            )

            # Predict
            preds_with = model.predict(with_comp, verbose=0).reshape(-1)
            preds_no = model.predict(no_comp, verbose=0).reshape(-1)

            # Square if intended (preserving your previous code)
            pred_with_sq = np.square(preds_with)
            pred_no_sq = np.square(preds_no)

            # Accumulate results
            for (pri_id, _), p_base, p_with in zip(batch_records, pred_no_sq, pred_with_sq):
                jobs[job_id]["results"].append({
                    'primary_molecule_id': pri_id,
                    'mirna_id': pri_id,
                    'predicted_affinity_baseline': format(float(p_base), '.10f'),
                    'predicted_affinity_with_competitor': format(float(p_with), '.10f'),
                    'competitive_effect (higher_is_better)': format(float(p_base - p_with), '.10f'),
                })
                jobs[job_id]["completed"] += 1

        # Mark job as completed
        jobs[job_id]["status"] = "completed"
        send_ga_event("prediction_completed", {"total": jobs[job_id]["total"]})

    except Exception as e:
        logging.exception(f"Prediction error: {e}")
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)[:500]
    finally:
        # Cleanup temp files
        for p in tmp_paths_to_cleanup:
            try:
                os.unlink(p)
            except Exception:
                pass
