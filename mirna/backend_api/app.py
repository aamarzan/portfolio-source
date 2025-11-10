# app.py — multi-target & multi-competitor ready (drop-in)

import os
import io
import json
import time
import uuid
import math
import secrets
import logging
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Dict, Tuple, List, Optional

import numpy as np
import pandas as pd
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_limiter.errors import RateLimitExceeded
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge

# TensorFlow / Keras
import tensorflow as tf
from tensorflow.keras.layers import Layer  # type: ignore
from spektral.layers import GCSConv
import joblib

# Molecule processing (your module)
from molecule_processors import process_molecule_universal

# =========================
# Configuration
# =========================
NONCE_EXPIRY_SECONDS = 300  # 5 minutes
USE_NONCE = True            # If your frontend isn't sending X-Nonce yet, set False temporarily
MIRNA_MAX = int(os.getenv("MIRNA_MAX", "5000"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "12"))
MATURE_TRIM_ENABLED = True
MATURE_TRIM_WINDOW = int(os.getenv("MATURE_TRIM_WINDOW", "22"))
AA_CONVERT_ALLOWED = True
STRUCTURE_MISMATCH_TOL = 0.10  # 10% mismatch allowed
MAX_CONTENT_MB = 100

# Jobs registry: job_id -> {"status": "...", "results": [], "error": None, "total": 0, "completed": 0}
jobs: Dict[str, Dict] = {}

# Google Analytics (GA4) Measurement Protocol (optional)
GA_MEASUREMENT_ID = os.getenv("GA_MEASUREMENT_ID", "G-XXXXXXX")
GA_API_SECRET = os.getenv("GA_API_SECRET", "your_secret")
GA_URL = f"https://www.google-analytics.com/mp/collect?measurement_id={GA_MEASUREMENT_ID}&api_secret={GA_API_SECRET}"

def send_ga_event(event_name: str, params: Dict):
    try:
        payload = {
            "client_id": "backend_server",
            "events": [{"name": event_name, "params": params}]
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
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_MB * 1024 * 1024  # MB → bytes

CORS(app, origins=[
    "https://aamarzan.com",
    "https://www.aamarzan.com",
    "https://mirna.aamarzan.com",
    "http://localhost",
    "http://127.0.0.1"
], methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type", "X-Nonce"])

@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(e):
    return jsonify({"error": f"Uploaded file is too large. Max size is {app.config['MAX_CONTENT_LENGTH'] // (1024*1024)} MB."}), 413

# =========================
# Security: Nonce (optional safer flow)
# =========================
nonce_store: Dict[str, Dict[str, float]] = {}

@app.route('/nonce', methods=['GET'])
def issue_nonce():
    client_ip = get_remote_address()
    token = secrets.token_urlsafe(32)
    expiry = time.time() + NONCE_EXPIRY_SECONDS
    nonce_store[client_ip] = {"nonce": token, "expiry": expiry}
    return jsonify({"nonce": token, "expires_in": NONCE_EXPIRY_SECONDS})

@app.before_request
def require_nonce_or_key():
    if request.method == "OPTIONS":
        return '', 200
    if request.endpoint == 'start_prediction':
        if USE_NONCE:
            client_ip = get_remote_address()
            provided_nonce = request.headers.get("X-Nonce")
            stored = nonce_store.get(client_ip)
            if not stored or stored["nonce"] != provided_nonce or time.time() > stored["expiry"]:
                return jsonify({"error": "Invalid or expired nonce"}), 403
            # Consume nonce after use
            del nonce_store[client_ip]

@app.errorhandler(Exception)
def handle_unexpected_error(e):
    cid = secrets.token_hex(4)
    logging.exception("CID %s | Unexpected error: %s", cid, e)
    return jsonify({"error": f"Unexpected error occurred (CID {cid}). Please try again or contact support with this ID."}), 500

@app.route('/config', methods=['GET'])
def get_config():
    return jsonify({
        "mirna_max": MIRNA_MAX,
        "mature_trim_enabled": MATURE_TRIM_ENABLED,
        "mature_window": MATURE_TRIM_WINDOW,
        "aa_convert_allowed": AA_CONVERT_ALLOWED,
        "use_nonce": USE_NONCE
    })

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
    model = tf.keras.models.load_model(model_path, custom_objects=custom_objects)
    scaler = joblib.load(scaler_path)
    print("Model and scaler loaded successfully.")
except Exception as e:
    print(f"FATAL: Could not load model or scaler on startup. Error: {e}")

# =========================
# Helpers: Encoding & Validation
# =========================
def one_hot_encode_sequence(sequence: str, max_len: int):
    sequence = (sequence or "").upper().replace('T', 'U')
    nucleotide_map = {'A': 0, 'U': 1, 'G': 2, 'C': 3, 'N': 4}
    encoded_seq = np.zeros((max_len, len(nucleotide_map)), dtype=np.float32)
    for i, char in enumerate(sequence[:max_len]):
        encoded_seq[i, nucleotide_map.get(char, 4)] = 1
    return encoded_seq

# AA vs NT detection and optional back-translation
AA_SET = set(list("ACDEFGHIKLMNPQRSTVWYBXZ"))  # includes ambiguous X,Z,B
NT_SET = set(list("AUGCTN"))
CODON_MAP = {
    'A':'GCU', 'C':'UGU', 'D':'GAU', 'E':'GAA', 'F':'UUU', 'G':'GGU',
    'H':'CAU', 'I':'AUU', 'K':'AAA', 'L':'UUA', 'M':'AUG', 'N':'AAU',
    'P':'CCU', 'Q':'CAA', 'R':'CGU', 'S':'UCU', 'T':'ACU', 'V':'GUU',
    'W':'UGG', 'Y':'UAU'
}

def is_aa_like(seq: str) -> bool:
    s = ''.join([c for c in (seq or "").upper() if c.isalpha()])
    if not s:
        return False
    aa_frac = sum(c in AA_SET for c in s) / len(s)
    nt_frac = sum(c in NT_SET for c in s) / len(s)
    return aa_frac > 0.8 and nt_frac < 0.6

def back_translate(aa_seq: str) -> str:
    # very simple, organism-agnostic choice
    nt = []
    for a in (aa_seq or "").upper():
        if a in CODON_MAP:
            nt.append(CODON_MAP[a])
        elif a == 'X':  # unknown AA
            nt.append('NNN')
        else:
            nt.append('NNN')
    return ''.join(nt)

def choose_mature_window(seq: str, window: int = 22) -> str:
    s = (seq or "").upper().replace("T","U")
    if len(s) <= window:
        return s
    import itertools
    def score(sub: str):
        gc = (sub.count('G')+sub.count('C'))/len(sub)
        groups = [list(g) for _, g in itertools.groupby(sub)]
        homo_pen = max((len(max(groups, key=len)))-4, 0)
        gc_pen = abs(gc - 0.5)
        return -(gc_pen*2 + homo_pen*0.5)
    best = None
    for i in range(0, len(s)-window+1):
        sub = s[i:i+window]
        sc = score(sub)
        if best is None or sc > best[0]:
            best = (sc, sub)
    return best[1] if best else s

# Numeric features helper (kept minimal & consistent with your scaler)
def numerical_features_from_processed_json(pdata: Dict) -> List[float]:
    gc  = float(pdata.get('gc_content', 0.5))
    dg  = float(pdata.get('dg', 0.0))
    cons= float(pdata.get('conservation', 0.0))
    return [gc, dg, cons]

# FASTA parsing helpers
def parse_fasta_records(text: str):
    """Return list of (id, seq) from FASTA or raw (single) text."""
    try:
        from Bio import SeqIO
    except Exception:
        return _parse_fasta_naive(text)
    records = list(SeqIO.parse(io.StringIO(text or ""), "fasta"))
    if records:
        return [(r.id, str(r.seq)) for r in records]
    raw = (text or "").strip()
    if raw:
        return [("primary_1", raw)]
    return []

def _parse_fasta_naive(text: str):
    lines = (text or "").splitlines()
    out = []
    cur_id = None
    cur_seq = []
    for ln in lines:
        if ln.startswith(">"):
            if cur_id is not None:
                out.append((cur_id, "".join(cur_seq)))
            cur_id = ln[1:].strip() or f"seq_{len(out)+1}"
            cur_seq = []
        else:
            cur_seq.append(ln.strip())
    if cur_id is not None:
        out.append((cur_id, "".join(cur_seq)))
    elif "".join(cur_seq).strip():
        out.append(("primary_1", "".join(cur_seq).strip()))
    return out

def has_any_fasta_header(text: str) -> bool:
    return any(ln.strip().startswith(">") for ln in (text or "").splitlines())

# 3D structure parsing and validation
def extract_seq_from_structure(file_path: str) -> Tuple[Optional[str], str]:
    """Return (kind, seq) where kind in {'AA','NT',None}."""
    try:
        from Bio.PDB import PDBParser, MMCIFParser, PPBuilder
    except Exception as e:
        logging.warning(f"Bio.PDB not available: {e}")
        return (None, "")
    parser = PDBParser(QUIET=True) if file_path.lower().endswith(".pdb") else MMCIFParser(QUIET=True)
    try:
        structure = parser.get_structure("struct", file_path)
    except Exception as e:
        logging.warning(f"Structure parse failed for {file_path}: {e}")
        return (None, "")
    # Protein attempt
    try:
        ppb = PPBuilder()
        aas = []
        for pp in ppb.build_peptides(structure):
            aas.append(str(pp.get_sequence()))
        if aas:
            return ("AA", "".join(aas))
    except Exception as e:
        logging.warning(f"PPBuilder failed: {e}")
    # Nucleic acids by residue name (simple)
    NA3 = {"A":"ADE", "U":"URA", "G":"GUA", "C":"CYT", "T":"THY"}
    nts = []
    try:
        for model in structure:
            for chain in model:
                for res in chain:
                    name = res.get_resname().strip().upper()
                    one = None
                    for base, three in NA3.items():
                        if name == three or name == base:
                            one = base
                            break
                    if one:
                        nts.append(one)
        if nts:
            return ("NT", "".join(nts))
    except Exception as e:
        logging.warning(f"Nucleic parse failed: {e}")
    return (None, "")

def validate_structure_matches_sequence(struct_kind: Optional[str], struct_seq: str,
                                        fasta_seq: str, molecule_label: str,
                                        allow_mismatch_ratio: float = STRUCTURE_MISMATCH_TOL) -> Tuple[bool, str]:
    try:
        from Bio import pairwise2
    except Exception:
        logging.warning("Biopython pairwise2 not available; skipping structure-vs-FASTA validation.")
        return (True, "Skipped (Biopython missing)")
    if struct_kind is None or not struct_seq:
        return (False, f"Could not detect polymer sequence in {molecule_label} 3D file.")
    fasta = (fasta_seq or "").upper().replace("T","U")
    if struct_kind == "AA":
        return (False, f"{molecule_label} 3D file appears to be protein (AA), but the model expects nucleic acid (NT).")
    if struct_kind == "NT":
        s = struct_seq.upper().replace("T","U")
        if not fasta or not s:
            return (False, f"Empty sequence for {molecule_label} during validation.")
        try:
            alns = pairwise2.align.globalms(fasta, s, 2, -1, -5, -0.5, one_alignment_only=True)
        except Exception as e:
            logging.warning(f"Alignment failed: {e}")
            return (True, "Alignment unavailable; not blocking.")
        if not alns:
            return (False, f"Could not align {molecule_label} 3D sequence to provided FASTA.")
        a = alns[0]
        s1, s2 = a.seqA, a.seqB
        matches = sum(1 for x,y in zip(s1,s2) if x==y and x!='-' and y!='-')
        nongaps = sum(1 for x,y in zip(s1,s2) if x!='-' and y!='-')
        mismatch_ratio = 1 - (matches / max(1, nongaps))
        if mismatch_ratio > allow_mismatch_ratio:
            return (False, f"{molecule_label} 3D sequence does not match FASTA (mismatch {mismatch_ratio:.1%}).")
        return (True, "OK")
    return (False, f"Unknown structure polymer kind for {molecule_label}.")

def save_filestorage_to_temp(fs) -> str:
    suffix = os.path.splitext(secure_filename(fs.filename))[1]
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    fs.save(tmp.name)
    tmp_path = tmp.name
    tmp.close()
    return tmp_path

# =========================
# Structural feature extraction and fallback helpers
# =========================
def _seq_to_struct_column(seq: str, max_len: int) -> np.ndarray:
    """
    Convert a nucleotide sequence into a simple numeric column vector (max_len, 1).
    Placeholder: A,U,G,C,N -> 0.0..1.0. Replace with real 3D feature extraction later.
    """
    mapping = {'A': 0.0, 'U': 0.25, 'G': 0.50, 'C': 0.75, 'T': 0.25, 'N': 1.0}
    s = (seq or "").upper()
    v = np.zeros((max_len, 1), dtype=np.float32)
    for i, ch in enumerate(s[:max_len]):
        v[i, 0] = mapping.get(ch, 1.0)
    return v

def extract_structure_vector_from_file(file_path: str, max_len: int) -> Optional[np.ndarray]:
    """
    Build a (max_len, 1) structural vector from a PDB/mmCIF or FASTA-derived sequence by extracting sequence and mapping it.
    Returns None if it fails, so caller can fall back to sequence-derived features or zeros.
    """
    try:
        kind, seq = extract_seq_from_structure(file_path)
        if kind is None or not seq:
            return None
        return _seq_to_struct_column(seq, max_len)
    except Exception:
        return None

def structure_vector_from_processed_json(struct_json: str, max_len: int) -> np.ndarray:
    """
    Turn a JSON-encoded 1D vector into (max_len,1), clipped/padded with zeros.
    """
    try:
        sv = np.array(json.loads(struct_json or "[]"), dtype=np.float32)
    except Exception:
        sv = np.array([], dtype=np.float32)
    if sv.ndim == 0:
        sv = sv.reshape(0)
    if sv.shape[0] > max_len:
        sv = sv[:max_len]
    out = np.zeros((max_len, 1), dtype=np.float32)
    if sv.size > 0:
        out[:sv.shape[0], 0] = sv
    return out

# =========================
# Prediction endpoints
# =========================
limiter = Limiter(key_func=get_remote_address)
limiter.init_app(app)

@app.errorhandler(RateLimitExceeded)
def ratelimit_handler(e):
    return jsonify({
        "error": "rate_limit_exceeded",
        "message": "We limit predictions to 10 every 15 minutes to keep the service fast for everyone. Please wait a few minutes before starting your next run."
    }), 429

@app.route('/predict', methods=['POST'])
@limiter.limit("10 per 15 minutes")
def start_prediction():
    # 1. Strict Content-Type check
    if request.mimetype != 'multipart/form-data':
        return jsonify({"error": "Bad request"}), 400

    # Inputs
    fasta_string = request.form.get('primary_molecules', '')
    target_seq_text = request.form.get('target_molecule', '')
    competitor_seq_text = request.form.get('competitor_molecule', '')

    # Flags (from frontend Advanced Options)
    convert_aa_to_nt_flag = request.form.get('convert_aa_to_nt', 'false').lower() == 'true'
    mature_trim_flag = request.form.get('mature_trim', 'true').lower() == 'true' if MATURE_TRIM_ENABLED else False

    # Parse miRNA FASTA — require headers to identify each sequence
    primary_records = parse_fasta_records(fasta_string)
    if not primary_records:
        return jsonify({"error": "We could not detect any valid miRNA sequences in your input. Please check the format and try again."}), 400
    if not has_any_fasta_header(fasta_string):
        return jsonify({"error": "Your miRNA input is missing FASTA headers. Please add >accession lines (e.g., >hsa-let-7a-5p) so results can be labeled correctly."}), 400
    if len(primary_records) > MIRNA_MAX:
        return jsonify({"error": f"Your submission exceeds the maximum of {MIRNA_MAX} miRNA sequences. Please reduce your input and try again."}), 400

    # ✅ Enforce minimum miRNA length
    MIN_MIRNA_LEN = 10
    short_mirnas = [pid for pid, seq in primary_records if len((seq or '').replace('\n', '').strip()) < MIN_MIRNA_LEN]
    if short_mirnas:
        return jsonify({"error": f"One or more miRNAs are shorter than {MIN_MIRNA_LEN} nt: {', '.join(short_mirnas[:10])}{' ...' if len(short_mirnas) > 10 else ''}"}), 400

    # Targets: one or more sequences (FASTA or raw)
    targets_list = parse_fasta_records(target_seq_text)
    if len(targets_list) == 0:
        return jsonify({"error": "Please provide at least one target sequence (FASTA or raw)."}), 400

    # Optional target region from Advanced tab (applies to every target)
    target_start_raw = request.form.get('target_start', '').strip()
    target_end_raw   = request.form.get('target_end', '').strip()

    def _to_int_safe(s):
        try:
            return int(s)
        except Exception:
            return None

    ts = _to_int_safe(target_start_raw)
    te = _to_int_safe(target_end_raw)

    # Normalize range once; if both None → for each target, full length is used
    def _slice_target(tid: str, tseq: str) -> Tuple[str, str]:
        if ts is None and te is None:
            return (tid, tseq)
        if ts is not None and te is not None:
            if ts <= 0 or te <= 0:
                raise ValueError("Target range must be positive integers (1-based).")
            if te < ts:
                raise ValueError("Target range end must be greater than or equal to start.")
            s_idx = max(0, ts - 1)
            e_idx = min(len(tseq), te)
            if s_idx >= len(tseq):
                raise ValueError("Target range start exceeds the target sequence length.")
            if e_idx - s_idx < 1:
                raise ValueError("Selected target range is empty. Please adjust the indices.")
            return (f"{tid}:{ts}-{te}", tseq[s_idx:e_idx])
        return (tid, tseq)

    try:
        targets_list = [_slice_target(tid, tseq) for (tid, tseq) in targets_list]
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400

    # Length / AA checks per target (after slicing)
    MIN_TARGET_LEN = 30
    _fixed_targets = []
    for (tid, tseq) in targets_list:
        seq = (tseq or '').replace('\n', '').strip()
        if len(seq) < MIN_TARGET_LEN:
            return jsonify({"error": f"Target '{tid}' must be at least {MIN_TARGET_LEN} nt long (after applying range if provided)."}), 400
        if is_aa_like(seq):
            if AA_CONVERT_ALLOWED and convert_aa_to_nt_flag:
                seq = back_translate(seq)
            else:
                return jsonify({"error": f"Target '{tid}' appears to be an amino-acid sequence. Enable AA→NT (lossy) in Advanced to proceed."}), 400
        _fixed_targets.append((tid, seq))
    targets_list = _fixed_targets

    # Competitors: zero or more sequences (FASTA or raw). If none, use a single empty placeholder.
    if competitor_seq_text.strip():
        competitors_list = parse_fasta_records(competitor_seq_text)
        if len(competitors_list) == 0:
            return jsonify({"error": "Could not parse the competitor sequences."}), 400
        MIN_COMP_LEN = 15
        _fixed_comps = []
        for (cid, cseq) in competitors_list:
            s = (cseq or '').replace('\n', '').strip()
            if len(s) < MIN_COMP_LEN:
                return jsonify({"error": f"Competitor '{cid}' must be at least {MIN_COMP_LEN} nt long."}), 400
            if is_aa_like(s):
                if AA_CONVERT_ALLOWED and convert_aa_to_nt_flag:
                    s = back_translate(s)
                else:
                    return jsonify({"error": f"Competitor '{cid}' appears to be an amino-acid sequence. Enable AA→NT (lossy) in Advanced to proceed."}), 400
            _fixed_comps.append((cid, s))
        competitors_list = _fixed_comps
    else:
        competitors_list = [("none", "")]  # placeholder meaning “no competitor”

    # Save uploaded 3D files to temp and index them
    tmp_paths_to_cleanup: List[str] = []
    def _save_optional(fs_key: str) -> Optional[str]:
        f = request.files.get(fs_key)
        if f and f.filename:
            p = save_filestorage_to_temp(f)
            tmp_paths_to_cleanup.append(p)
            return p
        return None

    target_3d_path = _save_optional('target_3d_file')
    competitor_3d_path = _save_optional('competitor_3d_file')

    mirna_3d_files = request.files.getlist('mirna_3d_file')
    mirna_3d_index: Dict[str, Tuple[Optional[str], str, str]] = {}
    for f in mirna_3d_files:
        if f and f.filename:
            p = save_filestorage_to_temp(f)
            tmp_paths_to_cleanup.append(p)
            stem = os.path.splitext(secure_filename(f.filename))[0]
            kind, seq = extract_seq_from_structure(p)
            mirna_3d_index[stem] = (kind, seq, p)

    job_id = str(uuid.uuid4())
    # Derive total = miRNAs × targets × competitors
    _total = len(primary_records) * max(1, len(targets_list)) * max(1, len(competitors_list))

    jobs[job_id] = {
        "status": "running",
        "results": [],
        "error": None,
        "total": _total,
        "completed": 0,
        "target_id": "MULTIPLE" if len(targets_list) > 1 else targets_list[0][0],
        "target_len": -1  # not meaningful for multiple; kept for backward compatibility
    }

    send_ga_event("prediction_started", {"total": _total})

    threading.Thread(
        target=process_job,
        args=(job_id, primary_records, targets_list, competitors_list,
              target_3d_path, competitor_3d_path, mirna_3d_index, tmp_paths_to_cleanup,
              convert_aa_to_nt_flag, mature_trim_flag),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id, "status": "started"})

def process_job(job_id: str,
                primary_records: List[Tuple[str,str]],
                targets_list: List[Tuple[str,str]],
                competitors_list: List[Tuple[str,str]],
                target_3d_path: Optional[str],
                competitor_3d_path: Optional[str],
                mirna_3d_index: Dict[str, Tuple[Optional[str], str, str]],
                tmp_paths_to_cleanup: List[str],
                convert_aa_to_nt_flag: bool,
                mature_trim_flag: bool):
    try:
        if model is None or scaler is None:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "Model or scaler not loaded on server."
            return

        # Helper to normalize processor outputs
        def ensure_dict(data):
            if isinstance(data, tuple):
                return {
                    "sequence": data[1] if len(data) > 1 else "",
                    "gc_content": 0.5, "dg": 0.0, "conservation": 0.0,
                    "structure_vector": "[]", "adjacency_matrix": "[]"
                }
            return data

        # Static model input shapes (and which inputs exist)
        model_inputs = {inp.name: inp.shape for inp in model.inputs}
        max_primary_len    = model_inputs.get('primary_sequence_input', [None, 120])[1]
        max_target_len     = model_inputs.get('target_sequence_input', [None, 200])[1]
        max_competitor_len = model_inputs.get('competitor_sequence_input', [None, 200])[1]
        empty_comp_enc     = one_hot_encode_sequence('', max_competitor_len)

        # Iterate in the requested order: competitors → targets → miRNA batches
        for (competitor_id, competitor_str) in competitors_list:
            # Prepare competitor once per competitor_id
            competitor_processed = {'sequence': ''}
            if competitor_str.strip():
                competitor_processed = ensure_dict(process_molecule_universal(((competitor_id, competitor_str), {}, 'competitor_molecule')))

            # Validate optional 3D file vs FASTA (competitor)
            if competitor_3d_path and competitor_processed.get('sequence','').strip():
                kind, seq = extract_seq_from_structure(competitor_3d_path)
                ok, msg = validate_structure_matches_sequence(kind, seq, competitor_processed.get('sequence',''), "Competitor")
                if not ok:
                    jobs[job_id]["status"] = "error"
                    jobs[job_id]["error"] = msg
                    return

            comp_seq_enc = None
            if competitor_processed.get('sequence', '').strip():
                comp_seq_enc = one_hot_encode_sequence(competitor_processed.get('sequence', ''), max_competitor_len)

            # Competitor structural input (if expected)
            competitor_struct_input = None
            if 'competitor_structure_input' in model_inputs:
                vec = None
                if competitor_3d_path:
                    vec = extract_structure_vector_from_file(competitor_3d_path, max_competitor_len)
                if vec is None:
                    if competitor_processed.get('sequence','').strip():
                        vec = structure_vector_from_processed_json(competitor_processed.get('structure_vector', '[]'), max_competitor_len)
                    else:
                        vec = np.zeros((max_competitor_len,1), dtype=np.float32)
                competitor_struct_input = vec

            for (target_id, target_str) in targets_list:
                # Prepare target once per target_id
                target_processed = ensure_dict(process_molecule_universal(((target_id, target_str), {}, 'target_molecule')))
                target_seq_enc   = one_hot_encode_sequence(target_processed.get('sequence', ''), max_target_len)

                # Validate optional 3D file vs FASTA (target)
                if target_3d_path and target_processed.get('sequence',''):
                    kind, seq = extract_seq_from_structure(target_3d_path)
                    ok, msg = validate_structure_matches_sequence(kind, seq, target_processed.get('sequence',''), "Target")
                    if not ok:
                        jobs[job_id]["status"] = "error"
                        jobs[job_id]["error"] = msg
                        return

                # Target structural input (if expected)
                target_struct_input = None
                if 'target_structure_input' in model_inputs:
                    vec = None
                    if target_3d_path:
                        vec = extract_structure_vector_from_file(target_3d_path, max_target_len)
                    if vec is None:
                        vec = structure_vector_from_processed_json(target_processed.get('structure_vector', '[]'), max_target_len)
                    target_struct_input = vec

                # -------- Batch over primaries --------
                for start in range(0, len(primary_records), BATCH_SIZE):
                    batch_records = primary_records[start:start + BATCH_SIZE]
                    prim_seq_list, num_feat_list, prim_struct_list = [], [], []

                    # Prepare primary (miRNA) batch (optionally trim)
                    for pri_id, pri_seq in batch_records:
                        pdata = ensure_dict(process_molecule_universal(((pri_id, pri_seq), {}, 'primary_molecule')))
                        seq = pdata.get('sequence', '')
                        if mature_trim_flag and len(seq) > 30:
                            seq = choose_mature_window(seq, window=MATURE_TRIM_WINDOW)
                            pdata['sequence'] = seq

                        prim_seq_list.append(one_hot_encode_sequence(pdata.get('sequence',''), max_primary_len))
                        num_feat_list.append(numerical_features_from_processed_json(pdata))

                        # Build primary structure vector (if model expects it)
                        if 'primary_structure_input' in model_inputs:
                            sp = structure_vector_from_processed_json(pdata.get('structure_vector','[]'), max_primary_len)
                            prim_struct_list.append(sp)

                        # If a 3D file for this miRNA exists, validate match
                        if pri_id in mirna_3d_index:
                            kind, seq3d, path3d = mirna_3d_index[pri_id]
                            ok, msg = validate_structure_matches_sequence(kind, seq3d, pdata.get('sequence',''), f"miRNA {pri_id}")
                            if not ok:
                                jobs[job_id]["status"] = "error"
                                jobs[job_id]["error"] = msg
                                return

                    # Encode/scale numeric features
                    if 'numerical_features_input' in model_inputs:
                        try:
                            if hasattr(scaler, 'feature_names_in_'):
                                df_features = pd.DataFrame(num_feat_list, columns=scaler.feature_names_in_)
                                scaled_num = scaler.transform(df_features)
                            else:
                                scaled_num = scaler.transform(num_feat_list)
                        except Exception as e:
                            jobs[job_id]["status"] = "error"
                            jobs[job_id]["error"] = f"Numeric feature scaling failed: {e}"
                            return

                    pri_seq_enc  = np.stack(prim_seq_list, axis=0).astype(np.float32)
                    batch_size   = pri_seq_enc.shape[0]

                    common_inputs = {
                        'primary_sequence_input': pri_seq_enc,
                        'target_sequence_input':  np.repeat(target_seq_enc[np.newaxis, ...], batch_size, axis=0),
                    }
                    if 'numerical_features_input' in model_inputs:
                        common_inputs['numerical_features_input'] = scaled_num
                    if 'primary_structure_input' in model_inputs:
                        pri_struct = np.stack(prim_struct_list, axis=0).astype(np.float32) if prim_struct_list else np.zeros((batch_size, max_primary_len, 1), dtype=np.float32)
                        common_inputs['primary_structure_input'] = pri_struct
                    if 'target_structure_input' in model_inputs and target_struct_input is not None:
                        common_inputs['target_structure_input'] = np.repeat(target_struct_input[np.newaxis, ...], batch_size, axis=0)
                    if 'competitor_structure_input' in model_inputs and competitor_struct_input is not None:
                        common_inputs['competitor_structure_input'] = np.repeat(competitor_struct_input[np.newaxis, ...], batch_size, axis=0)

                    # Prepare competitor present/absent inputs
                    with_comp = dict(common_inputs)
                    if comp_seq_enc is not None:
                        with_comp['competitor_sequence_input'] = np.repeat(comp_seq_enc[np.newaxis, ...], batch_size, axis=0)
                    else:
                        with_comp['competitor_sequence_input'] = np.repeat(empty_comp_enc[np.newaxis, ...], batch_size, axis=0)

                    no_comp = dict(common_inputs)
                    no_comp['competitor_sequence_input'] = np.repeat(empty_comp_enc[np.newaxis, ...], batch_size, axis=0)

                    # Predict
                    preds_with = model.predict(with_comp, verbose=0).reshape(-1).astype(np.float64)
                    preds_no   = model.predict(no_comp,   verbose=0).reshape(-1).astype(np.float64)

                    # Accumulate results
                    for (pri_id, _), p_base, p_with in zip(batch_records, preds_no, preds_with):
                        jobs[job_id]["results"].append({
                            'primary_molecule_id': pri_id,
                            'mirna_id': pri_id,
                            'target_id': target_id,
                            'competitor_id': competitor_id if competitor_str else '',
                            'predicted_affinity_baseline': format(float(p_base), '.10f'),
                            'predicted_affinity_with_competitor': format(float(p_with), '.10f'),
                            'competitive_effect (higher_is_better)': format(float(p_base - p_with), '.10f'),
                        })
                        jobs[job_id]["completed"] += 1

        jobs[job_id]["status"] = "completed"
        send_ga_event("prediction_completed", {"total": jobs[job_id]["total"]})
    except Exception as e:
        logging.exception(f"Prediction error: {e}")
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)[:500]
    finally:
        for p in tmp_paths_to_cleanup:
            try:
                os.unlink(p)
            except Exception:
                pass

@app.route('/progress/<job_id>', methods=['GET'])
def get_progress(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    return jsonify({
        "status": job["status"],
        "completed": job["completed"],
        "total": job["total"],
        "error": job["error"],
        "results": job["results"] if job["status"] == "completed" else []
    })

@app.route('/download/<job_id>', methods=['GET'])
def download_results(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400
    # Optionally sort by baseline so frontend can skip sorting if needed
    try:
        def _safe_float(x):
            try:
                return float(x)
            except Exception:
                return -math.inf
        job["results"].sort(key=lambda r: _safe_float(r.get('predicted_affinity_baseline', -1)), reverse=True)
    except Exception:
        pass
    return jsonify({"results": job["results"]})

# =========================
# Startup
# =========================
if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(debug=True, host='0.0.0.0', port=port)
