// mirna.js — upgraded & sync’d with multi-target/competitor backend (+ seed-scan + IG heatmap)
// - Keeps your existing UX: nonce, batching, progress, CSV/copy, gradient table, tabs
// - Adds per-row "Seed Sites" (exact coordinates) and "Heatmap" (IG saliency) actions
// - Adds analysis controls (Allow GU wobble, Max mismatches) above results
// - Range-aware (e.g., target IDs like "TP53_3UTR:90-150") to align coordinates properly

// =====================================================
// Global state
// =====================================================
let predictionResults = [];
let CONFIG = {
  mirna_max: 5000,
  mature_trim_enabled: true,
  mature_window: 22,
  aa_convert_allowed: true,
  use_nonce: false
};

// Store the exact inputs used at submit time so downstream analysis matches predictions
const CURRENT_INPUTS = {
  mirnas: {},      // id -> sequence
  targets: {},     // id -> sequence
  competitors: {}  // id -> sequence
};

// Guards to prevent duplicate injections/bindings
const GUARDS = {
  advancedInjected: false,
  fastaTipsInjected: false,
  tabWiringDone: false,
  formBindingDone: false,
  analysisControlsInjected: false,
  modalInjected: false
};

// =====================================================
// API routing and auth
// =====================================================
const LOCAL_BASE = "http://127.0.0.1:8080";
const PROD_BASE  = "https://mirna.aamarzan.com";
const isLocal =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
const BASE_URL = isLocal ? LOCAL_BASE : PROD_BASE;

const API_URL        = `${BASE_URL}/predict`;
const PROGRESS_URL   = (jobId) => `${BASE_URL}/progress/${jobId}`;
const DOWNLOAD_URL   = (jobId) => `${BASE_URL}/download/${jobId}`;
const NONCE_URL      = `${BASE_URL}/nonce`;
const CONFIG_URL     = `${BASE_URL}/config`;
const SEED_SCAN_URL  = `${BASE_URL}/seed_scan`;
const EXPLAIN_URL    = `${BASE_URL}/explain`;

const MAX_FILE_SIZE_MB = 100;

// =====================================================
// Helpers: DOM, UI, utils
// =====================================================
function $(id){ return document.getElementById(id); }
function byQS(sel, scope=document){ return scope.querySelector(sel); }
function byQSA(sel, scope=document){ return Array.from(scope.querySelectorAll(sel)); }
function setHTML(el, html){ if(el) el.innerHTML = html; }
function appendHTML(el, html){ if(el) el.insertAdjacentHTML('beforeend', html); }
function prependHTML(el, html){ if(el) el.insertAdjacentHTML('afterbegin', html); }
function show(el){ if(el) el.classList.remove('hidden'); }
function hide(el){ if(el) el.classList.add('hidden'); }
function text(el, t){ if(el) el.textContent = t; }

function safeParseFloat(x, d=0){
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : d;
}

function escapeHTML(s){
  return String(s || '')
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

function formatError(msg){
  return `<p style="color:#c22;margin:8px 0;">${escapeHTML(msg)}</p>`;
}
function formatWarn(msg){
  return `<p style="color:#b36b00;margin:8px 0;">${escapeHTML(msg)}</p>`;
}
function formatInfo(msg){
  return `<p style="color:#1e5a9c;margin:8px 0;">${escapeHTML(msg)}</p>`;
}

function validateFileSize(file){
  if(file && file.size > MAX_FILE_SIZE_MB * 1024 * 1024){
    alert(`File "${file.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
    return false;
  }
  return true;
}

function bindFileToTextarea(fileInputId, textareaId){
  const fileInput = $(fileInputId);
  const textarea  = $(textareaId);
  if(!fileInput || !textarea) return;

  // Replace input to drop old listeners (prevents duplicates)
  const clone = fileInput.cloneNode(true);
  fileInput.parentNode.replaceChild(clone, fileInput);

  clone.addEventListener('change', function(){
    const file = this.files && this.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { textarea.value = e.target.result; };
    reader.readAsText(file);
  });
}

function countFastaRecords(seqText){
  if(!seqText) return 0;
  const lines = seqText.trim().split(/\r?\n/);
  let count = 0;
  for(const line of lines){ if(line.trim().startsWith('>')) count++; }
  if(count === 0 && seqText.trim().length > 0) count = 1;
  return count;
}

function hasFastaHeaders(text){
  if(!text || !text.trim()) return false;
  return text.split(/\r?\n/).some(line => line.trim().startsWith('>'));
}

function ensureSingleton(id, html, parent){
  if(!parent) return null;
  let el = $(id);
  if(el) return el;
  const holder = document.createElement('div');
  holder.innerHTML = html.trim();
  const created = holder.firstElementChild;
  if(created) parent.appendChild(created);
  return created;
}

// Simple FASTA parser → { id: seq, ... } (if no headers: {"<prefix>_1": raw})
// Preserves FULL header text after ">"
function parseFastaToMap(text, defaultPrefix='seq'){
  const map = {};
  if(!text || !text.trim()){
    return map;
  }
  const hasHeader = hasFastaHeaders(text);
  if(!hasHeader){
    map[`${defaultPrefix}_1`] = text.replace(/^>.*$/gm,'').replace(/\s+/g,'').toUpperCase();
    return map;
  }
  let curId = null;
  let curSeq = [];
  const lines = text.split(/\r?\n/);
  for(const ln of lines){
    if(ln.trim().startsWith('>')){
      if(curId){
        map[curId] = (curSeq.join('')).toUpperCase();
      }
      // keep entire header after '>'
      curId = ln.replace(/^>/,'').trim() || `${defaultPrefix}_${Object.keys(map).length+1}`;
      curSeq = [];
    }else{
      curSeq.push(ln.trim());
    }
  }
  if(curId){
    map[curId] = (curSeq.join('')).toUpperCase();
  }
  return map;
}

// Parse an ID like "TP53:90-150" → {baseId, start, end} (1-based)
function parseIdRange(id){
  const m = String(id||'').match(/^(.+):(\d+)-(\d+)$/);
  if(!m) return null;
  return { baseId: m[1], start: parseInt(m[2],10), end: parseInt(m[3],10) };
}

// Get (possibly sliced) target sequence for a target_id possibly carrying :start-end
function getTargetSeqForId(targetId){
  const r = parseIdRange(targetId);
  if(!r){
    const s = CURRENT_INPUTS.targets[targetId];
    return typeof s === 'string' ? s : '';
  }
  const base = CURRENT_INPUTS.targets[r.baseId] || '';
  if(!base) return '';
  const sIdx = Math.max(0, r.start - 1);
  const eIdx = Math.min(base.length, r.end);
  return base.slice(sIdx, eIdx);
}

// NEW: general slice helper for any pool (targets/competitors)
function getAnySeqForId(anyId, pool){
  const r = parseIdRange(anyId);
  if(!r){
    return pool[anyId] || '';
  }
  const base = pool[r.baseId] || '';
  if(!base) return '';
  const sIdx = Math.max(0, r.start - 1);
  const eIdx = Math.min(base.length, r.end);
  return base.slice(sIdx, eIdx);
}

// For displaying global coords when a :start-end slice is used
function globalCoordForId(anyId, localStart, localEnd){
  const r = parseIdRange(anyId);
  if(!r) return null; // no global translation needed
  const offset = (r.start || 1) - 1; // 0-based offset
  return { globalStart: offset + localStart, globalEnd: offset + localEnd };
}

// =====================================================
// Config loader
// =====================================================
async function loadConfig(){
  try{
    const res = await fetch(CONFIG_URL, { method:'GET' });
    if(res.ok){
      const cfg = await res.json();
      CONFIG = { ...CONFIG, ...cfg };
    }
  }catch(_){
    // keep defaults
  }
}

// =====================================================
// Nonce (optional; graceful when disabled on server)
// =====================================================
async function getNonceOrKeyHeaders(){
  if(!('use_nonce' in CONFIG)) await loadConfig();
  if(!CONFIG.use_nonce){
    // Backend not using nonce — proceed without extra headers
    return {};
  }
  const res = await fetch(NONCE_URL, { method:'GET' });
  if(!res.ok) throw new Error('Failed to obtain auth token from server.');
  const data = await res.json();
  return { 'X-Nonce': data.nonce };
}

// =====================================================
// Safe event binding (prevent duplicates)
// =====================================================
function bindOnce(el, event, handler, key){
  if(!el) return;
  const k = key || `${event}__bound`;
  if(el.dataset && el.dataset[k] === '1') return;
  el.addEventListener(event, handler);
  if(el.dataset) el.dataset[k] = '1';
}

// =====================================================
// Initialization
// =====================================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();

  const loader = $('loader');
  if(loader){
    text(loader, "Please input your sequences to start a prediction.");
    show(loader);
  }

  // Link file pickers → textareas
  bindFileToTextarea('mirna-seq-file', 'primary-seqs');
  bindFileToTextarea('target-seq-file', 'target-seq');
  bindFileToTextarea('competitor-seq-file', 'competitor-seq');

  // Form submit
  const form = $('prediction-form');
  if(form && !GUARDS.formBindingDone){
    bindOnce(form, 'submit', handleSubmit, 'submitGuard');
    GUARDS.formBindingDone = true;
  }

  // Advanced options + tabs
  injectAdvancedOnce();
  wireTabButtonsOnce();
});

// =====================================================
// Advanced options injection (singleton)
// =====================================================
function injectAdvancedOnce(){
  const advTab = byQS('#advanced-tab');
  if(!advTab || GUARDS.advancedInjected) return;

  // Server configuration badge
  const serverCfgId = 'server-config-note';
  ensureSingleton(
    serverCfgId,
    `
    <div id="${serverCfgId}" style="margin:8px 0;color:#333;">
      <strong>Server configuration:</strong>
      <ul style="margin:6px 0 0 16px;">
        <li>Max miRNAs per request: <code>${CONFIG.mirna_max}</code></li>
        <li>Mature trimming enabled: <code>${CONFIG.mature_trim_enabled ? 'yes' : 'no'}</code> (window: ${CONFIG.mature_window})</li>
        <li>AA→NT conversion allowed: <code>${CONFIG.aa_convert_allowed ? 'yes' : 'no'}</code></li>
        <li>Auth mode: <code>${CONFIG.use_nonce ? 'nonce' : 'open'}</code></li>
      </ul>
    </div>
    `,
    advTab
  );

  // Flags
  const flagsWrapperId = 'advanced-flags-wrapper';
  ensureSingleton(
    flagsWrapperId,
    `
    <div id="${flagsWrapperId}" style="margin-top:8px;">
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;">
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="mature-trim-flag" ${CONFIG.mature_trim_enabled ? 'checked' : ''}/>
          <span>Auto-trim miRNAs &gt; 30nt to mature-like ${CONFIG.mature_window}nt</span>
        </label>
        <label style="display:flex;gap:8px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="aa-convert-flag" ${CONFIG.aa_convert_allowed ? '' : 'disabled'}/>
          <span>Convert AA → NT (lossy; for target/competitor)</span>
        </label>
      </div>
      <small style="color:#555;">If conversion is disabled server-side, this checkbox has no effect.</small>
    </div>
    `,
    advTab
  );

  // Respect server toggle
  const aaFlag = $('aa-convert-flag');
  if(aaFlag && !CONFIG.aa_convert_allowed){
    aaFlag.disabled = true;
    aaFlag.checked = false;
  }

  GUARDS.advancedInjected = true;
}

// =====================================================
// Submit handler
// =====================================================
async function handleSubmit(event){
  event.preventDefault();

  const loader = $('loader');
  const resultsContainer = $('results-container');

  const primarySeqs   = $('primary-seqs')?.value?.trim() ?? '';
  const targetSeq     = $('target-seq')?.value?.trim() ?? '';
  const competitorSeq = $('competitor-seq')?.value?.trim() ?? '';

  // Snapshot FASTA → maps for downstream analysis
  CURRENT_INPUTS.mirnas      = parseFastaToMap(primarySeqs, 'miRNA');
  CURRENT_INPUTS.targets     = parseFastaToMap(targetSeq, 'target');
  CURRENT_INPUTS.competitors = parseFastaToMap(competitorSeq, 'competitor');

  // Clear results view
  if(resultsContainer) setHTML(resultsContainer, '');
  predictionResults = [];

  // Anti-refresh note
  prependHTML(resultsContainer, `<div class="reload-warning">
    Please do not refresh or close this page while your prediction is running — this will cancel the analysis in progress.
  </div>`);

  // Require miRNA FASTA headers
  if(!hasFastaHeaders(primarySeqs)){
    setHTML(resultsContainer, formatError(
      'Your miRNA input is missing FASTA headers. Please add lines starting with ">" (e.g., >hsa-let-7a-5p) so results can be labeled correctly.'
    ));
    return;
  }

  // Count records for ETA hint
  const mirnaCount = countFastaRecords(primarySeqs);
  let tgtCount  = countFastaRecords(targetSeq);      if(!tgtCount && targetSeq)  tgtCount  = 1;
  let compCount = countFastaRecords(competitorSeq);  if(!compCount && competitorSeq) compCount = 1;

  // Friendly info + estimated total pairs
  const estTotal = (mirnaCount || 0) * (tgtCount || 0) * (compCount || 1);
  prependHTML(resultsContainer, formatInfo(
    `Detected ${tgtCount||0} target(s) and ${compCount||0} competitor(s). Estimated evaluations: ${estTotal}.`
  ));

  // Non-blocking tips (backend enforces)
  const MIN_TARGET_LEN = 30;
  const MIN_COMP_LEN   = 15;
  if ((targetSeq.replace(/^>.*$/gm,'').replace(/\s+/g,'')).length < MIN_TARGET_LEN){
    appendHTML(resultsContainer, formatWarn(`Tip: Target should be at least ${MIN_TARGET_LEN} nt. Your input looks shorter.`));
  }
  if(competitorSeq.trim() && (competitorSeq.replace(/^>.*$/gm,'').replace(/\s+/g,'')).length < MIN_COMP_LEN){
    appendHTML(resultsContainer, formatWarn(`Tip: Competitor should be at least ${MIN_COMP_LEN} nt or leave it blank.`));
  }
  if(mirnaCount > CONFIG.mirna_max){
    setHTML(resultsContainer, formatError(
      `You entered ${mirnaCount} miRNAs, but the maximum allowed is ${CONFIG.mirna_max}. Please reduce your input and try again.`
    ));
    return;
  }
  if(tgtCount >= 1 && !hasFastaHeaders(targetSeq)){
    prependHTML(resultsContainer, formatWarn('Tip: Add FASTA headers to targets (e.g., >target1) for clean labels in results.'));
  }
  if(competitorSeq && !hasFastaHeaders(competitorSeq)){
    prependHTML(resultsContainer, formatWarn('Tip: Add FASTA headers to competitors (e.g., >comp1) for clean labels in results.'));
  }

  // Switch to results tab
  const resultsTabButton = byQS('button.tab-btn:nth-child(3)');
  if(resultsTabButton) openTab(resultsTabButton, 'results-tab');

  // Show loader
  if(loader){
    text(loader, "Running prediction...");
    show(loader);
  }

  // Build FormData
  const formData = new FormData();
  formData.append('primary_molecules', primarySeqs);
  formData.append('target_molecule', targetSeq);
  formData.append('competitor_molecule', competitorSeq);
  formData.append('target_start', $('target-start')?.value ?? '');
  formData.append('target_end',   $('target-end')?.value ?? '');

  // Flags
  const matureTrimFlag = $('mature-trim-flag')?.checked ?? CONFIG.mature_trim_enabled;
  const aaConvertFlag  = $('aa-convert-flag')?.checked ?? false;
  formData.append('mature_trim', matureTrimFlag ? 'true' : 'false');
  formData.append('convert_aa_to_nt', aaConvertFlag ? 'true' : 'false');

  // Optional 3D files
  const mirnaFileInput = $('mirna-file');
  if(mirnaFileInput && mirnaFileInput.files && mirnaFileInput.files.length > 0){
    for(const f of mirnaFileInput.files){
      if(!validateFileSize(f)){ mirnaFileInput.value=''; return; }
      formData.append('mirna_3d_file', f);
    }
  }
  const targetFile = $('target-file')?.files?.[0];
  if(targetFile){
    if(!validateFileSize(targetFile)){ $('target-file').value=''; return; }
    formData.append('target_3d_file', targetFile);
  }
  const competitorFile = $('competitor-file')?.files?.[0];
  if(competitorFile){
    if(!validateFileSize(competitorFile)){ $('competitor-file').value=''; return; }
    formData.append('competitor_3d_file', competitorFile);
  }

  try{
    const authHeaders = await getNonceOrKeyHeaders();

    // 1) Start
    if(loader) text(loader, "Job started. Preparing batches...");
    const startRes = await fetch(API_URL, { method:'POST', headers:authHeaders, body:formData });

    if(!startRes.ok){
      let errorMsg;
      try{
        const errorData = await startRes.json();
        errorMsg = errorData.message || errorData.error || null;
      }catch(_){}
      throw new Error(errorMsg || 'Something went wrong while starting your job.');
    }

    const { job_id } = await startRes.json();
    if(!job_id) throw new Error('No job ID returned from server.');

    // 2) Poll progress
    const poll = async () => {
      const res = await fetch(PROGRESS_URL(job_id), { method:'GET' });
      if(!res.ok) throw new Error('Failed to check job progress.');
      const data = await res.json();

      if(data.status === 'running'){
        if(loader){
          if(!loader.querySelector('.loader-spinner')){
            loader.innerHTML = `<span class="loader-spinner"></span><span id="loader-text"></span>`;
          }
          const loaderText = loader.querySelector('#loader-text');
          if(loaderText){
            const total     = Number.isFinite(data.total) ? data.total : '?';
            const completed = Number.isFinite(data.completed) ? data.completed : '?';
            loaderText.textContent = `Processing... ${completed}/${total} completed`;
          }
          show(loader);
        }
        setTimeout(poll, 1200);
        return;
      }

      if(data.status === 'error'){
        const rw = resultsContainer.querySelector('.reload-warning'); if(rw) rw.remove();
        throw new Error(data.error || 'We encountered a technical issue while processing your request.');
      }

      if(data.status === 'completed'){
        const rw = resultsContainer.querySelector('.reload-warning'); if(rw) rw.remove();

        if(loader) text(loader, "Fetching final results...");
        const dr = await fetch(DOWNLOAD_URL(job_id), { method:'GET' });
        if(!dr.ok) throw new Error('Failed to download results.');
        const finalData = await dr.json();

        predictionResults = finalData.results || [];
        displayResults(predictionResults);

        if(loader){
          text(loader, "✅ Prediction completed. Results are shown below.");
          setTimeout(() => hide(loader), 3000);
        }
      }
    };

    await poll();

  }catch(error){
    const rw = resultsContainer?.querySelector('.reload-warning'); if(rw) rw.remove();

    const friendly = error?.message && !/server error/i.test(error.message)
      ? error.message
      : 'Something went wrong while processing your request. Please try again later.';
    setHTML(resultsContainer, formatError(friendly));
    if(loader) hide(loader);
  }
}

// =====================================================
// Display results (sorted by baseline; gradient by baseline)
// + injects analysis controls + per-row action buttons
// =====================================================
function displayResults(results){
  const container = $('results-container');
  if(!container) return;

  setHTML(container, '');

  if(!results || results.length === 0){
    setHTML(container, '<p>No results to display.</p>');
    return;
  }

  // Inject analysis controls (singleton)
  injectAnalysisControls(container);

  // Sort by baseline desc
  results.sort((a,b) =>
    safeParseFloat(b.predicted_affinity_baseline ?? b.baseline_score ?? 0, 0) -
    safeParseFloat(a.predicted_affinity_baseline ?? a.baseline_score ?? 0, 0)
  );

  // Gradient by baseline in [0,1]
  function getGradientColor(score){
    const s = Math.max(0, Math.min(1, parseFloat(score) || 0));
    const viridis = [
      [68, 1, 84],    // #440154
      [59, 82, 139],  // #3b528b
      [33, 144, 141], // #21908d
      [93, 201, 99],  // #5dc963
      [253, 231, 37]  // #fde725
    ];
    const idx = s * (viridis.length - 1);
    const low = Math.floor(idx);
    const high= Math.min(low + 1, viridis.length - 1);
    const t   = idx - low;
    const r = Math.round(viridis[low][0] + t * (viridis[high][0] - viridis[low][0]));
    const g = Math.round(viridis[low][1] + t * (viridis[high][1] - viridis[low][1]));
    const b = Math.round(viridis[low][2] + t * (viridis[high][2] - viridis[low][2]));
    return `rgba(${r},${g},${b},0.3)`;
  }

  // Legend (singleton into results container)
  const legendId = 'affinity-legend';
  const legendHTML = `
  <div id="${legendId}" class="affinity-legend" style="margin-bottom:10px;">
    <h4>Affinity Classification Guide</h4>
    <table>
      <thead><tr><th>Category</th><th>Score Range</th><th>Interpretation</th></tr></thead>
      <tbody>
        <tr style="background-color:rgba(189,223,38,0.3)"><td>High Affinity</td><td>0.76–1.00</td><td>Strong binding; prioritized for validation</td></tr>
        <tr style="background-color:rgba(74,193,109,0.3)"><td>Medium Affinity</td><td>0.51–0.75</td><td>Moderate; candidate for confirmation</td></tr>
        <tr style="background-color:rgba(43,116,142,0.3)"><td>Low Affinity</td><td>0.26–0.50</td><td>Weak prediction</td></tr>
        <tr style="background-color:rgba(72,36,117,0.3)"><td>No Affinity</td><td>0.00–0.25</td><td>No meaningful binding</td></tr>
      </tbody>
    </table>
  </div>
  `;

  // Download + Copy buttons
  const downloadId = 'download-btn';
  const downloadButtonHTML = `<div style="margin-bottom:12px;"><button id="${downloadId}">Download Results as CSV</button> <button id="copy-results-btn" class="btn-accent">Copy Results</button></div>`;

  appendHTML(container, legendHTML);
  appendHTML(container, downloadButtonHTML);
  bindOnce($('copy-results-btn'), 'click', () => {
    // Copy TSV (stable columns as printed in table rendering)
    const hasTargetCol = (predictionResults || []).some(r => typeof r.target_id !== 'undefined');
    const hasCompCol   = (predictionResults || []).some(r => (r.competitor_id ?? '') !== '');
    const lines = predictionResults.map(item => {
      const id        = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';
      const tid       = item.target_id ?? '';
      const cid       = item.competitor_id ?? '';
      const baseline  = (item.predicted_affinity_baseline ?? item.baseline_score ?? '').toString();
      const withComp  = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? '').toString();
      const compEff   = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? '').toString();
      return [
        id,
        ...(hasTargetCol ? [tid] : []),
        ...(hasCompCol   ? [cid] : []),
        baseline, withComp, compEff
      ].join('\t');
    });
    navigator.clipboard.writeText(lines.join('\n')).then(() => alert('Results copied to clipboard.'));
  }, 'copyResultsClick');

  // Table with optional Target/Competitor columns + Analysis col
  const hasTargetCol = (results || []).some(r => typeof r.target_id !== 'undefined');
  const hasCompCol   = (results || []).some(r => (r.competitor_id ?? '') !== '');

  let table = '<table id="results-table" style="margin-bottom:20px;"><thead><tr>' +
    '<th>Primary Molecule ID</th>' +
    (hasTargetCol ? '<th>Target ID</th>' : '') +
    (hasCompCol   ? '<th>Competitor ID</th>' : '') +
    '<th>Predicted Affinity (Baseline)</th>' +
    '<th>Predicted Affinity (With Competitor)</th>' +
    '<th>Competitive Effect (higher is better)</th>' +
    '<th>Analysis</th>' +
    '</tr></thead><tbody>';

  results.forEach((item, idx) => {
    const id        = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';
    const tid       = item.target_id ?? '';
    const cid       = item.competitor_id ?? '';
    const baseline  = (item.predicted_affinity_baseline ?? item.baseline_score ?? '').toString();
    const withComp  = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? '').toString();
    const compEff   = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? '').toString();
    const bgColor   = getGradientColor(baseline);

    const seedBtn = `<button class="seed-btn" data-row="${idx}">Seed Sites</button>`;
    const heatBtn = `<button class="heatmap-btn" data-row="${idx}">Heatmap</button>`;

    table += `<tr style="background-color:${bgColor}">
      <td>${escapeHTML(id)}</td>` +
      (hasTargetCol ? `<td>${escapeHTML(tid)}</td>` : '') +
      (hasCompCol   ? `<td>${escapeHTML(cid)}</td>` : '') +
      `<td>${escapeHTML(baseline)}</td>
       <td>${escapeHTML(withComp)}</td>
       <td>${escapeHTML(compEff)}</td>
       <td>${seedBtn} ${heatBtn}</td>
    </tr>`;
  });

  table += '</tbody></table>';
  appendHTML(container, table);
  makeTableSortable('results-table');

  // Bind CSV download
  const dl = $(downloadId);
  if(dl) bindOnce(dl, 'click', downloadCSV, 'clickOnce');

  // Delegate click handlers for action buttons
  const resultsTable = $('results-table');
  if(resultsTable){
    bindOnce(resultsTable, 'click', async (e) => {
      const t = e.target;
      if(!(t instanceof HTMLElement)) return;
      const rowIdx = t.dataset?.row ? parseInt(t.dataset.row, 10) : NaN;
      if(Number.isNaN(rowIdx) || !predictionResults[rowIdx]) return;
      const item = predictionResults[rowIdx];

      if(t.classList.contains('seed-btn')){
        await handleSeedSitesClick(item);
      }else if(t.classList.contains('heatmap-btn')){
        await handleHeatmapClick(item);
      }
    }, 'resultsActions');
  }
}

// Inject analysis controls (GU wobble + mismatch cap)
function injectAnalysisControls(parent){
  if(GUARDS.analysisControlsInjected) return;

  const controlsId = 'analysis-controls';
  ensureSingleton(
    controlsId,
    `
    <div id="${controlsId}" style="display:flex;gap:16px;align-items:center;margin:8px 0 14px 0;flex-wrap:wrap;">
      <label style="display:flex;gap:6px;align-items:center;">
        <input type="checkbox" id="allow-gu" checked />
        <span>Allow GU wobble</span>
      </label>
      <label style="display:flex;gap:6px;align-items:center;">
        <span>Max mismatches:</span>
        <select id="max-mm">
          <option value="0" selected>0</option>
          <option value="1">1</option>
        </select>
      </label>
      <small style="color:#555;">Seed scanning matches canonical 6/7/8mer rules; coordinates are 1-based on the (possibly sliced) target sequence.</small>
    </div>
    `,
    parent
  );
  GUARDS.analysisControlsInjected = true;
}

// =====================================================
// CSV download (sorted by baseline for consistency)
// =====================================================
function downloadCSV(){
  if(predictionResults.length === 0) return;

  const hasTargetCol = (predictionResults || []).some(r => typeof r.target_id !== 'undefined');
  const hasCompCol   = (predictionResults || []).some(r => (r.competitor_id ?? '') !== '');

  const headers = [
    "Primary_Molecule_ID",
    ...(hasTargetCol ? ["Target_ID"] : []),
    ...(hasCompCol   ? ["Competitor_ID"] : []),
    "Predicted_Affinity_Baseline",
    "Predicted_Affinity_With_Competitor",
    "Competitive_Effect"
  ].join(',');

  const csvRows = [headers];

  const sorted = [...predictionResults].sort((a,b) =>
    safeParseFloat(b["predicted_affinity_baseline"] ?? b.baseline_score ?? 0, 0) -
    safeParseFloat(a["predicted_affinity_baseline"] ?? a.baseline_score ?? 0, 0)
  );

  sorted.forEach(item => {
    const id  = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';
    const tid = item.target_id ?? '';
    const cid = item.competitor_id ?? '';
    const baseline   = (item.predicted_affinity_baseline ?? item.baseline_score ?? '').toString();
    const withComp   = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? '').toString();
    const compEffect = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? '').toString();

    const cells = [
      id,
      ...(hasTargetCol ? [tid] : []),
      ...(hasCompCol   ? [cid] : []),
      baseline, withComp, compEffect
    ].map(s => {
      const str = String(s ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g,'""')}"` : str;
    });

    csvRows.push(cells.join(','));
  });

  const csvString = csvRows.join('\n');
  const blob = new Blob([csvString], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'prediction_results.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// =====================================================
// Tabs / helpers
// =====================================================
function openTab(element, tabId){
  const targetCard = $(tabId);
  if(!targetCard) return;
  byQSA('.card').forEach(card => card.classList.remove('active'));
  byQSA('.tab-btn').forEach(btn => btn.classList.remove('active'));
  targetCard.classList.add('active');
  if(element && element.classList) element.classList.add('active');
}

function makeTableSortable(tableId){
  const table = document.getElementById(tableId);
  if(!table) return;
  table.querySelectorAll('th').forEach((header, idx) => {
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      const asc  = header.classList.toggle('asc');
      rows.sort((a,b) => {
        const aText = a.children[idx].textContent.trim();
        const bText = b.children[idx].textContent.trim();
        // numeric-aware compare
        const na = parseFloat(aText), nb = parseFloat(bText);
        if(!Number.isNaN(na) && !Number.isNaN(nb)){
          return asc ? na - nb : nb - na;
        }
        return asc ? aText.localeCompare(bText) : bText.localeCompare(aText);
      });
      const tbody = table.querySelector('tbody');
      rows.forEach(row => tbody.appendChild(row));
    });
  });
}

function wireTabButtonsOnce(){
  if(GUARDS.tabWiringDone) return;
  const tabs = byQSA('.tab-btn');
  const loader = $('loader');

  tabs.forEach(btn => {
    bindOnce(btn, 'click', () => {
      const name = (btn.textContent || '').toLowerCase();
      if(name.includes('inputs')){
        if(loader){
          text(loader, "Please input your sequences to start a prediction.");
          show(loader);
        }
      }
      if(name.includes('results')){
        const rc = $('results-container');
        if(rc && !rc.innerHTML.trim()){
          setHTML(rc, formatInfo('Results will appear here after you run a prediction.'));
        }
      }
    }, 'tabClick');
  });

  GUARDS.tabWiringDone = true;
}

// =====================================================
// Modal (singleton)
// =====================================================
function ensureModal(){
  if(GUARDS.modalInjected) return;
  const body = document.body;
  ensureSingleton(
    'analysis-modal',
    `
    <div id="analysis-modal" style="position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:9999;">
      <div data-overlay style="position:absolute;inset:0;background:rgba(0,0,0,0.45);"></div>
      <div data-panel style="position:relative;max-width:980px;width:96%;max-height:86vh;overflow:auto;background:#fff;border-radius:12px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,0.3);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
          <h3 id="modal-title" style="margin:0;">Analysis</h3>
          <button id="modal-close" aria-label="Close">✕</button>
        </div>
        <div id="modal-content"></div>
      </div>
    </div>
    `,
    body
  );
  const modal = $('analysis-modal');
  const closeBtn = $('modal-close');
  const overlay = modal?.querySelector('[data-overlay]');
  if(closeBtn) bindOnce(closeBtn,'click',closeModal,'mclose');
  if(overlay)  bindOnce(overlay,'click',closeModal,'moverlay');
  GUARDS.modalInjected = true;
}
function openModal(title, html){
  ensureModal();
  const modal = $('analysis-modal');
  if(!modal) return;
  text($('modal-title'), title || 'Analysis');
  setHTML($('modal-content'), html || '');
  modal.style.display = 'flex';
}
function closeModal(){
  const modal = $('analysis-modal');
  if(modal) modal.style.display = 'none';
}

// =====================================================
// Seed Sites (exact base-level coordinates) — RANGE-AWARE
// =====================================================
async function handleSeedSitesClick(item){
  try{
    const allowGU = byQS('#allow-gu')?.checked ?? true;
    const maxMM   = parseInt(byQS('#max-mm')?.value ?? '0', 10);

    const mirnaId = item.primary_molecule_id ?? item.mirna_id;
    const targetId= item.target_id ?? '';
    const compId  = item.competitor_id ?? '';

    const mirnaSeq = CURRENT_INPUTS.mirnas[mirnaId];
    // Use general helper so both targets and (if ever ranged) competitors are sliced consistently
    const targetSeq= getAnySeqForId(targetId, CURRENT_INPUTS.targets);
    const compSeq  = compId ? getAnySeqForId(compId, CURRENT_INPUTS.competitors) : '';

    if(!mirnaSeq || !targetSeq){
      openModal('Seed Sites', formatError('Could not resolve miRNA and/or target sequences for this row. Please ensure IDs match your FASTA headers.'));
      return;
    }

    const payload = {
      mirna_seq: mirnaSeq,
      targets: { [targetId]: targetSeq },
      competitors: compSeq ? { [compId]: compSeq } : {},
      allow_gu: !!allowGU,
      max_mismatch: Number.isFinite(maxMM) ? maxMM : 0
    };

    const headers = await getNonceOrKeyHeaders();
    const res = await fetch(SEED_SCAN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload)
    });

    if(!res.ok){
      let msg = 'Seed scanning failed.';
      try{ const j = await res.json(); msg = j.error || msg; }catch(_){}
      openModal('Seed Sites', formatError(msg));
      return;
    }

    const data = await res.json();
    let hits = Array.isArray(data.hits) ? data.hits : [];

    if(hits.length === 0){
      openModal('Seed Sites', `<p>No canonical seed matches found under current settings (GU=${allowGU ? 'on':'off'}, max mismatch=${maxMM}).</p>`);
      return;
    }

    // If target/competitor IDs have :start-end, compute global (unsliced) coordinates
    const tRange = parseIdRange(targetId);
    const cRange = compId ? parseIdRange(compId) : null;

    // Enrich hits with global coords when applicable
    hits = hits.map(h => {
      if(h.molecule === 'target' && tRange){
        const g = globalCoordForId(targetId, h.start, h.end);
        return { ...h, global_start: g.globalStart, global_end: g.globalEnd };
      }
      if(h.molecule === 'competitor' && cRange){
        const g = globalCoordForId(compId, h.start, h.end);
        return { ...h, global_start: g.globalStart, global_end: g.globalEnd };
      }
      return h;
    });

    // Build table (shows global columns only if any range existed)
    const showGlobalCols = !!(tRange || cRange);

    let html = `<div style="margin-bottom:8px;">Found <b>${hits.length}</b> seed-site hit(s). Coordinates are 1-based on the displayed sequence${showGlobalCols ? ' and global positions are shown when a :start-end range was applied' : ''}.</div>`;
    html += `<table style="width:100%;border-collapse:collapse;">
      <thead>
        <tr style="text-align:left;border-bottom:1px solid #ddd;">
          <th>Molecule</th><th>ID</th><th>Start</th><th>End</th>${showGlobalCols ? '<th>Global Start</th><th>Global End</th>' : ''}<th>Seed</th><th>Type</th><th>Wobble</th><th>Mismatches</th><th>Upstream</th>
        </tr>
      </thead>
      <tbody>`;
    hits.forEach(h => {
      html += `<tr style="border-bottom:1px solid #f0f0f0;">
        <td>${escapeHTML(h.molecule)}</td>
        <td>${escapeHTML(h.id)}</td>
        <td>${h.start}</td>
        <td>${h.end}</td>
        ${showGlobalCols ? `<td>${h.global_start ?? ''}</td><td>${h.global_end ?? ''}</td>` : ''}
        <td>${h.seed_len}</td>
        <td>${escapeHTML(h.seed_type || '')}</td>
        <td>${h.wobble ?? 0}</td>
        <td>${h.mismatches ?? 0}</td>
        <td>${escapeHTML(h.upstream_base ?? '')}</td>
      </tr>`;
    });
    html += `</tbody></table>`;

    openModal('Seed Sites', html);

  }catch(err){
    openModal('Seed Sites', formatError(err?.message || 'Unexpected error during seed scan.'));
  }
}

// =====================================================
// Heatmap (Integrated Gradients saliency) — RANGE-AWARE inputs
// =====================================================
async function handleHeatmapClick(item){
  try{
    const mirnaId = item.primary_molecule_id ?? item.mirna_id;
    const targetId= item.target_id ?? '';
    const compId  = item.competitor_id ?? '';

    const mirnaSeq = CURRENT_INPUTS.mirnas[mirnaId];
    const targetSeq= getAnySeqForId(targetId, CURRENT_INPUTS.targets);
    const compSeq  = compId ? getAnySeqForId(compId, CURRENT_INPUTS.competitors) : '';

    if(!mirnaSeq || !targetSeq){
      openModal('Heatmap', formatError('Could not resolve miRNA and/or target sequences for this row.'));
      return;
    }

    const headers = await getNonceOrKeyHeaders();
    const res = await fetch(EXPLAIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        mirna_seq: mirnaSeq,
        target_seq: targetSeq,
        competitor_seq: compSeq || undefined
      })
    });

    if(!res.ok){
      let msg = 'Explanation failed.';
      try{ const j = await res.json(); msg = j.error || msg; }catch(_){}
      openModal('Heatmap', formatError(msg));
      return;
    }

    const data = await res.json();
    const targAttr = Array.isArray(data.target_attrib) ? data.target_attrib : [];
    const compAttr = Array.isArray(data.competitor_attrib) ? data.competitor_attrib : null;

    // Trim to actual seq lengths (model returns fixed-length arrays)
    const targAttrTrim = targAttr.slice(0, targetSeq.length);
    const compAttrTrim = compSeq && compAttr ? compAttr.slice(0, compSeq.length) : null;

    // Build content
    let html = '';
    html += renderAttributionPanel('Target', targetSeq, targAttrTrim);
    if(compSeq){
      html += `<div style="height:12px;"></div>`;
      html += renderAttributionPanel('Competitor', compSeq, compAttrTrim || []);
    }

    openModal('Heatmap (Integrated Gradients)', html);

  }catch(err){
    openModal('Heatmap', formatError(err?.message || 'Unexpected error during explanation.'));
  }
}

// Render one attribution panel (mini heat-strip + top peaks)
function renderAttributionPanel(label, seq, attrib){
  if(!Array.isArray(attrib) || attrib.length === 0){
    return `<div><h4 style="margin:6px 0;">${escapeHTML(label)}</h4><p>No attribution available.</p></div>`;
  }
  const max = Math.max(1e-12, ...attrib.map(v => Math.abs(v)));
  const norm = attrib.map(v => Math.abs(v) / max);

  // Build heat strip (monospace cells)
  let strip = `<div style="font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px;">`;
  strip += `<div style="white-space:nowrap;">`;
  for(let i=0;i<seq.length;i++){
    const v = norm[i] || 0;
    const color = viridisColor(v, 0.85);
    strip += `<span title="pos ${i+1} • ${seq[i]} • ${v.toFixed(3)}" style="display:inline-block;min-width:10px;padding:2px 0;text-align:center;background:${color};color:#000;border-radius:2px;margin:0 1px;">${escapeHTML(seq[i] || '')}</span>`;
  }
  strip += `</div></div>`;

  // Top-5 peaks
  const idxs = norm.map((v,i)=>({i,v})).sort((a,b)=>b.v-a.v).slice(0,5);
  const peaks = idxs.map(o => `pos ${o.i+1} (${escapeHTML(seq[o.i]||'')}) → ${o.v.toFixed(3)}`).join(', ');

  return `
    <div>
      <h4 style="margin:6px 0;">${escapeHTML(label)}</h4>
      ${strip}
      <div style="margin-top:6px;color:#333;"><strong>Top positions:</strong> ${peaks}</div>
      <small style="color:#666;">Color scale is relative within each sequence (min→max saliency, Viridis).</small>
    </div>
  `;
}

// Viridis color helper for heatmaps (0..1 → rgba)
function viridisColor(t, alpha=1.0){
  const lut = [
    [68,1,84],[71,44,122],[59,82,139],[44,113,142],[33,144,141],[39,173,129],[92,200,99],[170,220,50],[253,231,37]
  ];
  const x = Math.max(0, Math.min(1, t)) * (lut.length-1);
  const i = Math.floor(x);
  const j = Math.min(i+1, lut.length-1);
  const f = x - i;
  const r = Math.round(lut[i][0] + f*(lut[j][0]-lut[i][0]));
  const g = Math.round(lut[i][1] + f*(lut[j][1]-lut[i][1]));
  const b = Math.round(lut[i][2] + f*(lut[j][2]-lut[i][2]));
  return `rgba(${r},${g},${b},${alpha})`;
}

// =====================================================
// Guard for missing elements (console hint, no crash)
// =====================================================
(function guardMissingElements(){
  const form = $('prediction-form');
  if(!form) console.warn("Prediction form not found on page.");
})();
