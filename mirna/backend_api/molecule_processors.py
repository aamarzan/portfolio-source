# codes/processors.py  — safe-updated (non-breaking)
# - Keeps original behavior and return schema EXACTLY:
#     { 'id', 'original_sequence', 'sequence', 'gc_content',
#       'structure_vector' (json), 'dg' (float), 'adjacency_matrix' (json) }
# - Adds:
#     * Robust config loading (optional env var override), cached
#     * RNAfold/DSSR caching (speed only; no logic change)
#     * Optional target-region slicing (OFF by default → no change)
#     * Optional smarter PDB matching modes (default 'exact' → no change)
#     * Safer parsers for RNAfold/DSSR outputs with graceful fallback
# - Leaves reverse translation for proteins ON (as before) to avoid drift.

RNAFOLD_CACHE = {}
DSSR_CACHE = {}

# --- Standard Library Imports ---
import os
import re
import json
import numpy as np
import subprocess
import random
import io
import warnings

# --- Biopython Imports ---
from Bio.PDB import PDBParser, MMCIFParser, PDBExceptions
from Bio.PDB.Polypeptide import protein_letters_3to1_extended as aa3to1

# --- Utils ---
from functools import lru_cache


# ==============================
# CONFIGURATION LOADER (safe)
# ==============================
@lru_cache(maxsize=1)
def load_config(config_path=None):
    """
    Loads configuration JSON.
    Default behavior unchanged: look for 'config.json' in this script's folder.
    Added (non-breaking):
      - ENV override via MIRNA_CONFIG (optional)
      - lru_cache for speed
    """
    # 1) Explicit arg wins
    if config_path is not None:
        path = config_path
    else:
        # 2) Optional env override
        env_path = os.getenv("MIRNA_CONFIG")
        if env_path and os.path.isfile(env_path):
            path = env_path
        else:
            # 3) Original fallback: same directory as this file
            script_dir = os.path.dirname(os.path.realpath(__file__))
            path = os.path.join(script_dir, 'config.json')

    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"FATAL: Configuration file not found at '{path}'.")
        exit()


# ==============================
# SEQUENCE FROM STRUCTURE
# ==============================
def _get_sequence_from_pdb(pdb_path):
    """
    Extracts the longest chain sequence from a PDB/mmCIF file.
    Supports nucleic acids (A,C,G,U/T) and amino acids (3-letter → 1-letter).
    Safe: returns '' on any parse error.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", PDBExceptions.PDBConstructionWarning)
            file_ext = os.path.splitext(pdb_path)[1].lower()
            parser = MMCIFParser(QUIET=True) if file_ext == '.cif' else PDBParser(QUIET=True)
            structure = parser.get_structure("mol", pdb_path)

            sequences = []
            nt_map = {
                "A": "A", "DA": "A", "ADE": "A",
                "G": "G", "DG": "G", "GUA": "G",
                "C": "C", "DC": "C", "CYT": "C",
                "U": "U", "DU": "U", "URA": "U",
                "T": "T", "DT": "T", "THY": "T"
            }

            for model in structure:
                for chain in model:
                    chain_seq = []
                    for residue in chain.get_residues():
                        res = residue.get_resname().strip()
                        if res in nt_map:            # nucleotide
                            chain_seq.append(nt_map[res])
                        elif res in aa3to1:          # amino acid
                            chain_seq.append(aa3to1[res])
                    if chain_seq:
                        sequences.append("".join(chain_seq))

            return max(sequences, key=len) if sequences else ""
    except Exception:
        return ""


# ==============================
# FEATURE CALCULATORS
# ==============================
def calculate_gc_content(sequence):
    """
    GC content of nucleotide sequence; safe on empty.
    """
    if not sequence:
        return 0.0
    s = sequence.upper()
    return (s.count('G') + s.count('C')) / len(s)


def _parse_rnafold_stdout(stdout):
    """
    Robustly parse RNAfold output.
    Expected formats include:
      line1: sequence
      line2: dot-bracket (...)  ( -12.30)
    Returns (dot_bracket, dG_float) or (None, None) on failure.
    """
    if not stdout:
        return None, None
    lines = [ln.strip() for ln in stdout.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return None, None

    struct_line = lines[1]
    # dot-bracket is the first contiguous non-space token
    dbn = struct_line.split()[0] if struct_line else None

    # dG typically in parentheses; fallback to first float
    m = re.search(r"\(([-+]?\d+(?:\.\d+)?)\)", struct_line)
    if not m:
        m = re.search(r"[-+]?\d+(?:\.\d+)?", struct_line)
    dg = float(m.group(1) if len(m.groups()) else m.group(0)) if m else None

    return (dbn if dbn else None), (dg if dg is not None else None)


def predict_rna_structure_1d(sequence):
    """
    Predict RNA secondary structure (dot-bracket) and dG using RNAfold.
    Non-breaking:
      - Uses global RNAFOLD_CACHE (speed only)
      - Parses more robustly but returns identical fields:
          {'structure_vector': json.dumps(list_of_ints), 'dg': float}
      - On failure, caches None (same as before).
    """
    # Cache first
    if sequence in RNAFOLD_CACHE:
        return RNAFOLD_CACHE[sequence]

    config = load_config()
    rnafold_cmd = config.get('tool_paths', {}).get('rnafold') or 'RNAfold'
    calculated_result = None

    try:
        proc = subprocess.run(
            [rnafold_cmd],
            input=sequence,
            text=True,
            capture_output=True,
            check=True,
            encoding='utf-8',
            timeout=60
        )
        dbn, dg = _parse_rnafold_stdout(proc.stdout)
        if dbn:
            # Encode '.','(',')' as 0,1,-1 (unchanged)
            mapping = {'.': 0, '(': 1, ')': -1}
            encoded = [mapping.get(c, 0) for c in dbn]
            calculated_result = {
                'structure_vector': json.dumps(encoded),
                'dg': float(dg) if dg is not None else 0.0
            }
    except subprocess.CalledProcessError as e:
        print(f"  - WARNING: RNAfold failed for sequence. STDERR: {e.stderr}")

    RNAFOLD_CACHE[sequence] = calculated_result
    return calculated_result


def _parse_dot_bracket_to_adjacency(dbn_structure):
    """
    Dot-bracket → adjacency matrix with pairing + backbone edges.
    """
    n = len(dbn_structure)
    A = np.zeros((n, n), dtype=int)
    stack = []

    for i, ch in enumerate(dbn_structure):
        if ch == '(':
            stack.append(i)
        elif ch == ')':
            if stack:
                j = stack.pop()
                A[i, j] = 1
                A[j, i] = 1

    for i in range(n - 1):
        A[i, i + 1] = 1
        A[i + 1, i] = 1

    return A


# ==============================
# GRAPH STRUCTURE PREDICTION
# ==============================
def _run_dssr_and_get_dbn(pdb_path):
    """
    Runs x3dna-dssr to obtain dot-bracket. Tries JSON mode first (safer),
    then falls back to legacy stdout parsing. Caches by pdb_path.
    """
    if pdb_path in DSSR_CACHE:
        return DSSR_CACHE[pdb_path]

    config = load_config()
    dssr_cmd = config.get('tool_paths', {}).get('dssr') or 'x3dna-dssr'
    dbn = None

    # Try JSON mode (best-effort; DSSR versions differ)
    try:
        proc_json = subprocess.run(
            [dssr_cmd, f'--input={pdb_path}', '--json'],
            capture_output=True, text=True, check=True, timeout=60
        )
        try:
            d = json.loads(proc_json.stdout)
            # Common locations (varies by DSSR version/build):
            #  - d.get('dbn') or d.get('dot-bracket') or inside 'summary'
            candidate = (
                d.get('dbn')
                or d.get('dot-bracket')
                or (d.get('summary', {}).get('dbn') if isinstance(d.get('summary'), dict) else None)
            )
            if isinstance(candidate, str) and candidate.strip():
                dbn = candidate.strip()
        except Exception:
            pass
    except subprocess.CalledProcessError as e:
        # Ignore; fall back to text parse
        pass

    # Fallback: parse text mode
    if dbn is None:
        try:
            proc = subprocess.run(
                [dssr_cmd, f'--input={pdb_path}'],
                capture_output=True, text=True, check=True, timeout=60
            )
            # Grep a DBN-like token (balanced parens / dots)
            # Original pattern kept for compatibility; plus a generic fallback.
            m = re.search(r'secondary structure in dot-bracket notation\s*\n\s*(\S+)', proc.stdout)
            if m:
                dbn = m.group(1).strip()
            else:
                # Generic DBN token fallback
                mm = re.search(r'[\.\(\)]+', proc.stdout)
                if mm:
                    dbn = mm.group(0).strip()
        except subprocess.CalledProcessError as e:
            print(f"  - WARNING: DSSR failed for {pdb_path}. STDERR: {e.stderr}")

    DSSR_CACHE[pdb_path] = dbn
    return dbn


def _maybe_slice_target(sequence, role):
    """
    Optional whole-target slicing (OFF by default).
    Applies only when:
      processing_parameters.focus_on_target_region == True AND role indicates target.
    """
    cfg = load_config()
    pp = cfg.get('processing_parameters', {}) or {}
    if not pp.get('focus_on_target_region', False):
        return sequence
    if role and str(role).lower().startswith('target'):
        sl = pp.get('target_region_slice') or []
        if isinstance(sl, (list, tuple)) and len(sl) == 2:
            start, end = int(sl[0]), int(sl[1])
            start = max(1, start)
            end = max(start, end)
            # 1-based inclusive slice
            s = sequence[(start - 1):end]
            # Guard against empty slice; if empty, fall back to full sequence
            return s if s else sequence
    return sequence


def _choose_pdb_for_sequence(molecule_id, sequence, role_key, cfg):
    """
    Original behavior:
      1) Look for exact filename match: <id>.pdb / <id>.cif
      2) If not found, attempt sequence-equality match against extracted PDB sequences.
    New (non-breaking):
      - Optional smarter strategy controlled by:
          cfg['processors']['pdb_match_strategy'] in {'exact','contains'}
        Default is 'exact' so previous behavior is preserved.
    """
    pdb_folder = os.path.join(cfg.get('project_root', '.'), cfg.get('structure_folders', {}).get(role_key, ''))
    if not os.path.isdir(pdb_folder):
        return None

    # Step 1: direct filename match
    for ext in ('.pdb', '.cif'):
        direct = os.path.join(pdb_folder, f"{molecule_id}{ext}")
        if os.path.exists(direct):
            return direct

    # Step 2: intelligent sequence match (default strict equality)
    strategy = (cfg.get('processors', {}) or {}).get('pdb_match_strategy', 'exact')
    seq_uT = sequence.upper().replace('U', 'T')  # original normalization
    try:
        for fname in os.listdir(pdb_folder):
            if not fname.lower().endswith(('.pdb', '.cif')):
                continue
            full = os.path.join(pdb_folder, fname)
            pdb_seq = _get_sequence_from_pdb(full).upper()
            if not pdb_seq:
                continue

            if strategy == 'contains':
                # Opt-in: allow subsequence match either way
                if seq_uT in pdb_seq or pdb_seq in seq_uT:
                    return full
            else:
                # Default: exact equality (unchanged)
                if pdb_seq == seq_uT:
                    return full
    except Exception:
        pass

    return None


def predict_graph_structure(molecule_id, sequence, role):
    """
    Builds adjacency matrix:
      1) If PDB/mmCIF found → DSSR to DBN; else
      2) RNAfold to DBN (fallback).
    Non-breaking:
      - Honors original enable_pdb_processing default
      - Adds DSSR caching + safer parsers
      - Optional target-region slicing (OFF by default)
    """
    cfg = load_config()

    # Respect original gate
    if not cfg.get('processing_parameters', {}).get('enable_pdb_processing', False):
        return None

    # Optional global slice for targets (kept OFF by default)
    seq_for_graph = _maybe_slice_target(sequence, role)

    # Determine role key ('target', 'competitor', etc.)
    role_key = str(role or '').replace('_molecule', '').strip() or 'target'

    # Prefer PDB if available
    pdb_path = _choose_pdb_for_sequence(molecule_id, seq_for_graph, role_key, cfg)

    # DSSR path
    if pdb_path:
        dbn = _run_dssr_and_get_dbn(pdb_path)
        if dbn:
            try:
                return _parse_dot_bracket_to_adjacency(dbn)
            except Exception:
                # Fall through to RNAfold fallback
                pass

    # RNAfold fallback (unchanged core logic)
    try:
        rnafold_cmd = cfg.get('tool_paths', {}).get('rnafold') or 'RNAfold'
        proc = subprocess.run(
            [rnafold_cmd],
            input=seq_for_graph,
            text=True,
            capture_output=True,
            check=True,
            encoding='utf-8',
            timeout=300
        )
        dbn, _dg = _parse_rnafold_stdout(proc.stdout)
        if dbn:
            return _parse_dot_bracket_to_adjacency(dbn)
    except subprocess.CalledProcessError as e:
        print(f"  - WARNING: RNAfold (fallback) failed for {molecule_id}. STDERR: {e.stderr}")

    return None


# ==============================
# CODON TABLE & REVERSE TRANSLATION
# ==============================
def load_codon_table(table_path):
    """
    Loads codon usage table; normalizes frequencies → probabilities.
    Safe: returns None if not found (handled upstream).
    """
    codon_map = {}
    try:
        with open(table_path, 'r', encoding='utf-8') as f:
            for line in f:
                parts = re.findall(r'([A-Z]{3})\s+([A-Z\*])\s+([\d\.]+)', line)
                for codon, aa, freq in parts:
                    codon = codon.replace('T', 'U')
                    codon_map.setdefault(aa, []).append({'codon': codon, 'freq': float(freq)})
    except FileNotFoundError:
        print(f"  - WARNING: Codon usage table not found at {table_path}. Reverse translation will fail.")
        return None

    for aa, codons in codon_map.items():
        total = sum(c['freq'] for c in codons)
        if total > 0:
            for c in codons:
                c['prob'] = c['freq'] / total
        else:
            # uniform fallback
            for c in codons:
                c['prob'] = 1.0 / max(1, len(codons))
    return codon_map


def reverse_translate(aa_sequence, codon_map):
    """
    Reverse translates AA → NT using usage probabilities.
    """
    if not codon_map or not aa_sequence:
        return ""
    out = []
    for aa in aa_sequence.upper():
        if aa in codon_map and codon_map[aa]:
            codons = [c['codon'] for c in codon_map[aa]]
            probs  = [c['prob']  for c in codon_map[aa]]
            out.append(random.choices(codons, weights=probs, k=1)[0])
        # unknown AA are skipped (unchanged from prior behavior)
    return "".join(out)


# ==============================
# SEQUENCE TYPE DETECTION
# ==============================
def detect_sequence_type(sequence):
    """
    Heuristic: if any AA-only letters present, treat as protein; else RNA.
    """
    rna_alphabet = set("ACGTUN")
    protein_alphabet = set("LIVFWYMCAGPSTHRKQNDE")
    s = set((sequence or "").upper())
    if not s.issubset(rna_alphabet) and s.intersection(protein_alphabet):
        return "protein"
    return "rna"


# ==============================
# MAIN UNIVERSAL PROCESSOR
# ==============================
def process_molecule_universal(args):
    """
    Unified processing pipeline (NON-BREAKING):
      1) Detect sequence type
      2) Protein → reverse translate (as before)
      3) RNA → replace T→U (as before)
      4) RNAfold secondary structure (cached)
      5) Graph adjacency via DSSR if PDB found, else RNAfold fallback
      6) Return dict with EXACT same keys as previous versions
    Rejection tuples are kept unchanged.
    """
    (molecule_id, sequence), params, role = args
    cfg = load_config()

    # ---- Step 1: Normalize inputs safely ----
    original_sequence = sequence
    seq = sequence or ""

    # ---- Step 2: Type & canonical nucleotides ----
    if detect_sequence_type(seq) == "protein":
        codon_table_path = os.path.join(cfg.get('project_root', '.'), cfg.get('file_paths', {}).get('codon_table', ''))
        codon_map = load_codon_table(codon_table_path)
        nt_sequence = reverse_translate(seq, codon_map)
        if not nt_sequence:
            return (molecule_id, "reject_reverse_translation")
    else:
        # Preserve original behavior: simple T→U; avoid other canonicalization to prevent drift
        nt_sequence = seq.replace('T', 'U')

    # ---- Step 3: 1D structure (RNAfold) ----
    structural_features_1d = predict_rna_structure_1d(nt_sequence)
    if structural_features_1d is None:
        return (molecule_id, "reject_structure_1d")

    # ---- Step 4: Graph (DSSR → DBN → adjacency) with safe fallbacks ----
    adjacency_matrix = predict_graph_structure(molecule_id, nt_sequence, role)
    if adjacency_matrix is None:
        # Maintain exact previous fallback: zeros of len x len
        adjacency_matrix = np.zeros((len(nt_sequence), len(nt_sequence)), dtype=int)

    # ---- Step 5: Return EXACT schema ----
    return {
        'id': molecule_id,
        'original_sequence': original_sequence,
        'sequence': nt_sequence,
        'gc_content': calculate_gc_content(nt_sequence),
        **structural_features_1d,
        'adjacency_matrix': json.dumps(adjacency_matrix.tolist())
    }


# ==============================
# PROCESSOR MAP (unchanged)
# ==============================
PROCESSOR_MAP = {
    "miRNA": process_molecule_universal,
    "RNA": process_molecule_universal,
    "protein": process_molecule_universal,
}
