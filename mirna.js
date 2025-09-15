// mirna.js (Upgraded & Backend-Ready)

// Global variable to hold results for the download function
let predictionResults = [];

// === CONFIGURE API BASE URL ===
// Local backend for development:
const LOCAL_API = "http://127.0.0.1:8080/predict";
// Production backend (replace with your deployed URL when ready):
const PROD_API = "https://mirna.aamarzan.com/predict";

// Automatically choose based on where the page is running
const API_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? LOCAL_API
    : PROD_API;
const API_KEY = "supersecret123";

// On load: bind file inputs and show idle message
document.addEventListener('DOMContentLoaded', () => {
    // Idle message
    const loader = document.getElementById('loader');
    if (loader) {
        loader.textContent = "Please input your sequences to start a prediction.";
        loader.classList.remove('hidden');
    }

    // Bind file inputs to textareas
    bindFileToTextarea('mirna-file', 'primary-seqs');
    bindFileToTextarea('target-file', 'target-seq');
    bindFileToTextarea('competitor-file', 'competitor-seq');
});

// Bind file -> textarea content
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

// Count FASTA records in a text block; treat raw non-empty as one record
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

    // UI elements
    const loader = document.getElementById('loader');
    const resultsContainer = document.getElementById('results-container');

    // Instant validation for target/competitor counts before calling backend
    const targetSeq = document.getElementById('target-seq').value.trim();
    const competitorSeq = document.getElementById('competitor-seq').value.trim();

    if (countFastaRecords(targetSeq) > 1) {
        resultsContainer.innerHTML = '<p style="color: red;">Please enter only one target sequence.</p>';
        return;
    }
    if (countFastaRecords(competitorSeq) > 1) {
        resultsContainer.innerHTML = '<p style="color: red;">Please enter only one competitor sequence.</p>';
        return;
    }

    // Switch to the results tab to show the loader
    const resultsTabButton = document.querySelector('button[onclick*="results-tab"]');
    if (resultsTabButton) openTab(resultsTabButton, 'results-tab');

    // Show running loader and clear prior results
    if (loader) {
        loader.textContent = "Running prediction...";
        loader.classList.remove('hidden');
    }
    resultsContainer.innerHTML = '';
    predictionResults = []; // Clear previous results

    // Create a FormData object to hold all text and file data
    const formData = new FormData();

    // Append text and number values from the form
    formData.append('primary_molecules', document.getElementById('primary-seqs').value);
    formData.append('target_molecule', targetSeq);
    formData.append('competitor_molecule', competitorSeq);
    // If you use these in backend later:
    formData.append('target_start', document.getElementById('target-start')?.value ?? '');
    formData.append('target_end', document.getElementById('target-end')?.value ?? '');

    // Get file objects (optional 3D files — you’re not parsing them yet, but keeping compatibility)
    const mirnaFile = document.getElementById('mirna-file')?.files?.[0];
    const targetFile = document.getElementById('target-file')?.files?.[0];
    const competitorFile = document.getElementById('competitor-file')?.files?.[0];

    if (mirnaFile) formData.append('mirna_3d_file', mirnaFile);
    if (targetFile) formData.append('target_3d_file', targetFile);
    if (competitorFile) formData.append('competitor_3d_file', competitorFile);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                "X-API-Key": API_KEY
            },
            body: formData
        });

        if (!response.ok) {
            let errorMsg = 'A server error occurred.';
            try {
                const errorData = await response.json();
                if (errorData.error) errorMsg = errorData.error;
            } catch (_) {}
            throw new Error(errorMsg);
        }

        const results = await response.json();
        predictionResults = results; // Save results for the download button
        displayResults(results);

    } catch (error) {
        resultsContainer.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
    } finally {
        // Hide loader when finished; keep results visible
        if (loader) loader.classList.add('hidden');
    }
});

function displayResults(results) {
    const container = document.getElementById('results-container');
    if (!results || results.length === 0) {
        container.innerHTML = '<p>No results to display.</p>';
        return;
    }

    // Build table: prefer primary_molecule_id, fallback to mirna_id
    let table = '<table><thead><tr>' +
        '<th>Primary Molecule ID</th>' +
        '<th>Predicted Affinity (Baseline)</th>' +
        '<th>Predicted Affinity (With Competitor)</th>' +
        '<th>Competitive Effect (higher is better)</th>' +
        '</tr></thead><tbody>';

    results.forEach(item => {
        const id = item.primary_molecule_id ?? item.mirna_id ?? 'N/A';

        // Values from backend are already formatted to 10 decimals; display as-is.
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
