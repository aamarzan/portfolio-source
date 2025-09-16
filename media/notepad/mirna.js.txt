// mirna.js (Upgraded & Backend-Ready)

// Global variable to hold results for the download function
let predictionResults = [];

// === CONFIGURE API BASE URL ===
const LOCAL_API = "http://127.0.0.1:8080/predict";
const PROD_API = "https://mirna.aamarzan.com/predict";
const API_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? LOCAL_API
    : PROD_API;
const API_KEY = "supersecret123";

const MAX_FILE_SIZE_MB = 100;
const MAX_MIRNAS = 1000; // lifted single-run cap

document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('loader');
    if (loader) {
        loader.textContent = "Please input your sequences to start a prediction.";
        loader.classList.remove('hidden');
    }

    // Bind sequence file inputs to textareas
    bindFileToTextarea('mirna-seq-file', 'primary-seqs');
    bindFileToTextarea('target-seq-file', 'target-seq');
    bindFileToTextarea('competitor-seq-file', 'competitor-seq');
});

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

    fileInput.addEventListener('change', function () {
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
    for (const line of lines) {
        if (line.startsWith('>')) count++;
    }
    if (count === 0 && seqText.trim().length > 0) count = 1;
    return count;
}

document.getElementById('prediction-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    const loader = document.getElementById('loader');
    const resultsContainer = document.getElementById('results-container');

    const primarySeqs = document.getElementById('primary-seqs').value.trim();
    const targetSeq = document.getElementById('target-seq').value.trim();
    const competitorSeq = document.getElementById('competitor-seq').value.trim();

    // Limit check for miRNA count
    const mirnaCount = countFastaRecords(primarySeqs);
    if (mirnaCount > MAX_MIRNAS) {
        resultsContainer.innerHTML = `<p style="color: red;">
            You entered ${mirnaCount} miRNAs, but the maximum allowed is ${MAX_MIRNAS}.
            Please reduce your input and try again.
        </p>`;
        return;
    }

    // Validate target/competitor counts
    if (countFastaRecords(targetSeq) > 1) {
        resultsContainer.innerHTML = '<p style="color: red;">Please enter only one target sequence.</p>';
        return;
    }
    if (countFastaRecords(competitorSeq) > 1) {
        resultsContainer.innerHTML = '<p style="color: red;">Please enter only one competitor sequence.</p>';
        return;
    }

    // Switch to results tab
    const resultsTabButton = document.querySelector('button[onclick*="results-tab"]');
    if (resultsTabButton) openTab(resultsTabButton, 'results-tab');

    // Show loader
    if (loader) {
        loader.textContent = "Running prediction...";
        loader.classList.remove('hidden');
    }
    resultsContainer.innerHTML = '';
    predictionResults = [];

    const formData = new FormData();
    formData.append('primary_molecules', primarySeqs);
    formData.append('target_molecule', targetSeq);
    formData.append('competitor_molecule', competitorSeq);
    formData.append('target_start', document.getElementById('target-start')?.value ?? '');
    formData.append('target_end', document.getElementById('target-end')?.value ?? '');

    // Get optional PDB/CIF files
    const mirnaFile = document.getElementById('mirna-file')?.files?.[0];
    const targetFile = document.getElementById('target-file')?.files?.[0];
    const competitorFile = document.getElementById('competitor-file')?.files?.[0];

    // Validate sizes
    if (mirnaFile && !validateFileSize(mirnaFile)) {
        document.getElementById('mirna-file').value = '';
        return;
    }
    if (targetFile && !validateFileSize(targetFile)) {
        document.getElementById('target-file').value = '';
        return;
    }
    if (competitorFile && !validateFileSize(competitorFile)) {
        document.getElementById('competitor-file').value = '';
        return;
    }

    if (mirnaFile) formData.append('mirna_3d_file', mirnaFile);
    if (targetFile) formData.append('target_3d_file', targetFile);
    if (competitorFile) formData.append('competitor_3d_file', competitorFile);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { "X-API-Key": API_KEY },
            body: formData
        });

        if (!response.ok) {
            let errorMsg;
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || null;
            } catch (_) {}
            throw new Error(errorMsg || 'Something went wrong while processing your request. Please try again later.');
        }

        const data = await response.json();
        predictionResults = data.results; // Save only the results array
        displayResults(data.results);

        if (loader) {
            if (data.status === "completed") {
                loader.textContent = "✅ Prediction completed. Results are shown below.";
            } else {
                loader.textContent = "ℹ️ Prediction finished.";
            }
            setTimeout(() => loader.classList.add('hidden'), 3000);
        }

    } catch (error) {
        const friendlyMessage = error.message && !error.message.includes('server error')
            ? error.message
            : 'Something went wrong while processing your request. Please try again later.';
        resultsContainer.innerHTML = `<p style="color: red;">${friendlyMessage}</p>`;
        if (loader) loader.classList.add('hidden');
    }
});

function displayResults(results) {
    const container = document.getElementById('results-container');
    if (!results || results.length === 0) {
        container.innerHTML = '<p>No results to display.</p>';
        return;
    }

    let table = '<table><thead><tr>' +
        '<th>Primary Molecule ID</th>' +
        '<th>Predicted Affinity (Baseline)</th>' +
        '<th>Predicted Affinity (With Competitor)</th>' +
        '<th>Competitive Effect (higher is better)</th>' +
        '</tr></thead><tbody>';

    results.forEach(item => {
        const id = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';
        const baseline = item.predicted_affinity_baseline ?? item.baseline_score ?? '';
        const withComp = item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? '';
        const compEffect = item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? '';

        table += `<tr>
            <td>${id}</td>
            <td>${baseline}</td>
            <td>${withComp}</td>
            <td>${compEffect}</td>
        </tr>`;
    });
    table += '</tbody></table>';

    const downloadButton = '<button id="download-btn">Download Results as CSV</button>';
    container.innerHTML = table + downloadButton;

    document.getElementById('download-btn').addEventListener('click', downloadCSV);
}

function downloadCSV() {
    if (predictionResults.length === 0) return;

    const headers = "Primary_Molecule_ID,Predicted_Affinity_Baseline,Predicted_Affinity_With_Competitor,Competitive_Effect";
    const csvRows = [headers];

    predictionResults.forEach(item => {
        const id = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';
        const baseline = (item.predicted_affinity_baseline ?? item.baseline_score ?? '').toString();
        const withComp = (item.predicted_affinity_with_competitor ?? item.score_with_competitor ?? '').toString();
        const compEffect = (item["competitive_effect (higher_is_better)"] ?? item.competitive_effect ?? '').toString();

        csvRows.push([id, baseline, withComp, compEffect].join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', 'prediction_results.csv');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// Tabs function (kept from your original)
function openTab(element, tabId) {
    document.querySelectorAll('.card').forEach(card => card.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    element.classList.add('active');
}