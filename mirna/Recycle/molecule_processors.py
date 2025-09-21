# codes/processors.py (With Intelligent PDB Matching)
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


# ==============================
# CONFIGURATION LOADER
# ==============================
def load_config(config_path=None):
    """
    Loads the configuration from a JSON file.
    If no path is given, it automatically finds 'config.json' in the same directory as the script.
    """
    if config_path is None:
        script_dir = os.path.dirname(os.path.realpath(__file__))
        config_path = os.path.join(script_dir, 'config.json')
    
    #print(f"--- Loading configuration from: {config_path} ---")
    try:
        with open(config_path, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"FATAL: Configuration file not found at '{config_path}'.")
        exit()

# ==============================
# SEQUENCE EXTRACTION FROM STRUCTURE
# ==============================
def _get_sequence_from_pdb(pdb_path):
    """
    Extracts the sequence from a PDB or mmCIF file, handling both
    proteins and nucleic acids using Biopython's internal dictionaries.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", PDBExceptions.PDBConstructionWarning)
            file_ext = os.path.splitext(pdb_path)[1].lower()
            parser = MMCIFParser(QUIET=True) if file_ext == '.cif' else PDBParser(QUIET=True)
            structure = parser.get_structure("mol", pdb_path)
            
            sequences = []
            # Define standard nucleotide residue names
            nucleotide_map = {
                "A": "A", "DA": "A", "ADE": "A",
                "G": "G", "DG": "G", "GUA": "G",
                "C": "C", "DC": "C", "CYT": "C",
                "U": "U", "DU": "U", "URA": "U",
                "T": "T", "DT": "T", "THY": "T"
            }

            for model in structure:
                for chain in model:
                    chain_sequence = ''
                    for residue in chain.get_residues():
                        res_name = residue.get_resname().strip()
                        # Check if it's a standard nucleotide
                        if res_name in nucleotide_map:
                            chain_sequence += nucleotide_map[res_name]
                        # Else, check if it's a standard amino acid
                        elif res_name in aa3to1:
                            chain_sequence += aa3to1[res_name]
                    
                    if chain_sequence:
                        sequences.append(chain_sequence)
            
            return max(sequences, key=len) if sequences else ""
    except Exception: 
        return ""


# ==============================
# FEATURE CALCULATORS
# ==============================
def calculate_gc_content(sequence):
    """
    Calculates GC content of a nucleotide sequence.
    Returns 0.0 if the sequence is empty.
    """
    if not sequence:
        return 0.0
    return (sequence.upper().count('G') + sequence.upper().count('C')) / len(sequence)


def predict_rna_structure_1d(sequence):
    """
    Predicts RNA secondary structure (dot-bracket + dG value) using RNAfold.
    - Encodes dot-bracket into vector for downstream ML/GNN models.
    - Returns structure vector + free energy.
    - This version includes a CACHING mechanism to avoid re-calculating known sequences.
    """
    # Step 1: Check the cache first for a pre-computed result.
    if sequence in RNAFOLD_CACHE:
        return RNAFOLD_CACHE[sequence]

    # Step 2: If not in the cache, run the slow external process.
    config = load_config()
    rnafold_cmd = config.get('tool_paths', {}).get('rnafold') or 'RNAfold'
    # Default to None in case of failure
    calculated_result = None
    
    try:
        result = subprocess.run(
            [rnafold_cmd],
            input=sequence, text=True, capture_output=True, check=True,
            encoding='utf-8', timeout=60
        )
        output_lines = result.stdout.strip().split('\n')

        # RNAfold outputs: sequence, dot-bracket structure with energy
        if len(output_lines) >= 2:
            struct_line = output_lines[1]
            structure = struct_line.split(' ')[0]

            # Extract dG value from RNAfold output
            match = re.search(r"[-+]?\d+\.\d+", struct_line)
            dg = float(match.group(0)) if match else 0.0

            # Encode dot-bracket into numeric vector
            encoded_structure = [({'.': 0, '(': 1, ')': -1}).get(c, 0) for c in structure]

            # Store the successful result in our variable
            calculated_result = {'structure_vector': json.dumps(encoded_structure), 'dg': dg}

    except subprocess.CalledProcessError as e:
        print(f"  - WARNING: RNAfold failed for sequence. STDERR: {e.stderr}")
        # 'calculated_result' remains None

    # Step 3: Save the result to the cache before returning.
    # This caches both successful results and failures (None) to avoid re-trying bad sequences.
    RNAFOLD_CACHE[sequence] = calculated_result
    
    # Step 4: Return the result.
    return calculated_result


def _parse_dot_bracket_to_adjacency(dbn_structure):
    """
    Converts dot-bracket notation to adjacency matrix.
    - '(' and ')' represent paired bases.
    - Adds linear connections between consecutive residues.
    """
    seq_len = len(dbn_structure)
    adjacency_matrix = np.zeros((seq_len, seq_len), dtype=int)
    stack = []

    # Pairing edges
    for i, char in enumerate(dbn_structure):
        if char == '(':
            stack.append(i)
        elif char == ')':
            if stack:
                j = stack.pop()
                adjacency_matrix[i, j] = 1
                adjacency_matrix[j, i] = 1

    # Backbone connections
    for i in range(seq_len - 1):
        adjacency_matrix[i, i + 1] = 1
        adjacency_matrix[i + 1, i] = 1

    return adjacency_matrix


# ==============================
# GRAPH STRUCTURE PREDICTION
# ==============================
def predict_graph_structure(molecule_id, sequence, role):
    """
    Generates adjacency matrix for a molecule.
    Workflow:
    - If enabled, tries to match with existing PDB/mmCIF structure.
    - If found, runs DSSR (x3dna-dssr) to extract secondary structure.
    - If no PDB available, falls back to RNAfold.
    """
    config = load_config()

    # Only run if structure processing is enabled in config
    if not config.get('processing_parameters', {}).get('enable_pdb_processing', False):
        return None

    pdb_path = None
    role_key = role.replace('_molecule', '')

    # Locate folder containing structures
    pdb_folder_path = os.path.join(config.get('project_root', '.'), config.get('structure_folders', {}).get(role_key, ''))

    # Try direct matching: molecule_id.pdb or molecule_id.cif
    if os.path.isdir(pdb_folder_path):
        for ext in ['.pdb', '.cif']:
            potential_path = os.path.join(pdb_folder_path, f"{molecule_id}{ext}")
            if os.path.exists(potential_path):
                pdb_path = potential_path
                break

        # Try intelligent matching: check if sequence matches any PDB file
        if not pdb_path:
            for filename in os.listdir(pdb_folder_path):
                if filename.lower().endswith(('.pdb', '.cif')):
                    full_path = os.path.join(pdb_folder_path, filename)
                    pdb_seq = _get_sequence_from_pdb(full_path).upper()
                    if pdb_seq and pdb_seq == sequence.upper().replace('U', 'T'):
                        pdb_path = full_path
                        break

    # If PDB found, use DSSR for dot-bracket structure
    if pdb_path:
        dssr_cmd = config.get('tool_paths', {}).get('dssr') or 'x3dna-dssr'
        try:
            result = subprocess.run(
                [dssr_cmd, f'--input={pdb_path}'],
                capture_output=True, text=True, check=True, timeout=60
            )
            match = re.search(r'secondary structure in dot-bracket notation\s*\n\s*(\S+)', result.stdout)
            if match:
                return _parse_dot_bracket_to_adjacency(match.group(1))
        except subprocess.CalledProcessError as e:
            print(f"  - WARNING: DSSR failed for {molecule_id} ({pdb_path}). STDERR: {e.stderr}")

    # Fallback: Predict RNA secondary structure with RNAfold
    try:
        rnafold_cmd = config.get('tool_paths', {}).get('rnafold') or 'RNAfold'
        result = subprocess.run(
            [rnafold_cmd], input=sequence, text=True,
            capture_output=True, check=True, encoding='utf-8', timeout=300
        )
        if len(result.stdout.strip().split('\n')) >= 2:
            return _parse_dot_bracket_to_adjacency(result.stdout.strip().split('\n')[1].split(' ')[0])
    except subprocess.CalledProcessError as e:
        print(f"  - WARNING: RNAfold (fallback) failed for {molecule_id}. STDERR: {e.stderr}")

    return None


# ==============================
# CODON TABLE LOADING & TRANSLATION
# ==============================
def load_codon_table(table_path):
    """
    Loads codon usage table into a dictionary.
    - File format: codon, amino acid, frequency.
    - Normalizes frequencies into probabilities.
    """
    codon_map = {}
    try:
        with open(table_path, 'r') as f:
            for line in f:
                parts = re.findall(r'([A-Z]{3})\s+([A-Z\*])\s+([\d\.]+)', line)
                for codon, aa, freq in parts:
                    if aa not in codon_map:
                        codon_map[aa] = []
                    codon_map[aa].append({'codon': codon.replace('T', 'U'), 'freq': float(freq)})
    except FileNotFoundError:
        print(f"  - WARNING: Codon usage table not found at {table_path}. Reverse translation will fail.")
        return None

    # Normalize frequencies -> probabilities
    for aa, codons in codon_map.items():
        total_freq = sum(c['freq'] for c in codons)
        if total_freq > 0:
            for c in codons:
                c['prob'] = c['freq'] / total_freq
        else:
            for c in codons:
                c['prob'] = 1.0 / len(codons)
    return codon_map


def reverse_translate(aa_sequence, codon_map):
    """
    Reverse translates amino acid sequence into probable nucleotide sequence.
    - Uses codon usage probabilities for realism.
    """
    if not codon_map:
        return ""
    nt_sequence = []
    for aa in aa_sequence.upper():
        if aa in codon_map:
            codons = [c['codon'] for c in codon_map[aa]]
            probabilities = [c['prob'] for c in codon_map[aa]]
            chosen_codon = random.choices(codons, weights=probabilities, k=1)[0]
            nt_sequence.append(chosen_codon)
    return "".join(nt_sequence)


# ==============================
# SEQUENCE TYPE DETECTION
# ==============================
def detect_sequence_type(sequence):
    """
    Detects if a sequence is RNA or Protein.
    - Protein: contains amino acids beyond RNA alphabet.
    - RNA: only A,C,G,U,T,N present.
    """
    rna_alphabet = set("ACGTUN")
    protein_alphabet = set("LIVFWYMCAGPSTHRKQNDE")
    seq_set = set(sequence.upper())
    if not seq_set.issubset(rna_alphabet) and seq_set.intersection(protein_alphabet):
        return "protein"
    return "rna"


# ==============================
# MAIN UNIVERSAL PROCESSOR
# ==============================
def process_molecule_universal(args):
    """
    Unified processing pipeline for molecules.
    Steps:
    1. Detect sequence type (RNA vs Protein).
    2. For protein: reverse translate to nucleotide sequence.
    3. For RNA: standardize bases (replace T->U).
    4. Compute structural features (RNAfold).
    5. Compute graph structure (DSSR or RNAfold fallback).
    6. Return dictionary with features.
    """
    (molecule_id, sequence), params, role = args
    config = load_config()

    # Step 1: Detect type
    if detect_sequence_type(sequence) == "protein":
        codon_table_path = os.path.join(config.get('project_root', '.'), config.get('file_paths', {}).get('codon_table'))
        codon_map = load_codon_table(codon_table_path)
        nt_sequence = reverse_translate(sequence, codon_map)
        if not nt_sequence:
            return (molecule_id, "reject_reverse_translation")
    else:
        nt_sequence = sequence.replace('T', 'U')

    # Step 2: Structural features (RNAfold)
    structural_features_1d = predict_rna_structure_1d(nt_sequence)
    if structural_features_1d is None:
        return (molecule_id, "reject_structure_1d")

    # Step 3: Graph structure
    adjacency_matrix = predict_graph_structure(molecule_id, nt_sequence, role)
    if adjacency_matrix is None:
        adjacency_matrix = np.zeros((len(nt_sequence), len(nt_sequence)), dtype=int)

    # Final output dictionary
    return {
        'id': molecule_id,
        'original_sequence': sequence,
        'sequence': nt_sequence,
        'gc_content': calculate_gc_content(nt_sequence),
        **structural_features_1d,
        'adjacency_matrix': json.dumps(adjacency_matrix.tolist())
    }


# ==============================
# PROCESSOR MAP
# ==============================
PROCESSOR_MAP = {
    "miRNA": process_molecule_universal,
    "RNA": process_molecule_universal,
    "protein": process_molecule_universal,
}
