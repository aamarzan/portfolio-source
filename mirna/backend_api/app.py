import os
import pandas as pd
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS
import tensorflow as tf
from tensorflow.keras.layers import Layer
import joblib
from spektral.layers import GCSConv
import logging
from werkzeug.exceptions import RequestEntityTooLarge
from datetime import datetime
import requests
from Bio import SeqIO
import io

from molecule_processors import process_molecule_universal

# =========================
# Config
# =========================
API_KEY = os.getenv("API_KEY", "supersecret123")

GA_MEASUREMENT_ID = os.getenv("GA_MEASUREMENT_ID", "G-XXXXXXX")
GA_API_SECRET = os.getenv("GA_API_SECRET", "your_secret")
GA_URL = f"https://www.google-analytics.com/mp/collect?measurement_id={GA_MEASUREMENT_ID}&api_secret={GA_API_SECRET}"

def send_ga_event(event_name, params):
    try:
        payload = {
            "client_id": "backend_server",
            "events": [{
                "name": event_name,
                "params": params
            }]
        }
        r = requests.post(GA_URL, json=payload, timeout=2)
        if r.status_code != 204:
            logging.warning(f"GA event status {r.status_code}: {r.text}")
    except Exception as e:
        logging.warning(f"Failed to send GA event: {e}")

logging.basicConfig(
    filename='backend_usage.log',
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s'
)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

CORS(app, origins=[
    "https://aamarzan.com",
    "https://www.aamarzan.com",
    "https://mirna.aamarzan.com"
], methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-API-Key"])

@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(e):
    return jsonify({"error": f"Uploaded file is too large. Max size is {app.config['MAX_CONTENT_LENGTH'] // (1024*1024)} MB."}), 413

@app.before_request
def require_api_key():
    if request.method == "OPTIONS":
        return '', 200
    if request.endpoint == 'predict':
        key = request.headers.get("X-API-Key")
        if key != API_KEY:
            return jsonify({"error": "Unauthorized"}), 401

@app.errorhandler(Exception)
def handle_unexpected_error(e):
    logging.exception("Unexpected error: %s", e)
    return jsonify({"error": "Unexpected error occurred. Please try again later or contact support."}), 500

# =========================
# Custom layers
# =========================
class PositionalEncoding(Layer):
    def __init__(self, max_len, embed_dim, **kwargs):
        super(PositionalEncoding, self).__init__(**kwargs)
        self.max_len = max_len
        self.embed_dim = embed_dim
        self.pos_encoding = self.positional_encoding(max_len, embed_dim)

    def get_config(self):
        config = super().get_config()
        config.update({"max_len": self.max_len, "embed_dim": self.embed_dim})
        return config

    def positional_encoding(self, max_len, embed_dim):
        pos = np.arange(max_len)[:, np.newaxis]
        i = np.arange(embed_dim)[np.newaxis, :]
        angle_rates = 1 / np.power(10000, (2 * (i // 2)) / np.float32(embed_dim))
        angle_rads = pos * angle_rates
        angle_rads[:, 0::2] = np.sin(angle_rads[:, 0::2])
        angle_rads[:, 1::2] = np.cos(angle_rads[:, 1::2])
        pos_encoding = angle_rads[np.newaxis, ...]
        return tf.cast(pos_encoding, dtype=tf.float32)

    def call(self, x):
        seq_len = tf.shape(x)[1]
        return x + self.pos_encoding[:, :seq_len, :]

def create_weighted_mse(pos_weight=5.0, threshold=0.1):
    def weighted_mse(y_true, y_pred):
        mse_loss = tf.keras.losses.MeanSquaredError()
        mse = mse_loss(y_true, y_pred)
        weights = tf.where(y_true >= threshold, pos_weight, 1.0)
        return mse * weights
    return weighted_mse

# =========================
# Load model & scaler
# =========================
MODELS_DIR = 'model_files'
model = None
scaler = None

try:
    print("--- Loading Model and Scaler ---")
    custom_objects = {
        'PositionalEncoding': PositionalEncoding,
        'weighted_mse': create_weighted_mse(),
        'GCSConv': GCSConv
    }
    model_path = os.path.join(MODELS_DIR, 'supreme_model.keras')
    scaler_path = os.path.join(MODELS_DIR, 'minmax_scaler.pkl')

    model = tf.keras.models.load_model(model_path, custom_objects=custom_objects)
    print("  - Keras model loaded successfully.")

    scaler = joblib.load(scaler_path)
    print("  - Scaler loaded successfully.")

except Exception as e:
    print(f"FATAL: Could not load model or scaler on startup. Error: {e}")

# =========================
# Helpers
# =========================
def one_hot_encode_sequence(sequence, max_len):
    sequence = (sequence or "").upper().replace('T', 'U')
    nucleotide_map = {'A': 0, 'U': 1, 'G': 2, 'C': 3, 'N': 4}
    encoded_seq = np.zeros((max_len, len(nucleotide_map)), dtype=np.float32)
    for i, char in enumerate(sequence[:max_len]):
        encoded_seq[i, nucleotide_map.get(char, 4)] = 1
    return encoded_seq

def ensure_dict(data):
    if isinstance(data, tuple):
        return {
            "sequence": data[1] if len(data) > 1 else "",
            "gc_content": 0.0,
            "dg": 0.0,
            "conservation": 0.0,
            "structure_vector": "[]",
            "adjacency_matrix": "[]"
        }
    return data

def parse_single_fasta_or_raw(seq_text, default_id):
    recs = list(SeqIO.parse(io.StringIO(seq_text), "fasta"))
    if len(recs) == 1:
        return recs[0].id, str(recs[0].seq)
    if len(recs) > 1:
        return None
    raw = seq_text.strip()
    if raw:
        return default_id, raw
    return default_id, ""

# =========================
# Predict route (single-pass)
# =========================
@app.route('/predict', methods=['POST', 'OPTIONS'])
def predict():
    try:
        key = request.headers.get("X-API-Key")
        if key != API_KEY:
            return jsonify({"error": "Unauthorized"}), 401

        if not model or not scaler:
            return jsonify({"error": "Model or scaler is not available on the server."}), 500

        fasta_string = request.form.get('primary_molecules', '')
        target_seq = request.form.get('target_molecule', '')
        competitor_seq = request.form.get('competitor_molecule', '')

        if not fasta_string.strip() or not target_seq.strip():
            return jsonify({"error": "miRNA and Target sequences are required."}), 400

        # Target
        target_parsed = parse_single_fasta_or_raw(target_seq, "target")
        if target_parsed is None:
            return jsonify({"error": "Please enter only one target sequence."}), 400
        target_id, target_str = target_parsed
        target_processed = ensure_dict(process_molecule_universal(((target_id, target_str), {}, 'target_molecule')))

        # Competitor
        competitor_processed = {'sequence': ''}
        if competitor_seq.strip():
            competitor_parsed = parse_single_fasta_or_raw(competitor_seq, "competitor")
            if competitor_parsed is None:
                return jsonify({"error": "Please enter only one competitor sequence."}), 400
            comp_id, comp_str = competitor_parsed
            competitor_processed = ensure_dict(process_molecule_universal(((comp_id, comp_str), {}, 'competitor_molecule')))

        # Primaries
        records = list(SeqIO.parse(io.StringIO(fasta_string), "fasta"))
        if not records:
            raw = fasta_string.strip()
            if raw:
                records = [type('R', (), {'id': 'primary_1', 'seq': raw})()]
        if not records:
            return jsonify({"error": "No valid FASTA records found in miRNA input."}), 400

        # Shapes
        model_inputs = {inp.name: inp.shape for inp in model.inputs}
        max_primary_len = model_inputs['primary_sequence_input'][1]
        max_target_len = model_inputs['target_sequence_input'][1]
        max_competitor_len = model_inputs['competitor_sequence_input'][1]

        target_seq_encoded = one_hot_encode_sequence(
            target_processed.get('sequence', ''), max_target_len
        )
        comp_seq_encoded = one_hot_encode_sequence(
            competitor_processed.get('sequence', ''), max_competitor_len
        )

        # Numerical features template (extend to scaler dims if needed)
        num_features = [0.5, 0.0, 0.0]
        if hasattr(scaler, 'n_features_in_') and scaler.n_features_in_ > len(num_features):
            num_features += [0.0] * (scaler.n_features_in_ - len(num_features))

        # Scale with feature names if available
        if hasattr(scaler, 'feature_names_in_'):
            df_features = pd.DataFrame([num_features], columns=scaler.feature_names_in_)
            scaled_numerical = scaler.transform(df_features)[0]
        else:
            scaled_numerical = scaler.transform([num_features])[0]

        # Encode all primaries at once
        primary_batch = [
            ensure_dict(process_molecule_universal(((rec.id, str(rec.seq)), {}, 'primary_molecule')))
            for rec in records
        ]

        inputs_with_comp = {
            'primary_sequence_input': np.stack([
                one_hot_encode_sequence(p['sequence'], max_primary_len) for p in primary_batch
            ]),
            'target_sequence_input': np.repeat(target_seq_encoded[np.newaxis, ...], len(primary_batch), axis=0),
            'competitor_sequence_input': np.repeat(comp_seq_encoded[np.newaxis, ...], len(primary_batch), axis=0),
            'numerical_features_input': np.stack([scaled_numerical for _ in primary_batch])
        }

        # Predict with competitor
        with_comp = model.predict(inputs_with_comp, verbose=0).squeeze()

        # Predict baseline (competitor empty)
        empty_comp_encoded = one_hot_encode_sequence('', max_competitor_len)
        inputs_no_comp = inputs_with_comp.copy()
        inputs_no_comp['competitor_sequence_input'] = np.repeat(
            empty_comp_encoded[np.newaxis, ...], len(primary_batch), axis=0
        )
        no_comp = model.predict(inputs_no_comp, verbose=0).squeeze()

        # Square predictions and compute competitive effect
        pred_with = np.square(with_comp)
        pred_base = np.square(no_comp)

        results = []
        for rec, p_base, p_with in zip(records, pred_base, pred_with):
            results.append({
                'mirna_id': rec.id,
                'predicted_affinity_baseline': float(p_base),
                'predicted_affinity_with_competitor': float(p_with),
                'competitive_effect (higher_is_better)': float(p_base - p_with),
            })

        return jsonify({"status": "completed", "results": results})

    except Exception as e:
        logging.exception(f"Prediction error: {e}")
        return jsonify({"error": f"Internal server error: {e}"}), 500
