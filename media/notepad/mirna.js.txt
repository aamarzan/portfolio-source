// mirna.js (Final, cleaned, and production ready)

// Global state
let predictionResults = [];

// === CONFIGURE API BASE URL ===
const LOCAL_API = "http://127.0.0.1:8080/predict";
const PROD_API = "https://mirna.aamarzan.com/predict";
const API_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? LOCAL_API
    : PROD_API;
const API_KEY = "supersecret123";

const MAX_FILE_SIZE_MB = 100;
const MAX_MIRNAS = 1000;

// DOM ready
document.addEventListener("DOMContentLoaded", () => {
  const loader = document.getElementById("loader");
  if (loader) {
    loader.textContent = "Please input your sequences to start a prediction.";
    loader.classList.remove("hidden");
  }

  // Bind sequence file inputs to textareas
  bindFileToTextarea("mirna-seq-file", "primary-seqs");
  bindFileToTextarea("target-seq-file", "target-seq");
  bindFileToTextarea("competitor-seq-file", "competitor-seq");

  // Optional: clear results on input change
  ["primary-seqs", "target-seq", "competitor-seq"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      const c = document.getElementById("results-container");
      if (c) c.innerHTML = "";
    });
  });
});

// ----- Helpers -----

function validateFileSize(file) {
  if (file && file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    alert(`File "${file.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
    return false;
  }
  return true;
}

function bindFileToTextarea(fileInputId, textareaId) {
  const fileInput = document.getElementById(fileInputId);
  const textarea = document.getElementById(textareaId);
  if (!fileInput || !textarea) return;

  fileInput.addEventListener("change", function () {
    const file = this.files && this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      textarea.value = (e.target.result || "").trim();
    };
    reader.readAsText(file);
  });
}

// Count FASTA records or treat non-empty raw text as one record
function countFastaRecords(seqText) {
  if (!seqText) return 0;
  const lines = seqText.trim().split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (line.startsWith(">")) count++;
  }
  if (count === 0 && seqText.trim().length > 0) count = 1;
  return count;
}

function disableForm(disabled) {
  const form = document.getElementById("prediction-form");
  if (!form) return;
  Array.from(form.elements).forEach((el) => {
    if (el && typeof el.disabled !== "undefined") el.disabled = disabled;
  });
}

// Escape CSV cell
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ----- Prediction submit -----

document.getElementById("prediction-form").addEventListener("submit", async function (event) {
  event.preventDefault();

  const loader = document.getElementById("loader");
  const resultsContainer = document.getElementById("results-container");
  const submitBtn = this.querySelector('button[type="submit"]');

  const primarySeqs = (document.getElementById("primary-seqs").value || "").trim();
  const targetSeq = (document.getElementById("target-seq").value || "").trim();
  const competitorSeq = (document.getElementById("competitor-seq").value || "").trim();

  // Validate counts
  const mirnaCount = countFastaRecords(primarySeqs);
  if (mirnaCount === 0) {
    resultsContainer.innerHTML = '<p style="color: red;">Please add at least one miRNA sequence.</p>';
    return;
  }
  if (mirnaCount > MAX_MIRNAS) {
    resultsContainer.innerHTML = `<p style="color: red;">
      You entered ${mirnaCount} miRNAs, but the maximum allowed is ${MAX_MIRNAS}.
      Please reduce your input and try again.
    </p>`;
    return;
  }
  if (countFastaRecords(targetSeq) !== 1) {
    resultsContainer.innerHTML = '<p style="color: red;">Please enter exactly one target sequence.</p>';
    return;
  }
  if (countFastaRecords(competitorSeq) > 1) {
    resultsContainer.innerHTML = '<p style="color: red;">Please enter only one competitor sequence.</p>';
    return;
  }

  // Switch to results tab if present
  const resultsTabButton = document.querySelector('button[onclick*="results-tab"]');
  if (resultsTabButton) openTab(resultsTabButton, "results-tab");

  // Prepare form data
  const formData = new FormData();
  formData.append("primary_molecules", primarySeqs);
  formData.append("target_molecule", targetSeq);
  formData.append("competitor_molecule", competitorSeq);
  formData.append("target_start", document.getElementById("target-start")?.value ?? "");
  formData.append("target_end", document.getElementById("target-end")?.value ?? "");

  // Optional structure files
  const mirnaFile = document.getElementById("mirna-file")?.files?.[0];
  const targetFile = document.getElementById("target-file")?.files?.[0];
  const competitorFile = document.getElementById("competitor-file")?.files?.[0];

  if (mirnaFile && !validateFileSize(mirnaFile)) {
    document.getElementById("mirna-file").value = "";
    return;
  }
  if (targetFile && !validateFileSize(targetFile)) {
    document.getElementById("target-file").value = "";
    return;
  }
  if (competitorFile && !validateFileSize(competitorFile)) {
    document.getElementById("competitor-file").value = "";
    return;
  }

  if (mirnaFile) formData.append("mirna_3d_file", mirnaFile);
  if (targetFile) formData.append("target_3d_file", targetFile);
  if (competitorFile) formData.append("competitor_3d_file", competitorFile);

  // UI state
  resultsContainer.innerHTML = "";
  predictionResults = [];
  if (loader) {
    loader.textContent = "Running prediction...";
    loader.classList.remove("hidden");
  }
  disableForm(true);
  if (submitBtn) submitBtn.textContent = "Running...";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "X-API-Key": API_KEY },
      body: formData
    });

    // Handle common non-200s with clearer messages
    if (!response.ok) {
      let errorMsg = "";
      try {
        const errorData = await response.json();
        errorMsg = errorData?.error || "";
      } catch {
        // not JSON, leave empty
      }
      if (!errorMsg) {
        if (response.status === 401) errorMsg = "Unauthorized. Please check your API key.";
        else if (response.status === 413) errorMsg = `Payload too large. Keep under ${MAX_FILE_SIZE_MB} MB and 1000 miRNAs.`;
        else if (response.status === 400) errorMsg = "Invalid input. Please check your sequences and try again.";
        else errorMsg = "Something went wrong while processing your request. Please try again later.";
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    predictionResults = results;
    displayResults(results);

    if (loader) {
      loader.textContent =
        data?.status === "completed"
          ? "✅ Prediction completed. Results are shown below."
          : "ℹ️ Prediction finished.";
      setTimeout(() => loader.classList.add("hidden"), 3000);
    }
  } catch (error) {
    const msg =
      error?.message && !/server error/i.test(error.message)
        ? error.message
        : "Something went wrong while processing your request. Please try again later.";
    resultsContainer.innerHTML = `<p style="color: red;">${msg}</p>`;
    if (loader) loader.classList.add("hidden");
  } finally {
    disableForm(false);
    if (submitBtn) submitBtn.textContent = "Run prediction";
  }
});

// ----- Results rendering -----

function displayResults(results) {
  const container = document.getElementById("results-container");
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = "<p>No results to display.</p>";
    return;
  }

  // Non-destructive sorted view for UX (descending competitive effect)
  const sorted = [...results].sort((a, b) => {
    const av =
      Number(a["competitive_effect (higher_is_better)"] ?? a.competitive_effect ?? 0);
    const bv =
      Number(b["competitive_effect (higher_is_better)"] ?? b.competitive_effect ?? 0);
    return bv - av;
  });

  let table =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
    '<div style="font-weight:600;">Results</div>' +
    '<div>' +
    '<button id="download-btn" style="margin-right:8px;">Download CSV</button>' +
    '<button id="toggle-sort-btn">Toggle original/sorted view</button>' +
    "</div></div>";

  table += buildResultsTable(sorted);

  container.innerHTML = table;

  document.getElementById("download-btn")?.addEventListener("click", downloadCSV);

  // Toggle between sorted and original to help users correlate to their input order
  const toggleBtn = document.getElementById("toggle-sort-btn");
  if (toggleBtn) {
    let showingSorted = true;
    toggleBtn.addEventListener("click", () => {
      showingSorted = !showingSorted;
      const rows = showingSorted ? sorted : predictionResults;
      container.innerHTML =
        container.innerHTML.split("</div></div>")[0] + // preserve header controls
        "</div></div>" +
        buildResultsTable(rows);
      document.getElementById("download-btn")?.addEventListener("click", downloadCSV);
    });
  }
}

function buildResultsTable(rows) {
  let html =
    "<table><thead><tr>" +
    "<th>Primary Molecule ID</th>" +
    "<th>Predicted Affinity (Baseline)</th>" +
    "<th>Predicted Affinity (With Competitor)</th>" +
    "<th>Competitive Effect (higher is better)</th>" +
    "</tr></thead><tbody>";

  rows.forEach((item) => {
    const id = item.primary_molecule_id ?? item.mirna_id ?? "N/A";
    const baseline = item.predicted_affinity_baseline ?? item.baseline_score ?? "";
    const withComp =
      item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? "";
    const compEffect =
      item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? "";

    // Keep formatting flexible: numeric to fixed, else pass-through
    const fmt = (v) =>
      typeof v === "number" && isFinite(v) ? v.toFixed(10) : String(v);

    html += `<tr>
      <td>${id}</td>
      <td>${fmt(baseline)}</td>
      <td>${fmt(withComp)}</td>
      <td>${fmt(compEffect)}</td>
    </tr>`;
  });

  html += "</tbody></table>";
  return html;
}

// ----- CSV Download -----

function downloadCSV() {
  if (!predictionResults || predictionResults.length === 0) return;

  const headers = [
    "Primary_Molecule_ID",
    "Predicted_Affinity_Baseline",
    "Predicted_Affinity_With_Competitor",
    "Competitive_Effect"
  ];
  const csvRows = [headers.join(",")];

  predictionResults.forEach((item) => {
    const id = item.primary_molecule_id ?? item.mirna_id ?? "N/A";
    const baseline = item.predicted_affinity_baseline ?? item.baseline_score ?? "";
    const withComp =
      item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? "";
    const compEffect =
      item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? "";

    csvRows.push(
      [
        csvEscape(id),
        csvEscape(baseline),
        csvEscape(withComp),
        csvEscape(compEffect)
      ].join(",")
    );
  });

  const csvString = csvRows.join("\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "prediction_results.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ----- Tabs function (kept from your original) -----

function openTab(element, tabId) {
  document.querySelectorAll(".card").forEach((card) => card.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  element.classList.add("active");
}
