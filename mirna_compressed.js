let predictionResults = [];
let CURRENT_JOB_ID = null;
let CONFIG = { mirna_max: 5000, mature_trim_enabled: true, mature_window: 22, aa_convert_allowed: true, use_nonce: false };
let batch_records = [];
let trimmed_sequences = {};
let prim_seq_list = [];
let num_feat_list = [];
let prim_struct_list = [];
const CURRENT_INPUTS = { mirnas: {}, targets: {}, competitors: {} };
let LAST_SEED_HITS = null;
let LAST_SEED_META = null;
let RUN_MANIFEST = null;
const GUARDS = {
  advancedInjected: false,
  fastaTipsInjected: false,
  tabWiringDone: false,
  formBindingDone: false,
  analysisControlsWired: false,
  modalInjected: false,
  styleInjected: false,
  nglLoaded: false,
  analysisControlsInjected: false,
  stickyShimWired: false
};
const LOCAL_BASE = "http://127.0.0.1:8080";
const PROD_BASE = "https://mirna.aamarzan.com";
const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const BASE_URL = isLocal ? LOCAL_BASE : PROD_BASE;
const API_URL = `${BASE_URL}/predict`;
const PRECHECK_URL = `${BASE_URL}/precheck`;
const PROGRESS_URL = (jobId) => `${BASE_URL}/progress/${jobId}`;
const DOWNLOAD_URL = (jobId) => `${BASE_URL}/download/${jobId}`;
const DOWNLOAD_ALL_CSV_URL = (jobId) => `${BASE_URL}/download/${jobId}/all.csv`;
const DOWNLOAD_ROW_CSV_URL = (jobId, interactionId) => `${BASE_URL}/download/${jobId}/${interactionId}.csv`;
const HEATMAP_PNG_URL = (jobId, interactionId, mode, steps) => `${BASE_URL}/download/${jobId}/${interactionId}/heatmap.png?mode=${encodeURIComponent(mode)}&steps=${encodeURIComponent(steps)}`;
const STRUCTURE_URL = (jobId, kind) => `${BASE_URL}/structure/${jobId}/${kind}`;
const NONCE_URL = `${BASE_URL}/nonce`;
const CONFIG_URL = `${BASE_URL}/config`;
const SEED_SCAN_URL = `${BASE_URL}/seed_scan`;
const EXPLAIN_URL = `${BASE_URL}/explain`;
const MAX_FILE_SIZE_MB = 100;

function inferExtFromResponse(res) {
  const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
  const dispo = (res.headers.get("Content-Disposition") || "").toLowerCase();
  if (/cif|mmcif/.test(ctype) || /\.mm?cif\b/.test(dispo)) return "cif";
  if (/pdb|x-pdb|ent/.test(ctype) || /\.pdb\b/.test(dispo)) return "pdb";
  return "pdb";
}

if (data.status === "error") {
  hide(loader);
  setHTML(resultsContainer, formatError(data.error || "An unexpected error occurred during prediction."));
  return;
}

function $(id) { return document.getElementById(id); }
function byQS(sel, scope = document) { return scope.querySelector(sel); }
function byQSA(sel, scope = document) { return Array.from(scope.querySelectorAll(sel)); }
function setHTML(el, html) { if (el) el.innerHTML = html; }
function appendHTML(el, html) { if (el) el.insertAdjacentHTML("beforeend", html); }
function prependHTML(el, html) { if (el) el.insertAdjacentHTML("afterbegin", html); }
function show(el) { if (el) el.classList.remove("hidden"); }
function hide(el) { if (el) el.classList.add("hidden"); }
function text(el, t) { if (el) el.textContent = t; }
function getFirstExistingElement(ids) { for (const id of ids) { const el = document.getElementById(id); if (el) return el; } return null; }
function getTextValuePossible(ids) { const el = getFirstExistingElement(ids); return el && typeof el.value === "string" ? el.value.trim() : ""; }
function safeParseFloat(x, d = 0) { const v = parseFloat(x); return Number.isFinite(v) ? v : d; }
function escapeHTML(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function formatError(msg) { return `<p style="color:#c22;margin:8px 0;">${escapeHTML(msg)}</p>`; }
function formatWarn(msg) { return `<p style="color:#b36b00;margin:8px 0;">${escapeHTML(msg)}</p>`; }
function formatInfo(msg) { return `<p class="info-note">${escapeHTML(msg)}</p>`; }

function openModalText(title, textMessage, toolbarHTML = "") {
  ensureModal();
  const modal = $("analysis-modal");
  if (!modal) return;
  text($("modal-title"), title || "Message");
  const mc = $("modal-content");
  mc.textContent = textMessage || "";
  setHTML($("modal-tools"), toolbarHTML || "");
  modal.style.display = "flex";
}

function validateFileSize(file) {
  if (file && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    alert(`File "${file.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
    return false;
  }
  return true;
}

function bindFileToTextarea(fileInputId, textareaId) {
  const fileInput = $(fileInputId);
  const textarea = $(textareaId);
  if (!fileInput || !textarea) return;
  const clone = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(clone, fileInput);
  clone.addEventListener("change", function () {
    const file = this.files && this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { textarea.value = e.target.result; };
    reader.readAsText(file);
  });
}

function countFastaRecords(seqText) {
  if (!seqText) return 0;
  const lines = seqText.trim().split(/\r?\n/);
  let count = 0;
  for (const line of lines) { if (line.trim().startsWith(">")) count++; }
  if (count === 0 && seqText.trim().length > 0) count = 1;
  return count;
}

function getTabbarHeight() {
  const t = getTabsBarEl();
  return t ? Math.round(t.getBoundingClientRect().height) : 0;
}

function hasFastaHeaders(text) {
  if (!text || !text.trim()) return false;
  return text.split(/\r?\n/).some(line => line.trim().startsWith(">"));
}

function ensureSingleton(id, html, parent) {
  if (!parent) return null;
  let el = $(id);
  if (el) return el;
  const holder = document.createElement("div");
  holder.innerHTML = html.trim();
  const created = holder.firstElementChild;
  if (created) parent.appendChild(created);
  return created;
}

function injectPremiumStyles() {
  if (GUARDS.styleInjected) return;
  const css = `
:root{--sticky-gap:12px;}nav.is-sticky-gap,header.is-sticky-gap{top:0!important;}
.btn-premium{padding:10px 14px;min-height:42px;min-width:130px;border-radius:12px;border:1px solid #d9d9e3;background:linear-gradient(180deg,#ffffff,#f6f7fb);font-weight:600;letter-spacing:.2px;box-shadow:0 1px 1px rgba(0,0,0,.04),0 8px 20px rgba(17,24,39,.06);transition:.15s transform ease,.2s box-shadow ease;}
.btn-premium:hover{transform:translateY(-1px);box-shadow:0 10px 24px rgba(17,24,39,.09);}
.btn-action{min-width:128px;min-height:40px;padding:9px 12px;border-radius:10px;font-weight:600;border:1px solid #d8dee9;background:linear-gradient(180deg,#fff,#f8fafc);}
.btn-accent{background:#0ea5e9;color:#fff;border:1px solid #0284c7;}
.chip{display:inline-block;padding:2px 8px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc;color:#334155;font-size:12px;margin-left:6px;}
#tabs-anchor{scroll-margin-top:calc(var(--sticky-offset-main) + var(--sticky-gap));}
table#results-table thead th{position:static;top:0;background:#fff;z-index:1;text-align:center;}
table#results-table tbody tr:hover{filter:brightness(.98);}
.toolbar-btn{min-height:32px;padding:6px 10px;border-radius:8px;border:1px solid #d8dee9;background:#fff;font-weight:600;}
.info-note{text-align:center;margin:8px 0;}
.reload-warning{text-align:center;margin:8px 0;}
.precheck-table{width:100%;border-collapse:collapse;margin:6px 0;}
.precheck-table th,.precheck-table td{border-bottom:1px solid #e5e7eb;padding:6px 8px;text-align:left;font-size:13px;}
.is-sticky-gap{top:calc(var(--sticky-offset-main) + var(--sticky-gap))!important;}
input[type="file"].file-premium{font-size:13px;border-radius:999px;border:1px solid #c4ddf9;padding:3px;background:transparent;cursor:pointer;}
input[type="file"].file-premium::-webkit-file-upload-button,input[type="file"].file-premium::file-selector-button{padding:7px 14px;border-radius:999px;border:1px solid #93c5fd;background:linear-gradient(135deg,#e0f2ff,#bae6fd);color:#0f172a;font-weight:500;letter-spacing:.15px;box-shadow:0 1px 4px rgba(15,23,42,.18);cursor:pointer;background-size:100% 100%;transition:.12s transform ease,.18s box-shadow ease,.18s background-color ease;}
input[type="file"].file-premium:hover::-webkit-file-upload-button,input[type="file"].file-premium:hover::file-selector-button{background:linear-gradient(135deg,#dbeafe,#bfdbfe);box-shadow:0 3px 8px rgba(15,23,42,.22);transform:translateY(-.5px);}
input[type="file"].file-premium:active::-webkit-file-upload-button,input[type="file"].file-premium:active::file-selector-button{transform:translateY(0);box-shadow:0 1px 4px rgba(15,23,42,.18);}
.fasta-file-shell{display:flex;align-items:stretch;flex-wrap:nowrap;padding:3px 8px;border-radius:12px;border:1px solid #c4ddf9;background:#fff;width:100%;box-sizing:border-box;min-height:40px;}
.fasta-file-shell input[type="file"].file-premium{border:none;padding:0;box-shadow:none;}
.fasta-file-shell .fasta-clear-btn{display:flex;align-items:center;height:100%;}
.fasta-clear-btn{display:inline-flex;align-items:center;min-height:35px;padding:3px 12px;margin-left:auto;border-radius:999px;border:1px solid #93c5fd;background:linear-gradient(135deg,#e0f2ff,#bae6fd);font-size:12px;font-weight:500;color:#0f172a;cursor:pointer;box-shadow:0 1px 4px rgba(15,23,42,.18);transition:.15s background-color ease,.15s border-color ease,.15s color ease,.12s transform ease;}
.fasta-clear-btn:hover{background:linear-gradient(135deg,#dbeafe,#bfdbfe);border-color:#93c5fd;color:#0f172a;transform:translateY(-.5px);}
.fasta-clear-btn:active{transform:translateY(0);box-shadow:0 1px 4px rgba(15,23,42,.18);}
#advanced-flags-wrapper{margin-top:8px;}
#advanced-flags-wrapper>div{background:linear-gradient(135deg,#f0fdf4,#ecfeff);border-radius:10px;padding:10px 12px;box-shadow:0 1px 1px rgba(15,23,42,.04),0 8px 20px rgba(15,23,42,.06);}
#advanced-flags-wrapper label{display:flex;gap:8px;align-items:center;cursor:pointer;font-size:14px;color:#111827;}
#advanced-tab input[type="checkbox"]{-webkit-appearance:none;appearance:none;width:18px;height:18px;border-radius:6px;border:1px solid #a7f3d0;background:linear-gradient(135deg,#ecfdf3,#d1fae5);position:relative;outline:none;cursor:pointer;box-shadow:0 1px 3px rgba(16,185,129,.25);transition:background .18s ease,border-color .18s ease,box-shadow .18s ease,transform .12s ease;}
#advanced-tab input[type="checkbox"]:hover{transform:translateY(-.5px);box-shadow:0 4px 10px rgba(16,185,129,.35);border-color:#6ee7b7;}
#advanced-tab input[type="checkbox"]:checked{background:linear-gradient(135deg,#22c55e,#0ea5e9);border-color:#22c55e;box-shadow:0 0 0 1px rgba(255,255,255,.45) inset,0 7px 16px rgba(14,165,233,.55);}
#advanced-tab input[type="checkbox"]::after{content:'';position:absolute;inset:3px 4px 4px 4px;border-radius:4px;border:2px solid #fff;border-top:none;border-left:none;opacity:0;transform:scale(.5) rotate(10deg);transition:opacity .16s ease,transform .16s ease;}
#advanced-tab input[type="checkbox"]:checked::after{opacity:1;transform:scale(.9) rotate(45deg);}
#advanced-tab input[type="checkbox"]:disabled{cursor:not-allowed;opacity:.55;box-shadow:none;}
#advanced-tab select#aa-nt-mode{border-radius:8px;border:1px solid #a7f3d0;padding:4px 26px 4px 10px;font-size:13px;font-weight:500;background:linear-gradient(135deg,#f0fdf4,#ecfeff);box-shadow:0 1px 3px rgba(199,243,228,1);}
#advanced-tab select#aa-nt-mode:focus{outline:none;border-color:#22c55e;box-shadow:0 0 0 1px rgba(202,236,214,1);}
#advanced-tab select#aa-nt-mode:disabled{opacity:.6;cursor:not-allowed;box-shadow:none;}
`;
  const style = document.createElement("style");
  style.id = "mirna-js-style";
  style.textContent = css;
  document.head.appendChild(style);
  GUARDS.styleInjected = true;
}

window.addEventListener("load", () => {
  document.querySelectorAll(".fasta-clear-btn").forEach(btn => {
    const fileInput = btn.previousElementSibling;
    if (!fileInput || !fileInput.classList.contains("file-premium")) return;
    if (btn.parentElement && btn.parentElement.classList.contains("fasta-file-shell")) return;
    const shell = document.createElement("span");
    shell.className = "fasta-file-shell";
    fileInput.parentNode.insertBefore(shell, fileInput);
    shell.appendChild(fileInput);
    shell.appendChild(btn);
  });
});

function targetIdFromButton(btn) {
  if (!btn) return null;
  const byAttr = btn.getAttribute("data-target") || btn.dataset?.target || btn.getAttribute("aria-controls");
  if (byAttr && document.getElementById(byAttr)) return byAttr;
  const href = btn.getAttribute("href");
  if (href && href.startsWith("#") && document.getElementById(href.slice(1))) return href.slice(1);
  const label = (btn.textContent || "").toLowerCase().trim();
  if (/^work(\s*flow)?$/.test(label)) return "workflow-tab";
  if (/^inputs?$/.test(label)) return "inputs-tab";
  if (/advanced/.test(label)) return "advanced-tab";
  if (/results?/.test(label)) return "results-tab";
  return null;
}

function smallSpinner(text = "Working...") {
  return `<div style="text-align:center;padding:10px 0;"><span class="loader-spinner"></span><span style="vertical-align:middle;">${escapeHTML(text)}</span></div>`;
}

function fetchWithTimeout(url, options = {}, ms = 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function fetchRetry(url, options = {}, ms = 30000, retries = 2, backoffMs = 600) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, ms);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr;
}

async function fetchJSONWithTimeout(url, opts = {}, ms = 60000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function parseFastaToMap(text, defaultPrefix = "seq") {
  const map = {};
  if (!text || !text.trim()) return map;
  const hasHeader = hasFastaHeaders(text);
  if (!hasHeader) {
    map[`${defaultPrefix}_1`] = text.replace(/^>.*$/gm, "").replace(/\s+/g, "").toUpperCase();
    return map;
  }
  let curId = null;
  let curSeq = [];
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    if (ln.trim().startsWith(">")) {
      if (curId) map[curId] = curSeq.join("").toUpperCase();
      curId = ln.replace(/^>/, "").trim() || `${defaultPrefix}_${Object.keys(map).length + 1}`;
      curSeq = [];
    } else curSeq.push(ln.trim());
  }
  if (curId) map[curId] = curSeq.join("").toUpperCase();
  return map;
}

function idVariants(s) {
  if (!s) return [];
  const t = String(s).trim();
  const slug = t.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_\-\.]/g, "");
  const set = new Set([
    t,
    t.replace(/\s+/g, "_"),
    t.replace(/\s+/g, ""),
    slug,
    slug.replace(/_/g, " "),
    t.toLowerCase(),
    t.replace(/\s+/g, "_").toLowerCase(),
    t.replace(/\s+/g, "").toLowerCase()
  ]);
  return Array.from(set);
}
function lookupTolerant(pool, key) {
  if (!pool || !key) return undefined;
  if (Object.prototype.hasOwnProperty.call(pool, key)) return pool[key];
  for (const v of idVariants(key)) {
    if (Object.prototype.hasOwnProperty.call(pool, v)) return pool[v];
  }
  return undefined;
}
function parseIdRange(id) {
  const m = String(id || "").match(/^(.+):(\d+)-(\d+)$/);
  if (!m) return null;
  return { baseId: m[1], start: parseInt(m[2], 10), end: parseInt(m[3], 10) };
}
function tolerantGetAnySeqForId(anyId, pool) {
  const r = parseIdRange(anyId);
  if (!r) {
    const exact = lookupTolerant(pool, anyId);
    return typeof exact === "string" ? exact : "";
  }
  const base = lookupTolerant(pool, r.baseId) || "";
  if (!base) return "";
  const sIdx = Math.max(0, r.start - 1);
  const eIdx = Math.min(base.length, r.end);
  return base.slice(sIdx, eIdx);
}
function globalCoordForId(anyId, localStart, localEnd) {
  const r = parseIdRange(anyId);
  if (!r) return null;
  const offset = (r.start || 1) - 1;
  return { globalStart: offset + localStart, globalEnd: offset + localEnd };
}
function exactKeyExists(pool, anyId) {
  if (!pool || !anyId) return false;
  const r = parseIdRange(anyId);
  const k = r ? r.baseId : anyId;
  return Object.prototype.hasOwnProperty.call(pool, k);
}

const NUCLEOTIDE_CHARS = new Set(["A", "C", "G", "U", "T", "N", "R", "Y", "K", "M", "S", "W", "B", "D", "H", "V"]);
function isLikelyAA(seq) {
  if (!seq) return false;
  const s = String(seq).replace(/[\s\-]/g, "").toUpperCase();
  if (!s) return false;
  return /[^ACGTUNRYKMSWBVDH]/.test(s);
}
function toRNA(seq) {
  return String(seq || "").toUpperCase().replace(/T/g, "U").replace(/[^ACGU]/g, (ch) => NUCLEOTIDE_CHARS.has(ch) ? ch : "");
}
const AA2RNA_CANON = {
  A: "GCU", R: "CGU", N: "AAU", D: "GAU", C: "UGU",
  Q: "CAA", E: "GAA", G: "GGU", H: "CAU", I: "AUU",
  L: "UUA", K: "AAA", M: "AUG", F: "UUU", P: "CCU",
  S: "UCU", T: "ACU", W: "UGG", Y: "UAU", V: "GUU",
  U: "UGA", O: "UAG", B: "AAN", Z: "CAN", X: "NNN", "*": "NNN"
};
const AA2RNA_GC = {
  A: "GCC", R: "CGC", N: "AAC", D: "GAC", C: "UGC",
  Q: "CAG", E: "GAG", G: "GGC", H: "CAC", I: "AUC",
  L: "CUG", K: "AAG", M: "AUG", F: "UUC", P: "CCC",
  S: "UCC", T: "ACC", W: "UGG", Y: "UAC", V: "GUG",
  U: "UGA", O: "UAG", B: "AAN", Z: "CAN", X: "NNN", "*": "NNN"
};
const AA2RNA_NNK = {
  A: "NNK", R: "NNK", N: "NNK", D: "NNK", C: "NNK",
  Q: "NNK", E: "NNK", G: "NNK", H: "NNK", I: "NNK",
  L: "NNK", K: "NNK", M: "AUG", F: "NNK", P: "NNK",
  S: "NNK", T: "NNK", W: "UGG", Y: "NNK", V: "NNK",
  U: "UGA", O: "UAG", B: "NNK", Z: "NNK", X: "NNN", "*": "NNN"
};
function aaToRNAWithMode(aaSeq, mode = "canonical") {
  const s = String(aaSeq || "").replace(/\s+/g, "").toUpperCase();
  const table = mode === "gc_balanced" ? AA2RNA_GC : (mode === "nnk" ? AA2RNA_NNK : AA2RNA_CANON);
  let out = "";
  for (const ch of s) {
    if (table[ch]) out += table[ch];
    else if (NUCLEOTIDE_CHARS.has(ch)) out += ch;
    else out += "NNN";
  }
  return out;
}

function resolveSeqWithAAHandling(anyId, pool, pdbTextPool = {}) {
  let raw = tolerantGetAnySeqForId(anyId, pool);
  const uiFlag = $("aa-convert-flag")?.checked ?? CONFIG.aa_convert_allowed;
  const mode = (byQS("#aa-nt-mode")?.value || "canonical").toLowerCase();
  const canConvert = CONFIG.aa_convert_allowed && uiFlag;
  const fallbackFromPDB = () => {
    const pdbSeq = tolerantGetAnySeqForId(anyId, pdbTextPool);
    if (!pdbSeq) return { seq: "", converted: false, note: "No PDB sequence available.", mode: "" };
    if (!isLikelyAA(pdbSeq)) return { seq: toRNA(pdbSeq), converted: false, note: "From PDB/CIF (nt chain).", mode: "" };
    if (canConvert) {
      const nt = aaToRNAWithMode(pdbSeq, mode);
      return { seq: toRNA(nt), converted: true, note: `AA→NT from PDB (${mode}).`, mode };
    }
    return { seq: "", converted: false, note: "PDB-only amino acids — conversion disabled.", mode: "" };
  };
  if (raw && !isLikelyAA(raw)) return { seq: toRNA(raw), converted: false, note: "From FASTA nt.", mode: "" };
  if (raw && isLikelyAA(raw)) {
    if (canConvert) {
      const nt = aaToRNAWithMode(raw, mode);
      return { seq: toRNA(nt), converted: true, note: `AA→NT from FASTA (${mode}).`, mode };
    }
    return fallbackFromPDB();
  }
  return fallbackFromPDB();
}

async function loadConfig() {
  try {
    const res = await fetch(CONFIG_URL, { method: "GET" });
    if (res.ok) {
      const cfg = await res.json();
      CONFIG = { ...CONFIG, ...cfg };
    }
  } catch (_) { }
}

async function getNonceOrKeyHeaders() {
  const h = {};
  try {
    if (CONFIG && CONFIG.use_nonce) {
      const r = await fetch(NONCE_URL, { method: "GET", cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j && j.nonce) h["X-Nonce"] = j.nonce;
      } else console.warn("Nonce fetch failed:", r.status);
    } else if (CONFIG && CONFIG.api_key) {
      h["X-API-KEY"] = CONFIG.api_key;
    }
  } catch (e) { console.warn("Auth header setup warning:", e); }
  return h;
}

function bindOnce(el, event, handler, key) {
  if (!el) return;
  const k = key || `${event}__bound`;
  if (el.dataset && el.dataset[k] === "1") return;
  el.addEventListener(event, handler);
  if (el.dataset) el.dataset[k] = "1";
}

function getBasketFiles(kind) {
  try {
    if (window.__BASKET__ && Array.isArray(window.__BASKET__[kind])) return window.__BASKET__[kind];
  } catch (_) { }
  return [];
}

function getLegacyInputFiles(kind) {
  const map = { target: $("target-file"), competitor: $("competitor-file"), mirna: $("mirna-file") };
  const el = map[kind];
  if (!el?.files?.length) return [];
  return Array.from(el.files);
}

function collectStructureSources(kind, primaryBlob = null, primaryExt = "pdb") {
  const sources = [];
  if (primaryBlob) sources.push({ label: `server_${kind}.${primaryExt}`, type: "server", payload: primaryBlob, ext: primaryExt });
  const staged = getBasketFiles(kind);
  staged.forEach((f, i) => sources.push({ label: `staged_${i + 1}_${f.name}`, type: "basket", payload: f, ext: (f.name.split(".").pop() || "pdb").toLowerCase() }));
  const legacy = getLegacyInputFiles(kind);
  legacy.forEach((f, i) => sources.push({ label: `legacy_${i + 1}_${f.name}`, type: "legacy", payload: f, ext: (f.name.split(".").pop() || "pdb").toLowerCase() }));
  return sources;
}

function filterSourcesForRowByRowItem(sources, kind, rowItem) {
  if (!rowItem || !sources || !sources.length) return sources || [];
  let wantedId = "";
  if (kind === "target") wantedId = (rowItem.target_id || "").trim();
  else if (kind === "mirna") wantedId = (rowItem.primary_molecule_id || rowItem.mirna_id || "").trim();
  else if (kind === "competitor") wantedId = (rowItem.competitor_id || "").trim();
  if (!wantedId) return sources;
  const needle = wantedId.toLowerCase();
  const filtered = sources.filter(src => {
    const label = (src && src.label ? String(src.label) : "");
    return label.toLowerCase().includes(needle);
  });
  return filtered.length ? filtered : sources;
}

let __scrollAnim = null;
function cancelScrollAnim() {
  if (__scrollAnim) { cancelAnimationFrame(__scrollAnim.rafId); __scrollAnim = null; }
}
function animateScrollTo(targetY, duration = 450) {
  cancelScrollAnim();
  const startY = window.pageYOffset;
  const dist = targetY - startY;
  const start = performance.now();
  const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  function step(now) {
    const p = Math.min(1, (now - start) / duration);
    const y = Math.round(startY + dist * ease(p));
    window.scrollTo(0, y);
    if (p < 1 && __scrollAnim) __scrollAnim.rafId = requestAnimationFrame(step);
    else {
      __scrollAnim = null;
      window.scrollTo(0, targetY);
    }
  }
  __scrollAnim = { rafId: requestAnimationFrame(step) };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(ev => window.addEventListener(ev, cancelScrollAnim, { once: true, passive: true }));
}

function ensureStickyGapForTabs() {
  document.querySelectorAll("nav.is-sticky-gap, header.is-sticky-gap").forEach(el => el.classList.remove("is-sticky-gap"));
  const tabbar = document.querySelector(".tab-bar-sticky, .sticky-tabs, .tabbar, .tabs");
  if (!tabbar) return;
  const cs = window.getComputedStyle(tabbar);
  if (cs.position !== "sticky") tabbar.style.position = "sticky";
  tabbar.classList.add("is-sticky-gap");
  tabbar.style.top = `calc(var(--sticky-offset-main) + var(--sticky-gap))`;
  tabbar.style.zIndex = "11";
  if (!tabbar.style.background || tabbar.style.background === "initial") tabbar.style.background = "#fff";
  let shim = document.getElementById("sticky-gap-shim");
  if (!shim) {
    shim = document.createElement("div");
    shim.id = "sticky-gap-shim";
    document.body.appendChild(shim);
  }
  const updateShim = () => {
    const topPx = parseInt(getComputedStyle(tabbar).top || "0", 10) || 0;
    const rectTop = Math.round(tabbar.getBoundingClientRect().top);
    const stuck = rectTop <= topPx + 1;
    shim.style.display = stuck ? "block" : "none";
  };
  if (!GUARDS.stickyShimWired) {
    window.addEventListener("scroll", updateShim, { passive: true });
    window.addEventListener("resize", () => { updateShim(); }, { passive: true });
    GUARDS.stickyShimWired = true;
  }
  updateShim();
}

function scrollToCardTop(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const prevSM = el.style.scrollMarginTop;
  el.style.scrollMarginTop = "0px";
  requestAnimationFrame(() => {
    const desired = getStickySum(true);
    const absTop = window.pageYOffset + el.getBoundingClientRect().top;
    const targetY = Math.max(0, Math.round(absTop - desired));
    animateScrollTo(targetY, 480);
    setTimeout(() => { el.style.scrollMarginTop = prevSM; }, 0);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  injectPremiumStyles();
  await loadConfig();
  ensureModal();
  syncStickyOffset();
  ensureStickyGapForTabs();
  window.addEventListener("resize", () => { syncStickyOffset(); ensureStickyGapForTabs(); ensureTabsAnchor(); }, { passive: true });
  const loader = $("loader");
  if (loader) { text(loader, "Please input your sequences to start a prediction."); show(loader); }
  (function hardenSubmit() {
    const form = $("prediction-form");
    if (form) {
      form.method = "post";
      form.setAttribute("action", "");
      form.removeAttribute("action");
      form.setAttribute("novalidate", "novalidate");
    }
    window.addEventListener("submit", (ev) => {
      const f = ev.target;
      if (f && f.id === "prediction-form") {
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
        handleSubmit(ev);
        const cleanUrl = window.location.pathname + window.location.search.replace(/^\?$/, "");
        if (window.location.hash) {
          history.replaceState(null, "", cleanUrl);
        } else if (window.location.search === "?") {
          history.replaceState(null, "", cleanUrl);
        }
      }
    }, true);
    const runSelectors = [
      "#run-prediction",
      '[data-run="prediction"]',
      'form#prediction-form button[type="submit"]',
      'form#prediction-form input[type="submit"]',
      'form#prediction-form button[formaction]',
      'form#prediction-form [type="submit"][formaction]',
      'form#prediction-form a[href*="#"]'
    ];
    document.querySelectorAll(runSelectors.join(",")).forEach((el) => {
      el.removeAttribute("href");
      el.removeAttribute("formaction");
      el.removeAttribute("formtarget");
      bindOnce(el, "click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        const f = $("prediction-form");
        if (!f) return;
        (f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit", { cancelable: true })));
      }, "runClickGuard2");
    });
    window.addEventListener("hashchange", (ev) => {
      if (window.location.hash && /workflow/i.test(window.location.hash)) {
        ev.preventDefault?.();
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }, true);
  })();
  const primaryTaEl = getFirstExistingElement(["primary-seqs", "mirna-seqs", "mirna-seq", "primary_molecules"]) || $("primary-seqs");
  const primaryTaId = primaryTaEl ? primaryTaEl.id : "primary-seqs";
  bindFileToTextarea("mirna-seq-file", primaryTaId);
  bindFileToTextarea("target-seq-file", "target-seq");
  bindFileToTextarea("competitor-seq-file", "competitor-seq");
  const fastaFileMap = [
    { fileId: "mirna-seq-file", textareaId: "primary-seqs" },
    { fileId: "target-seq-file", textareaId: "target-seq" },
    { fileId: "competitor-seq-file", textareaId: "competitor-seq" }
  ];
  fastaFileMap.forEach(({ fileId, textareaId }) => {
    const input = $(fileId);
    if (!input) return;
    input.classList.add("file-premium");
    if (!input.dataset.hasClearBtn) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Clear";
      btn.className = "fasta-clear-btn";
      input.insertAdjacentElement("afterend", btn);
      btn.addEventListener("click", () => {
        input.value = "";
        const ta = $(textareaId);
        if (ta) ta.value = "";
      });
      input.dataset.hasClearBtn = "1";
    }
  });
  ["mirna-file", "target-file", "competitor-file"].forEach(id => {
    const el = $(id);
    if (el) el.classList.add("file-premium");
  });
  const form = $("prediction-form");
  if (form && !GUARDS.formBindingDone) {
    bindOnce(form, "submit", handleSubmit, "submitGuard");
    GUARDS.formBindingDone = true;
  }
  ["load-sample-btn", "clear-btn", "clear-inputs-btn", "seed-scan-global-btn", "explain-global-btn"].forEach(id => {
    const el = $(id);
    if (el) el.classList.add("btn-premium");
  });
  injectAdvancedOnce();
  wireTabButtonsOnce();
  scrollTabsToTop();
});

function injectAdvancedOnce() {
  const advTab = byQS("#advanced-tab");
  if (!advTab || GUARDS.advancedInjected) return;
  const serverCfgId = "server-config-note";
  ensureSingleton(
    serverCfgId,
    `<div id="${serverCfgId}" style="margin:8px 0;color:#333;"><strong>Server configuration:</strong><ul style="margin:6px 0 0 16px;"><li>Max miRNAs per request: <code>${CONFIG.mirna_max}</code></li><li>Mature trimming enabled: <code>${CONFIG.mature_trim_enabled ? "yes" : "no"}</code> (window: ${CONFIG.mature_window})</li><li>AA→NT conversion allowed: <code>${CONFIG.aa_convert_allowed ? "yes" : "no"}</code></li><li>Auth mode: <code>${CONFIG.use_nonce ? "nonce" : "open"}</code></li></ul></div>`,
    advTab
  );
  const flagsWrapperId = "advanced-flags-wrapper";
  ensureSingleton(
    flagsWrapperId,
    `<div id="${flagsWrapperId}" style="margin-top:8px;"><div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" id="mature-trim-flag" ${CONFIG.mature_trim_enabled ? "checked" : ""}/><span>Auto-trim miRNAs &gt; 30nt to mature-like ${CONFIG.mature_window}nt</span></label><label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="checkbox" id="aa-convert-flag" ${CONFIG.aa_convert_allowed ? "checked" : "disabled"}/><span>Convert protein AA → NT for targets/competitors (lossy)</span></label><label style="display:flex;gap:8px;align-items:center;"><span>AA→NT mode</span><select id="aa-nt-mode" ${CONFIG.aa_convert_allowed ? "" : "disabled"}><option value="canonical" selected>Most-common human codon</option><option value="gc_balanced">GC-balanced</option><option value="nnk">NNK (degenerate)</option></select></label></div><small style="color:#555;">PDB is optional and never blocks scoring. If a PDB is protein-only, we’ll auto back-translate for scanning/visualization.</small></div>`,
    advTab
  );
  const aaFlag = $("aa-convert-flag");
  if (aaFlag && !CONFIG.aa_convert_allowed) {
    aaFlag.disabled = true;
    aaFlag.checked = false;
    const modeSel = $("aa-nt-mode");
    if (modeSel) modeSel.disabled = true;
  }
  GUARDS.advancedInjected = true;
}

function extractPdbIdsFromFasta(text) {
  const ids = [];
  if (!text) return ids;
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    if (!ln.trim().startsWith(">")) continue;
    const header = ln.slice(1);
    const re = /(pdb|rcsb)\s*[:=]\s*([0-9][A-Za-z0-9]{3})(?:[_\-\s]*([A-Za-z0-9]))?/gi;
    let m;
    while ((m = re.exec(header)) !== null) {
      const code = (m[2] || "").toUpperCase();
      const chain = (m[3] || "").toUpperCase();
      ids.push(chain ? `${code}_${chain}` : code);
    }
  }
  return Array.from(new Set(ids));
}
function extractChainHintsFromFasta(text) {
  const hints = {};
  if (!text) return hints;
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    if (!ln.trim().startsWith(">")) continue;
    const header = ln.slice(1).trim();
    const id = header.replace(/\|.*$/, "").trim();
    const m = header.match(/\bchain\b\s*=\s*([A-Za-z0-9])/i);
    if (m && id) hints[id] = m[1].toUpperCase();
  }
  return hints;
}

async function fetchServerHeatmapPng(item, mode = "ig_target", steps = 64) {
  if (!CURRENT_JOB_ID) throw new Error("No active job id for heatmap.");
  if (!item || !item.interaction_id) throw new Error("Row is missing interaction_id for heatmap.");
  const headers = await getNonceOrKeyHeaders();
  const url = HEATMAP_PNG_URL(CURRENT_JOB_ID, item.interaction_id, mode, steps);
  const res = await fetchRetry(url, { method: "GET", headers }, 45000, 2, 700);
  if (!res.ok) throw new Error(`Heatmap PNG request failed: ${res.status}`);
  return await res.blob();
}

async function handleSubmit(event) {
  event.preventDefault();
  gotoResultsTab();
  const loader = $("loader");
  const resultsContainer = $("results-container");
  const primarySeqs = getTextValuePossible(["primary-seqs", "mirna-seqs", "mirna-seq", "primary_molecules"]);
  const targetSeq = getTextValuePossible(["target-seq", "target-seqs", "target_sequence"]);
  const competitorSeq = getTextValuePossible(["competitor-seq", "competitor-seqs", "competitor_sequence"]);
  CURRENT_INPUTS.mirnas = parseFastaToMap(primarySeqs, "miRNA");
  CURRENT_INPUTS.targets = parseFastaToMap(targetSeq, "target");
  CURRENT_INPUTS.competitors = parseFastaToMap(competitorSeq, "competitor");
  if (
    Object.keys(CURRENT_INPUTS.mirnas).length === 0 &&
    getBasketFiles("mirna").length === 0 &&
    (($("mirna-file")?.files?.length || 0) === 0)
  ) {
    const rw = resultsContainer?.querySelector(".reload-warning");
    if (rw) rw.remove();
    setHTML(
      resultsContainer,
      formatError(
        "We could not detect any valid miRNA sequences in your input. Please paste nucleotide sequences in FASTA format (each starting with \">\") and try again."
      )
    );
    if (loader) hide(loader);
    return;
  }
  RUN_MANIFEST = {
    created_at: new Date().toISOString(),
    client: "mirna.js",
    config: {
      mirna_max: CONFIG.mirna_max,
      mature_trim_enabled: CONFIG.mature_trim_enabled,
      mature_window: CONFIG.mature_window,
      aa_convert_allowed: CONFIG.aa_convert_allowed
    },
    aa_nt_mode: (byQS("#aa-nt-mode")?.value || "canonical"),
    flags: {
      mature_trim: $("mature-trim-flag")?.checked ?? CONFIG.mature_trim_enabled,
      aa_convert: $("aa-convert-flag")?.checked ?? CONFIG.aa_convert_allowed
    },
    inputs: {
      mirna_count: Object.keys(CURRENT_INPUTS.mirnas).length,
      target_count: Object.keys(CURRENT_INPUTS.targets).length,
      competitor_count: Object.keys(CURRENT_INPUTS.competitors).length,
      target_pdb_ids: extractPdbIdsFromFasta(targetSeq),
      competitor_pdb_ids: extractPdbIdsFromFasta(competitorSeq),
      target_chain_hints: extractChainHintsFromFasta(targetSeq),
      competitor_chain_hints: extractChainHintsFromFasta(competitorSeq),
      staged_target_files: getBasketFiles("target").map(f => f.name),
      staged_competitor_files: getBasketFiles("competitor").map(f => f.name)
    }
  };
  if (resultsContainer) setHTML(resultsContainer, "");
  predictionResults = [];
  LAST_SEED_HITS = null; LAST_SEED_META = null; CURRENT_JOB_ID = null;
  prependHTML(resultsContainer, `<div class="reload-warning">Please do not refresh or close this page while your prediction is running — this will cancel the analysis in progress.</div>`);
  const hasMirnaFasta = !!primarySeqs;
  const hasMirnaPdbFile = ($("mirna-file")?.files?.length || 0) > 0;
  const hasMirnaPdbStaged = getBasketFiles("mirna").length > 0;
  const hasMirnaAny = hasMirnaFasta || hasMirnaPdbFile || hasMirnaPdbStaged;
  const hasTargetFasta = !!targetSeq;
  const targetPdbIdsGuard = extractPdbIdsFromFasta(targetSeq);
  const hasTargetPdbFile = ($("target-file")?.files?.length || 0) > 0;
  const hasTargetPdbStaged = getBasketFiles("target").length > 0;
  const hasTargetAny = hasTargetFasta || hasTargetPdbFile || hasTargetPdbStaged || (targetPdbIdsGuard && targetPdbIdsGuard.length > 0);
  if (!hasMirnaAny || !hasTargetAny) {
    const hasMirnaStruct = (getBasketFiles("mirna").length + ($("mirna-file")?.files?.length || 0)) > 0;
    const hasTargetStruct = (getBasketFiles("target").length + ($("target-file")?.files?.length || 0)) > 0;
    if (!(hasMirnaStruct && hasTargetStruct)) {
      const rw = resultsContainer?.querySelector(".reload-warning");
      if (rw) rw.remove();
      setHTML(resultsContainer, formatError("Provide at least a PDB/mmCIF for both miRNA and Target. FASTA is optional."));
      if (loader) hide(loader);
      return;
    }
  }
  if (!hasMirnaFasta || !hasTargetFasta) {
    prependHTML(
      resultsContainer,
      `<div class="staging-box" style="background:linear-gradient(135deg,#f0f9ff,#eef2ff);border-radius:12px;border:1px solid #bfdbfe;padding:10px;margin:8px 0;"><div style="font-weight:600;margin-bottom:2px;">Running with structural-only input</div><p style="margin:0;color:#334155;font-size:13px;">Your combination (FASTA + PDB) is valid — we’ll start the analysis. Just note that some client-side views (Seed Sites, IG heatmaps) work best when FASTA sequences are also provided.</p></div>`
    );
  }
  if (primarySeqs && !hasFastaHeaders(primarySeqs)) {
    setHTML(resultsContainer, formatError('Your miRNA input is missing FASTA headers. Please add lines starting with ">" (e.g., >hsa-let-7a-5p) so results can be labeled correctly.'));
    return;
  }
  const mirnaCount = countFastaRecords(primarySeqs);
  let tgtCount = countFastaRecords(targetSeq); if (!tgtCount && targetSeq) tgtCount = 1;
  let compCount = countFastaRecords(competitorSeq); if (!compCount && competitorSeq) compCount = 1;
  function dedupCount(role, fastaText, files) {
    const fastaIds = Object.keys(parseFastaToMap(fastaText || "", role));
    const pdbIds = new Set((files || []).map(f => {
      const name = (f.name || "").split(".")[0];
      return name.toLowerCase();
    }));
    const overlaps = fastaIds.filter(id => pdbIds.has(id.toLowerCase())).length;
    const fastaOnly = Math.max(0, fastaIds.length - overlaps);
    const pdbOnly = Math.max(0, pdbIds.size - overlaps);
    const matched = overlaps;
    return fastaOnly + pdbOnly + matched;
  }
  const mirnaFiles = [...(getBasketFiles("mirna") || []), ...Array.from($("mirna-file")?.files || [])];
  const targetFiles = [...(getBasketFiles("target") || []), ...Array.from($("target-file")?.files || [])];
  const compFiles = [...(getBasketFiles("competitor") || []), ...Array.from($("competitor-file")?.files || [])];
  const mirnaEffectiveCount = dedupCount("mirna", primarySeqs, mirnaFiles);
  const targetEffectiveCount = dedupCount("target", targetSeq, targetFiles);
  const compEffectiveCount = dedupCount("competitor", competitorSeq, compFiles);
  const totalCombinations = mirnaEffectiveCount * Math.max(1, targetEffectiveCount) * Math.max(1, compEffectiveCount);
  prependHTML(resultsContainer, formatInfo(`Detected: miRNA=${mirnaEffectiveCount}, Target=${targetEffectiveCount}, Competitor=${compEffectiveCount}.Estimated total combinations: ${totalCombinations}.`));
  const MIN_TARGET_LEN = 30;
  const MIN_COMP_LEN = 15;
  if (targetSeq && (targetSeq.replace(/^>.*$/gm, "").replace(/\s+/g, "")).length < MIN_TARGET_LEN) appendHTML(resultsContainer, formatWarn(`Tip: Target should be at least ${MIN_TARGET_LEN} nt if provided. PDB-only runs are also supported.`));
  if (competitorSeq && (competitorSeq.replace(/^>.*$/gm, "").replace(/\s+/g, "")).length < MIN_COMP_LEN) appendHTML(resultsContainer, formatWarn(`Tip: Competitor should be at least ${MIN_COMP_LEN} nt or leave it blank. PDB-only runs are supported.`));
  if (mirnaCount > CONFIG.mirna_max) {
    setHTML(resultsContainer, formatError(`You entered ${mirnaCount} miRNAs, but the maximum allowed is ${CONFIG.mirna_max}. Please reduce your input and try again.`));
    return;
  }
  if (tgtCount >= 1 && !hasFastaHeaders(targetSeq)) prependHTML(resultsContainer, formatWarn("Tip: Add FASTA headers to targets (e.g., >target1) for clean labels in results. PDB can still be used for visualization."));
  if (competitorSeq && !hasFastaHeaders(competitorSeq)) prependHTML(resultsContainer, formatWarn("Tip: Add FASTA headers to competitors (e.g., >comp1) for clean labels in results."));
  if (loader) { text(loader, "Running prediction..."); show(loader); }
  const formData = new FormData();
  formData.append("primary_molecules", mirnaFastaText);
  formData.append("primary_molecules", primarySeqs);
  formData.append("primary_molecule", primarySeqs);
  formData.append("mirna_sequences", primarySeqs);
  formData.append("mirna_seq", primarySeqs);
  formData.append("target_molecule", targetSeq);
  formData.append("competitor_molecule", competitorSeq);
  formData.append("target_start", $("target-start")?.value ?? "");
  formData.append("target_end", $("target-end")?.value ?? "");
  const matureTrimFlag = $("mature-trim-flag")?.checked ?? CONFIG.mature_trim_enabled;
  const aaConvertFlag = $("aa-convert-flag")?.checked ?? false;
  const aaMode = (byQS("#aa-nt-mode")?.value || "canonical").toLowerCase();
  formData.append("mature_trim", matureTrimFlag ? "true" : "false");
  formData.append("convert_aa_to_nt", aaConvertFlag ? "true" : "false");
  formData.append("aa_nt_mode", aaMode);
  const targetPdbIds = extractPdbIdsFromFasta(targetSeq);
  const compPdbIds = extractPdbIdsFromFasta(competitorSeq);
  targetPdbIds.forEach(id => formData.append("target_pdb_id", id));
  compPdbIds.forEach(id => formData.append("competitor_pdb_id", id));
  const targetChainHints = extractChainHintsFromFasta(targetSeq);
  const compChainHints = extractChainHintsFromFasta(competitorSeq);
  if (Object.keys(targetChainHints).length) formData.append("target_chain_hints_json", JSON.stringify(targetChainHints));
  if (Object.keys(compChainHints).length) formData.append("competitor_chain_hints_json", JSON.stringify(compChainHints));
  const structureRoles = [
    { kind: "mirna", inputId: "mirna-file", field: "mirna_3d_file" },
    { kind: "target", inputId: "target-file", field: "target_3d_file" },
    { kind: "competitor", inputId: "competitor-file", field: "competitor_3d_file" }
  ];
  const seenStructFiles = new Set();
  const fingerprint = (f) => `${f.name}::${f.size}::${f.type || ""}`;
  structureRoles.forEach(({ kind, inputId, field }) => {
    const inputEl = $(inputId);
    if (inputEl?.files?.length) {
      for (const f of inputEl.files) {
        if (!validateFileSize(f)) { inputEl.value = ""; break; }
        const fp = fingerprint(f);
        if (seenStructFiles.has(fp)) continue;
        seenStructFiles.add(fp);
        formData.append(field, f);
      }
    }
    const staged = getBasketFiles(kind);
    if (staged && staged.length) {
      for (const f of staged) {
        if (!validateFileSize(f)) continue;
        const fp = fingerprint(f);
        if (seenStructFiles.has(fp)) continue;
        seenStructFiles.add(fp);
        formData.append(field, f);
      }
    }
  });
  tryPrecheck(formData).catch(() => { });
  try {
    const authHeaders = await getNonceOrKeyHeaders();
    if (loader) text(loader, "Job started. Preparing batches...");
    const startRes = await fetch(API_URL, { method: "POST", headers: authHeaders, body: formData });
    if (!startRes.ok) {
      let errorMsg;
      try {
        const errorData = await startRes.json();
        errorMsg = errorData.message || errorData.error || null;
      } catch (_) { }
      throw new Error(errorMsg || "Something went wrong while starting your job.");
    }
    const { job_id } = await startRes.json();
    if (!job_id) throw new Error("No job ID returned from server.");
    CURRENT_JOB_ID = job_id;
    RUN_MANIFEST.job_id = job_id;
    let lastCompleted = -1;
    let lastTick = Date.now();
    const poll = async () => {
      const res = await fetch(PROGRESS_URL(job_id), { method: "GET" });
      if (!res.ok) throw new Error("Failed to check job progress.");
      const data = await res.json();
      if (data.status === "running") {
        const total = Number.isFinite(data.total) ? data.total : "?";
        const completed = Number.isFinite(data.completed) ? data.completed : "?";
        if (loader) {
          if (!loader.querySelector(".loader-spinner")) loader.innerHTML = `<span class="loader-spinner"></span><span id="loader-text"></span>`;
          const lt = loader.querySelector("#loader-text");
          if (lt) lt.textContent = `Processing... ${completed}/${total} completed`;
          show(loader);
        }
        if (Number.isFinite(completed) && completed !== lastCompleted) {
          lastCompleted = completed; lastTick = Date.now();
        } else if (Date.now() - lastTick > 180000) {
          const friendly = "Still working — this is taking longer than usual. Please keep this page open; closing it will stop the analysis.";
          const details = `<details style="margin-top:6px;"><summary style="cursor:pointer;color:#1e5a9c;">Technical details (for administrators)</summary><div style="margin-top:6px;font-size:13px;color:#444;">On some servers, the Flask <em>debug reloader</em> can start a second process and break live progress (it may show 0/… forever). If you manage this server, run it in single-process mode: <code>debug=False</code> and <code>use_reloader=False</code>.</div></details>`;
          prependHTML(resultsContainer, formatWarn(friendly) + details);
          lastTick = Date.now();
        }
        setTimeout(poll, 1200);
        return;
      }
      if (data.status === "error") {
        const rw = resultsContainer.querySelector(".reload-warning"); if (rw) rw.remove();
        const maybePdbWarning = /pdb|structure|polymer|chain|back-translate/i.test(data.error || "");
        try {
          if (loader) text(loader, "Attempting to fetch partial results...");
          const headers = await getNonceOrKeyHeaders();
          let finalDataSoft = null;
          try {
            finalDataSoft = await fetchJSONWithTimeout(
              DOWNLOAD_URL(job_id),
              { method: "GET", headers },
              60000
            );
          } catch (_) { }
          if (finalDataSoft) {
            const rows = finalDataSoft.results || [];
            if (rows.length) {
              predictionResults = rows;
              displayResults(predictionResults, finalDataSoft);
              if (maybePdbWarning) prependHTML(resultsContainer, formatWarn("Structure warning encountered. PDB files were kept for visualization; scoring continued using nucleotide sequences."));
              if (loader) { text(loader, "✅ Prediction completed with warnings."); setTimeout(() => hide(loader), 3000); }
              return;
            }
          }
        } catch (_) { }
        throw new Error(data.error || "We encountered a technical issue while processing your request.");
      }
      if (data.status === "completed") {
        const rw = resultsContainer.querySelector(".reload-warning"); if (rw) rw.remove();
        if (loader) text(loader, "Fetching final results...");
        try {
          const headers = await getNonceOrKeyHeaders();
          const finalData = await fetchJSONWithTimeout(
            DOWNLOAD_URL(job_id),
            { method: "GET", headers },
            60000
          );
          predictionResults = finalData.results || [];
          displayResults(predictionResults, finalData);
          if (loader) {
            text(loader, "✅ Prediction completed. Results are shown below.");
            setTimeout(() => hide(loader), 3000);
          }
        } catch (err) {
          prependHTML(resultsContainer, `<div class="note error" style="margin:8px 0;">Couldn’t fetch results quickly. You can still open them directly: <a href="${DOWNLOAD_URL(job_id)}" target="_blank" rel="noopener">Open results JSON</a></div>`);
          if (loader) hide(loader);
        }
      }
    };
    await poll();
  } catch (error) {
    const rw = resultsContainer?.querySelector(".reload-warning"); if (rw) rw.remove();
    const friendly = error?.message && !/server error/i.test(error.message)
      ? error.message
      : "Something went wrong while processing your request. Please try again later.";
    setHTML(resultsContainer, formatError(friendly));
    if (loader) hide(loader);
  }
}

async function tryPrecheck(formData) {
  const fd = new FormData();
  for (const [k, v] of formData.entries()) fd.append(k, v);
  const headers = await getNonceOrKeyHeaders();
  let res;
  try {
    res = await fetchWithTimeout(PRECHECK_URL, { method: "POST", headers, body: fd }, 20000);
  } catch (_) { }
  if (!res || !res.ok) {
    const rc = $("results-container");
    if (rc) appendHTML(rc, formatInfo("Pre-validation skipped (not available). We’ll auto-handle PDB-only, FASTA-only, and protein back-translation. PDB never blocks scoring."));
    return;
  }
  const data = await res.json();
  renderPrecheckPanel(data);
}

function renderPrecheckPanel(data) {
  const rc = $("results-container");
  if (!rc) return;
  const rows = [];
  const add = (arr, label) => {
    (arr || []).forEach(o => {
      rows.push({
        kind: label,
        id: o.id || o.header || o.filename || "(unknown)",
        chain: o.chain || o.chain_id || "",
        polymer: o.polymer || o.polymer_type || "unknown",
        length: o.length || o.seq_len || "",
        used_scoring: !!o.used_for_scoring,
        used_viz: !!o.used_for_viz || !!o.present_for_viz,
        back_tx: !!o.back_translated,
        note: o.note || ""
      });
    });
  };
  add(data.targets, "Target");
  add(data.competitors, "Competitor");
  let html = `<div class="staging-box" style="background:#f8fffb;border:1px solid #bbf7d0;border-radius:10px;padding:10px;margin:8px 0;"><div class="staging-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;"><div><strong>Pre-validation</strong> <span class="badge ok">non-blocking</span></div><div class="badge off">PDB optional</div></div><table class="precheck-table"><thead><tr><th>Role</th><th>ID / File</th><th>Chain</th><th>Polymer</th><th>Len</th><th>Used for scoring?</th><th>Used for viz?</th><th>AA→NT</th><th>Note</th></tr></thead><tbody>`;
  if (rows.length === 0) {
    html += `<tr><td colspan="9">No structures detected to pre-validate. This is fine — runs can be FASTA-only.</td></tr>`;
  } else {
    rows.forEach(r => {
      const bScore = r.used_scoring ? `<span class="badge ok">yes</span>` : `<span class="badge off">no</span>`;
      const bViz = r.used_viz ? `<span class="badge ok">yes</span>` : `<span class="badge off">no</span>`;
      const bBT = r.back_tx ? `<span class="badge warn">yes</span>` : `<span class="badge off">no</span>`;
      html += `<tr><td>${escapeHTML(r.kind)}</td><td>${escapeHTML(r.id)}</td><td>${escapeHTML(r.chain)}</td><td>${escapeHTML(r.polymer)}</td><td>${escapeHTML(r.length)}</td><td>${bScore}</td><td>${bViz}</td><td>${bBT}</td><td>${escapeHTML(r.note)}</td></tr>`;
    });
  }
  html += `</tbody></table><small style="color:#475569;">If a PDB isn’t nucleotide or doesn’t match the FASTA, it’s kept for visualization with a “not used in scoring” note. Protein chains are auto back-translated for seed/IG scanning when enabled.</small></div>`;
  prependHTML(rc, html);
  RUN_MANIFEST = RUN_MANIFEST || {};
  RUN_MANIFEST.precheck = { targets: data.targets || [], competitors: data.competitors || [] };
}

function displayResults(results, finalData = null) {
  const container = $("results-container");
  if (!container) return;
  setHTML(container, "");
  if (!results || results.length === 0) {
    setHTML(container, "<p>No results to display.</p>");
    return;
  }
  injectAnalysisControls(container);
  if (finalData && finalData.manifest) RUN_MANIFEST = { ...(RUN_MANIFEST || {}), server_manifest: finalData.manifest };
  const runBadgesId = "run-badges";
  const anyStruct = hasAnyStructure();
  const aaOn = !!$("aa-convert-flag")?.checked;
  const aaMode = (byQS("#aa-nt-mode")?.value || "canonical");
  const topBadges = `<div id="${runBadgesId}" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin:6px 0 8px;"><span class="badge ${anyStruct ? "ok" : "off"}">PDB present: ${anyStruct ? "yes" : "no"}</span><span class="badge ${aaOn ? "warn" : "off"}">AA→NT: ${aaOn ? "yes" : "no"}${aaOn ? ` (${escapeHTML(aaMode)})` : ""}</span><span class="badge off">Seed/IG computed on NT</span></div>`;
  appendHTML(container, topBadges);
  results.sort((a, b) =>
    safeParseFloat(b.predicted_affinity_baseline ?? b.baseline_score ?? 0, 0) -
    safeParseFloat(a.predicted_affinity_baseline ?? a.baseline_score ?? 0, 0)
  );
  function getGradientColor(score) {
    const s = Math.max(0, Math.min(1, parseFloat(score) || 0));
    const viridis = [
      [68, 1, 84],
      [59, 82, 139],
      [33, 144, 141],
      [93, 201, 99],
      [253, 231, 37]
    ];
    const idx = s * (viridis.length - 1);
    const low = Math.floor(idx);
    const high = Math.min(low + 1, viridis.length - 1);
    const t = idx - low;
    const r = Math.round(viridis[low][0] + t * (viridis[high][0] - viridis[low][0]));
    const g = Math.round(viridis[low][1] + t * (viridis[high][1] - viridis[low][1]));
    const b = Math.round(viridis[low][2] + t * (viridis[high][2] - viridis[low][2]));
    return `rgba(${r},${g},${b},0.3)`;
  }
  const legendHTML = `<div id="affinity-legend" class="affinity-legend" style="margin-bottom:10px;text-align:center;"><h4 style="margin:6px 0 10px 0;">Affinity Classification Guide</h4><table style="margin:0 auto;"><thead><tr><th>Category</th><th>Score Range</th><th>Interpretation</th></tr></thead><tbody><tr style="background-color:rgba(189,223,38,0.3)"><td>High Affinity</td><td>0.76–1.00</td><td>Strong binding; prioritized for validation</td></tr><tr style="background-color:rgba(74,193,109,0.3)"><td>Medium Affinity</td><td>0.51–0.75</td><td>Moderate; candidate for confirmation</td></tr><tr style="background-color:rgba(43,116,142,0.3)"><td>Low Affinity</td><td>0.26–0.50</td><td>Weak prediction</td></tr><tr style="background-color:rgba(72,36,117,0.3)"><td>No Affinity</td><td>0.00–0.25</td><td>No meaningful binding</td></tr></tbody></table></div>`;
  const buttonsHTML = `<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;"><button id="download-all-server-csv" class="btn-premium">Download Results (CSV)</button><button id="download-all-bundles" class="btn-premium">Download All</button><button id="copy-results-btn" class="btn-premium btn-accent">Copy Results (TSV)</button><button id="download-manifest" class="btn-premium">Run Manifest (JSON)</button></div>`;
  appendHTML(container, legendHTML);
  appendHTML(container, buttonsHTML);
  bindOnce($("download-manifest"), "click", () => {
    const manifest = RUN_MANIFEST || {};
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `mirna_run_manifest_${CURRENT_JOB_ID || "NA"}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "dlManifestOnce");
  bindOnce($("download-all-server-csv"), "click", async () => {
    if (!CURRENT_JOB_ID) { alert("No active job."); return; }
    try {
      const allowGU = byQS("#allow-gu")?.checked ?? true;
      const maxMM = parseInt(byQS("#max-mm")?.value ?? "0", 10);
      const headers = await getNonceOrKeyHeaders();
      const url = DOWNLOAD_ALL_CSV_URL(CURRENT_JOB_ID) + `?allow_gu=${allowGU ? 1 : 0}&max_mismatch=${Number.isFinite(maxMM) ? maxMM : 0}&range_aware=1&tolerant=1`;
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const dl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dl; a.download = `mirna_results_${CURRENT_JOB_ID}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(dl);
    } catch (err) { alert("Could not download CSV."); }
  }, "dlAllCsvOnce");
  bindOnce($("download-all-bundles"), "click", async () => {
    if (!CURRENT_JOB_ID) { alert("No active job."); return; }
    try {
      const headers = await getNonceOrKeyHeaders();
      const res = await fetch(`${BASE_URL}/download/${CURRENT_JOB_ID}/all.zip`, { method: "GET", headers });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `mirna_job_${CURRENT_JOB_ID}_all.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert("Could not download all bundles."); }
  }, "dlAllZipOnce");
  bindOnce($("copy-results-btn"), "click", () => {
    const hasTargetCol = (predictionResults || []).some(r => typeof r.target_id !== "undefined");
    const hasCompCol = (predictionResults || []).some(r => (r.competitor_id ?? "") !== "");
    const lines = predictionResults.map(item => {
      const id = item.primary_molecule_id ?? item.mirna_id ?? "N/A";
      const tid = item.target_id ?? "";
      const cid = item.competitor_id ?? "";
      const baseline = (item.predicted_affinity_baseline ?? item.baseline_score ?? "").toString();
      const withComp = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? "").toString();
      const compEff = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? "").toString();
      return [
        id,
        ...(hasTargetCol ? [tid] : []),
        ...(hasCompCol ? [cid] : []),
        baseline, withComp, compEff
      ].join("\t");
    });
    navigator.clipboard.writeText(lines.join("\n")).then(() => alert("Results copied to clipboard."));
  }, "copyResultsClick");
  const hasTargetCol = (results || []).some(r => typeof r.target_id !== "undefined");
  const hasCompCol = (results || []).some(r => (r.competitor_id ?? "") !== "");
  let table = '<table id="results-table" style="margin-bottom:20px;width:100%;border-collapse:collapse;"><thead><tr><th>Primary Molecule ID</th>' +
    (hasTargetCol ? "<th>Target ID</th>" : "") +
    (hasCompCol ? "<th>Competitor ID</th>" : "") +
    "<th>Predicted Affinity (Baseline)</th><th>Predicted Affinity (With Competitor)</th><th>Competitive Effect (higher is better)</th><th>Notes</th><th>Analysis</th></tr></thead><tbody>";
  results.forEach((item, idx) => {
    const id = item.primary_molecule_id ?? item.mirna_id ?? "N/A";
    const tid = item.target_id ?? "";
    const cid = item.competitor_id ?? "";
    const baseline = (item.predicted_affinity_baseline ?? item.baseline_score ?? "").toString();
    const withComp = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? "").toString();
    const compEff = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? "").toString();
    const bgColor = getGradientColor(baseline);
    const isRange = (!!tid && /:\d+-\d+/.test(tid)) || (!!cid && /:\d+-\d+/.test(cid));
    const tolT = tid ? (!exactKeyExists(CURRENT_INPUTS.targets, parseIdRange(tid)?.baseId || tid) && !!lookupTolerant(CURRENT_INPUTS.targets, parseIdRange(tid)?.baseId || tid)) : false;
    const tolC = cid ? (!exactKeyExists(CURRENT_INPUTS.competitors, parseIdRange(cid)?.baseId || cid) && !!lookupTolerant(CURRENT_INPUTS.competitors, parseIdRange(cid)?.baseId || cid)) : false;
    const isTol = tolT || tolC;
    const badgeBits = [];
    if (typeof item.pdb_used !== "undefined") badgeBits.push(`<span class="badge ${item.pdb_used ? "ok" : "off"}">PDB used: ${item.pdb_used ? "yes" : "no"}</span>`);
    else if (anyStruct) badgeBits.push(`<span class="badge off">PDB used: —</span>`);
    if (typeof item.aa_to_nt_mode !== "undefined" || typeof item.aa_to_nt !== "undefined") {
      const yn = item.aa_to_nt || !!item.aa_to_nt_mode;
      const mode = (item.aa_to_nt_mode || (byQS("#aa-nt-mode")?.value || "canonical")).toString();
      badgeBits.push(`<span class="badge ${yn ? "warn" : "off"}">AA→NT: ${yn ? "yes" : "no"}${yn ? ` (${escapeHTML(mode)})` : ""}</span>`);
    }
    if (typeof item.structure_features_on !== "undefined") badgeBits.push(`<span class="badge ${item.structure_features_on ? "ok" : "off"}">Structure-features: ${item.structure_features_on ? "on" : "off"}</span>`);
    const badgesHTML = badgeBits.length ? badgeBits.join(" ") : `<span class="badge off">Notes unavailable</span>`;
    const seedBtn = `<button class="seed-btn btn-action" data-row="${idx}">Seed Sites</button>`;
    const heatBtn = `<button class="heatmap-btn btn-action" data-row="${idx}">Heatmap</button>`;
    const csvBtn = `<button class="rowcsv-btn btn-action" data-row="${idx}">Row CSV</button>`;
    const t3dBtn = `<button class="t3d-btn btn-action" data-row="${idx}">3D Target</button>`;
    const c3dBtn = `<button class="c3d-btn btn-action" data-row="${idx}">3D Comp</button>`;
    const m3dBtn = `<button class="m3d-btn btn-action" data-row="${idx}">3D miRNA</button>`;
    const all3dBtn = `<button class="x3d-btn btn-action" data-row="${idx}">3D All</button>`;
    const bundleBtn = `<button class="bundle-btn btn-action" data-row="${idx}">Download</button>`;
    const actionBlock = `<div class="action-grid" style="display:grid;grid-template-columns: repeat(3, minmax(120px, 1fr));gap:8px;">${seedBtn}${heatBtn}${csvBtn}${t3dBtn}${c3dBtn}${m3dBtn}${all3dBtn}${bundleBtn}</div>`;
    table += `<tr data-range="${isRange ? "1" : "0"}" data-tolerant="${isTol ? "1" : "0"}" style="background-color:${bgColor}"><td>${escapeHTML(id)}</td>` +
      (hasTargetCol ? `<td>${escapeHTML(tid)}</td>` : "") +
      (hasCompCol ? `<td>${escapeHTML(cid)}</td>` : "") +
      `<td>${escapeHTML(baseline)}</td><td>${escapeHTML(withComp)}</td><td>${escapeHTML(compEff)}</td><td>${badgesHTML}</td><td>${actionBlock}</td></tr>`;
  });
  table += "</tbody></table>";
  appendHTML(container, table);
  makeTableSortable("results-table");
  injectResultFilters();
  const resultsTable = $("results-table");
  if (resultsTable) {
    bindOnce(resultsTable, "click", async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const rowIdx = t.dataset?.row ? parseInt(t.dataset.row, 10) : NaN;
      if (Number.isNaN(rowIdx) || !predictionResults[rowIdx]) return;
      const item = predictionResults[rowIdx];
      if (t.classList.contains("seed-btn")) await handleSeedSitesClick(item);
      else if (t.classList.contains("heatmap-btn")) await handleHeatmapClick(item);
      else if (t.classList.contains("rowcsv-btn")) await handleRowCsvClick(item);
      else if (t.classList.contains("t3d-btn")) await open3DOrExplain(item.target_id || "", "target", item);
      else if (t.classList.contains("c3d-btn")) await open3DOrExplain(item.competitor_id || "", "competitor", item);
      else if (t.classList.contains("m3d-btn")) await open3DOrExplain(item.primary_molecule_id || item.mirna_id || "", "mirna", item);
      else if (t.classList.contains("x3d-btn")) await open3DCombined(item);
      else if (t.classList.contains("bundle-btn")) await handleBundleClick(item);
    }, "resultsActions");
  }
}

function hasAnyStructure() {
  const allKinds = ["mirna", "target", "competitor"];
  let total = 0;
  allKinds.forEach(k => {
    total += getBasketFiles(k).length;
    total += ($(`${k}-file`)?.files?.length || 0);
  });
  return total > 0;
}
