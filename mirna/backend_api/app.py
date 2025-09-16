import os
import warnings
import pandas as pd
import json
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename
import tensorflow as tf
from tensorflow.keras.layers import Layer
from tensorflow.keras.models import load_model
import joblib
from spektral.layers import GCSConv
import logging
from werkzeug.exceptions import RequestEntityTooLarge
from datetime import datetime
import requests  # For GA4 Measurement Protocol

# Import from your project's own final scripts
from molecule_processors import process_molecule_universal

# =========================
# Configuration
# =========================
API_KEY = os.getenv("API_KEY", "supersecret123")

# Google Analytics (GA4) Measurement Protocol
GA_MEASUREMENT_ID = os.getenv("GA_MEASUREMENT_ID", "G-XXXXXXX")
GA_API_SECRET = os.getenv("GA_API_SECRET", "your_secret")
GA_URL = f"https://www.google-analytics.com/mp/collect?measurement_id={GA_MEASUREMENT_ID}&api_secret={GA_API_SECRET}"

def send_ga_event(event_name, params):
    """Send a custom event to Google Analytics 4 via Measurement Protocol."""
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

# =========================
# Logging setup
# =========================
logging.basicConfig(
    filename='backend_usage.log',
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s'
)

# =========================
# Flask app setup
# =========================
app = Flask(__name__)

# Set max upload size to 100 MB
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB

# Allow CORS for your frontend domains
CORS(app, origins=["https://aamarzan.com", "https://www.aamarzan.com"], methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-API-Key"])

# Set max upload size (e.g., 100 MB)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024  # 100 MB

from werkzeug.exceptions import RequestEntityTooLarge
@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(e):
    return jsonify({"error": f"Uploaded file is too large. Max size is {app.config['MAX_CONTENT_LENGTH'] // (1024*1024)} MB."}), 413

# API key protection middleware
@app.before_request
def require_api_key():
    # Allow CORS preflight requests
    if request.method == "OPTIONS":
        return '', 200

    if request.endpoint == 'predict':
        key = request.headers.get("X-API-Key")
        if key != API_KEY:
            return jsonify({"error": "Unauthorized"}), 401

@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(e):
    return jsonify({"error": f"Uploaded file is too large. Max size is {app.config['MAX_CONTENT_LENGTH'] // (1024*1024)} MB."}), 413

@app.errorhandler(Exception)
def handle_unexpected_error(e):
    logging.exception("Unexpected error: %s", e)
    return jsonify({"error": "Unexpected error occurred. Please try again later or contact support."}), 500

# =========================
# TensorFlow custom objects
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
# Load Model and Scaler
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

    print(f"Looking for model at: {os.path.abspath(model_path)}")
    print(f"Looking for scaler at: {os.path.abspath(scaler_path)}")

    model = tf.keras.models.load_model(model_path, custom_objects=custom_objects)
    print("  - Keras model loaded successfully.")

    scaler = joblib.load(scaler_path)
    print("  - Scaler loaded successfully.")

except Exception as e:
    print(f"FATAL: Could not load model or scaler on startup. Error: {e}")

# =========================
# Helper functions
# =========================
def one_hot_encode_sequence(sequence, max_len):
    nucleotide_map = {'A': 0, 'U': 1, 'G': 2, 'C': 3, 'N': 4}
    encoded_seq = np.zeros((max_len, len(nucleotide_map)), dtype=np.float32)
    for i, char in enumerate(sequence[:max_len]):
        encoded_seq[i, nucleotide_map.get(char.upper(), 4)] = 1
    return encoded_seq

def prepare_web_input(primary_data, target_data, competitor_data, scaler, model):
    model_inputs = {inp.name: inp.shape for inp in model.inputs}
    max_primary_len = model_inputs['primary_sequence_input'][1]
    max_target_len = model_inputs['target_sequence_input'][1]
    max_competitor_len = model_inputs['competitor_sequence_input'][1]

    num_features = [
        primary_data.get('gc_content', 0.5),
        primary_data.get('dg', 0.0),
        primary_data.get('conservation', 0.0)
    ]

    # Pad with zeros if fewer features than scaler expects
    if len(num_features) < scaler.n_features_in_:
        num_features += [0.0] * (scaler.n_features_in_ - len(num_features))

    # If scaler was trained with column names, preserve them
    if hasattr(scaler, 'feature_names_in_'):
        df_features = pd.DataFrame([num_features], columns=scaler.feature_names_in_)
        scaled_numerical = scaler.transform(df_features)
    else:
        scaled_numerical = scaler.transform([num_features])

    inputs = {
        'primary_sequence_input': np.array([one_hot_encode_sequence(primary_data.get('sequence', ''), max_primary_len)]),
        'target_sequence_input': np.array([one_hot_encode_sequence(target_data.get('sequence', ''), max_target_len)]),
        'competitor_sequence_input': np.array([one_hot_encode_sequence(competitor_data.get('sequence', ''), max_competitor_len)]),
        'numerical_features_input': scaled_numerical
    }

    if 'primary_structure_input' in model_inputs:
        structure_vector = json.loads(primary_data.get('structure_vector', '[]'))
        structure_padded = np.zeros((max_primary_len, 1), dtype=np.float32)
        structure_padded[:len(structure_vector), 0] = structure_vector
        inputs['primary_structure_input'] = np.array([structure_padded])

    if 'target_adjacency_input' in model_inputs:
        adj_matrix = np.array(json.loads(target_data.get('adjacency_matrix', '[]')))
        padded_adj = np.zeros((max_target_len, max_target_len), dtype=np.float32)
        if adj_matrix.size > 0:
            h, w = adj_matrix.shape
            padded_adj[:h, :w] = adj_matrix
        inputs['target_adjacency_input'] = np.array([padded_adj])

    return inputs

# =========================
# Routes
# =========================
@app.route('/predict', methods=['POST', 'OPTIONS'])
def predict():
    # OPTIONS handled in before_request
    key = request.headers.get("X-API-Key")
    if key != API_KEY:
        return jsonify({"error": "Unauthorized"}), 401

    if not model or not scaler:
        logging.error("Prediction attempted but model/scaler not loaded.")
        send_ga_event("prediction_error", {"reason": "model_not_loaded"})
        return jsonify({"error": "Model or scaler is not available on the server."}), 500

    start_time = datetime.now()
    try:
        from Bio import SeqIO
        import io

        fasta_string = request.form.get('primary_molecules', '')
        target_seq = request.form.get('target_molecule', '')
        competitor_seq = request.form.get('competitor_molecule', '')

        if not fasta_string.strip() or not target_seq.strip():
            logging.warning("Missing required sequences in request.")
            send_ga_event("prediction_error", {"reason": "missing_sequences"})
            return jsonify({"error": "miRNA and Target sequences are required."}), 400

        # Helpers
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
            # Try FASTA parse
            recs = list(SeqIO.parse(io.StringIO(seq_text), "fasta"))
            if len(recs) == 1:
                return recs[0].id, str(recs[0].seq)
            if len(recs) > 1:
                return None  # signal multi
            # Fallback: treat as raw string
            raw = seq_text.strip()
            if raw:
                return default_id, raw
            return default_id, ""  # empty

        # Validate target: must be exactly one sequence (FASTA or raw)
        target_parsed = parse_single_fasta_or_raw(target_seq, "target")
        if target_parsed is None:
            return jsonify({"error": "Please enter only one target sequence."}), 400
        target_id, target_str = target_parsed
        target_processed = process_molecule_universal(((target_id, target_str), {}, 'target_molecule'))
        target_processed = ensure_dict(target_processed)

        # Validate competitor: allow none or exactly one sequence
        competitor_processed = {'sequence': ''}
        if competitor_seq.strip():
            competitor_parsed = parse_single_fasta_or_raw(competitor_seq, "competitor")
            if competitor_parsed is None:
                return jsonify({"error": "Please enter only one competitor sequence."}), 400
            comp_id, comp_str = competitor_parsed
            competitor_processed = process_molecule_universal(((comp_id, comp_str), {}, 'competitor_molecule'))
            competitor_processed = ensure_dict(competitor_processed)

        # Parse all primary miRNAs (FASTA); also accept raw multi-line by wrapping lines as single FASTA
        records = list(SeqIO.parse(io.StringIO(fasta_string), "fasta"))
        if not records:
            # If user pasted raw lines without headers, create a single pseudo-record
            raw = fasta_string.strip()
            if raw:
                records = [type('R', (), {'id': 'primary_1', 'seq': raw})()]
        if not records:
            logging.warning("No FASTA records parsed from primary_molecules.")
            return jsonify({"error": "No valid FASTA records found in miRNA input."}), 400
        
        MAX_MIRNAS = 600  # match frontend limit
        if len(records) > MAX_MIRNAS:
            return jsonify({"error": f"Too many miRNAs submitted. Max allowed is {MAX_MIRNAS}."}), 400

        results = []
        for primary_record in records:
            # Support both SeqRecord and pseudo-record
            pri_id = getattr(primary_record, 'id', 'primary')
            pri_seq = str(getattr(primary_record, 'seq', '')) if hasattr(primary_record, 'seq') else str(primary_record)

            primary_processed = process_molecule_universal(((pri_id, pri_seq), {}, 'primary_molecule'))
            primary_processed = ensure_dict(primary_processed)

            # Baseline (no competitor)
            inputs_no_comp = prepare_web_input(primary_processed, target_processed, {'sequence': ''}, scaler, model)
            pred_no_comp_transformed = model.predict(inputs_no_comp, verbose=0)[0][0]
            pred_no_comp = float(np.square(pred_no_comp_transformed))

            # With competitor (only if a valid competitor sequence was provided)
            if competitor_processed.get('sequence', '').strip():
                inputs_with_comp = prepare_web_input(primary_processed, target_processed, competitor_processed, scaler, model)
                pred_with_comp_transformed = model.predict(inputs_with_comp, verbose=0)[0][0]
                pred_with_comp = float(np.square(pred_with_comp_transformed))
            else:
                pred_with_comp = pred_no_comp

            comp_effect = float(pred_no_comp - pred_with_comp)

            results.append({
                # Keep both keys for backward compatibility with your frontend
                'primary_molecule_id': pri_id,
                'mirna_id': pri_id,
                'predicted_affinity_baseline': format(pred_no_comp, '.10f'),
                'predicted_affinity_with_competitor': format(pred_with_comp, '.10f'),
                'competitive_effect (higher_is_better)': format(comp_effect, '.10f'),
            })

            # Per-record logging and GA
            duration = (datetime.now() - start_time).total_seconds()
            logging.info(f"Prediction success | miRNA: {pri_id} | Duration: {duration:.2f}s")
            send_ga_event("prediction", {"mirna_id": pri_id, "duration_sec": duration})

        return jsonify({"status": "completed", "results": results})

    except Exception as e:
        logging.exception(f"Prediction error: {e}")
        send_ga_event("prediction_error", {"exception": str(e)[:200]})
        return jsonify({"error": "An internal server error occurred."}), 500


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(debug=True, host='0.0.0.0', port=port)

