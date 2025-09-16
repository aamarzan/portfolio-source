// mirna.js — single-pass version matching the pre-batching backend

let predictionResults = [];

const LOCAL_API = "http://127.0.0.1:8080/predict";
const PROD_API = "https://mirna.aamarzan.com/predict";
const API_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? LOCAL_API
    : PROD_API;
const API_KEY = "supersecret123";

const MAX_FILE_SIZE_MB = 100;
const MAX_MIRNAS = 1000;

document.addEventListener("DOMContentLoaded", () => {
  const loader = document.getElementById("loader");
  if (loader) {
    loader.textContent = "Please input your sequences to start a prediction.";
    loader.classList.remove("hidden");
  }

  bindFileToTextarea("mirna-seq-file", "primary-seqs");
  bindFileToTextarea("target-seq-file", "target-seq");
  bindFileToTextarea("competitor-seq-file", "competitor-seq");
});

function bindFileToTextarea(fileInputId, textareaId) {
  const fileInput = document.getElementById(fileInputId);
  const textarea = document.getElementById(textareaId);
  if (!fileInput || !textarea) return;

  fileInput.addEventListener("change", function () {
    const file = this.files && this.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      alert(`File "${file.name}" exceeds ${MAX_FILE_SIZE_MB} MB limit.`);
      this.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      textarea.value = (e.target.result || "").trim();
    };
    reader.readAsText(file);
  });
}

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

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

document.getElementById("prediction-form").addEventListener("submit", async function (event) {
  event.preventDefault();

  const loader = document.getElementById("loader");
  const resultsContainer = document.getElementById("results-container");
  const submitBtn = this.querySelector('button[type="submit"]');

  const primarySeqs = (document.getElementById("primary-seqs").value || "").trim();
  const targetSeq = (document.getElementById("target-seq").value || "").trim();
  const competitorSeq = (document.getElementById("competitor-seq").value || "").trim();

  const mirnaCount = countFastaRecords(primarySeqs);
  if (mirnaCount === 0) {
    resultsContainer.innerHTML = '<p style="color: red;">Please add at least one miRNA sequence.</p>';
    return;
  }
  if (mirnaCount > MAX_MIRNAS) {
    resultsContainer.innerHTML = `<p style="color: red;">
      You entered ${mirnaCount} miRNAs, but the maximum allowed is ${MAX_MIRNAS}.
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

  const resultsTabButton = document.querySelector('button[onclick*="results-tab"]');
  if (resultsTabButton) openTab(resultsTabButton, "results-tab");

  const formData = new FormData();
  formData.append("primary_molecules", primarySeqs);
  formData.append("target_molecule", targetSeq);
  formData.append("competitor_molecule", competitorSeq);

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

    if (!response.ok) {
      let errorMsg = "";
      try {
        const errorData = await response.json();
        errorMsg = errorData?.error || "";
      } catch {}
      if (!errorMsg) {
        if (response.status === 401) errorMsg = "Unauthorized. Please check your API key.";
        else if (response.status === 413) errorMsg = `Payload too large. Keep under ${MAX_FILE_SIZE_MB} MB.`;
        else if (response.status === 400) errorMsg = "Invalid input. Please check your sequences.";
        else errorMsg = "Something went wrong while processing your request.";
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    const results = Array.isArray(data?.results) ? data.results : [];

    predictionResults = results;
    displayResults(results);

    if (loader) {
      loader.textContent = "✅ Prediction completed. Results are shown below.";
      setTimeout(() => loader.classList.add("hidden"), 3000);
    }
  } catch (error) {
    resultsContainer.innerHTML = `<p style="color: red;">${error.message}</p>`;
    if (loader) loader.classList.add("hidden");
  } finally {
    disableForm(false);
    if (submitBtn) submitBtn.textContent = "Run prediction";
  }
});

function displayResults(results) {
  const container = document.getElementById("results-container");
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = "<p>No results to display.</p>";
    return;
  }

  let html =
    "<table><thead><tr>" +
    "<th>Primary Molecule ID</th>" +
    "<th>Predicted Affinity (Baseline)</th>" +
    "<th>Predicted Affinity (With Competitor)</th>" +
    "<th>Competitive Effect (higher is better)</th>" +
    "</tr></thead><tbody>";

  results.forEach((item) => {
    const id = item.primary_molecule_id ?? item.mirna_id ?? "N/A";
    const baseline = item.predicted_affinity_baseline ?? "";
    const withComp = item.predicted_affinity_with_competitor ?? "";
    const compEffect = item["competitive_effect (higher_is_better)"] ?? "";

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
  html += '<button id="download-btn">Download CSV</button>';
  container.innerHTML = html;

  document.getElementById("download-btn")?.addEventListener("click", downloadCSV);
}

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
    const baseline = item.predicted_affinity_baseline ?? "";
    const withComp = item.predicted_affinity_with_competitor ?? "";
    const compEffect = item["competitive_effect (higher_is_better)"] ?? "";

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

// ----- Tabs function -----
function openTab(element, tabId) {
  document.querySelectorAll(".card").forEach((card) => card.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
  document.getElementById(tabId).classList.add("active");
  element.classList.add("active");
}
