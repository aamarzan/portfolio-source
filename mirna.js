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

document.getElementById('prediction-form').addEventListener('submit', async function(event) {
    event.preventDefault();

    // UI elements
    const loader = document.getElementById('loader');
    const resultsContainer = document.getElementById('results-container');

    // Switch to the results tab to show the loader
    openTab(document.querySelector('button[onclick*="results-tab"]'), 'results-tab');

    loader.classList.remove('hidden');
    resultsContainer.innerHTML = '';
    predictionResults = []; // Clear previous results

    // Create a FormData object to hold all text and file data
    const formData = new FormData();

    // Append text and number values from the form
    formData.append('primary_molecules', document.getElementById('primary-seqs').value);
    formData.append('target_molecule', document.getElementById('target-seq').value);
    formData.append('competitor_molecule', document.getElementById('competitor-seq').value);
    formData.append('target_start', document.getElementById('target-start').value);
    formData.append('target_end', document.getElementById('target-end').value);

    // Get file objects from the inputs
    const mirnaFile = document.getElementById('mirna-file').files[0];
    const targetFile = document.getElementById('target-file').files[0];
    const competitorFile = document.getElementById('competitor-file').files[0];

    // Append files only if they have been selected by the user
    if (mirnaFile) formData.append('mirna_3d_file', mirnaFile);
    if (targetFile) formData.append('target_3d_file', targetFile);
    if (competitorFile) formData.append('competitor_3d_file', competitorFile);

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
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
        loader.classList.add('hidden');
    }
});

function displayResults(results) {
    const container = document.getElementById('results-container');
    if (!results || results.length === 0) {
        container.innerHTML = '<p>No results to display.</p>';
        return;
    }

    let table = '<table><thead><tr><th>miRNA ID</th><th>Score (with Competitor)</th><th>Baseline Score</th><th>Competitive Effect</th></tr></thead><tbody>';
    results.forEach(item => {
        // Match backend keys exactly
        const withComp = item.predicted_affinity_with_competitor ?? item.score_with_competitor;
        const baseline = item.predicted_affinity_baseline ?? item.baseline_score;
        const compEffect = item["competitive_effect (higher_is_better)"] ?? item.competitive_effect;

        table += `<tr>
            <td>${item.mirna_id}</td>
            <td>${Number(withComp).toFixed(4)}</td>
            <td>${Number(baseline).toFixed(4)}</td>
            <td>${Number(compEffect).toFixed(4)}</td>
        </tr>`;
    });
    table += '</tbody></table>';

    const downloadButton = '<button id="download-btn">Download Results as CSV</button>';
    container.innerHTML = table + downloadButton;

    document.getElementById('download-btn').addEventListener('click', downloadCSV);
}

function downloadCSV() {
    if (predictionResults.length === 0) return;

    const headers = "miRNA_ID,Score_with_Competitor,Baseline_Score,Competitive_Effect";
    const csvRows = [headers];

    predictionResults.forEach(item => {
        const withComp = item.predicted_affinity_with_competitor ?? item.score_with_competitor;
        const baseline = item.predicted_affinity_baseline ?? item.baseline_score;
        const compEffect = item["competitive_effect (higher_is_better)"] ?? item.competitive_effect;

        const row = [
            item.mirna_id,
            Number(withComp).toFixed(4),
            Number(baseline).toFixed(4),
            Number(compEffect).toFixed(4)
        ];
        csvRows.push(row.join(','));
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

// Tabs function
function openTab(element, tabId) {
    document.querySelectorAll('.card').forEach(card => card.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    element.classList.add('active');
}
