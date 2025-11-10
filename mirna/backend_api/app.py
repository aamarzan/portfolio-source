# app.py — multi-target & multi-competitor + seed-scan + IG explain + CSV & heatmap exports + 3D contacts
# (premium, future-proof, and strictly provenance-grounded)

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
import hashlib
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Tuple, List, Optional

import numpy as np
import pandas as pd
import requests
from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_limiter.errors import RateLimitExceeded
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge

# use non-interactive backend for server PNG export
import matplotlib
matplotlib.use("Agg")  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

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

# Persist uploaded 3D artifacts for viewer endpoints (kept until job clean-up)
ARTIFACT_TTL_SECONDS = int(os.getenv("ARTIFACT_TTL_SECONDS", "7200"))  # 2h

# Jobs registry
# job_id -> {
#   status, error, total, completed,
#   target_id, target_len,
#   artifacts: { 'target_3d_path':..., 'competitor_3d_path':..., 'mirna_3d_index':... , 'expiry': float },
#   results: [ row, ... ],
#   model_input_shapes: {Lp, Lt, Lc},
# }
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

def _nonce_protected(endpoint_name: Optional[str]) -> bool:
    protected = {
        'start_prediction', 'seed_scan', 'explain',
        'download_all_csv', 'download_single_csv',
        'download_heatmap_png',
        'download_seeds_all', 'download_seeds_one',
        'get_structure_artifact', 'get_structure_mirna',
        'get_contacts'
    }
    return endpoint_name in protected

@app.before_request
def require_nonce_or_key():
    if request.method == "OPTIONS":
        return '', 200
    if _nonce_protected(request.endpoint):
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
# Load Model and Scaler + Provenance
# =========================
MODELS_DIR = 'model_files'
model = None
scaler = None

def _sha256_file(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None

PROVENANCE = {
    "model_name": "supreme_model.keras",
    "model_path": None,
    "model_sha256": None,
    "scaler_name": "minmax_scaler.pkl",
    "scaler_path": None,
    "scaler_sha256": None
}

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

    PROVENANCE["model_path"] = os.path.abspath(model_path)
    PROVENANCE["scaler_path"] = os.path.abspath(scaler_path)
    PROVENANCE["model_sha256"] = _sha256_file(model_path)
    PROVENANCE["scaler_sha256"] = _sha256_file(scaler_path)
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


# =========================
# FASTA parsing helpers (PATCH: preserve FULL header)
# =========================
def parse_fasta_records(text: str):
    """Return list of (full_header, seq) from FASTA or raw (single) text.

    FULL header = everything after '>' up to newline (spaces/punctuation preserved).
    """
    try:
        from Bio import SeqIO
    except Exception:
        return _parse_fasta_naive(text)
    records = list(SeqIO.parse(io.StringIO(text or ""), "fasta"))
    if records:
        out = []
        for r in records:
            hdr = (getattr(r, "description", None) or r.id or "").strip()
            if not hdr:
                hdr = f"seq_{len(out)+1}"
            out.append((hdr, str(r.seq)))
        return out
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
            cur_id = ln[1:].rstrip("\r\n")
            if not cur_id:
                cur_id = f"seq_{len(out)+1}"
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


# =========================
# 3D structure parsing and validation
# =========================
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
    Placeholder: A,U,G,C,N -> 0.0..1.0.
    """
    mapping = {'A': 0.0, 'U': 0.25, 'G': 0.50, 'C': 0.75, 'T': 0.25, 'N': 1.0}
    s = (seq or "").upper()
    v = np.zeros((max_len, 1), dtype=np.float32)
    for i, ch in enumerate(s[:max_len]):
        v[i, 0] = mapping.get(ch, 1.0)
    return v

def extract_structure_vector_from_file(file_path: str, max_len: int) -> Optional[np.ndarray]:
    try:
        kind, seq = extract_seq_from_structure(file_path)
        if kind is None or not seq:
            return None
        return _seq_to_struct_column(seq, max_len)
    except Exception:
        return None

def structure_vector_from_processed_json(struct_json: str, max_len: int) -> np.ndarray:
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
# Seed-scan helpers (deterministic, rule-based)
# =========================
def revcomp_rna(seq: str) -> str:
    comp = str.maketrans({'A':'U','U':'A','G':'C','C':'G','T':'A','N':'N'})
    return (seq or '').upper().translate(comp)[::-1].replace('T','U')

def is_wc(a: str, b: str) -> bool:   # Watson–Crick
    return (a=='A' and b=='U') or (a=='U' and b=='A') or (a=='C' and b=='G') or (a=='G' and b=='C')

def is_gu(a: str, b: str) -> bool:   # GU wobble
    return (a=='G' and b=='U') or (a=='U' and b=='G')

def match_seed(seed_rc: str, window: str, allow_gu: bool = True, max_mismatch: int = 0):
    mism = wob = 0
    for x,y in zip(seed_rc, window):
        if is_wc(x,y):
            continue
        elif allow_gu and is_gu(x,y):
            wob += 1
        else:
            mism += 1
            if mism > max_mismatch:
                return None
    return {'mismatches': mism, 'wobble': wob}

def classify_seed(miRNA_seq: str, target_seq: str, i: int, L: int) -> str:
    """
    Canonical labels:
    - 7mer-m8: perfect 2–8 (L==7)
    - 8mer: 7mer-m8 + upstream 'A'
    - 7mer-A1: perfect 2–7 (L==6) + upstream 'A'
    - 6mer: 2–7 perfect (no upstream A)
    """
    m = (miRNA_seq or '').upper().replace('T','U')
    t = (target_seq or '').upper().replace('T','U')
    label = f'seed{L}'
    upstream_A = (i-1 >= 0 and t[i-1] == 'A')
    if L == 7:
        label = '7mer-m8'
        if upstream_A:
            label = '8mer'
    elif L == 6:
        label = '7mer-A1' if upstream_A else '6mer'
    return label

def _scan_seeds_for_pair(mirna_seq: str, target_seq: str,
                         allow_gu: bool = True, max_mismatch: int = 0) -> List[Dict]:
    m = (mirna_seq or "").upper().replace('T','U')
    t = (target_seq or "").upper().replace('T','U')
    if not m or not t:
        return []
    hits: List[Dict] = []
    seed_2_8 = m[1:8] if len(m) >= 8 else m[1:]
    seed_2_7 = m[1:7] if len(m) >= 7 else m[1:]
    seeds = [(seed_2_8, 7), (seed_2_7, 6)]
    seeds = [(s, L) for (s, L) in seeds if len(s) == L and L in (6,7)]
    for seed, L in seeds:
        seed_rc = revcomp_rna(seed)
        max_i = max(0, len(t) - len(seed_rc) + 1)
        for i in range(0, max_i):
            w = t[i:i+len(seed_rc)]
            score = match_seed(seed_rc, w, allow_gu=allow_gu, max_mismatch=max_mismatch)
            if score is None:
                continue
            hit = {
                'start': i + 1,
                'end': i + len(seed_rc),
                'seed_len': len(seed_rc),
                'seed_type': classify_seed(m, t, i, L),
                **score
            }
            if i - 1 >= 0:
                hit['upstream_base'] = t[i-1]
            hits.append(hit)
    return hits


# =========================
# IG explain helper
# =========================
def integrated_gradients(model, inputs_dict: Dict[str, np.ndarray], input_key: str, steps: int = 50) -> List[float]:
    """
    Compute Integrated Gradients on a single input tensor of shape (1, L, C).
    Returns a list of length L with per-position attribution magnitude (sum over channels).
    """
    x = tf.convert_to_tensor(inputs_dict[input_key], dtype=tf.float32)  # (1, L, C)
    baseline = tf.zeros_like(x)
    grads_accum = tf.zeros_like(x)

    for k in range(1, steps + 1):
        alpha = tf.cast(k / steps, tf.float32)
        x_step = baseline + alpha * (x - baseline)
        with tf.GradientTape() as tape:
            tape.watch(x_step)
            feed = {k2: (tf.convert_to_tensor(v) if not isinstance(v, tf.Tensor) else v)
                    for k2, v in inputs_dict.items()}
            feed[input_key] = x_step
            out = model(feed, training=False)
            out = tf.reduce_mean(out)  # ensure scalar
        grads = tape.gradient(out, x_step)
        grads_accum += grads

    ig = (x - baseline) * grads_accum / steps
    ig_pos = tf.reduce_sum(tf.abs(ig), axis=-1).numpy()[0].tolist()  # (L,)
    return ig_pos


# =========================
# PATCH: tolerant ID variants for 3D-file ↔ FASTA header matching
# =========================
def _id_variants(s: str) -> List[str]:
    """Generate tolerant keys to match filename stems against full FASTA headers."""
    if not s:
        return []
    t = s.strip()
    cand = {
        t,
        t.replace(" ", "_"),
        t.replace(" ", ""),
        secure_filename(t),
        secure_filename(t).replace("_", " "),
        t.lower(),
        secure_filename(t).lower(),
        t.replace(" ", "_").lower(),
        t.replace(" ", "").lower(),
    }
    return list(cand)

def _lookup_3d(idx: Dict[str, Tuple[Optional[str], str, str]], key: str):
    for k in _id_variants(key):
        if k in idx:
            return idx[k]
    return None


# =========================
# Prediction & analysis endpoints
# =========================
limiter = Limiter(key_func=get_remote_address)
limiter.init_app(app)

@app.errorhandler(RateLimitExceeded)
def ratelimit_handler(e):
    return jsonify({
        "error": "rate_limit_exceeded",
        "message": "We limit predictions to keep the service fast for everyone. Please try again later."
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

    # PATCH: index miRNA 3D files under multiple tolerant keys
    mirna_3d_files = request.files.getlist('mirna_3d_file')
    mirna_3d_index: Dict[str, Tuple[Optional[str], str, str]] = {}
    for f in mirna_3d_files:
        if f and f.filename:
            p = save_filestorage_to_temp(f)
            tmp_paths_to_cleanup.append(p)
            stem = os.path.splitext(secure_filename(f.filename))[0]
            kind, seq = extract_seq_from_structure(p)
            for k in _id_variants(stem):
                mirna_3d_index[k] = (kind, seq, p)

    job_id = str(uuid.uuid4())
    _total = len(primary_records) * max(1, len(targets_list)) * max(1, len(competitors_list))

    jobs[job_id] = {
        "status": "running",
        "results": [],
        "error": None,
        "total": _total,
        "completed": 0,
        "target_id": "MULTIPLE" if len(targets_list) > 1 else targets_list[0][0],
        "target_len": -1,
        "artifacts": {
            "target_3d_path": target_3d_path,
            "competitor_3d_path": competitor_3d_path,
            "mirna_3d_index": mirna_3d_index,
            "expiry": time.time() + ARTIFACT_TTL_SECONDS
        },
        "model_input_shapes": {}  # filled in process_job
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
        max_primary_len    = int(model_inputs.get('primary_sequence_input', [None, 120])[1])
        max_target_len     = int(model_inputs.get('target_sequence_input', [None, 200])[1])
        max_competitor_len = int(model_inputs.get('competitor_sequence_input', [None, 200])[1])
        empty_comp_enc     = one_hot_encode_sequence('', max_competitor_len)

        jobs[job_id]["model_input_shapes"] = {"Lp": max_primary_len, "Lt": max_target_len, "Lc": max_competitor_len}

        # Iterate in the requested order: competitors → targets → miRNA batches
        interaction_counter = 0

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
                target_seq_used = target_processed.get('sequence', '')
                target_seq_enc  = one_hot_encode_sequence(target_seq_used, max_target_len)

                # Validate optional 3D file vs FASTA (target)
                if target_3d_path and target_seq_used:
                    kind, seq = extract_seq_from_structure(target_3d_path)
                    ok, msg = validate_structure_matches_sequence(kind, seq, target_seq_used, "Target")
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
                    trimmed_sequences: List[str] = []

                    # Prepare primary (miRNA) batch (optionally trim)
                    for pri_id, pri_seq in batch_records:
                        pdata = ensure_dict(process_molecule_universal(((pri_id, pri_seq), {}, 'primary_molecule')))
                        seq = pdata.get('sequence', '')
                        if MATURE_TRIM_ENABLED and mature_trim_flag and len(seq) > 30:
                            seq = choose_mature_window(seq, window=MATURE_TRIM_WINDOW)
                            pdata['sequence'] = seq

                        trimmed_sequences.append(seq)
                        prim_seq_list.append(one_hot_encode_sequence(seq, max_primary_len))
                        num_feat_list.append(numerical_features_from_processed_json(pdata))

                        # Build primary structure vector (if model expects it)
                        if 'primary_structure_input' in model_inputs:
                            sp = structure_vector_from_processed_json(pdata.get('structure_vector','[]'), max_primary_len)
                            prim_struct_list.append(sp)

                        # PATCH: tolerant lookup for miRNA 3D matching
                        val = _lookup_3d(mirna_3d_index, pri_id)
                        if val is not None:
                            kind, seq3d, path3d = val
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

                    # Accumulate results (+ seed details)
                    for row_idx, ((pri_id, _), p_base, p_with) in enumerate(zip(batch_records, preds_no, preds_with)):
                        interaction_counter += 1
                        pri_seq_used = trimmed_sequences[row_idx]
                        seed_hits = _scan_seeds_for_pair(pri_seq_used, target_seq_used, allow_gu=True, max_mismatch=0)

                        # derive compact summary for CSV columns
                        best = None
                        if seed_hits:
                            # prefer longer seed, then fewer mismatches, then fewer wobble, then earliest position
                            seed_hits_sorted = sorted(seed_hits, key=lambda h: (-h['seed_len'], h['mismatches'], h.get('wobble',0), h['start']))
                            best = seed_hits_sorted[0]

                        row = {
                            'interaction_id': f"I{interaction_counter:07d}",
                            'timestamp_utc': datetime.utcnow().isoformat(timespec='seconds'),
                            'mirna_id': pri_id,
                            'primary_molecule_id': pri_id,
                            'target_id': target_id,
                            'competitor_id': competitor_id if competitor_str else '',
                            'predicted_affinity_baseline': format(float(p_base), '.10f'),
                            'predicted_affinity_with_competitor': format(float(p_with), '.10f'),
                            'competitive_effect (higher_is_better)': format(float(p_base - p_with), '.10f'),

                            # sequences used (to allow reproducible /explain & per-interaction heatmap)
                            'primary_seq_used': pri_seq_used,
                            'target_seq_used': target_seq_used,
                            'competitor_seq_used': competitor_processed.get('sequence','') if competitor_str else '',

                            # seed info (JSON plus top summary columns)
                            'seed_hits_json': json.dumps(seed_hits, separators=(',',':')),
                            'seed_best_type': (best or {}).get('seed_type', ''),
                            'seed_best_start': (best or {}).get('start', ''),
                            'seed_best_end': (best or {}).get('end', ''),
                            'seed_best_wobble': (best or {}).get('wobble', ''),
                            'seed_best_mismatches': (best or {}).get('mismatches', '')
                        }

                        # attach provenance once per row to keep CSV self-auditable
                        row.update({
                            'prov_model_path': PROVENANCE.get('model_path'),
                            'prov_model_sha256': PROVENANCE.get('model_sha256'),
                            'prov_scaler_path': PROVENANCE.get('scaler_path'),
                            'prov_scaler_sha256': PROVENANCE.get('scaler_sha256'),
                            'prov_explain_method': 'integrated_gradients',
                            'prov_explain_steps': 50,
                            'prov_seed_rules': 'v1 canonical (6/7mer, upstream-A for 7mer-A1/8mer), allow_gu=True, max_mismatch=0'
                        })

                        jobs[job_id]["results"].append(row)
                        jobs[job_id]["completed"] += 1

        jobs[job_id]["status"] = "completed"
        send_ga_event("prediction_completed", {"total": jobs[job_id]["total"]})
    except Exception as e:
        logging.exception(f"Prediction error: {e}")
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)[:500]
    finally:
        # NOTE: we deliberately do NOT delete tmp_paths immediately to allow later viewer/structure use during TTL.
        # A background janitor will clean them up after expiry.
        start_janitor()  # ensure janitor thread is running


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
    # Legacy JSON endpoint (kept for backward compatibility)
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400
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
# CSV + Heatmap Download Endpoints
# =========================
def _results_df(job_id: str) -> pd.DataFrame:
    job = jobs.get(job_id)
    if not job or job["status"] != "completed":
        return pd.DataFrame()
    df = pd.DataFrame(job["results"])
    preferred = [
        'interaction_id', 'timestamp_utc',
        'mirna_id', 'primary_molecule_id', 'target_id', 'competitor_id',
        'predicted_affinity_baseline', 'predicted_affinity_with_competitor',
        'competitive_effect (higher_is_better)',
        'seed_best_type','seed_best_start','seed_best_end','seed_best_wobble','seed_best_mismatches',
        'seed_hits_json',
        'primary_seq_used','target_seq_used','competitor_seq_used',
        'prov_model_path','prov_model_sha256','prov_scaler_path','prov_scaler_sha256',
        'prov_explain_method','prov_explain_steps','prov_seed_rules'
    ]
    rest = [c for c in df.columns if c not in preferred]
    return df[preferred + rest]

@app.route('/download/<job_id>/all.csv', methods=['GET'])
def download_all_csv(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400

    df = _results_df(job_id)
    if df.empty:
        return jsonify({"error": "No results available"}), 400

    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    send_ga_event("download_all_csv", {"job_id": job_id, "rows": len(df)})
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=mirna_results_{job_id}.csv"}
    )

@app.route('/download/<job_id>/<interaction_id>.csv', methods=['GET'])
def download_single_csv(job_id, interaction_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400

    row = next((r for r in job["results"] if r.get('interaction_id') == interaction_id), None)
    if not row:
        return jsonify({"error": "Invalid interaction_id"}), 404

    df = pd.DataFrame([row])
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    send_ga_event("download_single_csv", {"job_id": job_id})
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=interaction_{interaction_id}.csv"}
    )

# ---- NEW: seed-hits exploded CSVs (per-row and all-rows) ----
def _explode_seed_hits(row: Dict) -> List[Dict]:
    out = []
    hits = []
    try:
        hits = json.loads(row.get('seed_hits_json') or "[]")
    except Exception:
        hits = []
    for h in hits:
        out.append({
            "interaction_id": row.get("interaction_id"),
            "mirna_id": row.get("mirna_id"),
            "target_id": row.get("target_id"),
            "competitor_id": row.get("competitor_id",""),
            "seed_type": h.get("seed_type",""),
            "start": h.get("start",""),
            "end": h.get("end",""),
            "seed_len": h.get("seed_len",""),
            "mismatches": h.get("mismatches",""),
            "wobble": h.get("wobble",""),
            "upstream_base": h.get("upstream_base","")
        })
    return out

@app.route('/download/<job_id>/seeds_all.csv', methods=['GET'])
def download_seeds_all(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400

    rows = []
    for r in job["results"]:
        rows.extend(_explode_seed_hits(r))
    if not rows:
        return jsonify({"error": "No seed hits available"}), 400

    df = pd.DataFrame(rows)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    send_ga_event("download_seeds_all", {"job_id": job_id, "rows": len(df)})
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=seed_hits_{job_id}.csv"}
    )

@app.route('/download/<job_id>/<interaction_id>/seeds.csv', methods=['GET'])
def download_seeds_one(job_id, interaction_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400

    row = next((r for r in job["results"] if r.get('interaction_id') == interaction_id), None)
    if not row:
        return jsonify({"error": "Invalid interaction_id"}), 404

    rows = _explode_seed_hits(row)
    if not rows:
        return jsonify({"error": "No seed hits for this interaction"}), 400

    df = pd.DataFrame(rows)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    send_ga_event("download_seeds_one", {"job_id": job_id, "interaction_id": interaction_id})
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=seed_hits_{interaction_id}.csv"}
    )

def _build_ig_feed(pseq: str, tseq: str, cseq: str,
                   Lp: int, Lt: int, Lc: int, include_struct: Dict[str, bool]) -> Dict[str, np.ndarray]:
    # sequences
    pri_enc = one_hot_encode_sequence(pseq, Lp)[None, ...]
    tgt_enc = one_hot_encode_sequence(tseq, Lt)[None, ...]
    cmp_enc = one_hot_encode_sequence(cseq or '', Lc)[None, ...]

    # numeric features (safe baseline)
    if hasattr(scaler, 'feature_names_in_'):
        z = np.zeros((1, len(scaler.feature_names_in_)), dtype=np.float32)
        scaled_num = scaler.transform(z)
    else:
        scaled_num = scaler.transform([[0.5, 0.0, 0.0]])

    feed = {
        'primary_sequence_input': pri_enc.astype(np.float32),
        'target_sequence_input':  tgt_enc.astype(np.float32),
        'competitor_sequence_input': cmp_enc.astype(np.float32),
        'numerical_features_input': scaled_num.astype(np.float32)
    }

    if include_struct.get('primary_structure_input', False):
        feed['primary_structure_input'] = np.zeros((1, Lp, 1), dtype=np.float32)
    if include_struct.get('target_structure_input', False):
        feed['target_structure_input'] = np.zeros((1, Lt, 1), dtype=np.float32)
    if include_struct.get('competitor_structure_input', False):
        feed['competitor_structure_input'] = np.zeros((1, Lc, 1), dtype=np.float32)

    return feed

@app.route('/download/<job_id>/<interaction_id>/heatmap.png', methods=['GET'])
def download_heatmap_png(job_id, interaction_id):
    """
    Export a PNG heatmap for a single interaction.

    Query params:
      mode=ig_target | ig_competitor | seed_density   (default=ig_target)
      steps=<int>    (IG steps, default=50)
    """
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    if job["status"] != "completed":
        return jsonify({"error": "Job not completed yet"}), 400

    row = next((r for r in job["results"] if r.get('interaction_id') == interaction_id), None)
    if not row:
        return jsonify({"error": "Invalid interaction_id"}), 404

    mode = (request.args.get('mode') or 'ig_target').lower().strip()
    steps = int(request.args.get('steps') or 50)

    pseq = row.get('primary_seq_used','') or ''
    tseq = row.get('target_seq_used','') or ''
    cseq = row.get('competitor_seq_used','') or ''

    shapes = job.get("model_input_shapes", {})
    Lp, Lt, Lc = int(shapes.get('Lp', 120)), int(shapes.get('Lt', 200)), int(shapes.get('Lc', 200))
    include_struct = {
        'primary_structure_input': 'primary_structure_input' in {i.name for i in model.inputs},
        'target_structure_input': 'target_structure_input' in {i.name for i in model.inputs},
        'competitor_structure_input': 'competitor_structure_input' in {i.name for i in model.inputs},
    }

    # Build feed & compute data
    if mode.startswith('ig'):
        # Integrated Gradients heatmap over model inputs
        feed = _build_ig_feed(pseq, tseq, cseq, Lp, Lt, Lc, include_struct)
        if mode == 'ig_target':
            values = integrated_gradients(model, feed, 'target_sequence_input', steps=steps)
            title = f"IG (target) — {row.get('mirna_id')} vs {row.get('target_id')}"
            L = Lt
        elif mode == 'ig_competitor':
            values = integrated_gradients(model, feed, 'competitor_sequence_input', steps=steps)
            title = f"IG (competitor) — {row.get('mirna_id')} vs {row.get('competitor_id','')}"
            L = Lc
        else:
            return jsonify({"error": "Invalid mode. Use ig_target, ig_competitor, or seed_density."}), 400
        data = np.array(values[:L], dtype=np.float32)[None, :]  # shape (1, L)
        ytick = ['IG magnitude']
    elif mode == 'seed_density':
        hits = json.loads(row.get('seed_hits_json') or "[]")
        L = len(tseq)
        vec = np.zeros(L, dtype=np.float32)
        for h in hits:
            s = int(h['start'])-1
            e = int(h['end'])
            vec[s:e] += 1.0
        if L == 0:
            vec = np.zeros(1, dtype=np.float32)
        data = vec[None, :]  # (1, L)
        title = f"Seed-hit density — {row.get('mirna_id')} on {row.get('target_id')}"
        ytick = ['hit count']
    else:
        return jsonify({"error": "Invalid mode. Use ig_target, ig_competitor, or seed_density."}), 400

    # Plot heatmap
    fig, ax = plt.subplots(figsize=(max(6, data.shape[1] / 20.0), 1.8))
    im = ax.imshow(data, aspect='auto')
    ax.set_yticks([0])
    ax.set_yticklabels(ytick)
    ax.set_xlabel('Position')
    ax.set_title(title, fontsize=10)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    buf = io.BytesIO()
    plt.tight_layout()
    fig.savefig(buf, format='png', dpi=200)
    plt.close(fig)
    buf.seek(0)

    send_ga_event("download_heatmap_png", {"job_id": job_id, "interaction_id": interaction_id, "mode": mode})
    return send_file(buf, mimetype="image/png",
                     as_attachment=True,
                     download_name=f"{interaction_id}_{mode}.png")


# =========================
# Public structure artifact getters (for 3D viewer)
# =========================
@app.route('/structure/<job_id>/<kind>', methods=['GET'])
def get_structure_artifact(job_id, kind):
    """
    kind: target | competitor
    """
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    art = job.get("artifacts") or {}
    if time.time() > float(art.get("expiry", 0)):
        return jsonify({"error": "Artifacts expired"}), 410

    path = None
    if kind == 'target':
        path = art.get('target_3d_path')
    elif kind == 'competitor':
        path = art.get('competitor_3d_path')
    else:
        return jsonify({"error": "Invalid kind"}), 400

    if not path or not os.path.exists(path):
        return jsonify({"error": "No artifact available"}), 404

    return send_file(path, as_attachment=True, download_name=os.path.basename(path))

@app.route('/structure/<job_id>/miRNA/<mirna_id>', methods=['GET'])
def get_structure_mirna(job_id, mirna_id):
    """Serve the uploaded miRNA structure file that best matches the given ID."""
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    art = job.get("artifacts") or {}
    if time.time() > float(art.get("expiry", 0)):
        return jsonify({"error": "Artifacts expired"}), 410
    idx = art.get('mirna_3d_index') or {}
    val = _lookup_3d(idx, mirna_id)
    if not val:
        return jsonify({"error": "No miRNA 3D file for this ID"}), 404
    _, __, p = val
    if not p or not os.path.exists(p):
        return jsonify({"error": "Artifact not found"}), 404
    return send_file(p, as_attachment=True, download_name=os.path.basename(p))


# =========================
# Contacts (miRNA↔Target / miRNA↔Competitor) for 3D overlay
# =========================
def _compute_contacts(path_a: str, path_b: str, cutoff: float = 4.0) -> Dict:
    """
    Fast contact heuristics using Bio.PDB NeighborSearch.
    Returns atoms pairs with distance and coarse type labels:
      - close (<= cutoff)
      - hbond_like (N/O pairs <= 3.5 Å)
      - salt_bridge_like (basic N vs phosphate O/P <= 4.0 Å)
      - pi_stacking_like (nucleobase centroid distance <= 4.5 Å)
    """
    try:
        from Bio.PDB import PDBParser, MMCIFParser, NeighborSearch, Selection
    except Exception as e:
        return {"error": "Biopython with Bio.PDB is required on the server", "detail": str(e)}

    def _load_atoms(p):
        parser = PDBParser(QUIET=True) if p.lower().endswith(".pdb") else MMCIFParser(QUIET=True)
        struct = parser.get_structure("s", p)
        atoms = [a for a in Selection.unfold_entities(struct, 'A') if a.element.strip()]
        return struct, atoms

    def _is_base_atom(atom):
        name = atom.get_name().upper()
        return name in {"C2","C4","C5","C6","C8","N1","N3","N7","N9","C5M"}

    def _res_serial(atom):
        res = atom.get_parent()
        ch = res.get_parent()
        r = res.get_id()[1] if isinstance(res.get_id(), tuple) else str(res.get_id())
        return {"chain": getattr(ch, "id", "?"), "resname": res.get_resname(), "resid": int(r) if isinstance(r, int) else r}

    struct_a, atoms_a = _load_atoms(path_a)
    struct_b, atoms_b = _load_atoms(path_b)

    ns = NeighborSearch(atoms_a + atoms_b)
    pairs = ns.search_all(cutoff)

    out = []
    hbonds = 0
    salts = 0
    for x, y in pairs:
        # ensure x from A, y from B (order)
        in_a = x in atoms_a
        in_b = y in atoms_b
        if not (in_a and in_b) and not (y in atoms_a and x in atoms_b):
            continue
        a1, a2 = (x, y) if (in_a and in_b) else (y, x)
        d = (a1.coord - a2.coord)
        dist = float(np.sqrt(np.dot(d, d)))

        # type inference
        n1 = a1.element.upper()
        n2 = a2.element.upper()
        nm1 = a1.get_name().upper()
        nm2 = a2.get_name().upper()
        rn1 = a1.get_parent().get_resname().upper()
        rn2 = a2.get_parent().get_resname().upper()

        ctype = "close"
        # H-bond like: N/O within 3.5 Å
        if (n1 in {"N","O"} and n2 in {"N","O"} and dist <= 3.5):
            ctype = "hbond_like"; hbonds += 1
        # Salt-bridge like: basic N (LYS/ARG/HIS) vs phosphate O/P in nucleic acid
        basic = (rn1 in {"LYS","ARG","HIS"} and n1 == "N") or (rn2 in {"LYS","ARG","HIS"} and n2 == "N")
        phosphate = (rn1 in {"A","U","G","C","T"} and (nm1.startswith("OP") or nm1 in {"O1P","O2P","O3*","P"})) or \
                    (rn2 in {"A","U","G","C","T"} and (nm2.startswith("OP") or nm2 in {"O1P","O2P","O3*","P"}))
        if basic and phosphate and dist <= 4.0:
            ctype = "salt_bridge_like"; salts += 1

        out.append({
            "a": {**_res_serial(a1), "atom": nm1, "element": n1},
            "b": {**_res_serial(a2), "atom": nm2, "element": n2},
            "distance": round(dist, 3),
            "type": ctype
        })

    # very coarse π-stacking heuristic (centroid distance of base heavy atoms)
    def _base_centroids(struct):
        cents = []
        for model in struct:
            for chain in model:
                for res in chain:
                    pts = [atom.coord for atom in res if _is_base_atom(atom)]
                    if len(pts) >= 4:
                        pts = np.array(pts, dtype=np.float32)
                        cents.append(pts.mean(axis=0))
        return cents

    cents_a = _base_centroids(struct_a)
    cents_b = _base_centroids(struct_b)
    pi_pairs = 0
    for ca in cents_a:
        for cb in cents_b:
            dist = float(np.linalg.norm(ca - cb))
            if dist <= 4.5:
                pi_pairs += 1

    return {
        "contacts": out,
        "summary": {
            "total": len(out),
            "hbond_like": hbonds,
            "salt_bridge_like": salts,
            "pi_stacking_like_pairs": pi_pairs
        }
    }

@app.route('/contacts/<job_id>/<mirna_id>', methods=['GET'])
def get_contacts(job_id, mirna_id):
    """
    Return contact map between miRNA structure and target/competitor.
    query:
      with=target|competitor (default=target)
      cutoff=4.0
    """
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Invalid job ID"}), 404
    art = job.get("artifacts") or {}
    if time.time() > float(art.get("expiry", 0)):
        return jsonify({"error": "Artifacts expired"}), 410

    idx = art.get('mirna_3d_index') or {}
    mval = _lookup_3d(idx, mirna_id)
    if not mval:
        return jsonify({"error": "No miRNA 3D available for this ID"}), 404
    _, __, mpath = mval
    if not mpath or not os.path.exists(mpath):
        return jsonify({"error": "miRNA artifact not found"}), 404

    target_kind = (request.args.get('with') or 'target').strip().lower()
    if target_kind not in {'target','competitor'}:
        return jsonify({"error": "Parameter 'with' must be target or competitor"}), 400

    if target_kind == 'target':
        tpath = art.get('target_3d_path')
    else:
        tpath = art.get('competitor_3d_path')

    if not tpath or not os.path.exists(tpath):
        return jsonify({"error": f"No {target_kind} 3D artifact available"}), 404

    try:
        cutoff = float(request.args.get('cutoff') or 4.0)
    except Exception:
        cutoff = 4.0

    result = _compute_contacts(mpath, tpath, cutoff=cutoff)
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 500

    return jsonify(result)


# =========================
# Janitor: clean expired artifacts
# =========================
_janitor_started = False
def start_janitor():
    global _janitor_started
    if _janitor_started:
        return
    _janitor_started = True

    def _run():
        while True:
            try:
                now = time.time()
                for jid, job in list(jobs.items()):
                    art = job.get("artifacts") or {}
                    exp = float(art.get("expiry", 0))
                    if exp and now > exp:
                        # try cleaning files
                        for key in ('target_3d_path','competitor_3d_path'):
                            p = art.get(key)
                            if p and os.path.exists(p):
                                try:
                                    os.unlink(p)
                                except Exception:
                                    pass
                        idx = art.get('mirna_3d_index') or {}
                        for _, (_, __, p) in idx.items():
                            if p and os.path.exists(p):
                                try:
                                    os.unlink(p)
                                except Exception:
                                    pass
                        # prevent re-clean
                        job["artifacts"]["expiry"] = 0
                time.sleep(120)
            except Exception:
                time.sleep(120)

    threading.Thread(target=_run, daemon=True).start()


# =========================
# Seed-scan endpoint (unchanged public API)
# =========================
@app.route('/seed_scan', methods=['POST'])
@limiter.limit("30 per 15 minutes")
def seed_scan():
    """
    JSON body:
    {
      "mirna_seq": "UGAGGUAGUAGGUUGUAUAGUU",
      "targets": {"target1": "ACGU..."},
      "competitors": {"comp1": "ACGU..."},
      "allow_gu": true,
      "max_mismatch": 0
    }
    Returns { "hits": [ {molecule, id, start, end, seed_len, seed_type, mismatches, wobble} ... ] }
    Coordinates are 1-based on the provided target/competitor sequences.
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        mirna = (data.get('mirna_seq') or '').strip()
        targets = data.get('targets') or {}
        competitors = data.get('competitors') or {}
        allow_gu = bool(data.get('allow_gu', True))
        max_mism = int(data.get('max_mismatch', 0))

        if not mirna or not targets:
            return jsonify({'error': 'Provide mirna_seq and at least one target'}), 400

        m = mirna.upper().replace('T','U')
        hits: List[Dict] = []

        # Prepare seeds: 2–8 (7 nt) and 2–7 (6 nt)
        seed_2_8 = m[1:8] if len(m) >= 8 else m[1:]
        seed_2_7 = m[1:7] if len(m) >= 7 else m[1:]
        seeds = [(seed_2_8, 7), (seed_2_7, 6)]
        seeds = [(s, L) for (s, L) in seeds if len(s) == L and L in (6,7)]

        # Scan function
        def scan_one(label: str, seq_map: Dict[str, str]):
            for sid, sseq in seq_map.items():
                t = (sseq or '').upper().replace('T','U')
                for seed, L in seeds:
                    if len(seed) < L:
                        continue
                    seed_rc = revcomp_rna(seed)
                    max_i = max(0, len(t) - len(seed_rc) + 1)
                    for i in range(0, max_i):
                        w = t[i:i+len(seed_rc)]
                        score = match_seed(seed_rc, w, allow_gu=allow_gu, max_mismatch=max_mism)
                        if score is None:
                            continue
                        stype = classify_seed(m, t, i, L)
                        hit = {
                            'molecule': label,
                            'id': sid,
                            'start': i + 1,
                            'end': i + len(seed_rc),
                            'seed_len': len(seed_rc),
                            'seed_type': stype,
                            **score
                        }
                        if i - 1 >= 0:
                            hit['upstream_base'] = t[i-1]
                        hits.append(hit)

        scan_one('target', targets)
        scan_one('competitor', competitors)
        return jsonify({'hits': hits})
    except Exception as e:
        logging.exception(f"/seed_scan error: {e}")
        return jsonify({'error': str(e)}), 500


# =========================
# Explain (Integrated Gradients) endpoint (unchanged public API)
# =========================
@app.route('/explain', methods=['POST'])
@limiter.limit("20 per 15 minutes")
def explain():
    """
    JSON body:
    {
      "mirna_seq": "UGAGGUAGUAGGUUGUAUAGUU",
      "target_seq": "ACGU...",
      "competitor_seq": "ACGU..."   # optional
    }
    Returns:
    {
      "target_attrib": [ ... per-position magnitude ... ],
      "competitor_attrib": [ ... ] | null
    }
    """
    try:
        if model is None or scaler is None:
            return jsonify({"error": "Model or scaler not loaded on server."}), 500

        data = request.get_json(force=True, silent=True) or {}
        mirna = (data.get('mirna_seq') or '').strip()
        target = (data.get('target_seq') or '').strip()
        competitor = (data.get('competitor_seq') or '').strip()

        if not mirna or not target:
            return jsonify({'error': 'Provide mirna_seq and target_seq'}), 400

        # Shapes & inputs that model expects
        model_inputs = {inp.name: inp.shape for inp in model.inputs}
        Lp = int(model_inputs.get('primary_sequence_input', [None, 120])[1])
        Lt = int(model_inputs.get('target_sequence_input', [None, 200])[1])
        Lc = int(model_inputs.get('competitor_sequence_input', [None, 200])[1])

        # Process through your processor to get features & structure vectors
        def ensure_dict(data):
            if isinstance(data, tuple):
                return {
                    "sequence": data[1] if len(data) > 1 else "",
                    "gc_content": 0.5, "dg": 0.0, "conservation": 0.0,
                    "structure_vector": "[]", "adjacency_matrix": "[]"
                }
            return data

        pdat = ensure_dict(process_molecule_universal((("miRNA", mirna), {}, 'primary_molecule')))
        tdat = ensure_dict(process_molecule_universal((("target", target), {}, 'target_molecule')))
        if competitor:
            cdat = ensure_dict(process_molecule_universal((("competitor", competitor), {}, 'competitor_molecule')))
        else:
            cdat = {'sequence': ''}

        # Optionally mature-trim primary for consistency with /predict
        pseq = pdat.get('sequence','')
        if MATURE_TRIM_ENABLED and len(pseq) > 30:
            pseq = choose_mature_window(pseq, window=MATURE_TRIM_WINDOW)

        # Encode sequences
        pri_enc = one_hot_encode_sequence(pseq, Lp)[None, ...]
        tgt_enc = one_hot_encode_sequence(tdat.get('sequence',''), Lt)[None, ...]
        if competitor:
            cmp_enc = one_hot_encode_sequence(cdat.get('sequence',''), Lc)[None, ...]
        else:
            cmp_enc = one_hot_encode_sequence('', Lc)[None, ...]

        # Numeric features (scaled) – using primary features for consistency
        num_list = [numerical_features_from_processed_json(pdat)]
        if hasattr(scaler, 'feature_names_in_'):
            df_features = pd.DataFrame(num_list, columns=scaler.feature_names_in_)
            scaled_num = scaler.transform(df_features)
        else:
            scaled_num = scaler.transform(num_list)

        feed = {
            'primary_sequence_input': pri_enc.astype(np.float32),
            'target_sequence_input':  tgt_enc.astype(np.float32),
            'competitor_sequence_input': cmp_enc.astype(np.float32),
            'numerical_features_input': scaled_num.astype(np.float32)
        }

        # Structure vectors (zeros fallback)
        if 'primary_structure_input' in model_inputs:
            feed['primary_structure_input'] = structure_vector_from_processed_json(pdat.get('structure_vector','[]'), Lp)[None, ...].astype(np.float32)
        if 'target_structure_input' in model_inputs:
            feed['target_structure_input'] = structure_vector_from_processed_json(tdat.get('structure_vector','[]'), Lt)[None, ...].astype(np.float32)
        if 'competitor_structure_input' in model_inputs:
            if competitor:
                feed['competitor_structure_input'] = structure_vector_from_processed_json(cdat.get('structure_vector','[]'), Lc)[None, ...].astype(np.float32)
            else:
                feed['competitor_structure_input'] = np.zeros((1, Lc, 1), dtype=np.float32)

        # Compute IG for target (+ competitor if present)
        tgt_attr = integrated_gradients(model, feed, 'target_sequence_input', steps=50)
        cmp_attr = integrated_gradients(model, feed, 'competitor_sequence_input', steps=50) if competitor else None

        return jsonify({
            'target_attrib': tgt_attr,
            'competitor_attrib': cmp_attr
        })
    except Exception as e:
        logging.exception(f"/explain error: {e}")
        return jsonify({'error': str(e)}), 500


# =========================
# Startup
# =========================
if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    # ensure janitor alive for artifact cleanup
    start_janitor()
    app.run(debug=True, host='0.0.0.0', port=port)
