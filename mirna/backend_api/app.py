# app.py (fully updated, consolidated ~800+ lines)

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
USE_NONCE = True  # set True once frontend is updated to use /nonce
MIRNA_MAX = int(os.getenv("MIRNA_MAX", "5000"))
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "12"))
MATURE_TRIM_ENABLED = True           # default: enable auto-trim
MATURE_TRIM_WINDOW = int(os.getenv("MATURE_TRIM_WINDOW", "22"))
AA_CONVERT_ALLOWED = True           # default: reject AA unless frontend opts-in
STRUCTURE_MISMATCH_TOL = 0.10        # 10% mismatch tolerance in alignment
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
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_MB * 1024 * 1024  # 100 MB default

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
      
    # Inputs  — multi-target / multi-competitor aware (backward compatible)
    fasta_string = request.form.get('primary_molecules', '')

    # NEW (multi): prefer multi-field if provided, else fall back to legacy single fields
    targets_fasta = (request.form.get('targets_fasta', '') or '').strip()
    target_seq_text = (request.form.get('target_molecule', '') or '').strip()

    competitors_fasta = (request.form.get('competitors_fasta', '') or '').strip()
    competitor_seq_text = (request.form.get('competitor_molecule', '') or '').strip()

    # Flags
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

    # -------- Targets (multi) --------
    if targets_fasta:
        target_records = parse_fasta_records(targets_fasta)
    else:
        # backward-compatible: allow single target field
        tparsed = parse_fasta_records(target_seq_text)
        if len(tparsed) == 0:
            return jsonify({"error": "Please provide at least one target sequence (FASTA or raw)."}), 400
        target_records = tparsed

    # Optional range (applies only when there is exactly one target)
    target_start_raw = request.form.get('target_start', '').strip()
    target_end_raw = request.form.get('target_end', '').strip()
    def _to_int_safe(s):
        try: return int(s)
        except Exception: return None
    ts = _to_int_safe(target_start_raw); te = _to_int_safe(target_end_raw)
    if len(target_records) == 1 and (ts is not None or te is not None):
        tid, tseq = target_records[0]
        if ts is None or te is None or ts <= 0 or te <= 0 or ts > te or te > len(tseq):
            return jsonify({"error": "Invalid target range. Use 1-based inclusive indices within the target length."}), 400
        # slice (convert to 0-based)
        target_records = [(f"{tid}:{ts}-{te}", tseq[ts-1:te])]

    # -------- Competitors (multi; optional) --------
    if competitors_fasta:
        competitor_records = parse_fasta_records(competitors_fasta)
    else:
        # backward-compatible: allow single competitor field (may be empty)
        cparsed = parse_fasta_records(competitor_seq_text) if competitor_seq_text else []
        competitor_records = cparsed

    # If no competitors supplied at all, we’ll still return baseline-only rows
    comp_nonempty = [(cid, cseq) for (cid, cseq) in competitor_records if (cseq or '').strip()]
    has_any_competitor = len(comp_nonempty) > 0

    # ---- Optional 3D uploads (same as before)
    tmp_paths_to_cleanup: List[str] = []
    files = request.files

    def _save_optional(fs_key: str) -> Optional[str]:
        f = files.get(fs_key)
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

    # Job bookkeeping
    job_id = str(uuid.uuid4())
    total_pairs = len(primary_records) * len(target_records) * (len(comp_nonempty) if has_any_competitor else 1)
    jobs[job_id] = {
        "status": "running",
        "results": [],
        "error": None,
        "total": total_pairs,
        "completed": 0,
        # store a quick summary for UI if you want
        "target_count": len(target_records),
        "competitor_count": len(comp_nonempty)
    }

    send_ga_event("prediction_started", {"mirnas": len(primary_records), "targets": len(target_records), "competitors": len(comp_nonempty)})

    threading.Thread(
        target=process_job,
        args=(
            job_id, primary_records, target_records, comp_nonempty,
            target_3d_path, competitor_3d_path,
            mirna_3d_index, tmp_paths_to_cleanup,
            convert_aa_to_nt_flag, mature_trim_flag
        ),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id, "status": "started"})

def process_job(job_id: str,
                primary_records: List[Tuple[str, str]],
                target_records: List[Tuple[str, str]],
                competitor_records: List[Tuple[str, str]],
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

        # Helpers
        def ensure_dict(data):
            if isinstance(data, tuple):
                return {
                    "sequence": data[1] if len(data) > 1 else "",
                    "gc_content": 0.5,
                    "dg": 0.0,
                    "conservation": 0.0,
                    "structure_vector": "[]",
                    "adjacency_matrix": "[]"
                }
            return data

        # Model input shapes
        model_inputs = {inp.name: inp.shape for inp in model.inputs}
        max_primary_len   = model_inputs['primary_sequence_input'][1]
        max_target_len    = model_inputs['target_sequence_input'][1]
        max_competitor_len= model_inputs['competitor_sequence_input'][1]

        # Pre-read any 3D structural vectors ONCE (global files only).
        # If multiple targets/competitors are supplied, we only use these when sensible.
        target_struct_input_global = extract_structure_vector_from_file(target_3d_path, max_target_len) if target_3d_path else None
        competitor_struct_input_global = extract_structure_vector_from_file(competitor_3d_path, max_competitor_len) if competitor_3d_path else None

        # Cache processed targets
        target_cache = []
        for (tid, tseq) in target_records:
            tproc = ensure_dict(process_molecule_universal(((tid, tseq), {}, 'target_molecule')))
            t_enc = one_hot_encode_sequence(tproc.get('sequence', ''), max_target_len)
            # prefer JSON-provided structure if available; else fall back to global; else None
            t_struct = structure_vector_from_processed_json(tproc.get('structure_vector', '[]'), max_target_len)
            target_cache.append({
                "id": tid, "seq": tproc.get('sequence', ''),
                "enc": t_enc,
                "struct": t_struct if t_struct is not None else target_struct_input_global
            })

        # Cache processed competitors (may be empty list)
        competitor_cache = []
        for (cid, cseq) in competitor_records:
            cproc = ensure_dict(process_molecule_universal(((cid, cseq), {}, 'competitor_molecule')))
            c_enc = one_hot_encode_sequence(cproc.get('sequence', ''), max_competitor_len)
            c_struct = structure_vector_from_processed_json(cproc.get('structure_vector', '[]'), max_competitor_len)
            competitor_cache.append({
                "id": cid, "seq": cproc.get('sequence', ''),
                "enc": c_enc,
                "struct": c_struct if c_struct is not None else competitor_struct_input_global
            })

        # Empty competitor encoding for “no competitor / baseline”
        empty_comp_enc = one_hot_encode_sequence('', max_competitor_len)

        # Prepare miRNA batches once (trim, encode, features, optional 3D)
        def iter_batches(records, batch_size=BATCH_SIZE):
            for i in range(0, len(records), batch_size):
                yield records[i:i + batch_size]

        for tgt in target_cache:
            target_seq_enc = tgt["enc"]
            target_struct_input = tgt["struct"]

            # ---- baseline once per target (no competitor) ----
            baseline_lookup = {}  # (mirna_id) -> baseline score for this target

            for batch_records in iter_batches(primary_records):
                prim_seq_list, prim_struct_list, num_feat_list = [], [], []

                for (pri_id, pri_seq_raw) in batch_records:
                    pri_seq = trim_mature(pri_seq_raw, window=MATURE_TRIM_WINDOW) if mature_trim_flag else pri_seq_raw
                    pri_seq_enc = one_hot_encode_sequence(pri_seq, max_primary_len)
                    prim_seq_list.append(pri_seq_enc)

                    # optional 3D per-miRNA by filename stem
                    stem = pri_id.split()[0].split('|')[0].split(':')[0]
                    m3d = mirna_3d_index.get(stem)
                    if m3d and m3d[1]:
                        prim_struct_list.append(_seq_to_struct_column(m3d[1], max_primary_len))
                    else:
                        prim_struct_list.append(np.zeros((max_primary_len, 1), dtype=np.float32))

                    num_feat_list.append(to_numeric_features(pri_seq, tgt["seq"]))

                # scale numeric
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
                    common_inputs['primary_structure_input'] = np.stack(prim_struct_list)
                if 'target_structure_input' in model_inputs and target_struct_input is not None:
                    common_inputs['target_structure_input'] = np.repeat(target_struct_input[np.newaxis, ...], batch_size, axis=0)

                # Predict baseline
                no_comp = dict(common_inputs)
                no_comp['competitor_sequence_input'] = np.repeat(empty_comp_enc[np.newaxis, ...], batch_size, axis=0)
                preds_no = model.predict(no_comp, verbose=0).reshape(-1)
                pred_no_sq = np.square(preds_no)

                for (pri_id, _), p_base in zip(batch_records, pred_no_sq):
                    baseline_lookup[pri_id] = float(p_base)

            # ---- for each competitor, predict with competitor & emit rows ----
            if competitor_cache:
                for comp in competitor_cache:
                    comp_seq_enc = comp["enc"]
                    competitor_struct_input = comp["struct"]

                    for batch_records in iter_batches(primary_records):
                        prim_seq_list, prim_struct_list, num_feat_list = [], [], []

                        for (pri_id, pri_seq_raw) in batch_records:
                            pri_seq = trim_mature(pri_seq_raw, window=MATURE_TRIM_WINDOW) if mature_trim_flag else pri_seq_raw
                            pri_seq_enc = one_hot_encode_sequence(pri_seq, max_primary_len)
                            prim_seq_list.append(pri_seq_enc)

                            stem = pri_id.split()[0].split('|')[0].split(':')[0]
                            m3d = mirna_3d_index.get(stem)
                            if m3d and m3d[1]:
                                prim_struct_list.append(_seq_to_struct_column(m3d[1], max_primary_len))
                            else:
                                prim_struct_list.append(np.zeros((max_primary_len, 1), dtype=np.float32))

                            num_feat_list.append(to_numeric_features(pri_seq, tgt["seq"]))

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
                            common_inputs['primary_structure_input'] = np.stack(prim_struct_list)
                        if 'target_structure_input' in model_inputs and target_struct_input is not None:
                            common_inputs['target_structure_input'] = np.repeat(target_struct_input[np.newaxis, ...], batch_size, axis=0)
                        if 'competitor_structure_input' in model_inputs and competitor_struct_input is not None:
                            common_inputs['competitor_structure_input'] = np.repeat(competitor_struct_input[np.newaxis, ...], batch_size, axis=0)

                        with_comp = dict(common_inputs)
                        with_comp['competitor_sequence_input'] = np.repeat(comp_seq_enc[np.newaxis, ...], batch_size, axis=0)

                        preds_with = model.predict(with_comp, verbose=0).reshape(-1)
                        pred_with_sq = np.square(preds_with)

                        for (pri_id, _), p_with in zip(batch_records, pred_with_sq):
                            p_base = baseline_lookup.get(pri_id, None)
                            if p_base is None:
                                continue
                            jobs[job_id]["results"].append({
                                'primary_molecule_id': pri_id,
                                'mirna_id': pri_id,
                                'target_id': tgt["id"],
                                'competitor_id': comp["id"],
                                'predicted_affinity_baseline': f"{p_base:.10f}",
                                'predicted_affinity_with_competitor': f"{float(p_with):.10f}",
                                'competitive_effect (higher_is_better)': f"{float(p_base - p_with):.10f}",
                            })
                            jobs[job_id]["completed"] += 1
            else:
                # No competitors provided: return baseline-only rows (one per miRNA-target)
                for pri_id, _ in primary_records:
                    p_base = baseline_lookup.get(pri_id, None)
                    if p_base is None:
                        continue
                    jobs[job_id]["results"].append({
                        'primary_molecule_id': pri_id,
                        'mirna_id': pri_id,
                        'target_id': tgt["id"],
                        'competitor_id': "",
                        'predicted_affinity_baseline': f"{p_base:.10f}",
                        'predicted_affinity_with_competitor': f"{p_base:.10f}",
                        'competitive_effect (higher_is_better)': f"{0.0:.10f}",
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
            try: os.unlink(p)
            except Exception: pass

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
  # Optionally sort here by baseline so frontend can skip sorting if needed
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
  